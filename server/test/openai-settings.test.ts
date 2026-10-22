// Ma trận Story 1.5 — nhập và kiểm khoá OpenAI, lựa chọn model/tỉ giá/hạn mức (fake adapter OpenAI).
import { randomBytes } from 'node:crypto'
import { Writable } from 'node:stream'
import { ErrorResponse, OpenAiKeyInfo, OpenAiSettingsResponse } from '@ottm/shared'
import type { FastifyInstance } from 'fastify'
import type { PgBoss } from 'pg-boss'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest'
import { createSecretCipher, type SecretCipher } from '../src/adapters/crypto/index.ts'
import { createFakeOpenAiAdapter, type FakeOpenAiAdapter } from '../src/adapters/openai/fake.ts'
import { buildApp } from '../src/app/app.ts'
import { SESSION_COOKIE } from '../src/app/auth/index.ts'
import { getOpenAiKey, getOpenAiKeyStatus } from '../src/modules/ai/index.ts'
import { createSession } from '../src/modules/settings/index.ts'
import { createDb, type DbHandle } from '../src/platform/db/index.ts'
import { createEventPublisher, type EventPublisher } from '../src/platform/events/index.ts'
import { BOSS_SCHEMA, createBoss } from '../src/platform/jobs/index.ts'
import { AppError } from '../src/platform/errors/index.ts'
import { createLogger } from '../src/platform/log/index.ts'
import { listenRealtime, sleep, waitFor } from './helpers/realtime.ts'

const ORIGIN = 'http://localhost:5173'
const GOOD = 'sk-proj-GOOD-test-key-aaaa1111'
const GOOD2 = 'sk-proj-GOOD-second-key-bbbb2222'
const BAD = 'sk-proj-BAD-test-key-cccc3333'
const DOWN = 'sk-proj-DOWN-test-key-dddd4444'
const LIMITED = 'sk-proj-LIMITED-key-eeee5555'
const BROKEN = 'sk-proj-5XX-test-key-ffff6666'
const QUOTA = 'sk-proj-QUOTA-test-key-gggg7777'
const RESTRICTED = 'sk-proj-403-test-key-hhhh8888'
const ALL_KEYS = [GOOD, GOOD2, BAD, DOWN, LIMITED, BROKEN, QUOTA, RESTRICTED]

let handle: DbHandle
let boss: PgBoss
let events: EventPublisher
let realtime: Awaited<ReturnType<typeof listenRealtime>>
const k1 = randomBytes(32)
const cipher: SecretCipher = createSecretCipher({ keys: new Map([['k1', k1]]), activeKeyId: 'k1' })
/** Toàn bộ log của mọi app trong file (mức trace) — cuối file kiểm không chứa khoá nào. */
const logLines: string[] = []
const logSink = new Writable({
  write(chunk, _enc, cb) {
    logLines.push(String(chunk))
    cb()
  },
})

beforeAll(async () => {
  handle = createDb(inject('databaseUrl'), { max: 3 })
  boss = createBoss(inject('databaseUrl'), 'ottm-test-openai', { background: false })
  boss.on('error', () => {})
  await boss.start()
  events = createEventPublisher(boss)
  realtime = await listenRealtime(handle.sql)
  await handle.sql`insert into ai_model_prices (model, kind, label, active, sort)
    values ('testonly-inactive', 'text', 'Đã tắt', false, -1) on conflict do nothing`
})
afterAll(async () => {
  await handle.sql`delete from ai_model_prices where model = 'testonly-inactive'`
  await handle.sql`delete from secrets where name = 'openai_api_key'`
  await handle.sql`delete from settings where key = 'openai'`
  await realtime.stop()
  await boss.stop({ graceful: false })
  await handle.close()
})

let app: FastifyInstance
let token: string
let fake: FakeOpenAiAdapter

function build(options: { cipher?: SecretCipher | null } = {}) {
  return buildApp({
    sql: handle.sql,
    db: handle.db,
    logger: createLogger({ level: 'trace' }, logSink),
    http: { allowedOrigins: [ORIGIN] },
    events,
    ai: { cipher: options.cipher === undefined ? cipher : options.cipher, openai: fake },
  })
}

beforeEach(async () => {
  await handle.sql`delete from secrets where name = 'openai_api_key'`
  await handle.sql`delete from settings where key = 'openai'`
  realtime.messages.length = 0
  fake = createFakeOpenAiAdapter({
    [GOOD]: { ok: true },
    [GOOD2]: { ok: true },
    [BAD]: { ok: false, kind: 'KEY_INVALID', status: 401 },
    [DOWN]: { ok: false, kind: 'TRANSIENT' },
    [LIMITED]: { ok: false, kind: 'RATE_LIMITED', status: 429 },
    [BROKEN]: { ok: false, kind: 'TRANSIENT', status: 503 },
    [QUOTA]: { ok: false, kind: 'PROVIDER_QUOTA', status: 429 },
    [RESTRICTED]: { ok: false, kind: 'KEY_RESTRICTED', status: 403 },
  })
  app = build()
  token = (await createSession(handle.db)).token
})
afterEach(async () => {
  await app.close()
})

const call = (method: 'GET' | 'PUT' | 'POST' | 'DELETE', url: string, payload?: unknown, auth = true) =>
  app.inject({
    method,
    url,
    headers: { ...(auth ? { cookie: `${SESSION_COOKIE}=${token}` } : {}), ...(method === 'GET' ? {} : { origin: ORIGIN }) },
    ...(payload !== undefined ? { payload: payload as object } : {}),
  })

const putKey = (apiKey: unknown) => call('PUT', '/api/v1/settings/openai/key', { apiKey })
const getSettings = async () => OpenAiSettingsResponse.parse((await call('GET', '/api/v1/settings/openai')).json())
const errorCode = (res: { json(): unknown }) => ErrorResponse.parse(res.json()).error.code
const settingsEvents = () => realtime.messages.filter((m) => m.type === 'settings.updated')
const storedSecret = async () =>
  (await handle.sql<{ kind: string; value: string; status: string | null; last4: string | null; checked_at: Date | null }[]>`
    select kind, value, status, last4, checked_at from secrets where name = 'openai_api_key'`)[0]

const VALID_PREFS = {
  textModel: 'gpt-6.1-sol',
  imageModel: 'gpt-image-2',
  imageSize: '1536x1024',
  exchangeRateVnd: 25_500,
  monthlyLimitVnd: 2_500_000,
  warn80: false,
}

describe('xác thực', () => {
  it('chưa đăng nhập → 401 UNAUTHENTICATED ở mọi route, không gọi OpenAI', async () => {
    for (const [m, u, body] of [
      ['GET', '/api/v1/settings/openai', undefined],
      ['PUT', '/api/v1/settings/openai', VALID_PREFS],
      ['PUT', '/api/v1/settings/openai/key', { apiKey: GOOD }],
      ['DELETE', '/api/v1/settings/openai/key', undefined],
      ['POST', '/api/v1/settings/openai/key/recheck', {}],
    ] as const) {
      const res = await call(m, u, body, false)
      expect(res.statusCode).toBe(401)
      expect(errorCode(res)).toBe('UNAUTHENTICATED')
    }
    expect(fake.calls).toBe(0)
  })
})

describe('GET /api/v1/settings/openai', () => {
  it('chưa có khoá → configured:false, status missing; mặc định theo Boundaries; model từ ai_model_prices', async () => {
    const res = await call('GET', '/api/v1/settings/openai')
    expect(res.statusCode).toBe(200)
    const body = OpenAiSettingsResponse.parse(res.json())
    expect(body).toMatchObject({
      key: { configured: false, last4: null, status: 'missing', checkedAt: null, reason: null },
      imageSize: '1024x1024',
      exchangeRateVnd: 26_000,
      monthlyLimitVnd: 1_000_000,
      warn80: true,
    })
    // Seed có mặt (story sau có thể thêm/đổi model); mặc định = model đầu danh sách mỗi loại.
    const ids = (kind: 'text' | 'image') => body.models[kind].map((m) => m.model)
    expect(ids('text')).toEqual(expect.arrayContaining(['gpt-6-luna', 'gpt-6.1-sol', 'gpt-6-astra']))
    expect(ids('image')).toEqual(expect.arrayContaining(['gpt-image-2.5-flare', 'gpt-image-2.5-sunburst', 'gpt-image-2']))
    expect(ids('text')).not.toContain('testonly-inactive')
    expect(body.textModel).toBe(ids('text')[0])
    expect(body.imageModel).toBe(ids('image')[0])
    expect(body.models.text.find((m) => m.model === 'gpt-6-luna')?.label).toBe('GPT-6 Luna')
  })

  it('giá trị đã lưu hỏng một phần → khoá đó lấy mặc định', async () => {
    await handle.sql`insert into settings (key, value) values ('openai', ${JSON.stringify({ textModel: 'gpt-6-astra', exchangeRateVnd: -5, imageSize: 'to-lắm' })}::jsonb)`
    const body = await getSettings()
    expect(body).toMatchObject({ textModel: 'gpt-6-astra', exchangeRateVnd: 26_000, imageSize: '1024x1024', monthlyLimitVnd: 1_000_000 })
  })
})

describe('PUT /api/v1/settings/openai/key', () => {
  it('khoá hợp lệ → lưu envelope, trả {configured,last4,status:valid,checkedAt}, phát settings.updated', async () => {
    const before = Date.now()
    const res = await putKey(GOOD)
    expect(res.statusCode).toBe(200)
    const info = OpenAiKeyInfo.parse(res.json())
    expect(info).toEqual({ configured: true, last4: '1111', status: 'valid', checkedAt: expect.stringMatching(/Z$/), reason: null })
    expect(Object.keys(res.json() as object).sort()).toEqual(['checkedAt', 'configured', 'last4', 'reason', 'status'])
    expect(Date.parse(info.checkedAt!)).toBeGreaterThanOrEqual(before - 1_000)
    expect(res.body).not.toContain(GOOD)
    expect(fake.calls).toBe(1)

    // DB chỉ chứa envelope, không chứa khoá.
    const row = await storedSecret()
    expect(row).toMatchObject({ kind: 'envelope', status: 'valid', last4: '1111' })
    expect(row!.value).toMatch(/^v1:k1:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/)
    const dump = JSON.stringify(await handle.sql`select * from secrets`)
    expect(dump).not.toContain(GOOD)
    expect(dump).not.toContain('GOOD-test-key')

    // Giải mã được (dùng ở 1.6); trạng thái đọc lại qua GET.
    expect(await getOpenAiKey({ db: handle.db, cipher })).toBe(GOOD)
    expect((await getSettings()).key).toEqual(info)

    const msg = await waitFor(() => realtime.messages.find((m) => m.type === 'settings.updated'))
    expect(msg).toEqual({ type: 'settings.updated', entity: 'settings', id: 'openai_api_key' })
    // Payload job của sự kiện không chứa khoá.
    const jobs = await handle.sql.unsafe(`select data from ${BOSS_SCHEMA}.job`)
    expect(JSON.stringify(jobs)).not.toContain(GOOD)
  })

  it('khoảng trắng hai đầu khi dán được bỏ', async () => {
    const res = await putKey(`  ${GOOD}\n`)
    expect(res.statusCode).toBe(200)
    expect(await getOpenAiKey({ db: handle.db, cipher })).toBe(GOOD)
  })

  it('khoá mới hợp lệ thay khoá cũ', async () => {
    await putKey(GOOD)
    const res = await putKey(GOOD2)
    expect(OpenAiKeyInfo.parse(res.json()).last4).toBe('2222')
    expect(await getOpenAiKey({ db: handle.db, cipher })).toBe(GOOD2)
  })

  it('khoá sai (OpenAI 401) → 400 OPENAI_KEY_INVALID, không lưu; khoá cũ giữ nguyên', async () => {
    const first = await putKey(BAD)
    expect(first.statusCode).toBe(400)
    expect(errorCode(first)).toBe('OPENAI_KEY_INVALID')
    expect(first.body).not.toContain(BAD)
    expect(await storedSecret()).toBeUndefined()
    expect((await getSettings()).key.status).toBe('missing')

    await putKey(GOOD)
    const old = await storedSecret()
    const res = await putKey(BAD)
    expect(res.statusCode).toBe(400)
    expect(errorCode(res)).toBe('OPENAI_KEY_INVALID')
    expect(await storedSecret()).toEqual(old)
    expect((await getSettings()).key).toMatchObject({ status: 'valid', last4: '1111' })
  })

  it('OpenAI 403 (quyền / khu vực) → 400 OPENAI_KEY_RESTRICTED, không lưu, không phát sự kiện', async () => {
    const res = await putKey(RESTRICTED)
    expect(res.statusCode).toBe(400)
    expect(errorCode(res)).toBe('OPENAI_KEY_RESTRICTED')
    expect(await storedSecret()).toBeUndefined()
    await sleep(300)
    expect(settingsEvents()).toEqual([])
  })

  it('429 insufficient_quota → 502 AI_PROVIDER_ERROR, details.kind = PROVIDER_QUOTA, không lưu', async () => {
    const res = await putKey(QUOTA)
    expect(res.statusCode).toBe(502)
    expect(ErrorResponse.parse(res.json()).error).toMatchObject({ code: 'AI_PROVIDER_ERROR' })
    expect(res.body).not.toContain(QUOTA)
    expect(await storedSecret()).toBeUndefined()
  })

  it('khoá sai dạng / OpenAI từ chối / OpenAI lỗi → KHÔNG phát settings.updated', async () => {
    for (const key of ['khong-phai-khoa', BAD, DOWN, QUOTA]) await putKey(key)
    await sleep(300)
    expect(settingsEvents()).toEqual([])
  })

  it.each([
    ['lỗi mạng / timeout', DOWN],
    ['429', LIMITED],
    ['5xx', BROKEN],
  ])('OpenAI không trả lời được (%s) → 502 AI_PROVIDER_ERROR, không thay khoá cũ', async (_label, key) => {
    await putKey(GOOD)
    const old = await storedSecret()
    const res = await putKey(key)
    expect(res.statusCode).toBe(502)
    expect(errorCode(res)).toBe('AI_PROVIDER_ERROR')
    expect(res.body).not.toContain(key)
    expect(await storedSecret()).toEqual(old)
    expect(await getOpenAiKey({ db: handle.db, cipher })).toBe(GOOD)
  })

  it.each([
    ['rỗng', ''],
    ['chỉ khoảng trắng', '   '],
    ['không bắt đầu bằng sk-', 'pk-abcdef123456'],
    ['chỉ có sk-', 'sk-'],
    ['có khoảng trắng giữa', 'sk-abc def'],
    ['dài hơn 512', `sk-${'a'.repeat(510)}`],
    ['không phải chuỗi', 12345],
  ])('khoá sai dạng (%s) → 400 VALIDATION_FAILED, không gọi OpenAI', async (_label, apiKey) => {
    const res = await putKey(apiKey)
    expect(res.statusCode).toBe(400)
    expect(errorCode(res)).toBe('VALIDATION_FAILED')
    if (typeof apiKey === 'string' && apiKey.length > 3) expect(res.body).not.toContain(apiKey)
    expect(fake.calls).toBe(0)
    expect(await storedSecret()).toBeUndefined()
  })

  it('body thiếu apiKey / có khoá lạ → 400, không gọi OpenAI', async () => {
    expect((await call('PUT', '/api/v1/settings/openai/key', {})).statusCode).toBe(400)
    expect((await call('PUT', '/api/v1/settings/openai/key', { apiKey: GOOD, extra: 1 })).statusCode).toBe(400)
    expect(fake.calls).toBe(0)
  })

  it('đúng 512 ký tự → được nhận', async () => {
    const long = `sk-${'b'.repeat(509)}`
    fake.set(long, { ok: true })
    expect((await putKey(long)).statusCode).toBe(200)
  })

  it('api chưa có khoá chủ (cipher null) → 500 ENCRYPTION_NOT_CONFIGURED, không gọi OpenAI, không lưu', async () => {
    await app.close()
    app = build({ cipher: null })
    const res = await putKey(GOOD)
    expect(res.statusCode).toBe(500)
    expect(errorCode(res)).toBe('ENCRYPTION_NOT_CONFIGURED')
    expect(fake.calls).toBe(0)
    expect(await storedSecret()).toBeUndefined()
  })
})

describe('giải mã (ai.getOpenAiKey)', () => {
  it('keyId của envelope không còn trong APP_ENCRYPTION_KEYS → AppError nêu keyId; GET báo cần nhập lại; DB không đổi', async () => {
    await putKey(GOOD)
    const before = await storedSecret()
    const onlyK2 = createSecretCipher({ keys: new Map([['k2', randomBytes(32)]]), activeKeyId: 'k2' })
    const attempt = getOpenAiKey({ db: handle.db, cipher: onlyK2 })
    await expect(attempt).rejects.toBeInstanceOf(AppError)
    await expect(getOpenAiKey({ db: handle.db, cipher: onlyK2 })).rejects.toMatchObject({
      code: 'OPENAI_KEY_INVALID',
      message: expect.stringContaining('"k1"'),
      details: { reason: 'reentry_required' },
    })
    expect(await getOpenAiKeyStatus({ db: handle.db, cipher: onlyK2 })).toMatchObject({
      configured: true,
      status: 'invalid',
      reason: 'reentry_required',
      last4: '1111',
    })
    // GET qua api dựng với keyring mới
    await app.close()
    app = build({ cipher: onlyK2 })
    expect((await getSettings()).key).toMatchObject({ status: 'invalid', reason: 'reentry_required' })
    expect(await storedSecret()).toEqual(before)
    // keyring cũ vẫn giải mã được
    expect(await getOpenAiKeyStatus({ db: handle.db, cipher })).toMatchObject({ status: 'valid', reason: null })
  })

  it('envelope hỏng / khoá dev sinh lại cùng keyId → AppError (không phải lỗi thô); GET báo cần nhập lại', async () => {
    await putKey(GOOD)
    const regenerated = createSecretCipher({ keys: new Map([['k1', randomBytes(32)]]), activeKeyId: 'k1' })
    await expect(getOpenAiKey({ db: handle.db, cipher: regenerated })).rejects.toMatchObject({ code: 'OPENAI_KEY_INVALID' })
    expect(await getOpenAiKeyStatus({ db: handle.db, cipher: regenerated })).toMatchObject({ status: 'invalid', reason: 'reentry_required' })
    await handle.sql`update secrets set value = 'hong-hoan-toan' where name = 'openai_api_key'`
    await expect(getOpenAiKey({ db: handle.db, cipher })).rejects.toMatchObject({ code: 'OPENAI_KEY_INVALID', details: { reason: 'reentry_required' } })
    expect((await getSettings()).key).toMatchObject({ status: 'invalid', reason: 'reentry_required' })
  })

  it('cipher null → ENCRYPTION_NOT_CONFIGURED', async () => {
    await putKey(GOOD)
    await expect(getOpenAiKey({ db: handle.db, cipher: null })).rejects.toMatchObject({ code: 'ENCRYPTION_NOT_CONFIGURED' })
  })

  it('xoay khoá: k1 cũ vẫn giải mã được khi active là k2', async () => {
    await putKey(GOOD)
    const rotated = createSecretCipher({ keys: new Map([['k1', k1], ['k2', randomBytes(32)]]), activeKeyId: 'k2' })
    expect(await getOpenAiKey({ db: handle.db, cipher: rotated })).toBe(GOOD)
    expect(await getOpenAiKeyStatus({ db: handle.db, cipher: rotated })).toMatchObject({ status: 'valid' })
  })

  it('chưa có khoá → OPENAI_KEY_MISSING; khoá đã bị đánh dấu invalid → OPENAI_KEY_INVALID', async () => {
    await expect(getOpenAiKey({ db: handle.db, cipher })).rejects.toMatchObject({ code: 'OPENAI_KEY_MISSING' })
    await putKey(GOOD)
    await handle.sql`update secrets set status = 'invalid' where name = 'openai_api_key'`
    await expect(getOpenAiKey({ db: handle.db, cipher })).rejects.toMatchObject({ code: 'OPENAI_KEY_INVALID' })
    expect((await getSettings()).key.status).toBe('invalid')
  })
})

describe('DELETE /api/v1/settings/openai/key (gỡ khoá)', () => {
  it('xoá khoá → status missing, phát settings.updated; gỡ khi chưa có → vẫn 200', async () => {
    await putKey(GOOD)
    realtime.messages.length = 0
    const res = await call('DELETE', '/api/v1/settings/openai/key')
    expect(res.statusCode).toBe(200)
    expect(OpenAiKeyInfo.parse(res.json())).toEqual({ configured: false, last4: null, status: 'missing', checkedAt: null, reason: null })
    expect(await storedSecret()).toBeUndefined()
    expect((await getSettings()).key.status).toBe('missing')
    const msg = await waitFor(() => settingsEvents()[0])
    expect(msg).toEqual({ type: 'settings.updated', entity: 'settings', id: 'openai_api_key' })
    await expect(getOpenAiKey({ db: handle.db, cipher })).rejects.toMatchObject({ code: 'OPENAI_KEY_MISSING' })

    realtime.messages.length = 0
    expect((await call('DELETE', '/api/v1/settings/openai/key')).statusCode).toBe(200)
    await sleep(300)
    expect(settingsEvents()).toEqual([])
  })
})

describe('POST /api/v1/settings/openai/key/recheck (kiểm lại)', () => {
  const recheck = () => call('POST', '/api/v1/settings/openai/key/recheck', {})

  it('chưa có khoá → 400 OPENAI_KEY_MISSING, không gọi OpenAI', async () => {
    const res = await recheck()
    expect(res.statusCode).toBe(400)
    expect(errorCode(res)).toBe('OPENAI_KEY_MISSING')
    expect(fake.calls).toBe(0)
  })

  it('OpenAI vẫn nhận → valid, checkedAt mới, phát settings.updated; OpenAI trả 401 → invalid', async () => {
    await putKey(GOOD)
    const firstCheck = (await storedSecret())!.checked_at!
    realtime.messages.length = 0
    await sleep(20)
    const ok = await recheck()
    expect(ok.statusCode).toBe(200)
    const info = OpenAiKeyInfo.parse(ok.json())
    expect(info).toMatchObject({ status: 'valid', last4: '1111', reason: null })
    expect(Date.parse(info.checkedAt!)).toBeGreaterThan(new Date(firstCheck).getTime())
    expect(fake.calls).toBe(2)
    await waitFor(() => settingsEvents()[0])

    fake.set(GOOD, { ok: false, kind: 'KEY_INVALID', status: 401 })
    const bad = await recheck()
    expect(bad.statusCode).toBe(200)
    expect(OpenAiKeyInfo.parse(bad.json())).toMatchObject({ status: 'invalid', configured: true, reason: null })
    expect((await storedSecret())!.status).toBe('invalid')
    expect((await getSettings()).key.status).toBe('invalid')

    fake.set(GOOD, { ok: true })
    expect(OpenAiKeyInfo.parse((await recheck()).json()).status).toBe('valid')
  })

  it('403 / lỗi phía OpenAI → lỗi tương ứng, trạng thái không đổi', async () => {
    await putKey(GOOD)
    const before = await storedSecret()
    fake.set(GOOD, { ok: false, kind: 'KEY_RESTRICTED', status: 403 })
    const restricted = await recheck()
    expect(restricted.statusCode).toBe(400)
    expect(errorCode(restricted)).toBe('OPENAI_KEY_RESTRICTED')
    fake.set(GOOD, { ok: false, kind: 'TRANSIENT' })
    const down = await recheck()
    expect(down.statusCode).toBe(502)
    expect(errorCode(down)).toBe('AI_PROVIDER_ERROR')
    expect(await storedSecret()).toEqual(before)
  })

  it('khoá không giải mã được → trả reentry_required, không gọi OpenAI', async () => {
    await putKey(GOOD)
    await app.close()
    app = build({ cipher: createSecretCipher({ keys: new Map([['k2', randomBytes(32)]]), activeKeyId: 'k2' }) })
    const res = await recheck()
    expect(res.statusCode).toBe(200)
    expect(OpenAiKeyInfo.parse(res.json())).toMatchObject({ status: 'invalid', reason: 'reentry_required' })
    expect(fake.calls).toBe(1) // chỉ lần lưu
  })
})

describe('PUT /api/v1/settings/openai', () => {
  it('lưu lựa chọn, trả về như GET, phát settings.updated', async () => {
    const res = await call('PUT', '/api/v1/settings/openai', VALID_PREFS)
    expect(res.statusCode).toBe(200)
    expect(OpenAiSettingsResponse.parse(res.json())).toMatchObject(VALID_PREFS)
    expect(await getSettings()).toMatchObject({ ...VALID_PREFS, key: { status: 'missing' } })
    const msg = await waitFor(() => realtime.messages.find((m) => m.type === 'settings.updated'))
    expect(msg).toEqual({ type: 'settings.updated', entity: 'settings', id: 'openai' })
  })

  it.each([
    ['model chữ không có', { textModel: 'gpt-khong-co' }],
    ['model ảnh dùng làm model chữ', { textModel: 'gpt-image-2' }],
    ['model chữ dùng làm model ảnh', { imageModel: 'gpt-6-luna' }],
    ['model đã tắt', { textModel: 'testonly-inactive' }],
    ['kích thước ảnh lạ', { imageSize: '999x999' }],
    ['tỉ giá 0', { exchangeRateVnd: 0 }],
    ['tỉ giá âm', { exchangeRateVnd: -1 }],
    ['tỉ giá lẻ', { exchangeRateVnd: 25_000.5 }],
    ['hạn mức 0', { monthlyLimitVnd: 0 }],
    ['hạn mức là chuỗi', { monthlyLimitVnd: '1000000' }],
    ['tỉ giá vượt tối đa', { exchangeRateVnd: 1_000_001 }],
    ['warn80 không phải bool', { warn80: 'có' }],
    ['khoá lạ', { warn90: true }],
  ])('%s → 400 VALIDATION_FAILED, không lưu', async (_label, patch) => {
    const res = await call('PUT', '/api/v1/settings/openai', { ...VALID_PREFS, ...patch })
    expect(res.statusCode).toBe(400)
    expect(errorCode(res)).toBe('VALIDATION_FAILED')
    expect((await handle.sql`select 1 from settings where key = 'openai'`).length).toBe(0)
  })

  it('chỉ gửi một phần → các khoá khác giữ giá trị đang lưu; model không gửi thì không bị kiểm', async () => {
    await call('PUT', '/api/v1/settings/openai', VALID_PREFS)
    const res = await call('PUT', '/api/v1/settings/openai', { monthlyLimitVnd: 3_000_000 })
    expect(res.statusCode).toBe(200)
    expect(OpenAiSettingsResponse.parse(res.json())).toMatchObject({ ...VALID_PREFS, monthlyLimitVnd: 3_000_000 })
    // chưa từng chọn model: gửi mỗi warn80 vẫn lưu được, model vẫn là mặc định
    await handle.sql`delete from settings where key = 'openai'`
    const only = OpenAiSettingsResponse.parse((await call('PUT', '/api/v1/settings/openai', { warn80: false })).json())
    expect(only).toMatchObject({ warn80: false, textModel: only.models.text[0]!.model })
  })

  it('PUT không hợp lệ → KHÔNG phát settings.updated', async () => {
    await call('PUT', '/api/v1/settings/openai', { textModel: 'gpt-khong-co' })
    await sleep(300)
    expect(settingsEvents()).toEqual([])
  })

  it('model đã lưu bị tắt sau đó → GET trả model mặc định', async () => {
    await call('PUT', '/api/v1/settings/openai', VALID_PREFS)
    await handle.sql`update ai_model_prices set active = false where model = 'gpt-6.1-sol'`
    try {
      expect((await getSettings()).textModel).toBe('gpt-6-luna')
    } finally {
      await handle.sql`update ai_model_prices set active = true where model = 'gpt-6.1-sol'`
    }
  })
})

describe('log (AD-12)', () => {
  it('mọi log của file này không chứa khoá nào; lỗi OpenAI có log warn', () => {
    const text = logLines.join('')
    expect(text.length).toBeGreaterThan(0)
    for (const key of ALL_KEYS) expect(text).not.toContain(key)
    expect(text).not.toContain('test-key')
    expect(text).toContain('kiểm khoá OpenAI')
  })
})
