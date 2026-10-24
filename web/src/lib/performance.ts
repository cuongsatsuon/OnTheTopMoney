// Màn Hiệu suất (Story 8.2) phía web: `GET /performance?scope=&range=` (server tổng hợp từ số liệu đã thu — không gọi
// Meta). Phạm vi chỉ có id kho mẫu (`serverScope` → `null`) → dữ liệu rỗng, không hỏi server. Phần thuần (so sánh kỳ
// trước, tỉ lệ tương tác, sắp xếp bảng trang có `null`, câu trạng thái) tách khỏi hook để test được (performance.test.ts).
// `null` = không có số liệu (nền tảng không cung cấp / chưa thu) → hiện "—", khác 0.
import {
  PerformanceResponse,
  type MetricComparison,
  type PagePerformanceDto,
  type PageMetricsState,
  type PerformanceRange,
  type PerformanceSeriesPoint,
  type Scope,
} from '@ottm/shared'
import { useQuery } from '@tanstack/react-query'
import { apiFetch } from './api'
import { serverScope } from './inbox'

export const PERFORMANCE_RANGE_OPTIONS: { id: PerformanceRange; label: string }[] = [
  { id: '7d', label: '7 ngày' },
  { id: '30d', label: '30 ngày' },
  { id: '90d', label: '90 ngày' },
]

/** EXPERIENCE › State "Chưa đủ dữ liệu": trang kết nối <7 ngày. */
export const INSUFFICIENT_DATA_TEXT = 'Cần thêm vài ngày dữ liệu'

export const performanceKey = (scope: string | null, range: PerformanceRange) => ['performance', scope, range] as const

const NO_KPI: MetricComparison = { current: null, previous: null }

/** Phạm vi không có trang thật: rỗng như server trả cho nhóm không có trang (không ngày nào). */
export function emptyPerformance(range: PerformanceRange): PerformanceResponse {
  return {
    range,
    from: '',
    to: '',
    insufficientData: false,
    platforms: [],
    kpis: { views: NO_KPI, reach: NO_KPI, engagement: NO_KPI, followersDelta: NO_KPI, engagementRate: NO_KPI },
    series: [],
    pages: [],
    topPosts: [],
  }
}

export function usePerformance(scope: Scope, range: PerformanceRange) {
  const param = serverScope(scope)
  return useQuery({
    queryKey: performanceKey(param, range),
    queryFn: ({ signal }) => {
      if (param === null) return Promise.resolve(emptyPerformance(range))
      return apiFetch(`/performance?${new URLSearchParams({ scope: param, range })}`, { schema: PerformanceResponse, signal })
    },
  })
}

/* ---------- Phần thuần ---------- */

/** % thay đổi so với kỳ trước (1 chữ số thập phân); chỉ khi cả hai là số và kỳ trước > 0. */
export function deltaPct(m: MetricComparison): number | undefined {
  if (m.current === null || m.previous === null || m.previous <= 0) return undefined
  return Math.round(((m.current - m.previous) / m.previous) * 1000) / 10
}

/**
 * Tỉ lệ tương tác (%) của một dòng = tương tác / tiếp cận; thiếu một trong hai hoặc tiếp cận 0 → `null`. KPI cả phạm vi
 * dùng `kpis.engagementRate` của server (chia hai tổng ở đây thổi phồng khi phạm vi có Threads — không có reach).
 */
export function engagementRate(engagement: number | null, reach: number | null): number | null {
  if (engagement === null || reach === null || reach <= 0) return null
  return (engagement / reach) * 100
}

export const formatMetric = (v: number | null): string => (v === null ? '—' : v.toLocaleString('vi-VN'))
export const formatRate = (v: number | null): string => (v === null ? '—' : `${v.toLocaleString('vi-VN', { maximumFractionDigits: 1 })}%`)

/** `YYYY-MM-DD` → `dd/MM` (nhãn trục ngày). */
export function formatDay(day: string): string {
  const [, m, d] = day.split('-')
  return d && m ? `${d}/${m}` : day
}

/** Biểu đồ có ít nhất một giá trị (kỳ này hoặc kỳ trước). */
export function hasSeriesData(series: readonly PerformanceSeriesPoint[]): boolean {
  return series.some((p) => p.facebook !== null || p.instagram !== null || p.threads !== null || p.previous !== null)
}

export type PageSortKey = 'views' | 'reach' | 'engagement' | 'rate' | 'followersDelta' | 'posts'

export function pageSortValue(row: PagePerformanceDto, key: PageSortKey): number | null {
  return key === 'rate' ? engagementRate(row.engagement, row.reach) : row[key]
}

/** Sắp xếp bảng trang; `null` luôn ở cuối (cả hai chiều), bằng nhau giữ thứ tự server. */
export function sortPageRows(rows: readonly PagePerformanceDto[], key: PageSortKey, asc: boolean): PagePerformanceDto[] {
  return rows
    .map((row, i) => ({ row, i, v: pageSortValue(row, key) }))
    .sort((a, b) => {
      if (a.v === null || b.v === null) return a.v === b.v ? a.i - b.i : a.v === null ? 1 : -1
      return (asc ? a.v - b.v : b.v - a.v) || a.i - b.i
    })
    .map((x) => x.row)
}

/** Câu trạng thái thu số liệu của một trang (dòng bảng); `ok` → không có câu. */
export function metricsStateText(state: PageMetricsState): string | null {
  switch (state) {
    case 'permissions_missing':
      return 'Thiếu quyền thống kê'
    case 'failed':
      return 'Chưa lấy được số liệu'
    case 'pending':
      return 'Đang chờ số liệu đầu tiên'
    case 'ok':
      return null
  }
}
