// CORS cho `/api/v1/*` khi web nằm ở host khác api (vd web `app.<miền>` trên Hostinger, api `api.<miền>` trên VPS).
// - Chỉ origin có trong `ALLOWED_ORIGINS` (so khớp chính xác, không bao giờ `*`) mới nhận header CORS, kèm
//   `Access-Control-Allow-Credentials: true` để cookie phiên `ottm_sid` đi kèm (`credentials: 'include'`).
// - Mọi response `/api/v1/*` có `Vary: Origin` (cache trung gian không trộn phản hồi giữa các origin).
// - Preflight `OPTIONS` trả 204 ngay, không cần phiên; origin lạ → 204 không header CORS (trình duyệt tự chặn).
// - Hook đăng ký TRƯỚC plugin auth: header có cả trên 401/403/4xx/5xx do guard hay route ném ra, và trên SSE
//   (`stream.ts` gộp `reply.getHeaders()` vào `writeHead` sau `hijack`).
// Kiểm Origin cho request ghi vẫn nằm ở plugin auth (403 với origin lạ) — CORS không nới lỏng nó.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

export const CORS_ALLOW_METHODS = 'GET, POST, PUT, PATCH, DELETE'
/** `X-File-Name`: tên file khi tải file kho kiến thức lên (Story 5.2 — body là bytes của file). */
export const CORS_ALLOW_HEADERS = 'Content-Type, Accept, X-File-Name'
export const CORS_MAX_AGE_SECONDS = 600

const API_PREFIX = '/api/v1/'

function isApiPath(req: FastifyRequest): boolean {
  const q = req.url.indexOf('?')
  const path = q === -1 ? req.url : req.url.slice(0, q)
  return path.startsWith(API_PREFIX)
}

function addVaryOrigin(reply: FastifyReply): void {
  const current = reply.getHeader('vary')
  const values = (Array.isArray(current) ? current.join(',') : String(current ?? ''))
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean)
  if (values.some((v) => v === '*' || v.toLowerCase() === 'origin')) return
  reply.header('Vary', [...values, 'Origin'].join(', '))
}

export function registerCors(app: FastifyInstance, allowedOrigins: readonly string[]): void {
  const allowed = new Set(allowedOrigins)

  app.addHook('onRequest', async (req, reply) => {
    if (!isApiPath(req)) return
    addVaryOrigin(reply)
    const origin = req.headers.origin
    const ok = origin !== undefined && allowed.has(origin)
    if (ok) {
      reply.header('Access-Control-Allow-Origin', origin)
      reply.header('Access-Control-Allow-Credentials', 'true')
    }
    if (req.method !== 'OPTIONS') return
    if (ok) {
      reply.header('Access-Control-Allow-Methods', CORS_ALLOW_METHODS)
      reply.header('Access-Control-Allow-Headers', CORS_ALLOW_HEADERS)
      reply.header('Access-Control-Max-Age', String(CORS_MAX_AGE_SECONDS))
    }
    // Không qua guard phiên/Origin: preflight không mang cookie và không đổi gì.
    return reply.code(204).send()
  })
}
