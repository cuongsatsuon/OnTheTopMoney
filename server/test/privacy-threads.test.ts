// Story 9.4 — callback gỡ app / xoá dữ liệu của Threads app (app Meta riêng), Postgres thật:
// - verify `signed_request` bằng `THREADS_APP_SECRET` (ký bằng `META_APP_SECRET` → 400), cùng luật idempotent / chống
//   phát lại của 9.1/9.2, khoá người dùng `threads-user:<id>`;
// - người dùng = trang Threads có `platform_account_id` = `user_id` (kể cả đã gỡ); `scope=all` thu hẹp về trang đó,
//   `metaAccountId = null`; uninstall ngắt đúng trang Threads, không đụng FB / IG / Threads khác;
// - trang trạng thái ghi "tài khoản Threads", config có URL Threads, log không mang PII.
import { Writable } from 'node:stream'
import { MetaDataDeletionResponse, PrivacyConfigResponse } from '@ottm/shared'
import type { FastifyInstance } from 'fastify'
import type { PgBoss } from 'pg-boss'
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest'
import { buildApp } from '../src/app/app.ts'
import { SESSION_COOKIE } from '../src/app/auth/index.ts'
import { REASON_THREADS_DEAUTHORIZED } from '../src/modules/connections/index.ts'
import { upsertFromPlatform } from '../src/modules/pages/index.ts'
import { signRequestForTest } from '../src/modules/privacy/index.ts'
import { createSession } from '../src/modules/settings/index.ts'
import { createDb, type DbHandle } from '../src/platform/db/index.ts'
import { createEventPublisher, type EventPublisher } from '../src/platform/events/index.ts'
import { BOSS_SCHEMA, createBoss, ensureQueues } from '../src/platform/jobs/index.ts'
import { createLogger } from '../src/platform/log/index.ts'

const META_SECRET = 'meta-app-secret-123'
const THREADS_SECRET = 'threads-app-secret-456'
const BASE = 'https://api.example.com'
/** Id Threads của chủ shop (= `pages.platform_account_id` của trang Threads), và của một tài khoản Threads khác. */
const TH_OWNER = '17841400000000001'
const TH_OTHER = '17841400000000002'
/** `fb_user_id` của chủ shop ở Meta App — Threads app gửi cùng số này thì vẫn là người lạ (khác app, khác trang). */
const FB_OWNER = '100200300'
const STRANGER = '555000555'
const SINK = 'testonly.privacy_threads_sink'
const SINK_EVENTS = ['privacy.purge_requested', 'page.disconnected'] as const

let handle: DbHandle
let boss: PgBoss
let events: EventPublisher
let app: FastifyInstance
let logLines: string[] = []

function build(opts: { threadsSecret?: string | undefined } = {}) {
  const sink = new Writable({
    write(chunk, _enc, cb) {
      logLines.push(String(chunk))
      cb()
    },
  })
  const threadsSecret = 'threadsSecret' in opts ? opts.threadsSecret : THREADS_SECRET
  return buildApp({
    sql: handle.sql,
    db: handle.db,
    logger: createLogger({ level: 'info' }, sink),
    events,
    privacy: {
      metaAppSecret: META_SECRET,
      ...(threadsSecret ? { threadsAppSecret: threadsSecret } : {}),
      publicBaseUrl: BASE,
      operator: { name: 'Shop', email: 'lienhe@shop.example' },
      limits: { callbackPerMinute: 1000, pagePerMinute: 1000 },
    },
  })
}

async function wipe() {
  await handle.sql`delete from deletion_requests`
  await handle.sql`delete from page_credentials`
  await handle.sql`delete from pages`
  await handle.sql`delete from meta_accounts`
  await handle.sql`delete from sessions`
  await boss.deleteAllJobs(SINK)
}

beforeAll(async () => {
  handle = createDb(inject('databaseUrl'), { max: 3 })
  boss = createBoss(inject('databaseUrl'), 'ottm-test-privacy-threads', { background: false })
  boss.on('error', () => {})
  await boss.start()
  await ensureQueues(boss)
  await boss.createQueue(SINK)
  for (const e of SINK_EVENTS) await boss.subscribe(e, SINK)
  events = createEventPublisher(boss)
  app = build()
  await app.ready()
})
afterAll(async () => {
  await app.close()
  await wipe()
  for (const e of SINK_EVENTS) await boss.unsubscribe(e, SINK)
  await boss.deleteQueue(SINK)
  await handle.sql.unsafe(`delete from ${BOSS_SCHEMA}.job where name like 'events.%' or name like '%.purge'`)
  await boss.stop({ graceful: false })
  await handle.close()
})
beforeEach(async () => {
  await wipe()
  logLines = []
})

async function sinkEvents(name?: (typeof SINK_EVENTS)[number]) {
  const rows = await handle.sql.unsafe<{ data: { event: string; payload: Record<string, unknown> } }[]>(
    `select data from ${BOSS_SCHEMA}.job where name = $1 order by created_on`,
    [SINK],
  )
  return rows.map((r) => r.data).filter((d) => !name || d.event === name)
}

async function requests() {
  return handle.sql<{ code: string; scope: string; status: string; source: string; matched: boolean; page_ids: string[] | null; meta_account_id: string | null }[]>`
    select code, scope, status, source, matched, page_ids, meta_account_id from deletion_requests order by requested_at`
}

async function statusOf(pageId: string) {
  const [row] = await handle.sql<{ connection_status: string; connection_status_reason: string | null }[]>`
    select connection_status, connection_status_reason from pages where id = ${pageId}`
  return row
}

/** Chủ shop: Fanpage + IG (Meta App, `FB_OWNER`) và trang Threads `TH_OWNER`; thêm trang Threads của người khác. */
async function seed() {
  const [owner] = await handle.sql<{ id: string }[]>`
    insert into meta_accounts (fb_user_id, name, user_token) values (${FB_OWNER}, 'Chủ shop', 'v1:k1:x') returning id`
  const fb = (await upsertFromPlatform(handle.db, { platform: 'facebook', platformAccountId: 'FB1', name: 'FB', handle: null, avatarUrl: null })).page
  const ig = (await upsertFromPlatform(handle.db, { platform: 'instagram', platformAccountId: 'IG1', name: 'IG', handle: 'ig', avatarUrl: null })).page
  const th = (await upsertFromPlatform(handle.db, { platform: 'threads', platformAccountId: TH_OWNER, name: 'TH', handle: 'th', avatarUrl: null })).page
  const th2 = (await upsertFromPlatform(handle.db, { platform: 'threads', platformAccountId: TH_OTHER, name: 'TH2', handle: 'th2', avatarUrl: null })).page
  await handle.sql`insert into page_credentials (page_id, meta_account_id, access_token) values (${fb.id}, ${owner!.id}, 'v1:k1:p')`
  await handle.sql`insert into page_credentials (page_id, meta_account_id, token_source_page_id) values (${ig.id}, ${owner!.id}, ${fb.id})`
  await handle.sql`insert into page_credentials (page_id, access_token) values (${th.id}, 'v1:k1:t')`
  await handle.sql`insert into page_credentials (page_id, access_token) values (${th2.id}, 'v1:k1:u')`
  return { fb: fb.id, ig: ig.id, th: th.id, th2: th2.id }
}

const signed = (userId: string, secret = THREADS_SECRET, issuedAt = 1_790_000_000) =>
  signRequestForTest({ algorithm: 'HMAC-SHA256', issued_at: issuedAt, user_id: userId }, secret)

function callback(kind: 'uninstall' | 'delete', signedRequest: string | null, opts: { app?: FastifyInstance; contentType?: string; body?: string } = {}) {
  const form = signedRequest === null ? '' : `signed_request=${encodeURIComponent(signedRequest)}`
  return (opts.app ?? app).inject({
    method: 'POST',
    url: `/privacy/threads/${kind}`,
    headers: { 'content-type': opts.contentType ?? 'application/x-www-form-urlencoded' },
    payload: opts.body ?? form,
  })
}

describe('POST /privacy/threads/delete', () => {
  it('người dùng Threads đã biết → {url, confirmation_code}; 1 yêu cầu pending scope=all chỉ trang Threads đó; trang không đổi', async () => {
    const ids = await seed()
    const res = await callback('delete', signed(TH_OWNER))
    expect(res.statusCode).toBe(200)
    expect(res.headers['cache-control']).toBe('no-store')
    const body = MetaDataDeletionResponse.parse(res.json())
    expect(body.url).toBe(`${BASE}/privacy/status/${body.confirmation_code}`)
    const rows = await requests()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ code: body.confirmation_code, scope: 'all', status: 'pending', source: 'threads_delete', matched: true, page_ids: [ids.th], meta_account_id: null })
    const purge = await sinkEvents('privacy.purge_requested')
    expect(purge).toHaveLength(1)
    expect(purge[0]!.payload).toMatchObject({ scope: 'all', targetId: null, pageIds: [ids.th], metaAccountId: null })
    expect(await sinkEvents('page.disconnected')).toHaveLength(0)
    expect((await statusOf(ids.th))!.connection_status).toBe('active')
  })

  it('JSON {signed_request} cũng được nhận', async () => {
    await seed()
    const res = await callback('delete', null, { contentType: 'application/json', body: JSON.stringify({ signed_request: signed(TH_OWNER) }) })
    expect(res.statusCode).toBe(200)
    expect(await requests()).toHaveLength(1)
  })

  it('trang Threads đã gỡ (dữ liệu còn) → vẫn là người dùng đã biết, yêu cầu gồm trang đó', async () => {
    const ids = await seed()
    await handle.sql`update pages set removed_at = now() where id = ${ids.th}`
    expect((await callback('delete', signed(TH_OWNER))).statusCode).toBe(200)
    expect((await requests())[0]).toMatchObject({ status: 'pending', matched: true, page_ids: [ids.th] })
  })

  it('người dùng lạ (kể cả trùng fb_user_id của Meta App) → có mã, completed matched=false, không sự kiện; gọi lại → cùng mã', async () => {
    await seed()
    const first = MetaDataDeletionResponse.parse((await callback('delete', signed(FB_OWNER))).json())
    expect((await requests())[0]).toMatchObject({ status: 'completed', matched: false, source: 'threads_delete' })
    expect(await sinkEvents()).toHaveLength(0)
    const again = MetaDataDeletionResponse.parse((await callback('delete', signed(FB_OWNER))).json())
    expect(again.confirmation_code).toBe(first.confirmation_code)
    MetaDataDeletionResponse.parse((await callback('delete', signed(STRANGER))).json())
    expect(await requests()).toHaveLength(2)
  })

  it('đã xoá xong rồi Meta gửi lại `signed_request` cũ → mã cũ, không yêu cầu mới; mới hơn → yêu cầu mới', async () => {
    await seed()
    const first = MetaDataDeletionResponse.parse((await callback('delete', signed(TH_OWNER))).json())
    await handle.sql`update deletion_requests set status = 'completed', completed_at = now()`
    await boss.deleteAllJobs(SINK)
    const replay = MetaDataDeletionResponse.parse((await callback('delete', signed(TH_OWNER))).json())
    expect(replay.confirmation_code).toBe(first.confirmation_code)
    expect(await requests()).toHaveLength(1)
    const next = MetaDataDeletionResponse.parse((await callback('delete', signed(TH_OWNER, THREADS_SECRET, 1_790_000_100))).json())
    expect(next.confirmation_code).not.toBe(first.confirmation_code)
    expect(await sinkEvents('privacy.purge_requested')).toHaveLength(1)
  })
})

describe('POST /privacy/threads/uninstall', () => {
  it('ngắt đúng trang Threads (THREADS_DEAUTHORIZED), giữ FB / IG / Threads khác; 1 yêu cầu + 1 sự kiện', async () => {
    const ids = await seed()
    const res = await callback('uninstall', signed(TH_OWNER))
    expect(res.statusCode).toBe(200)
    expect(res.body).toBe('')
    expect(await statusOf(ids.th)).toEqual({ connection_status: 'disconnected', connection_status_reason: REASON_THREADS_DEAUTHORIZED })
    for (const id of [ids.fb, ids.ig, ids.th2]) expect((await statusOf(id))!.connection_status).toBe('active')
    expect(await sinkEvents('page.disconnected')).toHaveLength(1)
    expect((await requests())[0]).toMatchObject({ status: 'pending', source: 'threads_uninstall', page_ids: [ids.th] })
    expect(await sinkEvents('privacy.purge_requested')).toHaveLength(1)
  })

  it('gọi lại / gọi delete khi yêu cầu còn mở → cùng yêu cầu, không phát lại page.disconnected', async () => {
    await seed()
    await callback('uninstall', signed(TH_OWNER))
    await callback('uninstall', signed(TH_OWNER))
    const del = MetaDataDeletionResponse.parse((await callback('delete', signed(TH_OWNER))).json())
    const rows = await requests()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.code).toBe(del.confirmation_code)
    expect(await sinkEvents('page.disconnected')).toHaveLength(1)
    expect(await sinkEvents('privacy.purge_requested')).toHaveLength(1)
  })

  it('trang Threads đã gỡ → không ngắt (đã gỡ), vẫn ghi yêu cầu', async () => {
    const ids = await seed()
    await handle.sql`update pages set removed_at = now() where id = ${ids.th}`
    expect((await callback('uninstall', signed(TH_OWNER))).statusCode).toBe(200)
    expect(await sinkEvents('page.disconnected')).toHaveLength(0)
    expect(await requests()).toHaveLength(1)
  })

  it('người dùng lạ → 200, không ngắt trang nào, completed, không sự kiện', async () => {
    const ids = await seed()
    expect((await callback('uninstall', signed(STRANGER))).statusCode).toBe(200)
    for (const id of Object.values(ids)) expect((await statusOf(id))!.connection_status).toBe('active')
    expect((await requests())[0]).toMatchObject({ status: 'completed', matched: false })
    expect(await sinkEvents()).toHaveLength(0)
  })
})

describe('chữ ký sai / dữ liệu hỏng → 400, không ghi gì', () => {
  const cases: [string, () => ReturnType<typeof callback>][] = [
    ['ký bằng META_APP_SECRET', () => callback('delete', signed(TH_OWNER, META_SECRET))],
    ['secret lạ (uninstall)', () => callback('uninstall', signed(TH_OWNER, 'secret-khac'))],
    ['payload bị sửa', () => callback('uninstall', `${signed(TH_OWNER).split('.')[0]}.${Buffer.from(JSON.stringify({ algorithm: 'HMAC-SHA256', user_id: TH_OTHER })).toString('base64url')}`)],
    ['thiếu signed_request', () => callback('delete', null)],
    ['không có dấu chấm', () => callback('delete', 'abc')],
  ]
  for (const [name, run] of cases) {
    it(name, async () => {
      const ids = await seed()
      const res = await run()
      expect(res.statusCode).toBe(400)
      expect(res.json()).toMatchObject({ error: { code: 'VALIDATION_FAILED' } })
      expect(await requests()).toHaveLength(0)
      expect(await sinkEvents()).toHaveLength(0)
      for (const id of Object.values(ids)) expect((await statusOf(id))!.connection_status).toBe('active')
    })
  }

  it('content-type lạ → 415, không ghi', async () => {
    await seed()
    const res = await callback('delete', null, { contentType: 'application/octet-stream', body: `signed_request=${signed(TH_OWNER)}` })
    expect(res.statusCode).toBe(415)
    expect(await requests()).toHaveLength(0)
  })

  it('máy chủ chưa đặt THREADS_APP_SECRET → 400 + log cảnh báo; callback Meta App vẫn chạy', async () => {
    await seed()
    const bare = build({ threadsSecret: undefined })
    expect((await callback('delete', signed(TH_OWNER), { app: bare })).statusCode).toBe(400)
    expect(await requests()).toHaveLength(0)
    expect(logLines.join('')).toContain('thiếu THREADS_APP_SECRET')
    const meta = await bare.inject({
      method: 'POST',
      url: '/privacy/meta/data-deletion',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: `signed_request=${encodeURIComponent(signed(FB_OWNER, META_SECRET))}`,
    })
    expect(meta.statusCode).toBe(200)
    await bare.close()
  })
})

describe('trang trạng thái, config, log', () => {
  it('yêu cầu Threads → phạm vi "tài khoản Threads"', async () => {
    await seed()
    const { confirmation_code: code } = MetaDataDeletionResponse.parse((await callback('delete', signed(TH_OWNER))).json())
    const res = await app.inject({ method: 'GET', url: `/privacy/status/${code}` })
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('Dữ liệu gắn với tài khoản Threads đã cấp quyền')
    expect(res.body).not.toContain('tài khoản Facebook')
  })

  it('config có hai URL Threads tuyệt đối + threadsSecretConfigured', async () => {
    const { token } = await createSession(handle.db)
    const res = await app.inject({ method: 'GET', url: '/api/v1/privacy/config', headers: { cookie: `${SESSION_COOKIE}=${token}` } })
    expect(PrivacyConfigResponse.parse(res.json())).toMatchObject({
      threadsUninstallUrl: `${BASE}/privacy/threads/uninstall`,
      threadsDeleteUrl: `${BASE}/privacy/threads/delete`,
      threadsSecretConfigured: true,
    })
  })

  it('log không chứa user_id, signed_request, mã xác nhận', async () => {
    await seed()
    const sr = signed(TH_OWNER)
    const { confirmation_code: code } = MetaDataDeletionResponse.parse((await callback('delete', sr)).json())
    await callback('uninstall', sr)
    await callback('uninstall', signed(TH_OWNER, META_SECRET))
    const out = logLines.join('')
    expect(out).toContain('privacy: nhận yêu cầu từ Meta')
    expect(out).toContain('threads_delete')
    for (const secret of [TH_OWNER, sr, sr.split('.')[0]!, code]) expect(out).not.toContain(secret)
  })
})
