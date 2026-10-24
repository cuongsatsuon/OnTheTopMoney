// Tổng quan `/` (Story 8.5, AD-18, AD-3): hai DTO ghép ở `server/src/app/read-models/overview.ts`.
// - `GET /api/v1/overview?scope=` — việc cần xử lý + bài sắp đăng + chiến dịch đang chạy. Web làm cũ theo hint realtime
//   (tin mới, bài lỗi, chiến dịch tạm dừng, trang, webhook, hạn mức AI) và refetch ngay.
// - `GET /api/v1/overview/metrics?scope=&range=` — số liệu chính (cắt từ màn Hiệu suất, số cron) — không refetch theo
//   realtime để tin nhắn tới liên tục không kéo theo phần tổng hợp nặng.
import { z } from 'zod'
import { AiBudgetState } from './ai.ts'
import { CampaignSummaryDto } from './campaigns.ts'
import { PageDto } from './connections.ts'
import { ErrorCode } from './errors.ts'
import { Platform, PostSource, PostTargetStatus, WebhookProduct } from './enums.ts'
import { ConversationDto } from './inbox.ts'
import { MetricComparison, PerformanceRange, PerformanceSeriesPoint } from './metrics.ts'
import { ScopeParam } from './scope.ts'

const IsoDateTime = z.iso.datetime({ offset: false })
const Count = z.number().int().nonnegative()
/** Ngày VN `YYYY-MM-DD`; chuỗi rỗng khi phạm vi không có trang (như Hiệu suất). */
const VnDate = z.string().regex(/^(\d{4}-\d{2}-\d{2})?$/)

/** Số mục tối đa mỗi danh sách của Tổng quan (hội thoại chờ, bài lỗi, bài sắp đăng). */
export const OVERVIEW_LIST_MAX = 5

/** `GET /api/v1/overview?scope=` — phạm vi mặc định `all`. */
export const OverviewQuery = z.object({ scope: ScopeParam.optional() }).strict()
export type OverviewQuery = z.input<typeof OverviewQuery>

/** `GET /api/v1/overview/metrics?scope=&range=` — khoảng mặc định 30 ngày (như Hiệu suất). */
export const OverviewMetricsQuery = z.object({ scope: ScopeParam.optional(), range: PerformanceRange.default('30d') }).strict()
export type OverviewMetricsQuery = z.input<typeof OverviewMetricsQuery>

/** Một target của bài trong mục (cùng trạng thái); `version` = khoá lạc quan để "Đăng lại" gửi thẳng (AD-13). */
export const OverviewPostTarget = z.object({
  id: z.uuid(),
  pageId: z.uuid(),
  version: z.number().int().nonnegative(),
  errorCode: ErrorCode.nullable(),
})
export type OverviewPostTarget = z.infer<typeof OverviewPostTarget>

/**
 * Một bài ở "Bài đăng lỗi" / "Bài sắp đăng" — target cùng bài cùng trạng thái gom lại (bài sắp đăng: cùng giờ). Trường hiển
 * thị theo luật Lịch nội dung: `ai` (UX-DR10), `title` = đầu caption (trống → `null`), `topic` cho slot chưa viết.
 */
export const OverviewPostDto = z.object({
  postId: z.uuid(),
  status: PostTargetStatus,
  /** Bài lỗi: giờ đăng mới nhất của các target lỗi; bài sắp đăng: giờ đăng. */
  scheduledAt: IsoDateTime,
  targets: z.array(OverviewPostTarget).min(1),
  title: z.string().nullable(),
  topic: z.string().nullable(),
  thumbnailUrl: z.url().nullable(),
  ai: z.boolean(),
  source: PostSource,
  campaignId: z.uuid().nullable(),
})
export type OverviewPostDto = z.infer<typeof OverviewPostDto>

/**
 * `GET /api/v1/overview` → 200:
 * - `needsHuman`: đúng điều kiện tab "Cần xử lý" (`count`) + tối đa `OVERVIEW_LIST_MAX` hội thoại chờ lâu nhất trước;
 * - `failedPosts`: `count` = số bài có target `failed` trong phạm vi; `items` mới nhất trước;
 * - `pendingApproval`: bài chiến dịch chờ duyệt (cùng tập hàng đợi "Bài chờ duyệt");
 * - `pageAlerts`: trang trong phạm vi `disconnected` (trước) / `expiring`;
 * - `webhookStalled`: sản phẩm ngừng nhận tin mà phạm vi có trang thuộc sản phẩm đó;
 * - `aiBudget`: hạn mức tháng này (không theo phạm vi);
 * - `upcoming`: bài sắp đăng (đã lên lịch / chờ duyệt, chưa tới giờ, không bị giữ);
 * - `campaigns`: chiến dịch `running` / `paused` theo phạm vi (tiến độ + lý do tạm dừng).
 */
export const OverviewResponse = z.object({
  needsHuman: z.object({ count: Count, items: z.array(ConversationDto) }),
  failedPosts: z.object({ count: Count, items: z.array(OverviewPostDto) }),
  pendingApproval: Count,
  pageAlerts: z.array(PageDto),
  webhookStalled: z.array(WebhookProduct),
  aiBudget: z.object({ percent: Count, state: AiBudgetState, spentVnd: Count, limitVnd: Count }),
  upcoming: z.array(OverviewPostDto),
  campaigns: z.array(CampaignSummaryDto),
})
export type OverviewResponse = z.infer<typeof OverviewResponse>

/**
 * `GET /api/v1/overview/metrics` → 200 — số liệu chính, cùng nguồn và kỳ với `GET /performance` (N ngày VN kết thúc hôm
 * qua): 4 KPI + kỳ trước, tương tác theo nền tảng, tin khách / tin AI trả lời ("AI đã trả lời X%").
 */
export const OverviewMetricsResponse = z.object({
  range: PerformanceRange,
  from: VnDate,
  to: VnDate,
  insufficientData: z.boolean(),
  platforms: z.array(Platform),
  kpis: z.object({
    reach: MetricComparison,
    engagement: MetricComparison,
    messages: MetricComparison,
    followersDelta: MetricComparison,
  }),
  series: z.array(PerformanceSeriesPoint),
  customerMessages: Count,
  aiAnswered: Count,
})
export type OverviewMetricsResponse = z.infer<typeof OverviewMetricsResponse>
