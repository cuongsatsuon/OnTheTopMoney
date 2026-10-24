// Story 9.4 (AD-22, AD-5): callback quyền riêng tư của Threads app (app Meta riêng, token riêng, không có `meta_accounts`).
// `user_id` trong `signed_request` của Threads app so với `pages.platform_account_id` của trang `threads` [ASSUMPTION: cùng
// id `/me` của Threads — kiểm sau Live, `deploy/app-review.md` mục 8].
// - `threadsUserPurgeScope`: ảnh chụp phạm vi xoá `scope=all` của người dùng Threads — trang Threads của đúng tài khoản đó
//   (kể cả đã gỡ: dữ liệu còn tới khi bị dọn), `metaAccountId = null`. `null` = app không giữ dữ liệu gì của người này.
// - `disconnectThreadsUserTx`: người dùng gỡ app khỏi Threads → trang Threads (chưa gỡ) sang `disconnected` qua
//   `markDisconnectedTx` trong transaction của bên gọi. Trang Facebook / Instagram và trang Threads khác không bị đụng.
import { findPageRefByPlatformAccount } from '../pages/index.ts'
import type { DbExecutor } from '../../platform/db/index.ts'
import { markDisconnectedTx, type TokenCheckDeps } from './token-check.ts'

/** Lý do nội bộ ghi vào `pages.connection_status_reason` khi người dùng gỡ app trên Threads. */
export const REASON_THREADS_DEAUTHORIZED = 'THREADS_DEAUTHORIZED'

export async function threadsUserPurgeScope(tx: DbExecutor, threadsUserId: string): Promise<{ metaAccountId: null; pageIds: string[] } | null> {
  const page = await findPageRefByPlatformAccount(tx, 'threads', threadsUserId)
  return page ? { metaAccountId: null, pageIds: [page.id] } : null
}

export async function disconnectThreadsUserTx(
  tx: DbExecutor,
  deps: Pick<TokenCheckDeps, 'events' | 'log'>,
  threadsUserId: string,
): Promise<{ known: boolean; disconnected: string[] }> {
  const page = await findPageRefByPlatformAccount(tx, 'threads', threadsUserId)
  if (!page) return { known: false, disconnected: [] }
  if (page.removed) return { known: true, disconnected: [] }
  return { known: true, disconnected: await markDisconnectedTx(tx, deps, page.id, REASON_THREADS_DEAUTHORIZED) }
}
