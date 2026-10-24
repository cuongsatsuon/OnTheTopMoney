// Module `analytics` (AD-1, AD-17 — Story 8.1): sở hữu `post_metrics`, `page_daily_metrics`, `metric_sync_states`. Public API
// chỉ export từ file này.
// Gọi `pages` (base), `content` (bài đã đăng có id nền tảng), `connections` (token, quyền đã cấp, mất kết nối) và
// `adapters/meta` (hạng `background`) theo bảng mũi tên AD-1. Không module nào gọi `analytics`; màn Hiệu suất / Tổng quan
// (Story 8.2+) đọc qua hàm export ở đây, không bao giờ gọi Meta theo request.
export const MODULE = 'analytics'

// Bảng ánh xạ metric Meta → chỉ số chuẩn (chỗ duy nhất biết tên metric gốc).
export {
  PAGE_METRIC_MAP,
  POST_METRIC_MAP,
  applyRule,
  insightDayOf,
  parseInsightDaily,
  parseInsightTotals,
  referencedMetricNames,
  standardize,
  type MetricRule,
  type PageMetricSpec,
  type PostMetricSpec,
  type RawMetrics,
} from './metric-map.ts'
// Job thu một trang: `analytics.collect_posts` (bài 30 ngày) / `analytics.collect_page` (trang theo ngày).
export {
  METRICS_DEFER_MAX_MS,
  MetricsRetryableError,
  PAGE_METRICS_LOOKBACK_DAYS,
  POST_METRICS_WINDOW_DAYS,
  POST_TRANSIENT_STOP,
  collectPageMetrics,
  collectPostMetrics,
  handleCollectPageJob,
  handleCollectPostsJob,
  parseCollectJobData,
  vnDateOf,
  type AnalyticsDeps,
  type CollectJobData,
  type CollectOutcome,
} from './collect.ts'
// Cron rải job theo trang.
export { runPageMetricsCron, runPostMetricsCron, type MetricsCronDeps } from './cron.ts'
// Màn Hiệu suất (Story 8.2): tổng hợp chỉ đọc theo phạm vi + khoảng.
export { pageMetricsState, performanceOverview, performanceWindow, type PerformanceWindow } from './performance.ts'
