// Phần `content` của Tổng quan (Story 8.5, AD-18): bài đăng lỗi và bài sắp đăng, gom target theo bài — read-model
// `app/read-models/overview.ts` ghép với phần của module khác. Chỉ đọc; hai câu mỗi danh sách (chọn bài → đọc target),
// không N+1.
// - Bài thuộc phạm vi khi có target cùng trạng thái của mục ở trang trong phạm vi; target cùng bài ở trang khác chưa gỡ vẫn
//   trả (AD-18 "danh sách con vẫn trả đủ"), trang đã gỡ thì không.
// - Hiển thị theo luật Lịch nội dung: `ai` (slot chiến dịch / caption AI / ảnh AI), tiêu đề = đầu caption, `topic`.
import { OVERVIEW_LIST_MAX, type ErrorCode, type OverviewPostDto, type PostSource, type PostTargetStatus } from '@ottm/shared'
import { and, asc, desc, eq, gte, inArray, sql, type SQL } from 'drizzle-orm'
import type { DbExecutor } from '../../platform/db/index.ts'
import { calendarTitle } from './calendar.ts'
import { mediaAssets, postTargetMedia, postTargets, posts } from './schema.ts'

export interface OverviewPostsInput {
  /** Trang trong phạm vi đang xem. */
  pageIds: readonly string[]
  /** Trang chưa gỡ (target của trang đã gỡ không hiện). */
  visiblePageIds: readonly string[]
  limit?: number
}

const UPCOMING: readonly PostTargetStatus[] = ['scheduled', 'pending_approval']

/** Mốc của bài lỗi: giờ đăng (luôn có với target từng `scheduled`), phòng hờ `updated_at`. */
const failedAt = sql<Date>`coalesce(${postTargets.scheduledAt}, ${postTargets.updatedAt})`

const aiOf = sql<boolean>`(${posts.source} = 'campaign' or ${postTargets.aiCaption} or exists (
  select 1 from ${postTargetMedia} join ${mediaAssets} on ${mediaAssets.id} = ${postTargetMedia.mediaAssetId}
  where ${postTargetMedia.postTargetId} = ${postTargets.id} and ${mediaAssets.source} = 'ai'))`
const thumbnailOf = sql<string | null>`(select ${mediaAssets.url} from ${postTargetMedia} join ${mediaAssets} on ${mediaAssets.id} = ${postTargetMedia.mediaAssetId}
  where ${postTargetMedia.postTargetId} = ${postTargets.id} order by ${postTargetMedia.position} limit 1)`

const toDate = (v: Date | string) => (v instanceof Date ? v : new Date(v))

/** Target của các bài đã chọn (theo `where`), gom theo `keyOf`, giữ thứ tự `order` (khoá nhóm). */
async function readGroups(db: DbExecutor, where: SQL | undefined, order: readonly string[], keyOf: (r: { postId: string; at: Date; status: string }) => string): Promise<OverviewPostDto[]> {
  const rows = await db
    .select({
      id: postTargets.id,
      postId: postTargets.postId,
      pageId: postTargets.pageId,
      status: postTargets.status,
      version: postTargets.version,
      errorCode: postTargets.errorCode,
      at: failedAt,
      caption: postTargets.caption,
      ai: aiOf,
      thumbnail: thumbnailOf,
      source: posts.source,
      topic: posts.topic,
      campaignId: postTargets.campaignId,
    })
    .from(postTargets)
    .innerJoin(posts, eq(posts.id, postTargets.postId))
    .where(where)
    .orderBy(asc(postTargets.postId), asc(postTargets.position), asc(postTargets.id))
  const groups = new Map<string, OverviewPostDto>()
  for (const r of rows) {
    const at = toDate(r.at)
    const key = keyOf({ postId: r.postId, at, status: r.status })
    const target = { id: r.id, pageId: r.pageId, version: r.version, errorCode: (r.errorCode as ErrorCode | null) ?? null }
    const g = groups.get(key)
    if (g) {
      g.targets.push(target)
      g.ai ||= r.ai
      g.title ??= calendarTitle(r.caption)
      g.thumbnailUrl ??= r.thumbnail
      if (at.toISOString() > g.scheduledAt) g.scheduledAt = at.toISOString()
      continue
    }
    groups.set(key, {
      postId: r.postId,
      status: r.status as PostTargetStatus,
      scheduledAt: at.toISOString(),
      targets: [target],
      title: calendarTitle(r.caption),
      topic: r.topic,
      thumbnailUrl: r.thumbnail,
      ai: r.ai,
      source: r.source as PostSource,
      campaignId: r.campaignId,
    })
  }
  return order.flatMap((k) => groups.get(k) ?? [])
}

/**
 * Bài có target `failed` ở trang trong phạm vi: `count` = số bài; `items` = tối đa `limit` bài, giờ đăng lỗi mới nhất trước,
 * mỗi bài kèm mọi target lỗi (trang chưa gỡ) để "Đăng lại" một lần.
 */
export async function listFailedPosts(db: DbExecutor, input: OverviewPostsInput): Promise<{ count: number; items: OverviewPostDto[] }> {
  if (!input.pageIds.length || !input.visiblePageIds.length) return { count: 0, items: [] }
  const failed = eq(postTargets.status, 'failed' satisfies PostTargetStatus)
  const latest = sql<Date | string>`max(${failedAt})`
  // `count(*) over ()` sau `group by` = số bài (trước `limit`).
  const ranked = await db
    .select({ postId: postTargets.postId, total: sql<number>`(count(*) over ())::int` })
    .from(postTargets)
    .where(and(failed, inArray(postTargets.pageId, [...input.pageIds])))
    .groupBy(postTargets.postId)
    .orderBy(desc(latest), desc(postTargets.postId))
    .limit(input.limit ?? OVERVIEW_LIST_MAX)
  if (!ranked.length) return { count: 0, items: [] }
  const ids = ranked.map((r) => r.postId)
  const items = await readGroups(db, and(failed, inArray(postTargets.postId, ids), inArray(postTargets.pageId, [...input.visiblePageIds])), ids, (r) => r.postId)
  return { count: ranked[0]!.total, items }
}

/**
 * Bài sắp đăng: target `scheduled` / `pending_approval` không bị giữ, giờ đăng từ `now`, ở trang trong phạm vi — gom theo
 * `(bài, giờ, trạng thái)`, sớm nhất trước, tối đa `limit` nhóm.
 */
export async function listUpcomingPosts(db: DbExecutor, input: OverviewPostsInput & { now: Date }): Promise<OverviewPostDto[]> {
  if (!input.pageIds.length || !input.visiblePageIds.length) return []
  const open = and(inArray(postTargets.status, [...UPCOMING]), eq(postTargets.held, false), gte(postTargets.scheduledAt, input.now))
  const ranked = await db
    .select({ postId: postTargets.postId, at: postTargets.scheduledAt, status: postTargets.status })
    .from(postTargets)
    .where(and(open, inArray(postTargets.pageId, [...input.pageIds])))
    .groupBy(postTargets.postId, postTargets.scheduledAt, postTargets.status)
    .orderBy(asc(postTargets.scheduledAt), asc(postTargets.postId))
    .limit(input.limit ?? OVERVIEW_LIST_MAX)
  if (!ranked.length) return []
  const keyOf = (r: { postId: string; at: Date; status: string }) => `${r.postId}|${r.at.getTime()}|${r.status}`
  const order = ranked.map((r) => keyOf({ postId: r.postId, at: r.at!, status: r.status }))
  return readGroups(
    db,
    and(
      open,
      inArray(
        postTargets.postId,
        ranked.map((r) => r.postId),
      ),
      inArray(postTargets.pageId, [...input.visiblePageIds]),
    ),
    order,
    keyOf,
  )
}
