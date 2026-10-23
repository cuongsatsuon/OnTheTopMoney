// adapters/meta/client với HTTP server cục bộ và store thật (`connections.createRateStore` trên `meta_rate_state`):
// mọi dòng ma trận Story 2.1, `appsecret_proof` đúng, log không chứa token.
import { createHmac } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Writable } from 'node:stream'
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest'
import {
  createGraphClient,
  createMetaClient,
  createThreadsClient,
  publishedRefFromFacebook,
  type MetaClient,
} from '../src/adapters/meta/index.ts'
import { createFakeMetaClient } from '../src/adapters/meta/fake.ts'
import { createRateStore } from '../src/modules/connections/index.ts'
import { createDb, type DbHandle } from '../src/platform/db/index.ts'
import { createLogger } from '../src/platform/log/index.ts'
import { freePort } from './helpers/net.ts'

const TOKEN = 'EAAB-PAGE-TOKEN-S3CR3T'
const APP_SECRET = 'app-secret-S3CR3T'
const SCOPE = 'page:111'
const T0 = new Date('2026-10-22T03:00:00.000Z')

let handle: DbHandle
let server: Server
let baseUrl: string
let clock = T0
let handler: (req: IncomingMessage, res: ServerResponse) => void = () => {}
const seen: { method?: string; url: URL; body: string; contentType?: string }[] = []
const logLines: string[] = []

const sink = new Writable({
  write(chunk, _enc, cb) {
    logLines.push(String(chunk))
    cb()
  },
})
const log = createLogger({ level: 'debug', name: 'meta-test' }, sink)

function client(overrides: Partial<Parameters<typeof createMetaClient>[0]> = {}): MetaClient {
  return createMetaClient({
    baseUrl,
    version: 'v26.0',
    appSecret: APP_SECRET,
    rateStore: createRateStore(handle.db),
    now: () => clock,
    log,
    ...overrides,
  })
}

function reply(status: number, body: unknown, headers: Record<string, string> = {}) {
  handler = (_req, res) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers })
    res.end(typeof body === 'string' ? body : JSON.stringify(body))
  }
}

const metaError = (code: number, subcode?: number) => ({
  error: { message: 'x', type: 'OAuthException', code, ...(subcode ? { error_subcode: subcode } : {}), fbtrace_id: 'FBTRACE' },
})

async function rateRows() {
  // Client postgres.js thô trả timestamptz dạng chuỗi → đổi sang Date để so.
  const rows = await handle.sql<{ scope: string; bucket: string; usage_pct: number; blocked_until: string | null }[]>`
    select scope, bucket, usage_pct, blocked_until from meta_rate_state order by scope, bucket`
  return rows.map((r) => ({ ...r, blocked_until: r.blocked_until === null ? null : new Date(r.blocked_until) }))
}

beforeAll(async () => {
  handle = createDb(inject('databaseUrl'), { max: 3 })
  server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      seen.push({ method: req.method, url: new URL(req.url ?? '/', 'http://x'), body, contentType: req.headers['content-type'] })
      handler(req, res)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(async () => {
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
  await handle.close()
})
beforeEach(async () => {
  await handle.sql`delete from meta_rate_state`
  seen.length = 0
  logLines.length = 0
  clock = T0
})

describe('lời gọi thành công', () => {
  it('200 JSON → {ok:true, data}; usage từ header được ghi meta_rate_state', async () => {
    reply(200, { data: [{ id: '111', name: 'Shop' }] }, {
      'x-app-usage': '{"call_count":12,"total_time":30,"total_cputime":7}',
      'x-business-use-case-usage': JSON.stringify({ '111': [{ type: 'pages', call_count: 40, total_cputime: 2, total_time: 3, estimated_time_to_regain_access: 0 }] }),
    })
    const r = await client().get('/me/accounts', { token: TOKEN, tier: 'interactive', scope: SCOPE, params: { fields: 'id,name' } })
    expect(r).toEqual({ ok: true, data: { data: [{ id: '111', name: 'Shop' }] } })
    expect(seen).toHaveLength(1)
    expect(seen[0]?.method).toBe('GET')
    expect(seen[0]?.url.pathname).toBe('/v26.0/me/accounts')
    expect(seen[0]?.url.searchParams.get('fields')).toBe('id,name')
    expect(await rateRows()).toEqual([
      { scope: 'app:graph', bucket: 'app', usage_pct: 30, blocked_until: null },
      { scope: SCOPE, bucket: 'buc', usage_pct: 40, blocked_until: null },
    ])
  })

  it('header usage hỏng → bỏ qua, không lỗi', async () => {
    reply(200, { id: '1' }, { 'x-app-usage': '{broken', 'x-business-use-case-usage': '[]' })
    expect(await client().get('/1', { token: TOKEN, tier: 'background', scope: SCOPE })).toEqual({ ok: true, data: { id: '1' } })
    expect(await rateRows()).toEqual([])
  })

  it('appsecret_proof = HMAC-SHA256(token, app secret) hex; token trong access_token', async () => {
    reply(200, {})
    await client().get('/me', { token: TOKEN, tier: 'interactive', scope: SCOPE })
    const q = seen[0]!.url.searchParams
    expect(q.get('access_token')).toBe(TOKEN)
    expect(q.get('appsecret_proof')).toBe(createHmac('sha256', APP_SECRET).update(TOKEN).digest('hex'))
    expect(q.get('appsecret_proof')).toMatch(/^[0-9a-f]{64}$/)
  })

  it('không có app secret → không gửi appsecret_proof; không token → không gửi cả hai', async () => {
    reply(200, {})
    await client({ appSecret: undefined }).get('/me', { token: TOKEN, tier: 'interactive', scope: SCOPE })
    await client().get('/oauth/access_token', { tier: 'interactive', scope: 'app', params: { grant_type: 'fb_exchange_token' } })
    expect(seen[0]!.url.searchParams.has('appsecret_proof')).toBe(false)
    expect(seen[1]!.url.searchParams.has('access_token')).toBe(false)
    expect(seen[1]!.url.searchParams.has('appsecret_proof')).toBe(false)
  })

  it('POST gửi body JSON; Id bài FB đăng ảnh → platformPostId = post_id', async () => {
    reply(200, { id: '555', post_id: '111_777' })
    const r = await client().post<{ id: string; post_id?: string }>('/111/photos', {
      token: TOKEN,
      tier: 'publish',
      scope: SCOPE,
      body: { url: 'https://app.example.com/media/a.jpg', caption: 'Xin chào' },
    })
    expect(seen[0]?.method).toBe('POST')
    expect(seen[0]?.contentType).toBe('application/json')
    expect(JSON.parse(seen[0]!.body)).toEqual({ url: 'https://app.example.com/media/a.jpg', caption: 'Xin chào' })
    expect(r.ok && publishedRefFromFacebook('111', r.data)).toEqual({ platformPostId: '111_777' })
  })
})

describe('lỗi Meta', () => {
  it.each([
    [400, metaError(190), 'TOKEN_INVALID'],
    [400, metaError(10, 2018278), 'OUTSIDE_WINDOW'],
    [400, metaError(200, 1545041), 'RECIPIENT_UNAVAILABLE'],
    [403, metaError(10), 'PERMISSION_DENIED'],
    [400, metaError(613, 2018338), 'REJECTED'],
    [400, metaError(424242), 'REJECTED'],
    [500, metaError(2), 'TRANSIENT'],
    [502, '<html>bad gateway</html>', 'TRANSIENT'],
  ])('HTTP %i %j → %s', async (status, body, kind) => {
    reply(status, body)
    const r = await client().get('/me', { token: TOKEN, tier: 'interactive', scope: SCOPE })
    expect(r).toMatchObject({ ok: false, kind, status })
    if (typeof body === 'object') expect(r).toMatchObject({ code: body.error.code, fbtraceId: 'FBTRACE' })
    expect(JSON.stringify(r)).not.toContain(TOKEN)
  })

  it('200 mà body có error → phân loại như lỗi (190 → TOKEN_INVALID)', async () => {
    reply(200, metaError(190))
    expect(await client().get('/me', { token: TOKEN, tier: 'interactive', scope: SCOPE })).toMatchObject({ ok: false, kind: 'TOKEN_INVALID', status: 200, code: 190 })
  })

  it('2xx body rỗng → TRANSIENT; 204 → ok, data undefined', async () => {
    reply(200, '')
    expect(await client().post('/x', { token: TOKEN, tier: 'publish', scope: SCOPE })).toEqual({ ok: false, kind: 'TRANSIENT', status: 200 })
    handler = (_req, res) => {
      res.writeHead(204)
      res.end()
    }
    expect(await client().post('/x', { token: TOKEN, tier: 'publish', scope: SCOPE })).toEqual({ ok: true, data: undefined })
  })

  it('HTTP 429 không có mã Meta: RATE_LIMITED, retryAfterMs theo Retry-After, chặn scope', async () => {
    reply(429, '<html>Too Many Requests</html>', { 'content-type': 'text/html', 'retry-after': '120' })
    expect(await client().get('/x', { token: TOKEN, tier: 'interactive', scope: SCOPE })).toEqual({
      ok: false,
      kind: 'RATE_LIMITED',
      status: 429,
      retryAfterMs: 120_000,
    })
    expect((await rateRows()).find((r) => r.bucket === 'blocked')).toMatchObject({ scope: SCOPE, blocked_until: new Date(T0.getTime() + 120_000) })
  })

  it('200 mà body không phải JSON → TRANSIENT', async () => {
    reply(200, 'not json')
    expect(await client().get('/me', { token: TOKEN, tier: 'interactive', scope: SCOPE })).toEqual({ ok: false, kind: 'TRANSIENT', status: 200 })
  })
})

describe('ngân sách tần suất', () => {
  async function primeUsage(pct: number) {
    reply(200, {}, { 'x-business-use-case-usage': JSON.stringify({ '111': [{ type: 'pages', call_count: pct, total_cputime: 1, total_time: 1 }] }) })
    await client().get('/prime', { token: TOKEN, tier: 'interactive', scope: SCOPE })
    seen.length = 0
  }

  it('usage 80%: background bị từ chối trước khi gửi; publish và interactive vẫn gửi', async () => {
    await primeUsage(80)
    reply(200, { ok: 1 })
    const bg = await client().get('/x', { token: TOKEN, tier: 'background', scope: SCOPE })
    expect(bg).toMatchObject({ ok: false, kind: 'RATE_LIMITED' })
    expect(bg.ok ? 0 : bg.retryAfterMs).toBeGreaterThan(0)
    expect(seen).toHaveLength(0)
    expect((await client().get('/x', { token: TOKEN, tier: 'publish', scope: SCOPE })).ok).toBe(true)
    expect((await client().get('/x', { token: TOKEN, tier: 'interactive', scope: SCOPE })).ok).toBe(true)
    expect(seen).toHaveLength(2)
  })

  it('usage 92%: publish và background bị từ chối; interactive vẫn gửi', async () => {
    await primeUsage(92)
    reply(200, {})
    expect(await client().post('/x', { token: TOKEN, tier: 'publish', scope: SCOPE })).toMatchObject({ ok: false, kind: 'RATE_LIMITED' })
    expect(await client().get('/x', { token: TOKEN, tier: 'background', scope: SCOPE })).toMatchObject({ ok: false, kind: 'RATE_LIMITED' })
    expect(seen).toHaveLength(0)
    expect((await client().get('/x', { token: TOKEN, tier: 'interactive', scope: SCOPE })).ok).toBe(true)
    expect(seen).toHaveLength(1)
  })

  it('header estimated_time_to_regain_access: 5 → blocked_until = now + 5 phút; mọi hạng bị chặn tới khi hết hạn', async () => {
    reply(200, {}, {
      'x-business-use-case-usage': JSON.stringify({ '111': [{ type: 'pages', call_count: 100, total_cputime: 10, total_time: 10, estimated_time_to_regain_access: 5 }] }),
    })
    expect((await client().get('/x', { token: TOKEN, tier: 'interactive', scope: SCOPE })).ok).toBe(true)
    expect((await rateRows()).find((r) => r.bucket === 'buc')?.blocked_until).toEqual(new Date(T0.getTime() + 5 * 60_000))
    seen.length = 0

    clock = new Date(T0.getTime() + 2 * 60_000)
    for (const tier of ['interactive', 'publish', 'background'] as const) {
      expect(await client().get('/x', { token: TOKEN, tier, scope: SCOPE })).toEqual({ ok: false, kind: 'RATE_LIMITED', retryAfterMs: 3 * 60_000, notSent: true })
    }
    expect(seen).toHaveLength(0)

    // Hết hạn chặn → gửi lại được (mọi hạng).
    reply(200, { ok: 1 })
    clock = new Date(T0.getTime() + 5 * 60_000 + 1)
    for (const tier of ['interactive', 'publish', 'background'] as const) {
      expect((await client().get('/x', { token: TOKEN, tier, scope: SCOPE })).ok).toBe(true)
    }
    expect(seen).toHaveLength(3)
  })

  it('lỗi 80001 kèm header regain 5 → RATE_LIMITED{retryAfterMs: 5 phút}, chặn scope; scope khác không bị chặn', async () => {
    reply(400, metaError(80001), {
      'x-business-use-case-usage': JSON.stringify({ '111': [{ type: 'pages', call_count: 100, total_cputime: 1, total_time: 1, estimated_time_to_regain_access: 5 }] }),
    })
    expect(await client().get('/x', { token: TOKEN, tier: 'interactive', scope: SCOPE })).toMatchObject({
      ok: false,
      kind: 'RATE_LIMITED',
      code: 80001,
      retryAfterMs: 5 * 60_000,
    })
    expect((await rateRows()).find((r) => r.bucket === 'blocked')).toMatchObject({ scope: SCOPE, blocked_until: new Date(T0.getTime() + 5 * 60_000) })
    seen.length = 0
    expect(await client().get('/x', { token: TOKEN, tier: 'interactive', scope: SCOPE })).toEqual({ ok: false, kind: 'RATE_LIMITED', retryAfterMs: 5 * 60_000, notSent: true })
    reply(200, {})
    expect((await client().get('/x', { token: TOKEN, tier: 'interactive', scope: 'page:222' })).ok).toBe(true)
    expect(seen).toHaveLength(1)
  })

  it('BUC của trang khác trong phản hồi được ghi cho trang đó, không giữ trang của lời gọi', async () => {
    reply(200, {}, {
      'x-business-use-case-usage': JSON.stringify({ '222': [{ type: 'pages', call_count: 100, total_cputime: 1, total_time: 1, estimated_time_to_regain_access: 3 }] }),
    })
    await client().get('/x', { token: TOKEN, tier: 'interactive', scope: SCOPE })
    expect((await rateRows()).map((r) => `${r.scope}/${r.bucket}`)).toEqual(['page:222/buc'])
    reply(200, {})
    expect((await client().get('/x', { token: TOKEN, tier: 'background', scope: SCOPE })).ok).toBe(true)
    expect(await client().get('/x', { token: TOKEN, tier: 'interactive', scope: 'page:222' })).toEqual({ ok: false, kind: 'RATE_LIMITED', retryAfterMs: 3 * 60_000, notSent: true })
  })

  it('Threads bị chặn mức app (mã 4) không giữ lời gọi Graph', async () => {
    const rateStore = createRateStore(handle.db)
    const threads = createThreadsClient({ baseUrl, rateStore, now: () => clock })
    const graph = createGraphClient({ baseUrl, rateStore, now: () => clock })
    reply(400, metaError(4), { 'x-app-usage': '{"call_count":100}' })
    expect(await threads.get('/me', { token: TOKEN, tier: 'interactive', scope: 'threads:1' })).toMatchObject({ kind: 'RATE_LIMITED' })
    expect((await rateRows()).map((r) => `${r.scope}/${r.bucket}`)).toEqual(['app:threads/app', 'app:threads/blocked'])
    expect(await threads.get('/me', { token: TOKEN, tier: 'interactive', scope: 'threads:2' })).toMatchObject({ kind: 'RATE_LIMITED' })
    reply(200, { id: 'p' })
    expect(await graph.get('/me', { token: TOKEN, tier: 'background', scope: SCOPE })).toEqual({ ok: true, data: { id: 'p' } })
  })

  it('lỗi 80001 không có header → chặn mặc định 5 phút; mã 4 (mức app) chặn mọi scope', async () => {
    reply(400, metaError(80001))
    expect(await client().get('/x', { token: TOKEN, tier: 'interactive', scope: SCOPE })).toMatchObject({ kind: 'RATE_LIMITED', retryAfterMs: 5 * 60_000 })
    reply(400, metaError(4))
    await client().get('/x', { token: TOKEN, tier: 'interactive', scope: 'page:222' })
    expect(await client().get('/x', { token: TOKEN, tier: 'interactive', scope: 'page:333' })).toMatchObject({ kind: 'RATE_LIMITED' })
    expect((await rateRows()).filter((r) => r.bucket === 'blocked').map((r) => r.scope)).toEqual(['app:graph', SCOPE])
  })

  it('store lỗi khi kiểm ngân sách → TRANSIENT `notSent`, không gửi', async () => {
    const broken = { get: async () => Promise.reject(new Error('db down')), record: async () => {} }
    expect(await client({ rateStore: broken }).get('/x', { token: TOKEN, tier: 'interactive', scope: SCOPE })).toEqual({ ok: false, kind: 'TRANSIENT', notSent: true })
    expect(seen).toHaveLength(0)
  })

  it('store lỗi khi ghi usage → lời gọi vẫn thành công', async () => {
    reply(200, { id: '1' }, { 'x-app-usage': '{"call_count":1}' })
    const broken = { get: async () => [], record: async () => Promise.reject(new Error('db down')) }
    expect(await client({ rateStore: broken }).get('/x', { token: TOKEN, tier: 'interactive', scope: SCOPE })).toEqual({ ok: true, data: { id: '1' } })
  })
})

describe('mạng lỗi / timeout', () => {
  it('quá thời hạn → TRANSIENT không `notSent` (có thể Meta đã nhận), không retry', async () => {
    handler = () => {} // giữ kết nối, không trả lời
    const started = Date.now()
    expect(await client({ timeoutMs: 200 }).get('/slow', { token: TOKEN, tier: 'interactive', scope: SCOPE })).toEqual({ ok: false, kind: 'TRANSIENT' })
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(seen).toHaveLength(1)
  })

  it('không kết nối được → TRANSIENT `notSent` (chắc chắn chưa gửi)', async () => {
    const port = await freePort()
    expect(await client({ baseUrl: `http://127.0.0.1:${port}` }).get('/x', { token: TOKEN, tier: 'interactive', scope: SCOPE })).toEqual({
      ok: false,
      kind: 'TRANSIENT',
      notSent: true,
    })
  })

  it('caller huỷ trước khi gửi → ABORTED, không gửi, không log cảnh báo', async () => {
    reply(200, {})
    const ctrl = new AbortController()
    ctrl.abort()
    expect(await client().get('/x', { token: TOKEN, tier: 'interactive', scope: SCOPE, signal: ctrl.signal })).toEqual({ ok: false, kind: 'ABORTED' })
    expect(seen).toHaveLength(0)
    expect(logLines.filter((l) => JSON.parse(l).level >= 40)).toEqual([])
  })

  it('caller huỷ giữa chừng → ABORTED (không phải TRANSIENT), không log cảnh báo', async () => {
    handler = () => {} // treo
    const ctrl = new AbortController()
    setTimeout(() => ctrl.abort(), 50)
    expect(await client().get('/slow', { token: TOKEN, tier: 'interactive', scope: SCOPE, signal: ctrl.signal })).toEqual({ ok: false, kind: 'ABORTED' })
    expect(logLines.filter((l) => JSON.parse(l).level >= 40)).toEqual([])
  })

  it('đọc body lỗi → TRANSIENT, nhưng usage từ header vẫn được ghi', async () => {
    const brokenBody = (async () =>
      new Response(
        new ReadableStream({
          start(c) {
            c.error(new Error('đứt kết nối'))
          },
        }),
        { status: 200, headers: { 'x-app-usage': '{"call_count":77}' } },
      )) as unknown as typeof fetch
    expect(await client({ fetch: brokenBody }).get('/x', { token: TOKEN, tier: 'interactive', scope: SCOPE })).toEqual({ ok: false, kind: 'TRANSIENT', status: 200 })
    expect(await rateRows()).toEqual([{ scope: 'app:graph', bucket: 'app', usage_pct: 77, blocked_until: null }])
  })

  it('fetch ném lỗi → TRANSIENT', async () => {
    const throwing = (async () => {
      throw new TypeError(`fetch failed ${TOKEN}`)
    }) as unknown as typeof fetch
    expect(await client({ fetch: throwing }).get('/x', { token: TOKEN, tier: 'interactive', scope: SCOPE })).toEqual({ ok: false, kind: 'TRANSIENT' })
  })
})

describe('log', () => {
  it('chỉ path không query, kèm mã lỗi và fbtrace id; không chứa token, proof hay query', async () => {
    reply(400, metaError(190, 463))
    await client().get('/me/accounts?fields=id', { token: TOKEN, tier: 'interactive', scope: SCOPE })
    reply(200, {})
    await client().get('/me', { token: TOKEN, tier: 'interactive', scope: SCOPE, params: { fields: 'id' } })
    handler = () => {}
    await client({ timeoutMs: 100 }).get('/slow', { token: TOKEN, tier: 'interactive', scope: SCOPE })
    const out = logLines.join('')
    const proof = createHmac('sha256', APP_SECRET).update(TOKEN).digest('hex')
    expect(out).not.toContain('S3CR3T')
    expect(out).not.toContain(proof)
    expect(out).not.toContain('access_token')
    expect(out).not.toContain('fields=')
    const failed = logLines.map((l) => JSON.parse(l)).find((l) => l.code === 190)
    expect(failed).toMatchObject({ metaPath: '/me/accounts', status: 400, kind: 'TOKEN_INVALID', code: 190, subcode: 463, fbtraceId: 'FBTRACE' })
  })
})

describe('lỗi lập trình', () => {
  it.each(['access_token', 'appsecret_proof'])('truyền %s qua params hoặc query của path → ném lỗi, không gửi', async (key) => {
    await expect(client().get('/me', { tier: 'interactive', scope: SCOPE, params: { [key]: 'x' } })).rejects.toThrow(key)
    await expect(client().get(`/me?${key}=x`, { tier: 'interactive', scope: SCOPE })).rejects.toThrow(key)
    expect(seen).toHaveLength(0)
  })

  it.each(['/../v25.0/me', '/me/../../x', '/%2e%2e/oauth', '/./me'])('path %s có segment . / .. → ném lỗi', async (path) => {
    await expect(client().get(path, { token: TOKEN, tier: 'interactive', scope: SCOPE })).rejects.toThrow('meta client')
    expect(seen).toHaveLength(0)
  })
})

describe('instance graph / threads', () => {
  it('graph pin phiên bản (mặc định v26.0); threads dùng v1.0', () => {
    const rateStore = { get: async () => [], record: async () => {} }
    expect(createGraphClient({ rateStore }).baseUrl).toBe('https://graph.facebook.com/v26.0')
    expect(createGraphClient({ rateStore, version: 'v27.0' }).baseUrl).toBe('https://graph.facebook.com/v27.0')
    expect(createThreadsClient({ rateStore }).baseUrl).toBe('https://graph.threads.com/v1.0')
  })

  it('threads gọi đúng gốc', async () => {
    reply(200, { id: 't1' })
    const threads = createThreadsClient({ baseUrl, rateStore: createRateStore(handle.db), appSecret: 'threads-secret', now: () => clock })
    expect(await threads.get('/me', { token: TOKEN, tier: 'interactive', scope: 'threads:1' })).toEqual({ ok: true, data: { id: 't1' } })
    expect(seen[0]?.url.pathname).toBe('/v1.0/me')
    expect(seen[0]?.url.searchParams.get('appsecret_proof')).toBe(createHmac('sha256', 'threads-secret').update(TOKEN).digest('hex'))
  })

  it('unversioned: path ngay dưới gốc host (endpoint token Threads); vẫn chặn thoát gốc', async () => {
    reply(200, { access_token: 'x' })
    const threads = createThreadsClient({ baseUrl, rateStore: createRateStore(handle.db), now: () => clock })
    const res = await threads.post('/oauth/access_token', { tier: 'interactive', scope: 'oauth:threads', unversioned: true, params: { code: 'c' } })
    expect(res).toEqual({ ok: true, data: { access_token: 'x' } })
    expect(seen[0]?.method).toBe('POST')
    expect(seen[0]?.url.pathname).toBe('/oauth/access_token')
    expect(seen[0]?.url.searchParams.get('code')).toBe('c')
    await expect(threads.get('/../x', { tier: 'interactive', scope: 'oauth:threads', unversioned: true })).rejects.toThrow('meta client')
  })

  it('form: secret và code nằm trong body x-www-form-urlencoded, không trong query; log không có query/secret', async () => {
    reply(400, metaError(100))
    const threads = createThreadsClient({ baseUrl, rateStore: createRateStore(handle.db), log, now: () => clock })
    const res = await threads.post('/oauth/access_token', {
      tier: 'interactive',
      scope: 'oauth:threads',
      unversioned: true,
      form: { client_id: '42', client_secret: 'SECRET-IN-BODY', code: 'CODE-IN-BODY', skip: undefined },
    })
    expect(res.ok).toBe(false)
    expect(seen[0]?.contentType).toBe('application/x-www-form-urlencoded')
    expect([...seen[0]!.url.searchParams.keys()]).toEqual([])
    expect(Object.fromEntries(new URLSearchParams(seen[0]!.body))).toEqual({ client_id: '42', client_secret: 'SECRET-IN-BODY', code: 'CODE-IN-BODY' })
    const logs = logLines.join('')
    expect(logs).toContain('/oauth/access_token')
    expect(logs).not.toContain('SECRET-IN-BODY')
    expect(logs).not.toContain('CODE-IN-BODY')
  })

  it('GET token Threads (th_exchange_token / debug_token): log chỉ có path, không có query', async () => {
    reply(400, metaError(190))
    const threads = createThreadsClient({ baseUrl, rateStore: createRateStore(handle.db), log, now: () => clock })
    await threads.get('/access_token', { tier: 'interactive', scope: 'oauth:threads', unversioned: true, token: 'SHORT-TOK', params: { grant_type: 'th_exchange_token', client_secret: 'GET-SECRET' } })
    await threads.get('/debug_token', { tier: 'interactive', scope: 'oauth:threads', token: 'TH|42|GET-SECRET', params: { input_token: 'LONG-TOK' } })
    const logs = logLines.join('')
    expect(logs).toContain('/access_token')
    expect(logs).toContain('/debug_token')
    for (const secret of ['GET-SECRET', 'SHORT-TOK', 'LONG-TOK', 'th_exchange_token', 'input_token']) expect(logs).not.toContain(secret)
  })
})

describe('fake client', () => {
  it('ghi lời gọi và trả phản hồi lập trình được', async () => {
    const fake = createFakeMetaClient()
    fake.on('GET', '/me/accounts', { ok: true, data: { data: [] } })
    fake.onSequence('POST', '111/feed', [
      { ok: false, kind: 'RATE_LIMITED', retryAfterMs: 1000 },
      { ok: true, data: { id: '111_1' } },
    ])
    expect(await fake.get('me/accounts', { token: 't', tier: 'interactive', scope: SCOPE })).toEqual({ ok: true, data: { data: [] } })
    expect(await fake.post('/111/feed', { token: 't', tier: 'publish', scope: SCOPE })).toMatchObject({ kind: 'RATE_LIMITED' })
    expect(await fake.post('/111/feed', { token: 't', tier: 'publish', scope: SCOPE })).toEqual({ ok: true, data: { id: '111_1' } })
    expect(await fake.get('/other', { tier: 'background', scope: SCOPE })).toEqual({ ok: true, data: {} })
    fake.setFallback(({ path }) => ({ ok: false, kind: 'REJECTED', code: path.length }))
    expect(await fake.get('/abc', { tier: 'background', scope: SCOPE })).toEqual({ ok: false, kind: 'REJECTED', code: 4 })
    expect(fake.calls.map((c) => `${c.method} ${c.path}`)).toEqual(['GET me/accounts', 'POST /111/feed', 'POST /111/feed', 'GET /other', 'GET /abc'])
    fake.reset()
    expect(fake.calls).toHaveLength(0)
  })
})
