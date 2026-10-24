// Yêu cầu xoá dữ liệu (Story 9.1, AD-22). Chỉ entrypoint gọi qua index.ts.
// - `recordMetaRequest`: ghi yêu cầu từ callback Meta, idempotent theo người dùng (`subject_hash`), phát
//   `privacy.purge_requested` trong CÙNG transaction của bên gọi. Người dùng app không giữ dữ liệu gì (`known=false`)
//   → dòng `completed` + `matched=false`, KHÔNG phát sự kiện (một tài khoản lạ không được kích hoạt xoá dữ liệu shop).
// - `getRequestByCode`: đọc trạng thái cho trang công khai `/privacy/status/<code>`.
// Việc xoá thật + đóng yêu cầu thuộc Story 9.2 (consumer ở từng module).
import type { DeletionScope, DeletionSource, DeletionStatus } from '@ottm/shared'
import { createHmac, randomBytes } from 'node:crypto'
import { desc, eq, sql } from 'drizzle-orm'
import type { DbExecutor } from '../../platform/db/index.ts'
import type { EventPublisher } from '../../platform/events/index.ts'
import { deletionRequests } from './schema.ts'

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

export interface DeletionRequestView {
  id: string
  code: string
  scope: DeletionScope
  status: DeletionStatus
  source: DeletionSource
  matched: boolean
  requestedAt: Date
  completedAt: Date | null
}

type Row = typeof deletionRequests.$inferSelect

function toView(row: Row): DeletionRequestView {
  return {
    id: row.id,
    code: row.code,
    scope: row.scope as DeletionScope,
    status: row.status as DeletionStatus,
    source: row.source as DeletionSource,
    matched: row.matched,
    requestedAt: row.requestedAt,
    completedAt: row.completedAt,
  }
}

export interface RecordMetaRequestInput {
  source: Extract<DeletionSource, 'meta_deauthorize' | 'meta_data_deletion'>
  subjectHash: string
  /** App có giữ dữ liệu gắn với người dùng này không (tra `connections` ở entrypoint, cùng transaction). */
  known: boolean
}

export interface RecordMetaRequestResult {
  request: DeletionRequestView
  /** `false` = trả lại yêu cầu đã có (gọi lại / endpoint kia của cùng người dùng). */
  created: boolean
}

/**
 * Ghi yêu cầu của callback Meta. Chạy TRONG transaction của bên gọi (`tx`), khoá tư vấn theo `subject_hash` để hai
 * callback song song của cùng người không cùng tạo yêu cầu. Luật trả lại yêu cầu cũ:
 * - còn yêu cầu mở (`pending|processing`) → trả lại nó;
 * - yêu cầu gần nhất `completed` + `matched=false` mà người dùng vẫn không có dữ liệu → trả lại nó;
 * - còn lại (chưa có, hoặc đã xoá xong mà nay lại có dữ liệu) → tạo mới.
 */
export async function recordMetaRequest(
  tx: DbExecutor,
  events: EventPublisher,
  input: RecordMetaRequestInput,
): Promise<RecordMetaRequestResult> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`privacy:${input.subjectHash}`}, 0))`)
  const [latest] = await tx
    .select()
    .from(deletionRequests)
    .where(eq(deletionRequests.subjectHash, input.subjectHash))
    .orderBy(desc(deletionRequests.requestedAt), desc(deletionRequests.id))
    .limit(1)
  if (latest && (latest.status !== 'completed' || (!latest.matched && !input.known))) {
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
      matched: input.known,
      status: input.known ? 'pending' : 'completed',
      requestedAt: now,
      completedAt: input.known ? null : now,
    })
    .returning()
  const request = toView(row!)
  if (input.known) {
    // AD-22: `scope=all` — người dùng Meta của app là chủ shop, mọi trang FB/IG đến từ tài khoản này [ASSUMPTION].
    await events.publishEvent(tx, 'privacy.purge_requested', { id: request.id, scope: 'all', targetId: null })
  }
  return { request, created: true }
}

/** Yêu cầu theo mã xác nhận; mã sai dạng hoặc không có → `null`. */
export async function getRequestByCode(db: DbExecutor, code: string): Promise<DeletionRequestView | null> {
  if (!CONFIRMATION_CODE_RE.test(code)) return null
  const [row] = await db.select().from(deletionRequests).where(eq(deletionRequests.code, code))
  return row ? toView(row) : null
}
