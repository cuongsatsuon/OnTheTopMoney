// Bảng của module `ai` (AD-1). Story 1.5: `ai_model_prices` — nguồn danh sách model cho FE (AD-7).
// Story 1.6: sổ hạn mức tháng `ai_budget_months`, chỗ giữ chi phí `ai_reservations`, nhật ký `ai_usage`.
import { AI_FEATURES, AI_MODEL_KINDS } from '@ottm/shared'
import { sql } from 'drizzle-orm'
import { bigint, boolean, check, index, integer, numeric, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'

const KIND_LIST = sql.raw(AI_MODEL_KINDS.map((k) => `'${k}'`).join(', '))
const FEATURE_LIST = sql.raw(AI_FEATURES.map((f) => `'${f}'`).join(', '))
/** Tháng lịch giờ Việt Nam, `YYYY-MM`. */
const MONTH_RE = sql.raw(`'^[0-9]{4}-(0[1-9]|1[0-2])$'`)

/**
 * Model OpenAI được phép chọn và giá của nó (USD). Seed ở migration; model mặc định của mỗi loại là
 * model đang bật có `sort` nhỏ nhất. Giá chữ: USD / 1 triệu token (input, cached input, output); model ảnh:
 * input chữ + output ảnh theo token, kèm `image_usd_each` — giá mỗi ảnh khi Images API không trả `usage`.
 * Cột giá NULL → gateway từ chối gọi model đó (`CONFIG_MISSING`).
 */
export const aiModelPrices = pgTable(
  'ai_model_prices',
  {
    model: text('model').primaryKey(),
    kind: text('kind').notNull(),
    label: text('label').notNull(),
    inputUsdPer1m: numeric('input_usd_per_1m', { precision: 12, scale: 6 }),
    cachedInputUsdPer1m: numeric('cached_input_usd_per_1m', { precision: 12, scale: 6 }),
    outputUsdPer1m: numeric('output_usd_per_1m', { precision: 12, scale: 6 }),
    imageUsdEach: numeric('image_usd_each', { precision: 12, scale: 6 }),
    active: boolean('active').notNull().default(true),
    sort: integer('sort').notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check('ai_model_prices_kind_check', sql`${t.kind} in (${KIND_LIST})`)],
)

/**
 * Sổ hạn mức tháng (giờ Việt Nam). `spent_vnd` = tổng chi phí thật đã ghi; dòng tháng bị khoá
 * (`FOR UPDATE`) khi giữ chỗ để api và worker gọi song song không vượt hạn mức. Cờ cảnh báo chỉ lật bằng
 * `UPDATE … WHERE alerted_x = false` → sự kiện `ai_budget.threshold_reached` phát đúng một lần.
 */
export const aiBudgetMonths = pgTable(
  'ai_budget_months',
  {
    month: text('month').primaryKey(),
    spentVnd: bigint('spent_vnd', { mode: 'number' }).notNull().default(0),
    alerted80: boolean('alerted_80').notNull().default(false),
    alerted100: boolean('alerted_100').notNull().default(false),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check('ai_budget_months_month_check', sql`${t.month} ~ ${MONTH_RE}`)],
)

/**
 * Chỗ giữ chi phí ước tính của lời gọi đang chạy. Gọi xong → xoá (thay bằng chi phí thật); tiến trình chết
 * giữa chừng để lại dòng, cron `ai.reservations_gc` dọn dòng cũ hơn 15 phút.
 */
export const aiReservations = pgTable(
  'ai_reservations',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    month: text('month')
      .notNull()
      .references(() => aiBudgetMonths.month),
    estVnd: bigint('est_vnd', { mode: 'number' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('ai_reservations_month_idx').on(t.month), index('ai_reservations_created_at_idx').on(t.createdAt)],
)

/**
 * Một lời gọi OpenAI đã tính tiền. Không chứa prompt hay nội dung trả về (AD-12) — chỉ tính năng, model,
 * trang, tham chiếu của caller, số token / ảnh và chi phí (USD gốc `usd_micros`, VND làm tròn lên).
 */
export const aiUsage = pgTable(
  'ai_usage',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    month: text('month').notNull(),
    feature: text('feature').notNull(),
    model: text('model').notNull(),
    pageId: text('page_id'),
    ref: text('ref'),
    inputTokens: integer('input_tokens').notNull().default(0),
    cachedInputTokens: integer('cached_input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    images: integer('images').notNull().default(0),
    usdMicros: bigint('usd_micros', { mode: 'number' }).notNull(),
    costVnd: bigint('cost_vnd', { mode: 'number' }).notNull(),
    /**
     * true = OpenAI không trả usage (hết giờ / đứt kết nối / huỷ sau khi đã gửi) → ghi chi phí ước tính lúc
     * giữ chỗ, vì OpenAI có thể đã tính tiền.
     */
    estimated: boolean('estimated').notNull().default(false),
  },
  (t) => [
    check('ai_usage_feature_check', sql`${t.feature} in (${FEATURE_LIST})`),
    check('ai_usage_month_check', sql`${t.month} ~ ${MONTH_RE}`),
    index('ai_usage_month_feature_idx').on(t.month, t.feature),
  ],
)
