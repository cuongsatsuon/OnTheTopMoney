// Token của trang cho module khác (AD-5): gọi `getAccessToken(pageId)` ngay trước mỗi lời gọi Meta, không cache.
// Trang IG không có token riêng → lấy token của Fanpage nguồn (`token_source_page_id`).
// Từ chối khi trang đã gỡ (`PAGE_REMOVED`) hoặc mất kết nối (`PAGE_DISCONNECTED`); IG mà Fanpage nguồn đã gỡ
// hoặc mất kết nối cũng `PAGE_DISCONNECTED` (phải kết nối lại Fanpage).
import { eq } from 'drizzle-orm'
import type { SecretCipher } from '../../adapters/crypto/index.ts'
import type { Db, DbExecutor } from '../../platform/db/index.ts'
import { AppError } from '../../platform/errors/index.ts'
import type { EventPublisher } from '../../platform/events/index.ts'
import { getPage, setRemoved } from '../pages/index.ts'
import { pageCredentials } from './schema.ts'
import { markDisconnectedTx, REASON_TOKEN_SOURCE_REMOVED } from './token-check.ts'

const disconnected = (message: string) => new AppError('PAGE_DISCONNECTED', 409, { message })

export async function getAccessToken(deps: { db: DbExecutor; cipher: SecretCipher | null }, pageId: string): Promise<string> {
  const page = await getPage(deps.db, pageId)
  if (!page) throw new AppError('PAGE_REMOVED', 409, { message: 'Trang không tồn tại hoặc đã gỡ' })
  if (page.connectionStatus === 'disconnected') throw disconnected('Trang đã mất kết nối')
  const [cred] = await deps.db.select().from(pageCredentials).where(eq(pageCredentials.pageId, pageId))
  if (!cred) throw disconnected('Trang chưa có token')
  let envelope = cred.accessToken
  if (cred.tokenSourcePageId) {
    const source = await getPage(deps.db, cred.tokenSourcePageId)
    if (!source) throw disconnected('Fanpage nguồn đã gỡ')
    if (source.connectionStatus === 'disconnected') throw disconnected('Fanpage nguồn đã mất kết nối')
    const [sourceCred] = await deps.db.select().from(pageCredentials).where(eq(pageCredentials.pageId, cred.tokenSourcePageId))
    envelope = sourceCred?.accessToken ?? null
  }
  if (!envelope) throw disconnected('Fanpage nguồn chưa có token')
  if (!deps.cipher) throw new AppError('ENCRYPTION_NOT_CONFIGURED', 500, { message: 'APP_ENCRYPTION_KEYS chưa đặt' })
  return deps.cipher.decrypt(envelope)
}

/**
 * Gỡ một trang khỏi app (Story 2.7): trong MỘT transaction (AD-3) soft-delete trang (`pages.setRemoved` đặt
 * `removed_at` + phát `page.removed`) rồi xoá token của chính trang đó (`page_credentials`). Giữ toàn bộ lịch sử —
 * chỉ đánh dấu trang đã gỡ. Trả `true` khi vừa gỡ; `false` khi trang không tồn tại hoặc đã gỡ (route → 404,
 * nhất quán với `getPage`/`resolveScope`). Kết nối lại sau đó: `upsertFromPlatform` khôi phục đúng dòng cũ.
 *
 * Ranh giới token (AD-5): chỉ xoá credential của TRANG ĐƯỢC CHỌN. Nếu trang là Fanpage nguồn token cho các tài
 * khoản Instagram Business liên kết (`token_source_page_id` trỏ về nó), những IG đó mất khả năng gọi Meta → trong
 * cùng transaction chuyển chúng sang `disconnected` (reason `TOKEN_SOURCE_REMOVED`) và phát `page.disconnected`
 * (dùng lại `markDisconnectedTx` của Story 2.4). Không đụng trạng thái trang vừa gỡ (đã `removed`, bị bỏ qua).
 */
export async function removePage(deps: { db: Db; events: EventPublisher }, pageId: string): Promise<boolean> {
  return deps.db.transaction(async (tx) => {
    const removed = await setRemoved(tx, deps.events, pageId)
    if (!removed) return false
    await tx.delete(pageCredentials).where(eq(pageCredentials.pageId, pageId))
    // Trang vừa gỡ đã `removed` → markDisconnectedTx bỏ qua nó; chỉ các IG liên kết bị chuyển `disconnected`.
    await markDisconnectedTx(tx, { events: deps.events }, pageId, REASON_TOKEN_SOURCE_REMOVED)
    return true
  })
}
