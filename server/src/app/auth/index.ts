// Đăng nhập chủ sở hữu và bề mặt công khai (AD-19).
// - Cookie phiên `ottm_sid` (HttpOnly; Secure; SameSite=Lax), phiên 30 ngày trượt ở module settings.
// - Mọi `/api/v1/*` cần phiên, trừ `POST /api/v1/auth/login` và `POST /api/v1/auth/logout`
//   (logout không phiên vẫn 204; vẫn qua kiểm Origin → 403 và rate-limit → 429).
// - Request ghi `/api/v1/*` phải có `Origin` trong danh sách cho phép, hoặc (không có Origin)
//   `Sec-Fetch-Site: same-origin`.
// - 5 lần sai / 15 phút / IP; `@fastify/rate-limit` 60 request/phút cho route ghi.
import cookie from '@fastify/cookie'
import rateLimit from '@fastify/rate-limit'
import { LoginRequest, type MeResponse } from '@ottm/shared'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import fp from 'fastify-plugin'
import type { Db } from '../../platform/db/index.ts'
import { AppError } from '../../platform/errors/index.ts'
import {
  SESSION_TTL_DAYS,
  createSession,
  deleteSession,
  resolveSession,
  verifyOwnerPassword,
  type OwnerSession,
} from '../../modules/settings/index.ts'
import { deleteOAuthForSession } from '../../modules/connections/index.ts'
import { LoginLimiter } from './login-limiter.ts'

export { LoginLimiter } from './login-limiter.ts'

export const SESSION_COOKIE = 'ottm_sid'
export const LOGIN_PATH = '/api/v1/auth/login'
export const LOGOUT_PATH = '/api/v1/auth/logout'
export const ME_PATH = '/api/v1/auth/me'
export const WRITE_RATE_LIMIT_PER_MINUTE = 60

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

declare module 'fastify' {
  interface FastifyRequest {
    /** Phiên đã xác thực của request `/api/v1/*`; null khi chưa đăng nhập. */
    ownerSession: OwnerSession | null
  }
}

export interface AuthOptions {
  db: Db
  allowedOrigins: readonly string[]
  cookieSecure: boolean
  loginLimiter?: LoginLimiter
}

function pathOf(req: FastifyRequest): string {
  const q = req.url.indexOf('?')
  return q === -1 ? req.url : req.url.slice(0, q)
}

function isApi(req: FastifyRequest): boolean {
  return pathOf(req).startsWith('/api/v1/') || (req.routeOptions.url ?? '').startsWith('/api/v1/')
}

/** Route khớp chính xác (theo mẫu route đã định tuyến, không theo chuỗi URL thô). */
function isRoute(req: FastifyRequest, path: string): boolean {
  return req.routeOptions.url === path && pathOf(req) === path
}

function isWrite(req: FastifyRequest): boolean {
  return WRITE_METHODS.has(req.method)
}

function originAllowed(req: FastifyRequest, allowed: ReadonlySet<string>): boolean {
  const origin = req.headers.origin
  if (origin !== undefined) return allowed.has(origin)
  return req.headers['sec-fetch-site'] === 'same-origin'
}

async function auth(app: FastifyInstance, options: AuthOptions): Promise<void> {
  const { db, cookieSecure } = options
  const allowedOrigins = new Set(options.allowedOrigins)
  const limiter = options.loginLimiter ?? new LoginLimiter()
  const cookieOptions = {
    path: '/',
    httpOnly: true,
    secure: cookieSecure,
    sameSite: 'lax' as const,
  }

  const setSessionCookie = (reply: FastifyReply, token: string) =>
    reply.setCookie(SESSION_COOKIE, token, { ...cookieOptions, maxAge: SESSION_TTL_DAYS * 86_400 })
  const clearSessionCookie = (reply: FastifyReply) => reply.clearCookie(SESSION_COOKIE, cookieOptions)

  await app.register(cookie)
  await app.register(rateLimit, {
    global: true,
    max: WRITE_RATE_LIMIT_PER_MINUTE,
    timeWindow: 60_000,
    // Chỉ giới hạn request ghi vào /api/v1 (webhook của Meta có giới hạn riêng ở story sau).
    allowList: (req) => !(isWrite(req) && isApi(req)),
    errorResponseBuilder: (_req, ctx) =>
      new AppError('RATE_LIMITED', ctx.statusCode, { message: `Rate limit exceeded, retry in ${ctx.after}` }),
  })

  app.decorateRequest('ownerSession', null)

  app.addHook('onRequest', async (req, reply) => {
    if (!isApi(req)) return
    if (isWrite(req) && !originAllowed(req, allowedOrigins)) {
      req.log.warn(
        { ip: req.ip, method: req.method, path: pathOf(req), origin: req.headers.origin ?? null },
        'chặn request ghi: Origin không được phép',
      )
      throw new AppError('FORBIDDEN', 403, { message: 'Origin not allowed' })
    }
    if (isRoute(req, LOGIN_PATH) || isRoute(req, LOGOUT_PATH)) return
    const token = req.cookies[SESSION_COOKIE]
    const session = await resolveSession(db, token)
    if (!session) {
      if (token !== undefined) clearSessionCookie(reply)
      throw new AppError('UNAUTHENTICATED', 401, { message: 'Session required' })
    }
    req.ownerSession = session
    // Gia hạn trượt: đặt lại Max-Age của cookie khi phiên vừa được gia hạn ở DB.
    if (session.renewed && token) setSessionCookie(reply, token)
  })

  app.post(LOGIN_PATH, async (req, reply) => {
    const ip = req.ip
    // Body sai schema không tính là một lần thử.
    const { password } = LoginRequest.parse(req.body ?? {})
    if (limiter.isBlocked(ip)) {
      req.log.warn({ ip }, 'đăng nhập bị khoá: quá số lần thử sai')
      throw new AppError('RATE_LIMITED', 429, { message: 'Too many failed logins' })
    }
    // Ghi lần thử TRƯỚC khi await verify để request song song cùng IP thấy ngay; đúng thì reset.
    const failures = limiter.recordAttempt(ip)
    if (!(await verifyOwnerPassword(db, password))) {
      req.log.warn({ ip, failures }, 'đăng nhập sai mật khẩu')
      throw new AppError('INVALID_CREDENTIALS', 401, { message: 'Invalid credentials' })
    }
    limiter.reset(ip)
    // Xoay phiên: phiên trình kèm (nếu có) bị xoá, luôn cấp token mới.
    await deleteSession(db, req.cookies[SESSION_COOKIE])
    const { token, session } = await createSession(db)
    req.log.info({ sessionId: session.id }, 'đăng nhập thành công')
    setSessionCookie(reply, token)
    return reply.code(204).send()
  })

  app.post(LOGOUT_PATH, async (req, reply) => {
    // Kết quả OAuth dở dang của phiên (giữ envelope token Page) không cần tới khi đã đăng xuất.
    const session = await resolveSession(db, req.cookies[SESSION_COOKIE])
    if (session) await deleteOAuthForSession(db, session.id)
    await deleteSession(db, req.cookies[SESSION_COOKIE])
    clearSessionCookie(reply)
    return reply.code(204).send()
  })

  app.get(ME_PATH, async (): Promise<MeResponse> => ({ authenticated: true }))
}

/** Plugin không đóng gói (fastify-plugin): hook guard áp cho mọi route của app. */
export const authPlugin = fp(auth, { name: 'ottm-auth', fastify: '5.x' })
