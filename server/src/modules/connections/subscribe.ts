// Story 4.2 (AD-4, AD-5, AD-24): tự đăng ký webhook cho trang đã kết nối — job `connections.subscribe_page`.
// - Fanpage: `POST /{platformAccountId}/subscribed_apps` với `subscribed_fields` của Page, token Page.
// - Instagram: không có token riêng → đăng ký Fanpage nguồn (`token_source_page_id`) với cùng field. Field IG
//   (`messages`, `comments`) bật ở cấp app — bước làm một lần (runbook), không gọi API ở đây.
// - Threads: không có API đăng ký theo tài khoản (field `replies` bật ở cấp app) → ghi thành công, không gọi mạng.
// Token lấy bằng `getAccessToken` ngay trước khi gọi (AD-5); không bao giờ log token. Không gọi Meta trong
// transaction. Kết quả lưu trên `page_credentials` (không đụng `updated_at` — mốc tuổi token Threads):
// - thành công → `webhook_subscribed_at = now`, xoá lỗi cũ;
// - `PERMISSION_DENIED` / `REJECTED` / lỗi khác không retry được → lưu mã, job kết thúc (không retry);
// - `TOKEN_INVALID` → `markDisconnected` (Fanpage giữ token + IG dùng chung) + lưu mã;
// - `RATE_LIMITED` / `TRANSIENT` → ném để pg-boss retry (policy `connections.*`); hết retry → `FAILED`.
// Trang đã gỡ hoặc mất kết nối lúc job chạy → bỏ qua, không lỗi.
import { WEBHOOK_FIELDS, type PageSubscriptionError, type Platform, type WebhookSubscribeError } from '@ottm/shared'
import { and, eq, isNotNull, isNull } from 'drizzle-orm'
import type { SecretCipher } from '../../adapters/crypto/index.ts'
import type { MetaClient, MetaErrorKind } from '../../adapters/meta/index.ts'
import { bossDbFor, type Db, type DbExecutor } from '../../platform/db/index.ts'
import { AppError } from '../../platform/errors/index.ts'
import type { EventPublisher } from '../../platform/events/index.ts'
import type { JobSender } from '../../platform/jobs/index.ts'
import { getPage, getPlatformAccountId, listPages } from '../pages/index.ts'
import { getAccessToken } from './credentials.ts'
import type { ConnectionsLogger } from './deps.ts'
import { pageCredentials } from './schema.ts'
import { markDisconnected, REASON_TOKEN_INVALID } from './token-check.ts'

/** Field đăng ký trên Fanpage (cả khi đăng ký thay cho IG liên kết). */
export const PAGE_SUBSCRIBED_FIELDS = WEBHOOK_FIELDS.page.join(',')

export interface SubscribePageDeps {
  db: Db
  events: EventPublisher
  /** `null` khi máy chủ chưa có khoá chủ → `getAccessToken` ném `ENCRYPTION_NOT_CONFIGURED` (job lỗi, retry). */
  cipher: SecretCipher | null
  /** Client Graph (fake khi `META_FAKE=1`). */
  graph: MetaClient
  log?: ConnectionsLogger
  now?: () => Date
}

export type SubscribeOutcome =
  | { status: 'subscribed'; network: boolean }
  /** Trang không còn (đã gỡ / không tồn tại) hoặc mất kết nối → bỏ qua, không ghi gì. */
  | { status: 'skipped' }
  | { status: 'failed'; errorCode: WebhookSubscribeError }

/** Lỗi retry được của job (`RATE_LIMITED`/`TRANSIENT`): handler ném lại để pg-boss retry. Không mang token/URL. */
export class SubscribeRetryableError extends Error {
  readonly kind: MetaErrorKind
  constructor(kind: MetaErrorKind) {
    super(`connections.subscribe_page: ${kind}`)
    this.name = 'SubscribeRetryableError'
    this.kind = kind
  }
}

/** Kind lỗi Meta → mã chẩn đoán lưu ở `webhook_subscribe_error` (chỉ các kind không retry). */
function errorCodeOf(kind: MetaErrorKind): WebhookSubscribeError {
  if (kind === 'PERMISSION_DENIED' || kind === 'TOKEN_INVALID' || kind === 'REJECTED') return kind
  return 'FAILED'
}

async function recordSuccess(db: DbExecutor, pageId: string, at: Date): Promise<void> {
  await db
    .update(pageCredentials)
    .set({ webhookSubscribedAt: at, webhookSubscribeError: null })
    .where(eq(pageCredentials.pageId, pageId))
}

/** Ghi mã lỗi đăng ký cho một trang (không đụng `webhook_subscribed_at` của lần thành công trước). */
export async function recordSubscribeError(db: DbExecutor, pageId: string, errorCode: WebhookSubscribeError): Promise<void> {
  await db.update(pageCredentials).set({ webhookSubscribeError: errorCode }).where(eq(pageCredentials.pageId, pageId))
}

const isGone = (err: unknown) => err instanceof AppError && (err.code === 'PAGE_REMOVED' || err.code === 'PAGE_DISCONNECTED')

/**
 * Đăng ký webhook cho một trang (handler của `connections.subscribe_page`). Idempotent: đăng ký lại cùng field
 * là no-op phía Meta, kết quả ghi đè lần trước.
 */
export async function subscribePage(deps: SubscribePageDeps, pageId: string): Promise<SubscribeOutcome> {
  const now = () => deps.now?.() ?? new Date()
  const page = await getPage(deps.db, pageId)
  if (!page || page.connectionStatus === 'disconnected') return { status: 'skipped' }

  // Threads: field `replies` bật ở cấp app; không có API theo tài khoản → ghi thành công, không gọi mạng.
  if (page.platform === 'threads') {
    await recordSuccess(deps.db, pageId, now())
    return { status: 'subscribed', network: false }
  }

  // Fanpage tự đăng ký; IG đăng ký Fanpage nguồn (token cũng của Fanpage đó).
  let target = page
  if (page.platform === 'instagram') {
    const [cred] = await deps.db
      .select({ tokenSourcePageId: pageCredentials.tokenSourcePageId })
      .from(pageCredentials)
      .where(eq(pageCredentials.pageId, pageId))
    const source = cred?.tokenSourcePageId ? await getPage(deps.db, cred.tokenSourcePageId) : null
    if (!source || source.connectionStatus === 'disconnected') return { status: 'skipped' }
    target = source
  }

  const targetAccountId = await getPlatformAccountId(deps.db, target.id)
  if (!targetAccountId) return { status: 'skipped' }

  let token: string
  try {
    // Lấy token ngay trước khi gọi (AD-5); IG → token của Fanpage nguồn.
    token = await getAccessToken({ db: deps.db, cipher: deps.cipher }, pageId)
  } catch (err) {
    if (isGone(err)) return { status: 'skipped' }
    throw err
  }

  // Scope `page:<id nền tảng>` trùng scope BUC mà adapter ghi từ header → tôn trọng chặn theo trang.
  const res = await deps.graph.post<{ success?: boolean }>(`/${targetAccountId}/subscribed_apps`, {
    token,
    tier: 'background',
    scope: `page:${targetAccountId}`,
    params: { subscribed_fields: PAGE_SUBSCRIBED_FIELDS },
  })

  if (res.ok) {
    if (res.data?.success === false) {
      await recordSubscribeError(deps.db, pageId, 'REJECTED')
      deps.log?.warn({ pageId, errorCode: 'REJECTED' }, 'connections: Meta từ chối đăng ký webhook trang')
      return { status: 'failed', errorCode: 'REJECTED' }
    }
    await recordSuccess(deps.db, pageId, now())
    deps.log?.info({ pageId, targetPageId: target.id }, 'connections: đã đăng ký webhook trang')
    return { status: 'subscribed', network: true }
  }

  if (res.kind === 'RATE_LIMITED' || res.kind === 'TRANSIENT') throw new SubscribeRetryableError(res.kind)

  const errorCode = errorCodeOf(res.kind)
  if (res.kind === 'TOKEN_INVALID') {
    // Token hỏng thuộc Fanpage (của chính nó, hoặc Fanpage nguồn của IG) → Fanpage + mọi IG dùng chung mất kết nối.
    await markDisconnected(deps, target.id, REASON_TOKEN_INVALID)
  }
  await recordSubscribeError(deps.db, pageId, errorCode)
  deps.log?.warn({ pageId, errorCode, code: res.code, subcode: res.subcode }, 'connections: đăng ký webhook trang lỗi')
  return { status: 'failed', errorCode }
}

/** Phụ thuộc của handler job (tách để unit-test nhánh "hết retry → FAILED" không cần DB). */
export interface SubscribeJobHandlerDeps {
  subscribe: (pageId: string) => Promise<unknown>
  markFailed: (pageId: string, errorCode: WebhookSubscribeError) => Promise<void>
}

export function parseSubscribeJobData(data: unknown): { pageId: string } {
  const id = (data as { pageId?: unknown } | null)?.pageId
  if (typeof id !== 'string' || id === '') throw new Error('connections.subscribe_page: thiếu pageId')
  return { pageId: id }
}

/**
 * Handler job `connections.subscribe_page`: lỗi ném ra (retry được, hoặc lỗi bất ngờ) được ném lại để pg-boss
 * retry; ở lần thử CUỐI ghi `FAILED` cho trang trước khi ném (để trang hiện lỗi và không bị chạy bù lại mãi).
 */
export async function handleSubscribeJob(
  deps: SubscribeJobHandlerDeps,
  job: { data: unknown; retryCount: number; retryLimit: number },
): Promise<void> {
  const { pageId } = parseSubscribeJobData(job.data)
  try {
    await deps.subscribe(pageId)
  } catch (err) {
    if (job.retryCount >= job.retryLimit) await deps.markFailed(pageId, 'FAILED').catch(() => {})
    throw err
  }
}

/** Enqueue đăng ký webhook cho một trang trong transaction đang mở (AD-2): job chỉ tồn tại khi commit. */
export async function enqueueSubscribePage(tx: DbExecutor, jobs: JobSender, pageId: string): Promise<void> {
  await jobs.send('connections.subscribe_page', { pageId }, { db: bossDbFor(tx) })
}

/**
 * Chạy bù (worker khởi động): enqueue cho mọi trang chưa gỡ, không `disconnected`, chưa từng đăng ký
 * (`webhook_subscribed_at IS NULL AND webhook_subscribe_error IS NULL`). Chạy lại an toàn: job idempotent.
 * Trả số job đã enqueue.
 */
export async function enqueueMissingSubscriptions(db: Db, jobs: JobSender): Promise<number> {
  return db.transaction(async (tx) => {
    const pages = (await listPages(tx)).filter((p) => p.connectionStatus !== 'disconnected')
    if (pages.length === 0) return 0
    const pending = await tx
      .select({ pageId: pageCredentials.pageId })
      .from(pageCredentials)
      .where(and(isNull(pageCredentials.webhookSubscribedAt), isNull(pageCredentials.webhookSubscribeError)))
    const pendingIds = new Set(pending.map((r) => r.pageId))
    let count = 0
    for (const page of pages) {
      if (!pendingIds.has(page.id)) continue
      await enqueueSubscribePage(tx, jobs, page.id)
      count += 1
    }
    return count
  })
}

/** Trang chưa gỡ có lỗi đăng ký webhook (cho `webhooks.getWebhookHealth`). Sắp theo thứ tự `listPages`. */
export async function listSubscriptionErrors(db: DbExecutor): Promise<PageSubscriptionError[]> {
  const rows = await db
    .select({ pageId: pageCredentials.pageId, errorCode: pageCredentials.webhookSubscribeError })
    .from(pageCredentials)
    .where(isNotNull(pageCredentials.webhookSubscribeError))
  if (rows.length === 0) return []
  const errorOf = new Map(rows.map((r) => [r.pageId, r.errorCode as WebhookSubscribeError]))
  const pages = await listPages(db)
  return pages
    .filter((p) => errorOf.has(p.id))
    .map((p) => ({ pageId: p.id, name: p.name, platform: p.platform as Platform, errorCode: errorOf.get(p.id)! }))
}
