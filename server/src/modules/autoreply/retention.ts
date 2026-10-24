// Dọn theo hạn của `autoreply` (Story 9.3, AD-22): cron `privacy.retention` (ghép ở worker) gọi `purgeExpiredRuns` — xoá
// `autoreply_runs` bắt đầu quá `RETENTION.autoreplyRunDays`, kể cả lượt dở (tiến trình chết giữa chừng từ lâu). Bảng chỉ có
// id + kết quả (không nội dung); không ai đọc lượt cũ ngoài đo độ trễ gần đây. Theo lô qua index `started_at`.
import { DAY_MS, RETENTION } from '@ottm/shared'
import { inArray, lt } from 'drizzle-orm'
import { runInBatches, type BatchOptions, type BatchResult, type Db } from '../../platform/db/index.ts'
import { autoreplyRuns } from './schema.ts'

export async function purgeExpiredRuns(db: Db, options: BatchOptions & { now?: Date } = {}): Promise<BatchResult> {
  const cutoff = new Date((options.now ?? new Date()).getTime() - RETENTION.autoreplyRunDays * DAY_MS)
  return runInBatches(async (limit) => {
    const rows = await db
      .delete(autoreplyRuns)
      .where(inArray(autoreplyRuns.id, db.select({ id: autoreplyRuns.id }).from(autoreplyRuns).where(lt(autoreplyRuns.startedAt, cutoff)).limit(limit)))
      .returning({ id: autoreplyRuns.id })
    return rows.length
  }, options)
}
