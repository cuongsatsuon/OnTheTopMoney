// Dọn theo hạn của `webhooks` (Story 9.3, AD-22): cron `privacy.retention` (ghép ở worker) gọi `purgeExpiredPayloads` —
// payload thô quá `RETENTION.webhookPayloadDays` (tính theo `received_at`) bị đặt `null`, GIỮ dòng (sản phẩm, trang,
// field, trạng thái, mốc giờ, khoá chống trùng) cho nhật ký Cài đặt › Webhook và sức khoẻ. Mọi trạng thái đều dọn, kể cả
// `failed` (không "Xử lý lại" được nữa) và `received` kẹt — nội dung tin của khách không giữ quá hạn. Theo lô qua index
// một phần `payload is not null`; chạy lại chỉ dọn phần còn lại.
import { DAY_MS, RETENTION } from '@ottm/shared'
import { and, inArray, isNotNull, lt } from 'drizzle-orm'
import { runInBatches, type BatchOptions, type BatchResult, type Db } from '../../platform/db/index.ts'
import { webhookEvents } from './schema.ts'

export async function purgeExpiredPayloads(db: Db, options: BatchOptions & { now?: Date } = {}): Promise<BatchResult> {
  const cutoff = new Date((options.now ?? new Date()).getTime() - RETENTION.webhookPayloadDays * DAY_MS)
  const expired = and(isNotNull(webhookEvents.payload), lt(webhookEvents.receivedAt, cutoff))
  return runInBatches(async (limit) => {
    const rows = await db
      .update(webhookEvents)
      .set({ payload: null })
      .where(inArray(webhookEvents.id, db.select({ id: webhookEvents.id }).from(webhookEvents).where(expired).limit(limit)))
      .returning({ id: webhookEvents.id })
    return rows.length
  }, options)
}
