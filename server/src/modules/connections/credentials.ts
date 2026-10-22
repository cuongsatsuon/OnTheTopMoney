// Token của trang cho module khác (AD-5): gọi `getAccessToken(pageId)` ngay trước mỗi lời gọi Meta, không cache.
// Trang IG không có token riêng → lấy token của Fanpage nguồn (`token_source_page_id`).
// Từ chối khi trang đã gỡ (`PAGE_REMOVED`) hoặc mất kết nối (`PAGE_DISCONNECTED`); IG mà Fanpage nguồn đã gỡ
// hoặc mất kết nối cũng `PAGE_DISCONNECTED` (phải kết nối lại Fanpage).
import { eq } from 'drizzle-orm'
import type { SecretCipher } from '../../adapters/crypto/index.ts'
import type { DbExecutor } from '../../platform/db/index.ts'
import { AppError } from '../../platform/errors/index.ts'
import { getPage } from '../pages/index.ts'
import { pageCredentials } from './schema.ts'

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
