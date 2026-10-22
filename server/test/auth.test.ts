// Ma trận Story 1.2 phía server: set-password, login/logout/me, giới hạn thử sai, Origin, log.
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { Writable } from 'node:stream'
import { ErrorResponse, MeResponse, OWNER_PASSWORD_MAX_LENGTH } from '@ottm/shared'
import type { FastifyInstance } from 'fastify'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest'
import { buildApp } from '../src/app/app.ts'
import { LoginLimiter, SESSION_COOKIE } from '../src/app/auth/index.ts'
import { createDb, type DbHandle } from '../src/platform/db/index.ts'
import { createLogger } from '../src/platform/log/index.ts'
import { createSession, setOwnerPassword } from '../src/modules/settings/index.ts'

const serverDir = fileURLToPath(new URL('..', import.meta.url))
const PASSWORD = 'mat-khau-dung-12'
const ORIGIN = 'http://localhost:5173'
const DAY_MS = 86_400_000

let handle: DbHandle

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

function capture() {
  const lines: string[] = []
  const sink = new Writable({
    write(chunk, _enc, cb) {
      lines.push(String(chunk))
      cb()
    },
  })
  return { sink, text: () => lines.join('') }
}

function makeApp(options: { limiter?: LoginLimiter; sink?: Writable; trustProxy?: boolean } = {}): FastifyInstance {
  const logger = options.sink ? createLogger({ level: 'info' }, options.sink) : createLogger({ level: 'silent' })
  return buildApp({
    sql: handle.sql,
    db: handle.db,
    logger,
    http: { allowedOrigins: [ORIGIN], cookieSecure: true, trustProxy: options.trustProxy ?? false },
    ...(options.limiter ? { loginLimiter: options.limiter } : {}),
  })
}

interface CallOptions {
  payload?: object
  cookie?: string
  headers?: Record<string, string>
  ip?: string
}

async function call(app: FastifyInstance, method: 'GET' | 'POST' | 'DELETE', url: string, o: CallOptions = {}) {
  const headers: Record<string, string> = { ...(method === 'GET' ? {} : { origin: ORIGIN }), ...o.headers }
  if (o.cookie !== undefined) headers.cookie = `${SESSION_COOKIE}=${o.cookie}`
  const res = await app.inject({
    method,
    url,
    headers,
    ...(o.payload ? { payload: o.payload } : {}),
    ...(o.ip ? { remoteAddress: o.ip } : {}),
  })
  const sid = res.cookies.find((c) => c.name === SESSION_COOKIE)
  return { res, status: res.statusCode, sid }
}

const login = (app: FastifyInstance, password: string, o: Omit<CallOptions, 'payload'> = {}) =>
  call(app, 'POST', '/api/v1/auth/login', { ...o, payload: { password } })

function errorCode(res: { json(): unknown }) {
  return ErrorResponse.parse(res.json()).error.code
}

async function sessionCount(): Promise<number> {
  const [row] = await handle.sql<{ n: number }[]>`select count(*)::int as n from sessions`
  return row!.n
}

describe('npm run set-password', () => {
  function run(input: string) {
    const env = { ...process.env, DATABASE_URL: inject('databaseUrl'), NODE_ENV: 'test' }
    return spawnSync('npm', ['run', '--silent', 'set-password'], { cwd: serverDir, env, input, encoding: 'utf8', timeout: 60_000 })
  }

  it('nhập 2 lần khớp, ≥12 ký tự → lưu hash argon2id, xoá mọi phiên cũ', async () => {
    await createSession(handle.db)
    const res = run(`${PASSWORD}\n${PASSWORD}\n`)
    expect(res.status).toBe(0)
    const [row] = await handle.sql<{ kind: string; value: string }[]>`select kind, value from secrets where name = 'owner_password'`
    expect(row?.kind).toBe('argon2id')
    expect(row?.value).toMatch(/^\$argon2id\$/)
    expect(row?.value).not.toContain(PASSWORD)
    expect(await sessionCount()).toBe(0)
    expect(`${res.stdout}${res.stderr}`).not.toContain(PASSWORD)
  })

  it('hai lần lệch → báo lỗi, exit ≠ 0, không lưu', async () => {
    const res = run(`${PASSWORD}\n${PASSWORD}x\n`)
    expect(res.status).not.toBe(0)
    expect(res.stderr).toContain('không khớp')
    expect(await handle.sql`select 1 from secrets`).toHaveLength(0)
  })

  it('dài hơn OWNER_PASSWORD_MAX_LENGTH → báo lỗi, exit ≠ 0, không lưu', async () => {
    const long = 'a'.repeat(OWNER_PASSWORD_MAX_LENGTH + 1)
    const res = run(`${long}\n${long}\n`)
    expect(res.status).not.toBe(0)
    expect(res.stderr).toContain(String(OWNER_PASSWORD_MAX_LENGTH))
    expect(await handle.sql`select 1 from secrets`).toHaveLength(0)
  })

  it('ngắn hơn 12 ký tự → báo lỗi, exit ≠ 0, không lưu', async () => {
    const res = run('ngan-qua\nngan-qua\n')
    expect(res.status).not.toBe(0)
    expect(res.stderr).toContain('12')
    expect(await handle.sql`select 1 from secrets`).toHaveLength(0)
  })
})

describe('auth API', () => {
  let app: FastifyInstance

  afterEach(async () => {
    await app?.close()
  })

  describe('POST /api/v1/auth/login', () => {
    beforeEach(async () => {
      app = makeApp()
      await setOwnerPassword(handle.db, PASSWORD)
    })

    it('đúng mật khẩu → 204 + cookie phiên HttpOnly; Secure; SameSite=Lax, DB chỉ lưu sha256', async () => {
      const { status, sid, res } = await login(app, PASSWORD)
      expect(status).toBe(204)
      expect(sid).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Lax', path: '/', maxAge: 30 * 86_400 })
      expect(sid!.value).toMatch(/^[A-Za-z0-9_-]{43}$/) // 32 byte base64url
      expect(String(res.headers['set-cookie'])).toMatch(/HttpOnly/)
      const rows = await handle.sql<{ token_hash: string }[]>`select token_hash from sessions`
      expect(rows).toHaveLength(1)
      expect(rows[0]!.token_hash).toMatch(/^[0-9a-f]{64}$/)
      expect(rows[0]!.token_hash).not.toBe(sid!.value)
    })

    it('xoay phiên: phiên cũ trình kèm bị xoá, cấp token mới', async () => {
      const first = await login(app, PASSWORD)
      const second = await login(app, PASSWORD, { cookie: first.sid!.value })
      expect(second.status).toBe(204)
      expect(second.sid!.value).not.toBe(first.sid!.value)
      expect(await sessionCount()).toBe(1)
      expect((await call(app, 'GET', '/api/v1/auth/me', { cookie: first.sid!.value })).status).toBe(401)
      expect((await call(app, 'GET', '/api/v1/auth/me', { cookie: second.sid!.value })).status).toBe(200)
    })

    it('sai mật khẩu → 401 INVALID_CREDENTIALS, không cookie', async () => {
      const { status, sid, res } = await login(app, 'sai-mat-khau-roi')
      expect(status).toBe(401)
      expect(errorCode(res)).toBe('INVALID_CREDENTIALS')
      expect(sid).toBeUndefined()
      expect(await sessionCount()).toBe(0)
    })

    it('chưa đặt mật khẩu → 401 INVALID_CREDENTIALS giống hệt sai mật khẩu', async () => {
      const wrong = await login(app, 'sai-mat-khau-roi')
      await handle.sql`delete from secrets`
      const unset = await login(app, PASSWORD)
      expect(unset.status).toBe(401)
      expect(unset.res.json()).toEqual(wrong.res.json())
    })

    it('mật khẩu có dấu đặt dạng NFD vẫn đăng nhập được khi gửi NFC (và ngược lại)', async () => {
      const vi = 'Mật khẩu tiếng Việt có dấu'
      await setOwnerPassword(handle.db, vi.normalize('NFD'))
      expect(vi.normalize('NFD')).not.toBe(vi.normalize('NFC'))
      expect((await login(app, vi.normalize('NFC'))).status).toBe(204)
      expect((await login(app, vi.normalize('NFD'))).status).toBe(204)
    })

    it('body thiếu password → 400 VALIDATION_FAILED, không tính là lần sai', async () => {
      const limiter = new LoginLimiter({ max: 1 })
      await app.close()
      app = makeApp({ limiter })
      const { status, res } = await call(app, 'POST', '/api/v1/auth/login', { payload: {} })
      expect(status).toBe(400)
      expect(errorCode(res)).toBe('VALIDATION_FAILED')
      expect((await login(app, PASSWORD)).status).toBe(204)
    })
  })

  describe('giới hạn thử sai (5 lần / 15 phút / IP)', () => {
    let now: number

    beforeEach(async () => {
      now = Date.parse('2026-10-22T00:00:00Z')
      app = makeApp({ limiter: new LoginLimiter({ now: () => now }) })
      await setOwnerPassword(handle.db, PASSWORD)
    })

    it('lần thứ 6 → 429 RATE_LIMITED kể cả mật khẩu đúng', async () => {
      for (let i = 0; i < 5; i++) expect((await login(app, `sai-${i}-xxxxxxxx`)).status).toBe(401)
      const sixth = await login(app, PASSWORD)
      expect(sixth.status).toBe(429)
      expect(errorCode(sixth.res)).toBe('RATE_LIMITED')
      expect(sixth.sid).toBeUndefined()
    })

    it('10 lần sai song song cùng IP → tối đa 5 lần tới bước verify, còn lại 429', async () => {
      const results = await Promise.all(Array.from({ length: 10 }, (_, i) => login(app, `sai-song-song-${i}`)))
      const statuses = results.map((r) => r.status)
      expect(statuses.filter((s) => s === 401).length).toBeLessThanOrEqual(5)
      expect(statuses.filter((s) => s !== 401).every((s) => s === 429)).toBe(true)
      expect(statuses.filter((s) => s === 429).length).toBeGreaterThanOrEqual(5)
    })

    it('trustProxy: đếm theo IP trong X-Forwarded-For (một hop)', async () => {
      await app.close()
      app = makeApp({ limiter: new LoginLimiter({ now: () => now }), trustProxy: true })
      const via = (xff: string) => ({ ip: '127.0.0.1', headers: { 'x-forwarded-for': xff } })
      for (let i = 0; i < 5; i++) expect((await login(app, `sai-${i}-xxxxxxxx`, via('203.0.113.1'))).status).toBe(401)
      const blocked = await login(app, PASSWORD, via('203.0.113.1'))
      expect(blocked.status).toBe(429)
      expect((await login(app, PASSWORD, via('203.0.113.2'))).status).toBe(204)
    })

    it('đếm theo IP: IP khác vẫn đăng nhập được', async () => {
      for (let i = 0; i < 5; i++) await login(app, `sai-${i}-xxxxxxxx`, { ip: '10.0.0.1' })
      expect((await login(app, PASSWORD, { ip: '10.0.0.1' })).status).toBe(429)
      expect((await login(app, PASSWORD, { ip: '10.0.0.2' })).status).toBe(204)
    })

    it('đăng nhập đúng xoá bộ đếm của IP', async () => {
      for (let i = 0; i < 4; i++) await login(app, `sai-${i}-xxxxxxxx`)
      expect((await login(app, PASSWORD)).status).toBe(204)
      for (let i = 0; i < 4; i++) expect((await login(app, `sai-${i}-xxxxxxxx`)).status).toBe(401)
      expect((await login(app, PASSWORD)).status).toBe(204)
    })

    it('cửa sổ trượt: lần sai cũ hơn 15 phút không còn tính', async () => {
      for (let i = 0; i < 5; i++) {
        await login(app, `sai-${i}-xxxxxxxx`)
        now += 60_000
      }
      expect((await login(app, PASSWORD)).status).toBe(429)
      now += 11 * 60_000 // lần sai đầu tiên vừa ra khỏi cửa sổ 15 phút
      expect((await login(app, PASSWORD)).status).toBe(204)
    })
  })

  describe('GET /api/v1/auth/me', () => {
    beforeEach(() => {
      app = makeApp()
    })

    it('không cookie → 401 UNAUTHENTICATED', async () => {
      const { status, res } = await call(app, 'GET', '/api/v1/auth/me')
      expect(status).toBe(401)
      expect(errorCode(res)).toBe('UNAUTHENTICATED')
    })

    it('cookie sai → 401 UNAUTHENTICATED và xoá cookie', async () => {
      const { status, res, sid } = await call(app, 'GET', '/api/v1/auth/me', { cookie: 'khong-phai-token' })
      expect(status).toBe(401)
      expect(errorCode(res)).toBe('UNAUTHENTICATED')
      expect(sid?.value).toBe('')
    })

    it('cookie hết hạn → 401 UNAUTHENTICATED', async () => {
      const { token, session } = await createSession(handle.db)
      await handle.sql`update sessions set expires_at = now() - interval '1 second' where id = ${session.id}`
      const { status, res } = await call(app, 'GET', '/api/v1/auth/me', { cookie: token })
      expect(status).toBe(401)
      expect(errorCode(res)).toBe('UNAUTHENTICATED')
    })

    it('có phiên mới → 200 {authenticated:true}, không ghi DB, không đặt lại cookie', async () => {
      const { token, session } = await createSession(handle.db)
      const [before] = await handle.sql<{ last_seen_at: Date; expires_at: Date }[]>`select last_seen_at, expires_at from sessions where id = ${session.id}`
      const { status, res, sid } = await call(app, 'GET', '/api/v1/auth/me', { cookie: token })
      expect(status).toBe(200)
      expect(MeResponse.parse(res.json())).toEqual({ authenticated: true })
      expect(sid).toBeUndefined()
      const [after] = await handle.sql<{ last_seen_at: Date; expires_at: Date }[]>`select last_seen_at, expires_at from sessions where id = ${session.id}`
      expect(after).toEqual(before)
    })

    it('phiên còn < 29 ngày → gia hạn về 30 ngày và đặt lại Max-Age cookie', async () => {
      const { token, session } = await createSession(handle.db)
      await handle.sql`update sessions set expires_at = now() + interval '28 days' where id = ${session.id}`
      const { status, sid } = await call(app, 'GET', '/api/v1/auth/me', { cookie: token })
      expect(status).toBe(200)
      expect(sid).toMatchObject({ value: token, maxAge: 30 * 86_400, httpOnly: true })
      const [row] = await handle.sql<{ ms_left: number }[]>`select extract(epoch from expires_at - now()) * 1000 as ms_left from sessions where id = ${session.id}`
      expect(Number(row!.ms_left)).toBeGreaterThan(29.9 * DAY_MS)
    })

    it('route lạ dưới /api/v1 cũng cần phiên', async () => {
      const { status, res } = await call(app, 'GET', '/api/v1/khong-co')
      expect(status).toBe(401)
      expect(errorCode(res)).toBe('UNAUTHENTICATED')
    })

    it('/healthz vẫn công khai', async () => {
      const { status } = await call(app, 'GET', '/healthz')
      expect([200, 503]).toContain(status)
    })
  })

  describe('kiểm Origin cho request ghi', () => {
    beforeEach(async () => {
      app = makeApp()
      await setOwnerPassword(handle.db, PASSWORD)
    })

    it('Origin ngoài danh sách → 403 FORBIDDEN (kể cả login)', async () => {
      const r = await login(app, PASSWORD, { headers: { origin: 'https://evil.example' } })
      expect(r.status).toBe(403)
      expect(errorCode(r.res)).toBe('FORBIDDEN')
      expect(await sessionCount()).toBe(0)
    })

    it('thiếu Origin và thiếu Sec-Fetch-Site: same-origin → 403 FORBIDDEN', async () => {
      const res = await app.inject({ method: 'POST', url: '/api/v1/auth/logout' })
      expect(res.statusCode).toBe(403)
      expect(errorCode(res)).toBe('FORBIDDEN')
      const cross = await app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: { 'sec-fetch-site': 'cross-site' } })
      expect(cross.statusCode).toBe(403)
    })

    it('thiếu Origin nhưng Sec-Fetch-Site: same-origin → cho qua', async () => {
      const res = await app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: { 'sec-fetch-site': 'same-origin' } })
      expect(res.statusCode).toBe(204)
    })

    it('request ghi có phiên nhưng Origin lạ vẫn bị chặn', async () => {
      const { token } = await createSession(handle.db)
      const r = await call(app, 'POST', '/api/v1/auth/logout', { cookie: token, headers: { origin: 'https://evil.example' } })
      expect(r.status).toBe(403)
      expect(await sessionCount()).toBe(1)
    })

    it('GET không cần Origin', async () => {
      const { token } = await createSession(handle.db)
      expect((await call(app, 'GET', '/api/v1/auth/me', { cookie: token, headers: { origin: 'https://evil.example' } })).status).toBe(200)
    })
  })

  describe('POST /api/v1/auth/logout', () => {
    beforeEach(() => {
      app = makeApp()
    })

    it('có phiên → 204, xoá phiên, xoá cookie', async () => {
      const { token } = await createSession(handle.db)
      const { status, sid } = await call(app, 'POST', '/api/v1/auth/logout', { cookie: token })
      expect(status).toBe(204)
      expect(sid?.value).toBe('')
      expect(await sessionCount()).toBe(0)
      expect((await call(app, 'GET', '/api/v1/auth/me', { cookie: token })).status).toBe(401)
    })

    it('không có phiên → vẫn 204', async () => {
      expect((await call(app, 'POST', '/api/v1/auth/logout')).status).toBe(204)
      expect((await call(app, 'POST', '/api/v1/auth/logout', { cookie: 'het-han-roi' })).status).toBe(204)
    })
  })

  describe('giới hạn route ghi (@fastify/rate-limit)', () => {
    it('quá 60 request ghi / phút → 429 RATE_LIMITED; GET không bị tính', async () => {
      app = makeApp()
      for (let i = 0; i < 60; i++) expect((await call(app, 'POST', '/api/v1/auth/logout')).status).toBe(204)
      const over = await call(app, 'POST', '/api/v1/auth/logout')
      expect(over.status).toBe(429)
      expect(errorCode(over.res)).toBe('RATE_LIMITED')
      for (let i = 0; i < 3; i++) expect((await call(app, 'GET', '/api/v1/auth/me')).status).toBe(401)
    })
  })

  describe('log (AD-12)', () => {
    it('log khi đăng nhập/đăng xuất không có mật khẩu, token phiên hay cookie', async () => {
      const { sink, text } = capture()
      app = makeApp({ sink })
      await setOwnerPassword(handle.db, PASSWORD)
      await login(app, 'sai-mat-khau-roi')
      const ok = await login(app, PASSWORD)
      const token = ok.sid!.value
      await call(app, 'GET', '/api/v1/auth/me', { cookie: token })
      await call(app, 'POST', '/api/v1/auth/logout', { cookie: token })
      for (let i = 0; i < 5; i++) await login(app, 'sai-mat-khau-roi')
      await login(app, PASSWORD) // bị khoá
      await login(app, PASSWORD, { headers: { origin: 'https://evil.example' } })
      const out = text()
      const lines = out.trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>)
      expect(lines).toContainEqual(expect.objectContaining({ level: 40, msg: 'đăng nhập sai mật khẩu', ip: '127.0.0.1', failures: 1 }))
      expect(lines).toContainEqual(expect.objectContaining({ level: 40, msg: 'đăng nhập bị khoá: quá số lần thử sai', ip: '127.0.0.1' }))
      expect(lines).toContainEqual(
        expect.objectContaining({ level: 40, msg: 'chặn request ghi: Origin không được phép', origin: 'https://evil.example' }),
      )
      expect(out).toContain('đăng nhập thành công')
      expect(out).not.toContain(PASSWORD)
      expect(out).not.toContain('sai-mat-khau-roi')
      expect(out).not.toContain(token)
      expect(out).not.toContain(SESSION_COOKIE)
    })
  })
})
