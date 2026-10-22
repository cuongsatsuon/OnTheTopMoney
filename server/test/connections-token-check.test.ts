// Story 2.4 — theo dõi hạn token (cron `connections.token_check`) và đánh dấu mất kết nối (`TOKEN_INVALID`).
// Dùng Postgres nhúng + Threads giả (fake-meta.ts) + đồng hồ cố định, như các test connections khác.
import { randomBytes } from 'node:crypto'
import type { PgBoss } from 'pg-boss'
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest'
import { createSecretCipher, type SecretCipher } from '../src/adapters/crypto/index.ts'
import type { FakeMetaClient } from '../src/adapters/meta/fake.ts'
import {
  computeConnectionStatus,
  effectiveExpiry,
  markDisconnected,
  runTokenCheck,
  THREADS_MIN_AGE_S,
} from '../src/modules/connections/index.ts'
import { createFakeThreads } from '../src/modules/connections/fake-meta.ts'
import { createDb, type DbHandle } from '../src/platform/db/index.ts'
import { createEventPublisher, type EventPublisher } from '../src/platform/events/index.ts'
import { createBoss } from '../src/platform/jobs/index.ts'
import { createLogger } from '../src/platform/log/index.ts'
import { listenRealtime, waitFor } from './helpers/realtime.ts'

const DAY_S = 86_400
/** Đồng hồ cố định của test; mốc hết hạn tính theo giây epoch quanh mốc này. */
const NOW = new Date('2026-10-22T03:00:00.000Z')
const NOW_SEC = Math.floor(NOW.getTime() / 1000)
const cipher: SecretCipher = createSecretCipher({ keys: new Map([['k1', randomBytes(32)]]), activeKeyId: 'k1' })
const ENVELOPE = /^v1:k1:/

let handle: DbHandle
let boss: PgBoss
let events: EventPublisher
let realtime: Awaited<ReturnType<typeof listenRealtime>>
const log = createLogger({ level: 'silent' })

async function wipe() {
  await handle.sql`delete from page_credentials`
  await handle.sql`delete from pages`
}

let pageSeq = 0
/** Chèn một trang + bản ghi token. `tokenEnvelope` null = trang IG (trỏ `tokenSourcePageId`). */
async function insertPage(opts: {
  platform: 'facebook' | 'instagram' | 'threads'
  status?: 'active' | 'expiring' | 'disconnected'
  expiresAt?: number
  dataAccessExpiresAt?: number | null
  tokenPlain?: string | null
  tokenSourcePageId?: string | null
  updatedAgoS?: number
}): Promise<string> {
  pageSeq += 1
  const accountId = `acc-${pageSeq}`
  const [page] = await handle.sql<{ id: string }[]>`
    insert into pages (platform, platform_account_id, name, connection_status)
    values (${opts.platform}, ${accountId}, ${'Trang ' + pageSeq}, ${opts.status ?? 'active'})
    returning id`
  const pageId = page!.id
  const accessToken = opts.tokenPlain === undefined ? cipher.encrypt('FAKE_TH_LONG_full_seed') : opts.tokenPlain === null ? null : cipher.encrypt(opts.tokenPlain)
  const tokenSource = opts.tokenSourcePageId ?? null
  const updatedAt = new Date(NOW.getTime() - (opts.updatedAgoS ?? 2 * DAY_S) * 1000).toISOString()
  await handle.sql`
    insert into page_credentials (page_id, access_token, token_source_page_id, expires_at, data_access_expires_at, updated_at)
    values (${pageId}, ${accessToken}, ${tokenSource}, ${opts.expiresAt ?? 0}, ${opts.dataAccessExpiresAt ?? null}, ${updatedAt}::timestamptz)`
  return pageId
}

const statusOf = async (id: string) =>
  (await handle.sql<{ connection_status: string; connection_status_reason: string | null }[]>`
    select connection_status, connection_status_reason from pages where id = ${id}`)[0]!
const credOf = async (id: string) =>
  (await handle.sql<{ access_token: string | null; expires_at: string }[]>`
    select access_token, expires_at from page_credentials where page_id = ${id}`)[0]!
const pageEvents = () => realtime.messages.filter((m) => String(m.type).startsWith('page.'))

function deps(threads?: FakeMetaClient) {
  return { db: handle.db, events, cipher, threads, now: () => NOW, log }
}

beforeAll(async () => {
  handle = createDb(inject('databaseUrl'), { max: 3 })
  boss = createBoss(inject('databaseUrl'), 'ottm-test-token-check', { background: false })
  boss.on('error', () => {})
  await boss.start()
  events = createEventPublisher(boss)
  realtime = await listenRealtime(handle.sql)
})
afterAll(async () => {
  await wipe()
  await realtime.stop()
  await boss.stop({ graceful: false })
  await handle.close()
})
beforeEach(async () => {
  await wipe()
  realtime.messages.length = 0
})

describe('computeConnectionStatus / effectiveExpiry (ma trận)', () => {
  it('expires_at=0, không data_access → không hết hạn → active', () => {
    expect(effectiveExpiry(0, null)).toBeNull()
    expect(computeConnectionStatus({ expiresAt: 0, dataAccessExpiresAt: null }, NOW_SEC)).toBe('active')
  })
  it('bỏ qua mốc 0: lấy data_access khi expires_at=0', () => {
    expect(effectiveExpiry(0, NOW_SEC + 5 * DAY_S)).toBe(NOW_SEC + 5 * DAY_S)
    expect(computeConnectionStatus({ expiresAt: 0, dataAccessExpiresAt: NOW_SEC + 5 * DAY_S }, NOW_SEC)).toBe('expiring')
  })
  it('còn ≤7 ngày → expiring; còn xa → active', () => {
    expect(computeConnectionStatus({ expiresAt: NOW_SEC + 5 * DAY_S, dataAccessExpiresAt: null }, NOW_SEC)).toBe('expiring')
    expect(computeConnectionStatus({ expiresAt: NOW_SEC + 30 * DAY_S, dataAccessExpiresAt: NOW_SEC + 90 * DAY_S }, NOW_SEC)).toBe('active')
  })
  it('lấy mốc sớm nhất giữa expires_at và data_access_expires_at', () => {
    expect(effectiveExpiry(NOW_SEC + 10 * DAY_S, NOW_SEC + 3 * DAY_S)).toBe(NOW_SEC + 3 * DAY_S)
    expect(computeConnectionStatus({ expiresAt: NOW_SEC + 10 * DAY_S, dataAccessExpiresAt: NOW_SEC + 3 * DAY_S }, NOW_SEC)).toBe('expiring')
  })
  it('mốc hết hạn đã qua → disconnected', () => {
    expect(computeConnectionStatus({ expiresAt: NOW_SEC - 10, dataAccessExpiresAt: null }, NOW_SEC)).toBe('disconnected')
    expect(computeConnectionStatus({ expiresAt: 0, dataAccessExpiresAt: NOW_SEC - 1 }, NOW_SEC)).toBe('disconnected')
  })
})

describe('runTokenCheck — tính lại trạng thái + page.expiring một lần/chu kỳ', () => {
  it('trang còn 5 ngày → expiring, phát page.expiring một lần; chạy lại không phát lại', async () => {
    const expiring = await insertPage({ platform: 'facebook', dataAccessExpiresAt: NOW_SEC + 5 * DAY_S, tokenPlain: 'FAKE_PAGE_x' })
    const healthy = await insertPage({ platform: 'facebook', dataAccessExpiresAt: NOW_SEC + 60 * DAY_S, tokenPlain: 'FAKE_PAGE_y' })

    const r1 = await runTokenCheck(deps())
    expect(r1.expiring).toBe(1)
    // Facebook: không làm mới token Page (chỉ Threads).
    expect(r1.refreshed).toBe(0)
    expect((await statusOf(expiring)).connection_status).toBe('expiring')
    expect((await statusOf(healthy)).connection_status).toBe('active')
    const evt = await waitFor(() => (pageEvents().length >= 1 ? pageEvents() : null))
    expect(evt).toEqual([{ type: 'page.expiring', entity: 'page', id: expiring, pageId: expiring }])

    // Chu kỳ sau: trang đã expiring, vẫn ≤7 ngày → giữ nguyên, KHÔNG phát lại.
    realtime.messages.length = 0
    const r2 = await runTokenCheck(deps())
    expect(r2.expiring).toBe(0)
    expect((await statusOf(expiring)).connection_status).toBe('expiring')
    expect(pageEvents()).toEqual([])
  })

  it('không chạm trang disconnected (không tự hồi phục)', async () => {
    const id = await insertPage({ platform: 'facebook', status: 'disconnected', dataAccessExpiresAt: NOW_SEC + 60 * DAY_S, tokenPlain: 'FAKE_PAGE_z' })
    await runTokenCheck(deps())
    expect((await statusOf(id)).connection_status).toBe('disconnected')
  })

  it('token đã quá hạn → disconnected (reason TOKEN_EXPIRED), phát page.disconnected một lần', async () => {
    const id = await insertPage({ platform: 'facebook', dataAccessExpiresAt: NOW_SEC - 3600, tokenPlain: 'FAKE_PAGE_exp' })
    await runTokenCheck(deps())
    const st = await statusOf(id)
    expect(st.connection_status).toBe('disconnected')
    expect(st.connection_status_reason).toBe('TOKEN_EXPIRED')
    const evt = await waitFor(() => (pageEvents().length >= 1 ? pageEvents() : null))
    expect(evt).toEqual([{ type: 'page.disconnected', entity: 'page', id, pageId: id }])
    // Chu kỳ sau: đã disconnected → không phát lại.
    realtime.messages.length = 0
    await runTokenCheck(deps())
    expect(pageEvents()).toEqual([])
  })

  it('một trang làm mới ném lỗi → các trang còn lại vẫn được tính lại trạng thái + phát page.expiring', async () => {
    // Trang Threads đủ điều kiện làm mới nhưng handler ném → phải bị nuốt, không làm chết cron.
    const bad = await insertPage({ platform: 'threads', expiresAt: NOW_SEC + 10 * DAY_S, tokenPlain: 'FAKE_TH_LONG_full_boom', updatedAgoS: 2 * DAY_S })
    const expiring = await insertPage({ platform: 'facebook', dataAccessExpiresAt: NOW_SEC + 5 * DAY_S, tokenPlain: 'FAKE_PAGE_ex' })
    const threads = createFakeThreads(() => NOW)
    threads.on('GET', '/refresh_access_token', () => {
      throw new Error('boom')
    })
    const r = await runTokenCheck(deps(threads))
    expect(r.refreshed).toBe(0)
    expect((await statusOf(expiring)).connection_status).toBe('expiring')
    const evt = await waitFor(() => (pageEvents().length >= 1 ? pageEvents() : null))
    expect(evt).toEqual([{ type: 'page.expiring', entity: 'page', id: expiring, pageId: expiring }])
    // Trang Threads hỏng vẫn còn 10 ngày → tính lại thành active (không bị ngắt).
    expect((await statusOf(bad)).connection_status).toBe('active')
  })
})

describe('runTokenCheck — làm mới token Threads', () => {
  it('token ≤15 ngày (đang expiring) và ≥24h tuổi → làm mới, về active và xoá reason', async () => {
    const id = await insertPage({
      platform: 'threads',
      status: 'expiring',
      expiresAt: NOW_SEC + 3 * DAY_S,
      tokenPlain: 'FAKE_TH_LONG_full_old',
      updatedAgoS: 2 * DAY_S,
    })
    await handle.sql`update pages set connection_status_reason = 'TOKEN_EXPIRING' where id = ${id}`
    const before = await credOf(id)
    const r = await runTokenCheck(deps(createFakeThreads(() => NOW)))
    expect(r.refreshed).toBe(1)
    const after = await credOf(id)
    expect(after.access_token).toMatch(ENVELOPE)
    expect(after.access_token).not.toBe(before.access_token)
    expect(cipher.decrypt(after.access_token!)).toMatch(/^FAKE_TH_LONG_full_/)
    // Hạn mới ~60 ngày → active, reason bị xoá.
    expect(Number(after.expires_at)).toBeGreaterThan(NOW_SEC + 30 * DAY_S)
    const st = await statusOf(id)
    expect(st.connection_status).toBe('active')
    expect(st.connection_status_reason).toBeNull()
  })

  it('token còn >15 ngày (dù ≥24h tuổi) → không làm mới, token không đổi, active', async () => {
    const id = await insertPage({ platform: 'threads', expiresAt: NOW_SEC + 40 * DAY_S, tokenPlain: 'FAKE_TH_LONG_full_far', updatedAgoS: 2 * DAY_S })
    const before = await credOf(id)
    const r = await runTokenCheck(deps(createFakeThreads(() => NOW)))
    expect(r.refreshed).toBe(0)
    expect((await credOf(id)).access_token).toBe(before.access_token)
    expect((await statusOf(id)).connection_status).toBe('active')
  })

  it('token quá mới (<24h tuổi) → bỏ qua làm mới', async () => {
    const id = await insertPage({
      platform: 'threads',
      expiresAt: NOW_SEC + 10 * DAY_S,
      tokenPlain: 'FAKE_TH_LONG_full_fresh',
      updatedAgoS: THREADS_MIN_AGE_S - 3600,
    })
    const before = await credOf(id)
    const r = await runTokenCheck(deps(createFakeThreads(() => NOW)))
    expect(r.refreshed).toBe(0)
    expect((await credOf(id)).access_token).toBe(before.access_token)
    // Vẫn tính lại trạng thái: còn 10 ngày > 7 → active.
    expect((await statusOf(id)).connection_status).toBe('active')
  })

  it('làm mới trả TOKEN_INVALID → markDisconnected, phát page.disconnected', async () => {
    const id = await insertPage({ platform: 'threads', expiresAt: NOW_SEC + 10 * DAY_S, tokenPlain: 'FAKE_TH_LONG_full_bad', updatedAgoS: 2 * DAY_S })
    const threads = createFakeThreads(() => NOW)
    threads.on('GET', '/refresh_access_token', { ok: false, kind: 'TOKEN_INVALID', code: 190, status: 400 })
    await runTokenCheck(deps(threads))
    expect((await statusOf(id)).connection_status).toBe('disconnected')
    const evt = await waitFor(() => (pageEvents().length >= 1 ? pageEvents() : null))
    expect(evt).toEqual([{ type: 'page.disconnected', entity: 'page', id, pageId: id }])
  })
})

describe('markDisconnected — lan sang trang IG cùng nguồn token', () => {
  it('Fanpage + IG dùng chung token → cả hai disconnected, page.disconnected mỗi trang', async () => {
    const fb = await insertPage({ platform: 'facebook', tokenPlain: 'FAKE_PAGE_fb' })
    const ig = await insertPage({ platform: 'instagram', tokenPlain: null, tokenSourcePageId: fb })
    const other = await insertPage({ platform: 'facebook', tokenPlain: 'FAKE_PAGE_other' })

    const changed = await markDisconnected({ db: handle.db, events, log }, fb, 'TOKEN_INVALID')
    expect(new Set(changed)).toEqual(new Set([fb, ig]))
    expect((await statusOf(fb)).connection_status).toBe('disconnected')
    expect((await statusOf(fb)).connection_status_reason).toBe('TOKEN_INVALID')
    expect((await statusOf(ig)).connection_status).toBe('disconnected')
    // Trang không liên quan giữ nguyên.
    expect((await statusOf(other)).connection_status).toBe('active')

    const evts = await waitFor(() => (pageEvents().length >= 2 ? pageEvents() : null))
    expect(evts.map((e) => e.id).sort()).toEqual([fb, ig].sort())
    expect(evts.every((e) => e.type === 'page.disconnected')).toBe(true)
  })

  it('idempotent: trang đã disconnected không phát lại', async () => {
    const fb = await insertPage({ platform: 'facebook', status: 'disconnected', tokenPlain: 'FAKE_PAGE_d' })
    const changed = await markDisconnected({ db: handle.db, events, log }, fb)
    expect(changed).toEqual([])
    expect(pageEvents()).toEqual([])
  })
})
