// Bề mặt quyền riêng tư (Story 9.1, AD-22, AD-19). Công khai ngoài /api/v1: guard phiên, CORS và rate-limit ghi mặc
// định không áp → route tự khai rate-limit theo IP. Tất cả nằm trên host api (`PUBLIC_BASE_URL`) ở cả hai chế độ deploy.
// - GET /privacy/policy (+ /privacy → 302), GET /privacy/assets/privacy.css: trang chính sách tĩnh.
// - POST /privacy/meta/{deauthorize,data-deletion}: verify `signed_request` (HMAC-SHA256, app secret, constant-time) →
//   một transaction: (deauthorize) `connections` ngắt trang của tài khoản Meta + `privacy` ghi yêu cầu idempotent và
//   phát `privacy.purge_requested`. Sai / thiếu / chưa cấu hình secret → 400, KHÔNG ghi gì. Data-deletion trả
//   `{url, confirmation_code}` theo dạng Meta yêu cầu.
// - GET /privacy/status/:code: trang trạng thái công khai (no-store, no-referrer, noindex); mã lạ → 404 HTML.
// - GET /api/v1/privacy/config: URL để dán vào Meta App (dưới guard phiên).
// Story 9.2: callback chặn phát lại `signed_request` (trước khi ngắt trang) và chụp phạm vi `all` (trang FB + IG của đúng
// tài khoản); `POST /api/v1/contacts/:id/deletion {confirm:true}` — chủ shop xoá khách và toàn bộ hội thoại.
// Story 9.4: POST /privacy/threads/{uninstall,delete} — cùng đường cho Threads app (app Meta riêng): verify bằng
// `THREADS_APP_SECRET`, người dùng = trang Threads có `platform_account_id` = `user_id`, uninstall ngắt trang Threads đó.
// Log chỉ mang id yêu cầu + cờ; không bao giờ `signed_request`, `user_id`, mã xác nhận (AD-12).
import {
  ContactDeletionBody,
  PRIVACY_PATHS,
  type CallbackDeletionSource,
  type ContactDeletionResponse,
  type MetaDataDeletionResponse,
  type PrivacyConfigResponse,
} from '@ottm/shared'
import { z } from 'zod'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { disconnectMetaUserTx, disconnectThreadsUserTx, metaUserPurgeScope, threadsUserPurgeScope } from '../modules/connections/index.ts'
import { markContactForDeletion } from '../modules/inbox/index.ts'
import {
  findMetaReplay,
  getRequestByCode,
  latestTargetRequest,
  metaSubjectHash,
  recordMetaRequest,
  requestTargetDeletion,
  threadsSubjectHash,
  verifySignedRequest,
  type DeletionRequestView,
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
  /** Story 9.4: `THREADS_APP_SECRET` — verify `signed_request` của Threads app; thiếu → callback Threads 400 + log cảnh báo. */
  threadsAppSecret?: string | undefined
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

  /**
   * Mỗi nguồn callback: app nào ký (`secret`), env nào thiếu (log), khoá người dùng, có ngắt trang không, tra phạm vi
   * xoá ở `connections`. Meta App (9.1): tài khoản Facebook → trang FB + IG. Threads app (9.4): trang Threads.
   */
  const SOURCES: Record<
    CallbackDeletionSource,
    {
      secret: string | undefined
      secretEnv: 'META_APP_SECRET' | 'THREADS_APP_SECRET'
      subjectHash: (secret: string, userId: string) => string
      disconnect: typeof disconnectMetaUserTx | null
      purgeScope: (tx: Parameters<typeof metaUserPurgeScope>[0], userId: string) => Promise<{ pageIds: string[]; metaAccountId: string | null } | null>
    }
  > = {
    meta_deauthorize: { secret: deps.metaAppSecret, secretEnv: 'META_APP_SECRET', subjectHash: metaSubjectHash, disconnect: disconnectMetaUserTx, purgeScope: metaUserPurgeScope },
    meta_data_deletion: { secret: deps.metaAppSecret, secretEnv: 'META_APP_SECRET', subjectHash: metaSubjectHash, disconnect: null, purgeScope: metaUserPurgeScope },
    threads_uninstall: { secret: deps.threadsAppSecret, secretEnv: 'THREADS_APP_SECRET', subjectHash: threadsSubjectHash, disconnect: disconnectThreadsUserTx, purgeScope: threadsUserPurgeScope },
    threads_delete: { secret: deps.threadsAppSecret, secretEnv: 'THREADS_APP_SECRET', subjectHash: threadsSubjectHash, disconnect: null, purgeScope: threadsUserPurgeScope },
  }

  /** Verify rồi ghi trong MỘT transaction; sai → ném 400 trước khi đụng DB. */
  async function handleCallback(req: FastifyRequest, source: CallbackDeletionSource) {
    const cfg = SOURCES[source]
    const verified = verifySignedRequest(signedRequestOf(req.body), cfg.secret)
    if (!verified.ok) {
      if (verified.reason === 'not_configured') req.log.warn({ source }, `privacy: thiếu ${cfg.secretEnv}, không verify được signed_request`)
      else req.log.warn({ source, reason: verified.reason }, 'privacy: signed_request không hợp lệ')
      throw new AppError('VALIDATION_FAILED', 400, { message: 'Invalid signed_request' })
    }
    const subjectHash = cfg.subjectHash(cfg.secret!, verified.userId)
    const result: RecordMetaRequestResult & { disconnected: number; replay: boolean } = await deps.db.transaction(async (tx) => {
      // Story 9.2: `signed_request` không mới hơn yêu cầu đã xoá xong của cùng người → trả mã cũ, KHÔNG ngắt trang (chủ
      // shop có thể đã kết nối lại), không tạo yêu cầu mới.
      const replayed = await findMetaReplay(tx, subjectHash, verified.issuedAt)
      if (replayed) return { request: replayed, created: false, disconnected: 0, replay: true }
      const disconnected = cfg.disconnect ? (await cfg.disconnect(tx, { events: deps.events, log: deps.log }, verified.userId)).disconnected.length : 0
      // Ảnh chụp phạm vi `all` (Story 9.2): trang của đúng tài khoản này (+ dòng `meta_accounts` với Meta App); `null` = người lạ.
      const scope = await cfg.purgeScope(tx, verified.userId)
      const recorded = await recordMetaRequest(tx, deps.events, { source, subjectHash, issuedAt: verified.issuedAt, scope })
      return { ...recorded, disconnected, replay: false }
    })
    req.log.info(
      {
        source,
        requestId: result.request.id,
        created: result.created,
        matched: result.request.matched,
        status: result.request.status,
        disconnected: result.disconnected,
        replay: result.replay,
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

    const deletionCallback = (source: Extract<CallbackDeletionSource, 'meta_data_deletion' | 'threads_delete'>) =>
      async (req: FastifyRequest, reply: FastifyReply) => {
        const { request } = await handleCallback(req, source)
        const body: MetaDataDeletionResponse = { url: statusUrl(request.code), confirmation_code: request.code }
        return reply.code(200).header('Cache-Control', 'no-store').send(body)
      }

    scope.post(PRIVACY_PATHS.dataDeletion, { bodyLimit: CALLBACK_BODY_LIMIT, config: callbackLimit }, deletionCallback('meta_data_deletion'))

    // Story 9.4 — Threads app: cùng dạng `signed_request` và phản hồi `{url, confirmation_code}` như Meta App.
    scope.post(PRIVACY_PATHS.threadsUninstall, { bodyLimit: CALLBACK_BODY_LIMIT, config: callbackLimit }, async (req, reply) => {
      await handleCallback(req, 'threads_uninstall')
      return reply.code(200).send()
    })

    scope.post(PRIVACY_PATHS.threadsDelete, { bodyLimit: CALLBACK_BODY_LIMIT, config: callbackLimit }, deletionCallback('threads_delete'))
  })

  // --- Khách hàng › "Xoá khách và toàn bộ hội thoại" (Story 9.2, dưới guard phiên + kiểm Origin + rate-limit ghi) ---
  // Một transaction: `inbox` đánh dấu khách chờ xoá (ẩn ngay) + chụp hội thoại, `privacy` ghi yêu cầu `contact` và phát
  // `privacy.purge_requested`. Đã có yêu cầu mở / đã xong cho khách này → trả lại nó (200), không tạo thêm.
  const deletionResponse = (r: DeletionRequestView): ContactDeletionResponse => ({
    requestId: r.id,
    code: r.code,
    scope: r.scope,
    status: r.status,
    statusUrl: statusUrl(r.code),
  })
  app.post('/api/v1/contacts/:id/deletion', async (req, reply): Promise<ContactDeletionResponse> => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params)
    ContactDeletionBody.parse(req.body ?? {})
    const out = await deps.db.transaction(async (tx) => {
      const existing = await latestTargetRequest(tx, 'contact', id)
      if (existing && existing.status !== 'completed') return { request: existing, created: false }
      const target = await markContactForDeletion(tx, id)
      if (!target) return existing ? { request: existing, created: false } : null
      return requestTargetDeletion(tx, deps.events, { scope: 'contact', targetId: id, source: 'manual', conversationIds: target.conversationIds })
    })
    if (!out) throw new AppError('NOT_FOUND', 404, { message: 'Khách không tồn tại' })
    if (out.created) req.log.info({ requestId: out.request.id }, 'privacy: chủ shop yêu cầu xoá khách')
    return reply.code(out.created ? 202 : 200).send(deletionResponse(out.request))
  })

  // --- Cài đặt › Tài khoản Meta (dưới guard phiên) ---
  app.get('/api/v1/privacy/config', async (): Promise<PrivacyConfigResponse> => ({
    policyUrl: `${base}${PRIVACY_PATHS.policy}`,
    deauthorizeUrl: `${base}${PRIVACY_PATHS.deauthorize}`,
    dataDeletionUrl: `${base}${PRIVACY_PATHS.dataDeletion}`,
    operatorConfigured: Boolean(deps.operator.name && deps.operator.email),
    metaSecretConfigured: Boolean(deps.metaAppSecret),
    threadsUninstallUrl: `${base}${PRIVACY_PATHS.threadsUninstall}`,
    threadsDeleteUrl: `${base}${PRIVACY_PATHS.threadsDelete}`,
    threadsSecretConfigured: Boolean(deps.threadsAppSecret),
  }))
}
