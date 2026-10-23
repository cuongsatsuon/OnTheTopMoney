// Story 4.10 — Tìm nhanh ⌘K (AD-1, AD-18). Postgres thật (extension `unaccent` + `pg_trgm`, hàm `search_norm` /
// `search_phone` của migration 0021). Phủ ma trận I/O phía server: không dấu (trang, handle, nhóm + số trang, khách),
// thứ tự từ / hoa thường, SĐT (khoảng trắng, +84, quá ít chữ số), gõ sai (gần đúng, xếp sau), xếp hạng, trang / khách
// đã gỡ, ký tự đại diện, giới hạn mỗi loại, lỗi kiểm + 401, `q` của danh sách Khách hàng; index có trên đúng biểu thức.
import { SearchResponse, type ListContactsResponse } from '@ottm/shared'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest'
import { buildApp } from '../src/app/app.ts'
import { SESSION_COOKIE } from '../src/app/auth/index.ts'
import { createSession } from '../src/modules/settings/index.ts'
import { createDb, type DbHandle } from '../src/platform/db/index.ts'
import { phoneDigits, searchTerms } from '../src/platform/db/search.ts'
import { createLogger } from '../src/platform/log/index.ts'

const ORIGIN = 'http://localhost:5173'

let handle: DbHandle
let app: FastifyInstance
let cookie: string

async function cleanup() {
  await handle.sql`delete from contacts`
  await handle.sql`update pages set group_id = null`
  await handle.sql`delete from pages`
  await handle.sql`delete from groups`
  await handle.sql`delete from sessions`
}

beforeAll(async () => {
  handle = createDb(inject('databaseUrl'), { max: 3 })
  app = buildApp({ sql: handle.sql, db: handle.db, logger: createLogger({ level: 'silent' }), http: { allowedOrigins: [ORIGIN] } })
})
afterAll(async () => {
  await cleanup()
  await app.close()
  await handle.close()
})
beforeEach(async () => {
  await cleanup()
  cookie = `${SESSION_COOKIE}=${(await createSession(handle.db)).token}`
})

// ---------------------------------------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------------------------------------

let seq = 0

async function group(name: string): Promise<string> {
  const [g] = await handle.sql<{ id: string }[]>`insert into groups (name, color) values (${name}, 'group-1') returning id`
  return g!.id
}

async function page(name: string, opts: { handle?: string; groupId?: string; removed?: boolean } = {}): Promise<string> {
  seq += 1
  const [p] = await handle.sql<{ id: string }[]>`
    insert into pages (platform, platform_account_id, name, handle, group_id, removed_at)
    values ('facebook', ${`acc_${seq}`}, ${name}, ${opts.handle ?? null}, ${opts.groupId ?? null}, case when ${opts.removed ?? false} then now() end)
    returning id`
  return p!.id
}

/** Khách có định danh trên các trang `pageIds`. */
async function contact(name: string | null, pageIds: string[], phone: string | null = null): Promise<string> {
  const [c] = await handle.sql<{ id: string }[]>`insert into contacts (name, phone) values (${name}, ${phone}) returning id`
  for (const pageId of pageIds) {
    seq += 1
    await handle.sql`insert into contact_identities (contact_id, page_id, platform_user_id) values (${c!.id}, ${pageId}, ${`psid_${seq}`})`
  }
  return c!.id
}

const get = (url: string, auth = true) => app.inject({ method: 'GET', url: `/api/v1${url}`, headers: { origin: ORIGIN, ...(auth ? { cookie } : {}) } })

async function search(q: string): Promise<SearchResponse> {
  const res = await get(`/search?q=${encodeURIComponent(q)}`)
  expect(res.statusCode).toBe(200)
  return SearchResponse.parse(res.json())
}
const pageNames = async (q: string) => (await search(q)).pages.map((p) => p.name)
const contactIds = async (q: string) => (await search(q)).contacts.map((c) => c.id)

// ---------------------------------------------------------------------------------------------------------
// GET /api/v1/search
// ---------------------------------------------------------------------------------------------------------

describe('GET /api/v1/search', () => {
  it('"nguyen thu ha" khớp khách, trang "Nguyễn Thu Hà"; nhóm không dấu kèm số trang chưa gỡ', async () => {
    const g = await group('Đồ gia dụng')
    const shop = await page('Nguyễn Thu Hà Shop', { groupId: g })
    await page('Trang gỡ cùng nhóm', { groupId: g, removed: true })
    await page('Mỹ phẩm Lan')
    const ha = await contact('Nguyễn Thu Hà', [shop])
    await contact('Trần Văn Long', [shop])

    const r = await search('nguyen thu ha')
    expect(r.pages.map((p) => p.id)).toEqual([shop])
    expect(r.pages[0]).toMatchObject({ name: 'Nguyễn Thu Hà Shop', groupId: g, platform: 'facebook' })
    expect(r.contacts).toEqual([{ id: ha, name: 'Nguyễn Thu Hà', phone: null, stage: 'new', pageIds: [shop] }])
    expect(r.groups).toEqual([])

    const byGroup = await search('do gia')
    expect(byGroup.groups).toMatchObject([{ id: g, name: 'Đồ gia dụng', color: 'group-1', pageCount: 1 }])
    expect(await pageNames('MY PHAM')).toEqual(['Mỹ phẩm Lan'])
  })

  it('thứ tự từ tự do, hoa thường, có dấu hay không; trang khớp cả handle', async () => {
    const p = await page('Shop Bé Yêu', { handle: 'be.yeu.official' })
    const ha = await contact('Nguyễn Thu Hà', [p])
    expect(await contactIds('ha nguyen')).toEqual([ha])
    expect(await contactIds('HÀ')).toEqual([ha])
    expect(await contactIds('Nguyễn   thu')).toEqual([ha])
    expect(await contactIds('nguyen long')).toEqual([])
    expect(await pageNames('official')).toEqual(['Shop Bé Yêu'])
  })

  it('SĐT theo chữ số: bỏ khoảng trắng, +84 ↔ 0; ít hơn 3 chữ số thì không khớp theo SĐT; khách chưa có tên vẫn tìm được', async () => {
    const p = await page('Trang A')
    const c = await contact(null, [p], '0912 345 678')
    const other = await contact('Lê Bình', [p], '0988 000 111')
    expect(await contactIds('345678')).toEqual([c])
    expect(await contactIds('0912345678')).toEqual([c])
    expect(await contactIds('+84 912 345 678')).toEqual([c])
    expect(await contactIds('34')).toEqual([])
    expect((await search('0988')).contacts).toEqual([{ id: other, name: 'Lê Bình', phone: '0988 000 111', stage: 'new', pageIds: [p] }])
  })

  it('gõ sai vẫn ra (gần đúng), xếp sau khách khớp đủ từ; truy vấn ngắn không khớp gần đúng', async () => {
    const p = await page('Trang A')
    const ha = await contact('Nguyễn Thu Hà', [p])
    const hoa = await contact('Nguyễn Thu Hoa', [p])
    await contact('Trần Văn Long', [p])
    expect(await contactIds('ngyen thu ha')).toEqual([ha])
    expect(await contactIds('nguyen thu hoa')).toEqual([hoa, ha])
    expect(await contactIds('hoa')).toEqual([hoa])
    expect(await contactIds('lon')).toEqual([(await contactIds('long'))[0]])
  })

  it('xếp hạng: trùng hẳn > bắt đầu bằng > chứa', async () => {
    await page('Shop Hà')
    await page('Hà Nội Shop')
    await page('Hà')
    expect(await pageNames('ha')).toEqual(['Hà', 'Hà Nội Shop', 'Shop Hà'])
  })

  it('bỏ trang đã gỡ và khách chỉ còn định danh trên trang đã gỡ; pageIds chỉ trang chưa gỡ', async () => {
    const live = await page('Hà Live')
    const gone = await page('Hà Gỡ', { removed: true })
    const both = await contact('Hà Hai Trang', [gone, live])
    await contact('Hà Chỉ Gỡ', [gone])
    const r = await search('ha')
    expect(r.pages.map((p) => p.id)).toEqual([live])
    expect(r.contacts).toMatchObject([{ id: both, pageIds: [live] }])
  })

  it('ký tự đại diện của LIKE là chữ thường', async () => {
    await page('Abc')
    await page('1000')
    expect(await pageNames('a_c')).toEqual([])
    expect(await pageNames('%')).toEqual([])
    expect(await pageNames('\\')).toEqual([])
  })

  it('tối đa 5 trang, 5 nhóm, 8 khách', async () => {
    const ids: string[] = []
    for (let i = 0; i < 7; i += 1) ids.push(await page(`Hà ${i}`))
    for (let i = 0; i < 7; i += 1) await group(`Hà nhóm ${i}`)
    for (let i = 0; i < 10; i += 1) await contact(`Hà khách ${i}`, [ids[0]!])
    const r = await search('ha')
    expect([r.pages.length, r.groups.length, r.contacts.length]).toEqual([5, 5, 8])
  })

  it('q rỗng / chỉ khoảng trắng / quá 100 ký tự → 400; thiếu phiên → 401', async () => {
    for (const qs of ['', '?q=', '?q=%20%20', `?q=${'a'.repeat(101)}`]) {
      const res = await get(`/search${qs}`)
      expect(res.statusCode).toBe(400)
      expect(res.json().error.code).toBe('VALIDATION_FAILED')
    }
    expect((await get('/search?q=ha', false)).statusCode).toBe(401)
  })

  it('index GIN trigram trên đúng biểu thức `search_norm` / `search_phone`', async () => {
    const rows = await handle.sql<{ indexname: string; indexdef: string }[]>`
      select indexname, indexdef from pg_indexes where indexname like '%\\_search\\_idx' order by indexname`
    expect(rows.map((r) => r.indexname)).toEqual([
      'contacts_name_search_idx',
      'contacts_phone_search_idx',
      'groups_name_search_idx',
      'pages_handle_search_idx',
      'pages_name_search_idx',
    ])
    for (const r of rows) expect(r.indexdef).toMatch(/USING gin \(search_(norm|phone)\(\w+\) gin_trgm_ops\)/)
    const [norm] = await handle.sql<{ a: string; b: string }[]>`
      select search_norm('Nguyễn Thu Hà ĐỨC') as a, search_phone('+84 912 345 678') as b`
    expect(norm).toEqual({ a: 'nguyen thu ha duc', b: '0912345678' })
  })
})

// ---------------------------------------------------------------------------------------------------------
// `q` của danh sách Khách hàng (Story 4.9 → không dấu)
// ---------------------------------------------------------------------------------------------------------

describe('GET /api/v1/contacts?q= (không dấu)', () => {
  it('khớp không dấu theo tên hoặc thẻ; không khớp gần đúng', async () => {
    const p = await page('Trang A')
    const ha = await contact('Nguyễn Thu Hà', [p])
    const vip = await contact('Lê Bình', [p])
    await handle.sql`update contacts set tags = ${['Khách quen']} where id = ${vip}`
    const ids = async (q: string) => {
      const res = await get(`/contacts?q=${encodeURIComponent(q)}`)
      expect(res.statusCode).toBe(200)
      return (res.json() as ListContactsResponse).items.map((c) => c.id)
    }
    expect(await ids('nguyen thu')).toEqual([ha])
    expect(await ids('khach QUEN')).toEqual([vip])
    expect(await ids('ngyen thu ha')).toEqual([])
  })
})

// ---------------------------------------------------------------------------------------------------------
// Helper thuần
// ---------------------------------------------------------------------------------------------------------

describe('searchTerms / phoneDigits', () => {
  it('NFC, gộp khoảng trắng, thoát ký tự đại diện, tối đa 8 từ; chữ số SĐT như `search_phone`', () => {
    expect(searchTerms('   ')).toBeNull()
    const nfd = 'Hà'.normalize('NFD')
    expect(searchTerms(`  ${nfd}   50%_x  `)).toEqual({ text: 'Hà 50%_x', tokens: ['Hà', '50\\%\\_x'], digits: '' })
    expect(searchTerms('a b c d e f g h i j')!.tokens).toHaveLength(8)
    expect(searchTerms('0912 345')!.digits).toBe('0912345')
    expect(phoneDigits('+84 912 345 678')).toBe('0912345678')
    expect(phoneDigits('84912')).toBe('84912')
  })
})
