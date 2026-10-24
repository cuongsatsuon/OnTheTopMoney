// Client Postgres (postgres.js) + Drizzle dùng chung cho api và worker.
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import type { Db as BossDb } from 'pg-boss'
import postgres from 'postgres'
import { v7 as uuidv7 } from 'uuid'
import * as schema from './schema.ts'

export { schema }
export type Db = PostgresJsDatabase<typeof schema>
export type Sql = postgres.Sql
/** Transaction Drizzle mở bằng `db.transaction(async (tx) => …)`. */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]
/** Nơi chạy câu lệnh: cả DB (tự commit từng câu) hoặc một transaction đang mở. */
export type DbExecutor = Db | Tx

export interface DbHandle {
  sql: Sql
  db: Db
  close(): Promise<void>
}

export function createDb(
  url: string,
  options: { max?: number; connectTimeoutSeconds?: number; applicationName?: string } = {},
): DbHandle {
  const sql = postgres(url, {
    max: options.max ?? 10,
    connect_timeout: options.connectTimeoutSeconds ?? 10,
    onnotice: () => {},
    connection: { application_name: options.applicationName ?? 'ottm' },
  })
  const db = drizzle(sql, { schema, casing: 'snake_case' })
  return { sql, db, close: () => sql.end({ timeout: 5 }) }
}

/** UUIDv7 dạng chuỗi (Consistency Conventions › ID). */
export function newId(): string {
  return uuidv7()
}

/** Client postgres.js bên dưới một executor Drizzle (pool, hoặc kết nối của transaction). */
function rawClient(executor: DbExecutor): postgres.Sql | postgres.TransactionSql {
  // `_.session` là thuộc tính công khai của PgDatabase; với driver postgres-js nó giữ `client`.
  const client = (executor._.session as unknown as { client?: postgres.Sql | postgres.TransactionSql }).client
  if (!client || typeof client.unsafe !== 'function') throw new Error('executor không phải Drizzle postgres-js')
  return client
}

/**
 * Bọc executor Drizzle thành `db` của pg-boss: `send`/`publish` ghi job trên đúng kết nối của
 * transaction đang mở, nên job chỉ tồn tại khi transaction commit (AD-2, AD-3).
 */
export function bossDbFor(executor: DbExecutor): BossDb {
  const client = rawClient(executor)
  return {
    async executeSql(text: string, values: unknown[] = []) {
      const rows = await client.unsafe(text, values as postgres.ParameterOrJSON<never>[])
      return { rows: [...rows] }
    },
  }
}

/**
 * Kiểm lúc khởi động (api, worker): `bossDbFor` dựa vào chi tiết nội bộ của Drizzle — nâng Drizzle mà
 * đổi cấu trúc thì phải hỏng ngay khi boot, không phải ở lần phát sự kiện đầu tiên.
 */
export async function assertBossDbSupported(db: Db): Promise<void> {
  await db.transaction(async (tx) => {
    const { rows } = await bossDbFor(tx).executeSql('select $1::int as ok', [1])
    if (rows[0]?.ok !== 1) throw new Error('bossDbFor: executeSql trên transaction Drizzle không trả kết quả mong đợi')
  })
}

/** Tuỳ chọn của một lượt dọn theo lô (Story 9.3): cỡ lô và trần số lô mỗi lượt (phần còn lại để lượt sau). */
export interface BatchOptions {
  batchSize?: number
  maxBatches?: number
}

/** Kết quả một lượt dọn: số dòng đã xử lý; `done=false` = chạm trần lô, lượt sau làm tiếp. */
export interface BatchResult {
  count: number
  done: boolean
}

export const DEFAULT_BATCH_SIZE = 1000
export const DEFAULT_MAX_BATCHES = 200

/**
 * Lặp `step(limit)` (mỗi lần một câu lệnh — một transaction ngầm) tới khi một lô ít hơn `limit` hoặc chạm trần lô.
 * `step` trả số dòng đã xử lý. Trả tổng và `done` (false = còn việc, chạm trần).
 */
export async function runInBatches(step: (limit: number) => Promise<number>, options: BatchOptions = {}): Promise<BatchResult> {
  const limit = options.batchSize ?? DEFAULT_BATCH_SIZE
  const maxBatches = options.maxBatches ?? DEFAULT_MAX_BATCHES
  let count = 0
  for (let i = 0; i < maxBatches; i++) {
    const n = await step(limit)
    count += n
    if (n < limit) return { count, done: true }
  }
  return { count, done: false }
}
