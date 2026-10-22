// Chạy migration Drizzle (chỉ tiến). Khoá advisory để api, worker, test chạy song song không giẫm nhau.
import { fileURLToPath } from 'node:url'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { createDb } from './index.ts'

export const MIGRATIONS_FOLDER = fileURLToPath(new URL('../../../drizzle', import.meta.url))
const LOCK_KEY = 7_120_011 // hằng số tuỳ ý, riêng cho migration của OnTheTopMoney

export async function runMigrations(url: string): Promise<void> {
  const handle = createDb(url, { max: 1, applicationName: 'ottm-migrate' })
  try {
    await handle.sql`select pg_advisory_lock(${LOCK_KEY})`
    try {
      await migrate(handle.db, { migrationsFolder: MIGRATIONS_FOLDER })
    } finally {
      // Lỗi unlock không được che lỗi migration thật (khoá tự nhả khi đóng kết nối).
      await handle.sql`select pg_advisory_unlock(${LOCK_KEY})`.catch(() => {})
    }
  } finally {
    await handle.close()
  }
}

/** Chờ Postgres nhận kết nối (dùng khi dev: db nhúng khởi động song song). */
export async function waitForDatabase(url: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() < deadline) {
    const handle = createDb(url, { max: 1, connectTimeoutSeconds: 2, applicationName: 'ottm-wait' })
    try {
      await handle.sql`select 1`
      return
    } catch (err) {
      lastError = err
    } finally {
      await handle.close().catch(() => {})
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`Postgres không sẵn sàng sau ${timeoutMs}ms: ${String(lastError)}`)
}
