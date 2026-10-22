// npm run ai-simulate -w server -- <số tiền VND> [feature] — ghi một chi phí AI giả vào tháng hiện tại
// (dev, Story 1.6) để thử chip / toast 80% / banner 100% mà không gọi OpenAI. Đi đúng đường `settle` của
// AI gateway (ghi `ai_usage`, cộng sổ hạn mức, lật cờ + phát `ai_budget.threshold_reached` trong transaction).
// Chặn khi NODE_ENV=production. `feature` mặc định `compose_caption` (hạng mục "Sinh bài viết").
// Ví dụ (hạn mức 1.000.000): `-- 850000` (hoặc `850.000`) → toast 80% + chip vàng; thêm `-- 200000` → banner đỏ.
// `npm run ai-simulate -w server -- --reset` — xoá mọi chi phí giả của tháng, tính lại tổng và cờ cảnh báo.
import { AI_FEATURES, isAiFeature } from '@ottm/shared'
import { SIMULATED_MODEL, budgetMonth, getBudgetSummary, resetSimulatedSpend, settle } from '../src/modules/ai/index.ts'
import { getOpenAiPrefs } from '../src/modules/settings/index.ts'
import { getConfig } from '../src/platform/config/index.ts'
import { createDb } from '../src/platform/db/index.ts'
import { createEventPublisher } from '../src/platform/events/index.ts'
import { createBoss } from '../src/platform/jobs/index.ts'

function fail(message: string): never {
  process.stderr.write(`${message}\n`)
  process.exit(1)
}

if (process.env.NODE_ENV === 'production') fail('ai-simulate chỉ dùng khi dev — bị chặn khi NODE_ENV=production.')

const USAGE = `Cách dùng: npm run ai-simulate -w server -- <số tiền VND> [feature]\n           npm run ai-simulate -w server -- --reset\nfeature: ${AI_FEATURES.join(', ')}`
const [rawAmount, feature = 'compose_caption'] = process.argv.slice(2)
if (!rawAmount || rawAmount === '--help' || rawAmount === '-h') fail(USAGE)
const reset = rawAmount === '--reset'
/** Chỉ chữ số, có thể ngăn nghìn bằng dấu chấm (`850000`, `850.000`); `1.5`, `850,5`, `-1` bị từ chối. */
const AMOUNT_RE = /^(\d+|\d{1,3}(\.\d{3})+)$/
const amount = reset ? 0 : AMOUNT_RE.test(rawAmount) ? Number(rawAmount.replaceAll('.', '')) : NaN
if (!reset && (!Number.isSafeInteger(amount) || amount <= 0)) {
  fail(`Số tiền phải là số nguyên dương VND (chỉ chữ số, dấu chấm ngăn nghìn), nhận "${rawAmount}".\n${USAGE}`)
}
if (!reset && !isAiFeature(feature)) fail(`feature "${feature}" không có trong AiFeature.\n${USAGE}`)

if (!process.env.DATABASE_URL) {
  // Import động: `embedded-postgres` là devDependency. Dùng Postgres nhúng của `npm run dev`.
  process.env.DATABASE_URL = (await import('./lib/embedded-pg.ts')).DEV_DB_URL
}
const { DATABASE_URL, NODE_ENV } = getConfig()
if (NODE_ENV === 'production') fail('ai-simulate chỉ dùng khi dev — bị chặn khi NODE_ENV=production.')

const handle = createDb(DATABASE_URL, { max: 1, connectTimeoutSeconds: 5, applicationName: 'ottm-ai-simulate' })
const boss = createBoss(DATABASE_URL, 'ottm-ai-simulate-boss', { background: false, max: 1 })
boss.on('error', () => {})
let code = 0
try {
  await boss.start()
  const events = createEventPublisher(boss)
  const vnd = (n: number) => `${n.toLocaleString('vi-VN')}đ`
  if (reset) {
    const removed = await resetSimulatedSpend({ db: handle.db, events })
    const s = await getBudgetSummary({ db: handle.db })
    console.log(`Đã xoá ${removed} chi phí giả. Tháng ${s.month}: ${vnd(s.spentVnd)} / ${vnd(s.limitVnd)} = ${s.percent}% · ${s.state}`)
  } else {
    const { exchangeRateVnd } = await getOpenAiPrefs(handle.db)
    await settle(
      { db: handle.db, events },
      {
        reservationId: null,
        month: budgetMonth(new Date()),
        feature: feature as Parameters<typeof settle>[1]['feature'],
        model: SIMULATED_MODEL,
        pageId: null,
        ref: 'ai-simulate',
        usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, images: feature === 'image_generate' ? 1 : 0 },
        cost: { costVnd: amount, usdMicros: Math.ceil((amount * 1_000_000) / exchangeRateVnd) },
      },
    )
    const s = await getBudgetSummary({ db: handle.db })
    console.log(`Đã ghi ${vnd(amount)} (${feature}). Tháng ${s.month}: ${vnd(s.spentVnd)} / ${vnd(s.limitVnd)} = ${s.percent}% · ${s.state}`)
  }
} catch (err) {
  code = 1
  // Không in lỗi thô (có thể chứa URL DB kèm mật khẩu).
  process.stderr.write(`Không ghi được: ${(err as { code?: string }).code ?? (err as Error).message}. Postgres đã chạy và đã migrate chưa (npm run dev)?\n`)
} finally {
  await boss.stop({ graceful: false }).catch(() => {})
  await handle.close().catch(() => {})
}
process.exit(code)
