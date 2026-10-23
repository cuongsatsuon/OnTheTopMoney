// Lên lịch và đăng bài (Story 6.4) phía web: giờ VN ↔ ISO UTC cho ô ngày/giờ ở Soạn bài, chế độ bài (còn nháp / đã rời
// nháp), nhãn trạng thái từng trang, câu lỗi khi lên lịch, toast "Đã đăng" theo SSE, và hook gọi
// `POST /posts/:id/targets/transition` (lên lịch / đăng ngay / đổi giờ / bỏ lịch / đăng lại — AD-13).
// Server lưu UTC; FE tự định dạng theo giờ Việt Nam (UTC+7 cố định — Việt Nam không đổi giờ mùa hè).
// Phần thuần tách khỏi hook để test được (publish.test.ts).
import {
  PostDto,
  instagramImageFit,
  type MediaAssetDto,
  type PageDto,
  type PostTargetDto,
  type PostTargetStatus,
  type PublishIssue,
  type TransitionTargetsRequest,
} from '@ottm/shared'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useRef } from 'react'
import { apiFetch, isApiError } from './api'
import { issueText, postKey } from './composer'
import { PAGES_KEY } from './connections'
import { errorMessage, errorMessageOf } from './error-messages'
import { useRealtimeEvent } from './realtime'

export const VN_TZ = 'Asia/Ho_Chi_Minh'
const VN_OFFSET_MS = 7 * 60 * 60_000
/** Giờ đăng mặc định (UX F4: "Thứ Bảy 19:00"). */
export const DEFAULT_PUBLISH_TIME = '19:00'

const pad = (n: number) => String(n).padStart(2, '0')

/** Ô ngày (`YYYY-MM-DD`) + ô giờ (`HH:MM`) theo giờ VN → ISO UTC; sai dạng → `null`. */
export function vnToIso(date: string, time: string): string | null {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  const t = /^(\d{2}):(\d{2})$/.exec(time)
  if (!d || !t) return null
  const [y, m, day, h, min] = [Number(d[1]), Number(d[2]), Number(d[3]), Number(t[1]), Number(t[2])]
  if (m < 1 || m > 12 || day < 1 || day > 31 || h > 23 || min > 59) return null
  const ms = Date.UTC(y, m - 1, day, h, min) - VN_OFFSET_MS
  // 31/02 → Date.UTC tự lăn sang tháng sau: coi là sai.
  if (new Date(ms + VN_OFFSET_MS).getUTCDate() !== day) return null
  return new Date(ms).toISOString()
}

/** ISO → giá trị ô ngày / giờ theo giờ VN. */
export function isoToVnInput(iso: string): { date: string; time: string } {
  const v = new Date(Date.parse(iso) + VN_OFFSET_MS)
  return { date: `${v.getUTCFullYear()}-${pad(v.getUTCMonth() + 1)}-${pad(v.getUTCDate())}`, time: `${pad(v.getUTCHours())}:${pad(v.getUTCMinutes())}` }
}

/** Mặc định của ô ngày giờ: 19:00 hôm nay (giờ VN); đã qua (hoặc còn dưới 5 phút) → 19:00 ngày mai. */
export function defaultScheduleInput(now: number): { date: string; time: string } {
  const today = isoToVnInput(new Date(now).toISOString()).date
  const iso = vnToIso(today, DEFAULT_PUBLISH_TIME)!
  if (Date.parse(iso) - now > 5 * 60_000) return { date: today, time: DEFAULT_PUBLISH_TIME }
  return { date: isoToVnInput(new Date(Date.parse(iso) + 24 * 60 * 60_000).toISOString()).date, time: DEFAULT_PUBLISH_TIME }
}

/** Câu báo dưới ô ngày giờ trước khi gửi; `null` = hợp lệ. */
export function scheduleInputIssue(date: string, time: string, now: number): string | null {
  const iso = vnToIso(date, time)
  if (!iso) return 'Chọn ngày và giờ đăng'
  if (Date.parse(iso) <= now) return 'Thời gian đăng đã qua — chọn thời điểm khác'
  return null
}

const WEEKDAY = ['Chủ Nhật', 'Thứ Hai', 'Thứ Ba', 'Thứ Tư', 'Thứ Năm', 'Thứ Sáu', 'Thứ Bảy']

/** "19:00 · Thứ Bảy 31/10" (giờ VN; khác năm hiện tại thì thêm năm). */
export function formatVnDateTime(iso: string, now = Date.now()): string {
  const v = new Date(Date.parse(iso) + VN_OFFSET_MS)
  const year = new Date(now + VN_OFFSET_MS).getUTCFullYear()
  const day = `${pad(v.getUTCDate())}/${pad(v.getUTCMonth() + 1)}${v.getUTCFullYear() !== year ? `/${v.getUTCFullYear()}` : ''}`
  return `${pad(v.getUTCHours())}:${pad(v.getUTCMinutes())} · ${WEEKDAY[v.getUTCDay()]} ${day}`
}

/* ---------- Chế độ bài + trạng thái từng trang ---------- */

/** Bài có target đã rời nháp → Soạn bài chỉ xem (không sửa chữ / ảnh / đích), chỉ còn Bỏ lịch / Đổi giờ / Đăng lại. */
export const isLocked = (post: PostDto | null | undefined): boolean => !!post?.targets.some((t) => t.status !== 'draft')

/** `{id, version}` của các target đang ở một trong `statuses` (body của transition). */
export function targetRefs(post: PostDto, statuses: readonly PostTargetStatus[]): { id: string; version: number }[] {
  return post.targets.filter((t) => statuses.includes(t.status)).map((t) => ({ id: t.id, version: t.version }))
}

export type StatusTone = 'muted' | 'info' | 'success' | 'danger'
export interface TargetStatusView {
  tone: StatusTone
  label: string
  /** Lý do lỗi (theo `errorCode`). */
  detail?: string
}

/** Nhãn trạng thái của một trang trên tab Soạn bài. */
export function targetStatusView(t: Pick<PostTargetDto, 'status' | 'scheduledAt' | 'publishedAt' | 'errorCode'>, now = Date.now()): TargetStatusView {
  switch (t.status) {
    case 'draft':
      return { tone: 'muted', label: 'Nháp' }
    case 'scheduled':
      return t.scheduledAt && Date.parse(t.scheduledAt) > now
        ? { tone: 'info', label: `Đã lên lịch · ${formatVnDateTime(t.scheduledAt, now)}` }
        : { tone: 'info', label: 'Đang chờ đăng…' }
    case 'publishing':
      return { tone: 'info', label: 'Đang đăng…' }
    case 'published':
      return { tone: 'success', label: t.publishedAt ? `Đã đăng · ${formatVnDateTime(t.publishedAt, now)}` : 'Đã đăng' }
    case 'failed':
      return { tone: 'danger', label: 'Đăng lỗi', detail: errorMessage(t.errorCode ?? 'PUBLISH_FAILED') }
    case 'cancelled':
      return { tone: 'muted', label: 'Đã huỷ' }
    case 'planned':
      return { tone: 'muted', label: 'Chờ AI soạn' }
    case 'pending_approval':
      return { tone: 'muted', label: 'Chờ duyệt' }
  }
}

/** Có trang đang chờ tới lượt / đang đăng → hỏi lại định kỳ (phòng lỡ sự kiện realtime). */
export function hasInFlight(post: PostDto | null | undefined, now = Date.now()): boolean {
  return !!post?.targets.some((t) => t.status === 'publishing' || (t.status === 'scheduled' && !!t.scheduledAt && Date.parse(t.scheduledAt) <= now + 60_000))
}

/** Hỏi lại bài mỗi chừng này khi còn trang đang đăng. */
export const IN_FLIGHT_POLL_MS = 5_000

/** Khung xem trước ảnh Instagram (đệm trắng khi ngoài 4:5–1,91:1 — đúng như lúc đăng). */
export const igPreviewFit = (media: Pick<MediaAssetDto, 'width' | 'height'> | undefined) => (media ? instagramImageFit(media.width, media.height) : 'ok')

/* ---------- Câu báo ---------- */

/**
 * Lỗi khi lên lịch / đăng lại: lỗi của một trang (luật nền tảng, giới hạn/24h) → "<Trang>: <câu>"; còn lại câu theo mã.
 */
export function transitionErrorMessage(err: unknown, pages: readonly Pick<PageDto, 'id' | 'name' | 'platform'>[]): string {
  if (!isApiError(err)) return errorMessageOf(err)
  const details = (err.details ?? {}) as { pageId?: unknown; issues?: unknown }
  const page = typeof details.pageId === 'string' ? pages.find((p) => p.id === details.pageId) : undefined
  if (!page) return errorMessageOf(err)
  const issue = Array.isArray(details.issues) ? (details.issues[0] as PublishIssue | undefined) : undefined
  return `${page.name}: ${issue ? issueText(issue, page.platform) : errorMessage(err.code)}`
}

/** Toast sau khi bấm Lên lịch / Đăng ngay / Đăng lại. */
export function scheduledToast(count: number, scheduledAt: string | null): string {
  return scheduledAt ? `Đã lên lịch ${count} trang · ${formatVnDateTime(scheduledAt)}` : `Đang đăng lên ${count} trang…`
}

/** Toast "Đã đăng" (gộp các trang đăng cùng lúc). */
export function publishedToast(names: readonly string[]): string {
  return names.length === 1 ? `Đã đăng lên ${names[0]}` : `Đã đăng lên ${names.length} trang`
}

/* ---------- Hook ---------- */

/**
 * Một hành động cho các target của bài; kết quả (bài mới nhất) ghi thẳng vào cache. Story 6.5: xong (cả khi lỗi — 409 là
 * dữ liệu cũ) thì làm cũ Lịch nội dung (khoá gốc `post_targets`) — đổi giờ / bỏ lịch không phát sự kiện realtime.
 */
export function useTransitionTargets() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ postId, body }: { postId: string; body: TransitionTargetsRequest }) =>
      apiFetch(`/posts/${postId}/targets/transition`, { method: 'POST', body, schema: PostDto }),
    onSuccess: (post) => qc.setQueryData(postKey(post.id), post),
    onSettled: () => qc.invalidateQueries({ queryKey: ['post_targets'] }),
  })
}

/** Gom các trang vừa đăng trong chừng này rồi mới toast một lần. */
export const PUBLISHED_TOAST_DEBOUNCE_MS = 1_500

/** Toast "Đã đăng lên <trang>" khi server phát `post_target.published` (dùng một lần, ở AppShell). */
export function usePublishedToasts(notify: (message: string) => void) {
  const qc = useQueryClient()
  const pending = useRef<string[]>([])
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  const onPublished = useCallback(
    (hint: { pageId?: string | undefined }) => {
      // Cache `['pages']` giữ phản hồi gốc `{items}` (`select` của `usePages` chỉ áp khi đọc qua hook).
      const pages = qc.getQueryData<{ items: PageDto[] }>(PAGES_KEY)?.items ?? []
      pending.current.push(pages.find((p) => p.id === hint.pageId)?.name ?? 'trang')
      clearTimeout(timer.current)
      timer.current = setTimeout(() => {
        const names = pending.current
        pending.current = []
        if (names.length) notify(publishedToast(names))
      }, PUBLISHED_TOAST_DEBOUNCE_MS)
    },
    [notify, qc],
  )
  useRealtimeEvent('post_target.published', onPublished)
}
