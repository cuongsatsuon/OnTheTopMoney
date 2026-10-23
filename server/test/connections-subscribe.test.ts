// Story 4.2 — tự đăng ký webhook trang (job `connections.subscribe_page`): xác nhận enqueue trong transaction,
// đăng ký theo từng nền tảng (Fanpage / IG qua Fanpage nguồn / Threads không gọi mạng), lỗi Meta → mã chẩn đoán,
// `TOKEN_INVALID` → mất kết nối, retry chỉ cho RATE_LIMITED/TRANSIENT, hết retry → FAILED, chạy bù khi khởi động.
import { randomBytes, randomUUID } from 'node:crypto'
import type { PgBoss } from 'pg-boss'
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest'
import { createSecretCipher, type SecretCipher } from '../src/adapters/crypto/index.ts'
import type { FakeMetaClient } from '../src/adapters/meta/fake.ts'
import {
  PAGE_SUBSCRIBED_FIELDS,
  SubscribeRetryableError,
  confirmConnections,
  enqueueMissingSubscriptions,
  handleSubscribeJob,
  listSubscriptionErrors,
  recordSubscribeError,
  subscribePage,
} from '../src/modules/connections/index.ts'
import { FAKE_IG, FAKE_PAGES, createFakeMetaGraph } from '../src/modules/connections/fake-meta.ts'
import { createDb, type DbHandle } from '../src/platform/db/index.ts'
import { createEventPublisher, type EventPublisher } from '../src/platform/events/index.ts'
import { createBoss, createJobSender, ensureQueues, type JobSender } from '../src/platform/jobs/index.ts'
import { createLogger } from '../src/platform/log/index.ts'

const QUEUE = 'connections.subscribe_page'
const NOW = new Date('2026-10-23T03:00:00.000Z')
const cipher: SecretCipher = createSecretCipher({ keys: new Map([['k1', randomBytes(32)]]), activeKeyId: 'k1' })
const log = createLogger({ level: 'silent' })

let handle: DbHandle
let boss: PgBoss
let events: EventPublisher
let jobs: JobSender
let graph: FakeMetaClient

async function wipe() {
  await handle.sql`delete from page_credentials`
  await handle.sql`delete from pages`
  await handle.sql`delete from oauth_results`
  await handle.sql`delete from pgboss.job where name = ${QUEUE}`
}

beforeAll(async () => {
  handle = createDb(inject('databaseUrl'), { max: 3 })
  boss = createBoss(inject('databaseUrl'), 'ottm-test-subscribe', { background: false })
  boss.on('error', () => {})
  await boss.start()
  await ensureQueues(boss)
  events = createEventPublisher(boss)
  jobs = createJobSender(boss)
})
afterAll(async () => {
  await wipe()
  await boss.stop({ graceful: false })
  await handle.close()
})
beforeEach(async () => {
  await wipe()
  graph = createFakeMetaGraph(() => NOW)
})

const deps = () => ({ db: handle.db, events, cipher, graph, log, now: () => NOW })

async function queuedPageIds(): Promise<string[]> {
  const rows = await handle.sql<{ data: { pageId: string } }[]>`select data from pgboss.job where name = ${QUEUE} order by created_on`
  return rows.map((r) => r.data.pageId)
}

/** Một trang + token. Fanpage/Threads: token riêng (rõ = `tokenPlain`); IG: `tokenSourcePageId`. */
async function insertPage(opts: {
  platform: 'facebook' | 'instagram' | 'threads'
  accountId: string
  status?: 'active' | 'expiring' | 'disconnected'
  tokenPlain?: string
  tokenSourcePageId?: string
  removed?: boolean
  subscribedAt?: Date | null
  subscribeError?: string | null
}): Promise<string> {
  const [page] = await handle.sql<{ id: string }[]>`
    insert into pages (platform, platform_account_id, name, connection_status, removed_at)
    values (${opts.platform}, ${opts.accountId}, ${'Trang ' + opts.accountId}, ${opts.status ?? 'active'},
            ${opts.removed ? NOW.toISOString() : null}::timestamptz)
    returning id`
  const pageId = page!.id
  const accessToken = opts.tokenSourcePageId ? null : cipher.encrypt(opts.tokenPlain ?? `FAKE_PAGE_${opts.accountId}_seed`)
  await handle.sql`
    insert into page_credentials (page_id, access_token, token_source_page_id, webhook_subscribed_at, webhook_subscribe_error)
    values (${pageId}, ${accessToken}, ${opts.tokenSourcePageId ?? null},
            ${opts.subscribedAt ? opts.subscribedAt.toISOString() : null}::timestamptz, ${opts.subscribeError ?? null})`
  return pageId
}

const credOf = async (pageId: string) =>
  (await handle.sql<{ webhook_subscribed_at: string | null; webhook_subscribe_error: string | null; updated_at: string }[]>`
    select webhook_subscribed_at, webhook_subscribe_error, updated_at from page_credentials where page_id = ${pageId}`)[0]!
const statusOf = async (pageId: string) =>
  (await handle.sql<{ connection_status: string }[]>`select connection_status from pages where id = ${pageId}`)[0]!.connection_status

const subscribeCalls = () => graph.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/subscribed_apps'))

// ---------------------------------------------------------------------------------------------------------
// confirmConnections enqueue trong transaction
// ---------------------------------------------------------------------------------------------------------

describe('confirmConnections — enqueue connections.subscribe_page trong cùng transaction', () => {
  const SESSION = randomUUID()
  const fbCandidate = {
    accountId: FAKE_PAGES.beauty.id,
    platform: 'facebook' as const,
    name: FAKE_PAGES.beauty.name,
    handle: FAKE_PAGES.beauty.username,
    avatarUrl: null,
    selectable: true,
    missing: [],
    grantedScopes: [],
    tokenEnvelope: '',
  }
  const igCandidate = {
    accountId: FAKE_IG.business.id,
    platform: 'instagram' as const,
    name: FAKE_IG.business.name,
    handle: FAKE_IG.business.username,
    avatarUrl: null,
    linkedToAccountId: FAKE_PAGES.beauty.id,
    selectable: true,
    missing: [],
    grantedScopes: [],
  }
  const threadsCandidate = {
    accountId: 'TH_ACC_1',
    platform: 'threads' as const,
    name: 'Threads 1',
    handle: 'th1',
    avatarUrl: null,
    selectable: true,
    missing: [],
    grantedScopes: [],
    tokenEnvelope: '',
    tokenExpiresAt: Math.floor(NOW.getTime() / 1000) + 60 * 86_400,
  }

  async function seedResult(candidates: object[]): Promise<string> {
    const [row] = await handle.sql<{ id: string }[]>`
      insert into oauth_results (provider, session_id, return_to, status, candidates, expires_at)
      values ('facebook', ${SESSION}, 'pages', 'ok', ${JSON.stringify(candidates)}::jsonb, ${new Date(NOW.getTime() + 600_000).toISOString()}::timestamptz)
      returning id`
    return row!.id
  }
  const fb = () => ({ ...fbCandidate, tokenEnvelope: cipher.encrypt(`FAKE_PAGE_${FAKE_PAGES.beauty.id}_x`) })
  const th = () => ({ ...threadsCandidate, tokenEnvelope: cipher.encrypt('FAKE_TH_LONG_full_x') })

  it('xác nhận 1 Fanpage → đúng 1 job; job đăng ký đủ 4 field, đặt webhook_subscribed_at', async () => {
    const resultId = await seedResult([fb()])
    const { pages } = await confirmConnections({ db: handle.db, events, jobs, now: () => NOW }, {
      sessionId: SESSION,
      request: { resultId, accountIds: [FAKE_PAGES.beauty.id] },
    })
    expect(pages).toHaveLength(1)
    expect(await queuedPageIds()).toEqual([pages[0]!.id])

    const outcome = await subscribePage(deps(), pages[0]!.id)
    expect(outcome).toEqual({ status: 'subscribed', network: true })
    const calls = subscribeCalls()
    expect(calls).toHaveLength(1)
    expect(calls[0]!.path).toBe(`/${FAKE_PAGES.beauty.id}/subscribed_apps`)
    expect(calls[0]!.options.params?.subscribed_fields).toBe('messages,messaging_postbacks,message_echoes,feed')
    expect(PAGE_SUBSCRIBED_FIELDS).toBe('messages,messaging_postbacks,message_echoes,feed')
    expect(calls[0]!.options.tier).toBe('background')
    expect(calls[0]!.options.token).toMatch(new RegExp(`^FAKE_PAGE_${FAKE_PAGES.beauty.id}_`))
    const cred = await credOf(pages[0]!.id)
    expect(new Date(cred.webhook_subscribed_at!).toISOString()).toBe(NOW.toISOString())
    expect(cred.webhook_subscribe_error).toBeNull()
  })

  it('xác nhận IG (tự gồm Fanpage nguồn) → job cho cả hai; IG đăng ký trên Fanpage nguồn', async () => {
    const resultId = await seedResult([fb(), igCandidate])
    const { pages } = await confirmConnections({ db: handle.db, events, jobs, now: () => NOW }, {
      sessionId: SESSION,
      request: { resultId, accountIds: [FAKE_IG.business.id] },
    })
    const ig = pages.find((p) => p.platform === 'instagram')!
    const fbPage = pages.find((p) => p.platform === 'facebook')!
    expect((await queuedPageIds()).sort()).toEqual([fbPage.id, ig.id].sort())

    expect(await subscribePage(deps(), ig.id)).toEqual({ status: 'subscribed', network: true })
    expect(subscribeCalls().map((c) => c.path)).toEqual([`/${FAKE_PAGES.beauty.id}/subscribed_apps`])
    expect((await credOf(ig.id)).webhook_subscribed_at).not.toBeNull()
  })

  it('xác nhận lại trang đang active (không phát sự kiện) vẫn enqueue', async () => {
    const r1 = await seedResult([fb()])
    await confirmConnections({ db: handle.db, events, jobs, now: () => NOW }, { sessionId: SESSION, request: { resultId: r1, accountIds: [FAKE_PAGES.beauty.id] } })
    const r2 = await seedResult([fb()])
    const { pages } = await confirmConnections({ db: handle.db, events, jobs, now: () => NOW }, {
      sessionId: SESSION,
      request: { resultId: r2, accountIds: [FAKE_PAGES.beauty.id] },
    })
    expect(await queuedPageIds()).toEqual([pages[0]!.id, pages[0]!.id])
  })

  it('transaction rollback (lỗi sau khi đã enqueue trang đầu) → KHÔNG còn job nào', async () => {
    const resultId = await seedResult([fb(), th()])
    let published = 0
    const failingEvents: EventPublisher = {
      async publishEvent(tx, name, payload) {
        published += 1
        if (published === 2) throw new Error('hỏng giữa transaction')
        await events.publishEvent(tx, name, payload)
      },
    }
    await expect(
      confirmConnections({ db: handle.db, events: failingEvents, jobs, now: () => NOW }, {
        sessionId: SESSION,
        request: { resultId, accountIds: [FAKE_PAGES.beauty.id, 'TH_ACC_1'] },
      }),
    ).rejects.toThrow('hỏng giữa transaction')
    expect(published).toBe(2)
    expect(await queuedPageIds()).toEqual([])
    const [row] = await handle.sql<{ n: number }[]>`select count(*)::int as n from pages`
    expect(row!.n).toBe(0)
  })
})

// ---------------------------------------------------------------------------------------------------------
// subscribePage theo nền tảng + lỗi
// ---------------------------------------------------------------------------------------------------------

describe('subscribePage — nền tảng và lỗi', () => {
  it('Threads → thành công, KHÔNG gọi mạng', async () => {
    const id = await insertPage({ platform: 'threads', accountId: 'TH_1', tokenPlain: 'FAKE_TH_LONG_full_x' })
    expect(await subscribePage(deps(), id)).toEqual({ status: 'subscribed', network: false })
    expect(graph.calls).toHaveLength(0)
    expect((await credOf(id)).webhook_subscribed_at).not.toBeNull()
  })

  it('ghi kết quả KHÔNG đụng updated_at (mốc tuổi token Threads)', async () => {
    const id = await insertPage({ platform: 'threads', accountId: 'TH_2', tokenPlain: 'FAKE_TH_LONG_full_x' })
    const before = (await credOf(id)).updated_at
    await subscribePage(deps(), id)
    expect((await credOf(id)).updated_at).toBe(before)
  })

  it('PERMISSION_DENIED → lưu lỗi, job kết thúc (không ném, không retry)', async () => {
    const id = await insertPage({ platform: 'facebook', accountId: FAKE_PAGES.beauty.id })
    graph.on('POST', `/${FAKE_PAGES.beauty.id}/subscribed_apps`, { ok: false, kind: 'PERMISSION_DENIED', code: 200, status: 403 })
    await expect(handleSubscribeJob({ subscribe: (p) => subscribePage(deps(), p), markFailed: async () => {} }, { data: { pageId: id }, retryCount: 0, retryLimit: 3 })).resolves.toBeUndefined()
    expect((await credOf(id)).webhook_subscribe_error).toBe('PERMISSION_DENIED')
    expect(await statusOf(id)).toBe('active')
    // Hiện ở đúng trang đó.
    expect(await listSubscriptionErrors(handle.db)).toEqual([
      { pageId: id, name: `Trang ${FAKE_PAGES.beauty.id}`, platform: 'facebook', errorCode: 'PERMISSION_DENIED' },
    ])
  })

  it('TOKEN_INVALID → markDisconnected (Fanpage + IG dùng chung) + lưu lỗi', async () => {
    const fbId = await insertPage({ platform: 'facebook', accountId: FAKE_PAGES.beauty.id })
    const igId = await insertPage({ platform: 'instagram', accountId: FAKE_IG.business.id, tokenSourcePageId: fbId })
    graph.on('POST', `/${FAKE_PAGES.beauty.id}/subscribed_apps`, { ok: false, kind: 'TOKEN_INVALID', code: 190, status: 400 })
    expect(await subscribePage(deps(), igId)).toEqual({ status: 'failed', errorCode: 'TOKEN_INVALID' })
    expect(await statusOf(fbId)).toBe('disconnected')
    expect(await statusOf(igId)).toBe('disconnected')
    expect((await credOf(igId)).webhook_subscribe_error).toBe('TOKEN_INVALID')
  })

  it('token giả sai (fake Graph trả 190) → TOKEN_INVALID', async () => {
    const id = await insertPage({ platform: 'facebook', accountId: FAKE_PAGES.home.id, tokenPlain: 'KHONG_PHAI_TOKEN_PAGE' })
    expect(await subscribePage(deps(), id)).toEqual({ status: 'failed', errorCode: 'TOKEN_INVALID' })
    expect(await statusOf(id)).toBe('disconnected')
  })

  it('REJECTED → REJECTED; kind không retry khác → FAILED', async () => {
    const id = await insertPage({ platform: 'facebook', accountId: FAKE_PAGES.beauty.id })
    graph.on('POST', `/${FAKE_PAGES.beauty.id}/subscribed_apps`, { ok: false, kind: 'REJECTED', code: 368, status: 400 })
    expect(await subscribePage(deps(), id)).toEqual({ status: 'failed', errorCode: 'REJECTED' })
    graph.on('POST', `/${FAKE_PAGES.beauty.id}/subscribed_apps`, { ok: false, kind: 'OUTSIDE_WINDOW', code: 10, status: 400 })
    expect(await subscribePage(deps(), id)).toEqual({ status: 'failed', errorCode: 'FAILED' })
    expect((await credOf(id)).webhook_subscribe_error).toBe('FAILED')
  })

  it('RATE_LIMITED / TRANSIENT → ném để retry, không ghi gì', async () => {
    const id = await insertPage({ platform: 'facebook', accountId: FAKE_PAGES.beauty.id })
    for (const kind of ['RATE_LIMITED', 'TRANSIENT'] as const) {
      graph.on('POST', `/${FAKE_PAGES.beauty.id}/subscribed_apps`, { ok: false, kind })
      await expect(subscribePage(deps(), id)).rejects.toBeInstanceOf(SubscribeRetryableError)
    }
    const cred = await credOf(id)
    expect(cred.webhook_subscribed_at).toBeNull()
    expect(cred.webhook_subscribe_error).toBeNull()
  })

  it('handleSubscribeJob: lần chưa cuối ném lại không ghi; lần cuối ghi FAILED rồi ném', async () => {
    const id = await insertPage({ platform: 'facebook', accountId: FAKE_PAGES.beauty.id })
    graph.on('POST', `/${FAKE_PAGES.beauty.id}/subscribed_apps`, { ok: false, kind: 'TRANSIENT' })
    const handlerDeps = { subscribe: (p: string) => subscribePage(deps(), p), markFailed: (p: string) => recordSubscribeError(handle.db, p, 'FAILED') }
    await expect(handleSubscribeJob(handlerDeps, { data: { pageId: id }, retryCount: 1, retryLimit: 3 })).rejects.toBeInstanceOf(SubscribeRetryableError)
    expect((await credOf(id)).webhook_subscribe_error).toBeNull()
    await expect(handleSubscribeJob(handlerDeps, { data: { pageId: id }, retryCount: 3, retryLimit: 3 })).rejects.toBeInstanceOf(SubscribeRetryableError)
    expect((await credOf(id)).webhook_subscribe_error).toBe('FAILED')
  })

  it('handleSubscribeJob: thiếu pageId → lỗi dữ liệu', async () => {
    await expect(handleSubscribeJob({ subscribe: async () => {}, markFailed: async () => {} }, { data: {}, retryCount: 0, retryLimit: 3 })).rejects.toThrow('thiếu pageId')
  })

  it('thành công xoá lỗi cũ', async () => {
    const id = await insertPage({ platform: 'facebook', accountId: FAKE_PAGES.beauty.id, subscribeError: 'PERMISSION_DENIED' })
    expect(await subscribePage(deps(), id)).toEqual({ status: 'subscribed', network: true })
    const cred = await credOf(id)
    expect(cred.webhook_subscribe_error).toBeNull()
    expect(cred.webhook_subscribed_at).not.toBeNull()
  })

  it('trang đã gỡ / mất kết nối / không tồn tại / IG mà Fanpage nguồn mất kết nối → bỏ qua, không gọi, không lỗi', async () => {
    const removed = await insertPage({ platform: 'facebook', accountId: 'P_REMOVED', removed: true })
    const disc = await insertPage({ platform: 'facebook', accountId: 'P_DISC', status: 'disconnected' })
    const src = await insertPage({ platform: 'facebook', accountId: 'P_SRC', status: 'disconnected' })
    const ig = await insertPage({ platform: 'instagram', accountId: 'IG_X', tokenSourcePageId: src })
    for (const id of [removed, disc, ig, randomUUID()]) expect(await subscribePage(deps(), id)).toEqual({ status: 'skipped' })
    expect(graph.calls).toHaveLength(0)
    expect((await credOf(disc)).webhook_subscribe_error).toBeNull()
  })

  it('lỗi đăng ký của trang đã gỡ không hiện trong danh sách lỗi', async () => {
    await insertPage({ platform: 'facebook', accountId: 'P_GONE', removed: true, subscribeError: 'REJECTED' })
    const live = await insertPage({ platform: 'threads', accountId: 'TH_ERR', subscribeError: 'FAILED' })
    expect((await listSubscriptionErrors(handle.db)).map((e) => e.pageId)).toEqual([live])
  })
})

// ---------------------------------------------------------------------------------------------------------
// Chạy bù khi worker khởi động
// ---------------------------------------------------------------------------------------------------------

describe('enqueueMissingSubscriptions — chạy bù', () => {
  it('2 trang cũ chưa đăng ký, 1 đã đăng ký (+ lỗi, mất kết nối, đã gỡ) → enqueue đúng 2; chạy lại sau khi xử lý → 0', async () => {
    const a = await insertPage({ platform: 'facebook', accountId: FAKE_PAGES.beauty.id })
    const b = await insertPage({ platform: 'threads', accountId: 'TH_OLD' })
    await insertPage({ platform: 'facebook', accountId: FAKE_PAGES.home.id, subscribedAt: NOW })
    await insertPage({ platform: 'facebook', accountId: 'P_ERR', subscribeError: 'PERMISSION_DENIED' })
    await insertPage({ platform: 'facebook', accountId: 'P_DISC2', status: 'disconnected' })
    await insertPage({ platform: 'facebook', accountId: 'P_REM2', removed: true })

    expect(await enqueueMissingSubscriptions(handle.db, jobs)).toBe(2)
    expect((await queuedPageIds()).sort()).toEqual([a, b].sort())

    for (const id of await queuedPageIds()) await subscribePage(deps(), id)
    expect(await enqueueMissingSubscriptions(handle.db, jobs)).toBe(0)
  })

  it('trang expiring vẫn được chạy bù (chưa mất kết nối)', async () => {
    const id = await insertPage({ platform: 'facebook', accountId: 'P_EXP', status: 'expiring' })
    expect(await enqueueMissingSubscriptions(handle.db, jobs)).toBe(1)
    expect(await queuedPageIds()).toEqual([id])
  })
})
