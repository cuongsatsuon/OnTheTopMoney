// Phần `autoreply` của luồng xoá (Story 9.2, AD-22, AD-1): queue `autoreply.purge` nghe `privacy.purge_requested` → xoá
// `autoreply_runs` theo `conversationIds` (khách) hoặc `pageIds` (trang / tài khoản), theo lô, rồi phát
// `privacy.purge_part_completed{module:'autoreply'}`. Idempotent: chạy lại chỉ xoá phần còn lại. Bảng chỉ có id (không
// nội dung), log chỉ mang id yêu cầu + số dòng.
import { PURGE_MODULES } from '@ottm/shared'
import { inArray, type SQL } from 'drizzle-orm'
import type { Db } from '../../platform/db/index.ts'
import { envelopePayload, type EventPublisher } from '../../platform/events/index.ts'
import { autoreplyRuns } from './schema.ts'

export const PURGE_BATCH = 1000

export interface AutoreplyPurgeDeps {
  db: Db
  events: EventPublisher
  batchSize?: number
}

export type PurgeResult = { requestId: string; deleted: number } | 'ignored'

export async function handleAutoreplyPurge(deps: AutoreplyPurgeDeps, data: unknown): Promise<PurgeResult> {
  const p = envelopePayload(data, 'privacy.purge_requested')
  if (!p || !PURGE_MODULES[p.scope].includes('autoreply')) return 'ignored'
  const where: SQL | null =
    p.scope === 'contact'
      ? (p.conversationIds?.length ?? 0) > 0
        ? inArray(autoreplyRuns.conversationId, p.conversationIds!)
        : null
      : (p.pageIds?.length ?? 0) > 0
        ? inArray(autoreplyRuns.pageId, p.pageIds!)
        : null
  const batch = deps.batchSize ?? PURGE_BATCH
  let deleted = 0
  while (where) {
    const rows = await deps.db
      .delete(autoreplyRuns)
      .where(inArray(autoreplyRuns.id, deps.db.select({ id: autoreplyRuns.id }).from(autoreplyRuns).where(where).limit(batch)))
      .returning({ id: autoreplyRuns.id })
    deleted += rows.length
    if (rows.length < batch) break
  }
  await deps.db.transaction((tx) => deps.events.publishEvent(tx, 'privacy.purge_part_completed', { id: p.id, module: 'autoreply' }))
  return { requestId: p.id, deleted }
}
