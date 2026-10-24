// Wizard tạo chiến dịch (Story 7.1) phía web: form bước 1–3 → body `SaveCampaignRequest` (`POST /campaigns`, sau đó
// `PUT /campaigns/:id`), mở lại nháp (`/chien-dich/tao?id=<id>`), trang chọn được (`GET /campaigns/page-options` — mất
// kết nối / thiếu hồ sơ → mờ + lý do), lỗi validate → đúng bước + dưới ô. Kiểm sớm bằng chính schema của
// `@ottm/shared` mà server dùng (tổng tỉ lệ = 100%). Tóm tắt (tổng bài, lịch nhiệt, bài có ảnh) dùng helper shared
// `campaignPostsOnDay` / `campaignImageRatio` — cùng luật 7.2/7.3 dùng khi tạo slot.
// Story 7.2: bước 4 xem trước 7 bài đầu (`GET /campaigns/:id/preview`, hỏi lại khi còn bài đang viết; SSE `post_target.*`
// làm cũ) + Sửa / Xoá / Tạo lại (`POST /campaigns/:id/slots/:targetId/transition` với `version`); PUT mang
// `baseUpdatedAt` để không đè nháp đã đổi ở tab khác.
// Story 7.3: "Bắt đầu chiến dịch" (`POST /campaigns/:id/start` — lỗi trang / ngày về đúng bước như khi lưu) và danh sách
// chiến dịch kèm tiến độ (`GET /campaigns?scope=`) cho `/chien-dich` + thẻ ở Tổng quan.
// Story 7.4: hàng đợi "Bài chờ duyệt" (`GET /campaigns/pending-slots?scope=`) + Duyệt / Từ chối / Sửa / Tạo lại qua
// CÙNG route hành động slot với bước 4 và Lịch nội dung (route trả `{slot}` — vá cache xem trước, làm cũ danh sách / Lịch).
// Bài quá giờ (hoặc còn dưới 2 phút) → "Quá giờ — chọn giờ mới"; server trả `SCHEDULE_IN_PAST` thì FE cũng hỏi giờ mới.
// Story 7.5: Tạm dừng / Tiếp tục (`POST /campaigns/:id/pause|resume`, không xác nhận) + lý do tạm dừng trên thẻ; Xoá
// (`DELETE /campaigns/:id`, có xác nhận — bài đã đăng giữ nguyên). Tiếp tục khi lý do tự dừng còn → câu theo mã.
// Phần thuần tách khỏi hook để test được (campaigns.test.ts).
import {
  CAMPAIGN_SLOT_MIN_LEAD_MS,
  CampaignActionResponse,
  CampaignDto,
  CampaignListResponse,
  CampaignPageOptionsResponse,
  CampaignPreviewResponse,
  CampaignSlotActionResponse,
  PendingSlotsResponse,
  DeleteCampaignResponse,
  SaveCampaignRequest,
  StartCampaignResponse,
  type PendingSlotDto,
  type CampaignStatus,
  type CampaignSummaryDto,
  type CampaignSlotActionRequest,
  type CampaignSlotDto,
  type ErrorCode,
  type ImageErrorCode,
  campaignImageRatio,
  campaignPostsOnDay,
  type CampaignDuration,
  type CampaignFrequency,
  type CampaignGoal,
  type CampaignMode,
  type CampaignPageBlockReason,
  type CampaignPageOption,
  type CampaignTopic,
  type GroupDto,
  type PageDto,
  type PauseReason,
  type Scope,
} from '@ottm/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiFetch, isApiError } from './api'
import { CALENDAR_ROOT_KEY, todayKey } from './calendar'
import { aiErrorText, imageFailureText } from './composer'
import { errorMessageOf } from './error-messages'
import { serverScope } from './inbox'
import { defaultScheduleInput, isoToVnInput } from './publish'

/** Tham số URL của nháp đang mở (`/chien-dich/tao?id=<campaignId>`). */
export const CAMPAIGN_PARAM = 'id'
export const WIZARD_STEPS = ['Mục tiêu', 'Trang đích', 'Nội dung & lịch', 'Duyệt'] as const

/* ---------- Nhãn ---------- */

/** Mục tiêu + chủ đề gợi ý (đổi mục tiêu khi chưa sửa chủ đề → thay bộ gợi ý). */
export const GOALS: { id: CampaignGoal; label: string; desc: string; topics: CampaignTopic[] }[] = [
  {
    id: 'engage',
    label: 'Tăng tương tác',
    desc: 'Bài mẹo, hỏi đáp để khách bình luận, chia sẻ nhiều hơn.',
    topics: [
      { name: 'Mẹo hay', share: 40 },
      { name: 'Review sản phẩm', share: 30 },
      { name: 'Hỏi đáp', share: 20 },
      { name: 'Hậu trường', share: 10 },
    ],
  },
  {
    id: 'follow',
    label: 'Tăng người theo dõi',
    desc: 'Nội dung đều đặn, dễ chia sẻ để trang mới lớn nhanh.',
    topics: [
      { name: 'Mẹo hay', share: 50 },
      { name: 'Xu hướng', share: 30 },
      { name: 'Hậu trường', share: 20 },
    ],
  },
  {
    id: 'sell',
    label: 'Bán hàng',
    desc: 'Giới thiệu sản phẩm, ưu đãi và phản hồi khách để chốt đơn.',
    topics: [
      { name: 'Khuyến mãi', share: 50 },
      { name: 'Review sản phẩm', share: 30 },
      { name: 'Feedback khách', share: 20 },
    ],
  },
  {
    id: 'launch',
    label: 'Ra mắt sản phẩm',
    desc: 'Chuỗi teaser → ra mắt → review cho sản phẩm mới.',
    topics: [
      { name: 'Teaser', share: 30 },
      { name: 'Ra mắt', share: 40 },
      { name: 'Review sản phẩm', share: 30 },
    ],
  },
]
export const goalOf = (id: CampaignGoal) => GOALS.find((g) => g.id === id)!

export const TOPIC_SUGGESTIONS = ['Mẹo hay', 'Review sản phẩm', 'Hỏi đáp', 'Hậu trường', 'Khuyến mãi', 'Feedback khách', 'Xu hướng', 'Mini game']

export const FREQUENCY_LABEL: Record<CampaignFrequency, string> = {
  '3_per_week': '3 bài/tuần',
  '1_per_day': '1 bài/ngày',
  '2_per_day': '2 bài/ngày',
  '3_per_day': '3 bài/ngày',
}

/** Lý do trang không làm đích được (chữ hiển thị cạnh trang mờ). */
export const BLOCK_REASON_TEXT: Record<CampaignPageBlockReason, string> = {
  PAGE_DISCONNECTED: 'Mất kết nối — kết nối lại để chọn',
  CONFIG_MISSING: 'Chưa có hồ sơ thương hiệu',
}

/* ---------- Ngày (lịch VN, `YYYY-MM-DD`) ---------- */

const DAY_MS = 24 * 60 * 60_000
const WD = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7']

/** Dời một ngày lịch `n` ngày (không phụ thuộc múi giờ trình duyệt). */
export function addDaysKey(key: string, n: number): string {
  return new Date(Date.parse(`${key}T00:00:00.000Z`) + n * DAY_MS).toISOString().slice(0, 10)
}

/** "T7, 24/10" của một ngày lịch. */
export function dayLabel(key: string, withYear = false): string {
  const d = new Date(`${key}T00:00:00.000Z`)
  const dd = `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}`
  return `${WD[d.getUTCDay()]}, ${dd}${withYear ? `/${d.getUTCFullYear()}` : ''}`
}

/** "24/10" của một ngày lịch. */
export const shortDay = (key: string) => `${key.slice(8, 10)}/${key.slice(5, 7)}`

/* ---------- Form ---------- */

export interface CampaignForm {
  goal: CampaignGoal
  durationDays: CampaignDuration
  startDate: string
  targetMode: 'group' | 'pages'
  groupId: string | null
  /** Trang chọn ở chế độ "Chọn từng trang". */
  picked: string[]
  defaultFrequency: CampaignFrequency
  /** Tần suất đặt riêng theo trang (không có = theo mặc định). */
  overrides: Record<string, CampaignFrequency>
  /** Trống → tên tự đặt (`autoName`). */
  name: string
  topics: CampaignTopic[]
  /** Chủ shop đã sửa chủ đề → đổi mục tiêu không thay bộ gợi ý. */
  topicsTouched: boolean
  postTimes: string[]
  imageRatio: number
  mode: CampaignMode
}

/** Lựa chọn trang theo id (thiếu = chưa tải xong → coi như chọn được, server vẫn kiểm). */
export type PageOptions = ReadonlyMap<string, CampaignPageOption>

export const blockReasonOf = (options: PageOptions, pageId: string): CampaignPageBlockReason | null => options.get(pageId)?.reason ?? null

/**
 * Form mới: bắt đầu ngày mai (giờ VN), đích theo Phạm vi đang chọn — nhóm → "Theo nhóm"; trang → "Chọn từng trang"
 * với trang đó; tất cả trang → nhóm đầu tiên (nếu có).
 */
export function initialForm(scope: Scope, groups: readonly Pick<GroupDto, 'id'>[], now = Date.now()): CampaignForm {
  const base: CampaignForm = {
    goal: 'engage',
    durationDays: 30,
    startDate: addDaysKey(todayKey(now), 1),
    targetMode: 'group',
    groupId: groups[0]?.id ?? null,
    picked: [],
    defaultFrequency: '1_per_day',
    overrides: {},
    name: '',
    topics: goalOf('engage').topics,
    topicsTouched: false,
    postTimes: ['11:30', '19:30'],
    imageRatio: 70,
    mode: 'review',
  }
  if (scope.kind === 'group') return { ...base, groupId: scope.id }
  if (scope.kind === 'page') return { ...base, targetMode: 'pages', picked: [scope.id] }
  return groups.length ? base : { ...base, targetMode: 'pages' }
}

/** Nạp lại form từ nháp đã lưu: có nhóm nhãn → "Theo nhóm"; không → "Chọn từng trang". */
export function formFromCampaign(c: CampaignDto): CampaignForm {
  const overrides: Record<string, CampaignFrequency> = {}
  for (const p of c.pages) if (p.frequency) overrides[p.pageId] = p.frequency
  return {
    goal: c.goal,
    durationDays: c.durationDays as CampaignDuration,
    startDate: c.startDate,
    targetMode: c.groupId ? 'group' : 'pages',
    groupId: c.groupId,
    picked: c.groupId ? [] : c.pages.map((p) => p.pageId),
    defaultFrequency: c.defaultFrequency,
    overrides,
    name: c.name,
    topics: c.topics,
    topicsTouched: true,
    postTimes: c.postTimes,
    imageRatio: c.imageRatio,
    mode: c.mode,
  }
}

/** Trang hiện ở bước 2 (kể cả trang không chọn được — hiện mờ kèm lý do), theo thứ tự `GET /pages`. */
export function targetPages(form: CampaignForm, pages: readonly PageDto[]): PageDto[] {
  if (form.targetMode === 'group') return form.groupId ? pages.filter((p) => p.groupId === form.groupId) : []
  const picked = new Set(form.picked)
  return pages.filter((p) => picked.has(p.id))
}

/** Trang thật sự làm đích: trang hiện ở bước 2 trừ trang không chọn được (chế độ nhóm tự loại). */
export function activePages(form: CampaignForm, pages: readonly PageDto[], options: PageOptions): PageDto[] {
  return targetPages(form, pages).filter((p) => blockReasonOf(options, p.id) === null)
}

export const frequencyOf = (form: CampaignForm, pageId: string): CampaignFrequency => form.overrides[pageId] ?? form.defaultFrequency

/** Tên tự đặt khi ô Tên để trống: "<nhóm/trang> – <mục tiêu> <n> ngày". */
export function autoName(form: CampaignForm, active: readonly PageDto[], groups: readonly Pick<GroupDto, 'id' | 'name'>[]): string {
  const group = form.targetMode === 'group' ? groups.find((g) => g.id === form.groupId) : undefined
  const who = group ? group.name.replace(/^Nhóm /, '') : (active[0]?.name ?? 'Trang')
  return `${who} – ${goalOf(form.goal).label.toLowerCase()} ${form.durationDays} ngày`
}

/** Body `POST/PUT /campaigns` từ form. `baseUpdatedAt` = `updatedAt` của nháp đã nạp (PUT; khác bản server → 409). */
export function buildCampaignBody(form: CampaignForm, active: readonly PageDto[], name: string, baseUpdatedAt?: string): SaveCampaignRequest {
  return {
    ...(baseUpdatedAt ? { baseUpdatedAt } : {}),
    name,
    goal: form.goal,
    startDate: form.startDate,
    durationDays: form.durationDays,
    groupId: form.targetMode === 'group' ? form.groupId : null,
    defaultFrequency: form.defaultFrequency,
    pages: active.map((p) => ({ pageId: p.id, frequency: form.overrides[p.id] ?? null })),
    topics: form.topics,
    postTimes: [...form.postTimes].sort(),
    imageRatio: form.imageRatio,
    mode: form.mode,
  }
}

/* ---------- Tóm tắt ---------- */

/** Số ô của lịch nhiệt ở cột Tóm tắt (thời lượng dài nhất). */
export const PLAN_DAYS = 30

/** Số bài mỗi ngày (cả các trang) cho `PLAN_DAYS` ô; ô ngoài thời lượng = −1. */
export function dailyPlan(form: CampaignForm, active: readonly PageDto[]): number[] {
  return Array.from({ length: PLAN_DAYS }, (_, day) =>
    day < form.durationDays ? active.reduce((n, p) => n + campaignPostsOnDay(frequencyOf(form, p.id), day, form.postTimes.length), 0) : -1,
  )
}

/** Tổng bài và số bài dự kiến có ảnh AI (Instagram luôn có ảnh — `campaignImageRatio`). */
export function planTotals(form: CampaignForm, active: readonly PageDto[]): { posts: number; imagePosts: number } {
  let posts = 0
  let imagePosts = 0
  for (const p of active) {
    let n = 0
    for (let day = 0; day < form.durationDays; day++) n += campaignPostsOnDay(frequencyOf(form, p.id), day, form.postTimes.length)
    posts += n
    imagePosts += Math.round((n * campaignImageRatio(p.platform, form.imageRatio)) / 100)
  }
  return { posts, imagePosts }
}

export const hasInstagram = (active: readonly Pick<PageDto, 'platform'>[]) => active.some((p) => p.platform === 'instagram')

export const topicSum = (topics: readonly CampaignTopic[]) => topics.reduce((n, t) => n + (Number.isFinite(t.share) ? t.share : 0), 0)

/** Chia đều 100% cho các chủ đề (phần dư dồn vào các chủ đề đầu). */
export function splitEven(topics: readonly CampaignTopic[]): CampaignTopic[] {
  if (!topics.length) return []
  const base = Math.floor(100 / topics.length)
  const rest = 100 - base * topics.length
  return topics.map((t, i) => ({ ...t, share: base + (i < rest ? 1 : 0) }))
}

/* ---------- Lỗi → bước + ô ---------- */

export type CampaignField = Exclude<keyof SaveCampaignRequest, 'baseUpdatedAt'>
const STEP_OF: Record<CampaignField, number> = {
  goal: 1,
  startDate: 1,
  durationDays: 1,
  groupId: 2,
  pages: 2,
  defaultFrequency: 2,
  name: 3,
  topics: 3,
  postTimes: 3,
  imageRatio: 3,
  mode: 3,
}

export interface CampaignErrors {
  /** Câu dưới ô (lỗi đầu tiên của ô đó). */
  fields: Partial<Record<CampaignField, string>>
  /** Câu theo trang (lỗi ở `pages[i]`). */
  pages: Record<string, string>
  /** Bước nhỏ nhất có lỗi; `null` = không lỗi. */
  step: number | null
}

export const NO_ERRORS: CampaignErrors = { fields: {}, pages: {}, step: null }

interface Issue {
  path: readonly PropertyKey[]
  message: string
}

/** Danh sách lỗi (zod phía web hoặc `details` của server) → bước + câu dưới ô. `body` để đổi `pages[i]` → id trang. */
export function campaignErrors(issues: readonly Issue[], body: SaveCampaignRequest): CampaignErrors {
  const out: CampaignErrors = { fields: {}, pages: {}, step: null }
  for (const issue of issues) {
    const field = issue.path[0]
    if (typeof field !== 'string' || !(field in STEP_OF)) continue
    const key = field as CampaignField
    const index = issue.path[1]
    const pageId = key === 'pages' && typeof index === 'number' ? body.pages[index]?.pageId : undefined
    if (pageId) out.pages[pageId] ??= issue.message
    else out.fields[key] ??= issue.message
    out.step = Math.min(out.step ?? STEP_OF[key], STEP_OF[key])
  }
  return out
}

/** Bước `step` còn lỗi (ô thuộc bước đó, hoặc lỗi theo trang ở bước 2) — chặn "Tiếp tục". */
export function stepHasErrors(errors: CampaignErrors, step: number): boolean {
  if (step === 2 && Object.keys(errors.pages).length > 0) return true
  return (Object.keys(errors.fields) as CampaignField[]).some((f) => STEP_OF[f] === step)
}

/** Kiểm sớm trước khi gửi: schema shared + ngày bắt đầu không ở quá khứ (giờ VN). Server kiểm lại cả hai. */
export function validateCampaign(body: SaveCampaignRequest, now = Date.now()): CampaignErrors {
  const parsed = SaveCampaignRequest.safeParse(body)
  const issues: Issue[] = parsed.success ? [] : [...parsed.error.issues]
  if (/^\d{4}-\d{2}-\d{2}$/.test(body.startDate) && body.startDate < todayKey(now)) issues.push({ path: ['startDate'], message: 'Ngày bắt đầu đã qua' })
  return campaignErrors(issues, body)
}

/** Lỗi lưu từ server: `VALIDATION_FAILED` theo ô; lỗi khác → `null` (bên gọi báo bằng toast). */
export function serverCampaignErrors(err: unknown, body: SaveCampaignRequest): CampaignErrors | null {
  if (!isApiError(err) || err.code !== 'VALIDATION_FAILED' || !Array.isArray(err.details)) return null
  const issues = err.details.filter((d): d is Issue => !!d && typeof d === 'object' && Array.isArray((d as Issue).path) && typeof (d as Issue).message === 'string')
  const out = campaignErrors(issues, body)
  return out.step === null ? null : out
}

/**
 * Lỗi "Bắt đầu chiến dịch" (Story 7.3): server kiểm cấu hình ĐÃ LƯU nên `pages[i]` đánh theo thứ tự trang đã lưu — form
 * có thể đã bỏ trang vừa mất kết nối / gỡ (`activePages`), map theo `body` thì câu lỗi rơi vào trang khác.
 */
export function startCampaignErrors(err: unknown, body: SaveCampaignRequest, saved: Pick<CampaignDto, 'pages'> | undefined): CampaignErrors | null {
  return serverCampaignErrors(err, saved ? { ...body, pages: saved.pages } : body)
}

/* ---------- Xem trước 7 bài đầu (Story 7.2) ---------- */

/** Khoảng hỏi lại khi còn bài AI đang viết / đang tạo ảnh (SSE vẫn làm cũ ngay khi có sự kiện). */
export const PREVIEW_POLL_MS = 5_000

/** Bài đang hiện (chưa xoá, theo thứ tự đăng) + số bài đã bỏ + còn bài đang viết. */
export function previewView(items: readonly CampaignSlotDto[]): { shown: CampaignSlotDto[]; removed: number; generating: boolean } {
  const shown = items.filter((s) => s.status !== 'cancelled')
  return { shown, removed: items.length - shown.length, generating: items.some((s) => s.status === 'planned') }
}

/** Pha của một thẻ: AI đang viết caption, đang tạo ảnh (đã có caption), sẵn sàng xem / sửa. */
export type SlotPhase = 'writing' | 'image' | 'ready'
export function slotPhase(slot: Pick<CampaignSlotDto, 'status' | 'caption' | 'imagePending'>): SlotPhase {
  if (slot.status !== 'planned') return 'ready'
  return slot.imagePending || slot.caption ? 'image' : 'writing'
}

/** "T2, 26/10 · 11:30" — giờ đăng dự kiến theo giờ VN (UTC+7, không giờ mùa hè). */
export function slotWhen(slotAt: string): string {
  const vn = new Date(Date.parse(slotAt) + 7 * 60 * 60_000).toISOString()
  return `${dayLabel(vn.slice(0, 10))} · ${vn.slice(11, 16)}`
}

const isImageCode = (code: ErrorCode): code is ImageErrorCode => code === 'IMAGE_REJECTED' || code === 'IMAGE_FAILED'

/** Ghi chú dưới bài có mã lỗi (AI lỗi, ảnh lỗi, hậu kiểm chặn — AD-15); `null` = không lỗi. */
export function slotNote(code: ErrorCode | null): string | null {
  if (!code) return null
  if (code === 'AI_POLICY_BLOCKED') return 'Bài AI vẫn chạm “Điều cần tránh” của hồ sơ thương hiệu — sửa lại hoặc tạo lại.'
  if (isImageCode(code)) return `Không tạo được ảnh — ${imageFailureText(code).toLowerCase()} Bấm “Tạo lại” để thử lại.`
  return aiErrorText(code)
}

/** Sửa / Tạo lại chỉ khi bài đã viết xong (`pending_approval`); Xoá được cả bài đang viết. */
export const slotCanEdit = (slot: Pick<CampaignSlotDto, 'status'>) => slot.status === 'pending_approval'
export const slotCanCancel = (slot: Pick<CampaignSlotDto, 'status'>) => slot.status === 'pending_approval' || slot.status === 'planned'

/** Câu toast khi lưu nháp bị 409 (đã đổi ở tab khác / đã bắt đầu). */
export const DRAFT_CONFLICT_TEXT = 'Nháp đã đổi ở tab khác — tải lại trang để xem bản mới nhất.'

/* ---------- Hook React Query ---------- */

export const campaignKey = (id: string) => ['campaigns', id] as const
export const campaignPreviewKey = (id: string) => ['campaigns', id, 'preview'] as const
export const CAMPAIGN_PAGE_OPTIONS_KEY = ['campaigns', 'page-options'] as const

/** Trang chọn được làm đích, theo id. */
export function useCampaignPageOptions() {
  return useQuery({
    queryKey: CAMPAIGN_PAGE_OPTIONS_KEY,
    queryFn: ({ signal }) => apiFetch('/campaigns/page-options', { schema: CampaignPageOptionsResponse, signal }),
    select: (data): PageOptions => new Map(data.items.map((o) => [o.pageId, o])),
  })
}

/** Nháp đang mở; `null` → không tải. */
export function useCampaign(id: string | null) {
  return useQuery({
    queryKey: campaignKey(id ?? ''),
    queryFn: ({ signal }) => apiFetch(`/campaigns/${id}`, { schema: CampaignDto, signal }),
    enabled: id !== null,
    retry: false,
  })
}

/** Lưu nháp: chưa có id → tạo (`POST`), có id → thay toàn bộ cấu hình (`PUT`). */
export function useSaveCampaign() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, body }: { id: string | null; body: SaveCampaignRequest }) =>
      id
        ? apiFetch(`/campaigns/${id}`, { method: 'PUT', body, schema: CampaignDto })
        : apiFetch('/campaigns', { method: 'POST', body, schema: CampaignDto }),
    onSuccess: (campaign) => {
      qc.setQueryData(campaignKey(campaign.id), campaign)
      // Lưu nháp dựng lại bài xem trước theo cấu hình mới.
      void qc.invalidateQueries({ queryKey: campaignPreviewKey(campaign.id) })
    },
  })
}

/** Bài xem trước của nháp; `null` → không tải. Còn bài đang viết → hỏi lại mỗi `PREVIEW_POLL_MS`. */
export function useCampaignPreview(id: string | null) {
  return useQuery({
    queryKey: campaignPreviewKey(id ?? ''),
    queryFn: ({ signal }) => apiFetch(`/campaigns/${id}/preview`, { schema: CampaignPreviewResponse, signal }),
    enabled: id !== null,
    refetchInterval: (q) => (q.state.data?.generating ? PREVIEW_POLL_MS : false),
  })
}

/**
 * Hành động trên một slot chiến dịch (bước 4, "Bài chờ duyệt", Lịch nội dung — một route). `campaignId` cố định (bước 4)
 * hoặc theo từng lần gọi (hàng đợi gom nhiều chiến dịch). Xong → vá slot trong cache xem trước, làm cũ hàng đợi / danh
 * sách chiến dịch / Lịch; lỗi (409 bài vừa đổi…) → tải lại.
 */
export function useSlotAction(fixedCampaignId?: string) {
  const qc = useQueryClient()
  const refresh = (campaignId: string) => {
    void qc.invalidateQueries({ queryKey: PENDING_SLOTS_ROOT })
    void qc.invalidateQueries({ queryKey: CAMPAIGNS_LIST_ROOT })
    void qc.invalidateQueries({ queryKey: CALENDAR_ROOT_KEY })
    return campaignId
  }
  return useMutation({
    mutationFn: ({ campaignId = fixedCampaignId, targetId, body }: { campaignId?: string | undefined; targetId: string; body: CampaignSlotActionRequest }) =>
      apiFetch(`/campaigns/${campaignId}/slots/${targetId}/transition`, { method: 'POST', body, schema: CampaignSlotActionResponse }),
    onSuccess: ({ slot }, vars) => {
      const campaignId = refresh(vars.campaignId ?? fixedCampaignId ?? '')
      qc.setQueryData<CampaignPreviewResponse>(campaignPreviewKey(campaignId), (old) => (old ? patchPreview(old, slot) : old))
    },
    onError: (_err, vars) => {
      const campaignId = refresh(vars.campaignId ?? fixedCampaignId ?? '')
      void qc.invalidateQueries({ queryKey: campaignPreviewKey(campaignId) })
    },
  })
}

/** Thay slot vừa đổi trong danh sách xem trước (giữ thứ tự); `generating` tính lại. */
export function patchPreview(data: CampaignPreviewResponse, slot: CampaignSlotDto): CampaignPreviewResponse {
  const items = data.items.map((s) => (s.id === slot.id ? slot : s))
  return { items, generating: items.some((s) => s.status === 'planned') }
}

/* ---------- Bắt đầu chiến dịch + danh sách (Story 7.3) ---------- */

export const CAMPAIGN_STATUS_TEXT: Record<CampaignStatus, string> = { running: 'Đang chạy', paused: 'Tạm dừng', done: 'Đã xong', draft: 'Bản nháp' }

/** Toast sau khi bấm "Bắt đầu chiến dịch" (bấm hai lần → chiến dịch đã chạy từ trước, không đổi gì). */
export function startedToast(res: StartCampaignResponse): string {
  const c = res.campaign
  return res.alreadyStarted ? `“${c.name}” đã bắt đầu từ trước` : `Đã bắt đầu “${c.name}” — ${c.postsTotal} bài trên Lịch nội dung`
}

/** % tiến độ theo bài (đã đăng / tổng). */
export const campaignPct = (c: Pick<CampaignSummaryDto, 'postsDone' | 'postsTotal'>) => (c.postsTotal ? Math.round((c.postsDone / c.postsTotal) * 100) : 0)

/** "Hôm nay 19:30" / "Mai 11:30" / "T2, 26/10 · 19:30" theo giờ VN. */
export function relativeVnTime(iso: string, now = Date.now()): string {
  const vn = new Date(Date.parse(iso) + 7 * 60 * 60_000).toISOString()
  const day = vn.slice(0, 10)
  const time = vn.slice(11, 16)
  const today = todayKey(now)
  if (day === today) return `Hôm nay ${time}`
  if (day === addDaysKey(today, 1)) return `Mai ${time}`
  return `${dayLabel(day)} · ${time}`
}

/** Dòng "Bài tiếp theo" của thẻ chiến dịch. */
export function nextPostLabel(c: Pick<CampaignSummaryDto, 'status' | 'nextPost'>, now = Date.now()): string {
  if (c.status === 'draft') return 'Chưa bắt đầu'
  if (c.status === 'paused') return 'Đang tạm dừng'
  if (c.status === 'done') return 'Đã xong'
  return c.nextPost ? relativeVnTime(c.nextPost, now) : 'Chưa có bài sắp đăng'
}

/** Tổng bài đã đăng trong `trend` (7 ngày gần nhất). */
export const trendTotal = (trend: readonly number[]) => trend.reduce((n, v) => n + v, 0)

/** Số chiến dịch theo trạng thái + tổng (tab ở `/chien-dich`). */
export function campaignCounts(items: readonly Pick<CampaignSummaryDto, 'status'>[]): Record<CampaignStatus | 'all', number> {
  const out: Record<CampaignStatus | 'all', number> = { all: items.length, draft: 0, running: 0, paused: 0, done: 0 }
  for (const c of items) out[c.status]++
  return out
}

/** Thẻ "Chiến dịch đang chạy" ở Tổng quan: đang chạy + tạm dừng. */
export const activeCampaigns = <T extends Pick<CampaignSummaryDto, 'status'>>(items: readonly T[]): T[] =>
  items.filter((c) => c.status === 'running' || c.status === 'paused')

export const CAMPAIGNS_LIST_ROOT = ['campaigns', 'list'] as const
export const campaignsListKey = (scope: string | null) => [...CAMPAIGNS_LIST_ROOT, scope] as const

const EMPTY_LIST: CampaignListResponse = { items: [] }

/** Chiến dịch theo Phạm vi (mọi trạng thái). Phạm vi trỏ tới trang / nhóm của kho mẫu → rỗng (không hỏi server). */
export function useCampaigns(scope: Scope) {
  const param = serverScope(scope)
  return useQuery({
    queryKey: campaignsListKey(param),
    queryFn: ({ signal }) => {
      if (param === null) return Promise.resolve(EMPTY_LIST)
      return apiFetch(`/campaigns?${new URLSearchParams({ scope: param })}`, { schema: CampaignListResponse, signal })
    },
    select: (data) => data.items,
  })
}

/** "Bắt đầu chiến dịch": xong → làm cũ danh sách chiến dịch + Lịch nội dung (slot vừa tạo). */
export function useStartCampaign() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, baseUpdatedAt }: { id: string; baseUpdatedAt?: string | undefined }) =>
      apiFetch(`/campaigns/${id}/start`, { method: 'POST', body: baseUpdatedAt ? { baseUpdatedAt } : {}, schema: StartCampaignResponse }),
    onSuccess: (res) => {
      qc.setQueryData(campaignKey(res.campaign.id), res.campaign)
      void qc.invalidateQueries({ queryKey: ['campaigns'] })
      void qc.invalidateQueries({ queryKey: CALENDAR_ROOT_KEY })
    },
  })
}

/* ---------- Hàng đợi "Bài chờ duyệt" (Story 7.4) ---------- */

export const PENDING_SLOTS_ROOT = ['campaigns', 'pending'] as const
export const pendingSlotsKey = (scope: string | null) => [...PENDING_SLOTS_ROOT, scope] as const

const EMPTY_PENDING: PendingSlotsResponse = { items: [], truncated: false }

/** Bài chờ duyệt theo Phạm vi (SSE `post_target.*` làm cũ `['campaigns', …]`). Phạm vi của kho mẫu → rỗng. */
export function usePendingSlots(scope: Scope) {
  const param = serverScope(scope)
  return useQuery({
    queryKey: pendingSlotsKey(param),
    queryFn: ({ signal }) => {
      if (param === null) return Promise.resolve(EMPTY_PENDING)
      return apiFetch(`/campaigns/pending-slots?${new URLSearchParams({ scope: param })}`, { schema: PendingSlotsResponse, signal })
    },
  })
}

/** Giờ đăng hiện tại của bài chờ duyệt (lên Lịch); bài xem trước của nháp chưa có thì theo giờ dự kiến. */
export const slotTime = (slot: Pick<CampaignSlotDto, 'scheduledAt' | 'slotAt'>): string => slot.scheduledAt ?? slot.slotAt

/** Quá giờ: giờ đăng đã qua hoặc còn dưới 2 phút — duyệt phải chọn giờ mới (server trả `SCHEDULE_IN_PAST`). */
export const isOverdue = (slot: Pick<CampaignSlotDto, 'scheduledAt' | 'slotAt'>, now = Date.now()): boolean =>
  Date.parse(slotTime(slot)) <= now + CAMPAIGN_SLOT_MIN_LEAD_MS

export const OVERDUE_TEXT = 'Quá giờ — chọn giờ mới'

/** Vì sao chưa duyệt được (`null` = duyệt được): AI chưa viết được nội dung; hậu kiểm chặn → sửa trước. */
export function approveBlock(slot: Pick<CampaignSlotDto, 'caption' | 'media' | 'errorCode'>): string | null {
  if (!slot.caption && !slot.media.length) return 'AI chưa viết được bài này — bấm “Tạo lại”.'
  if (slot.errorCode === 'AI_POLICY_BLOCKED') return 'Sửa bài trước khi duyệt.'
  return null
}

/** Ghi chú dưới bài chờ duyệt: quá giờ trước, rồi mã lỗi (AI / ảnh / hậu kiểm / luật đăng). */
export function pendingNote(slot: Pick<CampaignSlotDto, 'scheduledAt' | 'slotAt' | 'errorCode'>, now = Date.now()): string | null {
  if (isOverdue(slot, now)) return `${OVERDUE_TEXT}.`
  return slotNote(slot.errorCode)
}

/** "Duyệt tất cả": bài không mã lỗi, chưa quá giờ, đã có nội dung — bài còn lại cần chủ shop xem từng bài. */
export const bulkApprovable = <T extends Pick<CampaignSlotDto, 'scheduledAt' | 'slotAt' | 'errorCode' | 'caption' | 'media'>>(items: readonly T[], now = Date.now()): T[] =>
  items.filter((s) => s.errorCode === null && !isOverdue(s, now) && approveBlock(s) === null)

/** Ô ngày giờ khi duyệt: bài quá giờ → 19:00 tới gần nhất; còn lại → giờ hiện tại của bài. */
export const approveInput = (slot: Pick<CampaignSlotDto, 'scheduledAt' | 'slotAt'>, now = Date.now()): { date: string; time: string } =>
  isOverdue(slot, now) ? defaultScheduleInput(now) : isoToVnInput(slotTime(slot))

/** Body duyệt: `scheduledAt` chỉ khi chủ shop chọn giờ khác giờ hiện tại của bài. */
export function approveBody(slot: Pick<CampaignSlotDto, 'version' | 'scheduledAt' | 'slotAt'>, at?: string | null): CampaignSlotActionRequest {
  return at && at.slice(0, 16) !== slotTime(slot).slice(0, 16) ? { action: 'approve', version: slot.version, scheduledAt: at } : { action: 'approve', version: slot.version }
}

/** Lỗi của "Duyệt" cần hỏi giờ mới. */
export const needsNewTime = (err: unknown): boolean => isApiError(err) && err.code === 'SCHEDULE_IN_PAST'

/** Toast sau khi duyệt một bài. */
export const approvedToast = (slot: Pick<PendingSlotDto, 'scheduledAt' | 'slotAt'>, now = Date.now()): string => `Đã duyệt — bài sẽ đăng ${relativeVnTime(slotTime(slot), now)}`

/* ---------- Tạm dừng, tiếp tục, xoá (Story 7.5) ---------- */

/** Lý do tạm dừng trên thẻ chiến dịch (`MANUAL` = chủ shop tự dừng; còn lại do hệ thống — kèm việc cần làm). */
export const PAUSE_REASON_TEXT: Record<PauseReason, string> = {
  MANUAL: 'Bạn đã tạm dừng chiến dịch — không bài nào được đăng cho tới khi tiếp tục.',
  PAGE_DISCONNECTED: 'Tự tạm dừng: trang trong chiến dịch mất kết nối. Kết nối lại rồi tiếp tục.',
  AI_BUDGET_EXCEEDED: 'Tự tạm dừng: đã dùng hết hạn mức AI tháng này. Tăng hạn mức rồi tiếp tục.',
  PUBLISH_FAILURES: 'Tự tạm dừng: nhiều bài đăng lỗi liên tiếp. Kiểm tra Lịch nội dung rồi tiếp tục.',
  CONFIG_MISSING: 'Tự tạm dừng: trang trong chiến dịch chưa có hồ sơ thương hiệu. Tạo hồ sơ rồi tiếp tục.',
  // Story 7.6: lượt AI viết bài gặp khoá OpenAI chưa dùng được (chưa nhập / bị từ chối).
  OPENAI_KEY_UNAVAILABLE: 'Tự tạm dừng: khoá OpenAI chưa dùng được nên AI không viết tiếp bài. Cập nhật khoá ở Cài đặt rồi tiếp tục.',
}

/** Dòng lý do của thẻ đang tạm dừng (dữ liệu cũ thiếu lý do → câu chung). */
export const pausedNote = (c: Pick<CampaignSummaryDto, 'pauseReason'>): string => (c.pauseReason ? PAUSE_REASON_TEXT[c.pauseReason] : 'Chiến dịch đang tạm dừng.')

/** Toast sau Tạm dừng / Tiếp tục (bấm lại → trạng thái đã như vậy từ trước; tiếp tục có bài lỡ giờ → nói số bài đã bỏ). */
export function lifecycleToast(action: 'pause' | 'resume', res: CampaignActionResponse): string {
  const name = `“${res.campaign.name}”`
  if (!res.changed) return action === 'pause' ? `${name} đã tạm dừng từ trước` : `${name} đang chạy`
  if (action === 'pause') return `Đã tạm dừng ${name} — không bài nào được đăng cho tới khi tiếp tục`
  return res.missed > 0 ? `Đã tiếp tục ${name} — bỏ ${res.missed} bài lỡ giờ trong lúc dừng` : `Đã tiếp tục ${name}`
}

/** Story 7.6: mã lỗi khoá khi tiếp tục chiến dịch dừng vì `OPENAI_KEY_UNAVAILABLE`. */
const RESUME_KEY_CODES: ReadonlySet<string> = new Set(['OPENAI_KEY_MISSING', 'OPENAI_KEY_INVALID', 'OPENAI_KEY_RESTRICTED', 'ENCRYPTION_NOT_CONFIGURED'])

/** Câu lỗi khi tiếp tục bị từ chối vì lý do tự dừng vẫn còn; lỗi khác theo bảng chung. */
export function resumeErrorText(err: unknown): string {
  if (isApiError(err)) {
    if (err.code === 'PAGE_DISCONNECTED') return 'Trang trong chiến dịch vẫn mất kết nối — kết nối lại ở Trang & Nhóm rồi tiếp tục.'
    if (err.code === 'CONFIG_MISSING') return 'Trang trong chiến dịch vẫn chưa có hồ sơ thương hiệu — tạo hồ sơ rồi tiếp tục.'
    if (err.code === 'AI_BUDGET_EXCEEDED') return 'Hạn mức AI tháng này vẫn hết — tăng hạn mức ở Cài đặt rồi tiếp tục.'
    if (RESUME_KEY_CODES.has(err.code)) return 'Khoá OpenAI vẫn chưa dùng được — cập nhật khoá ở Cài đặt › OpenAI rồi tiếp tục.'
  }
  return errorMessageOf(err)
}

/** Nội dung hộp xác nhận xoá. */
export function deleteConfirmText(c: Pick<CampaignSummaryDto, 'name' | 'status'>): string {
  if (c.status === 'draft') return `Nháp “${c.name}” và các bài xem trước sẽ bị xoá. Không hoàn tác được.`
  return `“${c.name}” sẽ bị xoá; các bài chưa đăng bị huỷ khỏi Lịch nội dung. Bài đã đăng vẫn giữ nguyên trên trang. Không hoàn tác được.`
}

/** Toast sau khi xoá. */
export function deletedToast(name: string, res: DeleteCampaignResponse): string {
  const kept = res.kept > 0 ? `, giữ ${res.kept} bài đã đăng` : ''
  return `Đã xoá “${name}” — huỷ ${res.cancelled} bài chưa đăng${kept}`
}

/** Tạm dừng / Tiếp tục: xong → làm cũ danh sách chiến dịch + hàng đợi + Lịch (bài vừa giữ / thả / huỷ vì lỡ giờ). */
export function useCampaignLifecycle() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, action }: { id: string; action: 'pause' | 'resume' }) =>
      apiFetch(`/campaigns/${id}/${action}`, { method: 'POST', body: {}, schema: CampaignActionResponse }),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['campaigns'] })
      void qc.invalidateQueries({ queryKey: CALENDAR_ROOT_KEY })
    },
  })
}

/** Xoá chiến dịch (đã xác nhận): bỏ cache của chiến dịch đó, làm cũ danh sách + hàng đợi + Lịch. */
export function useDeleteCampaign() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id }: { id: string; name: string }) => apiFetch(`/campaigns/${id}`, { method: 'DELETE', schema: DeleteCampaignResponse }),
    onSuccess: (_res, vars) => qc.removeQueries({ queryKey: campaignKey(vars.id) }),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['campaigns'] })
      void qc.invalidateQueries({ queryKey: CALENDAR_ROOT_KEY })
    },
  })
}
