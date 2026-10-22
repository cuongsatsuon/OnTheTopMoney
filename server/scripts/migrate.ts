// npm run db:migrate [-- --wait] — chạy migration Drizzle trong server/drizzle (chỉ tiến).
import { getConfig } from '../src/platform/config/index.ts'
import { runMigrations, waitForDatabase } from '../src/platform/db/migrate.ts'

const { DATABASE_URL } = getConfig()
if (process.argv.includes('--wait')) await waitForDatabase(DATABASE_URL, 180_000)
await runMigrations(DATABASE_URL)
console.log('migration xong')
