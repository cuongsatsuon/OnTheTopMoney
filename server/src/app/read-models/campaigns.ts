// Read-model chiến dịch (Story 7.3, AD-18, AD-15): ghép cấu hình (`campaigns`) với tiến độ slot (`content`) thành
// `CampaignSummaryDto` cho thẻ ở `/chien-dich` và Tổng quan. Một hàm ghép duy nhất cho DTO này; chỉ đọc.
// - Nháp: `postsTotal` = số bài theo kế hoạch (trang chưa gỡ) — bài xem trước còn `held`, chưa tính chờ duyệt / bài kế.
// - Đã bắt đầu: số từ slot (`content.campaignProgress`); `daysDone` theo ngày VN từ `startDate`.
// - Story 8.5 (hoãn từ 7.3): `trend` = tương tác tăng mỗi ngày VN của bài đã đăng (`analytics.engagementGains`, 14 ngày tới
//   hôm nay — 7 ngày sau là `trend`, 7 ngày trước là kỳ so); `engagement7d.previous = null` khi chiến dịch bắt đầu sau ngày
//   đầu kỳ trước hoặc chưa bài nào có số liệu trong kỳ trước.
import { CAMPAIGN_TREND_DAYS, type CampaignDto, type CampaignSummaryDto, type MetricComparison } from '@ottm/shared'
import { engagementGains, type EngagementGains } from '../../modules/analytics/index.ts'
import { campaignPlan } from '../../modules/campaigns/index.ts'
import { campaignProgress } from '../../modules/content/index.ts'
import type { DbExecutor } from '../../platform/db/index.ts'

const DAY_MS = 24 * 60 * 60_000
const VN_OFFSET_MS = 7 * 60 * 60_000
/** Ngày VN `YYYY-MM-DD` cách `now` `back` ngày. */
const vnDate = (now: Date, back = 0) => new Date(now.getTime() + VN_OFFSET_MS - back * DAY_MS).toISOString().slice(0, 10)
const NO_ENGAGEMENT: MetricComparison = { current: null, previous: null }

/** Gộp tương tác tăng của các bài một chiến dịch: `trend` (7 ngày gần nhất) + tổng so với 7 ngày trước. */
export function campaignEngagement(
  perTarget: readonly (EngagementGains | undefined)[],
  opts: { startDate: string; prevFrom: string },
): { trend: number[]; engagement7d: MetricComparison } {
  const n = CAMPAIGN_TREND_DAYS
  const all = Array.from({ length: 2 * n }, () => 0)
  let known = false
  let knownBefore = false
  for (const t of perTarget) {
    if (!t || t.knownFrom === null) continue
    known = true
    if (t.knownFrom < n) knownBefore = true
    t.gains.forEach((g, i) => (all[i] = all[i]! + g))
  }
  const trend = all.slice(n)
  if (!known) return { trend, engagement7d: NO_ENGAGEMENT }
  const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0)
  const comparable = knownBefore && opts.startDate <= opts.prevFrom
  return { trend, engagement7d: { current: sum(trend), previous: comparable ? sum(all.slice(0, n)) : null } }
}

/** Số ngày chiến dịch đã qua: hôm nay (VN) − ngày bắt đầu, chặn trong `[0, durationDays]`; đã xong = cả thời lượng. */
export function campaignDaysDone(c: Pick<CampaignDto, 'status' | 'startDate' | 'durationDays'>, now: Date): number {
  if (c.status === 'draft') return 0
  if (c.status === 'done') return c.durationDays
  const today = Math.floor((now.getTime() + VN_OFFSET_MS) / DAY_MS)
  const start = Math.floor(Date.parse(`${c.startDate}T00:00:00.000Z`) / DAY_MS)
  return Math.max(0, Math.min(c.durationDays, today - start))
}

const emptyTrend = () => Array.from({ length: CAMPAIGN_TREND_DAYS }, () => 0)

/** Tóm tắt của các chiến dịch (giữ thứ tự `items`). */
export async function campaignSummaries(db: DbExecutor, items: readonly CampaignDto[], now: Date): Promise<CampaignSummaryDto[]> {
  const started = items.filter((c) => c.status !== 'draft')
  const progress = await campaignProgress(
    db,
    started.map((c) => c.id),
    now,
  )
  // Cửa sổ 14 ngày VN tới hôm nay: một câu `analytics` cho mọi bài của mọi chiến dịch.
  const prevFrom = vnDate(now, 2 * CAMPAIGN_TREND_DAYS - 1)
  const gains = await engagementGains(
    db,
    [...progress.values()].flatMap((p) => p.publishedTargetIds),
    { from: prevFrom, days: 2 * CAMPAIGN_TREND_DAYS },
  )
  const out: CampaignSummaryDto[] = []
  for (const c of items) {
    if (c.status === 'draft') {
      const total = (await campaignPlan(db, c)).length
      out.push({ ...c, postsTotal: total, postsDone: 0, postsPending: 0, nextPost: null, trend: emptyTrend(), engagement7d: NO_ENGAGEMENT, daysDone: 0 })
      continue
    }
    const p = progress.get(c.id)
    const engagement = campaignEngagement(
      (p?.publishedTargetIds ?? []).map((id) => gains.get(id)),
      { startDate: c.startDate, prevFrom },
    )
    out.push({
      ...c,
      postsTotal: p?.total ?? 0,
      postsDone: p?.done ?? 0,
      postsPending: p?.pending ?? 0,
      nextPost: p?.nextPost?.toISOString() ?? null,
      ...engagement,
      daysDone: campaignDaysDone(c, now),
    })
  }
  return out
}
