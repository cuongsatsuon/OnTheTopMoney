// Cổng nhận webhook Meta/Threads (Story 4.1, AD-4). Web chỉ đọc nhật ký + gửi sự kiện thử + xử lý lại qua REST.
// `WebhookProduct` và `WebhookEventStatus` định nghĩa ở enums.ts (Consistency Conventions › Enum).
import { z } from 'zod'
import { Platform, WebhookEventStatus, WebhookHealthStatus, WebhookProduct } from './enums.ts'

/**
 * Field tối thiểu đăng ký ở cấp app cho từng sản phẩm (AD-4). Cài đặt › Webhook hiển thị cho chủ shop biết cần bật gì
 * ở Meta; `page` cũng là `subscribed_fields` của job `connections.subscribe_page`. Story 4.5: thêm "đã nhận / đã xem"
 * của tin outbound (`message_deliveries`, `message_reads`; IG `messaging_seen` chỉ bật ở cấp app).
 */
export const WEBHOOK_FIELDS = {
  page: ['messages', 'messaging_postbacks', 'message_echoes', 'message_deliveries', 'message_reads', 'feed'],
  instagram: ['messages', 'messaging_seen', 'comments'],
  threads: ['replies'],
} as const
export type WebhookFields = { [K in keyof typeof WEBHOOK_FIELDS]: string[] }

const IsoDateTime = z.iso.datetime({ offset: false })

/** Một trang liên quan tới mục webhook (đã khớp ở job `webhook.route`); `null` khi chưa biết/đã gỡ. */
export const WebhookEventPage = z.object({
  id: z.string().min(1),
  name: z.string(),
  platform: Platform,
})
export type WebhookEventPage = z.infer<typeof WebhookEventPage>

/** Một dòng nhật ký webhook (Cài đặt › Webhook). Không bao giờ chứa chữ ký hay app secret (AD-12). */
export const WebhookEventDto = z.object({
  id: z.string().min(1),
  product: WebhookProduct,
  /** Id trang theo nền tảng lấy từ payload (entry.id); dùng để khớp trang. */
  platformPageId: z.string().nullable(),
  /** Trang nội bộ đã khớp ở job route (giữ tên để hiển thị kể cả khi đã gỡ). */
  page: WebhookEventPage.nullable(),
  /** Loại mục: `messages`, `comments`, `feed`, `replies`, `test`… */
  field: z.string(),
  status: WebhookEventStatus,
  /** Mã lỗi chẩn đoán khi `status=failed`; `null` khi không lỗi. */
  errorCode: z.string().nullable(),
  /** Sự kiện do nút "Gửi sự kiện thử" tạo (chỉ ghi nhật ký, không route tới trang). */
  test: z.boolean(),
  receivedAt: IsoDateTime,
  routedAt: IsoDateTime.nullable(),
})
export type WebhookEventDto = z.infer<typeof WebhookEventDto>

export const WEBHOOK_LOG_PAGE_SIZE = 50

/** `GET /api/v1/webhooks/events?cursor=&limit=` — mới nhất trước. */
export const WebhookLogQuery = z.object({
  /** `nextCursor` của trang trước (id sự kiện). */
  cursor: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(WEBHOOK_LOG_PAGE_SIZE),
})
export type WebhookLogQuery = z.input<typeof WebhookLogQuery>

export const WebhookLogResponse = z.object({
  items: z.array(WebhookEventDto),
  nextCursor: z.string().nullable(),
})
export type WebhookLogResponse = z.infer<typeof WebhookLogResponse>

/** `GET /api/v1/webhooks/config` — URL callback + verify token (giá trị của chính chủ shop, AD-12) + field. */
export const WebhookConfigResponse = z.object({
  callbacks: z.object({ meta: z.string(), threads: z.string() }),
  /** Đầy đủ để chủ shop dán vào Meta; `null` khi server chưa đặt `META_VERIFY_TOKEN`. */
  verifyToken: z.string().nullable(),
  verifyTokenConfigured: z.boolean(),
  fields: z.object({
    page: z.array(z.string()),
    instagram: z.array(z.string()),
    threads: z.array(z.string()),
  }),
})
export type WebhookConfigResponse = z.infer<typeof WebhookConfigResponse>

/** `POST /api/v1/webhooks/test` — tạo một sự kiện thử (cờ `test`) chỉ để kiểm nhật ký. */
export const WebhookTestRequest = z.object({ product: WebhookProduct })
export type WebhookTestRequest = z.infer<typeof WebhookTestRequest>

// ---------------------------------------------------------------------------------------------------------
// Story 4.2 — tự đăng ký webhook trang (`connections.subscribe_page`) + sức khoẻ webhook (cron `webhooks.health`).
// ---------------------------------------------------------------------------------------------------------

/**
 * Mã lỗi chẩn đoán khi đăng ký webhook cho một trang (`POST /{page}/subscribed_apps`) thất bại, lưu ở
 * `page_credentials.webhook_subscribe_error`. `RATE_LIMITED`/`TRANSIENT` không lưu (job retry); hết retry → `FAILED`.
 */
export const WEBHOOK_SUBSCRIBE_ERRORS = ['PERMISSION_DENIED', 'TOKEN_INVALID', 'REJECTED', 'FAILED'] as const
export const WebhookSubscribeError = z.enum(WEBHOOK_SUBSCRIBE_ERRORS)
export type WebhookSubscribeError = z.infer<typeof WebhookSubscribeError>

/** Sức khoẻ một sản phẩm webhook: `lastEventAt` = sự kiện thật (không phải `test`) gần nhất; `null` khi chưa có. */
export const WebhookProductHealth = z.object({
  product: WebhookProduct,
  status: WebhookHealthStatus,
  lastEventAt: IsoDateTime.nullable(),
})
export type WebhookProductHealth = z.infer<typeof WebhookProductHealth>

/** Trang chưa gỡ mà lần đăng ký webhook gần nhất lỗi. */
export const PageSubscriptionError = z.object({
  pageId: z.string().min(1),
  name: z.string(),
  platform: Platform,
  errorCode: WebhookSubscribeError,
})
export type PageSubscriptionError = z.infer<typeof PageSubscriptionError>

/** `GET /api/v1/webhooks/health` — Cài đặt › Webhook, banner Hộp thư, cảnh báo Chi tiết trang. */
export const WebhookHealthResponse = z.object({
  products: z.array(WebhookProductHealth),
  pageSubscriptionErrors: z.array(PageSubscriptionError),
})
export type WebhookHealthResponse = z.infer<typeof WebhookHealthResponse>
