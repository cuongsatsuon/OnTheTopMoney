// Phần `webhooks` của luồng xoá (Story 9.2, AD-22, AD-1): queue `webhooks.purge` nghe `privacy.purge_requested` → xoá
// HẲN dòng `webhook_events` có payload thô liên quan (mục webhook chứa nội dung tin của khách), theo lô, rồi phát
// `privacy.purge_part_completed{module:'webhooks'}`.
// - `contact`: `inbox.purgeMatchKeys` (inbox chưa xoá — nó xoá sau cùng) cho các id nền tảng của khách: id người dùng
//   của mọi định danh, `thread_key` của hội thoại, id tin. Một mục liên quan khi payload (dạng chữ) chứa một id đó trong
//   ngoặc kép (`"<id>"`, so khớp nguyên chuỗi — số trần như `timestamp` không có ngoặc kép). Id lạ trùng nhau gần như
//   không xảy ra; lỡ trùng thì chỉ mất thêm một dòng nhật ký chẩn đoán.
// - `page|all`: mọi mục của `pageIds` — theo `page_id` (đã route) hoặc `platform_page_id` + sản phẩm (mục chưa route được).
// Id nền tảng chỉ nằm trong câu SQL, không log, không vào payload job. Idempotent: chạy lại chỉ xoá phần còn lại.
import { PURGE_MODULES, type Platform, type WebhookProduct } from '@ottm/shared'
import { and, eq, inArray, or, sql, type SQL } from 'drizzle-orm'
import { purgeMatchKeys } from '../inbox/index.ts'
import { platformAccountIdsOf } from '../pages/index.ts'
import type { Db, DbExecutor } from '../../platform/db/index.ts'
import { envelopePayload, type EventPublisher } from '../../platform/events/index.ts'
import { webhookEvents } from './schema.ts'

export const PURGE_BATCH = 500
/** Số id mỗi câu `like any(...)` — giữ câu lệnh vừa phải khi khách có nhiều tin. */
const KEYS_PER_QUERY = 200

const PRODUCT_OF: Record<Platform, WebhookProduct> = { facebook: 'meta', instagram: 'meta', threads: 'threads' }

export interface WebhooksPurgeDeps {
  db: Db
  events: EventPublisher
  batchSize?: number
}

/** `"<id>"` thành mẫu LIKE (thoát `\`, `%`, `_` — id tin Meta có `_`). */
const quotedPattern = (key: string) => `%"${key.replace(/[\\%_]/g, (c) => `\\${c}`)}"%`

async function deleteWhere(db: DbExecutor, where: SQL, batch: number): Promise<number> {
  let deleted = 0
  for (;;) {
    const rows = await db
      .delete(webhookEvents)
      .where(inArray(webhookEvents.id, db.select({ id: webhookEvents.id }).from(webhookEvents).where(where).limit(batch)))
      .returning({ id: webhookEvents.id })
    deleted += rows.length
    if (rows.length < batch) return deleted
  }
}

export async function handleWebhooksPurge(deps: WebhooksPurgeDeps, data: unknown): Promise<{ requestId: string; deleted: number } | 'ignored'> {
  const p = envelopePayload(data, 'privacy.purge_requested')
  if (!p || !PURGE_MODULES[p.scope].includes('webhooks')) return 'ignored'
  const batch = deps.batchSize ?? PURGE_BATCH
  let deleted = 0
  if (p.scope === 'contact') {
    const keys = p.targetId ? await purgeMatchKeys(deps.db, p.targetId, p.conversationIds ?? []) : []
    for (let i = 0; i < keys.length; i += KEYS_PER_QUERY) {
      const patterns = keys.slice(i, i + KEYS_PER_QUERY).map(quotedPattern)
      deleted += await deleteWhere(deps.db, sql`${webhookEvents.payload}::text like any(array[${sql.join(patterns.map((pt) => sql`${pt}`), sql`, `)}]::text[])`, batch)
    }
  } else if ((p.pageIds?.length ?? 0) > 0) {
    const platformIds = await platformAccountIdsOf(deps.db, p.pageIds!)
    const where = or(
      inArray(webhookEvents.pageId, p.pageIds!),
      ...platformIds.map((pg) => and(eq(webhookEvents.product, PRODUCT_OF[pg.platform]), eq(webhookEvents.platformPageId, pg.platformAccountId))),
    )!
    deleted += await deleteWhere(deps.db, where, batch)
  }
  await deps.db.transaction((tx) => deps.events.publishEvent(tx, 'privacy.purge_part_completed', { id: p.id, module: 'webhooks' }))
  return { requestId: p.id, deleted }
}
