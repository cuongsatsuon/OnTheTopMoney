// Lịch nội dung (Story 6.5) phía web: lưới tháng / tuần theo giờ Việt Nam, gom target (`GET /calendar`) thành "bài trên
// lịch", kế hoạch kéo thả và các nút của ngăn chi tiết. Mọi thay đổi đi qua `POST /posts/:id/targets/transition` có sẵn
// (AD-13): kéo bài đã lên lịch = `reschedule`, kéo bài lỗi = `retry` vào giờ mới, "Bỏ lịch" = `unschedule`, "Xoá" =
// `cancel` — không có đường ghi riêng.
// Lưới tính theo ngày giờ VN (UTC+7 cố định) bất kể múi giờ trình duyệt; khoá ngày `YYYY-MM-DD`.
// Phần thuần tách khỏi hook để test được (calendar.test.ts).
import {
  CalendarResponse,
  type CalendarItemDto,
  type PageDto,
  type Platform,
  type PostTargetStatus,
  type Scope,
  type TargetAction,
  type TransitionTargetsRequest,
} from '@ottm/shared'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { apiFetch } from './api'
import { serverScope } from './inbox'
import { formatVnDateTime, isoToVnInput, vnToIso, type StatusTone } from './publish'

/* ---------- Ngày theo giờ VN ---------- */

/** Ngày lịch `YYYY-MM-DD` (giờ VN). */
export type DayKey = string

const DAY_MS = 24 * 60 * 60_000
const pad = (n: number) => String(n).padStart(2, '0')

const keyToUtc = (key: DayKey) => Date.parse(`${key}T00:00:00.000Z`)
const utcToKey = (ms: number): DayKey => new Date(ms).toISOString().slice(0, 10)

/** Hôm nay theo giờ VN. */
export const todayKey = (now = Date.now()): DayKey => isoToVnInput(new Date(now).toISOString()).date

export const addDays = (key: DayKey, n: number): DayKey => utcToKey(keyToUtc(key) + n * DAY_MS)

/** Thứ trong tuần, Thứ Hai = 0 … Chủ Nhật = 6. */
export const weekdayIndex = (key: DayKey): number => (new Date(keyToUtc(key)).getUTCDay() + 6) % 7

export const mondayOf = (key: DayKey): DayKey => addDays(key, -weekdayIndex(key))

/** Tháng `YYYY-MM` của một ngày; lùi / tiến `n` tháng. */
export const monthOf = (key: DayKey): string => key.slice(0, 7)
export function addMonths(month: string, n: number): string {
  const [y, m] = month.split('-').map(Number) as [number, number]
  const d = new Date(Date.UTC(y, m - 1 + n, 1))
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`
}

/** Ô của lưới tháng: từ Thứ Hai của tuần chứa ngày 1 tới Chủ Nhật của tuần chứa ngày cuối (4–6 tuần). */
export function monthGrid(month: string): DayKey[] {
  const first = `${month}-01`
  const [y, m] = month.split('-').map(Number) as [number, number]
  const last = utcToKey(Date.UTC(y, m, 0))
  const start = mondayOf(first)
  const end = addDays(mondayOf(last), 6)
  const cells: DayKey[] = []
  for (let d = start; d <= end; d = addDays(d, 1)) cells.push(d)
  return cells
}

export const weekGrid = (monday: DayKey): DayKey[] => Array.from({ length: 7 }, (_, i) => addDays(monday, i))

export type CalendarView = 'month' | 'week'

/** Khoảng `[from, to)` ISO UTC để hỏi server: đúng các ô đang hiện (00:00 VN ngày đầu → 00:00 VN sau ngày cuối). */
export function rangeOfDays(days: readonly DayKey[]): { from: string; to: string } {
  return { from: vnToIso(days[0]!, '00:00')!, to: vnToIso(addDays(days[days.length - 1]!, 1), '00:00')! }
}

const MONTH_TITLE = (month: string) => `Tháng ${Number(month.slice(5, 7))}, ${month.slice(0, 4)}`
const dm = (key: DayKey) => `${key.slice(8, 10)}/${key.slice(5, 7)}`

/** Tiêu đề thanh điều hướng: "Tháng 10, 2026" / "26/10 – 01/11/2026". */
export function calendarTitle(view: CalendarView, anchor: { month: string; monday: DayKey }): string {
  if (view === 'month') return MONTH_TITLE(anchor.month)
  const end = addDays(anchor.monday, 6)
  return `${dm(anchor.monday)} – ${dm(end)}/${end.slice(0, 4)}`
}

const WEEKDAY_NAMES = ['Thứ Hai', 'Thứ Ba', 'Thứ Tư', 'Thứ Năm', 'Thứ Sáu', 'Thứ Bảy', 'Chủ Nhật']
/** "Chủ Nhật 01/11". */
export const dayLabel = (key: DayKey) => `${WEEKDAY_NAMES[weekdayIndex(key)]} ${dm(key)}`

/* ---------- Gom target thành "bài trên lịch" ---------- */

export interface CalendarGroup {
  /** `(campaignId ?? postId) | phút | trạng thái`. */
  key: string
  /** Bài của các target (bài thủ công: 1; slot chiến dịch gom theo giờ: nhiều). */
  postIds: string[]
  campaignId: string | null
  status: PostTargetStatus
  /** Giờ hẹn của nhóm (ISO). */
  scheduledAt: string
  day: DayKey
  hour: number
  /** "19:00". */
  time: string
  items: CalendarItemDto[]
  /** Có nội dung do AI sinh → nhãn chữ "AI tạo" (UX-DR10). */
  ai: boolean
  title: string | null
  /** Story 7.3: chủ đề — slot chiến dịch chưa viết hiện "AI sẽ viết · <chủ đề>". */
  topic: string | null
  thumbnailUrl: string | null
}

/**
 * Gom target theo `(campaignId ?? postId)` + cùng phút + cùng trạng thái: bài thủ công 3 trang cùng giờ = một ô; slot
 * chiến dịch (1 post : 1 target) cùng giờ = một ô; một trang lỗi trong bài tách thành ô đỏ riêng (một ô = một hành động).
 * Thứ tự: giờ tăng dần, rồi theo khoá (ổn định giữa các lần tải).
 */
export function groupCalendarItems(items: readonly CalendarItemDto[]): CalendarGroup[] {
  const groups = new Map<string, CalendarGroup>()
  for (const it of items) {
    const minute = it.scheduledAt.slice(0, 16)
    const key = `${it.campaignId ? `c:${it.campaignId}` : `p:${it.postId}`}|${minute}|${it.status}`
    const g = groups.get(key)
    if (g) {
      g.items.push(it)
      if (!g.postIds.includes(it.postId)) g.postIds.push(it.postId)
      g.ai ||= it.ai
      g.title ??= it.title
      g.topic ??= it.topic
      g.thumbnailUrl ??= it.thumbnailUrl
      continue
    }
    const vn = isoToVnInput(it.scheduledAt)
    groups.set(key, {
      key,
      postIds: [it.postId],
      campaignId: it.campaignId,
      status: it.status,
      scheduledAt: it.scheduledAt,
      day: vn.date,
      hour: Number(vn.time.slice(0, 2)),
      time: vn.time,
      items: [it],
      ai: it.ai,
      title: it.title,
      topic: it.topic,
      thumbnailUrl: it.thumbnailUrl,
    })
  }
  return [...groups.values()].sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt) || a.key.localeCompare(b.key))
}

/** Nhóm theo ngày (ô lịch). */
export function groupsByDay(groups: readonly CalendarGroup[]): Map<DayKey, CalendarGroup[]> {
  const m = new Map<DayKey, CalendarGroup[]>()
  for (const g of groups) m.set(g.day, [...(m.get(g.day) ?? []), g])
  return m
}

/* ---------- Lọc ---------- */

export interface CalendarFilter {
  platform: Platform | 'all'
  status: PostTargetStatus | 'all'
}

/** Lọc target trước khi gom: theo nền tảng của trang, theo trạng thái. Trang không có trong danh sách → bỏ khi lọc nền tảng. */
export function filterItems(items: readonly CalendarItemDto[], filter: CalendarFilter, platformOf: (pageId: string) => Platform | undefined): CalendarItemDto[] {
  return items.filter((it) => (filter.platform === 'all' || platformOf(it.pageId) === filter.platform) && (filter.status === 'all' || it.status === filter.status))
}

/* ---------- Trạng thái trên ô ---------- */

export const CALENDAR_STATUS_LABEL: Record<PostTargetStatus, string> = {
  scheduled: 'Đã lên lịch',
  publishing: 'Đang đăng',
  published: 'Đã đăng',
  failed: 'Lỗi đăng',
  pending_approval: 'Chờ duyệt',
  planned: 'Chờ AI soạn',
  draft: 'Nháp',
  cancelled: 'Đã huỷ',
}

export const CALENDAR_STATUS_TONE: Record<PostTargetStatus, StatusTone> = {
  scheduled: 'info',
  publishing: 'info',
  published: 'success',
  failed: 'danger',
  pending_approval: 'muted',
  planned: 'muted',
  draft: 'muted',
  cancelled: 'muted',
}

/* ---------- Kéo thả + hành động ---------- */

/**
 * Hành động của kéo thả theo trạng thái nhóm: đã lên lịch → đổi giờ; lỗi → đăng lại vào giờ mới. Còn lại không kéo được
 * (`publishing`/`published`/`cancelled` theo AD-13; `planned`/`pending_approval` chờ Epic 7).
 */
export function dragAction(status: PostTargetStatus): Extract<TargetAction, 'reschedule' | 'retry'> | null {
  if (status === 'scheduled') return 'reschedule'
  if (status === 'failed') return 'retry'
  return null
}

export const canDrag = (g: Pick<CalendarGroup, 'status'>): boolean => dragAction(g.status) !== null

/** Xoá được (`cancel`): mọi trạng thái trước `publishing` và bài lỗi. */
export const canCancel = (status: PostTargetStatus): boolean => ['planned', 'draft', 'pending_approval', 'scheduled', 'failed'].includes(status)

/**
 * Giờ mới khi thả: ô tháng (`hour` không có) → đổi ngày, giữ giờ phút VN; ô giờ của tuần → đổi ngày + giờ, giữ phút.
 */
export function dropAt(g: Pick<CalendarGroup, 'time'>, day: DayKey, hour?: number): string {
  const time = hour === undefined ? g.time : `${pad(hour)}:${g.time.slice(3, 5)}`
  return vnToIso(day, time)!
}

export interface TransitionCall {
  postId: string
  body: TransitionTargetsRequest
}

/** Request cho một hành động trên mọi target của nhóm — mỗi bài một request (tất cả hoặc không trong một bài). */
export function groupCalls(g: Pick<CalendarGroup, 'items'>, action: TargetAction, scheduledAt?: string | null): TransitionCall[] {
  const byPost = new Map<string, { id: string; version: number }[]>()
  for (const it of g.items) byPost.set(it.postId, [...(byPost.get(it.postId) ?? []), { id: it.id, version: it.version }])
  return [...byPost.entries()].map(([postId, targets]) => ({
    postId,
    body: action === 'unschedule' || action === 'cancel' ? { action, targets } : { action, scheduledAt: scheduledAt ?? null, targets },
  }))
}

export type MovePlan =
  | { kind: 'locked' }
  | { kind: 'same' }
  | { kind: 'past' }
  | { kind: 'move'; action: 'reschedule' | 'retry'; scheduledAt: string; calls: TransitionCall[] }

/** Kế hoạch khi thả một nhóm vào ô: không kéo được / đúng chỗ cũ / giờ đã qua → không gọi API; còn lại → request. */
export function planMove(g: CalendarGroup, day: DayKey, hour: number | undefined, now = Date.now()): MovePlan {
  const action = dragAction(g.status)
  if (!action) return { kind: 'locked' }
  const scheduledAt = dropAt(g, day, hour)
  // So theo phút (bài "Đăng ngay" có giờ hẹn lẻ giây).
  if (scheduledAt.slice(0, 16) === g.scheduledAt.slice(0, 16)) return { kind: 'same' }
  if (Date.parse(scheduledAt) <= now) return { kind: 'past' }
  return { kind: 'move', action, scheduledAt, calls: groupCalls(g, action, scheduledAt) }
}

/** Toast sau khi thả. */
export function moveToast(plan: Extract<MovePlan, { kind: 'move' }>, count: number, now = Date.now()): string {
  const when = formatVnDateTime(plan.scheduledAt, now)
  return plan.action === 'retry' ? `Sẽ đăng lại ${count} trang lúc ${when}` : `Đã dời ${count} trang sang ${when}`
}

/** Câu báo khi thả không hợp lệ (`null` = im lặng). */
export function moveRefusal(plan: MovePlan): string | null {
  if (plan.kind === 'past') return 'Không dời bài về thời điểm đã qua'
  if (plan.kind === 'locked') return 'Bài đã đăng hoặc đang đăng nên không đổi lịch được'
  return null
}

/** Tiêu đề ô: đầu caption; slot chiến dịch AI chưa viết (Story 7.3) → "AI sẽ viết · <chủ đề>"; còn lại bài chỉ có ảnh. */
export function groupTitle(g: Pick<CalendarGroup, 'title' | 'status' | 'topic'>): string {
  if (g.title) return g.title
  if (g.status === 'planned') return g.topic ? `AI sẽ viết · ${g.topic}` : 'AI sẽ viết'
  return 'Bài chỉ có ảnh'
}

/**
 * Slot chiến dịch (Story 7.3): không "Bỏ lịch" (slot không thành bài nháp — server trả 409) và không "Mở ở Soạn bài"
 * (bài của chiến dịch sửa ở Chiến dịch nuôi page).
 */
export const isCampaignGroup = (g: Pick<CalendarGroup, 'campaignId'>): boolean => g.campaignId !== null

/**
 * Câu báo khi chạy nhiều request (mỗi bài một request) mà lỗi giữa chừng: các bài trước đã đổi, không hoàn tác — nói rõ
 * đã xong bao nhiêu (đóng việc hoãn 6.5 "kéo ô gom nhiều bài chiến dịch"). Chưa bài nào xong → chỉ câu lỗi.
 */
export function partialRunMessage(done: number, total: number, error: string): string {
  return done > 0 && total > 1 ? `Đã xong ${done}/${total} bài — ${error}` : error
}

/** Đếm cho thanh chú giải: số ô lỗi / chờ duyệt. */
export function calendarCounts(groups: readonly CalendarGroup[]): { failed: number; pending: number } {
  return { failed: groups.filter((g) => g.status === 'failed').length, pending: groups.filter((g) => g.status === 'pending_approval').length }
}

/** Trang (theo thứ tự danh sách trang) của nhóm; trang không còn → bỏ. */
export function groupPages<P extends Pick<PageDto, 'id'>>(g: Pick<CalendarGroup, 'items'>, pages: readonly P[]): P[] {
  const ids = new Set(g.items.map((it) => it.pageId))
  return pages.filter((p) => ids.has(p.id))
}

/* ---------- Hook ---------- */

/** Khoá gốc `post_targets`: SSE `post_target.*` tự làm cũ (realtime `entityMatches`). */
export const calendarKey = (scope: string | null, from: string, to: string) => ['post_targets', 'calendar', scope, from, to] as const
export const CALENDAR_ROOT_KEY = ['post_targets'] as const

const EMPTY: CalendarResponse = { items: [], truncated: false }

/** Target trong `[from, to)` theo phạm vi. Phạm vi trỏ tới trang/nhóm của kho mẫu → rỗng (không hỏi server). */
export function useCalendar(scope: Scope, range: { from: string; to: string }) {
  const param = serverScope(scope)
  return useQuery({
    queryKey: calendarKey(param, range.from, range.to),
    queryFn: ({ signal }) => {
      if (param === null) return Promise.resolve(EMPTY)
      const qs = new URLSearchParams({ scope: param, from: range.from, to: range.to })
      return apiFetch(`/calendar?${qs}`, { schema: CalendarResponse, signal })
    },
    placeholderData: keepPreviousData,
  })
}
