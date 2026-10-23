// Ma trận Story 5.1 — cấu hình AI trả lời theo nhóm/trang. Qua app thật (buildApp) + Postgres nhúng; đổi nhóm gọi
// thẳng consumer `handleProfilesEvent` (như profiles-events.test). Phủ: lưu nhóm → tổng quan "Bật"/"Theo nhóm";
// luật bật (kịch bản / kênh / khung giờ); template kịch bản từ hồ sơ + theo ngành; dùng riêng (sao chép) / bỏ riêng;
// bật/tắt hàng loạt (chuyển riêng, giữ nguyên, CONFIG_MISSING, VALIDATION_FAILED); rời/xoá/vào nhóm cho kind autoreply.
import {
  AutoreplyConfigDto,
  AutoreplyConfigResponse,
  AutoreplyOverviewResponse,
  AutoreplyScriptTemplateResponse,
  BulkSetAutoreplyResponse,
  EffectiveAutoreplyConfigResponse,
  ErrorResponse,
  defaultAutoreplyHours,
  type EventName,
  type EventPayload,
} from '@ottm/shared'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest'
import { buildApp } from '../src/app/app.ts'
import { SESSION_COOKIE } from '../src/app/auth/index.ts'
import { getPageConfigState, handleProfilesEvent, resolveEffective } from '../src/modules/profiles/index.ts'
import { createSession } from '../src/modules/settings/index.ts'
import { createDb, newId, type DbHandle } from '../src/platform/db/index.ts'
import { createLogger } from '../src/platform/log/index.ts'

const ORIGIN = 'http://localhost:5173'

let handle: DbHandle
let app: FastifyInstance
let token: string

beforeAll(async () => {
  handle = createDb(inject('databaseUrl'), { max: 3 })
  app = buildApp({ sql: handle.sql, db: handle.db, logger: createLogger({ level: 'silent' }), http: { allowedOrigins: [ORIGIN] } })
})
afterAll(async () => {
  await cleanup()
  await app.close()
  await handle.close()
})
async function cleanup() {
  await handle.sql`delete from page_config_state`
  await handle.sql`delete from autoreply_configs`
  await handle.sql`delete from brand_profiles`
  await handle.sql`update pages set group_id = null`
  await handle.sql`delete from pages`
  await handle.sql`delete from groups`
}
beforeEach(async () => {
  await cleanup()
  token = (await createSession(handle.db)).token
})

async function api(method: 'GET' | 'PUT' | 'POST', url: string, payload?: unknown) {
  return app.inject({
    method,
    url,
    headers: { cookie: `${SESSION_COOKIE}=${token}`, ...(method === 'GET' ? {} : { origin: ORIGIN }) },
    ...(payload !== undefined ? { payload: payload as object } : {}),
  })
}

async function seedGroup(name = 'Nhóm Gia dụng'): Promise<string> {
  const [row] = await handle.sql<{ id: string }[]>`insert into groups (name, color) values (${name}, 'group-2') returning id`
  return row!.id
}
async function seedPage(groupId: string | null = null, name = 'Gia dụng Minh Phát'): Promise<string> {
  const [row] = await handle.sql<{ id: string }[]>`
    insert into pages (platform, platform_account_id, name, group_id) values ('facebook', ${newId()}, ${name}, ${groupId}) returning id`
  return row!.id
}
const setGroup = (pageId: string, groupId: string | null) => handle.sql`update pages set group_id = ${groupId} where id = ${pageId}`

const CONFIG = {
  enabled: true,
  schedule: 'offhours',
  hours: defaultAutoreplyHours(),
  script: 'Bạn là nhân viên bán hàng của Gia dụng Minh Phát.',
  handoffKeywords: ['đổi trả', 'bảo hành', 'Đổi trả'],
  handoffOnCustomerAsk: true,
  handoffOnUncertain: true,
  handoffMessage: 'Shop sẽ kiểm tra và phản hồi ngay ạ',
  channels: ['messenger', 'ig_direct', 'comment_public', 'comment_private'],
}

async function saveConfig(ownerType: 'group' | 'page', ownerId: string, patch: Record<string, unknown> = {}) {
  const res = await api('PUT', `/api/v1/autoreply-configs/${ownerType}/${ownerId}`, { ...CONFIG, ...patch })
  expect(res.statusCode, res.body).toBe(200)
  return AutoreplyConfigDto.parse(res.json())
}
const overview = async () => AutoreplyOverviewResponse.parse((await api('GET', '/api/v1/autoreply-configs/overview')).json())
const effectiveOf = async (pageId: string) => EffectiveAutoreplyConfigResponse.parse((await api('GET', `/api/v1/autoreply-configs/effective/page/${pageId}`)).json())
const ownRow = async (pageId: string) => handle.sql`select * from autoreply_configs where owner_type = 'page' and owner_id = ${pageId}`
const bulk = async (pageIds: string[], enabled: boolean) => {
  const res = await api('POST', '/api/v1/autoreply-configs/bulk-enabled', { pageIds, enabled })
  expect(res.statusCode, res.body).toBe(200)
  return BulkSetAutoreplyResponse.parse(res.json())
}

describe('lưu cấu hình nhóm', () => {
  it('nhóm bật → tổng quan: nhóm Bật, trang con Theo nhóm và đang bật (Page.autoReply dẫn xuất)', async () => {
    const g = await seedGroup()
    const p1 = await seedPage(g, 'Minh Phát')
    const p2 = await seedPage(g, 'minhphat.home')
    const saved = await saveConfig('group', g)
    // Từ khoá bỏ trùng không phân biệt hoa thường; mặc định/kênh giữ đúng.
    expect(saved.handoffKeywords).toEqual(['đổi trả', 'bảo hành'])
    expect(saved.schedule).toBe('offhours')

    const o = await overview()
    expect(o.groups).toEqual([{ groupId: g, configured: true, enabled: true }])
    expect(o.pages.find((x) => x.pageId === p1)).toEqual({ pageId: p1, groupId: g, mode: 'group', configured: true, enabled: true })
    expect(o.pages.find((x) => x.pageId === p2)?.mode).toBe('group')

    const eff = await effectiveOf(p1)
    expect(eff.useOwn).toBe(false)
    expect(eff.effective!.source).toMatchObject({ ownerType: 'group', ownerId: g, name: 'Nhóm Gia dụng' })
    const resolved = await resolveEffective<AutoreplyConfigDto>(handle.db, p1, 'autoreply')
    expect(resolved.config.enabled).toBe(true)
  })

  it('GET cấu hình riêng: chưa có → null; lưu rồi đọc lại đúng', async () => {
    const g = await seedGroup()
    expect(AutoreplyConfigResponse.parse((await api('GET', `/api/v1/autoreply-configs/group/${g}`)).json()).config).toBeNull()
    await saveConfig('group', g)
    const res = AutoreplyConfigResponse.parse((await api('GET', `/api/v1/autoreply-configs/group/${g}`)).json())
    expect(res.config!.script).toBe(CONFIG.script)
    expect(res.config!.hours).toHaveLength(7)
  })

  it.each([
    ['kịch bản trống', { script: '   ' }, 'script'],
    ['không có kênh', { channels: [] }, 'channels'],
    ['theo khung giờ mà không ngày nào bật', { schedule: 'custom', hours: defaultAutoreplyHours().map((h) => ({ ...h, on: false })) }, 'hours'],
  ])('bật khi %s → 400 VALIDATION_FAILED trỏ đúng ô, không lưu', async (_label, patch, path) => {
    const g = await seedGroup()
    const res = await api('PUT', `/api/v1/autoreply-configs/group/${g}`, { ...CONFIG, ...patch })
    expect(res.statusCode).toBe(400)
    const body = ErrorResponse.parse(res.json())
    expect(body.error.code).toBe('VALIDATION_FAILED')
    expect(body.error.details as { path: string[] }[]).toEqual(expect.arrayContaining([expect.objectContaining({ path: [path] })]))
    expect(await handle.sql`select 1 from autoreply_configs`).toHaveLength(0)
  })

  it('lưu nháp đang tắt với kịch bản trống và không kênh → được', async () => {
    const g = await seedGroup()
    const saved = await saveConfig('group', g, { enabled: false, script: '', channels: [] })
    expect(saved.enabled).toBe(false)
  })

  it('giờ trùng nhau khi bật một ngày → 400 (from ≠ to)', async () => {
    const g = await seedGroup()
    const hours = defaultAutoreplyHours()
    hours[0] = { on: true, from: '09:00', to: '09:00' }
    expect((await api('PUT', `/api/v1/autoreply-configs/group/${g}`, { ...CONFIG, hours })).statusCode).toBe(400)
  })

  it('chủ không tồn tại → 404', async () => {
    expect((await api('PUT', `/api/v1/autoreply-configs/group/${newId()}`, CONFIG)).statusCode).toBe(404)
    expect((await api('GET', `/api/v1/autoreply-configs/effective/page/${newId()}`)).statusCode).toBe(404)
  })
})

describe('kịch bản dựng từ template (không gọi AI)', () => {
  const BRAND = {
    name: 'Gia dụng Minh Phát',
    slogan: 'Bếp gọn nhà xinh',
    industry: 'Gia dụng',
    tones: ['Thân thiện'],
    formality: 50,
    pronoun: 'Shop – anh/chị',
    emoji: 'none',
    products: [{ name: 'Nồi chiên 5L', price: '1.290.000đ' }],
    audience: 'Gia đình trẻ',
    colors: [],
    hashtags: [],
    bannedWords: ['rẻ nhất'],
    allowedDomains: [],
  }

  it('nhóm có hồ sơ → kịch bản chứa tên, xưng hô, sản phẩm + giá, từ cấm; trang theo nhóm dùng hồ sơ nhóm', async () => {
    const g = await seedGroup()
    const p = await seedPage(g)
    expect((await api('PUT', `/api/v1/brand-profiles/group/${g}`, BRAND)).statusCode).toBe(200)

    const res = await api('POST', '/api/v1/autoreply-configs/script-template', { source: 'brand', ownerType: 'group', ownerId: g })
    expect(res.statusCode).toBe(200)
    const body = AutoreplyScriptTemplateResponse.parse(res.json())
    for (const part of ['Gia dụng Minh Phát', 'Shop – anh/chị', 'Nồi chiên 5L: 1.290.000đ', '"rẻ nhất"', 'không dùng emoji']) expect(body.script).toContain(part)
    expect(body.brandSource).toMatchObject({ ownerType: 'group', ownerId: g })

    const byPage = AutoreplyScriptTemplateResponse.parse(
      (await api('POST', '/api/v1/autoreply-configs/script-template', { source: 'brand', ownerType: 'page', ownerId: p })).json(),
    )
    expect(byPage.script).toBe(body.script) // xác định: cùng hồ sơ → cùng kịch bản
    expect(byPage.brandSource).toMatchObject({ ownerType: 'group', ownerId: g })
  })

  it('không có hồ sơ hiệu lực → 422 CONFIG_MISSING', async () => {
    const p = await seedPage(null)
    const res = await api('POST', '/api/v1/autoreply-configs/script-template', { source: 'brand', ownerType: 'page', ownerId: p })
    expect(res.statusCode).toBe(422)
    expect(ErrorResponse.parse(res.json()).error.code).toBe('CONFIG_MISSING')
  })

  it('mẫu theo ngành → kịch bản cố định; ngành lạ → 400', async () => {
    const a = AutoreplyScriptTemplateResponse.parse((await api('POST', '/api/v1/autoreply-configs/script-template', { source: 'industry', industry: 'home' })).json())
    const b = AutoreplyScriptTemplateResponse.parse((await api('POST', '/api/v1/autoreply-configs/script-template', { source: 'industry', industry: 'home' })).json())
    expect(a.script).toBe(b.script)
    expect(a.script).toContain('đồ gia dụng')
    expect(a.brandSource).toBeNull()
    expect((await api('POST', '/api/v1/autoreply-configs/script-template', { source: 'industry', industry: 'xe-may' })).statusCode).toBe(400)
  })
})

describe('Dùng cấu hình AI riêng', () => {
  it('trang theo nhóm: lưu cấu hình trang (tắt kênh bình luận) → use_own=true, hiệu lực của trang, nhóm giữ nguyên', async () => {
    const g = await seedGroup()
    const p = await seedPage(g, 'minhphat.store')
    await saveConfig('group', g)
    await saveConfig('page', p, { channels: ['messenger', 'ig_direct'] })

    expect(await getPageConfigState(handle.db, p, 'autoreply')).toEqual({ useOwn: true, awaitingGroupDefault: false })
    const eff = await effectiveOf(p)
    expect(eff.useOwn).toBe(true)
    expect(eff.effective!.source).toMatchObject({ ownerType: 'page', ownerId: p })
    expect(eff.effective!.config.channels).toEqual(['messenger', 'ig_direct'])
    const group = AutoreplyConfigResponse.parse((await api('GET', `/api/v1/autoreply-configs/group/${g}`)).json())
    expect(group.config!.channels).toEqual(CONFIG.channels)
    expect((await overview()).pages.find((x) => x.pageId === p)?.mode).toBe('own')
  })

  it('bật dùng riêng chưa sửa → sao chép cấu hình nhóm làm điểm xuất phát', async () => {
    const g = await seedGroup()
    const p = await seedPage(g)
    await saveConfig('group', g, { script: 'Kịch bản nhóm' })
    const res = EffectiveAutoreplyConfigResponse.parse((await api('PUT', `/api/v1/autoreply-configs/use-own/page/${p}`, { useOwn: true })).json())
    expect(res.useOwn).toBe(true)
    expect(res.effective!.source.ownerType).toBe('page')
    expect(res.effective!.config.script).toBe('Kịch bản nhóm')
  })

  it('bật dùng riêng khi nhóm chưa có cấu hình → riêng trống, hiệu lực null', async () => {
    const g = await seedGroup()
    const p = await seedPage(g)
    const res = EffectiveAutoreplyConfigResponse.parse((await api('PUT', `/api/v1/autoreply-configs/use-own/page/${p}`, { useOwn: true })).json())
    expect(res).toEqual({ effective: null, useOwn: true })
  })

  it('tắt dùng riêng → xoá cấu hình riêng, về nhóm; trang không nhóm → 400', async () => {
    const g = await seedGroup()
    const p = await seedPage(g)
    await saveConfig('group', g)
    await saveConfig('page', p, { enabled: false })
    const res = EffectiveAutoreplyConfigResponse.parse((await api('PUT', `/api/v1/autoreply-configs/use-own/page/${p}`, { useOwn: false })).json())
    expect(res.useOwn).toBe(false)
    expect(res.effective!.source).toMatchObject({ ownerType: 'group', ownerId: g })
    expect(await ownRow(p)).toHaveLength(0)

    const lone = await seedPage(null, 'Shop lẻ')
    expect((await api('PUT', `/api/v1/autoreply-configs/use-own/page/${lone}`, { useOwn: false })).statusCode).toBe(400)
  })

  it('hiệu lực null khi trang không nhóm & không cấu hình (useOwn=true) hoặc nhóm chưa cấu hình (useOwn=false)', async () => {
    const lone = await seedPage(null, 'Shop lẻ')
    expect(await effectiveOf(lone)).toEqual({ effective: null, useOwn: true })
    const g = await seedGroup()
    const p = await seedPage(g)
    expect(await effectiveOf(p)).toEqual({ effective: null, useOwn: false })
    const o = await overview()
    expect(o.pages.find((x) => x.pageId === lone)).toMatchObject({ mode: 'own', configured: false, enabled: false })
    expect(o.pages.find((x) => x.pageId === p)).toMatchObject({ mode: 'group', configured: false, enabled: false })
    expect(o.groups).toEqual([{ groupId: g, configured: false, enabled: false }])
  })
})

describe('Bật/Tắt AI hàng loạt', () => {
  it('tắt 2 trang đang theo nhóm bật → mỗi trang thành riêng, bản sao nhóm với enabled=false; nhóm vẫn bật', async () => {
    const g = await seedGroup()
    const p1 = await seedPage(g, 'A')
    const p2 = await seedPage(g, 'B')
    await saveConfig('group', g, { script: 'Kịch bản nhóm' })

    const res = await bulk([p1, p2], false)
    expect(res.updated.sort()).toEqual([p1, p2].sort())
    expect(res.failed).toEqual([])
    for (const p of [p1, p2]) {
      const eff = await effectiveOf(p)
      expect(eff.useOwn).toBe(true)
      expect(eff.effective!.config).toMatchObject({ enabled: false, script: 'Kịch bản nhóm', channels: CONFIG.channels })
    }
    expect((await overview()).groups[0]!.enabled).toBe(true)
  })

  it('trang theo nhóm đã đúng trạng thái → unchanged, vẫn Theo nhóm', async () => {
    const g = await seedGroup()
    const p = await seedPage(g)
    await saveConfig('group', g)
    const res = await bulk([p], true)
    expect(res).toEqual({ updated: [], unchanged: [p], failed: [] })
    expect(await getPageConfigState(handle.db, p, 'autoreply')).toEqual({ useOwn: false, awaitingGroupDefault: false })
    expect(await ownRow(p)).toHaveLength(0)
  })

  it('bật trang không có cấu hình → CONFIG_MISSING cho trang đó, trang khác vẫn xử lý; tắt trang không cấu hình → unchanged', async () => {
    const g = await seedGroup()
    const ok = await seedPage(g, 'Có cấu hình')
    await saveConfig('group', g, { enabled: false })
    const lone = await seedPage(null, 'Shop lẻ')
    const res = await bulk([lone, ok], true)
    expect(res.failed).toEqual([{ pageId: lone, code: 'CONFIG_MISSING' }])
    expect(res.updated).toEqual([ok])
    expect((await effectiveOf(ok)).effective!.config.enabled).toBe(true)
    expect(await bulk([lone], false)).toEqual({ updated: [], unchanged: [lone], failed: [] })
  })

  it('bật khi cấu hình không đủ điều kiện (kịch bản trống) → VALIDATION_FAILED, trang không bị chuyển sang riêng', async () => {
    const g = await seedGroup()
    const p = await seedPage(g)
    await saveConfig('group', g, { enabled: false, script: '' })
    const res = await bulk([p], true)
    expect(res.failed).toEqual([{ pageId: p, code: 'VALIDATION_FAILED' }])
    expect(await getPageConfigState(handle.db, p, 'autoreply')).toEqual({ useOwn: false, awaitingGroupDefault: false })
    expect(await ownRow(p)).toHaveLength(0)
  })

  it('trang id lạ → NOT_FOUND trong failed', async () => {
    const id = newId()
    expect((await bulk([id], true)).failed).toEqual([{ pageId: id, code: 'NOT_FOUND' }])
  })
})

describe('đổi nhóm giữ cấu hình AI (dùng chung xử lý Story 3.3)', () => {
  const groupChanged = (pageId: string, fromGroupId: string | null, toGroupId: string | null): { event: EventName; payload: EventPayload<'page.group_changed'> } => ({
    event: 'page.group_changed',
    payload: { id: pageId, pageId, fromGroupId, toGroupId },
  })
  const groupDeleted = (groupId: string, memberPageIds: string[]): { event: EventName; payload: EventPayload<'group.deleted'> } => ({
    event: 'group.deleted',
    payload: { id: groupId, groupId, memberPageIds },
  })

  it('rời nhóm → sao chép cấu hình AI của nhóm thành riêng; chạy hai lần vẫn đúng', async () => {
    const a = await seedGroup()
    const p = await seedPage(a)
    await saveConfig('group', a, { script: 'Kịch bản A' })
    await setGroup(p, null)
    for (let i = 0; i < 2; i++) expect(await handleProfilesEvent({ db: handle.db }, groupChanged(p, a, null))).toBe('applied')
    const eff = await effectiveOf(p)
    expect(eff.effective!.source.ownerType).toBe('page')
    expect(eff.effective!.config.script).toBe('Kịch bản A')
    expect(await ownRow(p)).toHaveLength(1)
  })

  it('xoá nhóm → trang thành viên giữ bản sao, cấu hình nhóm bị xoá', async () => {
    const a = await seedGroup()
    const p = await seedPage(a)
    await saveConfig('group', a)
    await setGroup(p, null)
    await handle.sql`delete from groups where id = ${a}`
    await handleProfilesEvent({ db: handle.db }, groupDeleted(a, [p]))
    expect(await ownRow(p)).toHaveLength(1)
    expect(await handle.sql`select 1 from autoreply_configs where owner_type = 'group' and owner_id = ${a}`).toHaveLength(0)
  })

  it('vào nhóm chưa có cấu hình AI → giữ riêng + awaiting; nhóm lưu lần đầu → trang về Theo nhóm', async () => {
    const b = await seedGroup('Nhóm B')
    const p = await seedPage(null)
    await saveConfig('page', p, { script: 'Kịch bản riêng' })
    await setGroup(p, b)
    await handleProfilesEvent({ db: handle.db }, groupChanged(p, null, b))
    expect(await getPageConfigState(handle.db, p, 'autoreply')).toEqual({ useOwn: true, awaitingGroupDefault: true })
    expect((await effectiveOf(p)).effective!.config.script).toBe('Kịch bản riêng')

    await saveConfig('group', b, { script: 'Kịch bản nhóm B' })
    expect(await getPageConfigState(handle.db, p, 'autoreply')).toEqual({ useOwn: false, awaitingGroupDefault: false })
    const eff = await effectiveOf(p)
    expect(eff.effective!.source).toMatchObject({ ownerType: 'group', ownerId: b })
    expect(await ownRow(p)).toHaveLength(0)
  })
})
