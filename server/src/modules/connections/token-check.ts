// Story 2.4 (AD-3, AD-5): theo dõi hạn token và đánh dấu mất kết nối.
// - `computeConnectionStatus`: tính `active`/`expiring` từ mốc hết hạn. `expires_at = 0` nghĩa là không hết hạn
//   (thường gặp với token Page); mốc hết hạn = sớm nhất giữa `expires_at` và `data_access_expires_at` (bỏ 0/null);
//   còn ≤7 ngày → `expiring`. Hàm thuần, không gọi DB.
// - `markDisconnected`: một lời gọi Meta trả `TOKEN_INVALID` → chuyển trang đó VÀ mọi trang IG dùng chung
//   `token_source_page_id` sang `disconnected` kèm lý do, phát `page.disconnected` cho từng trang, trong một
//   transaction (AD-3). Chỉ `connections` ghi trạng thái (AD-5, qua `pages.setConnectionStatus`).
// - `runTokenCheck`: handler của cron `connections.token_check` (hằng ngày, giờ VN). Làm mới token Threads sắp hết
//   hạn (còn ≤15 ngày và token đã ≥24 giờ tuổi — Meta từ chối làm mới token quá mới), rồi tính lại trạng thái mọi
//   trang; trang mới chuyển sang `expiring` phát `page.expiring` MỘT LẦN mỗi chu kỳ (không lặp nếu đã `expiring`).
//   Lỗi không làm mới được (rate/transient) chỉ ghi log rồi bỏ qua; `TOKEN_INVALID` → `markDisconnected`.
import { eq } from 'drizzle-orm'
import type { SecretCipher } from '../../adapters/crypto/index.ts'
import type { MetaClient } from '../../adapters/meta/index.ts'
import type { Db, DbExecutor } from '../../platform/db/index.ts'
import type { EventPublisher } from '../../platform/events/index.ts'
import { getPage, listPages, setConnectionStatus } from '../pages/index.ts'
import type { ConnectionsLogger } from './deps.ts'
import { pageCredentials } from './schema.ts'

const DAY_S = 86_400
/** Còn ≤7 ngày tới mốc hết hạn sớm nhất → `expiring` (epic-2-context, Story 2.4). */
export const EXPIRING_WINDOW_S = 7 * DAY_S
/** Chỉ làm mới token Threads khi còn ≤15 ngày tới hạn. */
export const THREADS_REFRESH_WINDOW_S = 15 * DAY_S
/** Token Threads phải đã ≥24 giờ tuổi mới làm mới được (`th_refresh_token`). */
export const THREADS_MIN_AGE_S = 24 * 3600
/** Lý do nội bộ ghi vào `pages.connection_status_reason` (không trả ra client). */
export const REASON_TOKEN_EXPIRING = 'TOKEN_EXPIRING'
export const REASON_TOKEN_INVALID = 'TOKEN_INVALID'
/** Mốc hết hạn đã qua (token coi như hỏng) → `disconnected`. */
export const REASON_TOKEN_EXPIRED = 'TOKEN_EXPIRED'
/** Gỡ Fanpage nguồn token (Story 2.7) → IG dùng chung token mất kết nối. */
export const REASON_TOKEN_SOURCE_REMOVED = 'TOKEN_SOURCE_REMOVED'

export interface TokenCheckDeps {
  db: Db
  events: EventPublisher
  /** `null` khi máy chủ chưa có khoá chủ → không giải/làm mới được token (bỏ qua bước làm mới Threads). */
  cipher: SecretCipher | null
  /** Client Threads (fake khi `META_FAKE=1`); `undefined` khi chưa cấu hình app Threads → bỏ qua làm mới. */
  threads?: MetaClient | undefined
  now?: () => Date
  log?: ConnectionsLogger
}

/**
 * Mốc hết hạn hiệu lực (giây epoch): sớm nhất giữa `expires_at` và `data_access_expires_at`, bỏ qua giá trị 0/null
 * (0 = không hết hạn). `null` khi không mốc nào hữu hạn → token không hết hạn.
 */
export function effectiveExpiry(expiresAt: number, dataAccessExpiresAt: number | null): number | null {
  const marks = [expiresAt, dataAccessExpiresAt ?? 0].filter((v) => v > 0)
  return marks.length ? Math.min(...marks) : null
}

/**
 * Trạng thái suy từ mốc hết hạn: không hết hạn / còn xa → `active`; còn ≤7 ngày (chưa qua) → `expiring`; đã qua
 * mốc (hết hạn) → `disconnected`.
 */
export function computeConnectionStatus(
  cred: { expiresAt: number; dataAccessExpiresAt: number | null },
  nowSec: number,
): 'active' | 'expiring' | 'disconnected' {
  const exp = effectiveExpiry(cred.expiresAt, cred.dataAccessExpiresAt)
  if (exp === null) return 'active'
  const remaining = exp - nowSec
  if (remaining <= 0) return 'disconnected'
  return remaining <= EXPIRING_WINDOW_S ? 'expiring' : 'active'
}

/**
 * `TOKEN_INVALID` cho một trang: chuyển trang đó và mọi trang IG dùng chung token (`token_source_page_id = pageId`)
 * sang `disconnected`, phát `page.disconnected` cho từng trang (trong cùng transaction). Trang đã gỡ hoặc đã
 * `disconnected` được bỏ qua (không phát lại). Trả danh sách id đã chuyển.
 */
export async function markDisconnected(
  deps: Pick<TokenCheckDeps, 'db' | 'events' | 'log'>,
  pageId: string,
  reason: string = REASON_TOKEN_INVALID,
): Promise<string[]> {
  return deps.db.transaction((tx) => markDisconnectedTx(tx, deps, pageId, reason))
}

/**
 * Như `markDisconnected` nhưng chạy TRONG transaction của bên gọi (vd gỡ trang — Story 2.7 — cần cùng transaction
 * với soft-delete). Trang đã gỡ hoặc đã `disconnected` được bỏ qua: nên khi gọi lúc trang nguồn đã soft-delete,
 * chỉ các trang IG liên kết (`token_source_page_id = pageId`) bị chuyển `disconnected`, không đụng trang đã gỡ.
 */
export async function markDisconnectedTx(
  tx: DbExecutor,
  deps: Pick<TokenCheckDeps, 'events' | 'log'>,
  pageId: string,
  reason: string = REASON_TOKEN_INVALID,
): Promise<string[]> {
  const igRows = await tx
    .select({ pageId: pageCredentials.pageId })
    .from(pageCredentials)
    .where(eq(pageCredentials.tokenSourcePageId, pageId))
  const targets = [pageId, ...igRows.map((r) => r.pageId)]
  const changed: string[] = []
  const done = new Set<string>()
  for (const id of targets) {
    if (done.has(id)) continue
    done.add(id)
    const page = await getPage(tx, id)
    if (!page || page.connectionStatus === 'disconnected') continue
    await setConnectionStatus(tx, id, 'disconnected', reason)
    await deps.events.publishEvent(tx, 'page.disconnected', { id, pageId: id, reason, disconnectedAt: new Date().toISOString() })
    changed.push(id)
  }
  deps.log?.info({ pageId, reason, changed: changed.length }, 'connections: đánh dấu mất kết nối')
  return changed
}

/**
 * Làm mới token Threads của một trang (`th_refresh_token`): lưu token mới mã hoá + hạn mới. Trả `true` chỉ khi đã
 * lưu token mới thành công. `TOKEN_INVALID` → `markDisconnected`; lỗi khác (rate/transient) ghi log rồi bỏ qua.
 * Phản hồi thiếu `access_token` hoặc `expires_in` hợp lệ → coi như thất bại (KHÔNG lưu, không giữ hạn cũ để tránh
 * làm mới lại mỗi chu kỳ).
 */
async function refreshThreadsToken(deps: TokenCheckDeps, pageId: string, envelope: string, nowSec: number, now: Date): Promise<boolean> {
  if (!deps.threads || !deps.cipher) return false
  const token = deps.cipher.decrypt(envelope)
  const res = await deps.threads.get<{ access_token?: string; expires_in?: number }>('/refresh_access_token', {
    tier: 'background',
    scope: `threads:${pageId}`,
    unversioned: true,
    token,
    params: { grant_type: 'th_refresh_token' },
  })
  if (!res.ok) {
    if (res.kind === 'TOKEN_INVALID') await markDisconnected(deps, pageId, REASON_TOKEN_INVALID)
    else deps.log?.warn({ pageId, kind: res.kind }, 'connections: làm mới token Threads lỗi (bỏ qua)')
    return false
  }
  const newToken = res.data.access_token
  const expiresIn = res.data.expires_in
  if (!newToken || typeof expiresIn !== 'number' || expiresIn <= 0) {
    deps.log?.warn({ pageId }, 'connections: phản hồi làm mới Threads thiếu access_token / expires_in hợp lệ (bỏ qua)')
    return false
  }
  await deps.db
    .update(pageCredentials)
    .set({ accessToken: deps.cipher.encrypt(newToken), expiresAt: nowSec + expiresIn, updatedAt: now })
    .where(eq(pageCredentials.pageId, pageId))
  deps.log?.info({ pageId }, 'connections: đã làm mới token Threads')
  return true
}

/**
 * Chu kỳ cron hằng ngày: (1) làm mới token Threads đủ điều kiện; (2) tính lại trạng thái mọi trang chưa gỡ, chưa
 * mất kết nối; ghi qua `pages.setConnectionStatus`; phát `page.expiring` một lần cho trang MỚI chuyển sang
 * `expiring`. Trang `disconnected` không tự hồi phục ở đây (chỉ kết nối lại mới về `active`).
 */
export async function runTokenCheck(deps: TokenCheckDeps): Promise<{ refreshed: number; expiring: number }> {
  const now = deps.now?.() ?? new Date()
  const nowSec = Math.floor(now.getTime() / 1000)

  // 1) Làm mới token Threads: trang Threads (có token riêng), còn ≤15 ngày tới hạn, token đã ≥24 giờ tuổi.
  // Mỗi trang bọc try/catch riêng: một trang hỏng (giải mã lỗi / Threads reject) không được làm chết cả cron.
  let refreshed = 0
  const pages = await listPages(deps.db)
  const creds = await deps.db.select().from(pageCredentials)
  const credByPage = new Map(creds.map((c) => [c.pageId, c]))
  for (const page of pages) {
    if (page.platform !== 'threads' || page.connectionStatus === 'disconnected') continue
    const cred = credByPage.get(page.id)
    if (!cred?.accessToken || cred.expiresAt <= 0) continue
    if (cred.expiresAt - nowSec > THREADS_REFRESH_WINDOW_S) continue
    const ageS = nowSec - Math.floor(new Date(cred.updatedAt).getTime() / 1000)
    if (ageS < THREADS_MIN_AGE_S) continue
    try {
      if (await refreshThreadsToken(deps, page.id, cred.accessToken, nowSec, now)) refreshed += 1
    } catch (err) {
      deps.log?.warn({ pageId: page.id, err: err instanceof Error ? err.name : typeof err }, 'connections: làm mới token Threads ném — bỏ qua trang')
    }
  }

  // 2) Tính lại trạng thái mọi trang (độc lập với phase 1: dù phase 1 có trang hỏng vẫn chạy). Đọc lại cred vì
  // phase 1 có thể đã đổi hạn / ngắt kết nối.
  const expiring = await deps.db.transaction(async (tx) => {
    const fresh = await tx.select().from(pageCredentials)
    const byPage = new Map(fresh.map((c) => [c.pageId, c]))
    const current = await listPages(tx)
    let count = 0
    for (const page of current) {
      if (page.connectionStatus === 'disconnected') continue
      const cred = byPage.get(page.id)
      if (!cred) continue
      const status = computeConnectionStatus(cred, nowSec)
      if (status === page.connectionStatus) continue
      const reason = status === 'expiring' ? REASON_TOKEN_EXPIRING : status === 'disconnected' ? REASON_TOKEN_EXPIRED : null
      await setConnectionStatus(tx, page.id, status, reason)
      const exp = effectiveExpiry(cred.expiresAt, cred.dataAccessExpiresAt)
      // Chỉ trang MỚI chuyển sang `expiring` mới phát `page.expiring` (một lần mỗi chu kỳ).
      if (status === 'expiring' && exp !== null) {
        await deps.events.publishEvent(tx, 'page.expiring', { id: page.id, pageId: page.id, expiresAt: new Date(exp * 1000).toISOString() })
        count += 1
      }
      // Token đã hết hạn (mốc đã qua) → mất kết nối; phát `page.disconnected` một lần khi chuyển sang.
      if (status === 'disconnected') {
        await deps.events.publishEvent(tx, 'page.disconnected', { id: page.id, pageId: page.id, reason: REASON_TOKEN_EXPIRED, disconnectedAt: now.toISOString() })
      }
    }
    return count
  })
  return { refreshed, expiring }
}
