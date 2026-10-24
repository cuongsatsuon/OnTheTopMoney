// Bảng của module `privacy` (AD-1, AD-22). Story 9.1: `deletion_requests` — mỗi yêu cầu xoá dữ liệu một dòng.
// `privacy` là điều phối DUY NHẤT của luồng xoá: ghi dòng + phát `privacy.purge_requested` trong cùng transaction;
// các module tham gia tự xoá phần của mình (Story 9.2) rồi báo lại, `privacy` đóng yêu cầu khi đủ.
// - `code`: mã xác nhận trả cho Meta + đường trang trạng thái công khai `/privacy/status/<code>` (ngẫu nhiên, không đoán được).
// - `subject_hash`: HMAC của id người dùng Meta (không lưu id thô) — khoá idempotent của callback Meta; `null` với yêu cầu tay.
// - `matched`: lúc nhận, app có giữ dữ liệu gắn với người yêu cầu không. `false` → không có gì để xoá, dòng `completed` ngay.
// - `target_id` KHÔNG có FK: trang / khách đích sẽ bị chính luồng xoá xoá đi, dòng yêu cầu vẫn phải còn để tra trạng thái.
import { DELETION_SCOPES, DELETION_SOURCES, DELETION_STATUSES } from '@ottm/shared'
import { sql } from 'drizzle-orm'
import { boolean, check, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'

const inList = (xs: readonly string[]) => sql.raw(xs.map((s) => `'${s}'`).join(', '))
const ts = (name: string) => timestamp(name, { withTimezone: true, precision: 3 })

export const deletionRequests = pgTable(
  'deletion_requests',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    code: text('code').notNull().unique(),
    scope: text('scope').notNull(),
    /** Trang (`scope=page`) hoặc khách (`scope=contact`); `null` khi `scope=all`. */
    targetId: uuid('target_id'),
    status: text('status').notNull().default('pending'),
    source: text('source').notNull(),
    subjectHash: text('subject_hash'),
    matched: boolean('matched').notNull().default(true),
    requestedAt: ts('requested_at').notNull().defaultNow(),
    completedAt: ts('completed_at'),
  },
  (t) => [
    check('deletion_requests_scope_check', sql`${t.scope} in (${inList(DELETION_SCOPES)})`),
    check('deletion_requests_status_check', sql`${t.status} in (${inList(DELETION_STATUSES)})`),
    check('deletion_requests_source_check', sql`${t.source} in (${inList(DELETION_SOURCES)})`),
    check('deletion_requests_target_check', sql`(${t.scope} = 'all') = (${t.targetId} is null)`),
    check('deletion_requests_completed_check', sql`(${t.status} = 'completed') = (${t.completedAt} is not null)`),
    // Lưới an toàn của idempotent theo người dùng: mỗi người tối đa một yêu cầu đang mở (khoá tư vấn chặn đua trước).
    uniqueIndex('deletion_requests_open_subject_unique')
      .on(t.subjectHash)
      .where(sql`${t.status} <> 'completed' and ${t.subjectHash} is not null`),
    index('deletion_requests_subject_idx').on(t.subjectHash, t.requestedAt),
  ],
)
