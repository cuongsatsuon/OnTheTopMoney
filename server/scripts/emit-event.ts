// npm run emit-event -w server -- <tên sự kiện> '<payload JSON>' — phát thử một sự kiện trong danh mục
// (dev, Story 1.4). Đi đúng đường `publishEvent` (pg-boss publish + NOTIFY realtime trong transaction).
// Không có route HTTP. Chặn khi NODE_ENV=production. Thiếu `id` trong payload → tự sinh UUIDv7.
// Ví dụ:
//   npm run emit-event -w server -- conversation.state_changed \
//     '{"pageId":"p1","from":"ai","to":"handoff","reasonCode":"CUSTOMER_ASKED_HUMAN"}'
import { EVENT_NAMES, isEventName } from '@ottm/shared'
import { ZodError } from 'zod'
import { getConfig } from '../src/platform/config/index.ts'
import { createDb, newId } from '../src/platform/db/index.ts'
import { createEventPublisher } from '../src/platform/events/index.ts'
import { createBoss } from '../src/platform/jobs/index.ts'

function fail(message: string): never {
  process.stderr.write(`${message}\n`)
  process.exit(1)
}

if (process.env.NODE_ENV === 'production') fail('emit-event chỉ dùng khi dev — bị chặn khi NODE_ENV=production.')

const [name, rawPayload = '{}'] = process.argv.slice(2)
if (!name || name === '--help' || name === '-h') {
  fail(`Cách dùng: npm run emit-event -w server -- <sự kiện> '<payload JSON>'\nSự kiện: ${EVENT_NAMES.join(', ')}`)
}
if (!isEventName(name)) fail(`Sự kiện "${name}" không có trong danh mục.\nSự kiện: ${EVENT_NAMES.join(', ')}`)

let payload: Record<string, unknown>
try {
  const parsed: unknown = JSON.parse(rawPayload)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('payload phải là object JSON')
  payload = parsed as Record<string, unknown>
} catch (err) {
  fail(`Payload không phải JSON object: ${(err as Error).message}`)
}
payload.id ??= newId()

if (!process.env.DATABASE_URL) {
  // Import động: `embedded-postgres` là devDependency. Dùng Postgres nhúng của `npm run dev`.
  process.env.DATABASE_URL = (await import('./lib/embedded-pg.ts')).DEV_DB_URL
}
const { DATABASE_URL } = getConfig()

const handle = createDb(DATABASE_URL, { max: 1, connectTimeoutSeconds: 5, applicationName: 'ottm-emit-event' })
const boss = createBoss(DATABASE_URL, 'ottm-emit-event-boss', { background: false, max: 1 })
boss.on('error', () => {})
let code = 0
try {
  await boss.start()
  const events = createEventPublisher(boss)
  await handle.db.transaction((tx) => events.publishEvent(tx, name, payload as never))
  console.log(`Đã phát ${name} ${JSON.stringify(payload)}`)
} catch (err) {
  code = 1
  if (err instanceof ZodError) {
    process.stderr.write(`Payload sai cho ${name}:\n${err.issues.map((i) => `  ${i.path.join('.') || '(gốc)'}: ${i.message}`).join('\n')}\n`)
  } else {
    // Không in lỗi thô (có thể chứa URL DB kèm mật khẩu).
    process.stderr.write(`Không phát được: ${(err as { code?: string }).code ?? (err as Error).message}. Postgres đã chạy chưa (npm run dev)?\n`)
  }
} finally {
  await boss.stop({ graceful: false }).catch(() => {})
  await handle.close().catch(() => {})
}
process.exit(code)
