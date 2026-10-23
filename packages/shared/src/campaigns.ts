// Chiến dịch nuôi page (Story 7.1, AD-15, module `campaigns`). Wizard bước 1–3 lưu cấu hình ở `draft`: mục tiêu, thời
// lượng, trang đích + tần suất, chủ đề + tỉ lệ, tỉ lệ ảnh AI, khung giờ đăng, chế độ duyệt. Schema ở đây là nguồn DUY
// NHẤT: FE kiểm sớm (báo dưới ô), server kiểm lại khi lưu (tổng tỉ lệ = 100% — AD-15 "kiểm phía server").
// Helper thuần (`campaignPostsOnDay`, `campaignImageRatio`) dùng cho tóm tắt ở wizard và cho việc tạo slot (7.2/7.3).
import { z } from 'zod'
import { POST_TARGETS_MAX } from './content.ts'
import { CampaignFrequency, CampaignGoal, CampaignMode, CampaignStatus, type Platform } from './enums.ts'

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
