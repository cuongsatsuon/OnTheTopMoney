// Viết thử bằng AI (Story 3.4) — endpoint `POST /api/v1/brand-profiles/sample`. Fake adapter OpenAI, Postgres thật.
// Phủ: sạch, vi phạm→sinh lại→sạch, vẫn vi phạm trả violations, URL ngoài allowlist, abort→release không settle,
// AI_BUDGET_EXCEEDED, OPENAI_KEY_MISSING, auth.
import { randomBytes } from 'node:crypto'
import { BrandSampleRequest, BrandSampleResponse, ErrorResponse } from '@ottm/shared'
import type { PgBoss } from 'pg-boss'
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest'
import { createSecretCipher } from '../src/adapters/crypto/index.ts'
import { createFakeOpenAiAdapter, type FakeOpenAiAdapter } from '../src/adapters/openai/fake.ts'
import type { CreateResponseResult } from '../src/adapters/openai/index.ts'
import { buildApp } from '../src/app/app.ts'
import { SESSION_COOKIE } from '../src/app/auth/index.ts'
import { runBrandSample } from '../src/app/brand-sample.ts'
import { setOpenAiKey, settle } from '../src/modules/ai/index.ts'
import { DEFAULT_OPENAI_PREFS, createSession, setOpenAiPrefs, type OpenAiPrefs } from '../src/modules/settings/index.ts'
import { createDb, type DbHandle } from '../src/platform/db/index.ts'
import { createEventPublisher, type EventPublisher } from '../src/platform/events/index.ts'
import { createBoss } from '../src/platform/jobs/index.ts'
import { createLogger } from '../src/platform/log/index.ts'
import { waitFor } from './helpers/realtime.ts'

const GOOD = 'sk-proj-SAMPLE-key-aaaa1111'
const MONTH = '2026-10'
const NOW = new Date('2026-10-15T05:00:00Z')

let handle: DbHandle
let boss: PgBoss
let events: EventPublisher
let fake: FakeOpenAiAdapter
const cipher = createSecretCipher({ keys: new Map([['k1', randomBytes(32)]]), activeKeyId: 'k1' })
const log = createLogger({ level: 'silent' })

const ok = (text: string): CreateResponseResult => ({ ok: true, id: 'r', text, usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 20 }, incomplete: null })

const counts = async () => {
  const [row] = await handle.sql<{ usage: number; reservations: number }[]>`
    select (select count(*)::int from ai_usage) as usage, (select count(*)::int from ai_reservations) as reservations`
  return row!
}

function makeApp() {
  return buildApp({ sql: handle.sql, db: handle.db, logger: log, events, ai: { cipher, openai: fake }, clock: () => NOW })
}

async function post(app: ReturnType<typeof buildApp>, body: unknown, opts: { auth?: boolean } = {}) {
  const headers: Record<string, string> = { 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' }
  if (opts.auth !== false) headers.cookie = `${SESSION_COOKIE}=${(await createSession(handle.db)).token}`
  return app.inject({ method: 'POST', url: '/api/v1/brand-profiles/sample', headers, payload: JSON.stringify(body) })
}

async function setPrefs(patch: Partial<OpenAiPrefs>) {
  await setOpenAiPrefs(handle.db, events, { ...DEFAULT_OPENAI_PREFS, ...patch })
}

beforeAll(async () => {
  handle = createDb(inject('databaseUrl'), { max: 10 })
  boss = createBoss(inject('databaseUrl'), 'ottm-test-brand-sample', { background: false })
  boss.on('error', () => {})
  await boss.start()
  events = createEventPublisher(boss)
})
afterAll(async () => {
  await handle.sql`delete from ai_usage`
  await handle.sql`delete from ai_reservations`
  await handle.sql`delete from ai_budget_months`
  await handle.sql`delete from secrets where name = 'openai_api_key'`
  await handle.sql`delete from settings where key = 'openai'`
  await boss.stop({ graceful: false })
  await handle.close()
})
beforeEach(async () => {
  await handle.sql`delete from ai_usage`
  await handle.sql`delete from ai_reservations`
  await handle.sql`delete from ai_budget_months`
  await handle.sql`delete from secrets where name = 'openai_api_key'`
  await handle.sql`delete from settings where key = 'openai'`
  fake = createFakeOpenAiAdapter()
  fake.set(GOOD, { ok: true })
  await setOpenAiKey({ db: handle.db, events, cipher, openai: fake }, GOOD)
})

describe('POST /api/v1/brand-profiles/sample', () => {
  it('sạch → 200 {caption, violations:[], avoidedBannedCount}; gọi OpenAI đúng một lần, không stream', async () => {
    fake.onResponse(ok('Mẫu mới về rồi cả nhà ơi, ghé xem nhé'))
    const app = makeApp()
    const res = await post(app, { name: 'Shop A', bannedWords: ['giảm giá', 'hàng fake'] })
    await app.close()
    expect(res.statusCode).toBe(200)
    expect(BrandSampleResponse.parse(res.json())).toEqual({
      caption: 'Mẫu mới về rồi cả nhà ơi, ghé xem nhé',
      violations: [],
      avoidedBannedCount: 2,
    })
    expect(fake.responseRequests).toHaveLength(1)
    expect(await counts()).toEqual({ usage: 1, reservations: 0 })
  })

  it('tên rỗng (hồ sơ nháp chưa lưu) vẫn viết thử được', async () => {
    fake.onResponse(ok('Caption không cần tên'))
    const app = makeApp()
    const res = await post(app, { bannedWords: [] })
    await app.close()
    expect(res.statusCode).toBe(200)
    expect(res.json().caption).toBe('Caption không cần tên')
  })

  it('có từ cấm lần 1 → sinh lại một lần; sạch → trả sạch (đúng 2 lời gọi)', async () => {
    let n = 0
    fake.onResponse(() => {
      n += 1
      return ok(n === 1 ? 'Siêu GIAM GIA hôm nay' : 'Mẫu mới về rồi nhé')
    })
    const app = makeApp()
    const res = await post(app, { name: 'Shop', bannedWords: ['giảm giá'] })
    await app.close()
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ caption: 'Mẫu mới về rồi nhé', violations: [] })
    expect(fake.responseRequests).toHaveLength(2)
    expect(await counts()).toEqual({ usage: 2, reservations: 0 })
  })

  it('vẫn vi phạm sau sinh lại → 200 kèm danh sách cụm vi phạm (không gọi quá 2 lần)', async () => {
    fake.onResponse(ok('Chốt đơn tại http://evil.com và GIAM GIA sốc'))
    const app = makeApp()
    const res = await post(app, { name: 'Shop', bannedWords: ['giảm giá'], allowedDomains: ['shop.vn'] })
    await app.close()
    const body = BrandSampleResponse.parse(res.json())
    expect(body.violations).toEqual([
      { kind: 'banned_word', text: 'GIAM GIA' },
      { kind: 'disallowed_url', text: 'http://evil.com' },
    ])
    expect(fake.responseRequests).toHaveLength(2)
  })

  it('hết hạn mức → 402 AI_BUDGET_EXCEEDED (FE khoá nút), không gọi OpenAI', async () => {
    await setPrefs({ monthlyLimitVnd: 100 })
    await settle({ db: handle.db, events }, { reservationId: null, month: MONTH, feature: 'brand_sample', model: 'gpt-6-luna', pageId: null, ref: null, usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, images: 0 }, cost: { usdMicros: 0, costVnd: 100 } })
    const app = makeApp()
    const res = await post(app, { name: 'Shop' })
    await app.close()
    expect(res.statusCode).toBe(402)
    expect(ErrorResponse.parse(res.json()).error.code).toBe('AI_BUDGET_EXCEEDED')
    expect(fake.responseRequests).toHaveLength(0)
  })

  it('thiếu khoá → 400 OPENAI_KEY_MISSING (FE khoá nút), không gọi OpenAI', async () => {
    await handle.sql`delete from secrets where name = 'openai_api_key'`
    const app = makeApp()
    const res = await post(app, { name: 'Shop' })
    await app.close()
    expect(res.statusCode).toBe(400)
    expect(ErrorResponse.parse(res.json()).error.code).toBe('OPENAI_KEY_MISSING')
    expect(fake.responseRequests).toHaveLength(0)
  })

  it('chưa đăng nhập → 401', async () => {
    const app = makeApp()
    const res = await post(app, { name: 'Shop' }, { auth: false })
    await app.close()
    expect(res.statusCode).toBe(401)
  })

  it('Dừng (client đóng kết nối) → request huỷ, AbortSignal sang OpenAI, reservation release, KHÔNG settle phần chưa chạy', async () => {
    // `runBrandSample` là lõi route (route chỉ nối `req.raw` 'close' → controller.abort). Fake "đang viết": chỉ trả
    // khi thấy abort → ABORTED chưa gửi (maybeBilled:false) → gateway release, không ghi `ai_usage` (AD-7).
    let sawAbort = false
    fake.onResponse(
      (req) =>
        new Promise((resolve) => {
          req.signal!.addEventListener('abort', () => {
            sawAbort = true
            resolve({ ok: false, kind: 'ABORTED', maybeBilled: false })
          })
        }),
    )
    const deps = { db: handle.db, events, cipher, openai: fake, log }
    const controller = new AbortController()
    const brand = BrandSampleRequest.parse({ name: 'Shop' })
    const call = runBrandSample(deps, brand, controller.signal)
    const rejected = expect(call).rejects.toMatchObject({ name: 'AbortError' })
    await waitFor(async () => (await counts()).reservations === 1) // giữ chỗ xong, đang "gọi OpenAI"
    controller.abort() // = nút Dừng / client đóng kết nối
    await rejected
    expect(sawAbort).toBe(true)
    expect(fake.responseRequests).toHaveLength(1)
    expect(await counts()).toEqual({ usage: 0, reservations: 0 }) // release, không settle phần chưa chạy
  })

  it('route-level: client huỷ fetch giữa lúc đang viết → fake nhận abort, release không settle, không 500', async () => {
    // HTTP thật (mẫu realtime.test.ts): socket đóng → route bắt `req.raw` 'close' → AbortSignal sang OpenAI.
    let sawAbort = false
    fake.onResponse(
      (req) =>
        new Promise((resolve) => {
          req.signal!.addEventListener('abort', () => {
            sawAbort = true
            resolve({ ok: false, kind: 'ABORTED', maybeBilled: false })
          })
        }),
    )
    const app = makeApp()
    const base = await app.listen({ port: 0, host: '127.0.0.1' })
    try {
      const token = (await createSession(handle.db)).token
      const ctrl = new AbortController()
      // Body rỗng → hồ sơ nháp mặc định (name ''); đủ để chạy flow và kiểm đường huỷ qua socket thật.
      const call = fetch(`${base}/api/v1/brand-profiles/sample`, {
        method: 'POST',
        headers: { 'sec-fetch-site': 'same-origin', cookie: `${SESSION_COOKIE}=${token}` },
        signal: ctrl.signal,
      })
      const rejected = expect(call).rejects.toThrow() // huỷ fetch → AbortError phía client (không phải 500)
      await waitFor(async () => (await counts()).reservations === 1) // đã giữ chỗ, đang "gọi OpenAI"
      ctrl.abort()
      await rejected
      await waitFor(() => sawAbort) // OpenAI (fake) nhận abort
      await waitFor(async () => (await counts()).reservations === 0) // release
      expect(await counts()).toEqual({ usage: 0, reservations: 0 }) // không settle phần chưa chạy
    } finally {
      await app.close()
    }
  })
})
