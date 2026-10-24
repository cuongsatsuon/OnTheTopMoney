// Dựng Fastify cho tiến trình `api` (không chạy việc nền dài — AD-2).
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import type { ErrorCode, ErrorResponse } from '@ottm/shared'
import type { AiDeps } from '../modules/ai/index.ts'
import type { ConnectionsDeps } from '../modules/connections/index.ts'
import { loggableError, type Logger } from '../platform/log/index.ts'
import type { Db, Sql } from '../platform/db/index.ts'
import { DEV_ALLOWED_ORIGINS } from '../platform/config/index.ts'
import { AppError } from '../platform/errors/index.ts'
import type { EventPublisher } from '../platform/events/index.ts'
import type { JobSender } from '../platform/jobs/index.ts'
import type { RealtimeHub } from '../platform/realtime/index.ts'
import { createMediaStores, type MediaStores } from '../adapters/media/index.ts'
import { authPlugin, type LoginLimiter } from './auth/index.ts'
import { registerAiBudget } from './ai-budget.ts'
import { registerAutoreplyConfigs } from './autoreply-configs.ts'
import { registerAutoreplyTest } from './autoreply-test.ts'
import { registerBrandProfiles } from './brand-profiles.ts'
import { registerBrandSample } from './brand-sample.ts'
import { registerCampaigns } from './campaigns.ts'
import { registerConnections } from './connections.ts'
import { registerContacts } from './contacts.ts'
import { registerCors } from './cors.ts'
import { registerGroups } from './groups.ts'
import { registerHealthz, type HealthOptions } from './healthz.ts'
import { registerInbox } from './inbox.ts'
import { registerInboxSuggest } from './inbox-suggest.ts'
import { registerKnowledgeItems } from './knowledge-items.ts'
import { registerMediaAssets } from './media-assets.ts'
import { registerMediaGenerate } from './media-generate.ts'
import { registerNotifications } from './notifications.ts'
import { registerOAuth } from './oauth.ts'
import { registerOnboarding } from './onboarding.ts'
import { registerOpenAiSettings } from './openai-settings.ts'
import { registerOverview } from './overview.ts'
import { registerPages } from './pages.ts'
import { registerPerformance } from './performance.ts'
import { registerPosts } from './posts.ts'
import { registerPostsCompose } from './posts-compose.ts'
import { registerSearch } from './search.ts'
import { registerStream } from './stream.ts'
import { registerWebhooks, type WebhooksDeps } from './webhooks.ts'

const VALIDATION_STATUSES = new Set([400, 413, 415, 422])
const STATUS_CODES: Partial<Record<number, ErrorCode>> = {
  401: 'UNAUTHENTICATED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'VERSION_CONFLICT',
  429: 'RATE_LIMITED',
}

export interface AppDeps {
  sql: Sql
  db: Db
  logger: Logger
  /** Cấu hình liên quan HTTP; mặc định theo giá trị dev của `platform/config` (main.ts truyền config thật). */
  http?: {
    /** Origin của web (CORS có credentials + kiểm Origin của request ghi). */
    allowedOrigins?: readonly string[]
    cookieSecure?: boolean
    trustProxy?: boolean
  }
  /** Cho test: bộ đếm đăng nhập sai với đồng hồ giả. */
  loginLimiter?: LoginLimiter
  /** `/healthz`: đường dẫn đĩa cần theo dõi; test truyền hàm đo đĩa giả. */
  health?: HealthOptions
  /** Phát sự kiện miền (pg-boss của api). Có thì mới đăng ký các route ghi cần phát sự kiện. */
  events?: EventPublisher
  /** Hub SSE (đã `start()`); có thì mới đăng ký `GET /api/v1/stream`. `app.close()` đóng nó. */
  realtime?: RealtimeHub
  /**
   * Mã hoá bí mật + adapter OpenAI cho Cài đặt › OpenAI (đăng ký cùng `events`). Thiếu `cipher` →
   * lưu khoá trả 500 (chỉ xảy ra ngoài production, khi chưa đặt `APP_ENCRYPTION_KEYS`).
   */
  ai?: Pick<AiDeps, 'cipher' | 'openai'>
  /** Đồng hồ cho tháng của `GET /api/v1/ai/budget` (test cố định thời điểm); mặc định giờ hệ thống. */
  clock?: () => Date
  /**
   * Kết nối Fanpage + IG (Story 2.2) và Threads (Story 2.3): client Graph + Threads (fake khi `META_FAKE=1`), mã hoá token, cấu hình OAuth.
   * Đăng ký cùng `events` (xác nhận phát `page.connected` / `page.reconnected`). `jobs` (Story 4.2): xác nhận enqueue
   * `connections.subscribe_page` trong cùng transaction.
   */
  connections?: Omit<ConnectionsDeps, 'db' | 'events' | 'log'>
  /**
   * Kho ảnh/file Cloudinary (AD-14) cho logo hồ sơ thương hiệu (Story 3.1), đính kèm của khách (Story 4.3), file
   * kho kiến thức (Story 5.2) và ảnh bài (Story 6.1). Không truyền → kho "chưa cấu hình": lưu logo / tải file trả `MEDIA_NOT_CONFIGURED`,
   * phần chữ của hồ sơ vẫn lưu được.
   */
  media?: MediaStores
  /**
   * Cổng webhook Meta/Threads (Story 4.1, AD-4): hàng đợi `webhook.route`, verify token + app secret, gốc công
   * khai để dựng URL callback. Không truyền → không đăng ký route webhook (vd test chỉ kiểm phần khác).
   */
  webhooks?: Omit<WebhooksDeps, 'db' | 'log'>
  /** Enqueue job (Story 4.7: gửi tin từ Hộp thư enqueue `inbox.send` cùng transaction). Thiếu → không có route gửi tin. */
  jobs?: JobSender
}

/** Như `trustProxy: 1` của proxy-addr (kiểu Fastify không nhận số): chỉ tin hop đầu tiên. */
const trustOneHop = (_address: string, hop: number): boolean => hop < 1

export function buildApp({ sql, db, logger, http = {}, loginLimiter, health, events, realtime, ai, clock, connections, media, webhooks, jobs }: AppDeps): FastifyInstance {
  // Sau một hop reverse proxy (nginx): chỉ tin địa chỉ cuối của X-Forwarded-For, không tin cả chuỗi client gửi.
  const app = Fastify({ loggerInstance: logger as FastifyBaseLogger, trustProxy: http.trustProxy ? trustOneHop : false })

  app.setNotFoundHandler((req, reply) => {
    const body: ErrorResponse = { error: { code: 'NOT_FOUND', message: `${req.method} ${req.url} không tồn tại` } }
    return reply.code(404).send(body)
  })

  app.setErrorHandler((err: Error & { statusCode?: number; validation?: unknown }, req, reply) => {
    const isZod = err instanceof ZodError
    const isApp = err instanceof AppError
    const given = err.statusCode
    const status = isZod ? 400 : given && given >= 400 && given < 600 ? given : 500
    // `loggableError`: lỗi truy vấn Drizzle mang tham số (vd từ khoá tìm ⌘K có thể là SĐT) — không log tham số.
    if (status >= 500) req.log.error({ err: loggableError(err) }, 'lỗi không xử lý')
    const code: ErrorCode = isApp
      ? err.code
      : isZod || err.validation || VALIDATION_STATUSES.has(status)
        ? 'VALIDATION_FAILED'
        : (STATUS_CODES[status] ?? 'INTERNAL')
    const details = isZod ? err.issues : isApp ? err.details : err.validation
    const body: ErrorResponse = {
      error: {
        code,
        message: status >= 500 ? 'Internal error' : err.message,
        ...(status < 500 && details !== undefined ? { details } : {}),
      },
    }
    return reply.code(status).send(body)
  })

  const allowedOrigins = http.allowedOrigins ?? DEV_ALLOWED_ORIGINS
  // CORS trước guard auth: preflight không bị 401/403, và header CORS có trên mọi response /api/v1 (kể cả lỗi).
  registerCors(app, allowedOrigins)
  app.register(authPlugin, {
    db,
    allowedOrigins,
    cookieSecure: http.cookieSecure ?? true,
    ...(loginLimiter ? { loginLimiter } : {}),
  })
  registerHealthz(app, sql, health)
  registerAiBudget(app, { db, ...(clock ? { now: clock } : {}) })
  if (realtime) registerStream(app, realtime, db)
  if (events) registerNotifications(app, { db, events })
  if (events) registerOpenAiSettings(app, { db, events, cipher: ai?.cipher ?? null, ...(ai?.openai ? { openai: ai.openai } : {}) })
  registerPages(app, { db })
  if (events) registerGroups(app, { db, events })
  // Hồ sơ thương hiệu (Story 3.1): không cần `events`; `media` thiếu → kho chưa cấu hình (logo trả MEDIA_NOT_CONFIGURED).
  const mediaStores = media ?? createMediaStores({ CLOUDINARY_FOLDER: 'ottm' })
  registerBrandProfiles(app, { db, media: mediaStores })
  // Cấu hình AI trả lời tự động (Story 5.1): kế thừa Nhóm→Trang qua `profiles`, không cần `events`.
  registerAutoreplyConfigs(app, { db })
  // Kho kiến thức (Story 5.2): FAQ + file lưu kho riêng tư; tải file cần `jobs` (enqueue `profiles.knowledge.extract`).
  registerKnowledgeItems(app, { db, media: mediaStores, jobs })
  // Soạn bài (Story 6.1): ảnh bài lên kho công khai + nháp nhiều trang (một cửa tạo `content.createPost`).
  registerMediaAssets(app, { db, media: mediaStores, ...(clock ? { now: clock } : {}) })
  // Story 6.4: lên lịch / đăng (enqueue `publish.target` cùng transaction → cần `jobs`); Story 6.5: xoá phát
  // `post_target.cancelled` (cần `events`); Lịch nội dung `GET /calendar`.
  registerPosts(app, { db, jobs, events, ...(clock ? { now: clock } : {}) })
  // Chiến dịch nuôi page (Story 7.1): nháp wizard bước 1–3 + trang chọn được làm đích. Story 7.2: bài xem trước — lưu
  // nháp enqueue `campaigns.preview` (cần `jobs`); Sửa / Xoá / Tạo lại cần `jobs` + `events`. Story 7.6: tiếp tục kiểm khoá
  // OpenAI (cần `cipher`).
  registerCampaigns(app, { db, jobs, events, cipher: ai?.cipher ?? null, ...(clock ? { now: clock } : {}) })
  // Hộp thư (Story 4.3): hội thoại, tin, đính kèm (đọc từ kho riêng tư); Story 4.7: gửi tin (cần `events` + `jobs`).
  registerInbox(app, { db, media: mediaStores, events, jobs })
  // Khách hàng (Story 4.9): danh sách, hồ sơ, lịch sử, gộp (cần `events`), tóm tắt AI (cần `events` + `jobs`).
  registerContacts(app, { db, events, jobs, ...(clock ? { now: clock } : {}) })
  // Tìm nhanh ⌘K (Story 4.10): trang, nhóm, khách không dấu — ghép `pages.search` + `inbox.searchContacts`.
  registerSearch(app, { db })
  // Hiệu suất (Story 8.2): chỉ đọc số liệu `analytics` đã thu (không gọi Meta theo request).
  registerPerformance(app, { db, ...(clock ? { now: clock } : {}) })
  // Tổng quan (Story 8.5): read-model ghép việc cần xử lý từ các module + số liệu chính của `analytics`.
  registerOverview(app, { db, ...(clock ? { now: clock } : {}) })
  // Màn chào 4 bước (Story 5.7): trạng thái dẫn xuất từ trang, khoá OpenAI (cần `cipher`), hồ sơ, cấu hình AI, tin AI.
  registerOnboarding(app, { db, cipher: ai?.cipher ?? null })
  // Viết thử bằng AI (Story 3.4) + Gợi ý bằng AI ở Hộp thư (Story 4.8) + Thử AI trả lời (Story 5.3) + caption Soạn bài
  // (Story 6.2): cần `events` (reserve/settle hạn mức của AI gateway, AD-7).
  if (events) {
    const aiDeps = {
      db,
      events,
      cipher: ai?.cipher ?? null,
      ...(ai?.openai ? { openai: ai.openai } : {}),
      log: logger.child({ component: 'ai' }),
    }
    registerBrandSample(app, aiDeps)
    registerInboxSuggest(app, aiDeps)
    registerAutoreplyTest(app, aiDeps)
    registerPostsCompose(app, aiDeps)
    // Sinh ảnh AI (Story 6.3): enqueue `content.image.generate` cùng transaction → cần `jobs`.
    if (jobs) registerMediaGenerate(app, { db, cipher: aiDeps.cipher, media: mediaStores, jobs, ...(clock ? { now: clock } : {}) })
  }
  if (events && connections) {
    const deps: ConnectionsDeps = { ...connections, db, events, log: logger.child({ component: 'connections' }) }
    registerConnections(app, deps)
    registerOAuth(app, deps)
  }
  // Cổng webhook (Story 4.1): cần `jobs` (enqueue `webhook.route`) — main.ts truyền từ pg-boss của api.
  if (webhooks) registerWebhooks(app, { ...webhooks, db, log: logger.child({ component: 'webhooks' }) })
  return app
}
