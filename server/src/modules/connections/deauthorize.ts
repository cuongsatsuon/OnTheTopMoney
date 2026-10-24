// Story 9.1 (AD-22, AD-5): người dùng Meta gỡ app khỏi Facebook → app ngắt mọi trang lấy token qua tài khoản đó.
// - `isKnownMetaUser`: app có giữ tài khoản Meta theo id theo app (`meta_accounts.fb_user_id` = `user_id` của
//   `signed_request`) không — `privacy` dùng để quyết có gì để xoá.
// - `disconnectMetaUserTx`: trong transaction của bên gọi, chuyển mọi trang có `page_credentials.meta_account_id` của
//   tài khoản (kèm IG dùng chung token Fanpage) sang `disconnected` qua `markDisconnectedTx` (phát `page.disconnected`,
//   bỏ qua trang đã gỡ / đã ngắt — gọi lại không phát lại). Trang Threads (app/token riêng) không bị đụng.
// - Story 9.2 `metaUserPurgeScope`: ảnh chụp phạm vi xoá `scope=all` của người dùng — dòng `meta_accounts` + trang
//   lấy token qua tài khoản (Fanpage có `meta_account_id`, IG có `token_source_page_id` về các Fanpage đó). Không có
//   Threads, không có trang của tài khoản Meta khác (hẹp, an toàn: gỡ app Facebook không xoá dữ liệu Threads).
import { eq, inArray, or } from 'drizzle-orm'
import type { DbExecutor } from '../../platform/db/index.ts'
import { markDisconnectedTx, type TokenCheckDeps } from './token-check.ts'
import { metaAccounts, pageCredentials } from './schema.ts'

/** Lý do nội bộ ghi vào `pages.connection_status_reason` khi người dùng gỡ app trên Facebook. */
export const REASON_META_DEAUTHORIZED = 'META_DEAUTHORIZED'

async function findAccountId(tx: DbExecutor, fbUserId: string): Promise<string | null> {
  const [row] = await tx.select({ id: metaAccounts.id }).from(metaAccounts).where(eq(metaAccounts.fbUserId, fbUserId))
  return row?.id ?? null
}

export async function isKnownMetaUser(tx: DbExecutor, fbUserId: string): Promise<boolean> {
  return (await findAccountId(tx, fbUserId)) !== null
}

export async function disconnectMetaUserTx(
  tx: DbExecutor,
  deps: Pick<TokenCheckDeps, 'events' | 'log'>,
  fbUserId: string,
): Promise<{ known: boolean; disconnected: string[] }> {
  const accountId = await findAccountId(tx, fbUserId)
  if (!accountId) return { known: false, disconnected: [] }
  const rows = await tx
    .select({ pageId: pageCredentials.pageId })
    .from(pageCredentials)
    .where(eq(pageCredentials.metaAccountId, accountId))
  const disconnected: string[] = []
  for (const { pageId } of rows) {
    for (const id of await markDisconnectedTx(tx, deps, pageId, REASON_META_DEAUTHORIZED)) {
      if (!disconnected.includes(id)) disconnected.push(id)
    }
  }
  return { known: true, disconnected }
}

export async function metaUserPurgeScope(tx: DbExecutor, fbUserId: string): Promise<{ metaAccountId: string; pageIds: string[] } | null> {
  const accountId = await findAccountId(tx, fbUserId)
  if (!accountId) return null
  const own = (await tx.select({ pageId: pageCredentials.pageId }).from(pageCredentials).where(eq(pageCredentials.metaAccountId, accountId))).map((r) => r.pageId)
  const rows =
    own.length === 0
      ? []
      : await tx
          .select({ pageId: pageCredentials.pageId })
          .from(pageCredentials)
          .where(or(inArray(pageCredentials.pageId, own), inArray(pageCredentials.tokenSourcePageId, own)))
  return { metaAccountId: accountId, pageIds: [...new Set(rows.map((r) => r.pageId))].sort() }
}
