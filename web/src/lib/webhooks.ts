// Cài đặt › Webhook phía web (Story 4.1, AD-4): URL callback + verify token + nhật ký + Xử lý lại + Gửi sự kiện
// thử. Chỉ đọc/ghi qua REST; không có nghiệp vụ ở client. Helper thuần (nhãn/tone/thời gian) tách để test.
// Story 4.2: sức khoẻ webhook (`GET /webhooks/health`) cho Cài đặt › Webhook, banner Hộp thư, cảnh báo Chi tiết trang.
// Mọi khoá query gốc `['webhooks', …]` → hint realtime `webhook.stalled|recovered` tự làm cũ (lib/realtime.ts).
import {
  WebhookConfigResponse,
  WebhookEventDto,
  WebhookHealthResponse,
  WebhookLogResponse,
  type PageSubscriptionError,
  type WebhookEventStatus,
  type WebhookProduct,
  type WebhookSubscribeError,
} from '@ottm/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from './api'

export const WEBHOOK_CONFIG_KEY = ['webhooks', 'config'] as const
export const WEBHOOK_EVENTS_KEY = ['webhooks', 'events'] as const
export const WEBHOOK_HEALTH_KEY = ['webhooks', 'health'] as const
/** Hỏi lại sức khoẻ mỗi phút (nhãn "x phút trước" + phòng khi lỡ hint realtime). */
export const WEBHOOK_HEALTH_REFETCH_MS = 60_000

export function useWebhookConfig() {
  return useQuery({
    queryKey: WEBHOOK_CONFIG_KEY,
    queryFn: ({ signal }) => apiFetch('/webhooks/config', { schema: WebhookConfigResponse, signal }),
  })
}

export function useWebhookEvents() {
  return useQuery({
    queryKey: WEBHOOK_EVENTS_KEY,
    queryFn: ({ signal }) => apiFetch('/webhooks/events', { schema: WebhookLogResponse, signal }),
  })
}

export function useWebhookHealth() {
  return useQuery({
    queryKey: WEBHOOK_HEALTH_KEY,
    queryFn: ({ signal }) => apiFetch('/webhooks/health', { schema: WebhookHealthResponse, signal }),
    refetchInterval: WEBHOOK_HEALTH_REFETCH_MS,
  })
}

export function useSendTestEvent() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (product: WebhookProduct) =>
      apiFetch('/webhooks/test', { method: 'POST', body: { product }, schema: WebhookEventDto }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: WEBHOOK_EVENTS_KEY }),
  })
}

export function useRetryWebhookEvent() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch(`/webhooks/events/${id}/retry`, { method: 'POST', schema: WebhookEventDto }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: WEBHOOK_EVENTS_KEY }),
  })
}

export type ChipTone = 'success' | 'danger' | 'neutral' | 'primary'

/** Nhãn + tone cho trạng thái một mục webhook ở nhật ký. */
export function webhookStatusView(event: Pick<WebhookEventDto, 'status' | 'errorCode'>): { label: string; tone: ChipTone } {
  switch (event.status) {
    case 'received':
      return { label: 'Đang xử lý', tone: 'neutral' }
    case 'routed':
      return { label: '200 OK', tone: 'success' }
    case 'ignored':
      return { label: 'Đã bỏ qua', tone: 'neutral' }
    case 'failed':
      return { label: event.errorCode ? `Lỗi: ${webhookErrorLabel(event.errorCode)}` : 'Lỗi', tone: 'danger' }
  }
}

const ERROR_LABELS: Record<string, string> = {
  WEBHOOK_ROUTE_FAILED: 'xử lý thất bại',
}

export function webhookErrorLabel(code: string): string {
  return ERROR_LABELS[code] ?? code
}

/** Chỉ mục `failed` mới cho "Xử lý lại" (AD-4). */
export function canRetry(status: WebhookEventStatus): boolean {
  return status === 'failed'
}

const FIELD_LABELS: Record<string, string> = {
  test: 'thử',
  messages: 'messages',
  message_echoes: 'message_echoes',
  messaging_postbacks: 'messaging_postbacks',
  message_reactions: 'message_reactions',
  message_deliveries: 'message_deliveries',
  message_reads: 'message_reads',
  comments: 'comments',
  feed: 'feed',
  mentions: 'mentions',
  replies: 'replies',
}

export function webhookFieldLabel(event: Pick<WebhookEventDto, 'field' | 'test'>): string {
  if (event.test) return `${event.field === 'test' ? 'test' : event.field} (thử)`
  return FIELD_LABELS[event.field] ?? event.field
}

const TIME = new Intl.DateTimeFormat('vi-VN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
const DATE_TIME = new Intl.DateTimeFormat('vi-VN', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })

/** "Hôm nay HH:MM:SS" khi cùng ngày, ngược lại "DD/MM HH:MM" (giờ máy). */
export function webhookEventTime(iso: string, now = new Date()): string {
  const d = new Date(iso)
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()
  return sameDay ? `Hôm nay ${TIME.format(d)}` : DATE_TIME.format(d)
}

// ---------------------------------------------------------------------------------------------------------
// Story 4.2 — sức khoẻ webhook
// ---------------------------------------------------------------------------------------------------------

export const WEBHOOK_PRODUCT_LABEL: Record<WebhookProduct, string> = {
  meta: 'Facebook / Instagram',
  threads: 'Threads',
}

/** "Đang chờ tin đầu tiên" hoặc "Nhận tin gần nhất: vừa xong / x phút trước / x giờ trước / x ngày trước". */
export function lastEventLabel(lastEventAt: string | null, now = new Date()): string {
  if (!lastEventAt) return 'Đang chờ tin đầu tiên'
  const minutes = Math.floor((now.getTime() - new Date(lastEventAt).getTime()) / 60_000)
  if (minutes < 1) return 'Nhận tin gần nhất: vừa xong'
  if (minutes < 60) return `Nhận tin gần nhất: ${minutes} phút trước`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `Nhận tin gần nhất: ${hours} giờ trước`
  return `Nhận tin gần nhất: ${Math.floor(hours / 24)} ngày trước`
}

const SUBSCRIBE_ERROR_LABELS: Record<WebhookSubscribeError, string> = {
  PERMISSION_DENIED: 'Thiếu quyền nhận tin nhắn của trang. Kết nối lại trang và cấp đủ quyền.',
  TOKEN_INVALID: 'Token của trang không còn hợp lệ. Kết nối lại trang.',
  REJECTED: 'Meta từ chối đăng ký nhận tin cho trang này.',
  FAILED: 'Chưa đăng ký nhận tin được do lỗi tạm thời. Thử kết nối lại trang.',
}

/** Câu tiếng Việt cho mã lỗi đăng ký webhook của một trang. */
export function subscribeErrorLabel(code: WebhookSubscribeError): string {
  return SUBSCRIBE_ERROR_LABELS[code]
}

/** Sản phẩm đang `stalled` (banner Hộp thư hiện khi danh sách không rỗng). */
export function stalledProducts(health: Pick<WebhookHealthResponse, 'products'> | undefined): WebhookProduct[] {
  return (health?.products ?? []).filter((p) => p.status === 'stalled').map((p) => p.product)
}

/** Lỗi đăng ký webhook của một trang (Chi tiết trang); `null` khi không có. */
export function pageSubscriptionErrorOf(
  health: Pick<WebhookHealthResponse, 'pageSubscriptionErrors'> | undefined,
  pageId: string,
): PageSubscriptionError | null {
  return health?.pageSubscriptionErrors.find((e) => e.pageId === pageId) ?? null
}

/** Đường tới Cài đặt › Webhook (banner Hộp thư). */
export const WEBHOOK_SETTINGS_PATH = '/cai-dat?section=webhook'
