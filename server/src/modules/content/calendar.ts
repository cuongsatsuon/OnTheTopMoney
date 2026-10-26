// Lịch nội dung (Story 6.5, AD-13, AD-18): đọc target có `scheduled_at` trong một khoảng — mỗi trang một dòng, FE gom
// thành "bài trên lịch". Phạm vi do route giải bằng `pages.resolveScope` rồi truyền tập trang vào đây:
// - bài thuộc phạm vi khi có ít nhất một target (không huỷ) ở trang trong phạm vi; target ở trang khác của bài đó vẫn trả
//   (AD-18 "danh sách con vẫn trả đủ"), trừ trang đã gỡ (`visiblePageIds`);
// - bỏ target `cancelled` (đã xoá khỏi lịch) và target chưa có giờ (nháp).
// Đổi giờ / xoá trên lịch đi qua `transitionTarget` (`transitions.ts`) như Soạn bài — không có đường ghi riêng.
// Story 7.8: slot chiến dịch kèm tiêu đề + định dạng của kế hoạch nội dung (bài chưa viết hiện tiêu đề kế hoạch).
import { CALENDAR_ITEMS_MAX, CALENDAR_TITLE_MAX, type CalendarItemDto, type CalendarResponse, type ErrorCode, type PostSource, type PostTargetStatus } from '@ottm/shared'
import { and, asc, eq, gte, inArray, isNotNull, lt, ne, sql } from 'drizzle-orm'
import type { DbExecutor } from '../../platform/db/index.ts'
import { mediaAssets, postTargetMedia, postTargets, posts } from './schema.ts'
import { planSummary } from './slot-plan-store.ts'

export interface CalendarRange {
  /** Trang trong phạm vi đang xem. */
  pageIds: readonly string[]
  /** Trang chưa gỡ (target của trang đã gỡ không hiện). */
  visiblePageIds: readonly string[]
  from: Date
  to: Date
}

/** Đầu caption làm tiêu đề ô lịch: gộp khoảng trắng, cắt theo code point; trống → `null`. */
export function calendarTitle(caption: string): string | null {
  const flat = caption.replace(/\s+/g, ' ').trim()
  if (!flat) return null
  const chars = [...flat]
  return chars.length > CALENDAR_TITLE_MAX ? `${chars.slice(0, CALENDAR_TITLE_MAX - 1).join('')}…` : flat
}

/** Target trên lịch trong `[from, to)`, theo giờ tăng dần, tối đa `CALENDAR_ITEMS_MAX` (`truncated` khi còn). */
export async function listCalendar(db: DbExecutor, range: CalendarRange): Promise<CalendarResponse> {
  if (!range.pageIds.length || !range.visiblePageIds.length) return { items: [], truncated: false }
  const inScope = db
    .selectDistinct({ postId: postTargets.postId })
    .from(postTargets)
    .where(and(inArray(postTargets.pageId, [...range.pageIds]), ne(postTargets.status, 'cancelled' satisfies PostTargetStatus)))
  const aiMedia = sql<boolean>`exists (select 1 from ${postTargetMedia} join ${mediaAssets} on ${mediaAssets.id} = ${postTargetMedia.mediaAssetId}
    where ${postTargetMedia.postTargetId} = ${postTargets.id} and ${mediaAssets.source} = 'ai')`
  const thumbnail = sql<string | null>`(select ${mediaAssets.url} from ${postTargetMedia} join ${mediaAssets} on ${mediaAssets.id} = ${postTargetMedia.mediaAssetId}
    where ${postTargetMedia.postTargetId} = ${postTargets.id} order by ${postTargetMedia.position} limit 1)`
  const rows = await db
    .select({
      id: postTargets.id,
      postId: postTargets.postId,
      pageId: postTargets.pageId,
      status: postTargets.status,
      version: postTargets.version,
      scheduledAt: postTargets.scheduledAt,
      publishedAt: postTargets.publishedAt,
      errorCode: postTargets.errorCode,
      permalink: postTargets.permalink,
      caption: postTargets.caption,
      aiCaption: postTargets.aiCaption,
      aiMedia,
      thumbnail,
      source: posts.source,
      topic: posts.topic,
      campaignId: postTargets.campaignId,
      held: postTargets.held,
      plan: postTargets.plan,
    })
    .from(postTargets)
    .innerJoin(posts, eq(posts.id, postTargets.postId))
    .where(
      and(
        inArray(postTargets.postId, inScope),
        inArray(postTargets.pageId, [...range.visiblePageIds]),
        ne(postTargets.status, 'cancelled' satisfies PostTargetStatus),
        isNotNull(postTargets.scheduledAt),
        gte(postTargets.scheduledAt, range.from),
        lt(postTargets.scheduledAt, range.to),
      ),
    )
    .orderBy(asc(postTargets.scheduledAt), asc(postTargets.id))
    .limit(CALENDAR_ITEMS_MAX + 1)
  const items = rows.slice(0, CALENDAR_ITEMS_MAX).map((r): CalendarItemDto => {
    const plan = planSummary(r.plan)
    return {
      id: r.id,
      postId: r.postId,
      pageId: r.pageId,
      status: r.status as PostTargetStatus,
      version: r.version,
      scheduledAt: r.scheduledAt!.toISOString(),
      publishedAt: r.publishedAt?.toISOString() ?? null,
      errorCode: (r.errorCode as ErrorCode | null) ?? null,
      permalink: r.permalink,
      // Slot chiến dịch luôn do AI sinh (Epic 7); bài tay: caption AI hoặc ảnh AI (UX-DR10).
      ai: r.source === 'campaign' || r.aiCaption || r.aiMedia,
      source: r.source as PostSource,
      campaignId: r.campaignId,
      title: calendarTitle(r.caption),
      topic: r.topic,
      thumbnailUrl: r.thumbnail,
      // Story 7.5: chiến dịch tạm dừng giữ bài lại — Lịch ghi "Tạm dừng".
      held: r.held,
      planTitle: plan?.title ?? null,
      planFormat: plan?.format ?? null,
    }
  })
  return { items, truncated: rows.length > CALENDAR_ITEMS_MAX }
}
