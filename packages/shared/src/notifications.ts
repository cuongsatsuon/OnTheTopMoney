// Trung tâm thông báo (Story 1.4). Thông báo do module `notifications` tạo từ sự kiện miền,
// bật/tắt từng loại ở Cài đặt › Thông báo. Web chỉ đọc qua REST.
import { z } from 'zod'

export const NOTIFICATION_TYPES = [
  'ai_handoff',
  'token_expiring',
  'publish_failed',
  'campaign_paused',
  /** Story 7.6: trang mất kết nối (`page.disconnected`) — chiến dịch dùng trang đó cũng tự tạm dừng. */
  'page_disconnected',
  /** Job hết retry ở queue quan trọng (`critical: true` trong platform/jobs/queues.ts). */
  'system_error',
] as const
export const NotificationType = z.enum(NOTIFICATION_TYPES)
export type NotificationType = z.infer<typeof NotificationType>

/** Bật/tắt từng loại. Khoá là giá trị enum `NotificationType`. */
export const NotificationPrefs = z.object({
  ai_handoff: z.boolean(),
  token_expiring: z.boolean(),
  publish_failed: z.boolean(),
  campaign_paused: z.boolean(),
  page_disconnected: z.boolean(),
  system_error: z.boolean(),
}) satisfies z.ZodType<Record<NotificationType, boolean>>
export type NotificationPrefs = z.infer<typeof NotificationPrefs>

/** Mặc định: bật cả, trừ `campaign_paused` (theo mock hiện có) [ASSUMPTION]. */
export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = {
  ai_handoff: true,
  token_expiring: true,
  publish_failed: true,
  campaign_paused: false,
  page_disconnected: true,
  system_error: true,
}

const IsoDateTime = z.iso.datetime({ offset: false })

export const Notification = z.object({
  id: z.string().min(1),
  type: NotificationType,
  title: z.string(),
  body: z.string(),
  /** Thực thể liên quan (`conversation`, `page`, `post_target`, `campaign`, `job`). */
  entity: z.string(),
  entityId: z.string(),
  pageId: z.string().nullable(),
  readAt: IsoDateTime.nullable(),
  createdAt: IsoDateTime,
})
export type Notification = z.infer<typeof Notification>

export const NOTIFICATIONS_PAGE_SIZE = 50

/** `GET /api/v1/notifications?since=&cursor=&limit=` — mới nhất trước. */
export const ListNotificationsQuery = z.object({
  /** Chỉ lấy thông báo tạo sau thời điểm này (ISO 8601) — dùng cho toast. */
  since: z.iso.datetime({ offset: true }).optional(),
  /** `nextCursor` của trang trước (id thông báo). */
  cursor: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(NOTIFICATIONS_PAGE_SIZE),
})
export type ListNotificationsQuery = z.input<typeof ListNotificationsQuery>

export const ListNotificationsResponse = z.object({
  items: z.array(Notification),
  nextCursor: z.string().nullable(),
  /** Tổng số chưa đọc (không phụ thuộc trang). */
  unreadCount: z.number().int().nonnegative(),
})
export type ListNotificationsResponse = z.infer<typeof ListNotificationsResponse>

/** `POST /api/v1/notifications/read` — đánh dấu đã đọc vài thông báo hoặc tất cả. */
export const MarkNotificationsReadRequest = z.union([
  z.object({ all: z.literal(true) }).strict(),
  z.object({ ids: z.array(z.uuid()).min(1).max(200) }).strict(),
])
export type MarkNotificationsReadRequest = z.infer<typeof MarkNotificationsReadRequest>

export const MarkNotificationsReadResponse = z.object({
  unreadCount: z.number().int().nonnegative(),
})
export type MarkNotificationsReadResponse = z.infer<typeof MarkNotificationsReadResponse>
