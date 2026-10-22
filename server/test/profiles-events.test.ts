// Ma trận Story 3.3 — đổi thành viên nhóm giữ cấu hình. Gọi thẳng consumer `handleProfilesEvent` (như events.ai)
// + Postgres nhúng. Phủ: rời nhóm→sao chép riêng, xoá nhóm→sao chép rồi xoá cấu hình nhóm, vào nhóm có/chưa có
// cấu hình, awaiting→theo nhóm khi nhóm lưu lần đầu, và idempotent khi sự kiện tới hai lần.
import { SaveBrandProfileRequest, type EventName, type EventPayload } from '@ottm/shared'
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest'
import { getPageConfigState, handleProfilesEvent, resolveEffective, setUseOwn, upsertProfile } from '../src/modules/profiles/index.ts'
import { createDb, newId, type DbHandle } from '../src/platform/db/index.ts'

let handle: DbHandle

beforeAll(async () => {
  handle = createDb(inject('databaseUrl'), { max: 3 })
})
afterAll(async () => {
  await cleanup()
  await handle.close()
})
async function cleanup() {
  await handle.sql`delete from page_config_state`
  await handle.sql`delete from brand_profiles`
  await handle.sql`update pages set group_id = null`
  await handle.sql`delete from pages`
  await handle.sql`delete from groups`
}
beforeEach(cleanup)

const deps = () => ({ db: handle.db })

async function seedGroup(name = 'Nhóm Mỹ phẩm'): Promise<string> {
  const [row] = await handle.sql<{ id: string }[]>`insert into groups (name, color) values (${name}, 'group-1') returning id`
  return row!.id
}
async function seedPage(groupId: string | null = null, name = 'Shop A'): Promise<string> {
  const [row] = await handle.sql<{ id: string }[]>`
    insert into pages (platform, platform_account_id, name, group_id) values ('facebook', ${newId()}, ${name}, ${groupId}) returning id`
  return row!.id
}
const setGroup = (pageId: string, groupId: string | null) => handle.sql`update pages set group_id = ${groupId} where id = ${pageId}`
const parsed = (name: string) => SaveBrandProfileRequest.parse({ name, slogan: '', industry: '', tones: [], formality: 60, pronoun: '', emoji: 'some', products: [], audience: '', colors: [], hashtags: [], bannedWords: [], allowedDomains: [] })

const saveProfile = (ownerType: 'group' | 'page', ownerId: string, name: string) => upsertProfile(handle.db, { ownerType, ownerId }, parsed(name))
const hasOwn = async (pageId: string) => (await handle.sql`select 1 from brand_profiles where owner_type = 'page' and owner_id = ${pageId}`).length > 0
const hasGroupProfile = async (groupId: string) => (await handle.sql`select 1 from brand_profiles where owner_type = 'group' and owner_id = ${groupId}`).length > 0

function groupChanged(pageId: string, fromGroupId: string | null, toGroupId: string | null): { event: EventName; payload: EventPayload<'page.group_changed'> } {
  return { event: 'page.group_changed', payload: { id: pageId, pageId, fromGroupId, toGroupId } }
}
function groupDeleted(groupId: string, memberPageIds: string[]): { event: EventName; payload: EventPayload<'group.deleted'> } {
  return { event: 'group.deleted', payload: { id: groupId, groupId, memberPageIds } }
}

describe('rời nhóm (không cấu hình riêng)', () => {
  it('page.group_changed {A,null} → sao chép cấu hình A thành riêng, use_own=true', async () => {
    const a = await seedGroup()
    const p = await seedPage(a)
    await saveProfile('group', a, 'Hồ sơ A')
    await setGroup(p, null) // pages.unassignGroup đã đặt group_id=null trước khi phát sự kiện

    expect(await handleProfilesEvent(deps(), groupChanged(p, a, null))).toBe('applied')
    expect(await hasOwn(p)).toBe(true)
    expect(await getPageConfigState(handle.db, p, 'brand')).toEqual({ useOwn: true, awaitingGroupDefault: false })
    const eff = await resolveEffective(handle.db, p, 'brand')
    expect(eff.source.ownerType).toBe('page')
    expect((eff.config as { name: string }).name).toBe('Hồ sơ A')
  })

  it('rời nhóm mà nhóm cũ không có cấu hình → không có riêng, use_own=false (CONFIG_MISSING)', async () => {
    const a = await seedGroup()
    const p = await seedPage(a)
    await setGroup(p, null)
    await handleProfilesEvent(deps(), groupChanged(p, a, null))
    expect(await hasOwn(p)).toBe(false)
    expect(await getPageConfigState(handle.db, p, 'brand')).toEqual({ useOwn: false, awaitingGroupDefault: false })
    await expect(resolveEffective(handle.db, p, 'brand')).rejects.toMatchObject({ code: 'CONFIG_MISSING' })
  })
})

describe('xoá nhóm (group.deleted)', () => {
  it('các trang thành viên sao chép cấu hình cũ thành riêng rồi cấu hình nhóm bị xoá', async () => {
    const a = await seedGroup()
    const p1 = await seedPage(a)
    const p2 = await seedPage(a)
    await saveProfile('group', a, 'Hồ sơ A')
    // deleteGroup đã đặt group_id=null cho các trang trước khi phát group.deleted.
    await setGroup(p1, null)
    await setGroup(p2, null)

    expect(await handleProfilesEvent(deps(), groupDeleted(a, [p1, p2]))).toBe('applied')
    expect(await hasOwn(p1)).toBe(true)
    expect(await hasOwn(p2)).toBe(true)
    expect(await hasGroupProfile(a)).toBe(false) // cấu hình nhóm đã xoá bị xoá sau đó
    for (const p of [p1, p2]) {
      const eff = await resolveEffective(handle.db, p, 'brand')
      expect(eff.source.ownerType).toBe('page')
      expect((eff.config as { name: string }).name).toBe('Hồ sơ A')
    }
  })
})

describe('vào nhóm', () => {
  it('vào nhóm đã có cấu hình loại đó → xoá cấu hình riêng, use_own=false', async () => {
    const b = await seedGroup('Nhóm B')
    await saveProfile('group', b, 'Hồ sơ B')
    const p = await seedPage(null)
    await saveProfile('page', p, 'Riêng cũ')
    await handle.db.transaction((tx) => setUseOwn(tx, p, 'brand', true))
    await setGroup(p, b)

    expect(await handleProfilesEvent(deps(), groupChanged(p, null, b))).toBe('applied')
    expect(await hasOwn(p)).toBe(false)
    expect(await getPageConfigState(handle.db, p, 'brand')).toEqual({ useOwn: false, awaitingGroupDefault: false })
    const eff = await resolveEffective(handle.db, p, 'brand')
    expect(eff.source).toMatchObject({ ownerType: 'group', ownerId: b })
    expect((eff.config as { name: string }).name).toBe('Hồ sơ B')
  })

  it('vào nhóm CHƯA có cấu hình → giữ riêng, awaiting=true; nhóm lưu lần đầu → về theo nhóm', async () => {
    const c = await seedGroup('Nhóm C')
    const p = await seedPage(null)
    await saveProfile('page', p, 'Riêng của trang')
    await handle.db.transaction((tx) => setUseOwn(tx, p, 'brand', true))
    await setGroup(p, c)

    await handleProfilesEvent(deps(), groupChanged(p, null, c))
    expect(await hasOwn(p)).toBe(true)
    expect(await getPageConfigState(handle.db, p, 'brand')).toEqual({ useOwn: true, awaitingGroupDefault: true })
    // Awaiting: vẫn dùng hồ sơ riêng tới khi nhóm có cấu hình.
    expect((await resolveEffective(handle.db, p, 'brand')).source.ownerType).toBe('page')

    // Nhóm C lưu cấu hình lần đầu → trang awaiting chuyển về "Theo nhóm".
    await saveProfile('group', c, 'Hồ sơ C')
    expect(await hasOwn(p)).toBe(false)
    expect(await getPageConfigState(handle.db, p, 'brand')).toEqual({ useOwn: false, awaitingGroupDefault: false })
    const eff = await resolveEffective(handle.db, p, 'brand')
    expect(eff.source).toMatchObject({ ownerType: 'group', ownerId: c })
    expect((eff.config as { name: string }).name).toBe('Hồ sơ C')
  })

  it('vào nhóm chưa có cấu hình mà trang cũng chưa có riêng → sao chép từ nhóm cũ (giữ hành vi), awaiting', async () => {
    const a = await seedGroup('Nhóm A')
    await saveProfile('group', a, 'Hồ sơ A')
    const c = await seedGroup('Nhóm C')
    const p = await seedPage(a)
    await setGroup(p, c) // chuyển A → C (C chưa có cấu hình)

    await handleProfilesEvent(deps(), groupChanged(p, a, c))
    expect(await hasOwn(p)).toBe(true) // sao chép từ A để không mất hành vi
    expect(await getPageConfigState(handle.db, p, 'brand')).toEqual({ useOwn: true, awaitingGroupDefault: true })
    expect((await resolveEffective(handle.db, p, 'brand')).source.ownerType).toBe('page')
  })
})

describe('idempotent khi sự kiện tới hai lần', () => {
  it('rời nhóm xử lý hai lần → kết quả như một lần (không nhân đôi/không hỏng)', async () => {
    const a = await seedGroup()
    const p = await seedPage(a)
    await saveProfile('group', a, 'Hồ sơ A')
    await setGroup(p, null)

    await handleProfilesEvent(deps(), groupChanged(p, a, null))
    await handleProfilesEvent(deps(), groupChanged(p, a, null))
    expect(await handle.sql`select 1 from brand_profiles where owner_type = 'page' and owner_id = ${p}`).toHaveLength(1)
    expect(await getPageConfigState(handle.db, p, 'brand')).toEqual({ useOwn: true, awaitingGroupDefault: false })
  })

  it('group.deleted xử lý hai lần → cấu hình nhóm vẫn xoá, trang vẫn có đúng một bản riêng', async () => {
    const a = await seedGroup()
    const p = await seedPage(a)
    await saveProfile('group', a, 'Hồ sơ A')
    await setGroup(p, null)

    await handleProfilesEvent(deps(), groupDeleted(a, [p]))
    await handleProfilesEvent(deps(), groupDeleted(a, [p]))
    expect(await handle.sql`select 1 from brand_profiles where owner_type = 'page' and owner_id = ${p}`).toHaveLength(1)
    expect(await hasGroupProfile(a)).toBe(false)
    expect(await getPageConfigState(handle.db, p, 'brand')).toEqual({ useOwn: true, awaitingGroupDefault: false })
  })

  it('sự kiện lạ / sai dạng → ignored', async () => {
    expect(await handleProfilesEvent(deps(), { event: 'page.removed', payload: { id: newId() } })).toBe('ignored')
    expect(await handleProfilesEvent(deps(), { nope: true })).toBe('ignored')
  })

  it('group.deleted thiếu memberPageIds (không phải mảng) → ignored (không for-of trên undefined)', async () => {
    expect(await handleProfilesEvent(deps(), { event: 'group.deleted', payload: { id: newId(), groupId: newId() } })).toBe('ignored')
  })
})

describe('chuẩn hoá payload page.group_changed', () => {
  it('thiếu toGroupId → coi như rời nhóm (sao chép nhóm cũ→riêng), KHÔNG rơi nhánh join id undefined', async () => {
    const a = await seedGroup()
    const p = await seedPage(a)
    await saveProfile('group', a, 'Hồ sơ A')
    await setGroup(p, null)
    // Payload chỉ có pageId + fromGroupId (thiếu toGroupId) → toGroupId null → rời nhóm.
    expect(await handleProfilesEvent(deps(), { event: 'page.group_changed', payload: { id: p, pageId: p, fromGroupId: a } })).toBe('applied')
    expect(await hasOwn(p)).toBe(true)
    expect(await getPageConfigState(handle.db, p, 'brand')).toEqual({ useOwn: true, awaitingGroupDefault: false })
  })
})
