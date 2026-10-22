// Ma trận Story 3.2 — kế thừa hồ sơ + "Dùng hồ sơ riêng". Qua app thật (buildApp) + Postgres nhúng.
// Phủ: resolveEffective mọi nhánh (theo nhóm / dùng riêng / CONFIG_MISSING) qua route effective; setUseOwn bật
// (sao chép hồ sơ nhóm, use_own=true) / tắt (xoá hồ sơ riêng, về nhóm); bật khi nhóm chưa có hồ sơ → CONFIG_MISSING.
import { BrandProfileDto, EffectiveBrandProfileResponse } from '@ottm/shared'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest'
import { buildApp } from '../src/app/app.ts'
import { SESSION_COOKIE } from '../src/app/auth/index.ts'
import { getPageConfigState, resolveEffective } from '../src/modules/profiles/index.ts'
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
  await handle.sql`delete from brand_profiles`
  await handle.sql`update pages set group_id = null`
  await handle.sql`delete from pages`
  await handle.sql`delete from groups`
}
beforeEach(async () => {
  await cleanup()
  token = (await createSession(handle.db)).token
})

const cookie = () => ({ cookie: `${SESSION_COOKIE}=${token}` })
async function api(method: 'GET' | 'PUT', url: string, payload?: unknown) {
  return app.inject({ method, url, headers: { ...cookie(), ...(method === 'GET' ? {} : { origin: ORIGIN }) }, ...(payload !== undefined ? { payload: payload as object } : {}) })
}

async function seedGroup(name = 'Nhóm Mỹ phẩm', color = 'group-1'): Promise<string> {
  const [row] = await handle.sql<{ id: string }[]>`insert into groups (name, color) values (${name}, ${color}) returning id`
  return row!.id
}
async function seedPage(name = 'Shop A', groupId: string | null = null): Promise<string> {
  const [row] = await handle.sql<{ id: string }[]>`
    insert into pages (platform, platform_account_id, name, group_id) values ('facebook', ${newId()}, ${name}, ${groupId}) returning id`
  return row!.id
}

const VALID = { name: 'Shop A', slogan: 'Đẹp mỗi ngày', industry: 'Mỹ phẩm', tones: ['Thân thiện'], formality: 70, pronoun: 'Shop – chị/bạn', emoji: 'some', products: [{ name: 'Serum', price: '450.000đ' }], audience: 'Nữ 22–35', colors: ['#DB2777'], hashtags: ['#shopa'], bannedWords: [], allowedDomains: [] }

/** Lưu hồ sơ nhóm qua route (kích hoạt cả onGroupProfileSaved). */
async function saveGroupProfile(groupId: string, name = 'Shop A') {
  const res = await api('PUT', `/api/v1/brand-profiles/group/${groupId}`, { ...VALID, name })
  expect(res.statusCode).toBe(200)
}
const effectiveOf = async (pageId: string) =>
  EffectiveBrandProfileResponse.parse((await api('GET', `/api/v1/brand-profiles/effective/page/${pageId}`)).json())

describe('resolveEffective (hàm duy nhất giải kế thừa)', () => {
  it('trang thuộc nhóm có hồ sơ, use_own=false → hồ sơ nhóm kèm source{group, name}', async () => {
    const g = await seedGroup()
    const p = await seedPage('Shop A', g)
    await saveGroupProfile(g, 'Mỹ phẩm Lan Anh')
    const res = await effectiveOf(p)
    expect(res.effective).not.toBeNull()
    expect(res.effective!.source).toMatchObject({ ownerType: 'group', ownerId: g, name: 'Nhóm Mỹ phẩm' })
    expect(res.effective!.config.name).toBe('Mỹ phẩm Lan Anh')
  })

  it('trang không nhóm & không hồ sơ → CONFIG_MISSING (effective null)', async () => {
    const p = await seedPage('Shop lẻ', null)
    expect((await effectiveOf(p)).effective).toBeNull()
    // Hàm service ném AppError CONFIG_MISSING (hợp đồng cho consumer epic sau).
    await expect(resolveEffective(handle.db, p, 'brand')).rejects.toMatchObject({ code: 'CONFIG_MISSING' })
  })

  it('trang trong nhóm nhưng nhóm chưa có hồ sơ → CONFIG_MISSING', async () => {
    const g = await seedGroup()
    const p = await seedPage('Shop A', g)
    expect((await effectiveOf(p)).effective).toBeNull()
  })

  it('resolveEffective với pageId lạ → NOT_FOUND', async () => {
    await expect(resolveEffective(handle.db, newId(), 'brand')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('setUseOwn (áp khi Lưu)', () => {
  it('bật "Dùng hồ sơ riêng" → sao chép hồ sơ nhóm làm điểm xuất phát, use_own=true, source=page', async () => {
    const g = await seedGroup()
    const p = await seedPage('Shop A', g)
    await saveGroupProfile(g, 'Mỹ phẩm Lan Anh')

    const res = EffectiveBrandProfileResponse.parse((await api('PUT', `/api/v1/brand-profiles/use-own/page/${p}`, { useOwn: true })).json())
    expect(res.effective!.source).toMatchObject({ ownerType: 'page', ownerId: p })
    expect(res.effective!.config.name).toBe('Mỹ phẩm Lan Anh') // đã sao chép từ nhóm

    expect(await getPageConfigState(handle.db, p, 'brand')).toEqual({ useOwn: true, awaitingGroupDefault: false })
    const [own] = await handle.sql`select 1 from brand_profiles where owner_type = 'page' and owner_id = ${p}`
    expect(own).toBeTruthy()
  })

  it('tắt "Dùng hồ sơ riêng" → xoá hồ sơ riêng, trang quay về hồ sơ nhóm (use_own=false)', async () => {
    const g = await seedGroup()
    const p = await seedPage('Shop A', g)
    await saveGroupProfile(g, 'Hồ sơ nhóm')
    await api('PUT', `/api/v1/brand-profiles/use-own/page/${p}`, { useOwn: true })

    const res = EffectiveBrandProfileResponse.parse((await api('PUT', `/api/v1/brand-profiles/use-own/page/${p}`, { useOwn: false })).json())
    expect(res.effective!.source).toMatchObject({ ownerType: 'group', ownerId: g })
    expect(res.effective!.config.name).toBe('Hồ sơ nhóm')
    expect(await getPageConfigState(handle.db, p, 'brand')).toEqual({ useOwn: false, awaitingGroupDefault: false })
    expect(await handle.sql`select 1 from brand_profiles where owner_type = 'page' and owner_id = ${p}`).toHaveLength(0)
  })

  it('bật riêng khi nhóm chưa có hồ sơ → use_own=true nhưng chưa có cấu hình → CONFIG_MISSING tới khi trang tự lưu', async () => {
    const g = await seedGroup()
    const p = await seedPage('Shop A', g)
    const res = EffectiveBrandProfileResponse.parse((await api('PUT', `/api/v1/brand-profiles/use-own/page/${p}`, { useOwn: true })).json())
    expect(res.effective).toBeNull()
    expect(await getPageConfigState(handle.db, p, 'brand')).toEqual({ useOwn: true, awaitingGroupDefault: false })

    // Trang tự lưu hồ sơ riêng → có hiệu lực, source=page.
    await api('PUT', `/api/v1/brand-profiles/page/${p}`, { ...VALID, name: 'Riêng của trang' })
    const after = await effectiveOf(p)
    expect(after.effective!.source).toMatchObject({ ownerType: 'page', ownerId: p })
    expect(after.effective!.config.name).toBe('Riêng của trang')
  })

  it('use-own với pageId lạ → 404', async () => {
    expect((await api('PUT', `/api/v1/brand-profiles/use-own/page/${newId()}`, { useOwn: true })).statusCode).toBe(404)
  })

  it('tắt "dùng riêng" cho trang KHÔNG thuộc nhóm → VALIDATION_FAILED (không xoá hồ sơ duy nhất)', async () => {
    const p = await seedPage('Shop lẻ', null)
    await api('PUT', `/api/v1/brand-profiles/page/${p}`, VALID) // tạo hồ sơ riêng
    const res = await api('PUT', `/api/v1/brand-profiles/use-own/page/${p}`, { useOwn: false })
    expect(res.statusCode).toBe(400)
    expect(await handle.sql`select 1 from brand_profiles where owner_type = 'page' and owner_id = ${p}`).toHaveLength(1)
  })
})

describe('trang không nhóm có hồ sơ riêng (AC4: tạo hồ sơ riêng cho trang)', () => {
  it('trang không nhóm tự lưu hồ sơ → effective = source page, dù use_own chưa đặt (không gì để kế thừa)', async () => {
    const p = await seedPage('Shop lẻ', null)
    await api('PUT', `/api/v1/brand-profiles/page/${p}`, VALID)
    const res = await effectiveOf(p)
    expect(res.effective!.source).toMatchObject({ ownerType: 'page', ownerId: p })
    expect(res.effective!.config.name).toBe('Shop A')
    expect(BrandProfileDto.parse((await api('GET', `/api/v1/brand-profiles/page/${p}`)).json().profile).name).toBe('Shop A')
  })
})
