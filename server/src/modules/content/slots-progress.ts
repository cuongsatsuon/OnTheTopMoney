// Tiến độ slot của chiến dịch (Story 7.3, AD-15, AD-18) — phần `content` của read-model chiến dịch
// (`app/read-models/campaigns.ts` ghép với cấu hình của `campaigns`). Chỉ đọc; ngày theo giờ VN (UTC+7, không giờ mùa hè).
import { CAMPAIGN_TREND_DAYS, type PostTargetStatus } from '@ottm/shared'
import { and, eq, gte, inArray, sql } from 'drizzle-orm'
import type { DbExecutor } from '../../platform/db/index.ts'
import { postTargets } from './schema.ts'

export interface CampaignProgress {
  /** Slot chưa huỷ. */
  total: number
  /** Đã đăng. */
  done: number
  /** Chờ duyệt (không tính bài xem trước còn `held`). */
  pending: number
  /** Giờ đăng dự kiến sớm nhất còn tới của slot chưa đăng, không `held`; `null` khi không có. */
  nextPost: Date | null
  /** Bài đã đăng mỗi ngày VN, `CAMPAIGN_TREND_DAYS` ngày tới hôm nay (cũ → mới). */
  trend: number[]
}

const DAY_MS = 24 * 60 * 60_000
const VN_OFFSET_MS = 7 * 60 * 60_000
/** Số ngày VN (đếm từ epoch) của thời điểm `ms`. */
const vnDay = (ms: number) => Math.floor((ms + VN_OFFSET_MS) / DAY_MS)

const UPCOMING: readonly PostTargetStatus[] = ['planned', 'pending_approval', 'scheduled']

/** Tiến độ theo chiến dịch; chiến dịch không có slot nào → không có trong map (bên gọi coi là 0). */
export async function campaignProgress(db: DbExecutor, campaignIds: readonly string[], now: Date): Promise<Map<string, CampaignProgress>> {
  const out = new Map<string, CampaignProgress>()
  if (!campaignIds.length) return out
  const nowIso = now.toISOString()
  const rows = await db
    .select({
      campaignId: postTargets.campaignId,
      total: sql<number>`count(*) filter (where ${postTargets.status} <> 'cancelled')::int`,
      done: sql<number>`count(*) filter (where ${postTargets.status} = 'published')::int`,
      pending: sql<number>`count(*) filter (where ${postTargets.status} = 'pending_approval' and not ${postTargets.held})::int`,
      nextPost: sql<string | null>`min(${postTargets.scheduledAt}) filter (where ${postTargets.status} in (${sql.raw(UPCOMING.map((s) => `'${s}'`).join(', '))})
        and not ${postTargets.held} and ${postTargets.scheduledAt} > ${nowIso}::timestamptz)`,
    })
    .from(postTargets)
    .where(inArray(postTargets.campaignId, [...campaignIds]))
    .groupBy(postTargets.campaignId)
  const today = vnDay(now.getTime())
  const firstDay = today - (CAMPAIGN_TREND_DAYS - 1)
  for (const r of rows) {
    out.set(r.campaignId!, {
      total: r.total,
      done: r.done,
      pending: r.pending,
      nextPost: r.nextPost ? new Date(r.nextPost) : null,
      trend: Array.from({ length: CAMPAIGN_TREND_DAYS }, () => 0),
    })
  }
  const published = await db
    .select({ campaignId: postTargets.campaignId, publishedAt: postTargets.publishedAt })
    .from(postTargets)
    .where(
      and(
        inArray(postTargets.campaignId, [...campaignIds]),
        eq(postTargets.status, 'published' satisfies PostTargetStatus),
        gte(postTargets.publishedAt, new Date(firstDay * DAY_MS - VN_OFFSET_MS)),
      ),
    )
  for (const p of published) {
    const day = vnDay(p.publishedAt!.getTime())
    const progress = out.get(p.campaignId!)
    if (progress && day >= firstDay && day <= today) progress.trend[day - firstDay]!++
  }
  return out
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Story 7.6 (chuỗi lỗi đăng không phụ thuộc thứ tự xử lý sự kiện): có target nào của chiến dịch `campaignId` đã đăng
 * SAU lần đổi cuối của target `targetId` (lúc nó lỗi) không — có → lỗi đó thuộc chuỗi cũ, không đếm.
 */
export async function publishedAfter(db: DbExecutor, campaignId: string, targetId: string): Promise<boolean> {
  if (!UUID_RE.test(campaignId) || !UUID_RE.test(targetId)) return false
  const [row] = await db
    .select({ id: postTargets.id })
    .from(postTargets)
    .where(
      and(
        eq(postTargets.campaignId, campaignId),
        eq(postTargets.status, 'published' satisfies PostTargetStatus),
        sql`${postTargets.publishedAt} > (select f.updated_at from post_targets f where f.id = ${targetId}::uuid)`,
      ),
    )
    .limit(1)
  return row !== undefined
}

/**
 * Story 7.6: trong `targetIds`, các target vẫn `failed` và lỗi SAU lúc target `publishedId` đăng — phần chuỗi lỗi còn
 * hiệu lực khi sự kiện đăng được tới muộn hơn sự kiện lỗi của bài đăng sau nó.
 */
export async function failedAfterPublish(db: DbExecutor, targetIds: readonly string[], publishedId: string): Promise<string[]> {
  const ids = targetIds.filter((id) => UUID_RE.test(id))
  if (!ids.length || !UUID_RE.test(publishedId)) return []
  const rows = await db
    .select({ id: postTargets.id })
    .from(postTargets)
    .where(
      and(
        inArray(postTargets.id, ids),
        eq(postTargets.status, 'failed' satisfies PostTargetStatus),
        sql`${postTargets.updatedAt} > (select p.published_at from post_targets p where p.id = ${publishedId}::uuid)`,
      ),
    )
  const kept = new Set(rows.map((r) => r.id))
  return targetIds.filter((id) => kept.has(id))
}
