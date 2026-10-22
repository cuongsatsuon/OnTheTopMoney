// Cài đặt › Webhook phía web (Story 4.1, AD-4): URL callback + verify token + nhật ký + Xử lý lại + Gửi sự kiện
// thử. Chỉ đọc/ghi qua REST; không có nghiệp vụ ở client. Helper thuần (nhãn/tone/thời gian) tách để test.
import {
  WebhookConfigResponse,
  WebhookEventDto,
  WebhookLogResponse,
  type WebhookEventStatus,
  type WebhookProduct,
} from '@ottm/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from './api'

export const WEBHOOK_CONFIG_KEY = ['webhooks', 'config'] as const
export const WEBHOOK_EVENTS_KEY = ['webhooks', 'events'] as const

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
