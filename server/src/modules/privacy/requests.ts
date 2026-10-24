// Yêu cầu xoá dữ liệu (Story 9.1, 9.2 — AD-22). Chỉ entrypoint gọi qua index.ts.
// - `recordMetaRequest`: ghi yêu cầu từ callback Meta, idempotent theo người dùng (`subject_hash`), phát
//   `privacy.purge_requested` trong CÙNG transaction của bên gọi. Người dùng app không giữ dữ liệu gì (`known=false`)
//   → dòng `completed` + `matched=false`, KHÔNG phát sự kiện (một tài khoản lạ không được kích hoạt xoá dữ liệu shop).
//   Story 9.2: kèm ảnh chụp phạm vi (`pageIds`, `metaAccountId`) và `issued_at`; `findMetaReplay` chặn phát lại.
// - `requestTargetDeletion`: yêu cầu `contact` (chủ shop bấm xoá) / `page` (cron trang gỡ quá 30 ngày), mỗi đích tối đa
//   một yêu cầu đang mở.
// - `getRequestByCode`: đọc trạng thái (kèm tiến độ phần) cho trang công khai `/privacy/status/<code>`.
// Việc xoá thật ở consumer `<module>.purge` của từng module; điều phối giai đoạn ở `coordinator.ts`.
import { purgePartCount, type CallbackDeletionSource, type DeletionScope, type DeletionSource, type DeletionStatus } from '@ottm/shared'
import { createHmac, randomBytes } from 'node:crypto'
import { and, count, desc, eq, sql } from 'drizzle-orm'
import type { DbExecutor } from '../../platform/db/index.ts'
import type { EventPublisher } from '../../platform/events/index.ts'
import { deletionRequestParts, deletionRequests } from './schema.ts'

/** Mã xác nhận: 16 byte ngẫu nhiên dạng hex. */
export const CONFIRMATION_CODE_RE = /^[0-9a-f]{32}$/

export function newConfirmationCode(): string {
  return randomBytes(16).toString('hex')
}

/**
 * Khoá idempotent của một người dùng Meta: HMAC-SHA256(app secret, `meta-user:<id>`) — không lưu id thô. Đổi app
 * secret thì khoá đổi theo (cùng lắm sinh thêm một yêu cầu trùng — vô hại vì xoá idempotent).
 */
export function metaSubjectHash(appSecret: string, userId: string): string {
  return createHmac('sha256', appSecret).update(`meta-user:${userId}`).digest('hex')
}

/**
 * Story 9.4: khoá idempotent của một người dùng Threads app — HMAC-SHA256(Threads app secret, `threads-user:<id>`). Tiền
 * tố khác `meta-user:` nên id trùng nhau giữa hai app không chung khoá (hai người khác nhau, hai yêu cầu riêng).
 */
export function threadsSubjectHash(appSecret: string, userId: string): string {
  return createHmac('sha256', appSecret).update(`threads-user:${userId}`).digest('hex')
}

export interface DeletionRequestView {
  id: string
  code: string
  scope: DeletionScope
  targetId: string | null
  status: DeletionStatus
  source: DeletionSource
  matched: boolean
  requestedAt: Date
  completedAt: Date | null
}

export type Row = typeof deletionRequests.$inferSelect

export function toView(row: Row): DeletionRequestView {
  return {
    id: row.id,
    code: row.code,
    scope: row.scope as DeletionScope,
    targetId: row.targetId,
    status: row.status as DeletionStatus,
    source: row.source as DeletionSource,
    matched: row.matched,
    requestedAt: row.requestedAt,
    completedAt: row.completedAt,
  }
}

/**
 * Phát giai đoạn 1 (`privacy.purge_requested`) của một dòng — dùng lúc ghi và khi cron resume phát lại. Payload lấy từ
 * ảnh chụp đã lưu, nên phát lại bao nhiêu lần cũng xoá đúng một tập.
 */
export async function publishPurgeRequested(tx: DbExecutor, events: EventPublisher, row: Row): Promise<void> {
  await events.publishEvent(tx, 'privacy.purge_requested', {
    id: row.id,
    scope: row.scope as DeletionScope,
    targetId: row.targetId,
    ...(row.conversationIds ? { conversationIds: row.conversationIds } : {}),
    ...(row.pageIds ? { pageIds: row.pageIds } : {}),
    ...(row.scope === 'all' ? { metaAccountId: row.metaAccountId } : {}),
  })
  await tx.update(deletionRequests).set({ lastPublishedAt: sql`now()` }).where(eq(deletionRequests.id, row.id))
}

const lockSubject = (tx: DbExecutor, key: string) => tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`privacy:${key}`}, 0))`)

async function latestForSubject(tx: DbExecutor, subjectHash: string): Promise<Row | undefined> {
  const [latest] = await tx
    .select()
    .from(deletionRequests)
    .where(eq(deletionRequests.subjectHash, subjectHash))
    .orderBy(desc(deletionRequests.requestedAt), desc(deletionRequests.id))
    .limit(1)
  return latest
}

/**
 * Chống phát lại `signed_request` (Story 9.2, hoãn từ 9.1): yêu cầu gần nhất của người dùng đã `completed` và
 * `signed_request` mới KHÔNG mới hơn (`issued_at` ≤ mốc đã thấy, hoặc thiếu `issued_at`) → trả lại yêu cầu đó; bên gọi
 * không ngắt trang, không tạo yêu cầu. Yêu cầu còn mở thì không chặn ở đây (ngắt trang lặp lại vô hại, `recordMetaRequest`
 * trả lại yêu cầu mở). Yêu cầu của 9.1 chưa có mốc (`meta_issued_at` null) → không coi là phát lại.
 * Khoá tư vấn theo người dùng (khoá theo transaction, gọi lại trong cùng transaction không tự chặn).
 */
export async function findMetaReplay(tx: DbExecutor, subjectHash: string, issuedAt: number | null): Promise<DeletionRequestView | null> {
  await lockSubject(tx, subjectHash)
  const latest = await latestForSubject(tx, subjectHash)
  if (!latest || latest.status !== 'completed' || latest.metaIssuedAt === null) return null
  return issuedAt === null || issuedAt <= latest.metaIssuedAt ? toView(latest) : null
}

export interface RecordMetaRequestInput {
  /** Callback Meta App (9.1) hoặc Threads app (9.4) — cùng luật idempotent / chống phát lại. */
  source: CallbackDeletionSource
  subjectHash: string
  /** `issued_at` của `signed_request` (giây epoch) — mốc chống phát lại. */
  issuedAt: number | null
  /**
   * Phạm vi xoá của người dùng đã biết (tra `connections` ở entrypoint, cùng transaction): trang FB + IG lấy token qua
   * tài khoản này và dòng `meta_accounts` của nó. `null` = app không giữ dữ liệu gì của người này. Threads app (9.4): trang
   * Threads của người dùng, `metaAccountId = null` (Threads không có `meta_accounts`).
   */
  scope: { pageIds: string[]; metaAccountId: string | null } | null
}

export interface RecordMetaRequestResult {
  request: DeletionRequestView
  /** `false` = trả lại yêu cầu đã có (gọi lại / endpoint kia của cùng người dùng). */
  created: boolean
}

/**
 * Ghi yêu cầu của callback Meta. Chạy TRONG transaction của bên gọi (`tx`), khoá tư vấn theo `subject_hash` để hai
 * callback song song của cùng người không cùng tạo yêu cầu. Luật trả lại yêu cầu cũ:
 * - còn yêu cầu mở (`pending|processing`) → trả lại nó (giữ mốc `issued_at` lớn nhất đã thấy);
 * - yêu cầu gần nhất `completed` + `matched=false` mà người dùng vẫn không có dữ liệu → trả lại nó;
 * - còn lại (chưa có, hoặc đã xoá xong mà nay lại có dữ liệu) → tạo mới. Bên gọi đã chặn phát lại bằng `findMetaReplay`.
 */
export async function recordMetaRequest(
  tx: DbExecutor,
  events: EventPublisher,
  input: RecordMetaRequestInput,
): Promise<RecordMetaRequestResult> {
  await lockSubject(tx, input.subjectHash)
  const known = input.scope !== null
  const latest = await latestForSubject(tx, input.subjectHash)
  if (latest && (latest.status !== 'completed' || (!latest.matched && !known))) {
    if (input.issuedAt !== null && (latest.metaIssuedAt === null || input.issuedAt > latest.metaIssuedAt)) {
      await tx.update(deletionRequests).set({ metaIssuedAt: input.issuedAt }).where(eq(deletionRequests.id, latest.id))
    }
    return { request: toView(latest), created: false }
  }

  const now = new Date()
  const [row] = await tx
    .insert(deletionRequests)
    .values({
      code: newConfirmationCode(),
      scope: 'all',
      targetId: null,
      source: input.source,
      subjectHash: input.subjectHash,
      matched: known,
      status: known ? 'pending' : 'completed',
      requestedAt: now,
      completedAt: known ? null : now,
      pageIds: input.scope?.pageIds ?? null,
      metaAccountId: input.scope?.metaAccountId ?? null,
      metaIssuedAt: input.issuedAt,
    })
    .returning()
  // AD-22: `scope=all` — thu hẹp về trang của đúng tài khoản Meta này (Story 9.2: Threads, tài khoản khác không bị đụng).
  if (known) await publishPurgeRequested(tx, events, row!)
  return { request: toView(row!), created: true }
}

export interface TargetDeletionInput {
  scope: Extract<DeletionScope, 'contact' | 'page'>
  targetId: string
  source: Extract<DeletionSource, 'manual' | 'page_removed'>
  /** `contact`: hội thoại của khách lúc ghi. */
  conversationIds?: string[]
}

/** Yêu cầu đang mở của một đích, hoặc gần nhất nếu không có cái nào mở. */
export async function latestTargetRequest(
  db: DbExecutor,
  scope: Extract<DeletionScope, 'contact' | 'page'>,
  targetId: string,
): Promise<DeletionRequestView | null> {
  const [row] = await db
    .select()
    .from(deletionRequests)
    .where(and(eq(deletionRequests.scope, scope), eq(deletionRequests.targetId, targetId)))
    .orderBy(sql`(${deletionRequests.status} <> 'completed') desc`, desc(deletionRequests.requestedAt), desc(deletionRequests.id))
    .limit(1)
  return row ? toView(row) : null
}

/**
 * Ghi yêu cầu xoá một khách / một trang và phát giai đoạn 1 trong transaction của bên gọi. Còn yêu cầu mở cho đích này →
 * trả lại nó (`created=false`). Khoá tư vấn theo đích để hai lần bấm song song không cùng tạo.
 */
export async function requestTargetDeletion(tx: DbExecutor, events: EventPublisher, input: TargetDeletionInput): Promise<RecordMetaRequestResult> {
  await lockSubject(tx, `${input.scope}:${input.targetId}`)
  const [open] = await tx
    .select()
    .from(deletionRequests)
    .where(and(eq(deletionRequests.scope, input.scope), eq(deletionRequests.targetId, input.targetId), sql`${deletionRequests.status} <> 'completed'`))
    .limit(1)
  if (open) return { request: toView(open), created: false }
  const [row] = await tx
    .insert(deletionRequests)
    .values({
      code: newConfirmationCode(),
      scope: input.scope,
      targetId: input.targetId,
      source: input.source,
      matched: true,
      status: 'pending',
      conversationIds: input.scope === 'contact' ? (input.conversationIds ?? []) : null,
      pageIds: input.scope === 'page' ? [input.targetId] : null,
    })
    .returning()
  await publishPurgeRequested(tx, events, row!)
  return { request: toView(row!), created: true }
}

export interface DeletionRequestStatus extends DeletionRequestView {
  /** Số phần đã xong / tổng số phần (giai đoạn 1 + `inbox`). */
  partsDone: number
  partsTotal: number
}

/** Yêu cầu theo mã xác nhận (kèm tiến độ); mã sai dạng hoặc không có → `null`. */
export async function getRequestByCode(db: DbExecutor, code: string): Promise<DeletionRequestStatus | null> {
  if (!CONFIRMATION_CODE_RE.test(code)) return null
  const [row] = await db.select().from(deletionRequests).where(eq(deletionRequests.code, code))
  if (!row) return null
  const [parts] = await db.select({ n: count() }).from(deletionRequestParts).where(eq(deletionRequestParts.requestId, row.id))
  const view = toView(row)
  const total = view.matched ? purgePartCount(view.scope) : 0
  return { ...view, partsDone: view.status === 'completed' ? total : Math.min(parts?.n ?? 0, total), partsTotal: total }
}
