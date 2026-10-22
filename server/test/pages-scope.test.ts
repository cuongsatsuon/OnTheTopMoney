// Ma trận Story 2.6 — phạm vi lọc dữ liệu thật (AD-18). `pages.resolveScope` là helper DUY NHẤT dịch phạm vi →
// tập pageId; `GET /pages?scope=` lọc theo đó. Qua app thật (buildApp) + Postgres nhúng, như pages-groups.test.ts.
import { ErrorResponse, ListPagesResponse } from '@ottm/shared'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest'
import { buildApp } from '../src/app/app.ts'
import { SESSION_COOKIE } from '../src/app/auth/index.ts'
import { resolveScope } from '../src/modules/pages/index.ts'
import { createSession } from '../src/modules/settings/index.ts'
import { createDb, newId, type DbHandle } from '../src/platform/db/index.ts'
import { createLogger } from '../src/platform/log/index.ts'

const ORIGIN = 'http://localhost:5173'

let handle: DbHandle
let app: FastifyInstance
let token: string

beforeAll(async () => {
  handle = createDb(inject('databaseUrl'), { max: 3 })
  app = buildApp({
    sql: handle.sql,
    db: handle.db,
    logger: createLogger({ level: 'silent' }),
    http: { allowedOrigins: [ORIGIN] },
  })
})
afterAll(async () => {
  await handle.sql`delete from pages`
  await handle.sql`delete from groups`
  await app.close()
  await handle.close()
})
beforeEach(async () => {
  // Xoá trang trước nhóm: `pages.group_id` tham chiếu `groups.id`, nên nhóm sạch FK sau khi trang đã đi.
  await handle.sql`delete from pages`
  await handle.sql`delete from groups`
  const s = await createSession(handle.db)
  token = s.token
})

const cookie = (t = token) => ({ cookie: `${SESSION_COOKIE}=${t}` })
const errorCode = (res: { json(): unknown }) => ErrorResponse.parse(res.json()).error.code

async function getPages(scope?: string) {
  const url = scope === undefined ? '/api/v1/pages' : `/api/v1/pages?scope=${encodeURIComponent(scope)}`
  return app.inject({ method: 'GET', url, headers: cookie() })
}
const idsOf = (res: { json(): unknown }) => ListPagesResponse.parse(res.json()).items.map((p) => p.id)

/** Tạo trang trực tiếp (Story 2.2 lo kết nối thật); trả id. Cũ nhất trước qua `connected_at`. */
async function seedPage(name: string, opts: { platform?: string; groupId?: string; removed?: boolean } = {}): Promise<string> {
  const [row] = await handle.sql<{ id: string }[]>`
    insert into pages (platform, platform_account_id, name, group_id, removed_at)
    values (${opts.platform ?? 'facebook'}, ${newId()}, ${name}, ${opts.groupId ?? null}, ${opts.removed ? handle.sql`now()` : null})
    returning id`
  return row!.id
}
async function seedGroup(name: string, color = 'group-1'): Promise<string> {
  const [row] = await handle.sql<{ id: string }[]>`insert into groups (name, color) values (${name}, ${color}) returning id`
  return row!.id
}

describe('resolveScope (helper duy nhất dịch phạm vi → tập pageId)', () => {
  it('all → mọi trang chưa gỡ, cũ nhất trước; trang đã gỡ bị loại', async () => {
    const a = await seedPage('A')
    const b = await seedPage('B')
    await seedPage('Đã gỡ', { removed: true })
    expect(await resolveScope(handle.db, { kind: 'all' })).toEqual([a, b])
  })

  it('group → đúng trang của nhóm (nhóm rỗng → [])', async () => {
    const g = await seedGroup('Mỹ phẩm')
    const p1 = await seedPage('P1', { groupId: g })
    const p2 = await seedPage('P2', { groupId: g })
    await seedPage('Ngoài nhóm')
    expect(new Set(await resolveScope(handle.db, { kind: 'group', id: g }))).toEqual(new Set([p1, p2]))

    const empty = await seedGroup('Rỗng')
    expect(await resolveScope(handle.db, { kind: 'group', id: empty })).toEqual([])
  })

  it('group → trang đã gỡ trong nhóm vẫn bị loại', async () => {
    const g = await seedGroup('N')
    const live = await seedPage('Sống', { groupId: g })
    await seedPage('Gỡ', { groupId: g, removed: true })
    expect(await resolveScope(handle.db, { kind: 'group', id: g })).toEqual([live])
  })

  it('page → [pageId]', async () => {
    const p = await seedPage('P')
    await seedPage('Khác')
    expect(await resolveScope(handle.db, { kind: 'page', id: p })).toEqual([p])
  })

  it('nhóm không tồn tại → 404; trang không tồn tại / đã gỡ → 404', async () => {
    await expect(resolveScope(handle.db, { kind: 'group', id: newId() })).rejects.toMatchObject({ statusCode: 404, code: 'NOT_FOUND' })
    await expect(resolveScope(handle.db, { kind: 'page', id: newId() })).rejects.toMatchObject({ statusCode: 404, code: 'NOT_FOUND' })
    const removed = await seedPage('Gỡ', { removed: true })
    await expect(resolveScope(handle.db, { kind: 'page', id: removed })).rejects.toMatchObject({ statusCode: 404, code: 'NOT_FOUND' })
  })
})

describe('GET /pages?scope=', () => {
  it('không có scope → mọi trang (mặc định all)', async () => {
    const a = await seedPage('A')
    const b = await seedPage('B')
    expect(await getPages().then(idsOf)).toEqual([a, b])
  })

  it('scope=all → mọi trang chưa gỡ', async () => {
    const a = await seedPage('A')
    await seedPage('Gỡ', { removed: true })
    expect(await getPages('all').then(idsOf)).toEqual([a])
  })

  it('scope=group:<id> → chỉ trang của nhóm đó', async () => {
    const g = await seedGroup('G')
    const inG = await seedPage('Trong', { groupId: g })
    await seedPage('Ngoài')
    expect(await getPages(`group:${g}`).then(idsOf)).toEqual([inG])
  })

  it('scope=page:<id> → đúng một trang', async () => {
    const p = await seedPage('P')
    await seedPage('Khác')
    expect(await getPages(`page:${p}`).then(idsOf)).toEqual([p])
  })

  it('scope sai cú pháp / id không phải uuid → VALIDATION_FAILED (400)', async () => {
    for (const bad of ['foo', 'group:', 'group:xyz', 'page:123', 'team:' + newId()]) {
      const res = await getPages(bad)
      expect(res.statusCode).toBe(400)
      expect(errorCode(res)).toBe('VALIDATION_FAILED')
    }
  })

  it('scope=group / page với id uuid không tồn tại → 404', async () => {
    expect((await getPages(`group:${newId()}`)).statusCode).toBe(404)
    expect((await getPages(`page:${newId()}`)).statusCode).toBe(404)
  })

  it('chưa đăng nhập → 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/pages' })
    expect(res.statusCode).toBe(401)
  })
})
