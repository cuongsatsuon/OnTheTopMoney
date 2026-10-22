// Ma trận Story 2.5 — nhóm và gán trang (AD-8). Qua app thật (buildApp) + Postgres nhúng; sự kiện bắt bằng
// một queue SINK đăng ký `page.group_changed` / `group.deleted` (giống events.test.ts).
import {
  AssignGroupResponse,
  CreateGroupResponse,
  DeleteGroupResponse,
  ErrorResponse,
  GroupDto,
  GroupMoveImpact,
  ListGroupsResponse,
  ListPagesResponse,
  type EventName,
  type EventPayload,
} from '@ottm/shared'
import type { FastifyInstance } from 'fastify'
import type { PgBoss } from 'pg-boss'
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest'
import { buildApp } from '../src/app/app.ts'
import { SESSION_COOKIE } from '../src/app/auth/index.ts'
import { createSession } from '../src/modules/settings/index.ts'
import { createDb, newId, type DbHandle } from '../src/platform/db/index.ts'
import { createEventPublisher, type EventPublisher } from '../src/platform/events/index.ts'
import { BOSS_SCHEMA, createBoss } from '../src/platform/jobs/index.ts'
import { createLogger } from '../src/platform/log/index.ts'

const ORIGIN = 'http://localhost:5173'
const SINK = 'testonly.group_sink'
const EVENTS = ['page.group_changed', 'group.deleted'] as const

let handle: DbHandle
let boss: PgBoss
let events: EventPublisher
let app: FastifyInstance
let token: string

beforeAll(async () => {
  handle = createDb(inject('databaseUrl'), { max: 3 })
  boss = createBoss(inject('databaseUrl'), 'ottm-test-groups', { background: false })
  boss.on('error', () => {})
  await boss.start()
  await boss.createQueue(SINK)
  for (const e of EVENTS) await boss.subscribe(e, SINK)
  events = createEventPublisher(boss)
  app = buildApp({
    sql: handle.sql,
    db: handle.db,
    logger: createLogger({ level: 'silent' }),
    http: { allowedOrigins: [ORIGIN] },
    events,
  })
})
afterAll(async () => {
  await handle.sql`delete from pages`
  await handle.sql`delete from groups`
  for (const e of EVENTS) await boss.unsubscribe(e, SINK)
  await boss.deleteQueue(SINK)
  await app.close()
  await boss.stop({ graceful: false })
  await handle.close()
})
beforeEach(async () => {
  await handle.sql`update pages set group_id = null`
  await handle.sql`delete from pages`
  await handle.sql`delete from groups`
  await boss.deleteAllJobs(SINK)
  const s = await createSession(handle.db)
  token = s.token
})

const cookie = (t = token) => ({ cookie: `${SESSION_COOKIE}=${t}` })

async function api(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown, t: string | null = token) {
  return app.inject({
    method,
    url,
    headers: { ...(t ? cookie(t) : {}), ...(method === 'GET' ? {} : { origin: ORIGIN }) },
    ...(payload !== undefined ? { payload: payload as object } : {}),
  })
}

const errorCode = (res: { json(): unknown }) => ErrorResponse.parse(res.json()).error.code

/** Tạo trang trực tiếp (Story 2.2 lo kết nối thật); trả id. */
async function seedPage(name: string, platform = 'facebook'): Promise<string> {
  const [row] = await handle.sql<{ id: string }[]>`
    insert into pages (platform, platform_account_id, name) values (${platform}, ${newId()}, ${name}) returning id`
  return row!.id
}

const JOB_SQL = `select data from ${BOSS_SCHEMA}.job where name = $1`

/** Sự kiện SINK đã nhận (chờ commit → job tới), lọc theo tên. */
async function sinkEvents<N extends EventName>(event: N): Promise<EventPayload<N>[]> {
  for (let i = 0; i < 40; i++) {
    const rows = await handle.sql.unsafe<{ data: { event: string; payload: unknown } }[]>(JOB_SQL, [SINK])
    const matched = rows.filter((r) => r.data.event === event).map((r) => r.data.payload as EventPayload<N>)
    if (matched.length) return matched
    await new Promise((r) => setTimeout(r, 25))
  }
  return []
}
async function allSinkJobs(): Promise<{ event: string }[]> {
  const rows = await handle.sql.unsafe<{ data: { event: string } }[]>(JOB_SQL, [SINK])
  return rows.map((r) => r.data)
}

const groupIdOfPage = async (id: string) =>
  (await handle.sql<{ group_id: string | null }[]>`select group_id from pages where id = ${id}`)[0]!.group_id

describe('xác thực & kiểm tra đầu vào', () => {
  it('chưa đăng nhập → 401 ở route ghi', async () => {
    const res = await api('POST', '/api/v1/groups', { name: 'X', color: 'group-1' }, null)
    expect(res.statusCode).toBe(401)
  })

  it('tên rỗng / chỉ khoảng trắng → VALIDATION_FAILED', async () => {
    for (const name of ['', '   ']) {
      const res = await api('POST', '/api/v1/groups', { name, color: 'group-1' })
      expect(res.statusCode).toBe(400)
      expect(errorCode(res)).toBe('VALIDATION_FAILED')
    }
  })

  it('màu ngoài bảng 8 màu → VALIDATION_FAILED', async () => {
    const res = await api('POST', '/api/v1/groups', { name: 'Nhóm', color: '#DB2777' })
    expect(res.statusCode).toBe(400)
    expect(errorCode(res)).toBe('VALIDATION_FAILED')
  })

  it('tên quá dài (>60 ký tự) → VALIDATION_FAILED', async () => {
    const res = await api('POST', '/api/v1/groups', { name: 'N'.repeat(61), color: 'group-1' })
    expect(res.statusCode).toBe(400)
    expect(errorCode(res)).toBe('VALIDATION_FAILED')
  })

  it('gán với danh sách trang rỗng → VALIDATION_FAILED', async () => {
    const g = GroupDto.parse((await api('POST', '/api/v1/groups', { name: 'G', color: 'group-1' }).then((r) => r.json())).group)
    const res = await api('POST', `/api/v1/groups/${g.id}/members`, { pageIds: [] })
    expect(res.statusCode).toBe(400)
    expect(errorCode(res)).toBe('VALIDATION_FAILED')
  })
})

describe('tạo nhóm + gán', () => {
  it('chọn 3 trang, tạo nhóm màu group-2 → nhóm tạo, 3 trang groupId=nhóm, 3 sự kiện page.group_changed', async () => {
    const ids = [await seedPage('A'), await seedPage('B'), await seedPage('C')]
    const res = await api('POST', '/api/v1/groups', { name: '  Nhóm Mỹ phẩm  ', color: 'group-2', pageIds: ids })
    expect(res.statusCode).toBe(200)
    const body = CreateGroupResponse.parse(res.json())
    expect(body.group.name).toBe('Nhóm Mỹ phẩm') // tên đã cắt khoảng trắng
    expect(body.group.color).toBe('group-2')
    expect(new Set(body.changedPageIds)).toEqual(new Set(ids))

    for (const id of ids) expect(await groupIdOfPage(id)).toBe(body.group.id)

    const evts = await sinkEvents('page.group_changed')
    expect(evts).toHaveLength(3)
    for (const e of evts) {
      expect(e.fromGroupId).toBeNull()
      expect(e.toGroupId).toBe(body.group.id)
      expect(ids).toContain(e.pageId)
    }
  })

  it('tạo nhóm không kèm trang → không phát sự kiện', async () => {
    const res = await api('POST', '/api/v1/groups', { name: 'Trống', color: 'group-1' })
    expect(res.statusCode).toBe(200)
    await new Promise((r) => setTimeout(r, 200))
    expect(await allSinkJobs()).toEqual([])
  })

  it('gán trang không tồn tại → 404, transaction rollback (không nhóm, không sự kiện)', async () => {
    const real = await seedPage('A')
    const res = await api('POST', '/api/v1/groups', { name: 'N', color: 'group-1', pageIds: [real, newId()] })
    expect(res.statusCode).toBe(404)
    expect(await handle.sql`select 1 from groups`).toHaveLength(0)
    expect(await groupIdOfPage(real)).toBeNull()
    await new Promise((r) => setTimeout(r, 150))
    expect(await allSinkJobs()).toEqual([])
  })
})

describe('xem ảnh hưởng rồi chuyển nhóm (mỗi trang một nhóm)', () => {
  it('trang ở nhóm A, preview sang B → {moves:[{A}], campaigns:[]}; confirm → đổi + sự kiện {A,B}', async () => {
    const page = await seedPage('P')
    const a = GroupDto.parse((await api('POST', '/api/v1/groups', { name: 'A', color: 'group-1', pageIds: [page] }).then((r) => r.json())).group)
    const b = GroupDto.parse((await api('POST', '/api/v1/groups', { name: 'B', color: 'group-2' }).then((r) => r.json())).group)
    await boss.deleteAllJobs(SINK)

    const prev = await api('POST', `/api/v1/groups/${b.id}/members/preview`, { pageIds: [page] })
    expect(prev.statusCode).toBe(200)
    const impact = GroupMoveImpact.parse(prev.json())
    expect(impact.moves).toEqual([{ pageId: page, fromGroupId: a.id }])
    expect(impact.campaigns).toEqual([])
    // Preview không đổi gì.
    expect(await groupIdOfPage(page)).toBe(a.id)
    expect(await allSinkJobs()).toEqual([])

    const res = await api('POST', `/api/v1/groups/${b.id}/members`, { pageIds: [page] })
    expect(res.statusCode).toBe(200)
    expect(AssignGroupResponse.parse(res.json()).changedPageIds).toEqual([page])
    expect(await groupIdOfPage(page)).toBe(b.id) // một nhóm duy nhất
    const [e] = await sinkEvents('page.group_changed')
    expect(e).toMatchObject({ pageId: page, fromGroupId: a.id, toGroupId: b.id })
  })

  it('gán trang đã ở đúng nhóm đó → no-op, không phát sự kiện thừa', async () => {
    const page = await seedPage('P')
    const g = GroupDto.parse((await api('POST', '/api/v1/groups', { name: 'G', color: 'group-1', pageIds: [page] }).then((r) => r.json())).group)
    await boss.deleteAllJobs(SINK)
    const res = await api('POST', `/api/v1/groups/${g.id}/members`, { pageIds: [page] })
    expect(res.statusCode).toBe(200)
    expect(AssignGroupResponse.parse(res.json()).changedPageIds).toEqual([])
    await new Promise((r) => setTimeout(r, 200))
    expect(await allSinkJobs()).toEqual([])
  })

  it('preview / gán nhóm không tồn tại → 404', async () => {
    const page = await seedPage('P')
    expect((await api('POST', `/api/v1/groups/${newId()}/members/preview`, { pageIds: [page] })).statusCode).toBe(404)
    expect((await api('POST', `/api/v1/groups/${newId()}/members`, { pageIds: [page] })).statusCode).toBe(404)
  })

  it('preview với trang không tồn tại → 404 (nhất quán với gán)', async () => {
    const g = GroupDto.parse((await api('POST', '/api/v1/groups', { name: 'G', color: 'group-1' }).then((r) => r.json())).group)
    const page = await seedPage('P')
    expect((await api('POST', `/api/v1/groups/${g.id}/members/preview`, { pageIds: [page, newId()] })).statusCode).toBe(404)
  })
})

describe('gỡ khỏi nhóm', () => {
  it('unassign → groupId null, page.group_changed {A,null}, 204', async () => {
    const page = await seedPage('P')
    const g = GroupDto.parse((await api('POST', '/api/v1/groups', { name: 'A', color: 'group-1', pageIds: [page] }).then((r) => r.json())).group)
    await boss.deleteAllJobs(SINK)
    const res = await api('DELETE', `/api/v1/pages/${page}/group`)
    expect(res.statusCode).toBe(204)
    expect(await groupIdOfPage(page)).toBeNull()
    const [e] = await sinkEvents('page.group_changed')
    expect(e).toMatchObject({ pageId: page, fromGroupId: g.id, toGroupId: null })
  })

  it('unassign trang vốn không có nhóm → no-op, không sự kiện', async () => {
    const page = await seedPage('P')
    const res = await api('DELETE', `/api/v1/pages/${page}/group`)
    expect(res.statusCode).toBe(204)
    await new Promise((r) => setTimeout(r, 150))
    expect(await allSinkJobs()).toEqual([])
  })
})

describe('xoá nhóm', () => {
  it('nhóm có 3 trang → 3 trang groupId null, group.deleted {groupId, [3 id]}, nhóm biến mất', async () => {
    const ids = [await seedPage('A'), await seedPage('B'), await seedPage('C')]
    const g = GroupDto.parse((await api('POST', '/api/v1/groups', { name: 'N', color: 'group-3', pageIds: ids }).then((r) => r.json())).group)
    await boss.deleteAllJobs(SINK)

    const res = await api('DELETE', `/api/v1/groups/${g.id}`)
    expect(res.statusCode).toBe(200)
    const body = DeleteGroupResponse.parse(res.json())
    expect(body.groupId).toBe(g.id)
    expect(new Set(body.memberPageIds)).toEqual(new Set(ids))

    for (const id of ids) expect(await groupIdOfPage(id)).toBeNull()
    expect(await handle.sql`select 1 from groups where id = ${g.id}`).toHaveLength(0)

    const [e] = await sinkEvents('group.deleted')
    expect(e.groupId).toBe(g.id)
    expect(new Set(e.memberPageIds)).toEqual(new Set(ids))
  })

  it('xoá nhóm không tồn tại → 404', async () => {
    expect((await api('DELETE', `/api/v1/groups/${newId()}`)).statusCode).toBe(404)
  })
})

describe('sửa tên/màu & danh sách', () => {
  it('rename + recolor không đổi thành viên, không phát page.group_changed', async () => {
    const page = await seedPage('P')
    const g = GroupDto.parse((await api('POST', '/api/v1/groups', { name: 'Cũ', color: 'group-1', pageIds: [page] }).then((r) => r.json())).group)
    await boss.deleteAllJobs(SINK)

    const res = await api('PATCH', `/api/v1/groups/${g.id}`, { name: '  Mới  ', color: 'group-5' })
    expect(res.statusCode).toBe(200)
    const dto = GroupDto.parse(res.json())
    expect(dto.name).toBe('Mới')
    expect(dto.color).toBe('group-5')
    expect(await groupIdOfPage(page)).toBe(g.id) // thành viên giữ nguyên
    await new Promise((r) => setTimeout(r, 150))
    expect(await allSinkJobs()).toEqual([])
  })

  it('PATCH rỗng → VALIDATION_FAILED; PATCH nhóm không tồn tại → 404', async () => {
    expect((await api('PATCH', `/api/v1/groups/${newId()}`, {})).statusCode).toBe(400)
    expect((await api('PATCH', `/api/v1/groups/${newId()}`, { name: 'X' })).statusCode).toBe(404)
  })

  it('chưa có nhóm → danh sách rỗng; sau khi tạo thì xuất hiện', async () => {
    expect(ListGroupsResponse.parse((await api('GET', '/api/v1/groups')).json()).items).toEqual([])
    await api('POST', '/api/v1/groups', { name: 'G1', color: 'group-1' })
    expect(ListGroupsResponse.parse((await api('GET', '/api/v1/groups')).json()).items).toHaveLength(1)
  })

  it('GET /pages trả groupId của trang', async () => {
    const page = await seedPage('P')
    const g = GroupDto.parse((await api('POST', '/api/v1/groups', { name: 'G', color: 'group-1', pageIds: [page] }).then((r) => r.json())).group)
    const items = ListPagesResponse.parse((await api('GET', '/api/v1/pages')).json()).items
    expect(items.find((p) => p.id === page)?.groupId).toBe(g.id)
  })
})
