// Bảng của module `settings` (AD-1): `settings`, `secrets`, `sessions`.
import { sql } from 'drizzle-orm'
import { check, index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'

/** Trạng thái kiểm của một bí mật (vd khoá OpenAI). `null` = loại bí mật không cần kiểm (mật khẩu). */
export const SECRET_STATUSES = ['valid', 'invalid'] as const
export type SecretStatus = (typeof SECRET_STATUSES)[number]
const STATUS_LIST = sql.raw(SECRET_STATUSES.map((s) => `'${s}'`).join(', '))

/** Cài đặt dạng khoá → JSON. Story 1.4: `notification_prefs` (bật/tắt từng loại thông báo). */
export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

/**
 * Bí mật của app. Story 1.2: hash mật khẩu chủ (`name='owner_password'`, `kind='argon2id'`).
 * Story 1.5: khoá OpenAI (`name='openai_api_key'`, `kind='envelope'`, `value` = envelope AES-256-GCM
 * `v1:<keyId>:<iv>:<ciphertext>:<tag>`), kèm `status`, `last4`, `checked_at` để trả client mà không giải mã.
 */
export const secrets = pgTable(
  'secrets',
  {
    name: text('name').primaryKey(),
    kind: text('kind').notNull(),
    value: text('value').notNull(),
    status: text('status'),
    last4: text('last4'),
    checkedAt: timestamp('checked_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check('secrets_status_check', sql`${t.status} is null or ${t.status} in (${STATUS_LIST})`)],
)

/** Phiên đăng nhập (AD-19). Chỉ lưu sha256 của token, không lưu token thô. */
export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    tokenHash: text('token_hash').notNull().unique(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => [index('sessions_expires_at_idx').on(t.expiresAt)],
)
