// Cổng nhận webhook Meta/Threads (Story 4.1, AD-4) + API Cài đặt › Webhook. Công khai ngoài /api/v1 (AD-19):
// guard phiên không áp (isApi=false), rate-limit ghi không áp, CORS chỉ cho /api/v1.
// - POST /webhooks/{meta,threads}: verify HMAC raw body (constant-time) → ghi + enqueue → 200 nhanh. Sai/thiếu
//   chữ ký → 401, KHÔNG ghi (AD-4). Dùng content-type parser buffer RIÊNG cho scope này để giữ raw body;
//   /api/v1 vẫn parse JSON như thường (parser đóng gói theo scope).
// - GET /webhooks/{meta,threads}: trả `hub.challenge` khi `hub.verify_token` khớp `META_VERIFY_TOKEN`; sai → 403.
// - /api/v1/webhooks/{config,events,test,events/:id/retry}: dưới guard phiên.
import type { WebhookConfigResponse, WebhookLogResponse, WebhookProduct } from '@ottm/shared'
import { WEBHOOK_FIELDS, WebhookEventDto, WebhookLogQuery, WebhookTestRequest } from '@ottm/shared'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { AppError } from '../platform/errors/index.ts'
import type { Db } from '../platform/db/index.ts'
import type { JobSender } from '../platform/jobs/index.ts'
import type { Logger } from '../platform/log/index.ts'
import { createTestEvent, ingestWebhook, listWebhookEvents, retryEvent, type IngestDeps } from '../modules/webhooks/index.ts'

export interface WebhooksDeps {
  db: Db
  jobs: JobSender
  /** `META_VERIFY_TOKEN` (bước xác minh GET). Không đặt → GET luôn 403, config trả `verifyToken=null`. */
  verifyToken?: string
  /** App secret ký webhook của từng app (AD-4). Thiếu → POST tương ứng không verify được → 401 + log cảnh báo. */
  metaAppSecret?: string
  threadsAppSecret?: string
  /** Gốc công khai của api để dựng URL callback hiển thị ở Cài đặt. */
  publicBaseUrl: string
  log: Logger
}

const SIGNATURE_HEADER = 'x-hub-signature-256'
const IdParam = z.object({ id: z.uuid() })
/**
 * Giới hạn body webhook: ~2MB (mặc định Fastify 1MB có thể nhỏ cho batch Meta gom nhiều mục → 413 làm Meta
 * retry/tắt subscription). Vẫn đủ nhỏ để chặn body khổng lồ.
 */
const WEBHOOK_BODY_LIMIT = 2 * 1024 * 1024

function headerString(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v
}

export function registerWebhooks(app: FastifyInstance, deps: WebhooksDeps): void {
  const ingest: IngestDeps = { db: deps.db, jobs: deps.jobs }
  const appSecretFor = (product: WebhookProduct): string | undefined =>
    product === 'threads' ? deps.threadsAppSecret : deps.metaAppSecret

  // --- Bề mặt công khai: raw body buffer chỉ trong scope này (parser đóng gói) ---
  app.register(async (scope) => {
    // Giữ nguyên byte để verify HMAC; verify xong service mới JSON.parse. Meta gửi application/json.
    scope.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => done(null, body))
    scope.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => done(null, body))

    for (const product of ['meta', 'threads'] as const) {
      scope.post(`/webhooks/${product}`, { bodyLimit: WEBHOOK_BODY_LIMIT }, async (req, reply) => {
        const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0)
        const outcome = await ingestWebhook(ingest, {
          product,
          rawBody,
          signature: headerString(req.headers[SIGNATURE_HEADER]),
          appSecret: appSecretFor(product),
        })
        if (!outcome.ok) {
          if (outcome.reason === 'not_configured') {
            // Ops: thiếu app secret nên không verify được — không ghi gì, 401 (không lộ cấu hình).
            req.log.warn({ product }, 'webhook: thiếu app secret, không verify được chữ ký')
          }
          throw new AppError('UNAUTHENTICATED', 401, { message: 'Invalid webhook signature' })
        }
        req.log.info({ product, accepted: outcome.accepted, duplicates: outcome.duplicates }, 'webhook nhận')
        // Trả 200 nhanh, không xử lý nghiệp vụ (AD-4) — route chạy ở job.
        return reply.code(200).send()
      })

      scope.get(`/webhooks/${product}`, async (req, reply) => {
        const q = (req.query ?? {}) as Record<string, string | undefined>
        const mode = q['hub.mode']
        const token = q['hub.verify_token']
        const challenge = q['hub.challenge'] ?? ''
        if (mode === 'subscribe' && deps.verifyToken !== undefined && token === deps.verifyToken) {
          return reply.code(200).type('text/plain; charset=utf-8').send(challenge)
        }
        throw new AppError('FORBIDDEN', 403, { message: 'Webhook verify token mismatch' })
      })
    }
  })

  // --- API Cài đặt › Webhook (dưới guard phiên) ---
  app.get('/api/v1/webhooks/config', async (): Promise<WebhookConfigResponse> => {
    const base = deps.publicBaseUrl.replace(/\/+$/, '')
    return {
      callbacks: { meta: `${base}/webhooks/meta`, threads: `${base}/webhooks/threads` },
      // Verify token là giá trị của chính chủ shop, không phải secret bên thứ ba → trả đầy đủ (AD-12).
      verifyToken: deps.verifyToken ?? null,
      verifyTokenConfigured: deps.verifyToken !== undefined,
      fields: { page: [...WEBHOOK_FIELDS.page], instagram: [...WEBHOOK_FIELDS.instagram], threads: [...WEBHOOK_FIELDS.threads] },
    }
  })

  app.get('/api/v1/webhooks/events', async (req): Promise<WebhookLogResponse> => {
    const { cursor, limit } = WebhookLogQuery.parse(req.query ?? {})
    return listWebhookEvents(deps.db, { cursor, limit })
  })

  app.post('/api/v1/webhooks/test', async (req, reply): Promise<WebhookEventDto> => {
    const { product } = WebhookTestRequest.parse(req.body ?? {})
    const event = await createTestEvent(ingest, product)
    reply.code(201)
    return WebhookEventDto.parse(event)
  })

  app.post('/api/v1/webhooks/events/:id/retry', async (req): Promise<WebhookEventDto> => {
    const { id } = IdParam.parse(req.params ?? {})
    const outcome = await retryEvent(ingest, id)
    if (outcome.status === 'not_found') throw new AppError('NOT_FOUND', 404, { message: 'Không tìm thấy sự kiện webhook' })
    // Chỉ mục failed mới xử lý lại được (AD-4): received/routed/ignored → 409, không reset/re-route.
    if (outcome.status === 'not_failed') throw new AppError('VERSION_CONFLICT', 409, { message: 'Chỉ sự kiện lỗi mới xử lý lại được' })
    return WebhookEventDto.parse(outcome.event)
  })
}
