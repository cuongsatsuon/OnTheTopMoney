// Ma trận Story 1.6 — AI gateway và hạn mức chi phí (fake adapter OpenAI, Postgres thật).
import { randomBytes } from 'node:crypto'
import { Writable } from 'node:stream'
import { AiBudgetSummary, ErrorResponse, aiBudgetState } from '@ottm/shared'
import type { PgBoss } from 'pg-boss'
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest'
import { createSecretCipher } from '../src/adapters/crypto/index.ts'
import { createFakeOpenAiAdapter, FAKE_JPEG, FAKE_RESPONSE_TEXT, type FakeOpenAiAdapter } from '../src/adapters/openai/fake.ts'
import type { CreateResponseResult } from '../src/adapters/openai/index.ts'
import { buildApp } from '../src/app/app.ts'
import { SESSION_COOKIE } from '../src/app/auth/index.ts'
import {
  budgetMonth,
  computeCost,
  estimateImageCost,
  estimateInputTokens,
  estimateTextCost,
  gcReservations,
  generateImage,
  generateText,
  getBudgetSummary,
  getModelPrice,
  handleAiEvent,
  isMaybeBilled,
  parseMicros,
  reserve,
  resetSimulatedSpend,
  setOpenAiKey,
  settle,
  type AiDeps,
  type ModelPrice,
} from '../src/modules/ai/index.ts'
import { DEFAULT_OPENAI_PREFS, createSession, setOpenAiPrefs, type OpenAiPrefs } from '../src/modules/settings/index.ts'
import { createDb, type DbHandle } from '../src/platform/db/index.ts'
import { AppError } from '../src/platform/errors/index.ts'
import { createEventPublisher, type EventEnvelope, type EventPublisher } from '../src/platform/events/index.ts'
import { BOSS_SCHEMA, QUEUES, createBoss } from '../src/platform/jobs/index.ts'
import { createLogger } from '../src/platform/log/index.ts'
import { listenRealtime, sleep, waitFor } from './helpers/realtime.ts'

const GOOD = 'sk-proj-GATEWAY-key-aaaa1111'
/** Giữa tháng 10/2026 giờ VN — mọi lời gọi của gateway dùng đồng hồ này. */
const NOW = new Date('2026-10-15T05:00:00Z')
const MONTH = '2026-10'
const SECRET_PROMPT = 'BÍ-MẬT-PROMPT-7f3a khách hỏi giá áo'
const SECRET_OUTPUT = 'BÍ-MẬT-TRẢ-LỜI-91c2'

let handle: DbHandle
/** Pool thứ hai giả tiến trình worker (api và worker gọi song song). */
let handle2: DbHandle
let boss: PgBoss
let events: EventPublisher
let realtime: Awaited<ReturnType<typeof listenRealtime>>
let fake: FakeOpenAiAdapter
const cipher = createSecretCipher({ keys: new Map([['k1', randomBytes(32)]]), activeKeyId: 'k1' })
const logLines: string[] = []
const log = createLogger(
  { level: 'trace' },
  new Writable({
    write(chunk, _enc, cb) {
      logLines.push(String(chunk))
      cb()
    },
  }),
)

const depsOf = (h: DbHandle = handle, now: () => Date = () => NOW): AiDeps => ({ db: h.db, events, cipher, openai: fake, log, now })

async function setPrefs(patch: Partial<OpenAiPrefs>) {
  await setOpenAiPrefs(handle.db, events, { ...DEFAULT_OPENAI_PREFS, ...patch })
}

async function storeKey() {
  fake.set(GOOD, { ok: true })
  await setOpenAiKey({ db: handle.db, events, cipher, openai: fake }, GOOD)
}

const settingsChanged = (): EventEnvelope => ({ event: 'settings.updated', payload: { id: 'openai', keys: ['openai'] } })

const counts = async () => {
  const [row] = await handle.sql<{ usage: number; reservations: number }[]>`
    select (select count(*)::int from ai_usage) as usage, (select count(*)::int from ai_reservations) as reservations`
  return row!
}
const monthRow = async (month = MONTH) =>
  (await handle.sql<{ spent_vnd: string; alerted_80: boolean; alerted_100: boolean }[]>`
    select spent_vnd, alerted_80, alerted_100 from ai_budget_months where month = ${month}`)[0]
const budgetEvents = (type = 'ai_budget.threshold_reached') => realtime.messages.filter((m) => m.type === type)

async function errorOf(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise
  } catch (err) {
    if (err instanceof AppError) return err
    throw err
  }
  throw new Error('mong đợi lỗi')
}

/**
 * Số tròn cho test hạn mức: tỉ giá 1.000.000 VND/USD → 1 micro-USD = 1 VND. Input "abc" (1 token × 0,10) +
 * 199 token output (× 0,50) = 99,6 → giữ chỗ 100 đ; fake trả đúng usage đó → chi phí thật 100 đ.
 */
const ROUND = { exchangeRateVnd: 1_000_000 }
const roundCall = { feature: 'autoreply' as const, input: 'abc', maxOutputTokens: 199 }
const roundUsage: CreateResponseResult = { ok: true, id: 'r', text: 'ok', usage: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 199 }, incomplete: null }

beforeAll(async () => {
  handle = createDb(inject('databaseUrl'), { max: 10 })
  handle2 = createDb(inject('databaseUrl'), { max: 10 })
  boss = createBoss(inject('databaseUrl'), 'ottm-test-ai-gateway', { background: false })
  boss.on('error', () => {})
  await boss.start()
  events = createEventPublisher(boss)
  realtime = await listenRealtime(handle.sql)
})
afterAll(async () => {
  await handle.sql`delete from ai_usage`
  await handle.sql`delete from ai_reservations`
  await handle.sql`delete from ai_budget_months`
  await handle.sql`delete from ai_model_prices where model like 'testonly-%'`
  await handle.sql`delete from secrets where name = 'openai_api_key'`
  await handle.sql`delete from settings where key = 'openai'`
  await realtime.stop()
  await boss.stop({ graceful: false })
  await handle2.close()
  await handle.close()
})
beforeEach(async () => {
  await handle.sql`delete from ai_usage`
  await handle.sql`delete from ai_reservations`
  await handle.sql`delete from ai_budget_months`
  await handle.sql`delete from secrets where name = 'openai_api_key'`
  await handle.sql`delete from settings where key = 'openai'`
  fake = createFakeOpenAiAdapter()
  await storeKey()
  await sleep(50) // NOTIFY của bước chuẩn bị tới trước khi xoá
  realtime.messages.length = 0
})

describe('cost', () => {
  const luna: ModelPrice = { model: 'gpt-6-luna', kind: 'text', active: true, input: 100_000n, cachedInput: 10_000n, output: 500_000n, imageEach: null, imageInput: null }

  it('giá seed đã điền theo bảng (USD / 1 triệu token, ảnh 0,05 USD/ảnh)', async () => {
    const rows = await handle.sql<{ model: string; input: string; cached: string | null; output: string; each: string | null }[]>`
      select model, input_usd_per_1m::text as input, cached_input_usd_per_1m::text as cached,
             output_usd_per_1m::text as output, image_usd_each::text as each
      from ai_model_prices where model not like 'testonly-%' order by kind desc, sort`
    expect(rows.map((r) => [r.model, Number(r.input), r.cached === null ? null : Number(r.cached), Number(r.output), r.each === null ? null : Number(r.each)])).toEqual([
      ['gpt-6-luna', 0.1, 0.01, 0.5, null],
      ['gpt-6.1-sol', 2, 0.1, 10, null],
      ['gpt-6-astra', 10, 1, 50, null],
      ['gpt-image-2.5-flare', 5, null, 30, 0.05],
      ['gpt-image-2.5-sunburst', 5, null, 30, 0.05],
      ['gpt-image-2', 5, null, 30, 0.05],
    ])
    expect(await getModelPrice(handle.db, 'gpt-6-luna')).toEqual(luna)
  })

  it('migration: cả sáu model seed đều có giá (UPDATE … FROM VALUES không bỏ sót model nào)', async () => {
    const seed = ['gpt-6-luna', 'gpt-6.1-sol', 'gpt-6-astra', 'gpt-image-2.5-flare', 'gpt-image-2.5-sunburst', 'gpt-image-2']
    const rows = await handle.sql<{ model: string; kind: string; ok: boolean }[]>`
      select model, kind,
        input_usd_per_1m is not null and output_usd_per_1m is not null
          and (kind = 'text' and cached_input_usd_per_1m is not null or kind = 'image' and image_usd_each is not null) as ok
      from ai_model_prices where model = any(${seed})`
    expect(rows.map((r) => r.model).sort()).toEqual([...seed].sort())
    expect(rows.filter((r) => !r.ok)).toEqual([])
  })

  it('chi phí = usage × giá × tỉ giá, cached tính giá cached, VND và usd_micros làm tròn lên', () => {
    // 1000 input (200 cached) + 500 output: 800×0,10 + 200×0,01 + 500×0,50 = 332 micro-USD → 8,632 đ → 9 đ.
    expect(computeCost(luna, { inputTokens: 1_000, cachedInputTokens: 200, outputTokens: 500, images: 0 }, 26_000)).toEqual({ usdMicros: 332, costVnd: 9 })
    // 1 token output = 0,5 micro → usd_micros 1, VND 0,013 → 1.
    expect(computeCost(luna, { inputTokens: 0, cachedInputTokens: 0, outputTokens: 1, images: 0 }, 26_000)).toEqual({ usdMicros: 1, costVnd: 1 })
    expect(computeCost(luna, { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, images: 0 }, 26_000)).toEqual({ usdMicros: 0, costVnd: 0 })
    // Ước tính chữ: 10 ký tự ÷ 2 → 5 token; 5×0,10 + 100×0,50 = 50,5 micro → 1,313 đ → 2 đ.
    expect(estimateTextCost(luna, 10, 100, 26_000)).toEqual({ usdMicros: 51, costVnd: 2 })
    expect(estimateInputTokens(11)).toBe(6)
    // Ảnh: theo kích thước (1024×1024 0,10 USD, khác 0,15 USD), không thấp hơn image_usd_each.
    const flare: ModelPrice = { model: 'f', kind: 'image', active: true, input: 5_000_000n, cachedInput: null, output: 30_000_000n, imageEach: 50_000n, imageInput: 8_000_000n }
    expect(estimateImageCost(flare, 2, '1024x1024', 26_000)).toEqual({ usdMicros: 200_000, costVnd: 5_200 })
    expect(estimateImageCost(flare, 1, '1536x1024', 26_000)).toEqual({ usdMicros: 150_000, costVnd: 3_900 })
    expect(estimateImageCost({ ...flare, imageEach: 400_000n }, 1, '1024x1024', 26_000)).toEqual({ usdMicros: 400_000, costVnd: 10_400 })
    expect(parseMicros('0.100000')).toBe(100_000n)
    expect(parseMicros('30.5')).toBe(30_500_000n)
    expect(parseMicros(null)).toBeNull()
  })

  it('tháng tính theo giờ Việt Nam', () => {
    expect(budgetMonth(new Date('2026-10-31T16:59:59Z'))).toBe('2026-10')
    expect(budgetMonth(new Date('2026-10-31T17:00:00Z'))).toBe('2026-11')
    expect(budgetMonth(new Date('2026-12-31T17:30:00Z'))).toBe('2027-01')
  })

  it('trạng thái hạn mức: warn chỉ khi bật cảnh báo; ≥ hạn mức (hoặc hạn mức 0) → blocked', () => {
    expect(aiBudgetState({ spentVnd: 799, limitVnd: 1_000, warn80: true })).toBe('ok')
    expect(aiBudgetState({ spentVnd: 800, limitVnd: 1_000, warn80: true })).toBe('warn')
    expect(aiBudgetState({ spentVnd: 900, limitVnd: 1_000, warn80: false })).toBe('ok')
    expect(aiBudgetState({ spentVnd: 1_000, limitVnd: 1_000, warn80: false })).toBe('blocked')
    expect(aiBudgetState({ spentVnd: 0, limitVnd: 0, warn80: true })).toBe('blocked')
  })
})

describe('generateText', () => {
  it('thành công → {text, usage}; 1 dòng ai_usage; chỗ giữ thay bằng chi phí thật', async () => {
    let reservedDuringCall = -1
    fake.onResponse(async () => {
      reservedDuringCall = (await counts()).reservations
      return { ok: true, id: 'r1', text: FAKE_RESPONSE_TEXT, usage: { inputTokens: 1_000, cachedInputTokens: 200, outputTokens: 500 }, incomplete: null }
    })
    const result = await generateText(depsOf(), {
      feature: 'compose_caption',
      pageId: 'page-1',
      ref: 'post-9',
      instructions: 'Viết caption',
      input: SECRET_PROMPT,
      maxOutputTokens: 400,
    })
    expect(result.text).toBe(FAKE_RESPONSE_TEXT)
    expect(result.incomplete).toBeNull()
    expect(result.usage).toMatchObject({ model: 'gpt-6-luna', inputTokens: 1_000, cachedInputTokens: 200, outputTokens: 500, images: 0, usdMicros: 332, costVnd: 9 })
    expect(reservedDuringCall).toBe(1)

    const [row] = await handle.sql`select * from ai_usage`
    expect(row).toMatchObject({
      id: result.usage.usageId,
      month: MONTH,
      feature: 'compose_caption',
      model: 'gpt-6-luna',
      page_id: 'page-1',
      ref: 'post-9',
      input_tokens: 1_000,
      cached_input_tokens: 200,
      output_tokens: 500,
      images: 0,
    })
    expect(Number(row!.usd_micros)).toBe(332)
    expect(Number(row!.cost_vnd)).toBe(9)
    expect(await counts()).toEqual({ usage: 1, reservations: 0 })
    expect(Number((await monthRow())!.spent_vnd)).toBe(9)

    // Gọi OpenAI đúng model đã chọn, có khoá, không lưu ở OpenAI (store:false do adapter đặt).
    expect(fake.responseRequests).toHaveLength(1)
    expect(fake.responseRequests[0]).toMatchObject({ apiKey: GOOD, model: 'gpt-6-luna', maxOutputTokens: 400, instructions: 'Viết caption', input: SECRET_PROMPT })
  })

  it('dùng model chữ đã chọn ở Cài đặt và tỉ giá trong Cài đặt', async () => {
    await setPrefs({ textModel: 'gpt-6.1-sol', exchangeRateVnd: 25_000 })
    const result = await generateText(depsOf(), { feature: 'inbox_suggest', input: 'x', maxOutputTokens: 10 })
    // 1000×2,00 + 500×10,00 = 7000 micro-USD × 25.000 = 175 đ.
    expect(result.usage).toMatchObject({ model: 'gpt-6.1-sol', usdMicros: 7_000, costVnd: 175 })
  })

  it('chưa có khoá / khoá invalid → lỗi, không giữ chỗ, không gọi OpenAI', async () => {
    await handle.sql`delete from secrets where name = 'openai_api_key'`
    expect((await errorOf(generateText(depsOf(), roundCall))).code).toBe('OPENAI_KEY_MISSING')
    await storeKey()
    await handle.sql`update secrets set status = 'invalid' where name = 'openai_api_key'`
    expect((await errorOf(generateText(depsOf(), roundCall))).code).toBe('OPENAI_KEY_INVALID')
    expect((await errorOf(generateImage(depsOf(), { feature: 'image_generate', prompt: 'p' }))).code).toBe('OPENAI_KEY_INVALID')
    expect(fake.responseRequests).toHaveLength(0)
    expect(fake.imageRequests).toHaveLength(0)
    expect(await counts()).toEqual({ usage: 0, reservations: 0 })
  })

  it('hết hạn mức (đã tiêu + đang giữ + ước tính > hạn mức) → AI_BUDGET_EXCEEDED 402, không gọi OpenAI', async () => {
    await setPrefs({ ...ROUND, monthlyLimitVnd: 1_000 })
    fake.onResponse(roundUsage)
    await settle(depsOf(), { reservationId: null, month: MONTH, feature: 'autoreply', model: 'gpt-6-luna', pageId: null, ref: null, usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, images: 0 }, cost: { usdMicros: 0, costVnd: 850 } })
    await reserve(depsOf(), 60) // một lời gọi khác đang giữ 60 đ → còn 90 đ < 100 đ ước tính
    const err = await errorOf(generateText(depsOf(), roundCall))
    expect(err.code).toBe('AI_BUDGET_EXCEEDED')
    expect(err.statusCode).toBe(402)
    // Chưa hết hạn mức (850/1000) nhưng phần còn lại (1000 − 850 − 60 = 90) không đủ cho ước tính 100.
    expect(err.details).toMatchObject({ remainingVnd: 90, estimateVnd: 100, spentVnd: 850, reservedVnd: 60, limitVnd: 1_000 })
    expect(fake.responseRequests).toHaveLength(0)
    expect(await counts()).toEqual({ usage: 1, reservations: 1 })

    // Qua API: 402 + mã lỗi.
    const app = buildApp({ sql: handle.sql, db: handle.db, logger: log, events })
    app.get('/api/v1/test/ai-text', () => generateText(depsOf(), roundCall))
    const token = (await createSession(handle.db)).token
    const res = await app.inject({ method: 'GET', url: '/api/v1/test/ai-text', headers: { cookie: `${SESSION_COOKIE}=${token}` } })
    expect(res.statusCode).toBe(402)
    expect(ErrorResponse.parse(res.json()).error.code).toBe('AI_BUDGET_EXCEEDED')
    await app.close()
  })

  it('song song (api + worker) sát ngưỡng: tổng không vượt hạn mức; cờ 80% và 100% lật đúng một lần', async () => {
    await setPrefs({ ...ROUND, monthlyLimitVnd: 1_000 })
    fake.onResponse(async () => {
      await sleep(400) // giữ chỗ trong lúc "gọi OpenAI"
      return roundUsage
    })
    const calls = Array.from({ length: 16 }, (_, i) => generateText(depsOf(i % 2 ? handle2 : handle), { ...roundCall, ref: `c${i}` }))
    const results = await Promise.allSettled(calls)
    const ok = results.filter((r) => r.status === 'fulfilled')
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    expect(ok).toHaveLength(10)
    expect(rejected.map((r) => (r.reason as AppError).code)).toEqual(Array(6).fill('AI_BUDGET_EXCEEDED'))
    expect(fake.responseRequests).toHaveLength(10)

    const row = (await monthRow())!
    expect(Number(row.spent_vnd)).toBe(1_000)
    expect(row).toMatchObject({ alerted_80: true, alerted_100: true })
    expect(await counts()).toEqual({ usage: 10, reservations: 0 })
    await waitFor(() => budgetEvents().length >= 2)
    await sleep(200)
    expect(budgetEvents()).toEqual([
      { type: 'ai_budget.threshold_reached', entity: 'ai_budget', id: `${MONTH}:80` },
      { type: 'ai_budget.threshold_reached', entity: 'ai_budget', id: `${MONTH}:100` },
    ])
    // Đã chạm 100% → lời gọi sau bị chặn.
    expect((await errorOf(generateText(depsOf(), roundCall))).code).toBe('AI_BUDGET_EXCEEDED')
  })

  it('vượt 80% lần đầu → threshold_reached{80}; warn80 tắt → không phát 80%, 100% vẫn chặn', async () => {
    await setPrefs({ ...ROUND, monthlyLimitVnd: 1_000 })
    fake.onResponse(roundUsage)
    for (let i = 0; i < 7; i++) await generateText(depsOf(), roundCall)
    await sleep(150)
    expect(budgetEvents()).toEqual([])
    await generateText(depsOf(), roundCall) // 800 đ = 80%
    await generateText(depsOf(), roundCall) // 900 đ — không phát lại
    await waitFor(() => budgetEvents().length >= 1)
    await sleep(150)
    expect(budgetEvents().map((m) => m.id)).toEqual([`${MONTH}:80`])
    expect((await getBudgetSummary(depsOf())).state).toBe('warn')

    // Làm lại với warn80 tắt.
    await handle.sql`delete from ai_usage`
    await handle.sql`delete from ai_budget_months`
    await setPrefs({ ...ROUND, monthlyLimitVnd: 1_000, warn80: false })
    await sleep(50)
    realtime.messages.length = 0
    for (let i = 0; i < 9; i++) await generateText(depsOf(), roundCall)
    expect((await getBudgetSummary(depsOf())).state).toBe('ok')
    await generateText(depsOf(), roundCall) // 1000 đ = 100%
    await waitFor(() => budgetEvents().length >= 1)
    await sleep(150)
    expect(budgetEvents().map((m) => m.id)).toEqual([`${MONTH}:100`])
    // Cờ 80% vẫn ghi nhận (không phát) — bật lại công tắc sau đó không phát toast 80% cho tháng này.
    expect(await monthRow()).toMatchObject({ alerted_80: true, alerted_100: true })
    expect((await getBudgetSummary(depsOf())).state).toBe('blocked')
    expect((await errorOf(generateText(depsOf(), roundCall))).code).toBe('AI_BUDGET_EXCEEDED')
  })

  it('tăng hạn mức → cờ hạ theo tỉ lệ mới, phát ai_budget.restored (consumer settings.updated)', async () => {
    await setPrefs({ ...ROUND, monthlyLimitVnd: 1_000 })
    fake.onResponse(roundUsage)
    for (let i = 0; i < 10; i++) await generateText(depsOf(), roundCall)
    expect(await monthRow()).toMatchObject({ alerted_80: true, alerted_100: true })

    // 1000/1200 = 83% → hạ 100%, giữ 80%.
    await setPrefs({ ...ROUND, monthlyLimitVnd: 1_200 })
    await sleep(50)
    realtime.messages.length = 0
    expect(await handleAiEvent(depsOf(), settingsChanged())).toBe('recomputed')
    expect(await monthRow()).toMatchObject({ alerted_80: true, alerted_100: false })
    await waitFor(() => budgetEvents('ai_budget.restored').length >= 1)
    expect((await getBudgetSummary(depsOf())).state).toBe('warn')

    // 1000/2000 = 50% → hạ cả hai; chạy lại consumer không phát trùng.
    await setPrefs({ ...ROUND, monthlyLimitVnd: 2_000 })
    await sleep(50)
    realtime.messages.length = 0
    await handleAiEvent(depsOf(), settingsChanged())
    await handleAiEvent(depsOf(), settingsChanged())
    expect(await monthRow()).toMatchObject({ alerted_80: false, alerted_100: false })
    await waitFor(() => budgetEvents('ai_budget.restored').length >= 1)
    await sleep(150)
    expect(budgetEvents('ai_budget.restored')).toEqual([{ type: 'ai_budget.restored', entity: 'ai_budget', id: MONTH }])
    expect(budgetEvents()).toEqual([])
    expect((await getBudgetSummary(depsOf())).state).toBe('ok')

    // Giảm lại hạn mức → cờ lật lên, phát threshold_reached.
    await setPrefs({ ...ROUND, monthlyLimitVnd: 1_000 })
    await handleAiEvent(depsOf(), settingsChanged())
    await waitFor(() => budgetEvents().length >= 2)

    // Sự kiện khác / khoá khác → bỏ qua.
    expect(await handleAiEvent(depsOf(), { event: 'settings.updated', payload: { id: 'openai_api_key', keys: ['openai_api_key'] } })).toBe('ignored')
    expect(QUEUES['events.ai'].subscribes).toContain('settings.updated')
  })

  it('OpenAI 401 lúc chạy → secrets invalid, phát openai_key.invalidated + settings.updated; lời gọi sau không gọi ra ngoài', async () => {
    fake.onResponse({ ok: false, kind: 'KEY_INVALID', status: 401 })
    const err = await errorOf(generateText(depsOf(), roundCall))
    expect(err.code).toBe('OPENAI_KEY_INVALID')
    expect(await counts()).toEqual({ usage: 0, reservations: 0 })
    const [secret] = await handle.sql`select status from secrets where name = 'openai_api_key'`
    expect(secret!.status).toBe('invalid')
    await waitFor(() => realtime.messages.some((m) => m.type === 'openai_key.invalidated'))
    expect(realtime.messages).toEqual(
      expect.arrayContaining([
        { type: 'openai_key.invalidated', entity: 'openai_key', id: 'openai_api_key' },
        { type: 'settings.updated', entity: 'settings', id: 'openai_api_key' },
      ]),
    )
    const before = fake.responseRequests.length
    expect((await errorOf(generateText(depsOf(), roundCall))).code).toBe('OPENAI_KEY_INVALID')
    expect(fake.responseRequests).toHaveLength(before)
  })

  it.each([
    [{ ok: false, kind: 'KEY_RESTRICTED', status: 403 }, 'OPENAI_KEY_RESTRICTED', 400, { kind: 'KEY_RESTRICTED' }],
    [{ ok: false, kind: 'PROVIDER_QUOTA', status: 429 }, 'AI_PROVIDER_ERROR', 502, { kind: 'PROVIDER_QUOTA', status: 429 }],
    [{ ok: false, kind: 'RATE_LIMITED', status: 429 }, 'RATE_LIMITED', 429, { kind: 'RATE_LIMITED' }],
    [{ ok: false, kind: 'CONTENT_REJECTED', status: 400 }, 'AI_POLICY_BLOCKED', 422, { kind: 'CONTENT_REJECTED' }],
    [{ ok: false, kind: 'TRANSIENT', status: 503 }, 'AI_PROVIDER_ERROR', 502, { kind: 'TRANSIENT', status: 503 }],
    [{ ok: false, kind: 'TRANSIENT', maybeBilled: false }, 'AI_PROVIDER_ERROR', 502, { kind: 'TRANSIENT' }],
    [{ ok: false, kind: 'INVALID_REQUEST', status: 400 }, 'AI_PROVIDER_ERROR', 400, { kind: 'INVALID_REQUEST', status: 400 }],
    [{ ok: false, kind: 'ABORTED', maybeBilled: false }, null, null, null],
  ] as const)('lỗi %o → %s, trả chỗ giữ, không ghi chi phí, khoá vẫn valid', async (result, code, status, details) => {
    fake.onResponse(result as CreateResponseResult)
    if (code === null) {
      await expect(generateText(depsOf(), roundCall)).rejects.toMatchObject({ name: 'AbortError' })
    } else {
      const err = await errorOf(generateText(depsOf(), roundCall))
      expect({ code: err.code, status: err.statusCode, details: err.details }).toEqual({ code, status, details })
    }
    expect(await counts()).toEqual({ usage: 0, reservations: 0 })
    const [secret] = await handle.sql`select status from secrets where name = 'openai_api_key'`
    expect(secret!.status).toBe('valid')
  })

  it('hết giờ / đứt kết nối sau khi gửi (TRANSIENT maybeBilled) → ghi chi phí ước tính, estimated = true', async () => {
    await setPrefs({ ...ROUND, monthlyLimitVnd: 1_000 })
    fake.onResponse({ ok: false, kind: 'TRANSIENT', maybeBilled: true })
    const err = await errorOf(generateText(depsOf(), roundCall))
    expect(err.code).toBe('AI_PROVIDER_ERROR')
    // Story 6.6: lỗi có thể đã tính tiền mang cờ để caller không retry.
    expect(err.details).toEqual({ kind: 'TRANSIENT', maybeBilled: true })
    expect(isMaybeBilled(err)).toBe(true)
    expect(await counts()).toEqual({ usage: 1, reservations: 0 })
    const [row] = await handle.sql`select estimated, cost_vnd, usd_micros, feature from ai_usage`
    expect(row).toMatchObject({ estimated: true, cost_vnd: '100', usd_micros: '100', feature: 'autoreply' })
    expect(Number((await monthRow())!.spent_vnd)).toBe(100)
  })

  it('settle lỗi sau lời gọi đã tính tiền → trả chỗ giữ, log feature/model/chi phí (không nội dung), ném lại', async () => {
    await handle.sql.unsafe(`
      create or replace function testonly_fail_usage() returns trigger language plpgsql as $$
      begin if new.ref = 'boom' then raise exception 'testonly: ghi ai_usage hỏng'; end if; return new; end $$;
      create trigger testonly_fail_usage before insert on ai_usage for each row execute function testonly_fail_usage();`)
    try {
      logLines.length = 0
      await expect(generateText(depsOf(), { ...roundCall, input: SECRET_PROMPT, ref: 'boom' })).rejects.toThrow(/Failed query: insert into "ai_usage"/)
      expect(await counts()).toEqual({ usage: 0, reservations: 0 })
      const logs = logLines.join('\n')
      expect(logs).toContain('ai: không ghi được chi phí lời gọi đã tính tiền')
      expect(logs).toMatch(/"feature":"autoreply".*"costVnd":10/)
      expect(logs).not.toContain('BÍ-MẬT')
    } finally {
      await handle.sql.unsafe(`drop trigger if exists testonly_fail_usage on ai_usage; drop function if exists testonly_fail_usage();`)
    }
  })

  it('nội dung bị bộ lọc chặn sau khi sinh → AI_POLICY_BLOCKED nhưng vẫn ghi chi phí đã tốn', async () => {
    fake.onResponse({ ok: true, id: 'r', text: '', usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 5 }, incomplete: 'content_filter' })
    const err = await errorOf(generateText(depsOf(), roundCall))
    expect(err.code).toBe('AI_POLICY_BLOCKED')
    expect(await counts()).toEqual({ usage: 1, reservations: 0 })
  })

  it('huỷ (AbortSignal) sau khi đã gửi → abort sang OpenAI, ghi chi phí ƯỚC TÍNH (OpenAI có thể đã tính tiền)', async () => {
    await setPrefs({ ...ROUND, monthlyLimitVnd: 1_000 })
    let sawAbort = false
    fake.onResponse(
      (req) =>
        new Promise((resolve) => {
          req.signal!.addEventListener('abort', () => {
            sawAbort = true
            resolve({ ok: false, kind: 'ABORTED', maybeBilled: true })
          })
        }),
    )
    const controller = new AbortController()
    const call = generateText(depsOf(), { ...roundCall, signal: controller.signal })
    await waitFor(async () => (await counts()).reservations === 1)
    controller.abort()
    await expect(call).rejects.toMatchObject({ name: 'AbortError' })
    expect(sawAbort).toBe(true)
    expect(await counts()).toEqual({ usage: 1, reservations: 0 })
    const [row] = await handle.sql`select estimated, cost_vnd, input_tokens, output_tokens from ai_usage`
    expect(row).toMatchObject({ estimated: true, cost_vnd: '100', input_tokens: 0, output_tokens: 0 })
    // Huỷ trước khi gọi → không giữ chỗ, không gọi.
    const before = fake.responseRequests.length
    await expect(generateText(depsOf(), { ...roundCall, signal: AbortSignal.abort() })).rejects.toMatchObject({ name: 'AbortError' })
    expect(fake.responseRequests).toHaveLength(before)
  })

  it('sang tháng mới → dòng tháng mới, cờ về false', async () => {
    await setPrefs({ ...ROUND, monthlyLimitVnd: 1_000 })
    fake.onResponse(roundUsage)
    for (let i = 0; i < 10; i++) await generateText(depsOf(), roundCall)
    expect((await getBudgetSummary(depsOf())).state).toBe('blocked')

    const november = () => new Date('2026-10-31T17:30:00Z') // 00:30 ngày 01/11 giờ VN
    const result = await generateText(depsOf(handle, november), roundCall)
    expect(result.text).toBe('ok')
    expect(await monthRow('2026-11')).toMatchObject({ spent_vnd: '100', alerted_80: false, alerted_100: false })
    expect(await monthRow('2026-10')).toMatchObject({ spent_vnd: '1000', alerted_80: true, alerted_100: true })
    const summary = await getBudgetSummary(depsOf(handle, november))
    expect(summary).toMatchObject({ month: '2026-11', spentVnd: 100, percent: 10, state: 'ok' })
  })

  it('model chưa có giá → CONFIG_MISSING, không gọi OpenAI', async () => {
    await handle.sql`insert into ai_model_prices (model, kind, label, sort) values ('testonly-unpriced', 'text', 'Chưa giá', 99) on conflict do nothing`
    const err = await errorOf(generateText(depsOf(), { ...roundCall, model: 'testonly-unpriced' }))
    expect(err.code).toBe('CONFIG_MISSING')
    expect((await errorOf(generateText(depsOf(), { ...roundCall, model: 'gpt-image-2' }))).code).toBe('VALIDATION_FAILED')
    await handle.sql`insert into ai_model_prices (model, kind, label, input_usd_per_1m, cached_input_usd_per_1m, output_usd_per_1m, active, sort)
      values ('testonly-inactive-priced', 'text', 'Đã tắt', 0.1, 0.01, 0.5, false, 98) on conflict do nothing`
    const inactive = await errorOf(generateText(depsOf(), { ...roundCall, model: 'testonly-inactive-priced' }))
    expect(inactive.code).toBe('VALIDATION_FAILED')
    expect(JSON.stringify(inactive.details)).toContain('đang tắt')
    expect((await errorOf(generateText(depsOf(), { ...roundCall, feature: 'nope' as never }))).code).toBe('VALIDATION_FAILED')
    expect(fake.responseRequests).toHaveLength(0)
    expect(await counts()).toEqual({ usage: 0, reservations: 0 })
  })
})

describe('cờ cảnh báo, consumer và các ca biên', () => {
  it('bật/tắt warn80 không đổi alerted_80: tắt không phát restored, bật lại không phát lại 80%', async () => {
    await setPrefs({ ...ROUND, monthlyLimitVnd: 1_000 })
    fake.onResponse(roundUsage)
    for (let i = 0; i < 9; i++) await generateText(depsOf(), roundCall) // 900 đ = 90%
    await waitFor(() => budgetEvents().length >= 1)

    await setPrefs({ ...ROUND, monthlyLimitVnd: 1_000, warn80: false })
    await sleep(50)
    realtime.messages.length = 0
    await handleAiEvent(depsOf(), settingsChanged())
    expect(await monthRow()).toMatchObject({ alerted_80: true, alerted_100: false })
    expect((await getBudgetSummary(depsOf())).state).toBe('ok')

    await setPrefs({ ...ROUND, monthlyLimitVnd: 1_000, warn80: true })
    await handleAiEvent(depsOf(), settingsChanged())
    expect((await getBudgetSummary(depsOf())).state).toBe('warn')
    await sleep(250)
    expect(budgetEvents()).toEqual([])
    expect(budgetEvents('ai_budget.restored')).toEqual([])
  })

  it('handleAiEvent: payload sai dạng / thiếu keys → bỏ qua, không ném (không đốt retry)', async () => {
    expect(await handleAiEvent(depsOf(), { event: 'settings.updated', payload: { id: 'openai' } })).toBe('ignored')
    expect(await handleAiEvent(depsOf(), { event: 'settings.updated', payload: { id: 'openai', keys: 'openai' } })).toBe('ignored')
    expect(await handleAiEvent(depsOf(), { event: 'settings.updated' })).toBe('ignored')
    expect(await handleAiEvent(depsOf(), 'rác')).toBe('ignored')
    expect(await handleAiEvent(depsOf(), null)).toBe('ignored')
  })

  it('nhiều lời gọi song song cùng gặp 401 → đúng một openai_key.invalidated và một settings.updated', async () => {
    fake.onResponse(async () => {
      await sleep(100)
      return { ok: false, kind: 'KEY_INVALID', status: 401 }
    })
    const results = await Promise.allSettled(Array.from({ length: 6 }, (_, i) => generateText(depsOf(i % 2 ? handle2 : handle), roundCall)))
    expect(results.map((r) => (r.status === 'rejected' ? (r.reason as AppError).code : 'ok'))).toEqual(Array(6).fill('OPENAI_KEY_INVALID'))
    await waitFor(() => realtime.messages.some((m) => m.type === 'openai_key.invalidated'))
    await sleep(250)
    expect(realtime.messages.filter((m) => m.type === 'openai_key.invalidated')).toHaveLength(1)
    expect(realtime.messages.filter((m) => m.type === 'settings.updated' && m.id === 'openai_api_key')).toHaveLength(1)
    expect(await counts()).toEqual({ usage: 0, reservations: 0 })
  })

  it('khoá được thay giữa lời gọi rồi khoá cũ gặp 401 → khoá mới không bị đánh dấu invalid', async () => {
    const GOOD2 = 'sk-proj-GATEWAY-key-bbbb2222'
    fake.set(GOOD2, { ok: true })
    fake.onResponse(async () => {
      await setOpenAiKey({ db: handle.db, events, cipher, openai: fake }, GOOD2)
      await sleep(50)
      realtime.messages.length = 0
      return { ok: false, kind: 'KEY_INVALID', status: 401 }
    })
    expect((await errorOf(generateText(depsOf(), roundCall))).code).toBe('OPENAI_KEY_INVALID')
    const [secret] = await handle.sql`select status, last4 from secrets where name = 'openai_api_key'`
    expect(secret).toMatchObject({ status: 'valid', last4: '2222' })
    await sleep(250)
    expect(realtime.messages.filter((m) => m.type === 'openai_key.invalidated')).toEqual([])
  })

  it('giữ chỗ lúc 23:59 ngày 31/10 (giờ VN), ghi chi phí sau nửa đêm → vẫn tính vào tháng 10', async () => {
    let clock = new Date('2026-10-31T16:59:30Z') // 23:59:30 giờ VN
    fake.onResponse(async () => {
      clock = new Date('2026-10-31T17:00:30Z') // 00:00:30 ngày 01/11 giờ VN
      return { ok: true, id: 'r', text: 'ok', usage: { inputTokens: 1_000, cachedInputTokens: 0, outputTokens: 500 }, incomplete: null }
    })
    await generateText(depsOf(handle, () => clock), roundCall)
    const rows = await handle.sql<{ month: string }[]>`select month from ai_usage`
    expect(rows.map((r) => r.month)).toEqual(['2026-10'])
    expect(Number((await monthRow('2026-10'))!.spent_vnd)).toBeGreaterThan(0)
    expect(await monthRow('2026-11')).toBeUndefined()
  })

  it('resetSimulatedSpend (ai-simulate --reset): xoá chi phí giả, tính lại tổng và hạ cờ', async () => {
    await setPrefs({ ...ROUND, monthlyLimitVnd: 1_000 })
    const zero = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, images: 0 }
    await settle(depsOf(), { reservationId: null, month: MONTH, feature: 'autoreply', model: 'gpt-6-luna', pageId: null, ref: null, usage: zero, cost: { usdMicros: 100, costVnd: 100 } })
    await settle(depsOf(), { reservationId: null, month: MONTH, feature: 'compose_caption', model: 'dev-simulate', pageId: null, ref: 'ai-simulate', usage: zero, cost: { usdMicros: 900, costVnd: 900 } })
    expect(await monthRow()).toMatchObject({ spent_vnd: '1000', alerted_80: true, alerted_100: true })
    await sleep(50)
    realtime.messages.length = 0
    expect(await resetSimulatedSpend(depsOf())).toBe(1)
    expect(await monthRow()).toMatchObject({ spent_vnd: '100', alerted_80: false, alerted_100: false })
    expect(await counts()).toEqual({ usage: 1, reservations: 0 })
    await waitFor(() => budgetEvents('ai_budget.restored').length === 1)
  })
})

describe('generateImage', () => {
  it('không có usage → bytes ảnh + 1 dòng ai_usage (images = n), chi phí = n × 0,05 USD', async () => {
    const result = await generateImage(depsOf(), { feature: 'image_generate', pageId: 'page-2', prompt: SECRET_PROMPT, n: 2 })
    expect(result.mimeType).toBe('image/jpeg')
    expect(result.images).toEqual([FAKE_JPEG, FAKE_JPEG])
    expect(result).toMatchObject({ requested: 2, received: 2 })
    // 2 × 0,05 USD = 100.000 micro-USD × 26.000 = 2.600 đ.
    expect(result.usage).toMatchObject({ model: 'gpt-image-2.5-flare', images: 2, usdMicros: 100_000, costVnd: 2_600 })
    expect(fake.imageRequests[0]).toMatchObject({ model: 'gpt-image-2.5-flare', n: 2, size: '1024x1024', prompt: SECRET_PROMPT })
    const [row] = await handle.sql`select feature, model, page_id, images, cost_vnd from ai_usage`
    expect(row).toMatchObject({ feature: 'image_generate', model: 'gpt-image-2.5-flare', page_id: 'page-2', images: 2, cost_vnd: '2600' })
    expect(await counts()).toEqual({ usage: 1, reservations: 0 })
  })

  it('có usage → tính theo token (input chữ 5,00 + output ảnh 30,00); kích thước và model theo Cài đặt', async () => {
    await setPrefs({ imageModel: 'gpt-image-2', imageSize: '1536x1024' })
    fake.onImage({ ok: true, images: [Buffer.from(FAKE_JPEG)], usage: { inputTokens: 50, cachedInputTokens: 0, outputTokens: 4_160 } })
    const result = await generateImage(depsOf(), { feature: 'image_generate', prompt: 'p' })
    // 50×5 + 4160×30 = 125.050 micro-USD × 26.000 = 3.251,3 → 3.252 đ.
    expect(result.usage).toMatchObject({ model: 'gpt-image-2', images: 1, inputTokens: 50, outputTokens: 4_160, usdMicros: 125_050, costVnd: 3_252 })
    expect(fake.imageRequests[0]).toMatchObject({ model: 'gpt-image-2', size: '1536x1024', n: 1 })
  })

  it('chi phí thật vượt ước tính cũ (n × 0,05 USD) nhưng không vượt ước tính theo kích thước (0,10 USD)', async () => {
    let reservedVnd = -1
    fake.onImage(async () => {
      reservedVnd = Number((await handle.sql`select est_vnd from ai_reservations`)[0]!.est_vnd)
      return { ok: true, images: [Buffer.from(FAKE_JPEG)], usage: { inputTokens: 50, cachedInputTokens: 0, outputTokens: 3_000 } }
    })
    const result = await generateImage(depsOf(), { feature: 'image_generate', prompt: 'p', size: '1024x1024' })
    // Thật: 50×5 + 3000×30 = 90.250 micro-USD → 2.347 đ. Cũ: 0,05 USD = 1.300 đ. Mới: 0,10 USD = 2.600 đ.
    expect(result.usage.costVnd).toBe(2_347)
    expect(reservedVnd).toBe(2_600)
    expect(result.usage.costVnd).toBeGreaterThan(1_300)
    expect(result.usage.costVnd).toBeLessThanOrEqual(reservedVnd)
  })

  it('OpenAI trả ít ảnh hơn yêu cầu → {requested, received}, chỉ tính tiền ảnh nhận được', async () => {
    fake.onImage({ ok: true, images: [Buffer.from(FAKE_JPEG)], usage: null })
    const result = await generateImage(depsOf(), { feature: 'image_generate', prompt: 'p', n: 3 })
    expect(result).toMatchObject({ requested: 3, received: 1, images: [FAKE_JPEG] })
    expect(result.usage).toMatchObject({ images: 1, costVnd: 1_300 })
  })

  it('lỗi → trả chỗ giữ; n sai → VALIDATION_FAILED', async () => {
    fake.onImage({ ok: false, kind: 'CONTENT_REJECTED', status: 400 })
    expect((await errorOf(generateImage(depsOf(), { feature: 'image_generate', prompt: 'p' }))).code).toBe('AI_POLICY_BLOCKED')
    expect(await counts()).toEqual({ usage: 0, reservations: 0 })
    expect((await errorOf(generateImage(depsOf(), { feature: 'image_generate', prompt: 'p', n: 9 }))).code).toBe('VALIDATION_FAILED')
  })
})

describe('ảnh vào (Story 6.6)', () => {
  const REF = { data: Buffer.from(FAKE_JPEG), mime: 'image/jpeg' as const }

  it('giá seed: token ảnh vào 8,00 USD/1M cho cả 3 model ảnh; model chữ không có', async () => {
    const rows = await handle.sql<{ model: string; v: string | null }[]>`
      select model, image_input_usd_per_1m::text as v from ai_model_prices where model not like 'testonly-%' order by kind desc, sort`
    expect(rows.map((r) => [r.model, r.v === null ? null : Number(r.v)])).toEqual([
      ['gpt-6-luna', null],
      ['gpt-6.1-sol', null],
      ['gpt-6-astra', null],
      ['gpt-image-2.5-flare', 8],
      ['gpt-image-2.5-sunburst', 8],
      ['gpt-image-2', 8],
    ])
  })

  it('computeCost tách token ảnh vào: 1000 ảnh × 8 + 100 chữ × 5 + 4160 × 30 (micro-USD); thiếu giá ảnh → giá chữ', () => {
    const img: ModelPrice = { model: 'g', kind: 'image', active: true, input: 5_000_000n, cachedInput: null, output: 30_000_000n, imageEach: 50_000n, imageInput: 8_000_000n }
    const usage = { inputTokens: 1_100, imageInputTokens: 1_000, cachedInputTokens: 0, outputTokens: 4_160, images: 1 }
    // 8.000 + 500 + 124.800 = 133.300 micro-USD × 26.000 = 3.465,8 → 3.466 đ.
    expect(computeCost(img, usage, 26_000)).toEqual({ usdMicros: 133_300, costVnd: 3_466 })
    // Không giá ảnh vào: 1100 × 5 + 124.800 = 130.300.
    expect(computeCost({ ...img, imageInput: null }, usage, 26_000).usdMicros).toBe(130_300)
  })

  it('generateImage({references}) → editImage (không gọi generations), input_fidelity theo model, chi phí theo usage tách ảnh', async () => {
    await setPrefs({ imageModel: 'gpt-image-2', imageSize: '1024x1024' })
    let reservedVnd = -1
    fake.onEdit(async () => {
      reservedVnd = Number((await handle.sql`select est_vnd from ai_reservations`)[0]!.est_vnd)
      return { ok: true, images: [Buffer.from(FAKE_JPEG)], usage: { inputTokens: 1_100, imageInputTokens: 1_000, cachedInputTokens: 0, outputTokens: 4_160 } }
    })
    const result = await generateImage(depsOf(), { feature: 'image_generate', prompt: 'p', references: [REF] })
    expect(fake.imageRequests).toHaveLength(0)
    expect(fake.editRequests).toHaveLength(1)
    expect(fake.editRequests[0]).toMatchObject({ model: 'gpt-image-2', n: 1, size: '1024x1024', images: [REF] })
    expect(fake.editRequests[0]!.inputFidelity).toBeUndefined() // gpt-image-2: bỏ tham số
    expect(result.usage).toMatchObject({ usdMicros: 133_300, costVnd: 3_466 })
    // Giữ chỗ = ảnh ra 0,10 USD + 6.000 token ảnh vào × 8 = 0,148 USD → 3.848 đ (≥ chi phí thật).
    expect(reservedVnd).toBe(3_848)
    const [row] = await handle.sql`select feature, input_tokens, output_tokens, cost_vnd from ai_usage`
    expect(row).toMatchObject({ feature: 'image_generate', input_tokens: 1_100, output_tokens: 4_160, cost_vnd: '3466' })
  })

  it('generateText({images}) → ảnh tới adapter với detail low; giữ chỗ cộng 1.600 token ảnh; input phải là chuỗi', async () => {
    let reservedVnd = -1
    fake.onResponse(async () => {
      reservedVnd = Number((await handle.sql`select est_vnd from ai_reservations`)[0]!.est_vnd)
      return roundUsage
    })
    await setPrefs(ROUND)
    await generateText(depsOf(), { ...roundCall, images: [REF] })
    expect(fake.responseRequests[0]!.images).toEqual([{ ...REF, detail: 'low' }])
    expect(fake.responseRequests[0]!.input).toBe('abc')
    // 100 đ của lời gọi chữ + 1.600 × 0,10 = 160 đ của ảnh.
    expect(reservedVnd).toBe(260)
    expect((await errorOf(generateText(depsOf(), { ...roundCall, input: [{ role: 'user', content: 'x' }], images: [REF] }))).code).toBe('VALIDATION_FAILED')
    expect((await errorOf(generateText(depsOf(), { ...roundCall, images: Array(5).fill(REF) }))).code).toBe('VALIDATION_FAILED')
    expect((await errorOf(generateImage(depsOf(), { feature: 'image_generate', prompt: 'p', references: [{ data: Buffer.alloc(0), mime: 'image/jpeg' }] }))).code).toBe('VALIDATION_FAILED')
    expect(fake.responseRequests).toHaveLength(1)
  })
})

describe('chỗ giữ bị bỏ rơi', () => {
  it('gcReservations dọn chỗ giữ cũ hơn 15 phút, giữ chỗ mới', async () => {
    const old = await reserve(depsOf(), 10)
    const fresh = await reserve(depsOf(), 10)
    await handle.sql`update ai_reservations set created_at = now() - interval '16 minutes' where id = ${old.id}`
    expect(await gcReservations(handle.db)).toBe(1)
    const left = await handle.sql<{ id: string }[]>`select id from ai_reservations`
    expect(left.map((r) => r.id)).toEqual([fresh.id])
    expect(QUEUES['ai.reservations_gc'].cron.expression).toBe('*/5 * * * *')
  })
})

describe('GET /api/v1/ai/budget', () => {
  const realMonth = MONTH

  async function get() {
    const app = buildApp({ sql: handle.sql, db: handle.db, logger: log, events, clock: () => NOW })
    const token = (await createSession(handle.db)).token
    const res = await app.inject({ method: 'GET', url: '/api/v1/ai/budget', headers: { cookie: `${SESSION_COOKIE}=${token}` } })
    const anon = await app.inject({ method: 'GET', url: '/api/v1/ai/budget' })
    await app.close()
    expect(anon.statusCode).toBe(401)
    expect(res.statusCode).toBe(200)
    return AiBudgetSummary.parse(res.json())
  }

  it('chưa có dòng tháng → mọi số = 0, đủ ba hạng mục', async () => {
    expect(await get()).toEqual({
      month: realMonth,
      limitVnd: 1_000_000,
      spentVnd: 0,
      reservedVnd: 0,
      percent: 0,
      state: 'ok',
      warn80: true,
      byCategory: [
        { category: 'reply', costVnd: 0, count: 0 },
        { category: 'content', costVnd: 0, count: 0 },
        { category: 'image', costVnd: 0, count: 0 },
      ],
    })
  })

  it('tổng tháng, % hạn mức, đang giữ, chi phí + số lượng theo hạng mục', async () => {
    const add = (feature: Parameters<typeof settle>[1]['feature'], costVnd: number, images = 0, month = realMonth) =>
      settle(depsOf(), { reservationId: null, month, feature, model: 'gpt-6-luna', pageId: null, ref: null, usage: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, images }, cost: { usdMicros: 1, costVnd } })
    await add('autoreply', 100_000)
    await add('inbox_suggest', 50_000)
    await add('autoreply_test', 10_000)
    await add('compose_caption', 200_000)
    await add('contact_summary', 40_000)
    await add('image_generate', 450_000, 3)
    await add('autoreply', 999_999, 0, '2020-01') // tháng khác không tính
    await reserve({ db: handle.db, now: () => NOW }, 1_234)
    expect(await get()).toMatchObject({
      spentVnd: 850_000,
      reservedVnd: 1_234,
      percent: 85,
      state: 'warn',
      byCategory: [
        { category: 'reply', costVnd: 160_000, count: 3 },
        { category: 'content', costVnd: 240_000, count: 2 },
        { category: 'image', costVnd: 450_000, count: 3 },
      ],
    })
  })
})

describe('AD-12: không lộ prompt / nội dung / khoá', () => {
  it('log, ai_usage và payload sự kiện không chứa prompt, chữ trả về hay khoá', async () => {
    logLines.length = 0
    await setPrefs({ ...ROUND, monthlyLimitVnd: 200_000 })
    fake.onResponse({ ok: true, id: 'r', text: SECRET_OUTPUT, usage: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 799 }, incomplete: null })
    const ok = await generateText(depsOf(), { feature: 'autoreply', instructions: SECRET_PROMPT, input: SECRET_PROMPT, maxOutputTokens: 900 })
    expect(ok.text).toBe(SECRET_OUTPUT)
    fake.onResponse({ ok: false, kind: 'TRANSIENT', status: 500 })
    await errorOf(generateText(depsOf(), { feature: 'autoreply', input: SECRET_PROMPT, maxOutputTokens: 10 }))
    fake.onImage({ ok: false, kind: 'CONTENT_REJECTED', status: 400 })
    await errorOf(generateImage(depsOf(), { feature: 'image_generate', prompt: SECRET_PROMPT }))
    expect(fake.imageRequests).toHaveLength(1)

    const logs = logLines.join('\n')
    expect(logs).toContain('ai: lời gọi xong')
    expect(logs).toContain('"costVnd"')
    expect(logs).toContain('"outputTokens":799')
    for (const secret of [SECRET_PROMPT, 'BÍ-MẬT', SECRET_OUTPUT, GOOD]) expect(logs).not.toContain(secret)
    const dump = JSON.stringify(await handle.sql`select * from ai_usage`) + JSON.stringify(await handle.sql.unsafe(`select data from ${BOSS_SCHEMA}.job`))
    for (const secret of ['BÍ-MẬT', GOOD]) expect(dump).not.toContain(secret)
  })
})
