// Ma trận Story 5.7 — Màn chào 4 bước: `GET /api/v1/onboarding` qua app thật (buildApp) + Postgres nhúng. Phủ: mới
// tinh; trang chưa gỡ (kể cả mất kết nối) / chỉ trang đã gỡ; khoá valid / invalid / chưa có; hồ sơ theo nhóm / riêng /
// nhóm không hồ sơ / chỉ trang đã gỡ; cấu hình AI bật / tắt; tin AI đã gửi mới nhất, bỏ tin chưa gửi / lỗi / của người /
// trang đã gỡ; 401 khi không có phiên. Khoá lưu qua `setOpenAiKey` (cipher thật, OpenAI giả, sự kiện no-op).
import { randomBytes } from 'node:crypto'
import { OnboardingStatusResponse, defaultAutoreplyHours } from '@ottm/shared'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest'
import { createSecretCipher } from '../src/adapters/crypto/index.ts'
import { createFakeOpenAiAdapter } from '../src/adapters/openai/fake.ts'
import { buildApp } from '../src/app/app.ts'
import { SESSION_COOKIE } from '../src/app/auth/index.ts'
import { setOpenAiKey } from '../src/modules/ai/index.ts'
import { createSession } from '../src/modules/settings/index.ts'
import { createDb, newId, type DbHandle } from '../src/platform/db/index.ts'
import type { EventPublisher } from '../src/platform/events/index.ts'
import { createLogger } from '../src/platform/log/index.ts'

const ORIGIN = 'http://localhost:5173'
const GOOD = 'sk-proj-ONBOARDING-test-aaaa1111'
const cipher = createSecretCipher({ keys: new Map([['k1', randomBytes(32)]]), activeKeyId: 'k1' })
/** Story này không kiểm sự kiện: lưu khoá chỉ cần một publisher không làm gì. */
const events: EventPublisher = { publishEvent: async () => {} }

let handle: DbHandle
let app: FastifyInstance
let token: string

async function cleanup() {
  await handle.sql`delete from contacts`
  await handle.sql`delete from secrets where name = 'openai_api_key'`
  await handle.sql`delete from page_config_state`
  await handle.sql`delete from autoreply_configs`
  await handle.sql`delete from brand_profiles`
  await handle.sql`update pages set group_id = null`
  await handle.sql`delete from pages`
  await handle.sql`delete from groups`
}

beforeAll(async () => {
  handle = createDb(inject('databaseUrl'), { max: 4 })
  app = buildApp({ sql: handle.sql, db: handle.db, logger: createLogger({ level: 'silent' }), http: { allowedOrigins: [ORIGIN] }, ai: { cipher } })
})
afterAll(async () => {
  await cleanup()
  await app.close()
  await handle.close()
})
beforeEach(async () => {
  await cleanup()
  token = (await createSession(handle.db)).token
})

// ---------------------------------------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------------------------------------

async function api(method: 'GET' | 'PUT', url: string, payload?: unknown, auth = true) {
  return app.inject({
    method,
    url,
    headers: { ...(auth ? { cookie: `${SESSION_COOKIE}=${token}` } : {}), ...(method === 'GET' ? {} : { origin: ORIGIN }) },
    ...(payload !== undefined ? { payload: payload as object } : {}),
  })
}

async function status(): Promise<OnboardingStatusResponse> {
  const res = await api('GET', '/api/v1/onboarding')
  expect(res.statusCode, res.body).toBe(200)
  return OnboardingStatusResponse.parse(res.json())
}

async function seedGroup(): Promise<string> {
  const [row] = await handle.sql<{ id: string }[]>`insert into groups (name, color) values ('Nhóm Gia dụng', 'group-2') returning id`
  return row!.id
}
async function seedPage(opts: { groupId?: string; removed?: boolean; status?: string } = {}): Promise<string> {
  const [row] = await handle.sql<{ id: string }[]>`
    insert into pages (platform, platform_account_id, name, group_id, connection_status, removed_at)
    values ('facebook', ${newId()}, 'Gia dụng Minh Phát', ${opts.groupId ?? null}, ${opts.status ?? 'active'},
      case when ${opts.removed ?? false} then now() end)
    returning id`
  return row!.id
}

async function saveBrand(ownerType: 'group' | 'page', ownerId: string) {
  const res = await api('PUT', `/api/v1/brand-profiles/${ownerType}/${ownerId}`, { name: 'Gia dụng Minh Phát' })
  expect(res.statusCode, res.body).toBe(200)
}

async function saveAutoreply(ownerType: 'group' | 'page', ownerId: string, enabled: boolean) {
  const res = await api('PUT', `/api/v1/autoreply-configs/${ownerType}/${ownerId}`, {
    enabled,
    schedule: 'always',
    hours: defaultAutoreplyHours(),
    script: 'Bạn là nhân viên bán hàng của Gia dụng Minh Phát.',
    handoffKeywords: [],
    handoffOnCustomerAsk: true,
    handoffOnUncertain: true,
    handoffMessage: 'Shop sẽ kiểm tra và phản hồi ngay ạ',
    channels: ['messenger'],
  })
  expect(res.statusCode, res.body).toBe(200)
}

async function saveKey() {
  const fake = createFakeOpenAiAdapter({ [GOOD]: { ok: true } })
  await setOpenAiKey({ db: handle.db, events, cipher, openai: fake }, GOOD)
}

let seq = 0

/** Hội thoại DM của một khách mới trên `pageId`. */
async function seedConversation(pageId: string): Promise<string> {
  seq += 1
  const [c] = await handle.sql<{ id: string }[]>`insert into contacts (name) values ('Khách') returning id`
  const [ident] = await handle.sql<{ id: string }[]>`
    insert into contact_identities (contact_id, page_id, platform_user_id) values (${c!.id}, ${pageId}, ${`psid_${seq}`}) returning id`
  const [conv] = await handle.sql<{ id: string }[]>`
    insert into conversations (page_id, channel, thread_key, contact_identity_id, state, last_message_at)
    values (${pageId}, 'dm', ${`psid_${seq}`}, ${ident!.id}, 'ai', now()) returning id`
  return conv!.id
}

async function seedOutbound(conversationId: string, pageId: string, opts: { origin?: string; status?: string; sentAt?: string | null } = {}) {
  const status = opts.status ?? 'sent'
  await handle.sql`
    insert into messages (conversation_id, page_id, direction, origin, status, delivery, error_code, text, sent_at, platform_timestamp)
    values (${conversationId}, ${pageId}, 'outbound', ${opts.origin ?? 'app_ai'}, ${status}, 'dm',
      ${status === 'failed' ? 'SEND_FAILED' : null}, 'Dạ shop chào bạn ạ', ${opts.sentAt === undefined ? new Date().toISOString() : opts.sentAt}, now())`
}

// ---------------------------------------------------------------------------------------------------------
// GET /api/v1/onboarding
// ---------------------------------------------------------------------------------------------------------

describe('GET /api/v1/onboarding', () => {
  it('mới tinh: 4 cờ false, chưa có tin AI', async () => {
    expect(await status()).toEqual({
      steps: { pageConnected: false, openAiKeyValid: false, brandProfile: false, autoreplyEnabled: false },
      lastAiReply: null,
    })
  })

  it('chưa đăng nhập → 401', async () => {
    const res = await api('GET', '/api/v1/onboarding', undefined, false)
    expect(res.statusCode).toBe(401)
  })

  it('trang chưa gỡ (kể cả mất kết nối) tính là có trang; chỉ trang đã gỡ thì không', async () => {
    await seedPage({ removed: true })
    expect((await status()).steps.pageConnected).toBe(false)
    await seedPage({ status: 'disconnected' })
    expect((await status()).steps.pageConnected).toBe(true)
  })

  it('khoá OpenAI: valid → true; bị đánh dấu invalid → false', async () => {
    await saveKey()
    expect((await status()).steps.openAiKeyValid).toBe(true)
    await handle.sql`update secrets set status = 'invalid' where name = 'openai_api_key'`
    expect((await status()).steps.openAiKeyValid).toBe(false)
  })

  it('hồ sơ hiệu lực: nhóm chưa có hồ sơ → false; lưu hồ sơ nhóm → true (trang theo nhóm)', async () => {
    const g = await seedGroup()
    await seedPage({ groupId: g })
    expect((await status()).steps.brandProfile).toBe(false)
    await saveBrand('group', g)
    expect((await status()).steps.brandProfile).toBe(true)
  })

  it('hồ sơ riêng của trang không nhóm → true; chỉ trang đã gỡ có hồ sơ → false', async () => {
    const gone = await seedPage()
    await saveBrand('page', gone)
    await handle.sql`update pages set removed_at = now() where id = ${gone}`
    await seedPage()
    expect((await status()).steps.brandProfile).toBe(false)
    const own = await seedPage()
    await saveBrand('page', own)
    expect((await status()).steps.brandProfile).toBe(true)
  })

  it('cấu hình AI hiệu lực: tắt → false; bật ở nhóm (trang theo nhóm) → true', async () => {
    const g = await seedGroup()
    await seedPage({ groupId: g })
    await saveAutoreply('group', g, false)
    expect((await status()).steps.autoreplyEnabled).toBe(false)
    await saveAutoreply('group', g, true)
    expect((await status()).steps.autoreplyEnabled).toBe(true)
  })

  it('cấu hình AI riêng của trang không nhóm đang bật → true', async () => {
    const p = await seedPage()
    await saveAutoreply('page', p, true)
    expect((await status()).steps.autoreplyEnabled).toBe(true)
  })

  it('tin AI: bỏ tin chưa gửi / lỗi / của người; chọn tin AI đã gửi mới nhất', async () => {
    const p = await seedPage()
    const first = await seedConversation(p)
    await seedOutbound(first, p, { status: 'pending', sentAt: null })
    await seedOutbound(first, p, { status: 'failed', sentAt: null })
    await seedOutbound(first, p, { origin: 'app_human' })
    expect((await status()).lastAiReply).toBeNull()

    await seedOutbound(first, p, { sentAt: '2026-10-24T03:00:00.000Z' })
    const second = await seedConversation(p)
    await seedOutbound(second, p, { status: 'read', sentAt: '2026-10-24T03:05:00.000Z' })
    expect((await status()).lastAiReply).toEqual({ conversationId: second, pageId: p, sentAt: '2026-10-24T03:05:00.000Z' })
  })

  it('tin AI trên trang đã gỡ không tính', async () => {
    const p = await seedPage()
    await seedOutbound(await seedConversation(p), p)
    expect((await status()).lastAiReply).not.toBeNull()
    await handle.sql`update pages set removed_at = now() where id = ${p}`
    expect(await status()).toEqual({
      steps: { pageConnected: false, openAiKeyValid: false, brandProfile: false, autoreplyEnabled: false },
      lastAiReply: null,
    })
  })

  it('đủ 4 bước', async () => {
    await saveKey()
    const g = await seedGroup()
    await seedPage({ groupId: g })
    await saveBrand('group', g)
    await saveAutoreply('group', g, true)
    expect((await status()).steps).toEqual({ pageConnected: true, openAiKeyValid: true, brandProfile: true, autoreplyEnabled: true })
  })
})
