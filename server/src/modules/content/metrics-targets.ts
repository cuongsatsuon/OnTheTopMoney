// Bài đã đăng cần kéo số liệu (Story 8.1, AD-17): `analytics` không đọc bảng `post_targets` (AD-1) nên lấy danh sách
// qua hàm này. Chỉ target `published` có `platform_post_id` (Meta trả id lúc đăng), trong cửa sổ `since`, mới nhất trước.
import { and, desc, eq, gte, isNotNull } from 'drizzle-orm'
import type { DbExecutor } from '../../platform/db/index.ts'
import { postTargets } from './schema.ts'

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
