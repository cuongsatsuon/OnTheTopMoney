// "Hiệu quả AI" của màn Hiệu suất (Story 8.3, AD-17, AD-1) — cùng phạm vi + kỳ với `performance.ts`, chỉ đọc:
// - số tin AI trả lời, tỉ lệ chuyển người, thời gian phản hồi: hàm đọc `inbox.aiReplyStats` (đếm trên `messages` + tin
//   `system`); không đọc `autoreply_runs` (`analytics` không gọi `autoreply`);
// - bài AI tạo vs bài tự viết: bài đã đăng trong kỳ (+ cờ `ai`) lấy qua `content`, tương tác = snapshot mới nhất của
//   `post_metrics`; bài chưa có snapshot / `engagement` `null` không tính (không kéo trung bình về 0).
// - KPI "Tin nhắn" (`countCustomerMessages`): kỳ trước chỉ so khi mọi trang đã kết nối từ đầu kỳ trước (không thì kỳ
//   trước thiếu tin → "+300%" giả, cùng tinh thần luật kỳ trước của 8.2).
import type { AiEfficiencyDto, MetricComparison, PageDto, PostKindStats } from '@ottm/shared'
import { desc, inArray } from 'drizzle-orm'
import type { PublishedRef } from '../content/index.ts'
import { aiReplyStats, countCustomerMessages } from '../inbox/index.ts'
import type { DbExecutor } from '../../platform/db/index.ts'
import { postMetrics } from './schema.ts'

interface Range {
  from: Date
  to: Date
}

/** Khối "Hiệu quả AI" cho các trang đã giải phạm vi và bài đã đăng trong kỳ. */
export async function aiEfficiency(
  db: DbExecutor,
  opts: { pageIds: readonly string[]; current: Range; published: readonly PublishedRef[] },
): Promise<AiEfficiencyDto> {
  const [replies, posts] = await Promise.all([aiReplyStats(db, { pageIds: opts.pageIds, ...opts.current }), postKindStats(db, opts.published)])
  return { ...replies, posts }
}

/** Tương tác trung bình mỗi bài theo nhóm (AI tạo / tự viết), từ snapshot mới nhất của từng target. */
async function postKindStats(db: DbExecutor, published: readonly PublishedRef[]): Promise<{ ai: PostKindStats; manual: PostKindStats }> {
  const acc = { ai: { posts: 0, sum: 0 }, manual: { posts: 0, sum: 0 } }
  if (published.length) {
    const aiTargets = new Set(published.filter((p) => p.ai).map((p) => p.targetId))
    const latest = await db
      .selectDistinctOn([postMetrics.postTargetId], { targetId: postMetrics.postTargetId, engagement: postMetrics.engagement })
      .from(postMetrics)
      .where(inArray(postMetrics.postTargetId, published.map((p) => p.targetId)))
      .orderBy(postMetrics.postTargetId, desc(postMetrics.metricDate))
    for (const r of latest) {
      if (r.engagement === null) continue
      const bucket = aiTargets.has(r.targetId) ? acc.ai : acc.manual
      bucket.posts += 1
      bucket.sum += r.engagement
    }
  }
  const stats = (b: { posts: number; sum: number }): PostKindStats => ({ posts: b.posts, avgEngagement: b.posts ? b.sum / b.posts : null })
  return { ai: stats(acc.ai), manual: stats(acc.manual) }
}

/** KPI "Tin nhắn": tin khách kỳ này và kỳ trước; `previous = null` khi có trang kết nối sau đầu kỳ trước. */
export async function messagesKpi(
  db: DbExecutor,
  opts: { pages: readonly Pick<PageDto, 'id' | 'connectedAt'>[]; current: Range; previous: Range },
): Promise<MetricComparison> {
  const pageIds = opts.pages.map((p) => p.id)
  const comparable = opts.pages.every((p) => Date.parse(p.connectedAt) <= opts.previous.from.getTime())
  const [current, previous] = await Promise.all([
    countCustomerMessages(db, { pageIds, ...opts.current }),
    comparable ? countCustomerMessages(db, { pageIds, ...opts.previous }) : Promise.resolve(null),
  ])
  return { current, previous }
}
