// Trung tâm thông báo phía web (Story 1.4): danh sách + số chưa đọc, đánh dấu đã đọc, cài đặt bật/tắt,
// toast khi có `notification.created` (chữ lấy qua REST, không lấy từ payload realtime).
// Khoá query bắt đầu bằng tên thực thể để realtime vô hiệu hoá đúng nhóm.
import {
  ListNotificationsResponse,
  MarkNotificationsReadResponse,
  NotificationPrefs,
  type MarkNotificationsReadRequest,
  type Notification,
} from '@ottm/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useRef } from 'react'
import { apiFetch } from './api'
import { useRealtimeEvent } from './realtime'

export const NOTIFICATIONS_LIST_KEY = ['notifications', 'list'] as const
export const NOTIFICATION_PREFS_KEY = ['settings', 'notifications'] as const

export function fetchNotifications(
  params: { cursor?: string; limit?: number } = {},
  signal?: AbortSignal,
): Promise<ListNotificationsResponse> {
  const search = new URLSearchParams()
  if (params.cursor) search.set('cursor', params.cursor)
  if (params.limit) search.set('limit', String(params.limit))
  const qs = search.toString()
  return apiFetch(`/notifications${qs ? `?${qs}` : ''}`, {
    schema: ListNotificationsResponse,
    ...(signal ? { signal } : {}),
  })
}

export function useNotifications() {
  return useQuery({ queryKey: NOTIFICATIONS_LIST_KEY, queryFn: ({ signal }) => fetchNotifications({}, signal) })
}

export function useMarkNotificationsRead() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: MarkNotificationsReadRequest) =>
      apiFetch('/notifications/read', { method: 'POST', body, schema: MarkNotificationsReadResponse }),
    onSuccess: ({ unreadCount }, body) => {
      const now = new Date().toISOString()
      queryClient.setQueryData<ListNotificationsResponse>(NOTIFICATIONS_LIST_KEY, (prev) =>
        prev ? applyMarkRead(prev, body, unreadCount, now) : prev,
      )
    },
  })
}

/** Cache danh sách sau `POST /notifications/read`: `unreadCount` lấy từ phản hồi server (gồm cả mục ngoài trang). */
export function applyMarkRead(
  prev: ListNotificationsResponse,
  body: MarkNotificationsReadRequest,
  unreadCount: number,
  now: string,
): ListNotificationsResponse {
  return { ...prev, unreadCount, items: markItemsRead(prev.items, body, now) }
}

/**
 * Cập nhật mục sau khi đánh dấu đã đọc: `{ids}` → chỉ các mục đó, `{all}` → mọi mục chưa đọc đang có.
 * `unreadCount` luôn lấy từ server (caller), không tự đếm.
 */
export function markItemsRead(items: readonly Notification[], body: MarkNotificationsReadRequest, now: string): Notification[] {
  const ids = 'ids' in body ? new Set(body.ids) : null
  return items.map((n) => (n.readAt === null && (!ids || ids.has(n.id)) ? { ...n, readAt: now } : n))
}

export function useNotificationPrefs() {
  return useQuery({
    queryKey: NOTIFICATION_PREFS_KEY,
    queryFn: ({ signal }) => apiFetch('/settings/notifications', { schema: NotificationPrefs, signal }),
  })
}

export function useSaveNotificationPrefs() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (prefs: NotificationPrefs) =>
      apiFetch('/settings/notifications', { method: 'PUT', body: prefs, schema: NotificationPrefs }),
    onSuccess: (prefs) => queryClient.setQueryData(NOTIFICATION_PREFS_KEY, prefs),
  })
}

/** Câu toast cho các thông báo mới (mới nhất trước). */
export function toastText(items: readonly Notification[]): string | null {
  const [newest] = items
  if (!newest) return null
  return items.length > 1 ? `${newest.title} (và ${items.length - 1} thông báo khác)` : newest.title
}

/** Giữ tối đa chừng này id đã thấy (bỏ id cũ nhất trước). */
export const SEEN_CAP = 500

/**
 * Chọn thông báo cần toast từ trang mới nhất: mục chưa đọc mà id chưa có trong `seen`. So theo id,
 * không theo thời gian, nên mục tạo đồng thời hay `createdAt` lệch thứ tự vẫn toast đúng một lần.
 * `seen = null` (chưa có danh sách nào để làm mốc) → chỉ toast mục chưa đọc mới nhất, phần còn lại coi
 * như đã thấy. Trả `seen` mới (đã giới hạn `cap`).
 */
export function pickToasts(
  items: readonly Notification[],
  seen: ReadonlySet<string> | null,
  cap = SEEN_CAP,
): { toast: Notification[]; seen: Set<string> } {
  const unread = items.filter((n) => n.readAt === null)
  const toast = seen ? unread.filter((n) => !seen.has(n.id)) : unread.slice(0, 1)
  const next = new Set(seen ?? [])
  for (const n of items) {
    next.delete(n.id) // đưa lên cuối = mới thấy gần nhất
    next.add(n.id)
  }
  while (next.size > cap) next.delete(next.values().next().value as string)
  return { toast, seen: next }
}

/**
 * Toast mỗi khi server báo `notification.created`: lấy trang mới nhất, toast mục chưa đọc chưa từng
 * thấy. Tập id đã thấy gieo từ lần tải danh sách đầu tiên; các lần lấy nối tiếp nhau để không toast trùng.
 */
export function useNotificationToasts(notify: (message: string) => void) {
  const list = useNotifications()
  const seen = useRef<Set<string> | null>(null)
  const chain = useRef<Promise<void>>(Promise.resolve())

  useEffect(() => {
    if (seen.current === null && list.data) seen.current = new Set(list.data.items.map((n) => n.id))
  }, [list.data])

  const onCreated = useCallback(() => {
    chain.current = chain.current.then(async () => {
      try {
        const { items } = await fetchNotifications({ limit: 20 })
        const picked = pickToasts(items, seen.current)
        seen.current = picked.seen
        const text = toastText(picked.toast)
        if (text) notify(text)
      } catch {
        // Lấy chữ lỗi thì bỏ qua toast; chuông vẫn cập nhật qua refetch danh sách.
      }
    })
  }, [notify])

  useRealtimeEvent('notification.created', onCreated)
}

const DATE_TIME = new Intl.DateTimeFormat('vi-VN', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })

/** "Vừa xong", "5 phút trước", "3 giờ trước", rồi ngày giờ (giờ máy). */
export function relativeTime(iso: string, now = Date.now()): string {
  const diff = Math.max(0, now - Date.parse(iso))
  const minutes = Math.floor(diff / 60_000)
  if (minutes < 1) return 'Vừa xong'
  if (minutes < 60) return `${minutes} phút trước`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} giờ trước`
  return DATE_TIME.format(new Date(iso))
}
