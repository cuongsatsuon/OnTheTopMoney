// npm run db:dev — bật Postgres 18 nhúng: cổng 5433, dữ liệu `.data/pg` ở gốc repo, DB `ottm`.
// Chạy tới khi Ctrl-C. Không dùng khi đã có DATABASE_URL (vd Postgres riêng hay docker).
import { fileURLToPath } from 'node:url'
import { DEV_DB_NAME, DEV_DB_PORT, startEmbeddedPostgres } from './lib/embedded-pg.ts'

const dataDir = fileURLToPath(new URL('../../.data/pg', import.meta.url))
const pg = await startEmbeddedPostgres({ dataDir, port: DEV_DB_PORT, database: DEV_DB_NAME })
console.log(`Postgres 18 nhúng sẵn sàng: ${pg.url} (dữ liệu ${dataDir})`)

let stopping = false
async function stop(): Promise<void> {
  if (stopping) return
  stopping = true
  await pg.stop().catch((err: unknown) => console.error(err))
  process.exit(0)
}
process.on('SIGINT', () => void stop())
process.on('SIGTERM', () => void stop())
setInterval(() => {}, 1 << 30) // giữ tiến trình sống
