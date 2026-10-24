// Phần `ai` của luồng xoá (Story 9.2, AD-22, AD-1): queue `ai.purge` nghe `privacy.purge_requested` → bỏ tham chiếu
// (`ai_usage.ref = null`) tới khách / hội thoại (`contact`: `contactId` + `conversationIds`) hoặc mọi dòng của `pageIds`
// (`page|all`), theo lô, rồi phát `privacy.purge_part_completed{module:'ai'}`. Dòng chi phí GIỮ NGUYÊN: hạn mức tháng
// cộng từ bảng này, và dòng không chứa prompt / nội dung (AD-12) — chỉ `ref` trỏ về dữ liệu của khách. Idempotent.
import { PURGE_MODULES } from '@ottm/shared'
import { and, inArray, isNotNull, type SQL } from 'drizzle-orm'
import type { Db } from '../../platform/db/index.ts'
import { envelopePayload, type EventPublisher } from '../../platform/events/index.ts'
import { aiUsage } from './schema.ts'

export const PURGE_BATCH = 1000

export interface AiPurgeDeps {
  db: Db
  events: EventPublisher
  batchSize?: number
}

export async function handleAiPurge(deps: AiPurgeDeps, data: unknown): Promise<{ requestId: string; cleared: number } | 'ignored'> {
  const p = envelopePayload(data, 'privacy.purge_requested')
  if (!p || !PURGE_MODULES[p.scope].includes('ai')) return 'ignored'
  let where: SQL | null = null
  if (p.scope === 'contact') {
    const refs = [...(p.targetId ? [p.targetId] : []), ...(p.conversationIds ?? [])]
    if (refs.length > 0) where = inArray(aiUsage.ref, refs)
  } else if ((p.pageIds?.length ?? 0) > 0) {
    where = and(inArray(aiUsage.pageId, p.pageIds!), isNotNull(aiUsage.ref))!
  }
  const batch = deps.batchSize ?? PURGE_BATCH
  let cleared = 0
  while (where) {
    const rows = await deps.db
      .update(aiUsage)
      .set({ ref: null })
      .where(inArray(aiUsage.id, deps.db.select({ id: aiUsage.id }).from(aiUsage).where(where).limit(batch)))
      .returning({ id: aiUsage.id })
    cleared += rows.length
    if (rows.length < batch) break
  }
  await deps.db.transaction((tx) => deps.events.publishEvent(tx, 'privacy.purge_part_completed', { id: p.id, module: 'ai' }))
  return { requestId: p.id, cleared }
}
