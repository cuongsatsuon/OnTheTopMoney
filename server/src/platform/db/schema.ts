// Bảng của platform (AD-1 Structural Seed): chỉ `worker_heartbeats`.
import { sql } from 'drizzle-orm'
import { integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'

export const workerHeartbeats = pgTable('worker_heartbeats', {
  /** id phiên chạy của worker (UUIDv7), sinh mỗi lần worker khởi động. */
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  hostname: text('hostname').notNull(),
  pid: integer('pid').notNull(),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  beatAt: timestamp('beat_at', { withTimezone: true }).notNull().defaultNow(),
})
