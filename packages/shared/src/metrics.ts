// Số liệu Hiệu suất (AD-17 — Story 8.1): bảng chỉ số chuẩn dùng chung server + web. Metric gốc của từng nền tảng
// ánh xạ sang đây ở MỘT chỗ (`server/src/modules/analytics/metric-map.ts`). Nền tảng không cung cấp → `null`, không 0.
// Story 8.2: hợp đồng màn Hiệu suất (`GET /api/v1/performance`) ở cuối file.
import { z } from 'zod'
import { Platform, PostSource } from './enums.ts'
import { ScopeParam } from './scope.ts'

/**
 * - `views`: lượt xem (metric `*media_view*` / `views`; không dùng `*impressions*` đã bị Meta bỏ từ v26);
 * - `reach`: số tài khoản khác nhau đã xem;
 * - `engagement`: reactions + comments + shares + saves, theo những gì nền tảng có;
 * - `followers_delta`: người theo dõi mới trừ bỏ theo dõi trong ngày (chỉ số trang).
 */
export const STANDARD_METRICS = ['views', 'reach', 'engagement', 'followers_delta'] as const
export const StandardMetric = z.enum(STANDARD_METRICS)
export type StandardMetric = z.infer<typeof StandardMetric>

/** Quyền Meta cần để kéo insight của trang (đọc từ quyền đã cấp theo trang). Thiếu → không thu, ghi `permissions_missing`. */
export const INSIGHTS_SCOPES: Readonly<Record<Platform, readonly string[]>> = {
  facebook: ['read_insights'],
  instagram: ['instagram_manage_insights'],
  threads: ['threads_manage_insights'],
}

/** Hai lượt thu: số liệu bài (mỗi 6 giờ) và số liệu trang theo ngày (hằng ngày). */
export const METRIC_SYNC_KINDS = ['posts', 'page'] as const
export const MetricSyncKind = z.enum(METRIC_SYNC_KINDS)
export type MetricSyncKind = z.infer<typeof MetricSyncKind>

/**
 * Kết quả lượt thu gần nhất của một trang:
 * - `ok`: chạy hết (có thể bỏ vài bài lỗi riêng);
 * - `permissions_missing`: chưa cấp quyền insight — không gọi Meta (kèm danh sách quyền thiếu);
 * - `permission_denied`: Meta từ chối quyền khi gọi (trang vẫn kết nối);
 * - `disconnected`: token hỏng giữa chừng → trang đã bị đánh dấu mất kết nối;
 * - `failed`: Meta lỗi hết lượt thử.
 */
export const METRIC_SYNC_STATUSES = ['ok', 'permissions_missing', 'permission_denied', 'disconnected', 'failed'] as const
export const MetricSyncStatus = z.enum(METRIC_SYNC_STATUSES)
export type MetricSyncStatus = z.infer<typeof MetricSyncStatus>

/* ---------- Màn Hiệu suất (Story 8.2, AD-17, AD-18) ---------- */

const IsoDateTime = z.iso.datetime({ offset: false })
/** Ngày VN `YYYY-MM-DD`. */
const VnDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
/** Số liệu tổng hợp: `null` = không có giá trị nào (nền tảng không cung cấp / chưa thu), khác 0. */
const MetricValue = z.number().nullable()

/** Khoảng xem: N ngày VN trọn vẹn kết thúc hôm qua; kỳ trước = N ngày liền trước. */
export const PERFORMANCE_RANGES = ['7d', '30d', '90d'] as const
export const PerformanceRange = z.enum(PERFORMANCE_RANGES)
export type PerformanceRange = z.infer<typeof PerformanceRange>
export const PERFORMANCE_RANGE_DAYS: Readonly<Record<PerformanceRange, number>> = { '7d': 7, '30d': 30, '90d': 90 }

/** Trang kết nối chưa đủ chừng này ngày → `insufficientData` ("Cần thêm vài ngày dữ liệu"). */
export const INSUFFICIENT_DATA_DAYS = 7
/** Số bài tốt nhất trả về. */
export const TOP_POSTS_MAX = 5

/**
 * Trạng thái thu số liệu của một trang (gộp hai lượt `posts` / `page` của `metric_sync_states`):
 * - `permissions_missing`: thiếu quyền insight hoặc Meta từ chối quyền → "Thiếu quyền thống kê — Kết nối lại";
 * - `failed`: lượt gần nhất lỗi / token hỏng giữa chừng;
 * - `pending`: chưa có lượt thu nào;
 * - `ok`: lượt gần nhất chạy hết.
 */
export const PAGE_METRICS_STATES = ['ok', 'pending', 'permissions_missing', 'failed'] as const
export const PageMetricsState = z.enum(PAGE_METRICS_STATES)
export type PageMetricsState = z.infer<typeof PageMetricsState>

/** `GET /api/v1/performance?scope=&range=` — phạm vi mặc định `all`, khoảng mặc định 30 ngày. */
export const PerformanceQuery = z.object({ scope: ScopeParam.optional(), range: PerformanceRange.default('30d') }).strict()
export type PerformanceQuery = z.input<typeof PerformanceQuery>

/** Một KPI: kỳ đang xem và kỳ trước liền kề (FE tính % thay đổi). */
export const MetricComparison = z.object({ current: MetricValue, previous: MetricValue })
export type MetricComparison = z.infer<typeof MetricComparison>

/** Một ngày của biểu đồ: tương tác theo nền tảng + tổng tương tác ngày cùng vị trí ở kỳ trước. */
export const PerformanceSeriesPoint = z.object({
  date: VnDate,
  facebook: MetricValue,
  instagram: MetricValue,
  threads: MetricValue,
  previous: MetricValue,
})
export type PerformanceSeriesPoint = z.infer<typeof PerformanceSeriesPoint>

/** Một dòng bảng "So sánh từng trang" (tổng của kỳ đang xem). */
export const PagePerformanceDto = z.object({
  pageId: z.uuid(),
  views: MetricValue,
  reach: MetricValue,
  engagement: MetricValue,
  followersDelta: MetricValue,
  /** Bài đã đăng trong kỳ. */
  posts: z.number().int().nonnegative(),
  /** Tương tác theo ngày của kỳ (sparkline), cùng độ dài `series`. */
  trend: z.array(MetricValue),
  insufficientData: z.boolean(),
  metricsState: PageMetricsState,
  /** Quyền insight còn thiếu (có khi `permissions_missing` do chưa cấp; Meta từ chối thì có thể rỗng). */
  missingScopes: z.array(z.string()),
})
export type PagePerformanceDto = z.infer<typeof PagePerformanceDto>

/**
 * Một bài tốt nhất — mỗi target (bài trên một trang) một dòng; số liệu = snapshot mới nhất (tổng trọn đời). `ai` cùng
 * luật Lịch nội dung (slot chiến dịch / caption AI / ảnh AI). `title` = đầu caption (trống → `null`).
 */
export const TopPostDto = z.object({
  targetId: z.uuid(),
  postId: z.uuid(),
  pageId: z.uuid(),
  publishedAt: IsoDateTime,
  title: z.string().nullable(),
  permalink: z.string().nullable(),
  thumbnailUrl: z.string().nullable(),
  ai: z.boolean(),
  source: PostSource,
  campaignId: z.uuid().nullable(),
  views: MetricValue,
  reach: MetricValue,
  engagement: MetricValue,
})
export type TopPostDto = z.infer<typeof TopPostDto>

/**
 * `GET /api/v1/performance` → 200. Chỉ đọc bảng nội bộ của `analytics` (không gọi Meta). Nhóm gộp theo thành viên hiện
 * tại. `insufficientData` = phạm vi có trang và mọi trang đều kết nối chưa đủ `INSUFFICIENT_DATA_DAYS` ngày.
 */
export const PerformanceResponse = z.object({
  range: PerformanceRange,
  /** Ngày đầu / cuối của kỳ (ngày VN, gồm cả hai đầu). */
  from: VnDate,
  to: VnDate,
  insufficientData: z.boolean(),
  /** Nền tảng có trang trong phạm vi (thứ tự `PLATFORMS`). */
  platforms: z.array(Platform),
  /**
   * `previous` = `null` khi kỳ trước chưa đủ dữ liệu (có trang bắt đầu có số liệu sau ngày đầu kỳ trước). `engagementRate`
   * (%) = tương tác / tiếp cận, chỉ cộng ngày có cả hai số (Threads không có reach).
   */
  kpis: z.object({
    views: MetricComparison,
    reach: MetricComparison,
    engagement: MetricComparison,
    followersDelta: MetricComparison,
    engagementRate: MetricComparison,
  }),
  series: z.array(PerformanceSeriesPoint),
  pages: z.array(PagePerformanceDto),
  topPosts: z.array(TopPostDto),
})
export type PerformanceResponse = z.infer<typeof PerformanceResponse>
