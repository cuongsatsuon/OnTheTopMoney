// Cron `content.requeue` (Story 6.4, AD-13): vá đường đăng khi job bị mất hoặc worker chết giữa chừng.
// - Target `scheduled` quá giờ hơn 10 phút mà không còn job `publish.target` sống (chờ / chờ retry / đang chạy) cùng
//   `{targetId, scheduleVersion}` → enqueue lại (job tự bỏ qua nếu lịch vừa đổi). Target `held` (AD-15) không enqueue lại.
// - Target `publishing` quá 15 phút → `failed` `PUBLISH_UNKNOWN` + `post_target.failed`: có thể bài đã lên, không tự đăng
//   lại (chủ shop kiểm trang rồi "Đăng lại").
import type { PostTargetStatus } from '@ottm/shared'
import { and, asc, eq, lt, sql } from 'drizzle-orm'
import type { Db } from '../../platform/db/index.ts'
import type { EventPublisher } from '../../platform/events/index.ts'
import { hasLiveJob, type JobSender } from '../../platform/jobs/index.ts'
import { postTargets } from './schema.ts'

/** Target `scheduled` quá giờ chừng này mà không có job sống → enqueue lại. */
export const REQUEUE_OVERDUE_MS = 10 * 60_000
/** Target kẹt `publishing` lâu hơn chừng này → `PUBLISH_UNKNOWN`. */
export const PUBLISHING_STUCK_MS = 15 * 60_000
/** Số target `scheduled` quá giờ xét mỗi lần chạy. */
export const REQUEUE_BATCH = 500

export interface RequeueDeps {
  db: Db
  events: EventPublisher
  jobs: JobSender
  now?: () => Date
}

export interface RequeueResult {
  requeued: number
  stuck: number
}

export async function requeueTargets(deps: RequeueDeps): Promise<RequeueResult> {
  const now = deps.now?.() ?? new Date()
  const overdue = await deps.db
    .select({ id: postTargets.id, scheduleVersion: postTargets.scheduleVersion })
    .from(postTargets)
    .where(
      and(eq(postTargets.status, 'scheduled'), eq(postTargets.held, false), lt(postTargets.scheduledAt, new Date(now.getTime() - REQUEUE_OVERDUE_MS))),
    )
    .orderBy(asc(postTargets.scheduledAt))
    .limit(REQUEUE_BATCH)
  let requeued = 0
  for (const t of overdue) {
    const data = { targetId: t.id, scheduleVersion: t.scheduleVersion }
    if (await hasLiveJob(deps.db, 'publish.target', data)) continue
    await deps.jobs.send('publish.target', data)
    requeued++
  }

  const stuck = await deps.db.transaction(async (tx) => {
    const rows = await tx
      .update(postTargets)
      .set({ status: 'failed' satisfies PostTargetStatus, errorCode: 'PUBLISH_UNKNOWN', version: sql`${postTargets.version} + 1`, updatedAt: sql`now()` })
      .where(and(eq(postTargets.status, 'publishing'), lt(postTargets.publishingAt, new Date(now.getTime() - PUBLISHING_STUCK_MS))))
      .returning({ id: postTargets.id, pageId: postTargets.pageId, campaignId: postTargets.campaignId, version: postTargets.version })
    for (const r of rows) {
      await deps.events.publishEvent(tx, 'post_target.failed', { id: r.id, pageId: r.pageId, campaignId: r.campaignId, errorCode: 'PUBLISH_UNKNOWN', version: r.version })
    }
    return rows.length
  })
  return { requeued, stuck }
}
