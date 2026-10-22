// Bảng của module `notifications` (AD-1): `notifications`.
import { NOTIFICATION_TYPES } from '@ottm/shared'
import { sql } from 'drizzle-orm'
import { check, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'

const TYPE_LIST = sql.raw(NOTIFICATION_TYPES.map((t) => `'${t}'`).join(', '))

/**
 * Thông báo trong app. `dedupe_key` = `<event>:<id>:<version|job:<jobId>>` — sự kiện lặp
 * (pg-boss giao lại, phát trùng cùng version) chỉ tạo một dòng.
 */
export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    type: text('type').notNull(),
    title: text('title').notNull(),
    body: text('body').notNull(),
    entity: text('entity').notNull(),
    entityId: text('entity_id').notNull(),
    pageId: text('page_id'),
    dedupeKey: text('dedupe_key').notNull().unique(),
    readAt: timestamp('read_at', { withTimezone: true }),
    /** Độ chính xác mili giây — khớp ISO 8601 của API, để `?since=<createdAt>` không trả lại chính mục đó. */
    createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
  },
  (t) => [
    check('notifications_type_check', sql`${t.type} in (${TYPE_LIST})`),
    index('notifications_created_at_idx').on(t.createdAt),
    index('notifications_unread_idx').on(t.id).where(sql`${t.readAt} is null`),
  ],
)
