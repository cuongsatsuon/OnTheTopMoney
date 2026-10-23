// npm run simulate-dm -w server -- <id nền tảng của trang> '<nội dung>' [PSID] — giả một tin Messenger/IG Direct
// của khách (dev, Story 4.3). Đi đúng đường thật từ sau bước verify chữ ký: `ingestWebhook` ghi `webhook_events` +
// enqueue `webhook.route` → worker → `inbox.ingest` → `autoreply.triage` → Hộp thư cập nhật qua SSE.
// Chữ ký ký bằng một secret ngẫu nhiên của chính script (không cần `META_APP_SECRET`). Chặn khi NODE_ENV=production.
// Ví dụ (trang thật đã kết nối, hoặc trang giả của META_FAKE):
//   npm run simulate-dm -w server -- 1234567890 'Shop ơi còn hàng không?' PSID_KHACH_1
import { createHmac, randomBytes } from 'node:crypto'
import { WEBHOOK_SIGNATURE_PREFIX } from '../src/adapters/meta/index.ts'
import { ingestWebhook } from '../src/modules/webhooks/index.ts'
import { getConfig } from '../src/platform/config/index.ts'
import { createDb, newId } from '../src/platform/db/index.ts'
import { createBoss, createJobSender } from '../src/platform/jobs/index.ts'

function fail(message: string): never {
  process.stderr.write(`${message}\n`)
  process.exit(1)
}

if (process.env.NODE_ENV === 'production') fail('simulate-dm chỉ dùng khi dev — bị chặn khi NODE_ENV=production.')

const [pageAccountId, text, sender = 'PSID_DEV_1'] = process.argv.slice(2)
if (!pageAccountId || !text || pageAccountId === '--help' || pageAccountId === '-h') {
  fail("Cách dùng: npm run simulate-dm -w server -- <id nền tảng của trang> '<nội dung>' [PSID]")
}

if (!process.env.DATABASE_URL) {
  // Import động: `embedded-postgres` là devDependency. Dùng Postgres nhúng của `npm run dev`.
  process.env.DATABASE_URL = (await import('./lib/embedded-pg.ts')).DEV_DB_URL
}
const { DATABASE_URL } = getConfig()

const body = JSON.stringify({
  object: 'page',
  entry: [
    {
      id: pageAccountId,
      time: Date.now(),
      messaging: [{ sender: { id: sender }, recipient: { id: pageAccountId }, timestamp: Date.now(), message: { mid: `m_dev_${newId()}`, text } }],
    },
  ],
})
const secret = randomBytes(16).toString('hex')
const rawBody = Buffer.from(body, 'utf8')
const signature = WEBHOOK_SIGNATURE_PREFIX + createHmac('sha256', secret).update(rawBody).digest('hex')

const handle = createDb(DATABASE_URL, { max: 1, connectTimeoutSeconds: 5, applicationName: 'ottm-simulate-dm' })
const boss = createBoss(DATABASE_URL, 'ottm-simulate-dm-boss', { background: false, max: 1 })
boss.on('error', () => {})
let code = 0
try {
  await boss.start()
  const outcome = await ingestWebhook({ db: handle.db, jobs: createJobSender(boss) }, { product: 'meta', rawBody, signature, appSecret: secret })
  console.log(outcome.ok ? `Đã ghi ${outcome.accepted} mục webhook — worker sẽ đưa vào Hộp thư.` : `Không ghi được: ${outcome.reason}`)
} catch (err) {
  code = 1
  // Không in lỗi thô (có thể chứa URL DB kèm mật khẩu).
  process.stderr.write(`Không ghi được: ${(err as { code?: string }).code ?? (err as Error).message}. Postgres đã chạy chưa (npm run dev)?\n`)
} finally {
  await boss.stop({ graceful: false }).catch(() => {})
  await handle.close().catch(() => {})
}
process.exit(code)
