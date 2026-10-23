// Bảng của module `autoreply` (AD-1, AD-16). Story 5.4: `autoreply_runs` — nhật ký từng lượt AI trả lời tin nhắn.
// Chỉ id, mốc thời gian, kết quả, lý do, nguồn cấu hình (AD-8) — KHÔNG có nội dung tin, prompt hay câu trả lời (AD-12).
// Không khoá ngoại sang bảng của `inbox`/`pages` (module khác sở hữu); dọn theo hạn 90 ngày / xoá dữ liệu ở Epic 9.
import { CONFIG_OWNER_TYPES, HANDOFF_REASONS } from '@ottm/shared'
import { sql } from 'drizzle-orm'
import { check, index, integer, pgTable, real, text, timestamp, uuid } from 'drizzle-orm/pg-core'

const list = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(', '))
const ts = (name: string) => timestamp(name, { withTimezone: true, precision: 3 })

/**
 * Kết quả một lượt: `replied` (AI trả lời, giữ `ai`) · `handoff` (chuyển cho người, có/không câu chuyển tiếp) ·
 * `not_applicable` (cổng không áp dụng → `human`) · `superseded` (trạng thái / tin khách đổi giữa lượt — bỏ, không gửi) ·
 * `failed` (lỗi bất ngờ). `null` khi lượt đang chạy (hoặc tiến trình chết giữa chừng).
 */
export const AUTOREPLY_RUN_OUTCOMES = ['replied', 'handoff', 'not_applicable', 'superseded', 'failed'] as const
export type AutoreplyRunOutcome = (typeof AUTOREPLY_RUN_OUTCOMES)[number]

export const autoreplyRuns = pgTable(
  'autoreply_runs',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    conversationId: uuid('conversation_id').notNull(),
    pageId: uuid('page_id').notNull(),
    /** Ảnh chụp lúc bắt đầu (khoá lạc quan của `inbox.applyAutoreplyDecision`). */
    lastInboundId: uuid('last_inbound_id').notNull(),
    stateVersion: integer('state_version').notNull(),
    /** Lúc tin khách MỚI đầu tiên của lượt vào hệ thống (≈ webhook) — mốc đo NFR1. */
    inboundAt: ts('inbound_at').notNull(),
    startedAt: ts('started_at').notNull().defaultNow(),
    finishedAt: ts('finished_at'),
    outcome: text('outcome'),
    /** Lý do chuyển (`HandoffReason`) khi `handoff` / `not_applicable`. */
    reasonCode: text('reason_code'),
    /** Cấu hình AI hiệu lực đã dùng (AD-8); `null` khi chưa giải được (`CONFIG_MISSING`). */
    configSourceType: text('config_source_type'),
    configSourceId: uuid('config_source_id'),
    llmCalls: integer('llm_calls').notNull().default(0),
    confidence: real('confidence'),
    /** Tin `app_ai` đã ghi (câu trả lời / câu chuyển tiếp), theo thứ tự gửi. */
    messageIds: uuid('message_ids').array().notNull().default(sql`'{}'::uuid[]`),
  },
  (t) => [
    check('autoreply_runs_outcome_check', sql`${t.outcome} in (${list(AUTOREPLY_RUN_OUTCOMES)})`),
    check('autoreply_runs_reason_check', sql`${t.reasonCode} in (${list(HANDOFF_REASONS)})`),
    check('autoreply_runs_source_check', sql`${t.configSourceType} in (${list(CONFIG_OWNER_TYPES)})`),
    index('autoreply_runs_conversation_idx').on(t.conversationId, t.startedAt),
    // Đo độ trễ / dọn theo hạn.
    index('autoreply_runs_started_idx').on(t.startedAt),
  ],
)
