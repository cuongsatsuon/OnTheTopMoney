// Số liệu Hiệu suất (AD-17 — Story 8.1): bảng chỉ số chuẩn dùng chung server + web. Metric gốc của từng nền tảng
// ánh xạ sang đây ở MỘT chỗ (`server/src/modules/analytics/metric-map.ts`). Nền tảng không cung cấp → `null`, không 0.
import { z } from 'zod'
import type { Platform } from './enums.ts'

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
