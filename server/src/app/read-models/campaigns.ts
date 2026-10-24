// Read-model chiến dịch (Story 7.3, AD-18, AD-15): ghép cấu hình (`campaigns`) với tiến độ slot (`content`) thành
// `CampaignSummaryDto` cho thẻ ở `/chien-dich` và Tổng quan. Một hàm ghép duy nhất cho DTO này; chỉ đọc.
// - Nháp: `postsTotal` = số bài theo kế hoạch (trang chưa gỡ) — bài xem trước còn `held`, chưa tính chờ duyệt / bài kế.
// - Đã bắt đầu: số từ slot (`content.campaignProgress`); `daysDone` theo ngày VN từ `startDate`.
import { CAMPAIGN_TREND_DAYS, type CampaignDto, type CampaignSummaryDto } from '@ottm/shared'
import { campaignPlan } from '../../modules/campaigns/index.ts'
import { campaignProgress } from '../../modules/content/index.ts'
import type { DbExecutor } from '../../platform/db/index.ts'

const DAY_MS = 24 * 60 * 60_000
const VN_OFFSET_MS = 7 * 60 * 60_000

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
  const out: CampaignSummaryDto[] = []
  for (const c of items) {
    if (c.status === 'draft') {
      const total = (await campaignPlan(db, c)).length
      out.push({ ...c, postsTotal: total, postsDone: 0, postsPending: 0, nextPost: null, trend: emptyTrend(), daysDone: 0 })
      continue
    }
    const p = progress.get(c.id)
    out.push({
      ...c,
      postsTotal: p?.total ?? 0,
      postsDone: p?.done ?? 0,
      postsPending: p?.pending ?? 0,
      nextPost: p?.nextPost?.toISOString() ?? null,
      trend: p?.trend ?? emptyTrend(),
      daysDone: campaignDaysDone(c, now),
    })
  }
  return out
}
