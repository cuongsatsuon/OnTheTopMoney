// Bề mặt quyền riêng tư (Story 9.1, AD-22, AD-19). Công khai ngoài /api/v1: guard phiên, CORS và rate-limit ghi mặc
// định không áp → route tự khai rate-limit theo IP. Tất cả nằm trên host api (`PUBLIC_BASE_URL`) ở cả hai chế độ deploy.
// - GET /privacy/policy (+ /privacy → 302), GET /privacy/assets/privacy.css: trang chính sách tĩnh.
// - POST /privacy/meta/{deauthorize,data-deletion}: verify `signed_request` (HMAC-SHA256, app secret, constant-time) →
//   một transaction: (deauthorize) `connections` ngắt trang của tài khoản Meta + `privacy` ghi yêu cầu idempotent và
//   phát `privacy.purge_requested`. Sai / thiếu / chưa cấu hình secret → 400, KHÔNG ghi gì. Data-deletion trả
//   `{url, confirmation_code}` theo dạng Meta yêu cầu.
// - GET /privacy/status/:code: trang trạng thái công khai (no-store, no-referrer, noindex); mã lạ → 404 HTML.
// - GET /api/v1/privacy/config: URL để dán vào Meta App (dưới guard phiên).
// Log chỉ mang id yêu cầu + cờ; không bao giờ `signed_request`, `user_id`, mã xác nhận (AD-12).
import { PRIVACY_PATHS, type DeletionSource, type MetaDataDeletionResponse, type PrivacyConfigResponse } from '@ottm/shared'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { disconnectMetaUserTx, isKnownMetaUser } from '../modules/connections/index.ts'
import {
  getRequestByCode,
  metaSubjectHash,
  recordMetaRequest,
  verifySignedRequest,
  type RecordMetaRequestResult,
} from '../modules/privacy/index.ts'
import type { Db } from '../platform/db/index.ts'
import { AppError } from '../platform/errors/index.ts'
import type { EventPublisher } from '../platform/events/index.ts'
import type { Logger } from '../platform/log/index.ts'
import { PRIVACY_CSP, PRIVACY_CSS, PRIVACY_CSS_PATH, policyHtml, statusHtml, statusNotFoundHtml, type PolicyOperator } from './privacy-pages.ts'

/** Rate-limit theo IP mỗi phút (Meta gọi callback hiếm; trang công khai có thể bị quét). */
export const PRIVACY_CALLBACK_LIMIT_PER_MINUTE = 30
export const PRIVACY_PAGE_LIMIT_PER_MINUTE = 120
/** Body callback chỉ có một trường `signed_request` (~vài trăm byte). */
const CALLBACK_BODY_LIMIT = 64 * 1024

export interface PrivacyDeps {
  db: Db
  events: EventPublisher
  log: Logger
  /** `META_APP_SECRET`; thiếu → mọi callback 400 + log cảnh báo. */
  metaAppSecret?: string | undefined
  /** Gốc công khai của api — `url` trả cho Meta và URL ở Cài đặt. */
  publicBaseUrl: string
  operator: PolicyOperator
  /** Cho test: hạ mức rate-limit. */
  limits?: { callbackPerMinute?: number; pagePerMinute?: number }
}

const rateLimit = (max: number) => ({
  rateLimit: {
    max,
    timeWindow: 60_000,
    // Rate-limit chung chỉ áp request ghi /api/v1 (allowList ở plugin auth) — route này luôn bị đếm.
    allowList: () => false,
  },
})

function sendHtml(reply: FastifyReply, status: number, html: string): FastifyReply {
  return reply.code(status).header('Content-Security-Policy', PRIVACY_CSP).type('text/html; charset=utf-8').send(html)
}

/** Header riêng của trang trạng thái: mã nằm trong URL → không cache, không lộ qua Referer, không đánh chỉ mục. */
function privateHeaders(reply: FastifyReply): FastifyReply {
  return reply.header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer').header('X-Robots-Tag', 'noindex, nofollow')
}

function signedRequestOf(body: unknown): unknown {
  return typeof body === 'object' && body !== null ? (body as { signed_request?: unknown }).signed_request : undefined
}

export function registerPrivacy(app: FastifyInstance, deps: PrivacyDeps): void {
  const base = deps.publicBaseUrl.replace(/\/+$/, '')
  const statusUrl = (code: string) => `${base}${PRIVACY_PATHS.status}/${code}`
  const callbackLimit = rateLimit(deps.limits?.callbackPerMinute ?? PRIVACY_CALLBACK_LIMIT_PER_MINUTE)
  const pageLimit = rateLimit(deps.limits?.pagePerMinute ?? PRIVACY_PAGE_LIMIT_PER_MINUTE)

  /** Verify rồi ghi trong MỘT transaction; sai → ném 400 trước khi đụng DB. */
  async function handleCallback(req: FastifyRequest, source: Extract<DeletionSource, 'meta_deauthorize' | 'meta_data_deletion'>) {
    const verified = verifySignedRequest(signedRequestOf(req.body), deps.metaAppSecret)
    if (!verified.ok) {
      if (verified.reason === 'not_configured') req.log.warn({ source }, 'privacy: thiếu META_APP_SECRET, không verify được signed_request')
      else req.log.warn({ source, reason: verified.reason }, 'privacy: signed_request không hợp lệ')
      throw new AppError('VALIDATION_FAILED', 400, { message: 'Invalid signed_request' })
    }
    const subjectHash = metaSubjectHash(deps.metaAppSecret!, verified.userId)
    const result: RecordMetaRequestResult & { disconnected: number } = await deps.db.transaction(async (tx) => {
      let known: boolean
      let disconnected = 0
      if (source === 'meta_deauthorize') {
        const out = await disconnectMetaUserTx(tx, { events: deps.events, log: deps.log }, verified.userId)
        known = out.known
        disconnected = out.disconnected.length
      } else {
        known = await isKnownMetaUser(tx, verified.userId)
      }
      return { ...(await recordMetaRequest(tx, deps.events, { source, subjectHash, known })), disconnected }
    })
    req.log.info(
      {
        source,
        requestId: result.request.id,
        created: result.created,
        matched: result.request.matched,
        status: result.request.status,
        disconnected: result.disconnected,
      },
      'privacy: nhận yêu cầu từ Meta',
    )
    return result
  }

  // --- Công khai: parser form riêng trong scope này (Meta gửi application/x-www-form-urlencoded) ---
  app.register(async (scope) => {
    scope.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => {
      done(null, Object.fromEntries(new URLSearchParams(body as string)))
    })

    scope.get('/privacy', { config: pageLimit }, async (_req, reply) => reply.redirect(PRIVACY_PATHS.policy, 302))

    scope.get(PRIVACY_PATHS.policy, { config: pageLimit }, async (_req, reply) =>
      sendHtml(reply.header('Cache-Control', 'no-cache'), 200, policyHtml(deps.operator)),
    )

    scope.get(PRIVACY_CSS_PATH, { config: pageLimit }, async (_req, reply) =>
      reply.header('Cache-Control', 'public, max-age=86400').type('text/css; charset=utf-8').send(PRIVACY_CSS),
    )

    scope.get(`${PRIVACY_PATHS.status}/:code`, { config: pageLimit }, async (req, reply) => {
      const code = String((req.params as { code?: unknown }).code ?? '')
      const found = await getRequestByCode(deps.db, code)
      privateHeaders(reply)
      return found ? sendHtml(reply, 200, statusHtml(found)) : sendHtml(reply, 404, statusNotFoundHtml())
    })

    scope.post(PRIVACY_PATHS.deauthorize, { bodyLimit: CALLBACK_BODY_LIMIT, config: callbackLimit }, async (req, reply) => {
      await handleCallback(req, 'meta_deauthorize')
      return reply.code(200).send()
    })

    scope.post(PRIVACY_PATHS.dataDeletion, { bodyLimit: CALLBACK_BODY_LIMIT, config: callbackLimit }, async (req, reply) => {
      const { request } = await handleCallback(req, 'meta_data_deletion')
      const body: MetaDataDeletionResponse = { url: statusUrl(request.code), confirmation_code: request.code }
      return reply.code(200).header('Cache-Control', 'no-store').send(body)
    })
  })

  // --- Cài đặt › Tài khoản Meta (dưới guard phiên) ---
  app.get('/api/v1/privacy/config', async (): Promise<PrivacyConfigResponse> => ({
    policyUrl: `${base}${PRIVACY_PATHS.policy}`,
    deauthorizeUrl: `${base}${PRIVACY_PATHS.deauthorize}`,
    dataDeletionUrl: `${base}${PRIVACY_PATHS.dataDeletion}`,
    operatorConfigured: Boolean(deps.operator.name && deps.operator.email),
    metaSecretConfigured: Boolean(deps.metaAppSecret),
  }))
}
