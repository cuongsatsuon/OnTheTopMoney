// Phần `connections` của luồng xoá (Story 9.2, AD-22 — việc hoãn của 9.1 "ai xoá `meta_accounts`"), chỉ `scope=all`:
// queue `connections.purge` nghe `privacy.purge_requested` → xoá dòng `meta_accounts` của yêu cầu (`metaAccountId`, ảnh
// chụp lúc nhận callback: `fb_user_id`, tên, user token). Khoá ngoại tự `set null` (`page_credentials.meta_account_id`,
// `oauth_results.meta_account_id`). Rồi phát `privacy.purge_part_completed{module:'connections'}`. Idempotent.
// Token TRANG giữ nguyên [quyết định 9.2, hẹp]: trang đã bị ngắt (deauthorize) hoặc vẫn chạy (chỉ xin xoá dữ liệu) — chủ
// shop gỡ / kết nối lại như thường; không xoá cứng dòng `pages`.
import { PURGE_MODULES } from '@ottm/shared'
import { eq } from 'drizzle-orm'
import type { Db } from '../../platform/db/index.ts'
import { envelopePayload, type EventPublisher } from '../../platform/events/index.ts'
import { metaAccounts } from './schema.ts'

export interface ConnectionsPurgeDeps {
  db: Db
  events: EventPublisher
}

export async function handleConnectionsPurge(deps: ConnectionsPurgeDeps, data: unknown): Promise<{ requestId: string; accounts: number } | 'ignored'> {
  const p = envelopePayload(data, 'privacy.purge_requested')
  if (!p || !PURGE_MODULES[p.scope].includes('connections')) return 'ignored'
  return deps.db.transaction(async (tx) => {
    const removed = p.metaAccountId ? await tx.delete(metaAccounts).where(eq(metaAccounts.id, p.metaAccountId)).returning({ id: metaAccounts.id }) : []
    await deps.events.publishEvent(tx, 'privacy.purge_part_completed', { id: p.id, module: 'connections' })
    return { requestId: p.id, accounts: removed.length }
  })
}
