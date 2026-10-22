// pino JSON, redact theo AD-12: không bao giờ ghi token, khoá, cookie, mật khẩu.
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

/** Tham số query chứa bí mật (OAuth, webhook verify, token Graph) — thay giá trị khi log URL. */
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
])

export function redactUrl(url: string | undefined): string | undefined {
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
