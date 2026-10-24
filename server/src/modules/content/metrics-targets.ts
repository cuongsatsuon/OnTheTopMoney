// Bài đã đăng cần kéo số liệu (Story 8.1, AD-17): `analytics` không đọc bảng `post_targets` (AD-1) nên lấy danh sách
// qua hàm này. Chỉ target `published` có `platform_post_id` (Meta trả id lúc đăng), trong cửa sổ `since`, mới nhất trước.
// Story 8.2 (màn Hiệu suất): `listPublishedInRange` (id bài đã đăng trong kỳ — đếm bài theo trang, ứng viên "bài tốt
// nhất") và `describePublishedTargets` (chi tiết vài bài đã chọn, cùng luật `ai` / tiêu đề với Lịch nội dung).
import type { PostSource } from '@ottm/shared'
import { and, desc, eq, gte, inArray, isNotNull, lt, sql } from 'drizzle-orm'
import type { DbExecutor } from '../../platform/db/index.ts'
import { calendarTitle } from './calendar.ts'
import { mediaAssets, postTargetMedia, postTargets, posts } from './schema.ts'

/** Tối đa bài mỗi trang mỗi lượt thu [ASSUMPTION] — 3 bài/ngày × 30 ngày = 90, dư cho trang đăng dày. */
export const METRIC_TARGETS_MAX = 300

export interface MetricTarget {
  targetId: string
  pageId: string
  /** Dạng chuẩn AD-6 (FB `{pageId}_{postId}`, IG / Threads media id). */
  platformPostId: string
  publishedAt: Date
}

export async function listMetricTargets(
  db: DbExecutor,
  opts: { pageId: string; since: Date; limit?: number },
): Promise<MetricTarget[]> {
  const rows = await db
    .select({ targetId: postTargets.id, pageId: postTargets.pageId, platformPostId: postTargets.platformPostId, publishedAt: postTargets.publishedAt })
    .from(postTargets)
    .where(
      and(
        eq(postTargets.pageId, opts.pageId),
        eq(postTargets.status, 'published'),
        isNotNull(postTargets.platformPostId),
        gte(postTargets.publishedAt, opts.since),
      ),
    )
    .orderBy(desc(postTargets.publishedAt), desc(postTargets.id))
    .limit(opts.limit ?? METRIC_TARGETS_MAX)
  return rows.map((r) => ({ targetId: r.targetId, pageId: r.pageId, platformPostId: r.platformPostId!, publishedAt: r.publishedAt! }))
}

/** Tối đa target một lần đọc kỳ Hiệu suất [ASSUMPTION] — 90 ngày × 3 bài × 35 trang; vượt thì bỏ bài cũ nhất. */
export const PUBLISHED_IN_RANGE_MAX = 10_000

export interface PublishedRef {
  targetId: string
  pageId: string
}

/** Target `published` của các trang có `published_at` trong `[from, to)`, mới nhất trước. */
export async function listPublishedInRange(
  db: DbExecutor,
  opts: { pageIds: readonly string[]; from: Date; to: Date; limit?: number },
): Promise<PublishedRef[]> {
  if (!opts.pageIds.length) return []
  return db
    .select({ targetId: postTargets.id, pageId: postTargets.pageId })
    .from(postTargets)
    .where(
      and(
        inArray(postTargets.pageId, [...opts.pageIds]),
        eq(postTargets.status, 'published'),
        gte(postTargets.publishedAt, opts.from),
        lt(postTargets.publishedAt, opts.to),
      ),
    )
    .orderBy(desc(postTargets.publishedAt), desc(postTargets.id))
    .limit(opts.limit ?? PUBLISHED_IN_RANGE_MAX)
}

export interface PublishedTargetInfo {
  targetId: string
  postId: string
  pageId: string
  publishedAt: Date
  title: string | null
  permalink: string | null
  thumbnailUrl: string | null
  ai: boolean
  source: PostSource
  campaignId: string | null
}

/** Chi tiết target đã đăng theo id (bỏ id không còn `published`); thứ tự không đảm bảo — bên gọi tự xếp. */
export async function describePublishedTargets(db: DbExecutor, targetIds: readonly string[]): Promise<PublishedTargetInfo[]> {
  if (!targetIds.length) return []
  const aiMedia = sql<boolean>`exists (select 1 from ${postTargetMedia} join ${mediaAssets} on ${mediaAssets.id} = ${postTargetMedia.mediaAssetId}
    where ${postTargetMedia.postTargetId} = ${postTargets.id} and ${mediaAssets.source} = 'ai')`
  const thumbnail = sql<string | null>`(select ${mediaAssets.url} from ${postTargetMedia} join ${mediaAssets} on ${mediaAssets.id} = ${postTargetMedia.mediaAssetId}
    where ${postTargetMedia.postTargetId} = ${postTargets.id} order by ${postTargetMedia.position} limit 1)`
  const rows = await db
    .select({
      targetId: postTargets.id,
      postId: postTargets.postId,
      pageId: postTargets.pageId,
      publishedAt: postTargets.publishedAt,
      caption: postTargets.caption,
      permalink: postTargets.permalink,
      aiCaption: postTargets.aiCaption,
      aiMedia,
      thumbnail,
      source: posts.source,
      campaignId: postTargets.campaignId,
    })
    .from(postTargets)
    .innerJoin(posts, eq(posts.id, postTargets.postId))
    .where(and(inArray(postTargets.id, [...targetIds]), eq(postTargets.status, 'published'), isNotNull(postTargets.publishedAt)))
  return rows.map((r) => ({
    targetId: r.targetId,
    postId: r.postId,
    pageId: r.pageId,
    publishedAt: r.publishedAt!,
    title: calendarTitle(r.caption),
    permalink: r.permalink,
    thumbnailUrl: r.thumbnail,
    // Cùng luật Lịch nội dung: slot chiến dịch luôn do AI sinh; bài tay: caption AI hoặc ảnh AI (UX-DR10).
    ai: r.source === 'campaign' || r.aiCaption || r.aiMedia,
    source: r.source as PostSource,
    campaignId: r.campaignId,
  }))
}
