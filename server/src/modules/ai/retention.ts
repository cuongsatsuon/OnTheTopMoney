// Dọn theo hạn của `ai` (Story 9.3, AD-22): cron `privacy.retention` (ghép ở worker) gọi `clearExpiredRefs` — bỏ tham chiếu
// của caller (`ai_usage.ref` = id hội thoại / bài) ở dòng quá `RETENTION.aiUsageRefDays`. Dòng chi phí GIỮ NGUYÊN (hạn mức
// tháng, số liệu chi phí). Theo lô qua index một phần `ref is not null`; chạy lại chỉ làm phần còn lại.
import { DAY_MS, RETENTION } from '@ottm/shared'
import { and, inArray, isNotNull, lt } from 'drizzle-orm'
import { runInBatches, type BatchOptions, type BatchResult, type Db } from '../../platform/db/index.ts'
import { aiUsage } from './schema.ts'

export async function clearExpiredRefs(db: Db, options: BatchOptions & { now?: Date } = {}): Promise<BatchResult> {
  const cutoff = new Date((options.now ?? new Date()).getTime() - RETENTION.aiUsageRefDays * DAY_MS)
  const expired = and(isNotNull(aiUsage.ref), lt(aiUsage.createdAt, cutoff))
  return runInBatches(async (limit) => {
    const rows = await db
      .update(aiUsage)
      .set({ ref: null })
      .where(inArray(aiUsage.id, db.select({ id: aiUsage.id }).from(aiUsage).where(expired).limit(limit)))
      .returning({ id: aiUsage.id })
    return rows.length
  }, options)
}
