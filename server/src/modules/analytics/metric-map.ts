// Bảng ánh xạ metric Meta → chỉ số chuẩn (AD-17 — Story 8.1): chỗ DUY NHẤT biết tên metric gốc và đường gọi insight
// của từng nền tảng. Đổi metric (Meta bỏ / đổi tên) chỉ sửa file này.
// - Lượt xem dùng `*media_view*` / `views`; CẤM metric `*impressions*` (Meta bỏ từ v26 — test kiểm).
// - Mỗi chỉ số chuẩn = tổng các metric gốc trong `sum` trừ tổng trong `minus`. Luật `null` = nền tảng không có chỉ số đó.
//   Không metric gốc nào được tham chiếu có trong phản hồi → `null` (không phải 0); có ít nhất một → cộng những cái có
//   (vd FB bỏ trường `shares` khi bài chưa ai chia sẻ).
// - Metric gốc là số hữu hạn ≥ 0; giá trị khác bị bỏ.
// Tên metric theo tài liệu Graph v26 / Threads v1.0 lúc viết — kiểm lại bằng Meta thật (deferred-work.md).
import type { Platform, StandardMetric } from '@ottm/shared'
import type { MetaParams } from '../../adapters/meta/index.ts'

/** Metric gốc đã đọc: tên metric (hoặc `<metric>.<chiều>` với breakdown) → số. */
export type RawMetrics = Record<string, number>

export interface MetricRule {
  sum: readonly string[]
  minus?: readonly string[]
}

export type PostStandardMetric = Exclude<StandardMetric, 'followers_delta'>

export interface PostMetricSpec {
  /** Lời gọi cho một bài (`platformPostId` dạng chuẩn AD-6). */
  request(platformPostId: string): { path: string; params: MetaParams }
  /** Phản hồi → metric gốc (không ném với dữ liệu lạ). */
  parse(data: unknown): RawMetrics
  rules: Readonly<Record<PostStandardMetric, MetricRule | null>>
}

export interface PageMetricRequest {
  /** Đường gọi theo id tài khoản nền tảng (Page / IG user / Threads user). */
  path(accountId: string): string
  params: MetaParams
  /** Lời gọi phụ: Meta từ chối (REJECTED / PERMISSION_DENIED) thì chỉ bỏ phần này — chỉ số dùng nó thành `null`. */
  optional?: true
}

export interface PageMetricSpec {
  /**
   * `range`: một lời gọi cho cả khoảng ngày, Meta trả mỗi ngày một giá trị (`period=day`, `end_time`) — FB.
   * `per_day`: mỗi ngày VN một cửa sổ `since/until`, giá trị là tổng của cửa sổ — IG (`metric_type=total_value`), Threads.
   */
  mode: 'range' | 'per_day'
  requests: readonly PageMetricRequest[]
  rules: Readonly<Record<StandardMetric, MetricRule | null>>
}

// ---------------------------------------------------------------------------------------------------------
// Đọc phản hồi insight
// ---------------------------------------------------------------------------------------------------------

const metricNumber = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined)
const obj = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])

function add(raw: RawMetrics, key: string, value: number | undefined): void {
  if (value !== undefined) raw[key] = (raw[key] ?? 0) + value
}

/** Một mục `data[]` của insight → `(tên, end_time | null, số)`; breakdown → tên `<metric>.<chiều>`. */
function* insightValues(item: unknown): Generator<{ name: string; endTime: string | null; value: number }> {
  const it = obj(item)
  const name = it?.name
  if (typeof name !== 'string' || name === '') return
  const total = obj(it!.total_value)
  if (total) {
    const breakdowns = arr(total.breakdowns)
    if (breakdowns.length > 0) {
      for (const b of breakdowns) {
        for (const r of arr(obj(b)?.results)) {
          const row = obj(r)
          const dims = arr(row?.dimension_values).filter((d): d is string => typeof d === 'string')
          const value = metricNumber(row?.value)
          if (dims.length > 0 && value !== undefined) yield { name: `${name}.${dims.join('.')}`, endTime: null, value }
        }
      }
      return
    }
    const value = metricNumber(total.value)
    if (value !== undefined) yield { name, endTime: null, value }
    return
  }
  for (const v of arr(it!.values)) {
    const row = obj(v)
    const value = metricNumber(row?.value)
    if (value !== undefined) yield { name, endTime: typeof row?.end_time === 'string' ? row.end_time : null, value }
  }
}

/** `{data: [...]}` của insight → metric gốc, cộng mọi giá trị (trọn đời, hoặc một cửa sổ ngày). */
export function parseInsightTotals(data: unknown): RawMetrics {
  const raw: RawMetrics = {}
  for (const item of arr(obj(data)?.data)) for (const v of insightValues(item)) add(raw, v.name, v.value)
  return raw
}

const DAY_MS = 86_400_000

/**
 * `end_time` của insight `period=day` (vd `2026-10-23T07:00:00+0000`) → ngày của giá trị (`YYYY-MM-DD`): giá trị phủ 24 giờ
 * kết thúc ở `end_time`, nên ngày = `end_time` − 1 ngày (lịch ngày của Meta) [ASSUMPTION].
 */
export function insightDayOf(endTime: string): string | null {
  const at = Date.parse(endTime.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'))
  return Number.isNaN(at) ? null : new Date(at - DAY_MS).toISOString().slice(0, 10)
}

/** `{data: [...]}` của insight `period=day` nhiều ngày → metric gốc theo ngày. Giá trị không có `end_time` bị bỏ. */
export function parseInsightDaily(data: unknown): Map<string, RawMetrics> {
  const byDay = new Map<string, RawMetrics>()
  for (const item of arr(obj(data)?.data)) {
    for (const v of insightValues(item)) {
      const day = v.endTime ? insightDayOf(v.endTime) : null
      if (!day) continue
      let raw = byDay.get(day)
      if (!raw) byDay.set(day, (raw = {}))
      add(raw, v.name, v.value)
    }
  }
  return byDay
}

/** Bài FB: `reactions` / `comments` (summary), `shares.count`, cộng insight lồng `insights.data`. */
function parseFacebookPost(data: unknown): RawMetrics {
  const d = obj(data)
  const raw = parseInsightTotals(d?.insights)
  add(raw, 'reactions', metricNumber(obj(obj(d?.reactions)?.summary)?.total_count))
  add(raw, 'comments', metricNumber(obj(obj(d?.comments)?.summary)?.total_count))
  add(raw, 'shares', metricNumber(obj(d?.shares)?.count))
  return raw
}

// ---------------------------------------------------------------------------------------------------------
// Bảng cấu hình
// ---------------------------------------------------------------------------------------------------------

export const POST_METRIC_MAP: Readonly<Record<Platform, PostMetricSpec>> = {
  facebook: {
    request: (id) => ({
      path: `/${id}`,
      params: {
        fields:
          'shares,comments.limit(0).summary(true),reactions.limit(0).summary(true),insights.metric(post_media_view,post_total_media_view_unique)',
      },
    }),
    parse: parseFacebookPost,
    rules: {
      views: { sum: ['post_media_view'] },
      reach: { sum: ['post_total_media_view_unique'] },
      engagement: { sum: ['reactions', 'comments', 'shares'] },
    },
  },
  instagram: {
    request: (id) => ({ path: `/${id}/insights`, params: { metric: 'views,reach,likes,comments,shares,saved' } }),
    parse: parseInsightTotals,
    rules: {
      views: { sum: ['views'] },
      reach: { sum: ['reach'] },
      engagement: { sum: ['likes', 'comments', 'shares', 'saved'] },
    },
  },
  threads: {
    request: (id) => ({ path: `/${id}/insights`, params: { metric: 'views,likes,replies,reposts,quotes' } }),
    parse: parseInsightTotals,
    rules: {
      views: { sum: ['views'] },
      // Threads không có reach theo bài.
      reach: null,
      engagement: { sum: ['likes', 'replies', 'reposts', 'quotes'] },
    },
  },
}

export const PAGE_METRIC_MAP: Readonly<Record<Platform, PageMetricSpec>> = {
  facebook: {
    mode: 'range',
    requests: [
      {
        path: (id) => `/${id}/insights`,
        params: {
          metric: 'page_media_view,page_total_media_view_unique,page_post_engagements,page_daily_follows_unique,page_daily_unfollows_unique',
          period: 'day',
        },
      },
    ],
    rules: {
      views: { sum: ['page_media_view'] },
      reach: { sum: ['page_total_media_view_unique'] },
      engagement: { sum: ['page_post_engagements'] },
      followers_delta: { sum: ['page_daily_follows_unique'], minus: ['page_daily_unfollows_unique'] },
    },
  },
  instagram: {
    mode: 'per_day',
    requests: [
      { path: (id) => `/${id}/insights`, params: { metric: 'views,reach,total_interactions', metric_type: 'total_value', period: 'day' } },
      {
        path: (id) => `/${id}/insights`,
        params: { metric: 'follows_and_unfollows', metric_type: 'total_value', period: 'day', breakdown: 'follow_type' },
        optional: true,
      },
    ],
    rules: {
      views: { sum: ['views'] },
      reach: { sum: ['reach'] },
      engagement: { sum: ['total_interactions'] },
      followers_delta: { sum: ['follows_and_unfollows.FOLLOWER'], minus: ['follows_and_unfollows.NON_FOLLOWER'] },
    },
  },
  threads: {
    mode: 'per_day',
    requests: [{ path: (id) => `/${id}/threads_insights`, params: { metric: 'views,likes,replies,reposts,quotes' } }],
    rules: {
      views: { sum: ['views'] },
      // Threads không có reach / theo dõi theo ngày (chỉ tổng người theo dõi hiện tại).
      reach: null,
      engagement: { sum: ['likes', 'replies', 'reposts', 'quotes'] },
      followers_delta: null,
    },
  },
}

/** Một chỉ số chuẩn từ metric gốc theo luật (xem đầu file). */
export function applyRule(rule: MetricRule | null, raw: RawMetrics): number | null {
  if (!rule) return null
  const has = (k: string) => Object.hasOwn(raw, k)
  const plus = rule.sum.filter(has)
  const minus = (rule.minus ?? []).filter(has)
  if (plus.length === 0 && minus.length === 0) return null
  const total = (keys: readonly string[]) => keys.reduce((s, k) => s + raw[k]!, 0)
  return total(plus) - total(minus)
}

export function standardize<K extends string>(rules: Readonly<Record<K, MetricRule | null>>, raw: RawMetrics): Record<K, number | null> {
  const out = {} as Record<K, number | null>
  for (const key of Object.keys(rules) as K[]) out[key] = applyRule(rules[key], raw)
  return out
}

/** Mọi tên metric gốc mà bảng cấu hình gửi lên Meta hoặc tham chiếu (test kiểm không có `impressions`). */
export function referencedMetricNames(): string[] {
  const names = new Set<string>()
  const addCsv = (v: unknown) => {
    if (typeof v === 'string') for (const s of v.split(/[,()]/)) if (s.trim()) names.add(s.trim())
  }
  for (const spec of Object.values(POST_METRIC_MAP)) {
    const req = spec.request('0')
    addCsv(req.params.metric)
    addCsv(req.params.fields)
    for (const r of Object.values(spec.rules)) for (const k of [...(r?.sum ?? []), ...(r?.minus ?? [])]) names.add(k)
  }
  for (const spec of Object.values(PAGE_METRIC_MAP)) {
    for (const req of spec.requests) addCsv(req.params.metric)
    for (const r of Object.values(spec.rules)) for (const k of [...(r?.sum ?? []), ...(r?.minus ?? [])]) names.add(k)
  }
  return [...names]
}
