// Ma trận Story 5.2 — Kho kiến thức. Qua app thật (buildApp) + Postgres nhúng + pg-boss (enqueue cùng transaction) +
// Cloudinary giả (không gọi mạng). Job `profiles.knowledge.extract` gọi thẳng handler với payload lấy từ `pgboss.job`;
// trích văn bản chạy thread thật (pdf.js của unpdf, docx, txt) — file mẫu dựng ở `helpers/files.ts`.
// Phủ: tải file (kiểm magic/kích thước/loại, kho chưa cấu hình, kho lỗi), trích xong / lỗi / hết giờ / tải về lỗi tạm /
// chạy lại, `too_large` (tự nó / khi cấu hình đang bật), FAQ (ready ngay, vượt khi bật), lưu bật + hàng loạt khi kho vượt,
// trang theo nhóm chỉ đọc, dùng riêng / bỏ riêng / rời / xoá nhóm kéo theo kho, xoá mục, chủ lạ.
import {
  AutoreplyConfigDto,
  BulkSetAutoreplyResponse,
  ErrorResponse,
  KNOWLEDGE_FILE_MAX_BYTES,
  KNOWLEDGE_MAX_TOKENS,
  KnowledgeItemDto,
  KnowledgeListResponse,
  defaultAutoreplyHours,
  type EventName,
  type EventPayload,
} from '@ottm/shared'
import type { FastifyInstance } from 'fastify'
import type { PgBoss } from 'pg-boss'
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest'
import { createFakeCloudinary, type FakeCloudinary } from '../src/adapters/media/fake.ts'
import { createMediaStores, type MediaStores } from '../src/adapters/media/index.ts'
import { buildApp } from '../src/app/app.ts'
import { SESSION_COOKIE } from '../src/app/auth/index.ts'
import {
  KnowledgeRetryableError,
  handleKnowledgeExtractJob,
  handleProfilesEvent,
  runExtraction,
  type KnowledgeExtractDeps,
} from '../src/modules/profiles/index.ts'
import { createSession } from '../src/modules/settings/index.ts'
import { createDb, newId, type DbHandle } from '../src/platform/db/index.ts'
import { createEventPublisher, type EventPublisher } from '../src/platform/events/index.ts'
import { createBoss, createJobSender, ensureQueues, type JobSender } from '../src/platform/jobs/index.ts'
import { createLogger } from '../src/platform/log/index.ts'
import { buildDocx, buildPdf, buildZip } from './helpers/files.ts'

const ORIGIN = 'http://localhost:5173'
const CREDS = { cloudName: 'demo-cloud', apiKey: '123456789012345', apiSecret: 'S3cr3t-KNOWLEDGE' }
const QUEUE = 'profiles.knowledge.extract'
const PDF = 'application/pdf'
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
const TXT = 'text/plain'

let handle: DbHandle
let boss: PgBoss
let realEvents: EventPublisher
let jobs: JobSender
let fake: FakeCloudinary
let media: MediaStores
let app: FastifyInstance
let cookie: string

const emitted: { name: EventName; payload: Record<string, unknown> }[] = []
const events: EventPublisher = {
  async publishEvent(tx, name, payload) {
    await realEvents.publishEvent(tx, name, payload)
    emitted.push({ name, payload: payload as Record<string, unknown> })
  },
}
const processedEvents = () => emitted.filter((e) => e.name === 'knowledge_item.processed').map((e) => e.payload)

async function cleanup() {
  await handle.sql`delete from knowledge_items`
  await handle.sql`delete from page_config_state`
  await handle.sql`delete from autoreply_configs`
  await handle.sql`update pages set group_id = null`
  await handle.sql`delete from pages`
  await handle.sql`delete from groups`
  await handle.sql`delete from pgboss.job where name = ${QUEUE}`
}

beforeAll(async () => {
  handle = createDb(inject('databaseUrl'), { max: 6 })
  boss = createBoss(inject('databaseUrl'), 'ottm-test-knowledge', { background: false })
  boss.on('error', () => {})
  await boss.start()
  await ensureQueues(boss)
  realEvents = createEventPublisher(boss)
  jobs = createJobSender(boss)
})
afterAll(async () => {
  await cleanup()
  await boss.stop({ graceful: false })
  await handle.close()
})
beforeEach(async () => {
  await cleanup()
  emitted.length = 0
  fake = createFakeCloudinary(CREDS)
  media = createMediaStores({ CLOUDINARY_URL: CREDS, CLOUDINARY_FOLDER: 'ottm-test' }, { fetch: fake.fetch })
  app = buildApp({ sql: handle.sql, db: handle.db, logger: createLogger({ level: 'silent' }), http: { allowedOrigins: [ORIGIN] }, media, jobs })
  cookie = `${SESSION_COOKIE}=${(await createSession(handle.db)).token}`
  return async () => {
    await app.close()
  }
})

/* ---------- Helper ---------- */

async function seedGroup(name = 'Nhóm Gia dụng'): Promise<string> {
  const [row] = await handle.sql<{ id: string }[]>`insert into groups (name, color) values (${name}, 'group-2') returning id`
  return row!.id
}
async function seedPage(groupId: string | null = null, name = 'Gia dụng Minh Phát'): Promise<string> {
  const [row] = await handle.sql<{ id: string }[]>`
    insert into pages (platform, platform_account_id, name, group_id) values ('facebook', ${newId()}, ${name}, ${groupId}) returning id`
  return row!.id
}

type Owner = ['group' | 'page', string]
const base = ([t, id]: Owner) => `/api/v1/knowledge-items/${t}/${id}`

function api(method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown) {
  return app.inject({
    method,
    url,
    headers: { cookie, ...(method === 'GET' ? {} : { origin: ORIGIN }) },
    ...(payload !== undefined ? { payload: payload as object } : {}),
  })
}

function upload(owner: Owner, data: Buffer, opts: { mime?: string; name?: string } = {}) {
  return app.inject({
    method: 'POST',
    url: `${base(owner)}/files`,
    headers: {
      cookie,
      origin: ORIGIN,
      'content-type': opts.mime ?? PDF,
      'x-file-name': encodeURIComponent(opts.name ?? 'Bảng giá.pdf'),
    },
    payload: data,
  })
}

async function uploadOk(owner: Owner, data: Buffer, opts: { mime?: string; name?: string } = {}): Promise<KnowledgeItemDto> {
  const res = await upload(owner, data, opts)
  expect(res.statusCode, res.body).toBe(201)
  return KnowledgeItemDto.parse(res.json())
}

async function addFaq(owner: Owner, question = 'Phí giao hàng?', answer = 'Nội thành miễn phí, tỉnh khác 30.000đ.') {
  return api('POST', `${base(owner)}/faqs`, { question, answer })
}

const list = async (owner: Owner) => {
  const res = await api('GET', base(owner))
  expect(res.statusCode, res.body).toBe(200)
  return KnowledgeListResponse.parse(res.json())
}

const CONFIG = {
  enabled: true,
  schedule: 'always',
  hours: defaultAutoreplyHours(),
  script: 'Bạn là nhân viên bán hàng của Gia dụng Minh Phát.',
  handoffKeywords: [],
  handoffOnCustomerAsk: true,
  handoffOnUncertain: true,
  handoffMessage: 'Shop sẽ kiểm tra và phản hồi ngay ạ',
  channels: ['messenger'],
}
const saveConfig = (owner: Owner, patch: Record<string, unknown> = {}) => api('PUT', `/api/v1/autoreply-configs/${owner[0]}/${owner[1]}`, { ...CONFIG, ...patch })

/** Mục `ready` lớn ghi thẳng DB (FAQ qua API tối đa ~2k token) để dồn kho gần/vượt giới hạn. */
async function seedReady(owner: Owner, tokens: number): Promise<void> {
  await handle.sql`
    insert into knowledge_items (owner_type, owner_id, kind, title, text, status, token_count)
    values (${owner[0]}, ${owner[1]}, 'faq', 'Bảng giá dài', 'nội dung', 'ready', ${tokens})`
}

const jobDataOf = async () =>
  (await handle.sql<{ data: { knowledgeItemId: string; filePublicId: string } }[]>`select data from pgboss.job where name = ${QUEUE} order by created_on`).map((r) => r.data)

const deps = (extra: Partial<KnowledgeExtractDeps> = {}): KnowledgeExtractDeps => ({ db: handle.db, events, media, ...extra })

/** Chạy job cho mục vừa tải lên (payload thật trong pgboss.job). */
async function runJob(item: KnowledgeItemDto, opts: { retryCount?: number; extra?: Partial<KnowledgeExtractDeps> } = {}) {
  const data = (await jobDataOf()).find((d) => d.knowledgeItemId === item.id)
  expect(data, 'job đã enqueue').toBeDefined()
  return handleKnowledgeExtractJob(deps(opts.extra), { data, retryCount: opts.retryCount ?? 0, retryLimit: 2 })
}

const rowOf = async (id: string) => (await handle.sql`select * from knowledge_items where id = ${id}`)[0]!
const privateAssets = () => [...fake.assets.values()].filter((a) => a.type === 'authenticated')

/* ---------- Tải file ---------- */

describe('tải file', () => {
  it('PDF hợp lệ → processing, file ở kho riêng tư (authenticated, raw), job enqueue cùng mục', async () => {
    const g = await seedGroup()
    const item = await uploadOk(['group', g], buildPdf(['Bang gia']))
    expect(item).toMatchObject({ kind: 'file', title: 'Bảng giá.pdf', status: 'processing', tokenCount: null, fileMime: PDF, answer: null })
    expect(privateAssets()).toHaveLength(1)
    expect(privateAssets()[0]!.resourceType).toBe('raw')
    const [job] = await jobDataOf()
    const row = await rowOf(item.id)
    expect(job).toEqual({ knowledgeItemId: item.id, filePublicId: row.file_public_id })
    expect((await list(['group', g])).items.map((i) => i.id)).toEqual([item.id])
  })

  it('sai loại / giả mạo / không khớp đuôi → 400 dưới ô file, không lưu, không tải lên', async () => {
    const g = await seedGroup()
    const exe = Buffer.concat([Buffer.from('MZ\x90\x00'), Buffer.alloc(64, 0)])
    const zipNoDoc = buildZip([{ name: 'xl/workbook.xml', data: '<workbook/>' }])
    const cases: [Buffer, string, string][] = [
      [exe, PDF, 'Chỉ nhận file PDF, DOCX hoặc TXT'],
      [zipNoDoc, DOCX, 'Chỉ nhận file PDF, DOCX hoặc TXT'],
      [Buffer.from('chỉ là chữ'), PDF, 'Định dạng file không khớp với đuôi file'],
    ]
    for (const [data, mime, message] of cases) {
      const res = await upload(['group', g], data, { mime })
      expect(res.statusCode, res.body).toBe(400)
      expect(ErrorResponse.parse(res.json()).error).toMatchObject({ code: 'VALIDATION_FAILED', details: [{ path: ['file'], message }] })
    }
    // Content-Type ngoài danh sách → Fastify 415 → VALIDATION_FAILED.
    const png = await upload(['group', g], Buffer.from('x'), { mime: 'image/png' })
    expect(png.statusCode).toBe(415)
    expect(png.json().error.code).toBe('VALIDATION_FAILED')
    expect(fake.assets.size).toBe(0)
    expect((await list(['group', g])).items).toEqual([])
  })

  it('rỗng / vượt 10 MB → 400 dưới ô file; quá giới hạn body → 413 VALIDATION_FAILED', async () => {
    const g = await seedGroup()
    for (const data of [Buffer.alloc(0), Buffer.alloc(KNOWLEDGE_FILE_MAX_BYTES + 1, 0x61)]) {
      const res = await upload(['group', g], data, { mime: TXT, name: 'a.txt' })
      expect(res.statusCode, res.body).toBe(400)
      expect(res.json().error.details).toEqual([{ path: ['file'], message: 'File tối đa 10 MB' }])
    }
    const huge = await upload(['group', g], Buffer.alloc(KNOWLEDGE_FILE_MAX_BYTES + 1024, 0x61), { mime: TXT })
    expect(huge.statusCode).toBe(413)
    expect(huge.json().error.code).toBe('VALIDATION_FAILED')
    expect(fake.assets.size).toBe(0)
  })

  it('thiếu tên file → 400; tên có đường dẫn được cắt về tên gốc', async () => {
    const g = await seedGroup()
    const res = await app.inject({ method: 'POST', url: `${base(['group', g])}/files`, headers: { cookie, origin: ORIGIN, 'content-type': TXT }, payload: Buffer.from('a') })
    expect(res.statusCode).toBe(400)
    expect(res.json().error.details).toEqual([{ path: ['file'], message: 'Thiếu tên file' }])
    const item = await uploadOk(['group', g], Buffer.from('Giá: 100k'), { mime: TXT, name: 'C:\\Users\\shop\\chính sách.txt' })
    expect(item.title).toBe('chính sách.txt')
  })

  it('chưa cấu hình Cloudinary → 500 MEDIA_NOT_CONFIGURED, không ghi mục', async () => {
    const g = await seedGroup()
    const bare = buildApp({ sql: handle.sql, db: handle.db, logger: createLogger({ level: 'silent' }), http: { allowedOrigins: [ORIGIN] }, jobs })
    const res = await bare.inject({
      method: 'POST',
      url: `${base(['group', g])}/files`,
      headers: { cookie, origin: ORIGIN, 'content-type': PDF, 'x-file-name': 'a.pdf' },
      payload: buildPdf(['x']),
    })
    await bare.close()
    expect(res.statusCode).toBe(500)
    expect(res.json().error.code).toBe('MEDIA_NOT_CONFIGURED')
    expect((await list(['group', g])).items).toEqual([])
  })

  it('kho lỗi khi tải lên → 502 UPLOAD_FAILED / 429 / 400 dưới ô file; không ghi mục', async () => {
    const g = await seedGroup()
    const expected: [number, number, string][] = [
      [503, 502, 'UPLOAD_FAILED'],
      [401, 502, 'UPLOAD_FAILED'],
      [429, 429, 'RATE_LIMITED'],
      [400, 400, 'VALIDATION_FAILED'],
    ]
    for (const [cloudinary, status, code] of expected) {
      fake.failNext(cloudinary)
      const res = await upload(['group', g], buildPdf(['x']))
      expect(res.statusCode, `${cloudinary}`).toBe(status)
      expect(res.json().error.code).toBe(code)
    }
    expect((await list(['group', g])).items).toEqual([])
    expect(await jobDataOf()).toEqual([])
  })
})

/* ---------- Job trích văn bản ---------- */

describe('job profiles.knowledge.extract', () => {
  it('pdf / docx / txt → ready kèm token, văn bản lưu DB, file gốc bị xoá, phát knowledge_item.processed', async () => {
    const g = await seedGroup()
    const pdf = await uploadOk(['group', g], buildPdf(['Bang gia', 'Noi chien 5L: 1.290.000d']))
    const docx = await uploadOk(['group', g], buildDocx(['Phí giao hàng: 30.000đ', ['Nồi chiên 5L', '1.290.000đ']]), { mime: DOCX, name: 'Chính sách.docx' })
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Đổi trả trong 7 ngày', 'utf16le')])
    const txt = await uploadOk(['group', g], utf16, { mime: TXT, name: 'đổi trả.txt' })
    expect(privateAssets()).toHaveLength(3)

    for (const item of [pdf, docx, txt]) expect(await runJob(item)).toBe('processed')

    const texts = new Map((await handle.sql<{ id: string; text: string }[]>`select id, text from knowledge_items`).map((r) => [r.id, r.text]))
    expect(texts.get(pdf.id)).toBe('Bang gia\nNoi chien 5L: 1.290.000d')
    expect(texts.get(docx.id)).toBe('Phí giao hàng: 30.000đ\nNồi chiên 5L | 1.290.000đ')
    expect(texts.get(txt.id)).toBe('Đổi trả trong 7 ngày')
    const l = await list(['group', g])
    for (const i of l.items) {
      expect(i.status).toBe('ready')
      expect(i.tokenCount).toBe(Math.ceil((i.title.length + texts.get(i.id)!.length) / 2))
      expect((await rowOf(i.id)).file_public_id).toBeNull()
    }
    expect(l.readyTokens).toBe(l.items.reduce((s, i) => s + i.tokenCount!, 0))
    expect(privateAssets()).toHaveLength(0)
    expect(processedEvents()).toEqual([pdf, docx, txt].map((i) => ({ id: i.id, ownerType: 'group', ownerId: g, status: 'ready' })))
  })

  it('pdf hỏng / có mật khẩu / không chữ → failed với lý do, không retry', async () => {
    const p = await seedPage(null)
    const cases: [Buffer, string][] = [
      [Buffer.from('%PDF-1.4 hỏng'), 'UNREADABLE'],
      [buildPdf([], { encrypt: true }), 'PASSWORD_PROTECTED'],
      [buildPdf([], { noText: true }), 'NO_TEXT'],
    ]
    for (const [data, code] of cases) {
      const item = await uploadOk(['page', p], data)
      expect(await runJob(item)).toBe('failed')
      expect((await list(['page', p])).items.find((i) => i.id === item.id)).toMatchObject({ status: 'failed', errorCode: code, tokenCount: null })
    }
    // Chủ là trang → sự kiện mang pageId cho realtime.
    expect(processedEvents().map((e) => [e.status, e.pageId])).toEqual([
      ['failed', p],
      ['failed', p],
      ['failed', p],
    ])
    expect(privateAssets()).toHaveLength(0)
  })

  it('thread vượt timeout → bị huỷ, failed EXTRACT_TIMEOUT', async () => {
    const g = await seedGroup()
    const item = await uploadOk(['group', g], buildPdf(['x']))
    const outcome = await runJob(item, { extra: { extract: (data, mime) => runExtraction(data, mime, { timeoutMs: 1 }) } })
    expect(outcome).toBe('failed')
    expect((await rowOf(item.id)).error_code).toBe('EXTRACT_TIMEOUT')
  })

  it('tải file về lỗi tạm: chưa phải lần cuối → ném để retry (giữ processing); lần cuối → failed FILE_UNAVAILABLE', async () => {
    const g = await seedGroup()
    const item = await uploadOk(['group', g], buildPdf(['x']))
    fake.failNext(503)
    await expect(runJob(item, { retryCount: 0 })).rejects.toBeInstanceOf(KnowledgeRetryableError)
    expect((await rowOf(item.id)).status).toBe('processing')
    fake.failNext(503)
    expect(await runJob(item, { retryCount: 2 })).toBe('failed')
    expect(await rowOf(item.id)).toMatchObject({ status: 'failed', error_code: 'FILE_UNAVAILABLE' })
  })

  it('chạy lại: mục đã xong → skipped, không phát lại; mục đã xoá → skipped và file không còn ai dùng bị xoá', async () => {
    const g = await seedGroup()
    const item = await uploadOk(['group', g], buildPdf(['x']))
    expect(await runJob(item)).toBe('processed')
    expect(await runJob(item)).toBe('skipped')
    expect(processedEvents()).toHaveLength(1)

    const other = await uploadOk(['group', g], buildPdf(['y']))
    // Mục bị xoá thẳng ở DB (vd kế thừa xoá kho) khi file còn trên kho.
    await handle.sql`delete from knowledge_items where id = ${other.id}`
    expect(privateAssets()).toHaveLength(1)
    expect(await runJob(other)).toBe('skipped')
    expect(privateAssets()).toHaveLength(0)
  })

  it('file tự nó vượt 40k token → too_large KNOWLEDGE_TOO_LARGE, giữ tokenCount, không lưu văn bản', async () => {
    const g = await seedGroup()
    const item = await uploadOk(['group', g], Buffer.from('a '.repeat(KNOWLEDGE_MAX_TOKENS + 10)), { mime: TXT, name: 'dài.txt' })
    await runJob(item)
    const got = (await list(['group', g])).items[0]!
    expect(got).toMatchObject({ status: 'too_large', errorCode: 'KNOWLEDGE_TOO_LARGE' })
    expect(got.tokenCount).toBeGreaterThan(KNOWLEDGE_MAX_TOKENS)
    expect((await rowOf(item.id)).text).toBeNull()
    expect((await list(['group', g])).readyTokens).toBe(0)
  })

  it('cấu hình đang bật: file làm tổng vượt → too_large; cấu hình tắt → ready (chặn ở lúc bật)', async () => {
    const g = await seedGroup()
    expect((await saveConfig(['group', g])).statusCode).toBe(200)
    await seedReady(['group', g], KNOWLEDGE_MAX_TOKENS - 5)
    const item = await uploadOk(['group', g], Buffer.from('Giá nồi chiên 1.290.000đ'), { mime: TXT, name: 'giá.txt' })
    await runJob(item)
    expect(await rowOf(item.id)).toMatchObject({ status: 'too_large', error_code: 'KNOWLEDGE_TOO_LARGE' })

    const g2 = await seedGroup('Nhóm 2')
    await seedReady(['group', g2], KNOWLEDGE_MAX_TOKENS - 5)
    const item2 = await uploadOk(['group', g2], Buffer.from('Giá nồi chiên 1.290.000đ'), { mime: TXT, name: 'giá.txt' })
    await runJob(item2)
    expect((await rowOf(item2.id)).status).toBe('ready')
    expect((await list(['group', g2])).readyTokens).toBeGreaterThan(KNOWLEDGE_MAX_TOKENS)
  })
})

/* ---------- FAQ + giới hạn khi lưu ---------- */

describe('FAQ và giới hạn token', () => {
  it('thêm FAQ → faq ready ngay, có tokenCount; thiếu câu trả lời → 400', async () => {
    const g = await seedGroup()
    const res = await addFaq(['group', g])
    expect(res.statusCode, res.body).toBe(201)
    const item = KnowledgeItemDto.parse(res.json())
    expect(item).toMatchObject({ kind: 'faq', title: 'Phí giao hàng?', answer: 'Nội thành miễn phí, tỉnh khác 30.000đ.', status: 'ready', errorCode: null })
    expect(item.tokenCount).toBe(Math.ceil(('Phí giao hàng?'.length + 'Nội thành miễn phí, tỉnh khác 30.000đ.'.length) / 2))
    expect(await jobDataOf()).toEqual([])

    const bad = await addFaq(['group', g], 'Phí giao hàng?', '  ')
    expect(bad.statusCode).toBe(400)
    expect(bad.json().error.code).toBe('VALIDATION_FAILED')
  })

  it('cấu hình đang bật mà FAQ làm vượt → 422 KNOWLEDGE_TOO_LARGE, không lưu', async () => {
    const g = await seedGroup()
    expect((await saveConfig(['group', g])).statusCode).toBe(200)
    await seedReady(['group', g], KNOWLEDGE_MAX_TOKENS - 3)
    const res = await addFaq(['group', g])
    expect(res.statusCode).toBe(422)
    expect(res.json().error).toMatchObject({ code: 'KNOWLEDGE_TOO_LARGE', details: { maxTokens: KNOWLEDGE_MAX_TOKENS } })
    expect((await list(['group', g])).items).toHaveLength(1)
  })

  it('lưu cấu hình BẬT khi kho vượt → 422 KNOWLEDGE_TOO_LARGE, cấu hình không đổi; lưu TẮT thì được', async () => {
    const g = await seedGroup()
    expect((await saveConfig(['group', g], { enabled: false })).statusCode).toBe(200)
    await seedReady(['group', g], KNOWLEDGE_MAX_TOKENS + 1)
    const on = await saveConfig(['group', g])
    expect(on.statusCode).toBe(422)
    expect(on.json().error.code).toBe('KNOWLEDGE_TOO_LARGE')
    const [cfg] = await handle.sql`select enabled from autoreply_configs where owner_id = ${g}`
    expect(cfg!.enabled).toBe(false)
    const off = await saveConfig(['group', g], { enabled: false, script: 'Kịch bản mới' })
    expect(off.statusCode).toBe(200)
    expect(AutoreplyConfigDto.parse(off.json()).script).toBe('Kịch bản mới')
  })

  it('bật hàng loạt: trang có kho hiệu lực vượt → failed KNOWLEDGE_TOO_LARGE (vẫn theo nhóm); trang khác vẫn bật', async () => {
    const g = await seedGroup()
    const p1 = await seedPage(g, 'Minh Phát')
    const p2 = await seedPage(null, 'Trang riêng')
    expect((await saveConfig(['group', g], { enabled: false })).statusCode).toBe(200)
    expect((await saveConfig(['page', p2], { enabled: false })).statusCode).toBe(200)
    await seedReady(['group', g], KNOWLEDGE_MAX_TOKENS + 1)
    const res = await api('POST', '/api/v1/autoreply-configs/bulk-enabled', { pageIds: [p1, p2], enabled: true })
    expect(res.statusCode, res.body).toBe(200)
    expect(BulkSetAutoreplyResponse.parse(res.json())).toEqual({ updated: [p2], unchanged: [], failed: [{ pageId: p1, code: 'KNOWLEDGE_TOO_LARGE' }] })
    const [state] = await handle.sql`select use_own from page_config_state where page_id = ${p1}`
    expect(state?.use_own ?? false).toBe(false)
  })
})

/* ---------- Kế thừa ---------- */

describe('kế thừa kho theo cấu hình AI', () => {
  it('trang đang theo nhóm: thêm FAQ / tải file / xoá mục → 400, không tải gì lên kho; đọc được kho của nhóm', async () => {
    const g = await seedGroup()
    const p = await seedPage(g)
    expect((await saveConfig(['group', g])).statusCode).toBe(200)
    expect((await addFaq(['group', g])).statusCode).toBe(201)

    const faq = await addFaq(['page', p])
    expect(faq.statusCode).toBe(400)
    expect(faq.json().error.details[0].path).toEqual(['owner'])
    expect((await upload(['page', p], buildPdf(['x']))).statusCode).toBe(400)
    expect(fake.assets.size).toBe(0)

    await seedReady(['page', p], 10)
    const [stray] = await handle.sql<{ id: string }[]>`select id from knowledge_items where owner_id = ${p}`
    expect((await api('DELETE', `/api/v1/knowledge-items/${stray!.id}`)).statusCode).toBe(400)
    expect((await list(['group', g])).items).toHaveLength(1)
  })

  it('lưu cấu hình riêng sao chép kho nhóm (kể cả file đang xử lý — job kết thúc cả bản sao); bỏ riêng xoá kho trang', async () => {
    const g = await seedGroup()
    const p = await seedPage(g)
    expect((await saveConfig(['group', g])).statusCode).toBe(200)
    expect((await addFaq(['group', g])).statusCode).toBe(201)
    const file = await uploadOk(['group', g], buildPdf(['Bang gia']))

    expect((await saveConfig(['page', p], { channels: ['messenger', 'ig_direct'] })).statusCode).toBe(200)
    const pageKb = await list(['page', p])
    expect(pageKb.items.map((i) => [i.kind, i.status])).toEqual([
      ['faq', 'ready'],
      ['file', 'processing'],
    ])
    // Trang dùng riêng thì ghi được kho của mình.
    expect((await addFaq(['page', p], 'Có ship COD không?', 'Có ạ.')).statusCode).toBe(201)

    expect(await runJob(file)).toBe('processed')
    expect((await list(['group', g])).items[1]!.status).toBe('ready')
    expect((await list(['page', p])).items[1]!.status).toBe('ready')
    expect(processedEvents().map((e) => e.ownerType).sort()).toEqual(['group', 'page'])
    expect(privateAssets()).toHaveLength(0)

    const off = await api('PUT', `/api/v1/autoreply-configs/use-own/page/${p}`, { useOwn: false })
    expect(off.statusCode).toBe(200)
    expect((await list(['page', p])).items).toEqual([])
    expect((await list(['group', g])).items).toHaveLength(2)
  })

  it('rời nhóm (chạy hai lần) giữ một bản sao kho; xoá nhóm xoá kho nhóm, trang giữ bản sao', async () => {
    const g = await seedGroup()
    const a = await seedPage(g, 'A')
    const b = await seedPage(g, 'B')
    expect((await saveConfig(['group', g])).statusCode).toBe(200)
    expect((await addFaq(['group', g])).statusCode).toBe(201)

    await handle.sql`update pages set group_id = null where id = ${a}`
    const changed = { event: 'page.group_changed' as const, payload: { id: a, pageId: a, fromGroupId: g, toGroupId: null } satisfies EventPayload<'page.group_changed'> }
    await handleProfilesEvent({ db: handle.db }, changed)
    await handleProfilesEvent({ db: handle.db }, changed)
    expect((await list(['page', a])).items.map((i) => i.title)).toEqual(['Phí giao hàng?'])

    await handle.sql`update pages set group_id = null where id = ${b}`
    await handleProfilesEvent({ db: handle.db }, { event: 'group.deleted', payload: { id: g, groupId: g, memberPageIds: [b] } satisfies EventPayload<'group.deleted'> })
    expect((await handle.sql`select 1 from knowledge_items where owner_type = 'group' and owner_id = ${g}`).length).toBe(0)
    expect((await list(['page', b])).items).toHaveLength(1)
  })
})

/* ---------- Xoá + chủ lạ ---------- */

describe('xoá mục và chủ lạ', () => {
  it('xoá FAQ → 204; xoá file đang xử lý → 204 và file bị xoá khỏi kho; id lạ → 404', async () => {
    const g = await seedGroup()
    const faq = KnowledgeItemDto.parse((await addFaq(['group', g])).json())
    const file = await uploadOk(['group', g], buildPdf(['x']))
    expect(privateAssets()).toHaveLength(1)

    expect((await api('DELETE', `/api/v1/knowledge-items/${faq.id}`)).statusCode).toBe(204)
    expect((await api('DELETE', `/api/v1/knowledge-items/${file.id}`)).statusCode).toBe(204)
    expect(privateAssets()).toHaveLength(0)
    expect((await list(['group', g])).items).toEqual([])

    const missing = await api('DELETE', `/api/v1/knowledge-items/${newId()}`)
    expect(missing.statusCode).toBe(404)
  })

  it('xoá bản gốc khi bản sao còn dùng file → giữ file; job vẫn kết thúc bản sao', async () => {
    const g = await seedGroup()
    const p = await seedPage(g)
    expect((await saveConfig(['group', g])).statusCode).toBe(200)
    const file = await uploadOk(['group', g], buildPdf(['Bang gia']))
    expect((await saveConfig(['page', p])).statusCode).toBe(200)
    expect((await api('DELETE', `/api/v1/knowledge-items/${file.id}`)).statusCode).toBe(204)
    expect(privateAssets()).toHaveLength(1)
    expect(await runJob(file)).toBe('processed')
    expect((await list(['page', p])).items[0]!.status).toBe('ready')
    expect(privateAssets()).toHaveLength(0)
  })

  it('chủ không tồn tại → 404 (đọc, thêm FAQ, tải file)', async () => {
    const ghost: Owner = ['group', newId()]
    expect((await api('GET', base(ghost))).statusCode).toBe(404)
    expect((await addFaq(ghost)).statusCode).toBe(404)
    const up = await upload(ghost, buildPdf(['x']))
    expect(up.statusCode).toBe(404)
    expect(fake.assets.size).toBe(0)
  })
})
