// Story 9.1 — trang chính sách + callback xoá dữ liệu của Meta (AD-22, AD-19), Postgres thật:
// - /privacy/policy công khai (CSP riêng, có / thiếu tên + email đơn vị vận hành), /privacy → 302, CSS;
// - data-deletion / deauthorize: verify `signed_request` → một transaction ghi `deletion_requests` + phát
//   `privacy.purge_requested` (deauthorize còn ngắt trang của tài khoản Meta); sai → 400 không ghi gì;
// - idempotent theo user id, người dùng lạ (không có dữ liệu) → `completed` không phát sự kiện;
// - /privacy/status/<code>, rate-limit, log không mang PII, /api/v1/privacy/config.
import { Writable } from 'node:stream'
import { MetaDataDeletionResponse, PrivacyConfigResponse } from '@ottm/shared'
import type { FastifyInstance } from 'fastify'
import type { PgBoss } from 'pg-boss'
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest'
import { buildApp } from '../src/app/app.ts'
import { SESSION_COOKIE } from '../src/app/auth/index.ts'
import { PRIVACY_CSP } from '../src/app/privacy-pages.ts'
import { REASON_META_DEAUTHORIZED } from '../src/modules/connections/index.ts'
import { upsertFromPlatform } from '../src/modules/pages/index.ts'
import { signRequestForTest } from '../src/modules/privacy/index.ts'
import { createSession } from '../src/modules/settings/index.ts'
import { createDb, type DbHandle } from '../src/platform/db/index.ts'
import { createEventPublisher, type EventPublisher } from '../src/platform/events/index.ts'
import { BOSS_SCHEMA, createBoss, ensureQueues } from '../src/platform/jobs/index.ts'
import { createLogger } from '../src/platform/log/index.ts'

const SECRET = 'meta-app-secret-123'
const BASE = 'https://api.example.com'
const OWNER = '100200300'
const OTHER = '900800700'
const STRANGER = '555000555'
const SINK = 'testonly.privacy_sink'
const SINK_EVENTS = ['privacy.purge_requested', 'page.disconnected'] as const
const OPERATOR = { name: 'Shop <Mỹ Phẩm> & Co', email: 'lienhe@shop.example' }

let handle: DbHandle
let boss: PgBoss
let events: EventPublisher
let app: FastifyInstance
let logLines: string[] = []

function build(opts: { secret?: string | undefined; operator?: { name?: string; email?: string }; limits?: { callbackPerMinute?: number; pagePerMinute?: number } } = {}) {
  const sink = new Writable({
    write(chunk, _enc, cb) {
      logLines.push(String(chunk))
      cb()
    },
  })
  return buildApp({
    sql: handle.sql,
    db: handle.db,
    logger: createLogger({ level: 'info' }, sink),
    events,
    privacy: {
      ...('secret' in opts ? (opts.secret ? { metaAppSecret: opts.secret } : {}) : { metaAppSecret: SECRET }),
      publicBaseUrl: BASE,
      operator: opts.operator ?? OPERATOR,
      ...(opts.limits ? { limits: opts.limits } : {}),
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
  boss = createBoss(inject('databaseUrl'), 'ottm-test-privacy', { background: false })
  boss.on('error', () => {})
  await boss.start()
  await ensureQueues(boss)
  await boss.createQueue(SINK)
  for (const e of SINK_EVENTS) await boss.subscribe(e, SINK)
  events = createEventPublisher(boss)
  // App chung của file: nới rate-limit (test rate-limit dựng app riêng với mức thấp).
  app = build({ limits: { callbackPerMinute: 1000, pagePerMinute: 1000 } })
  await app.ready()
})
afterAll(async () => {
  await app.close()
  await wipe()
  for (const e of SINK_EVENTS) await boss.unsubscribe(e, SINK)
  await boss.deleteQueue(SINK)
  // `page.disconnected` còn tới queue sự kiện thật (notifications, campaigns…) — không để test khác nhận.
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
  return handle.sql<{ code: string; scope: string; target_id: string | null; status: string; source: string; matched: boolean; subject_hash: string; completed_at: Date | null }[]>`
    select code, scope, target_id, status, source, matched, subject_hash, completed_at from deletion_requests order by requested_at`
}

async function statusOf(pageId: string) {
  const [row] = await handle.sql<{ connection_status: string; connection_status_reason: string | null }[]>`
    select connection_status, connection_status_reason from pages where id = ${pageId}`
  return row
}

/** Chủ shop (OWNER) có Fanpage + IG dùng chung token + Threads; một tài khoản Meta khác (OTHER) có Fanpage riêng. */
async function seed() {
  const [owner] = await handle.sql<{ id: string }[]>`
    insert into meta_accounts (fb_user_id, name, user_token) values (${OWNER}, 'Chủ shop', 'v1:k1:x') returning id`
  const [other] = await handle.sql<{ id: string }[]>`
    insert into meta_accounts (fb_user_id, name, user_token) values (${OTHER}, 'Người khác', 'v1:k1:y') returning id`
  const fb = (await upsertFromPlatform(handle.db, { platform: 'facebook', platformAccountId: 'FB1', name: 'FB', handle: null, avatarUrl: null })).page
  const ig = (await upsertFromPlatform(handle.db, { platform: 'instagram', platformAccountId: 'IG1', name: 'IG', handle: 'ig', avatarUrl: null })).page
  const th = (await upsertFromPlatform(handle.db, { platform: 'threads', platformAccountId: 'TH1', name: 'TH', handle: 'th', avatarUrl: null })).page
  const fb2 = (await upsertFromPlatform(handle.db, { platform: 'facebook', platformAccountId: 'FB2', name: 'FB2', handle: null, avatarUrl: null })).page
  await handle.sql`insert into page_credentials (page_id, meta_account_id, access_token) values (${fb.id}, ${owner!.id}, 'v1:k1:p')`
  await handle.sql`insert into page_credentials (page_id, meta_account_id, token_source_page_id) values (${ig.id}, ${owner!.id}, ${fb.id})`
  await handle.sql`insert into page_credentials (page_id, access_token) values (${th.id}, 'v1:k1:t')`
  await handle.sql`insert into page_credentials (page_id, meta_account_id, access_token) values (${fb2.id}, ${other!.id}, 'v1:k1:q')`
  return { fb: fb.id, ig: ig.id, th: th.id, fb2: fb2.id }
}

const signed = (userId: string, secret = SECRET, issuedAt = 1_790_000_000) =>
  signRequestForTest({ algorithm: 'HMAC-SHA256', issued_at: issuedAt, user_id: userId }, secret)

function callback(kind: 'deauthorize' | 'data-deletion', signedRequest: string | null, opts: { app?: FastifyInstance; contentType?: string; body?: string } = {}) {
  const form = signedRequest === null ? '' : `signed_request=${encodeURIComponent(signedRequest)}`
  return (opts.app ?? app).inject({
    method: 'POST',
    url: `/privacy/meta/${kind}`,
    headers: { 'content-type': opts.contentType ?? 'application/x-www-form-urlencoded' },
    payload: opts.body ?? form,
  })
}

describe('GET /privacy/policy — công khai', () => {
  it('không phiên → 200 HTML, đủ các mục, tên + email đã escape, CSP riêng, CSS tải được', async () => {
    const res = await app.inject({ method: 'GET', url: '/privacy/policy' })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('text/html')
    expect(res.headers['content-security-policy']).toBe(PRIVACY_CSP)
    const html = res.body
    for (const s of ['Dữ liệu chúng tôi thu thập', 'OpenAI', 'store: false', 'Thời gian lưu trữ', '30 ngày', '90 ngày', 'yêu cầu xoá dữ liệu']) {
      expect(html).toContain(s)
    }
    expect(html).toContain('Shop &lt;Mỹ Phẩm&gt; &amp; Co')
    expect(html).not.toContain('<Mỹ Phẩm>')
    expect(html).toContain('mailto:lienhe@shop.example')
    expect(html).not.toContain('Chưa điền')
    expect(html).not.toMatch(/<script|style=/)

    const css = await app.inject({ method: 'GET', url: '/privacy/assets/privacy.css' })
    expect(css.statusCode).toBe(200)
    expect(css.headers['content-type']).toContain('text/css')
  })

  it('thiếu tên + email → chỗ trống đánh dấu; /privacy → 302 về /privacy/policy', async () => {
    const bare = build({ operator: {} })
    const res = await bare.inject({ method: 'GET', url: '/privacy/policy' })
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('[Chưa điền: tên đơn vị vận hành]')
    expect(res.body).toContain('[Chưa điền: email liên hệ]')
    const root = await bare.inject({ method: 'GET', url: '/privacy' })
    expect(root.statusCode).toBe(302)
    expect(root.headers.location).toBe('/privacy/policy')
    await bare.close()
  })
})

describe('POST /privacy/meta/data-deletion', () => {
  it('người dùng đã biết → {url, confirmation_code}, 1 yêu cầu pending scope=all, 1 purge_requested, trang không đổi', async () => {
    const ids = await seed()
    const res = await callback('data-deletion', signed(OWNER))
    expect(res.statusCode).toBe(200)
    const body = MetaDataDeletionResponse.parse(res.json())
    expect(body.url).toBe(`${BASE}/privacy/status/${body.confirmation_code}`)
    expect(body.confirmation_code).toMatch(/^[0-9a-f]{32}$/)
    const rows = await requests()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ code: body.confirmation_code, scope: 'all', target_id: null, status: 'pending', source: 'meta_data_deletion', matched: true })
    expect(rows[0]!.subject_hash).not.toContain(OWNER)
    const purge = await sinkEvents('privacy.purge_requested')
    expect(purge).toHaveLength(1)
    expect(purge[0]!.payload).toMatchObject({ scope: 'all', targetId: null })
    expect(await sinkEvents('page.disconnected')).toHaveLength(0)
    expect((await statusOf(ids.fb))!.connection_status).toBe('active')
  })

  it('JSON {signed_request} cũng được nhận', async () => {
    await seed()
    const res = await callback('data-deletion', null, { contentType: 'application/json', body: JSON.stringify({ signed_request: signed(OWNER) }) })
    expect(res.statusCode).toBe(200)
    expect(await requests()).toHaveLength(1)
  })

  it('gọi lại / gọi deauthorize của cùng người khi yêu cầu còn mở → cùng mã, không thêm dòng / sự kiện', async () => {
    await seed()
    const first = MetaDataDeletionResponse.parse((await callback('data-deletion', signed(OWNER))).json())
    const again = MetaDataDeletionResponse.parse((await callback('data-deletion', signed(OWNER))).json())
    expect(again.confirmation_code).toBe(first.confirmation_code)
    expect((await callback('deauthorize', signed(OWNER))).statusCode).toBe(200)
    expect(await requests()).toHaveLength(1)
    expect(await sinkEvents('privacy.purge_requested')).toHaveLength(1)
  })

  it('song song cùng người → một yêu cầu, một mã', async () => {
    await seed()
    const all = await Promise.all([1, 2, 3, 4].map(() => callback('data-deletion', signed(OWNER))))
    const codes = new Set(all.map((r) => MetaDataDeletionResponse.parse(r.json()).confirmation_code))
    expect(codes.size).toBe(1)
    expect(await requests()).toHaveLength(1)
    expect(await sinkEvents('privacy.purge_requested')).toHaveLength(1)
  })

  it('người dùng lạ → vẫn có mã, dòng completed matched=false, KHÔNG phát sự kiện; gọi lại → cùng mã', async () => {
    await seed()
    const first = MetaDataDeletionResponse.parse((await callback('data-deletion', signed(STRANGER))).json())
    const rows = await requests()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ status: 'completed', matched: false, scope: 'all' })
    expect(rows[0]!.completed_at).not.toBeNull()
    expect(await sinkEvents()).toHaveLength(0)
    const again = MetaDataDeletionResponse.parse((await callback('data-deletion', signed(STRANGER))).json())
    expect(again.confirmation_code).toBe(first.confirmation_code)
    expect(await requests()).toHaveLength(1)
  })

  it('yêu cầu cũ đã xoá xong (matched) mà người dùng vẫn có dữ liệu → mã mới, yêu cầu mới, 1 sự kiện mới', async () => {
    await seed()
    const first = MetaDataDeletionResponse.parse((await callback('data-deletion', signed(OWNER))).json())
    await handle.sql`update deletion_requests set status = 'completed', completed_at = now()`
    await boss.deleteAllJobs(SINK)
    // Story 9.2: `signed_request` mới hơn (cùng `issued_at` = phát lại → mã cũ, xem privacy-purge.test.ts).
    const next = MetaDataDeletionResponse.parse((await callback('data-deletion', signed(OWNER, SECRET, 1_790_000_100))).json())
    expect(next.confirmation_code).not.toBe(first.confirmation_code)
    expect((await requests()).map((r) => r.status)).toEqual(['completed', 'pending'])
    expect(await sinkEvents('privacy.purge_requested')).toHaveLength(1)
  })
})

describe('POST /privacy/meta/deauthorize', () => {
  it('ngắt FB + IG của tài khoản (lý do META_DEAUTHORIZED), giữ Threads + tài khoản khác; 1 yêu cầu + 1 sự kiện', async () => {
    const ids = await seed()
    const res = await callback('deauthorize', signed(OWNER))
    expect(res.statusCode).toBe(200)
    expect(res.body).toBe('')
    expect(await statusOf(ids.fb)).toEqual({ connection_status: 'disconnected', connection_status_reason: REASON_META_DEAUTHORIZED })
    expect((await statusOf(ids.ig))!.connection_status).toBe('disconnected')
    expect((await statusOf(ids.th))!.connection_status).toBe('active')
    expect((await statusOf(ids.fb2))!.connection_status).toBe('active')
    const disc = await sinkEvents('page.disconnected')
    expect(disc.map((d) => d.payload.id).sort()).toEqual([ids.fb, ids.ig].sort())
    const rows = await requests()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ source: 'meta_deauthorize', status: 'pending', scope: 'all' })
    expect(await sinkEvents('privacy.purge_requested')).toHaveLength(1)
  })

  it('gọi lại → không phát lại page.disconnected, không thêm yêu cầu', async () => {
    await seed()
    await callback('deauthorize', signed(OWNER))
    await boss.deleteAllJobs(SINK)
    expect((await callback('deauthorize', signed(OWNER))).statusCode).toBe(200)
    expect(await sinkEvents()).toHaveLength(0)
    expect(await requests()).toHaveLength(1)
  })

  it('người dùng lạ → 200, không ngắt trang nào, dòng completed, không sự kiện', async () => {
    const ids = await seed()
    expect((await callback('deauthorize', signed(STRANGER))).statusCode).toBe(200)
    for (const id of Object.values(ids)) expect((await statusOf(id))!.connection_status).toBe('active')
    expect((await requests())[0]).toMatchObject({ status: 'completed', matched: false })
    expect(await sinkEvents()).toHaveLength(0)
  })
})

describe('signed_request sai → 400, không ghi gì', () => {
  const bad: [string, () => Promise<{ statusCode: number }>][] = [
    ['secret khác', () => callback('data-deletion', signed(OWNER, 'secret-khac'))],
    ['payload bị sửa', () => callback('deauthorize', `${signed(OWNER).split('.')[0]}.${Buffer.from(JSON.stringify({ algorithm: 'HMAC-SHA256', user_id: OTHER })).toString('base64url')}`)],
    ['chữ ký cắt ngắn', () => callback('deauthorize', signed(OWNER).slice(6))],
    ['thiếu signed_request', () => callback('data-deletion', null)],
    ['không có dấu chấm', () => callback('data-deletion', 'khongcodaucham')],
    ['algorithm khác', () => callback('data-deletion', signRequestForTest({ algorithm: 'HMAC-SHA1', user_id: OWNER }, SECRET))],
    ['không có user_id', () => callback('deauthorize', signRequestForTest({ algorithm: 'HMAC-SHA256' }, SECRET))],
  ]
  for (const [name, run] of bad) {
    it(name, async () => {
      const ids = await seed()
      const res = await run()
      expect(res.statusCode).toBe(400)
      expect((res as unknown as { json(): unknown }).json()).toMatchObject({ error: { code: 'VALIDATION_FAILED' } })
      expect(await requests()).toHaveLength(0)
      expect(await sinkEvents()).toHaveLength(0)
      for (const id of Object.values(ids)) expect((await statusOf(id))!.connection_status).toBe('active')
    })
  }

  it('content-type lạ → 415; text/plain (không phải form) → 400; không ghi', async () => {
    await seed()
    const res = await callback('data-deletion', null, { contentType: 'application/octet-stream', body: `signed_request=${signed(OWNER)}` })
    expect(res.statusCode).toBe(415)
    const text = await callback('data-deletion', null, { contentType: 'text/plain', body: `signed_request=${signed(OWNER)}` })
    expect(text.statusCode).toBe(400)
    expect(await requests()).toHaveLength(0)
  })

  it('máy chủ chưa đặt META_APP_SECRET → 400 + log cảnh báo, không ghi', async () => {
    await seed()
    const bare = build({ secret: undefined })
    const res = await callback('data-deletion', signed(OWNER), { app: bare })
    expect(res.statusCode).toBe(400)
    expect(await requests()).toHaveLength(0)
    expect(logLines.join('')).toContain('thiếu META_APP_SECRET')
    await bare.close()
  })
})

describe('GET /privacy/status/:code', () => {
  it('pending → "đang chờ xoá"; completed → "Đã xoá xong"; header no-store, no-referrer, noindex, CSP', async () => {
    await seed()
    const { confirmation_code: code } = MetaDataDeletionResponse.parse((await callback('data-deletion', signed(OWNER))).json())
    const res = await app.inject({ method: 'GET', url: `/privacy/status/${code}` })
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('Đã nhận — đang chờ xoá')
    expect(res.body).toContain(code)
    expect(res.headers['cache-control']).toBe('no-store')
    expect(res.headers['referrer-policy']).toBe('no-referrer')
    expect(res.headers['x-robots-tag']).toContain('noindex')
    expect(res.headers['content-security-policy']).toBe(PRIVACY_CSP)

    await handle.sql`update deletion_requests set status = 'completed', completed_at = now()`
    const done = await app.inject({ method: 'GET', url: `/privacy/status/${code}` })
    expect(done.body).toContain('Đã xoá xong')
    expect(done.body).toContain('Hoàn tất lúc')
  })

  it('người dùng lạ → "không lưu dữ liệu nào"', async () => {
    const { confirmation_code: code } = MetaDataDeletionResponse.parse((await callback('data-deletion', signed(STRANGER))).json())
    const res = await app.inject({ method: 'GET', url: `/privacy/status/${code}` })
    expect(res.body).toContain('không lưu dữ liệu nào')
  })

  it('mã không có / sai dạng → 404 HTML', async () => {
    for (const code of ['0'.repeat(32), 'khong-dung-dang', 'A'.repeat(32)]) {
      const res = await app.inject({ method: 'GET', url: `/privacy/status/${code}` })
      expect(res.statusCode).toBe(404)
      expect(res.headers['content-type']).toContain('text/html')
      expect(res.body).toContain('Không tìm thấy yêu cầu')
    }
  })
})

describe('rate-limit + log', () => {
  it('vượt hạn mức POST trong một phút → 429, không ghi thêm', async () => {
    await seed()
    const limited = build({ limits: { callbackPerMinute: 2 } })
    expect((await callback('data-deletion', signed(STRANGER), { app: limited })).statusCode).toBe(200)
    expect((await callback('data-deletion', signed(OWNER), { app: limited })).statusCode).toBe(200)
    expect((await callback('data-deletion', signed(OTHER), { app: limited })).statusCode).toBe(429)
    expect(await requests()).toHaveLength(2)
    await limited.close()
  })

  it('vượt hạn mức trang GET → 429', async () => {
    const limited = build({ limits: { pagePerMinute: 1 } })
    expect((await limited.inject({ method: 'GET', url: '/privacy/policy' })).statusCode).toBe(200)
    expect((await limited.inject({ method: 'GET', url: '/privacy/policy' })).statusCode).toBe(429)
    await limited.close()
  })

  it('log không chứa user_id, signed_request, mã xác nhận', async () => {
    await seed()
    const sr = signed(OWNER)
    const { confirmation_code: code } = MetaDataDeletionResponse.parse((await callback('data-deletion', sr)).json())
    await callback('deauthorize', sr)
    await callback('deauthorize', signed(OWNER, 'secret-khac'))
    await app.inject({ method: 'GET', url: `/privacy/status/${code}` })
    const out = logLines.join('')
    expect(out).toContain('privacy: nhận yêu cầu từ Meta')
    expect(out).toContain('/privacy/status/REDACTED')
    for (const secret of [OWNER, sr, sr.split('.')[0]!, code]) expect(out).not.toContain(secret)
  })
})

describe('GET /api/v1/privacy/config', () => {
  it('không phiên → 401; có phiên → URL tuyệt đối theo PUBLIC_BASE_URL', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/v1/privacy/config' })).statusCode).toBe(401)
    const { token } = await createSession(handle.db)
    const res = await app.inject({ method: 'GET', url: '/api/v1/privacy/config', headers: { cookie: `${SESSION_COOKIE}=${token}` } })
    expect(res.statusCode).toBe(200)
    expect(PrivacyConfigResponse.parse(res.json())).toEqual({
      policyUrl: `${BASE}/privacy/policy`,
      deauthorizeUrl: `${BASE}/privacy/meta/deauthorize`,
      dataDeletionUrl: `${BASE}/privacy/meta/data-deletion`,
      operatorConfigured: true,
      metaSecretConfigured: true,
      threadsUninstallUrl: `${BASE}/privacy/threads/uninstall`,
      threadsDeleteUrl: `${BASE}/privacy/threads/delete`,
      threadsSecretConfigured: false,
    })
    const bare = build({ secret: undefined, operator: { name: 'Shop' } })
    const res2 = await bare.inject({ method: 'GET', url: '/api/v1/privacy/config', headers: { cookie: `${SESSION_COOKIE}=${token}` } })
    expect(PrivacyConfigResponse.parse(res2.json())).toMatchObject({ operatorConfigured: false, metaSecretConfigured: false })
    await bare.close()
  })
})
