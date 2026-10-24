// Màn Hiệu suất (Story 8.2, AD-17, AD-18): tổng hợp CHỈ từ bảng nội bộ của `analytics` — không gọi Meta theo request.
// - Trang trong phạm vi: `pages.listPages(scope)` (giải bằng `resolveScope` — nhóm theo thành viên HIỆN TẠI, bỏ trang đã gỡ;
//   nhóm / trang không tồn tại → 404).
// - KPI (+ kỳ trước), chuỗi tương tác theo nền tảng, bảng từng trang: `page_daily_metrics`. Tổng = cộng giá trị không
//   `null`; không có giá trị nào → `null` (FE phân biệt "không có" với "bằng 0").
// - Bài tốt nhất: id bài đã đăng trong kỳ lấy qua `content` (AD-1 — không join `post_targets`), xếp hạng bằng snapshot mới
//   nhất ở `post_metrics`, rồi hỏi `content` chi tiết của vài bài đã chọn.
// - Kỳ = N ngày VN trọn vẹn kết thúc HÔM QUA (cron trang chỉ thu ngày trước hôm nay); kỳ trước = N ngày liền trước.
// - Kỳ trước chỉ so khi đủ dữ liệu: có trang mà số liệu đầu tiên SAU ngày đầu kỳ trước (mới kết nối / mới bật thu — cron
//   chỉ lùi vài ngày) → kỳ trước thiếu → `previous = null` cho mọi KPI thay vì "+300%" giả.
// - Tỉ lệ tương tác tính ở server, chỉ trên ngày có CẢ tương tác lẫn tiếp cận (Threads không có reach — cộng tương tác
//   Threads vào tử mà mẫu không có sẽ thổi phồng tỉ lệ).
// - Story 8.3: KPI "Tin nhắn" + khối "Hiệu quả AI" (`ai-efficiency.ts`) cùng phạm vi + kỳ.
import {
  INSUFFICIENT_DATA_DAYS,
  PERFORMANCE_RANGE_DAYS,
  PLATFORMS,
  TOP_POSTS_MAX,
  type MetricComparison,
  type PageDto,
  type PageMetricsState,
  type PagePerformanceDto,
  type PerformanceRange,
  type PerformanceResponse,
  type PerformanceSeriesPoint,
  type Platform,
  type Scope,
  type TopPostDto,
} from '@ottm/shared'
import { and, desc, gte, inArray, lte, sql } from 'drizzle-orm'
import { describePublishedTargets, listPublishedInRange } from '../content/index.ts'
import { listPages } from '../pages/index.ts'
import type { DbExecutor } from '../../platform/db/index.ts'
import { aiEfficiency, messagesKpi } from './ai-efficiency.ts'
import { vnDateOf } from './collect.ts'
import { metricSyncStates, pageDailyMetrics, postMetrics } from './schema.ts'

const DAY_MS = 24 * 3_600_000
const VN_OFFSET_MS = 7 * 3_600_000

const dayNumber = (day: string) => Math.round(Date.parse(`${day}T00:00:00.000Z`) / DAY_MS)
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00.000Z`) + n * DAY_MS).toISOString().slice(0, 10)
/** 00:00 giờ VN của ngày `day` (mốc UTC). */
const vnDayStart = (day: string) => new Date(Date.parse(`${day}T00:00:00.000Z`) - VN_OFFSET_MS)

export interface PerformanceWindow {
  days: number
  /** Kỳ đang xem `[from, to]` (ngày VN). */
  from: string
  to: string
  /** Kỳ trước liền kề `[prevFrom, prevTo]`. */
  prevFrom: string
  prevTo: string
}

/** Kỳ của khoảng `range` tại `now`: N ngày kết thúc hôm qua (giờ VN) và N ngày liền trước. */
export function performanceWindow(range: PerformanceRange, now: Date): PerformanceWindow {
  const days = PERFORMANCE_RANGE_DAYS[range]
  const to = vnDateOf(now, 1)
  const from = addDays(to, -(days - 1))
  const prevTo = addDays(from, -1)
  return { days, from, to, prevFrom: addDays(prevTo, -(days - 1)), prevTo }
}

/** Cộng có `null`: giá trị `null` bỏ qua; chưa cộng được gì → `null`. */
const add = (acc: number | null, v: number | null): number | null => (v === null ? acc : (acc ?? 0) + v)

type Totals = { views: number | null; reach: number | null; engagement: number | null; followersDelta: number | null }
const emptyTotals = (): Totals => ({ views: null, reach: null, engagement: null, followersDelta: null })
function addTotals(t: Totals, r: Totals): void {
  t.views = add(t.views, r.views)
  t.reach = add(t.reach, r.reach)
  t.engagement = add(t.engagement, r.engagement)
  t.followersDelta = add(t.followersDelta, r.followersDelta)
}

/** Cơ sở tỉ lệ tương tác: chỉ cộng ngày có cả hai số. */
type RateBase = { engagement: number; reach: number }
function addRate(b: RateBase, r: Pick<Totals, 'engagement' | 'reach'>): void {
  if (r.engagement === null || r.reach === null) return
  b.engagement += r.engagement
  b.reach += r.reach
}
/** Tỉ lệ tương tác (%); tiếp cận 0 / không có → `null`. */
const rateOf = (b: RateBase): number | null => (b.reach > 0 ? (b.engagement / b.reach) * 100 : null)

/** Gộp hai lượt thu (`posts` / `page`) của một trang thành một trạng thái hiển thị; quyền thiếu ưu tiên cao nhất. */
export function pageMetricsState(rows: readonly { status: string; missingScopes: readonly string[] }[]): {
  state: PageMetricsState
  missingScopes: string[]
} {
  const missing = [...new Set(rows.flatMap((r) => r.missingScopes))].sort()
  if (rows.some((r) => r.status === 'permissions_missing' || r.status === 'permission_denied')) return { state: 'permissions_missing', missingScopes: missing }
  if (rows.some((r) => r.status === 'failed' || r.status === 'disconnected')) return { state: 'failed', missingScopes: [] }
  if (!rows.length) return { state: 'pending', missingScopes: [] }
  return { state: 'ok', missingScopes: [] }
}

/** Trang kết nối chưa đủ `INSUFFICIENT_DATA_DAYS` ngày tính tới `now`. */
const isInsufficient = (page: Pick<PageDto, 'connectedAt'>, now: Date) => Date.parse(page.connectedAt) > now.getTime() - INSUFFICIENT_DATA_DAYS * DAY_MS

/** Tổng hợp màn Hiệu suất cho phạm vi + khoảng. Chỉ đọc. */
export async function performanceOverview(
  db: DbExecutor,
  opts: { scope: Scope; range: PerformanceRange; now: Date },
): Promise<PerformanceResponse> {
  const pages = await listPages(db, opts.scope)
  const w = performanceWindow(opts.range, opts.now)
  const dates = Array.from({ length: w.days }, (_, i) => addDays(w.from, i))
  const fromNo = dayNumber(w.from)
  const prevFromNo = dayNumber(w.prevFrom)
  const pageIds = pages.map((p) => p.id)
  const platformOf = new Map(pages.map((p) => [p.id, p.platform] as const))

  const cur = emptyTotals()
  const prev = emptyTotals()
  const curRate: RateBase = { engagement: 0, reach: 0 }
  const prevRate: RateBase = { engagement: 0, reach: 0 }
  const series: PerformanceSeriesPoint[] = dates.map((date) => ({ date, facebook: null, instagram: null, threads: null, previous: null }))
  const perPage = new Map(pageIds.map((id) => [id, { totals: emptyTotals(), trend: dates.map((): number | null => null) }]))

  const [daily, syncRows, published, lateStart] = pageIds.length
    ? await Promise.all([
        db
          .select({
            pageId: pageDailyMetrics.pageId,
            date: pageDailyMetrics.date,
            views: pageDailyMetrics.views,
            reach: pageDailyMetrics.reach,
            engagement: pageDailyMetrics.engagement,
            followersDelta: pageDailyMetrics.followersDelta,
          })
          .from(pageDailyMetrics)
          .where(and(inArray(pageDailyMetrics.pageId, pageIds), gte(pageDailyMetrics.date, w.prevFrom), lte(pageDailyMetrics.date, w.to))),
        db
          .select({ pageId: metricSyncStates.pageId, status: metricSyncStates.status, missingScopes: metricSyncStates.missingScopes })
          .from(metricSyncStates)
          .where(inArray(metricSyncStates.pageId, pageIds)),
        listPublishedInRange(db, { pageIds, from: vnDayStart(w.from), to: vnDayStart(addDays(w.to, 1)) }),
        // Trang có số liệu đầu tiên sau ngày đầu kỳ trước → kỳ trước chưa đủ để so (`min` đi theo PK `(page_id, date)`).
        db
          .select({ pageId: pageDailyMetrics.pageId })
          .from(pageDailyMetrics)
          .where(inArray(pageDailyMetrics.pageId, pageIds))
          .groupBy(pageDailyMetrics.pageId)
          .having(sql`min(${pageDailyMetrics.date}) > ${w.prevFrom}`)
          .limit(1),
      ])
    : [[], [], [], []]
  const comparable = lateStart.length === 0
  const current = { from: vnDayStart(w.from), to: vnDayStart(addDays(w.to, 1)) }
  const [messages, ai] = await Promise.all([
    messagesKpi(db, { pages, current, previous: { from: vnDayStart(w.prevFrom), to: current.from } }),
    aiEfficiency(db, { pageIds, current, published }),
  ])

  for (const r of daily) {
    const no = dayNumber(r.date)
    if (no >= fromNo) {
      const i = no - fromNo
      addTotals(cur, r)
      addRate(curRate, r)
      const point = series[i]!
      const pf = platformOf.get(r.pageId)!
      point[pf] = add(point[pf], r.engagement)
      const row = perPage.get(r.pageId)!
      addTotals(row.totals, r)
      row.trend[i] = add(row.trend[i]!, r.engagement)
    } else {
      addTotals(prev, r)
      addRate(prevRate, r)
      const point = series[no - prevFromNo]!
      point.previous = add(point.previous, r.engagement)
    }
  }

  const postCount = new Map<string, number>()
  for (const p of published) postCount.set(p.pageId, (postCount.get(p.pageId) ?? 0) + 1)
  const syncByPage = new Map<string, { status: string; missingScopes: string[] }[]>()
  for (const s of syncRows) syncByPage.set(s.pageId, [...(syncByPage.get(s.pageId) ?? []), s])

  const pageRows = pages.map((p): PagePerformanceDto => {
    const row = perPage.get(p.id)!
    const sync = pageMetricsState(syncByPage.get(p.id) ?? [])
    return {
      pageId: p.id,
      ...row.totals,
      posts: postCount.get(p.id) ?? 0,
      trend: row.trend,
      insufficientData: isInsufficient(p, opts.now),
      metricsState: sync.state,
      missingScopes: sync.missingScopes,
    }
  })

  const kpi = (k: keyof Totals): MetricComparison => ({ current: cur[k], previous: comparable ? prev[k] : null })
  return {
    range: opts.range,
    from: w.from,
    to: w.to,
    insufficientData: pageRows.length > 0 && pageRows.every((r) => r.insufficientData),
    platforms: PLATFORMS.filter((pf: Platform) => pages.some((p) => p.platform === pf)),
    kpis: {
      views: kpi('views'),
      reach: kpi('reach'),
      engagement: kpi('engagement'),
      followersDelta: kpi('followersDelta'),
      engagementRate: { current: rateOf(curRate), previous: comparable ? rateOf(prevRate) : null },
      messages,
    },
    series,
    pages: pageRows,
    topPosts: await topPosts(
      db,
      published.map((p) => p.targetId),
    ),
    ai,
  }
}

/** `TOP_POSTS_MAX` bài có tương tác cao nhất trong các target đã cho, theo snapshot mới nhất của từng bài. */
async function topPosts(db: DbExecutor, targetIds: readonly string[]): Promise<TopPostDto[]> {
  if (!targetIds.length) return []
  const latest = db
    .selectDistinctOn([postMetrics.postTargetId], {
      targetId: postMetrics.postTargetId,
      views: postMetrics.views,
      reach: postMetrics.reach,
      engagement: postMetrics.engagement,
    })
    .from(postMetrics)
    .where(inArray(postMetrics.postTargetId, [...targetIds]))
    .orderBy(postMetrics.postTargetId, desc(postMetrics.metricDate))
    .as('latest')
  const ranked = await db
    .select()
    .from(latest)
    .orderBy(sql`${latest.engagement} desc nulls last`, sql`${latest.views} desc nulls last`, latest.targetId)
    .limit(TOP_POSTS_MAX)
  const info = new Map((await describePublishedTargets(db, ranked.map((r) => r.targetId))).map((t) => [t.targetId, t]))
  const out: TopPostDto[] = []
  for (const r of ranked) {
    const t = info.get(r.targetId)
    if (!t) continue
    out.push({
      targetId: t.targetId,
      postId: t.postId,
      pageId: t.pageId,
      publishedAt: t.publishedAt.toISOString(),
      title: t.title,
      permalink: t.permalink,
      thumbnailUrl: t.thumbnailUrl,
      ai: t.ai,
      source: t.source,
      campaignId: t.campaignId,
      views: r.views,
      reach: r.reach,
      engagement: r.engagement,
    })
  }
  return out
}
