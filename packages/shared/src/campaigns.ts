// Chiến dịch nuôi page (Story 7.1, AD-15, module `campaigns`). Wizard bước 1–3 lưu cấu hình ở `draft`: mục tiêu, thời
// lượng, trang đích + tần suất, chủ đề + tỉ lệ, tỉ lệ ảnh AI, khung giờ đăng, chế độ duyệt. Schema ở đây là nguồn DUY
// NHẤT: FE kiểm sớm (báo dưới ô), server kiểm lại khi lưu (tổng tỉ lệ = 100% — AD-15 "kiểm phía server").
// Helper thuần (`campaignPostsOnDay`, `campaignImageRatio`) dùng cho tóm tắt ở wizard và cho việc tạo slot (7.2/7.3).
// Story 7.2: luật slot chung `campaignSlots` (ngày/giờ, chủ đề theo tỉ lệ, slot nào có ảnh) — nguồn DUY NHẤT cho 7 bài
// xem trước và phần slot còn lại lúc "Bắt đầu" (7.3), để hai lần tạo trùng khoá `(campaign_id, page_id, slot_at)`.
// Story 7.3: "Bắt đầu chiến dịch" (`StartCampaignRequest`) + danh sách chiến dịch kèm tiến độ dẫn xuất
// (`CampaignSummaryDto`, ghép ở read-model của server — AD-18) cho `/chien-dich` và Tổng quan.
// Story 7.4: sinh cuốn chiếu (`CAMPAIGN_GENERATE_WINDOW_MS`), hàng đợi "Bài chờ duyệt" (`PendingSlotDto`) và các hành động
// duyệt / từ chối dùng chung cho hàng đợi và Lịch nội dung (một endpoint — AD-13).
// Story 7.5: tạm dừng / tiếp tục (`CampaignActionResponse`, lý do `pauseReason` trên thẻ) và xoá chiến dịch
// (`DeleteCampaignResponse` — bài đã đăng / đang đăng giữ nguyên).
// Story 7.7: ảnh sản phẩm của chiến dịch (`productImageId` khi lưu nháp, `productImage` khi đọc) — mọi bài có ảnh sinh từ
// ảnh này qua Images API edits để giữ đúng sản phẩm. Chỉ đặt / đổi khi còn nháp.
import { z } from 'zod'
import { ScopeParam } from './scope.ts'
import { MediaAssetDto, POST_CAPTION_MAX, POST_TARGETS_MAX } from './content.ts'
import { CampaignFrequency, CampaignGoal, CampaignMode, CampaignStatus, PauseReason, PostTargetStatus, type Platform } from './enums.ts'
import { ErrorCode } from './errors.ts'
import { MetricComparison } from './metrics.ts'

const IsoDateTime = z.iso.datetime({ offset: false })

/** Thời lượng chọn được (ngày). */
export const CAMPAIGN_DURATIONS = [7, 14, 30] as const
export type CampaignDuration = (typeof CAMPAIGN_DURATIONS)[number]
/** Tên chiến dịch dài nhất [ASSUMPTION]. */
export const CAMPAIGN_NAME_MAX = 120
/** Số chủ đề tối đa [ASSUMPTION] và độ dài tên chủ đề. */
export const CAMPAIGN_TOPICS_MAX = 10
export const CAMPAIGN_TOPIC_NAME_MAX = 60
/** Số khung giờ đăng mỗi ngày tối đa [ASSUMPTION] — cũng là trần số bài/ngày của một trang. */
export const CAMPAIGN_POST_TIMES_MAX = 6
/** Ngày bắt đầu xa nhất tính từ hôm nay (giờ VN) [ASSUMPTION]: chặn gõ nhầm năm. */
export const CAMPAIGN_START_MAX_AHEAD_DAYS = 365

/* ---------- Helper thuần ---------- */

/**
 * Số bài của MỘT trang vào ngày thứ `dayIndex` (0 = ngày bắt đầu): `3_per_week` → 1 bài vào ngày 0, 2, 4 của mỗi tuần
 * chiến dịch; `n_per_day` → n bài. Không vượt số khung giờ (mỗi khung giờ tối đa 1 bài mỗi trang).
 */
export function campaignPostsOnDay(frequency: CampaignFrequency, dayIndex: number, timesCount: number): number {
  const wanted = frequency === '3_per_week' ? ([0, 2, 4].includes(dayIndex % 7) ? 1 : 0) : Number(frequency[0])
  return Math.max(0, Math.min(wanted, timesCount))
}

/** Tỉ lệ (%) bài có ảnh AI của một trang: Instagram luôn cần ảnh (100%); Facebook/Threads theo cấu hình. */
export function campaignImageRatio(platform: Platform, imageRatio: number): number {
  return platform === 'instagram' ? 100 : imageRatio
}

/** Số bài xem trước ở bước 4 wizard (AD-15). */
export const CAMPAIGN_PREVIEW_COUNT = 7

/** Đầu vào của luật slot: cấu hình chiến dịch + nền tảng từng trang (theo thứ tự lưu). */
export interface CampaignSlotPlanInput {
  startDate: string
  durationDays: number
  /** `HH:MM` giờ VN. */
  postTimes: readonly string[]
  defaultFrequency: CampaignFrequency
  topics: readonly { name: string; share: number }[]
  imageRatio: number
  pages: readonly { pageId: string; platform: Platform; frequency: CampaignFrequency | null }[]
}

export interface CampaignSlot {
  pageId: string
  /** ISO UTC — giờ dự kiến ban đầu, bất biến (AD-13). */
  slotAt: string
  topic: string
  /** Slot cần ảnh AI (Instagram luôn cần). */
  withImage: boolean
}

/** Bài thứ `k` (0-based, đếm theo trang) có ảnh không với tỉ lệ `ratio`% — dồn ảnh về đầu (70% → bài 0, 1, 2 có; 3 không). */
export function campaignSlotHasImage(ratio: number, k: number): boolean {
  return Math.ceil(((k + 1) * ratio) / 100) > Math.ceil((k * ratio) / 100)
}

/**
 * Slot của chiến dịch theo thứ tự đăng (giờ rồi thứ tự trang), tối đa `limit` slot đầu:
 * - ngày 0…N−1, mỗi trang `campaignPostsOnDay` bài vào khung giờ chỉ số `⌊i·T/n⌋` (n bài trên T khung giờ);
 * - chủ đề chia vòng có trọng số (smooth weighted round-robin) theo tỉ lệ, trên thứ tự chung — 10 slot với 40/30/20/10
 *   ra đúng 4/3/2/1 và xen kẽ nhau;
 * - ảnh: `campaignImageRatio` của trang, đếm bài theo từng trang (`campaignSlotHasImage`).
 * Thuần, xác định: cùng cấu hình → cùng danh sách (7.3 tạo phần còn lại không trùng 7 bài xem trước).
 */
export function campaignSlots(plan: CampaignSlotPlanInput, limit = Number.POSITIVE_INFINITY): CampaignSlot[] {
  const times = [...plan.postTimes].sort()
  const raw: { pageId: string; slotAt: string; pageIndex: number }[] = []
  for (let day = 0; day < plan.durationDays; day++) {
    const date = new Date(Date.parse(`${plan.startDate}T00:00:00.000Z`) + day * 24 * 60 * 60_000).toISOString().slice(0, 10)
    plan.pages.forEach((p, pageIndex) => {
      const n = campaignPostsOnDay(p.frequency ?? plan.defaultFrequency, day, times.length)
      for (let i = 0; i < n; i++) {
        const time = times[Math.floor((i * times.length) / n)]!
        raw.push({ pageId: p.pageId, pageIndex, slotAt: new Date(`${date}T${time}:00.000+07:00`).toISOString() })
      }
    })
  }
  raw.sort((a, b) => (a.slotAt === b.slotAt ? a.pageIndex - b.pageIndex : a.slotAt < b.slotAt ? -1 : 1))

  const weights = plan.topics.map((t) => Math.max(0, t.share))
  const total = weights.reduce((n, w) => n + w, 0)
  const current = weights.map(() => 0)
  const nextTopic = (): string => {
    if (!total) return plan.topics[0]?.name ?? ''
    let best = 0
    weights.forEach((w, i) => {
      current[i]! += w
      if (current[i]! > current[best]!) best = i
    })
    current[best]! -= total
    return plan.topics[best]!.name
  }
  const perPage = new Map<string, number>()
  return raw.slice(0, Math.min(limit, raw.length)).map((s) => {
    const page = plan.pages[s.pageIndex]!
    const k = perPage.get(s.pageId) ?? 0
    perPage.set(s.pageId, k + 1)
    return { pageId: s.pageId, slotAt: s.slotAt, topic: nextTopic(), withImage: campaignSlotHasImage(campaignImageRatio(page.platform, plan.imageRatio), k) }
  })
}

/* ---------- Yêu cầu lưu nháp ---------- */

const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** Ngày `YYYY-MM-DD` có thật (lịch, không múi giờ). */
const isCalendarDate = (s: string) => {
  if (!DATE_RE.test(s)) return false
  const d = new Date(`${s}T00:00:00.000Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s
}

export const CampaignTopic = z
  .object({
    name: z.string().trim().min(1, 'Nhập tên chủ đề').max(CAMPAIGN_TOPIC_NAME_MAX, `Tên chủ đề tối đa ${CAMPAIGN_TOPIC_NAME_MAX} ký tự`),
    share: z.number().int('Tỉ lệ là số nguyên').min(1, 'Tỉ lệ mỗi chủ đề từ 1%').max(100, 'Tỉ lệ tối đa 100%'),
  })
  .strict()
export type CampaignTopic = z.infer<typeof CampaignTopic>

/** Một trang đích: `frequency` `null` = theo tần suất mặc định của chiến dịch. */
export const CampaignPageInput = z.object({ pageId: z.uuid(), frequency: CampaignFrequency.nullable() }).strict()
export type CampaignPageInput = z.infer<typeof CampaignPageInput>

/**
 * Body `POST /api/v1/campaigns` (tạo nháp) và `PUT /api/v1/campaigns/:id` (thay toàn bộ cấu hình nháp). `groupId` chỉ là
 * nhãn (AD-15): chọn "Theo nhóm" thì gửi id nhóm + các trang chọn được của nhóm. `postTimes` theo giờ VN.
 * Kiểm ngày bắt đầu so với hôm nay và trang chọn được ở server (cần dữ liệu), không ở đây.
 */
export const SaveCampaignRequest = z
  .object({
    name: z.string().trim().min(1, 'Nhập tên chiến dịch').max(CAMPAIGN_NAME_MAX, `Tên tối đa ${CAMPAIGN_NAME_MAX} ký tự`),
    goal: CampaignGoal,
    startDate: z.string().refine(isCalendarDate, 'Ngày bắt đầu không hợp lệ'),
    durationDays: z.number().refine((n) => (CAMPAIGN_DURATIONS as readonly number[]).includes(n), 'Thời lượng là 7, 14 hoặc 30 ngày'),
    groupId: z.uuid().nullable(),
    defaultFrequency: CampaignFrequency,
    pages: z.array(CampaignPageInput).min(1, 'Chọn ít nhất 1 trang').max(POST_TARGETS_MAX, `Tối đa ${POST_TARGETS_MAX} trang`),
    topics: z.array(CampaignTopic).min(1, 'Thêm ít nhất 1 chủ đề').max(CAMPAIGN_TOPICS_MAX, `Tối đa ${CAMPAIGN_TOPICS_MAX} chủ đề`),
    postTimes: z
      .array(z.string().regex(HHMM_RE, 'Giờ đăng không hợp lệ'))
      .min(1, 'Thêm ít nhất 1 khung giờ')
      .max(CAMPAIGN_POST_TIMES_MAX, `Tối đa ${CAMPAIGN_POST_TIMES_MAX} khung giờ`),
    imageRatio: z.number().int('Tỉ lệ ảnh là số nguyên').min(0, 'Tỉ lệ ảnh từ 0%').max(100, 'Tỉ lệ ảnh tối đa 100%'),
    mode: CampaignMode.default('review'),
    /**
     * Story 7.7: ảnh sản phẩm (ảnh tải lên `ready` — `POST /media-assets`), tuỳ chọn, một ảnh. Thiếu = `null` (không ảnh:
     * bài có ảnh vẽ từ chữ như 6.8). PUT thay cả ô này như các ô khác.
     */
    productImageId: z.uuid('Ảnh sản phẩm không hợp lệ').nullable().default(null),
    /** Story 7.2: `updatedAt` của nháp lúc đọc (chỉ `PUT`) — khác bản hiện tại → 409 (nháp đã đổi ở tab khác). */
    baseUpdatedAt: IsoDateTime.optional(),
  })
  .strict()
  .superRefine((body, ctx) => {
    const pages = new Set<string>()
    body.pages.forEach((p, i) => {
      if (pages.has(p.pageId)) ctx.addIssue({ code: 'custom', path: ['pages', i, 'pageId'], message: 'Trang bị chọn hai lần' })
      pages.add(p.pageId)
    })
    const topics = new Set<string>()
    body.topics.forEach((t, i) => {
      const key = t.name.trim().toLowerCase()
      if (topics.has(key)) ctx.addIssue({ code: 'custom', path: ['topics', i, 'name'], message: 'Chủ đề bị trùng' })
      topics.add(key)
    })
    const sum = body.topics.reduce((n, t) => n + (Number.isFinite(t.share) ? t.share : 0), 0)
    if (body.topics.length > 0 && sum !== 100) {
      ctx.addIssue({ code: 'custom', path: ['topics'], message: `Tổng tỉ lệ chủ đề phải đúng 100% (hiện ${sum}%)` })
    }
    const times = new Set<string>()
    body.postTimes.forEach((t, i) => {
      if (times.has(t)) ctx.addIssue({ code: 'custom', path: ['postTimes', i], message: 'Khung giờ bị trùng' })
      times.add(t)
    })
  })
export type SaveCampaignRequest = z.input<typeof SaveCampaignRequest>
export type ParsedSaveCampaignRequest = z.output<typeof SaveCampaignRequest>

/* ---------- Đọc ---------- */

export const CampaignDto = z.object({
  id: z.uuid(),
  name: z.string(),
  goal: CampaignGoal,
  status: CampaignStatus,
  mode: CampaignMode,
  startDate: z.string(),
  durationDays: z.number().int(),
  groupId: z.uuid().nullable(),
  defaultFrequency: CampaignFrequency,
  /** Theo thứ tự lúc lưu. */
  pages: z.array(CampaignPageInput),
  /** Theo thứ tự lúc lưu. */
  topics: z.array(CampaignTopic),
  /** Giờ VN `HH:MM`, tăng dần. */
  postTimes: z.array(z.string()),
  imageRatio: z.number().int(),
  /** Story 7.7: ảnh sản phẩm đang dùng (`null` = không có). */
  productImage: MediaAssetDto.nullable(),
  /** Story 7.3: lúc bấm "Bắt đầu chiến dịch"; `null` khi còn nháp. */
  startedAt: IsoDateTime.nullable(),
  /** Story 7.5: lý do tạm dừng — có đúng khi `paused` (`MANUAL` = chủ shop tự dừng; còn lại do hệ thống — 7.6). */
  pauseReason: PauseReason.nullable(),
  /** Story 7.5: lúc tạm dừng; `null` khi không `paused`. */
  pausedAt: IsoDateTime.nullable(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
})
export type CampaignDto = z.infer<typeof CampaignDto>

/* ---------- Trang chọn được làm đích ---------- */

/** Lý do một trang không làm đích được: mất kết nối (xét trước) / chưa có hồ sơ thương hiệu hiệu lực. */
export const CAMPAIGN_PAGE_BLOCK_REASONS = ['PAGE_DISCONNECTED', 'CONFIG_MISSING'] as const
export const CampaignPageBlockReason = z.enum(CAMPAIGN_PAGE_BLOCK_REASONS)
export type CampaignPageBlockReason = z.infer<typeof CampaignPageBlockReason>

export const CampaignPageOption = z.object({
  pageId: z.uuid(),
  selectable: z.boolean(),
  reason: CampaignPageBlockReason.nullable(),
})
export type CampaignPageOption = z.infer<typeof CampaignPageOption>

/** `GET /api/v1/campaigns/page-options` → 200: mọi trang chưa gỡ, cùng thứ tự `GET /pages`. */
export const CampaignPageOptionsResponse = z.object({ items: z.array(CampaignPageOption) })
export type CampaignPageOptionsResponse = z.infer<typeof CampaignPageOptionsResponse>

/* ---------- Xem trước 7 bài đầu (Story 7.2) ---------- */

/**
 * Một slot chiến dịch (1 post : 1 target — AD-13). `topic` = chủ đề slot; `imagePending` = ô ảnh AI đang sinh (slot còn
 * `planned`); `errorCode` có khi AI / ảnh / hậu kiểm lỗi (`pending_approval` kèm mã — AD-15).
 */
export const CampaignSlotDto = z.object({
  id: z.uuid(),
  postId: z.uuid(),
  pageId: z.uuid(),
  slotAt: IsoDateTime,
  /** Story 7.4: giờ đăng hiện tại (lên Lịch); `null` với bài xem trước của nháp. */
  scheduledAt: IsoDateTime.nullable(),
  topic: z.string().nullable(),
  status: PostTargetStatus,
  caption: z.string(),
  aiCaption: z.boolean(),
  media: z.array(MediaAssetDto),
  imagePending: z.boolean(),
  /** Khoá lạc quan (AD-13) — body của hành động slot. */
  version: z.number().int().nonnegative(),
  errorCode: ErrorCode.nullable(),
})
export type CampaignSlotDto = z.infer<typeof CampaignSlotDto>

/** `GET /api/v1/campaigns/:id/preview` → 200, theo `slotAt` rồi thứ tự trang. `generating` = còn slot `planned`. */
export const CampaignPreviewResponse = z.object({ items: z.array(CampaignSlotDto), generating: z.boolean() })
export type CampaignPreviewResponse = z.infer<typeof CampaignPreviewResponse>

const SlotVersion = z.number().int().nonnegative()

/**
 * Body `POST /api/v1/campaigns/:id/slots/:targetId/transition` — Sửa (caption mới), Tạo lại (về `planned` rồi AI sinh
 * lại), Xoá (`cancelled`). Mọi hành động mang `version` (AD-13).
 * Story 7.4 (chỉ chiến dịch đã bắt đầu): Duyệt (`pending_approval → scheduled` tại `scheduledAt`, thiếu = giờ hiện tại của
 * bài; giờ đã qua hoặc còn dưới `CAMPAIGN_SLOT_MIN_LEAD_MS` → 422 `SCHEDULE_IN_PAST`, FE hỏi giờ mới), Từ chối
 * (`cancelled USER_REJECTED`). Tạo lại `immediate` = sinh lại ngay, không chờ lượt cron kế.
 */
export const CampaignSlotActionRequest = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('edit'),
      version: SlotVersion,
      caption: z.string().trim().min(1, 'Nhập nội dung bài').max(POST_CAPTION_MAX, `Nội dung tối đa ${POST_CAPTION_MAX} ký tự`),
    })
    .strict(),
  z.object({ action: z.literal('regenerate'), version: SlotVersion, immediate: z.boolean().optional() }).strict(),
  z.object({ action: z.literal('cancel'), version: SlotVersion }).strict(),
  z.object({ action: z.literal('approve'), version: SlotVersion, scheduledAt: IsoDateTime.optional() }).strict(),
  z.object({ action: z.literal('reject'), version: SlotVersion }).strict(),
])
export type CampaignSlotActionRequest = z.input<typeof CampaignSlotActionRequest>
export type ParsedCampaignSlotActionRequest = z.output<typeof CampaignSlotActionRequest>

/* ---------- Bắt đầu chiến dịch + danh sách (Story 7.3) ---------- */

/**
 * Bài chiến dịch phải còn ít nhất chừng này tới giờ đăng mới lên lịch được (bắt đầu ở chế độ "Tự đăng", duyệt bài —
 * AD-15: "giờ đã qua hoặc còn dưới 2 phút → `SCHEDULE_IN_PAST`"). Slot kế hoạch đã qua mốc này lúc bắt đầu thì không tạo.
 */
export const CAMPAIGN_SLOT_MIN_LEAD_MS = 2 * 60_000
/** Số ngày của `trend` (tương tác tăng mỗi ngày VN, cũ → hôm nay). */
export const CAMPAIGN_TREND_DAYS = 7

/**
 * Body `POST /api/v1/campaigns/:id/start`. `baseUpdatedAt` = `updatedAt` của nháp wizard đang xem — khác bản hiện tại →
 * 409 (nháp đã đổi ở tab khác). Chiến dịch đã bắt đầu thì bỏ qua (bấm hai lần → `alreadyStarted`).
 */
export const StartCampaignRequest = z.object({ baseUpdatedAt: IsoDateTime.optional() }).strict()
export type StartCampaignRequest = z.infer<typeof StartCampaignRequest>

/**
 * Chiến dịch kèm tiến độ dẫn xuất (AD-18, ghép ở `app/read-models/campaigns.ts`) cho thẻ ở `/chien-dich` và Tổng quan:
 * - `postsTotal`: nháp = số bài theo kế hoạch; đã bắt đầu = slot chưa huỷ. `postsDone` = đã đăng.
 * - `postsPending`: bài chờ duyệt (đã bắt đầu). `nextPost`: giờ đăng dự kiến sớm nhất còn tới (ISO), `null` khi không có.
 * - `trend`: `CAMPAIGN_TREND_DAYS` số — tương tác TĂNG mỗi ngày VN của bài đã đăng (cũ → hôm nay; Story 8.5 — từ snapshot
 *   `post_metrics`, giảm tính 0). `engagement7d`: tổng `trend` / tổng 7 ngày liền trước; `current = null` khi chưa bài nào có
 *   số liệu, `previous = null` khi chiến dịch chưa chạy đủ 14 ngày (nháp → cả hai `null`).
 * - `daysDone`: số ngày chiến dịch đã qua (0 khi nháp / ngày đầu; `done` = `durationDays`).
 */
export const CampaignSummaryDto = CampaignDto.extend({
  postsTotal: z.number().int().nonnegative(),
  postsDone: z.number().int().nonnegative(),
  postsPending: z.number().int().nonnegative(),
  nextPost: IsoDateTime.nullable(),
  trend: z.array(z.number().int().nonnegative()).length(CAMPAIGN_TREND_DAYS),
  engagement7d: MetricComparison,
  daysDone: z.number().int().nonnegative(),
})
export type CampaignSummaryDto = z.infer<typeof CampaignSummaryDto>

/** `POST /api/v1/campaigns/:id/start` → 200. `alreadyStarted` = chiến dịch đã rời nháp từ trước (không đổi gì). */
export const StartCampaignResponse = z.object({ campaign: CampaignSummaryDto, alreadyStarted: z.boolean() })
export type StartCampaignResponse = z.infer<typeof StartCampaignResponse>

/** Query `GET /api/v1/campaigns`: chiến dịch thuộc phạm vi khi `campaign_pages` giao tập trang của phạm vi (AD-18). */
export const CampaignListQuery = z.object({ scope: ScopeParam.optional() }).strict()
export type CampaignListQuery = z.input<typeof CampaignListQuery>

/** `GET /api/v1/campaigns` → 200, mọi trạng thái (gồm nháp), mới tạo trước. */
export const CampaignListResponse = z.object({ items: z.array(CampaignSummaryDto) })
export type CampaignListResponse = z.infer<typeof CampaignListResponse>

/* ---------- Sinh cuốn chiếu + hàng đợi "Bài chờ duyệt" (Story 7.4) ---------- */

/** Cron sinh nội dung cho slot `planned` có giờ đăng trong khoảng này tính từ bây giờ (AD-15: 3 ngày [ASSUMPTION]). */
export const CAMPAIGN_GENERATE_WINDOW_MS = 3 * 24 * 60 * 60_000

/** `POST /api/v1/campaigns/:id/slots/:targetId/transition` → 200: slot sau hành động (FE vá cache). */
export const CampaignSlotActionResponse = z.object({ slot: CampaignSlotDto })
export type CampaignSlotActionResponse = z.infer<typeof CampaignSlotActionResponse>

/** Số bài tối đa của hàng đợi "Bài chờ duyệt" mỗi lần đọc. */
export const PENDING_SLOTS_MAX = 200

/** Một bài chờ duyệt của chiến dịch đã bắt đầu (`pending_approval`, không `held`) kèm tên / chế độ chiến dịch. */
export const PendingSlotDto = CampaignSlotDto.extend({ campaignId: z.uuid(), campaignName: z.string(), campaignMode: CampaignMode })
export type PendingSlotDto = z.infer<typeof PendingSlotDto>

/** Query `GET /api/v1/campaigns/pending-slots`: bài thuộc phạm vi khi trang của bài thuộc tập trang của phạm vi (AD-18). */
export const PendingSlotsQuery = z.object({ scope: ScopeParam.optional() }).strict()
export type PendingSlotsQuery = z.input<typeof PendingSlotsQuery>

/** → 200, theo giờ đăng tăng dần (bài quá giờ trước). `truncated` = còn bài ngoài `PENDING_SLOTS_MAX`. */
export const PendingSlotsResponse = z.object({ items: z.array(PendingSlotDto), truncated: z.boolean() })
export type PendingSlotsResponse = z.infer<typeof PendingSlotsResponse>

/* ---------- Tạm dừng, tiếp tục, xoá (Story 7.5) ---------- */

/** Body `POST /api/v1/campaigns/:id/pause` và `/resume` (không tham số — bấm là chạy, không xác nhận). */
export const CampaignActionRequest = z.object({}).strict()
export type CampaignActionRequest = z.infer<typeof CampaignActionRequest>

/**
 * `POST /api/v1/campaigns/:id/pause|resume` → 200. `changed` = có đổi trạng thái (bấm lại khi đã dừng / đã chạy →
 * `false`, không đổi gì). `missed` = số bài vừa huỷ `MISSED_WHILE_PAUSED` khi tiếp tục (giờ đăng đã qua trong lúc dừng
 * — không đăng dồn); luôn 0 với tạm dừng. Tiếp tục khi lý do tự dừng vẫn còn → 409 với mã = lý do
 * (`PAGE_DISCONNECTED` / `CONFIG_MISSING` / `AI_BUDGET_EXCEEDED`).
 */
export const CampaignActionResponse = z.object({
  campaign: CampaignSummaryDto,
  changed: z.boolean(),
  missed: z.number().int().nonnegative(),
})
export type CampaignActionResponse = z.infer<typeof CampaignActionResponse>

/**
 * `DELETE /api/v1/campaigns/:id` → 200 (mọi trạng thái, gồm nháp). `cancelled` = bài chưa đăng vừa huỷ
 * (`CAMPAIGN_DELETED`); `kept` = bài đã đăng hoặc đang đăng giữ nguyên trên trang.
 */
export const DeleteCampaignResponse = z.object({ cancelled: z.number().int().nonnegative(), kept: z.number().int().nonnegative() })
export type DeleteCampaignResponse = z.infer<typeof DeleteCampaignResponse>
