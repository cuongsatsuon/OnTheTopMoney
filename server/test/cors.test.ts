// Spec 1.3c — CORS có credentials cho `/api/v1/*` khi web (Hostinger) và api (VPS) khác host.
import { ErrorResponse } from '@ottm/shared'
import type { FastifyInstance } from 'fastify'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest'
import { buildApp } from '../src/app/app.ts'
import { SESSION_COOKIE } from '../src/app/auth/index.ts'
import { CORS_ALLOW_HEADERS, CORS_ALLOW_METHODS, CORS_MAX_AGE_SECONDS } from '../src/app/cors.ts'
import { createSession, setOwnerPassword } from '../src/modules/settings/index.ts'
import { createDb, type DbHandle } from '../src/platform/db/index.ts'
import { createLogger } from '../src/platform/log/index.ts'
import { createRealtimeHub, type RealtimeHub } from '../src/platform/realtime/index.ts'
import { waitFor } from './helpers/realtime.ts'

const WEB = 'https://app.example.com'
const EVIL = 'https://evil.example'
const PASSWORD = 'mat-khau-cors-1234'

let handle: DbHandle
let app: FastifyInstance
let hub: RealtimeHub | undefined

beforeAll(() => {
  handle = createDb(inject('databaseUrl'), { max: 3 })
})
afterAll(async () => {
  await handle.close()
})
beforeEach(async () => {
  await handle.sql`delete from sessions`
  await handle.sql`delete from secrets`
})
afterEach(async () => {
  await app?.close()
  hub = undefined
})

function build(withRealtime = false) {
  if (withRealtime) hub = createRealtimeHub({ sql: handle.sql, log: createLogger({ level: 'silent' }) })
  app = buildApp({
    sql: handle.sql,
    db: handle.db,
    logger: createLogger({ level: 'silent' }),
    http: { allowedOrigins: [WEB], cookieSecure: true },
    ...(hub ? { realtime: hub } : {}),
  })
  return app
}

const cookie = (token: string) => `${SESSION_COOKIE}=${token}`

function expectCors(headers: Record<string, unknown>, origin: string) {
  expect(headers['access-control-allow-origin']).toBe(origin)
  expect(headers['access-control-allow-credentials']).toBe('true')
  expect(String(headers.vary)).toMatch(/\bOrigin\b/)
}

function expectNoCors(headers: Record<string, unknown>) {
  expect(headers['access-control-allow-origin']).toBeUndefined()
  expect(headers['access-control-allow-credentials']).toBeUndefined()
  expect(headers['access-control-allow-methods']).toBeUndefined()
}

describe('CORS /api/v1/*', () => {
  it('preflight hợp lệ → 204 đủ header, không cần phiên', async () => {
    const res = await build().inject({
      method: 'OPTIONS',
      url: '/api/v1/auth/login',
      headers: { origin: WEB, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' },
    })
    expect(res.statusCode).toBe(204)
    expectCors(res.headers, WEB)
    expect(res.headers['access-control-allow-methods']).toBe(CORS_ALLOW_METHODS)
    expect(res.headers['access-control-allow-headers']).toBe(CORS_ALLOW_HEADERS)
    expect(res.headers['access-control-allow-headers']).toBe('Content-Type, Accept')
    expect(res.headers['access-control-max-age']).toBe(String(CORS_MAX_AGE_SECONDS))
    expect(res.headers['access-control-max-age']).toBe('600')
    expect(res.body).toBe('')
  })

  it('preflight route cần phiên (không cookie) vẫn 204, không 401', async () => {
    const res = await build().inject({
      method: 'OPTIONS',
      url: '/api/v1/connections/facebook/start',
      headers: { origin: WEB, 'access-control-request-method': 'POST' },
    })
    expect(res.statusCode).toBe(204)
    expectCors(res.headers, WEB)
  })

  it('preflight Origin lạ / thiếu → 204 không header CORS, vẫn Vary: Origin', async () => {
    const evil = await build().inject({
      method: 'OPTIONS',
      url: '/api/v1/auth/login',
      headers: { origin: EVIL, 'access-control-request-method': 'POST' },
    })
    expect(evil.statusCode).toBe(204)
    expectNoCors(evil.headers)
    expect(String(evil.headers.vary)).toMatch(/\bOrigin\b/)
    // So khớp chính xác: khác scheme / cổng / dấu / cuối đều là origin lạ.
    for (const origin of ['http://app.example.com', 'https://app.example.com:8443', 'https://app.example.com/', 'null']) {
      const res = await app.inject({ method: 'OPTIONS', url: '/api/v1/auth/me', headers: { origin } })
      expect(res.statusCode).toBe(204)
      expectNoCors(res.headers)
    }
    const none = await app.inject({ method: 'OPTIONS', url: '/api/v1/auth/me' })
    expect(none.statusCode).toBe(204)
    expectNoCors(none.headers)
  })

  it('không bao giờ trả `*`', async () => {
    const res = await build().inject({ method: 'GET', url: '/api/v1/auth/me', headers: { origin: '*' } })
    expectNoCors(res.headers)
  })

  it('GET cross-origin có cookie → 200 kèm header CORS; 401 (chưa đăng nhập) cũng có', async () => {
    build()
    const { token } = await createSession(handle.db)
    const ok = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { origin: WEB, cookie: cookie(token) } })
    expect(ok.statusCode).toBe(200)
    expectCors(ok.headers, WEB)
    const anon = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { origin: WEB } })
    expect(anon.statusCode).toBe(401)
    expect(ErrorResponse.parse(anon.json()).error.code).toBe('UNAUTHENTICATED')
    expectCors(anon.headers, WEB)
  })

  it('lỗi 4xx của route (404, 400) vẫn có header CORS', async () => {
    build()
    const { token } = await createSession(handle.db)
    const missing = await app.inject({ method: 'GET', url: '/api/v1/khong-co', headers: { origin: WEB, cookie: cookie(token) } })
    expect(missing.statusCode).toBe(404)
    expectCors(missing.headers, WEB)
    const bad = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { origin: WEB, 'content-type': 'application/json' },
      payload: '{"password":',
    })
    expect(bad.statusCode).toBe(400)
    expectCors(bad.headers, WEB)
  })

  it('đăng nhập cross-origin: 204 kèm CORS; cookie phiên giữ HttpOnly; Secure; SameSite=Lax, host-only', async () => {
    await setOwnerPassword(handle.db, PASSWORD)
    const res = await build().inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { origin: WEB },
      payload: { password: PASSWORD },
    })
    expect(res.statusCode).toBe(204)
    expectCors(res.headers, WEB)
    const sid = res.cookies.find((c) => c.name === SESSION_COOKIE)
    expect(sid).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Lax', path: '/' })
    expect(sid?.domain).toBeUndefined()
  })

  it('ghi với Origin lạ vẫn 403 như cũ, không có header CORS', async () => {
    build()
    const { token } = await createSession(handle.db)
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: { origin: EVIL, cookie: cookie(token) },
    })
    expect(res.statusCode).toBe(403)
    expect(ErrorResponse.parse(res.json()).error.code).toBe('FORBIDDEN')
    expectNoCors(res.headers)
  })

  it('ngoài /api/v1 (healthz) không có header CORS', async () => {
    const res = await build().inject({ method: 'GET', url: '/healthz', headers: { origin: WEB } })
    expectNoCors(res.headers)
    expect(res.headers.vary ?? '').not.toMatch(/\bOrigin\b/)
  })

  it('SSE cross-origin: header CORS có trong writeHead sau hijack; 401 trước hijack cũng có', async () => {
    build(true)
    await hub!.start()
    const base = await app.listen({ port: 0, host: '127.0.0.1' })

    const anon = await fetch(`${base}/api/v1/stream`, { headers: { origin: WEB } })
    expect(anon.status).toBe(401)
    expect(anon.headers.get('access-control-allow-origin')).toBe(WEB)
    expect(anon.headers.get('access-control-allow-credentials')).toBe('true')
    await anon.body?.cancel()

    const { token } = await createSession(handle.db)
    const controller = new AbortController()
    const res = await fetch(`${base}/api/v1/stream`, { headers: { origin: WEB, cookie: cookie(token) }, signal: controller.signal })
    try {
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toMatch(/^text\/event-stream/)
      expect(res.headers.get('access-control-allow-origin')).toBe(WEB)
      expect(res.headers.get('access-control-allow-credentials')).toBe('true')
      expect(res.headers.get('vary')).toMatch(/\bOrigin\b/)
      const reader = res.body!.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      await waitFor(async () => {
        const { value } = await reader.read()
        buf += decoder.decode(value, { stream: true })
        return buf.includes('event: ready')
      })
      expect(buf).toContain('event: ready')
    } finally {
      controller.abort()
    }
  })
})
