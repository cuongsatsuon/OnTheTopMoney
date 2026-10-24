// pino JSON, redact theo AD-12: không bao giờ ghi token, khoá, cookie, mật khẩu.
import { DrizzleQueryError } from 'drizzle-orm'
import { pino, type Logger, type LoggerOptions } from 'pino'

const SECRET_KEYS = [
  'access_token',
  'refresh_token',
  'client_secret',
  'appsecret_proof',
  'input_token',
  'fb_exchange_token',
  'META_APP_SECRET',
  'THREADS_APP_SECRET',
  'META_VERIFY_TOKEN',
  'appSecret',
  'verifyToken',
  'authorization',
  'apiKey',
  'api_key',
  'openaiKey',
  'CLOUDINARY_URL',
  'api_secret',
  'apiSecret',
  'signature',
  // Story 9.1: callback xoá dữ liệu của Meta.
  'signed_request',
  'token',
  'password',
  'cookie',
  '["set-cookie"]',
]

export const REDACT_PATHS = [
  // Khoá bí mật ở gốc, sâu 1 và sâu 2 (vd `meta.page.access_token`).
  ...SECRET_KEYS.flatMap((k) => {
    const seg = k.startsWith('[') ? k : `.${k}` // `.token` hoặc `["set-cookie"]`
    return [seg.replace(/^\./, ''), `*${seg}`, `*.*${seg}`]
  }),
  'headers.cookie',
  'headers.authorization',
  'headers["set-cookie"]',
  'req.headers.cookie',
  'req.headers.authorization',
  'res.headers["set-cookie"]',
  'body.password',
  'req.body.password',
]

/**
 * Tham số query chứa bí mật (OAuth, webhook verify, token Graph) hoặc PII — thay giá trị khi log URL. `q`: từ khoá tìm
 * (⌘K `/api/v1/search`, lọc Khách hàng — Story 4.10) có thể là SĐT hay tên khách.
 */
export const SECRET_QUERY_PARAMS = new Set([
  'access_token',
  'refresh_token',
  'client_secret',
  'appsecret_proof',
  'input_token',
  'fb_exchange_token',
  'hub.verify_token',
  'code',
  'token',
  'signed_request',
  'signature',
  'api_secret',
  'q',
])

/**
 * Đường có mã bí mật ngay trong path: trang trạng thái xoá dữ liệu `/privacy/status/<mã xác nhận>` (Story 9.1) — mã là
 * quyền xem trạng thái, không ghi vào log.
 */
const SECRET_PATH_RE = /^(\/privacy\/status\/)[^/?#]+/

export function redactUrl(url: string | undefined): string | undefined {
  if (url && SECRET_PATH_RE.test(url)) url = url.replace(SECRET_PATH_RE, '$1REDACTED')
  if (!url || !url.includes('?')) return url
  const qIndex = url.indexOf('?')
  const params = new URLSearchParams(url.slice(qIndex + 1))
  let changed = false
  for (const key of params.keys()) {
    if (SECRET_QUERY_PARAMS.has(key.toLowerCase())) changed = true
  }
  if (!changed) return url
  const parts: string[] = []
  for (const [key, value] of params) {
    parts.push(`${encodeURIComponent(key)}=${SECRET_QUERY_PARAMS.has(key.toLowerCase()) ? 'REDACTED' : encodeURIComponent(value)}`)
  }
  return `${url.slice(0, qIndex)}?${parts.join('&')}`
}

/**
 * Lỗi đem log: `DrizzleQueryError` chép tham số truy vấn (từ khoá tìm, SĐT, nội dung tin…) vào `message`, `stack` và
 * `params` → thay bằng lỗi chỉ còn câu SQL (tham số dạng `$n`) + lỗi gốc `cause`. Lỗi khác giữ nguyên.
 */
export function loggableError(err: unknown): unknown {
  if (!(err instanceof DrizzleQueryError)) return err
  const safe = new Error(`Failed query: ${err.query}`, { cause: err.cause })
  safe.name = 'DrizzleQueryError'
  // Giữ khung gọi của lỗi gốc, bỏ dòng đầu (chứa `params`).
  const frames = err.stack?.indexOf('\n    at ') ?? -1
  safe.stack = `${safe.name}: ${safe.message}${frames >= 0 ? err.stack!.slice(frames) : ''}`
  return safe
}

interface ReqLike {
  id?: unknown
  method?: string
  url?: string
  host?: string
  hostname?: string
  ip?: string
  socket?: { remoteAddress?: string }
}

/** Chỉ ghi method, URL đã bỏ bí mật, host, IP — không ghi header hay body. */
export function serializeReq(req: ReqLike) {
  return {
    id: req.id,
    method: req.method,
    url: redactUrl(req.url),
    host: req.host ?? req.hostname,
    remoteAddress: req.ip ?? req.socket?.remoteAddress,
  }
}

export type { Logger }

export function createLogger(
  options: { level?: string; name?: string } = {},
  destination?: pino.DestinationStream,
): Logger {
  const opts: LoggerOptions = {
    level: options.level ?? 'info',
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    serializers: { req: serializeReq, err: pino.stdSerializers.err },
    base: { service: options.name },
    timestamp: pino.stdTimeFunctions.isoTime,
  }
  return destination ? pino(opts, destination) : pino(opts)
}
