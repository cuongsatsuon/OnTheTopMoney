// Story 9.3 — dọn dữ liệu theo thời hạn (AD-22, AD-24, AD-1, AD-14), Postgres thật + Cloudinary giả:
// - `runRetention` (cron `privacy.retention`): payload thô webhook quá 30 ngày → null (giữ metadata), `autoreply_runs` quá
//   90 ngày, `ai_usage.ref` quá 90 ngày, phiên hết hạn; theo lô có trần, chạy lại không làm gì thêm; một bước lỗi không chặn
//   bước khác;
// - `sweepOrphanFiles` (cron `privacy.orphan_files`): chỉ file mồ côi ≥ 7 ngày tuổi trong prefix của app bị xoá (ảnh bài,
//   đính kèm, file kiến thức, logo còn tham chiếu thì giữ); sau khôi phục dump cũ; trần 100 file mỗi lượt; cầu dao + `force`;
//   chế độ `off` / `dry_run`; phân trang bằng con trỏ lưu ở `settings`; lỗi kho không ném; kho chưa cấu hình;
// - `webhook.route`: tin của khách đang chờ xoá (tới sau giai đoạn 1 của luồng xoá 9.2) bỏ payload thô ngay;
// - trang chính sách hiện đúng bảng thời hạn; khai báo cron giờ VN; log chỉ số đếm.
import { Writable } from 'node:stream'
import { RETENTION } from '@ottm/shared'
import type { PgBoss } from 'pg-boss'
import { v7 as uuidv7 } from 'uuid'
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest'
import { FAKE_PNG, createFakeCloudinary, type FakeCloudinary } from '../src/adapters/media/fake.ts'
import { createMediaStores, type MediaStores } from '../src/adapters/media/index.ts'
import type { AttachmentDownloadResult } from '../src/adapters/meta/index.ts'
import { policyHtml } from '../src/app/privacy-pages.ts'
import { fetchAttachment, ingestDm } from '../src/modules/inbox/index.ts'
import { createSession, getStateValue } from '../src/modules/settings/index.ts'
import { routeWebhookEvent } from '../src/modules/webhooks/index.ts'
import { ConfigError, parseEnv } from '../src/platform/config/index.ts'
import { createDb, type DbHandle } from '../src/platform/db/index.ts'
import { createEventPublisher, type EventPublisher } from '../src/platform/events/index.ts'
import { BOSS_SCHEMA, QUEUES, createBoss, createJobSender, ensureQueues, type JobSender } from '../src/platform/jobs/index.ts'
import { createLogger, type Logger } from '../src/platform/log/index.ts'
import {
  ORPHAN_CURSORS_KEY,
  RetentionStepsError,
  resolveSweepMode,
  runRetention,
  sweepOrphanFiles,
  type OrphanSweepDeps,
} from '../src/worker/retention.ts'

const CREDS = { cloudName: 'demo-cloud', apiKey: '123456789012345', apiSecret: 'S3cr3t-RETENTION' }
const FOLDER = 'ottm-test'
const DAY = 24 * 60 * 60_000
const NOW = new Date()
const ago = (days: number) => new Date(NOW.getTime() - days * DAY)

let handle: DbHandle
let boss: PgBoss
let events: EventPublisher
let jobs: JobSender
let fake: FakeCloudinary
let media: MediaStores
let logLines: string[] = []
let log: Logger

beforeAll(async () => {
  handle = createDb(inject('databaseUrl'), { max: 4 })
  boss = createBoss(inject('databaseUrl'), 'ottm-test-retention', { background: false })
  boss.on('error', () => {})
  await boss.start()
  await ensureQueues(boss)
  events = createEventPublisher(boss)
  jobs = createJobSender(boss)
  const sink = new Writable({
    write(chunk, _enc, cb) {
      logLines.push(String(chunk))
      cb()
    },
  })
  log = createLogger({ level: 'debug' }, sink)
})

async function cleanup() {
  await handle.sql`delete from webhook_events`
  await handle.sql`delete from autoreply_runs`
  await handle.sql`delete from ai_usage`
  await handle.sql`delete from sessions`
  await handle.sql`delete from media_assets`
  await handle.sql`delete from knowledge_items`
  await handle.sql`delete from brand_profiles`
  await handle.sql`delete from contacts`
  await handle.sql`delete from pages`
  await handle.sql`delete from settings where key = ${ORPHAN_CURSORS_KEY}`
  await handle.sql.unsafe(`delete from ${BOSS_SCHEMA}.job where name like 'inbox.%'`)
}

afterAll(async () => {
  await cleanup()
  await boss.stop({ graceful: false })
  await handle.close()
})
beforeEach(async () => {
  await cleanup()
  logLines = []
  fake = createFakeCloudinary(CREDS)
  media = createMediaStores({ CLOUDINARY_URL: CREDS, CLOUDINARY_FOLDER: FOLDER }, { fetch: fake.fetch })
})

const count = async (q: Promise<{ n: string | number }[]>) => Number((await q)[0]!.n)

// ---------------------------------------------------------------------------------------------------------
// Dọn DB theo hạn
// ---------------------------------------------------------------------------------------------------------

let seq = 0
async function webhookEvent(receivedAt: Date, status = 'routed', test = false): Promise<string> {
  seq += 1
  const [row] = await handle.sql<{ id: string }[]>`
    insert into webhook_events (product, platform_page_id, field, dedupe_key, payload, status, test, received_at)
    values ('meta', 'FB_R', 'messages', ${`r${seq}`}, ${JSON.stringify({ message: { text: `nội dung khách ${seq}` } })}::jsonb, ${status}, ${test}, ${receivedAt.toISOString()})
    returning id`
  return row!.id
}
async function autoreplyRun(startedAt: Date, finished = true) {
  const id = uuidv7()
  await handle.sql`
    insert into autoreply_runs (conversation_id, page_id, last_inbound_id, state_version, inbound_at, started_at, finished_at, outcome)
    values (${id}, ${id}, ${id}, 0, ${startedAt.toISOString()}, ${startedAt.toISOString()}, ${finished ? startedAt.toISOString() : null}, ${finished ? 'replied' : null})`
}
async function usage(createdAt: Date, ref: string | null = uuidv7()) {
  await handle.sql`
    insert into ai_usage (month, feature, model, ref, usd_micros, cost_vnd, created_at)
    values ('2026-10', 'autoreply', 'gpt-test', ${ref}, 10, 1, ${createdAt.toISOString()})`
}

describe('runRetention — dọn DB theo hạn', () => {
  it('payload webhook quá hạn → null giữ metadata; lượt AI, tham chiếu chi phí, phiên hết hạn; mốc còn hạn giữ nguyên', async () => {
    const oldRouted = await webhookEvent(ago(31))
    const oldFailed = await webhookEvent(ago(31), 'failed')
    const oldTest = await webhookEvent(ago(31), 'ignored', true)
    const fresh = await webhookEvent(ago(29))
    await autoreplyRun(ago(91))
    await autoreplyRun(ago(91), false)
    await autoreplyRun(ago(89))
    await usage(ago(91))
    await usage(ago(89))
    await createSession(handle.db)
    await handle.sql`insert into sessions (token_hash, expires_at) values ('hash-het-han', now() - interval '1 minute')`

    const result = await runRetention({ db: handle.db, now: () => NOW })
    expect(result).toMatchObject({
      webhookPayloads: { count: 3, done: true },
      autoreplyRuns: { count: 2, done: true },
      aiUsageRefs: { count: 1, done: true },
      sessions: 1,
      failed: [],
    })

    const rows = await handle.sql<{ id: string; payload: unknown; status: string; field: string; platform_page_id: string; dedupe_key: string }[]>`
      select id, payload, status, field, platform_page_id, dedupe_key from webhook_events`
    const byId = new Map(rows.map((r) => [r.id, r]))
    for (const id of [oldRouted, oldFailed, oldTest]) {
      expect(byId.get(id)).toMatchObject({ payload: null, field: 'messages', platform_page_id: 'FB_R' })
      expect(byId.get(id)!.dedupe_key).toMatch(/^r\d+$/)
    }
    expect(byId.get(oldFailed)!.status).toBe('failed')
    expect(byId.get(fresh)!.payload).not.toBeNull()
    expect(await count(handle.sql`select count(*) as n from autoreply_runs`)).toBe(1)
    expect(await count(handle.sql`select count(*) as n from ai_usage`)).toBe(2)
    expect(await count(handle.sql`select count(*) as n from ai_usage where ref is null`)).toBe(1)
    expect(await count(handle.sql`select count(*) as n from ai_usage where ref is null and created_at < ${ago(90).toISOString()}`)).toBe(1)
    expect(await count(handle.sql`select count(*) as n from sessions`)).toBe(1)
    expect(await count(handle.sql`select count(*) as n from sessions where expires_at <= now()`)).toBe(0)

    // Chạy lại: không còn gì để dọn.
    const again = await runRetention({ db: handle.db, now: () => NOW })
    expect([again.webhookPayloads.count, again.autoreplyRuns.count, again.aiUsageRefs.count, again.sessions]).toEqual([0, 0, 0, 0])
  })

  it('theo lô: lô 2 dọn hết 5 dòng mỗi bảng; trần 1 lô → làm dở (done=false), lượt sau làm tiếp', async () => {
    for (let i = 0; i < 5; i++) {
      await webhookEvent(ago(40))
      await autoreplyRun(ago(100))
      await usage(ago(100))
    }
    const partial = await runRetention({ db: handle.db, now: () => NOW, batch: { batchSize: 2, maxBatches: 1 } })
    expect(partial.webhookPayloads).toEqual({ count: 2, done: false })
    expect(partial.autoreplyRuns).toEqual({ count: 2, done: false })
    expect(partial.aiUsageRefs).toEqual({ count: 2, done: false })
    const rest = await runRetention({ db: handle.db, now: () => NOW, batch: { batchSize: 2 } })
    expect(rest.webhookPayloads).toEqual({ count: 3, done: true })
    expect(rest.autoreplyRuns).toEqual({ count: 3, done: true })
    expect(rest.aiUsageRefs).toEqual({ count: 3, done: true })
    expect(await count(handle.sql`select count(*) as n from webhook_events where payload is not null`)).toBe(0)
  })

  it('một bước lỗi: các bước khác vẫn chạy, cuối lượt ném RetentionStepsError', async () => {
    await webhookEvent(ago(31))
    await autoreplyRun(ago(91))
    await usage(ago(91))
    await handle.sql`alter table autoreply_runs rename to autoreply_runs_tam`
    try {
      const err = await runRetention({ db: handle.db, now: () => NOW, log }).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(RetentionStepsError)
      expect((err as RetentionStepsError).steps).toEqual(['autoreply'])
    } finally {
      await handle.sql`alter table autoreply_runs_tam rename to autoreply_runs`
    }
    expect(await count(handle.sql`select count(*) as n from webhook_events where payload is not null`)).toBe(0)
    expect(await count(handle.sql`select count(*) as n from ai_usage where ref is not null`)).toBe(0)
    expect(await count(handle.sql`select count(*) as n from autoreply_runs`)).toBe(1)
    expect(logLines.join('')).toContain('"step":"autoreply"')
    expect(logLines.join('')).not.toContain('nội dung khách')
  })
})

describe('webhook.route — tin của khách đang chờ xoá', () => {
  it('mục tới sau giai đoạn 1 của luồng xoá: routed nhưng bỏ payload thô ngay; khách khác giữ payload', async () => {
    await handle.sql`insert into pages (platform, platform_account_id, name) values ('facebook', 'FB_PEND', 'Trang')`
    const item = (sender: string, mid: string) => ({ sender: { id: sender }, recipient: { id: 'FB_PEND' }, timestamp: Date.now(), message: { mid, text: `nội dung khách ${mid}` } })
    const insert = async (payload: object, key: string) =>
      (await handle.sql<{ id: string }[]>`
        insert into webhook_events (product, platform_page_id, field, dedupe_key, payload)
        values ('meta', 'FB_PEND', 'messages', ${key}, ${JSON.stringify(payload)}::jsonb) returning id`)[0]!.id
    const deps = { db: handle.db, events, jobs }
    const first = await insert(item('u_pend', 'm_p1'), 'k_p1')
    expect(await routeWebhookEvent(deps, { eventId: first })).toBe('routed')
    await handle.sql`update contacts set deletion_requested_at = now()`
    const late = await insert(item('u_pend', 'm_p2'), 'k_p2')
    const other = await insert(item('u_khac', 'm_o1'), 'k_o1')
    expect(await routeWebhookEvent(deps, { eventId: late })).toBe('routed')
    expect(await routeWebhookEvent(deps, { eventId: other })).toBe('routed')
    const rows = await handle.sql<{ id: string; status: string; payload: unknown }[]>`select id, status, payload from webhook_events`
    const by = new Map(rows.map((r) => [r.id, r]))
    expect(by.get(late)).toMatchObject({ status: 'routed', payload: null })
    expect(by.get(first)!.payload).not.toBeNull()
    expect(by.get(other)!.payload).not.toBeNull()
  })
})

// ---------------------------------------------------------------------------------------------------------
// Dọn file mồ côi trên Cloudinary
// ---------------------------------------------------------------------------------------------------------

/** Đặt một file vào kho giả với tuổi cho trước (public_id uuidv7 như adapter tạo). */
function file(kind: 'public' | 'private_image' | 'private_raw', ageDays: number, publicId?: string): string {
  const id = publicId ?? `${FOLDER}/${kind === 'public' ? 'public' : 'private'}/${uuidv7()}`
  const resourceType = kind === 'private_raw' ? 'raw' : 'image'
  const type = kind === 'public' ? 'upload' : 'authenticated'
  fake.assets.set(`${resourceType}/${type}/${id}`, {
    publicId: id,
    resourceType,
    type,
    format: resourceType === 'image' ? 'png' : null,
    data: FAKE_PNG,
    width: 2,
    height: 2,
    version: 1,
    createdAt: ago(ageDays),
  })
  return id
}
const onKho = (id: string) => [...fake.assets.values()].some((a) => a.publicId === id)

async function mediaAssetRow(publicId: string) {
  await handle.sql`
    insert into media_assets (source, status, public_id, url, width, height, bytes, format)
    values ('upload', 'ready', ${publicId}, ${`https://res.cloudinary.com/demo-cloud/image/upload/v1/${publicId}.jpg`}, 1, 1, 1, 'jpg')`
}
async function bulkMediaAssets(ids: string[]) {
  await handle.sql`
    insert into media_assets (source, status, public_id, url, width, height, bytes, format)
    select 'upload', 'ready', id, 'https://res.cloudinary.com/x/' || id || '.jpg', 1, 1, 1, 'jpg' from unnest(${ids}::text[]) as id`
}
async function pageId(): Promise<string> {
  seq += 1
  const [p] = await handle.sql<{ id: string }[]>`insert into pages (platform, platform_account_id, name) values ('facebook', ${`FB_${seq}`}, 'Trang') returning id`
  return p!.id
}
/** Tin DM có ảnh đã lưu lên kho riêng tư qua adapter thật (đính kèm thật của `inbox`); trả public_id file. */
async function storedAttachment(page: string): Promise<string> {
  seq += 1
  const res = await ingestDm(
    { db: handle.db, events, jobs },
    {
      pageId: page,
      message: {
        kind: 'dm', senderId: `u${seq}`, recipientId: 'PAGE', mid: `m_r${seq}`, timestamp: new Date(), text: 'ảnh', attachments: [{ kind: 'image', url: `https://cdn.fbsbx.com/${seq}.png` }],
      },
    },
  )
  if (res.status !== 'created') throw new Error('ingest trùng')
  const [att] = await handle.sql<{ id: string }[]>`select id from message_attachments where message_id = ${res.messageId}`
  const download = async (): Promise<AttachmentDownloadResult> => ({ ok: true, data: FAKE_PNG, mime: 'image/png' })
  expect(await fetchAttachment({ db: handle.db, events, media, download }, att!.id, { finalAttempt: false })).toBe('stored')
  const [row] = await handle.sql<{ file_public_id: string }[]>`select file_public_id from message_attachments where id = ${att!.id}`
  return row!.file_public_id
}
const age = (publicId: string, days: number) => {
  for (const a of fake.assets.values()) if (a.publicId === publicId) a.createdAt = ago(days)
}

const sweep = (over: Partial<OrphanSweepDeps> = {}) => sweepOrphanFiles({ db: handle.db, media, mode: 'on', log, now: () => NOW, ...over })

describe('sweepOrphanFiles — file mồ côi trên Cloudinary', () => {
  it('chỉ xoá mồ côi ≥ 7 ngày trong prefix của app; ảnh bài, đính kèm, file kiến thức, logo còn tham chiếu thì giữ', async () => {
    const page = await pageId()
    const orphanPub = file('public', 30)
    const orphanImg = file('private_image', 8)
    const orphanRaw = file('private_raw', 365)
    const young = file('public', 2)
    const foreign = file('public', 90, 'thu-muc-khac/public/x')
    const sibling = file('public', 90, `${FOLDER}-2/public/y`)
    const post = file('public', 60)
    await mediaAssetRow(post)
    const logo = file('public', 60)
    await handle.sql`insert into brand_profiles (owner_type, owner_id, name, logo_path) values ('page', ${page}, 'Shop', ${`https://res.cloudinary.com/demo-cloud/image/upload/v9/${logo}.png`})`
    const knowledge = file('private_raw', 60)
    await handle.sql`
      insert into knowledge_items (owner_type, owner_id, kind, title, status, file_public_id, file_resource_type, file_mime)
      values ('page', ${page}, 'file', 'bang-gia.pdf', 'processing', ${knowledge}, 'raw', 'application/pdf')`
    const attachment = await storedAttachment(page)
    age(attachment, 60)

    const result = await sweep()
    expect(result).toMatchObject({ skipped: null, old: 7, orphans: 3, deleted: 3, fileErrors: 0, storeErrors: 0, tripped: false })
    for (const id of [orphanPub, orphanImg, orphanRaw]) expect(onKho(id)).toBe(false)
    for (const id of [young, foreign, sibling, post, logo, knowledge, attachment]) expect(onKho(id)).toBe(true)

    // Chạy lại: không còn mồ côi đủ tuổi.
    expect(await sweep()).toMatchObject({ orphans: 0, deleted: 0 })
    // Log chỉ số đếm: không public_id.
    expect(logLines.join('')).not.toContain(`${FOLDER}/`)
  })

  it('sau khôi phục dump cũ: file mà DB không còn dòng trỏ tới bị dọn khi đủ tuổi', async () => {
    const kept = file('public', 20)
    const lost = file('public', 20)
    await mediaAssetRow(kept)
    await mediaAssetRow(lost)
    expect(await sweep()).toMatchObject({ orphans: 0, deleted: 0 })
    // DB khôi phục từ bản dump trước lúc có `lost`.
    await handle.sql`delete from media_assets where public_id = ${lost}`
    expect(await sweep()).toMatchObject({ orphans: 1, deleted: 1 })
    expect(onKho(lost)).toBe(false)
    expect(onKho(kept)).toBe(true)
  })

  it('trần 100 file mỗi lượt: 130 mồ côi + 200 còn dùng → lượt 1 xoá 100, lượt 2 xoá 30', async () => {
    const used = Array.from({ length: 200 }, () => file('public', 30))
    await bulkMediaAssets(used)
    for (let i = 0; i < 130; i++) file('public', 30)
    expect(await sweep()).toMatchObject({ old: 330, orphans: 130, deleted: 100, tripped: false })
    expect(await sweep()).toMatchObject({ orphans: 30, deleted: 30 })
    expect(await sweep()).toMatchObject({ orphans: 0, deleted: 0 })
    expect(fake.assets.size).toBe(200)
  })

  it('cầu dao: 30 file cũ, 20 mồ côi → không xoá, con trỏ giữ, cảnh báo; force → xoá 20', async () => {
    await bulkMediaAssets(Array.from({ length: 10 }, () => file('public', 30)))
    for (let i = 0; i < 20; i++) file('private_raw', 30)
    const tripped = await sweep()
    expect(tripped).toMatchObject({ old: 30, orphans: 20, deleted: 0, tripped: true })
    expect(fake.assets.size).toBe(30)
    expect(await getStateValue(handle.db, ORPHAN_CURSORS_KEY)).toBeUndefined()
    expect(logLines.join('')).toContain('tỉ lệ file mồ côi bất thường')

    expect(await sweep({ mode: 'force' })).toMatchObject({ orphans: 20, deleted: 20, tripped: false })
    expect(fake.assets.size).toBe(10)
  })

  it('chế độ: off không gọi kho; dry_run đếm, không xoá, báo cáo theo loại; mặc định dry_run mọi môi trường', async () => {
    const orphan = file('public', 30)
    expect(await sweep({ mode: 'off' })).toMatchObject({ skipped: 'off', scanned: 0 })
    expect(fake.requests).toHaveLength(0)
    const dry = await sweep({ mode: 'dry_run' })
    expect(dry).toMatchObject({ skipped: null, orphans: 1, deleted: 0 })
    expect(onKho(orphan)).toBe(true)
    expect(fake.requests.every((r) => r.method === 'GET')).toBe(true)
    // Báo cáo dry_run (worker log nguyên `result`): số đếm + prefix theo loại để đối chiếu kho thật, không public_id đầy đủ.
    expect(dry.byKind).toEqual({
      public_image: { prefix: `${FOLDER}/public/`, scanned: 1, old: 1, orphans: 1 },
      private_image: { prefix: `${FOLDER}/private/`, scanned: 0, old: 0, orphans: 0 },
      private_raw: { prefix: `${FOLDER}/private/`, scanned: 0, old: 0, orphans: 0 },
    })
    expect(JSON.stringify(dry)).not.toContain(orphan)
    expect(logLines.join('')).not.toContain(orphan)

    // Review 9.3 (quyết định chủ dự án): không đặt env → dry_run ở mọi môi trường, kể cả production.
    expect(resolveSweepMode({})).toBe('dry_run')
    expect(resolveSweepMode({ MEDIA_ORPHAN_SWEEP: undefined })).toBe('dry_run')
    expect(resolveSweepMode({ MEDIA_ORPHAN_SWEEP: 'on' })).toBe('on')
    expect(resolveSweepMode({ MEDIA_ORPHAN_SWEEP: 'force' })).toBe('force')
    const db = { DATABASE_URL: 'postgres://u:p@localhost:5432/db' }
    expect(parseEnv({ ...db, MEDIA_ORPHAN_SWEEP: 'dry_run' }).MEDIA_ORPHAN_SWEEP).toBe('dry_run')
    expect(parseEnv({ ...db, MEDIA_ORPHAN_SWEEP: '' }).MEDIA_ORPHAN_SWEEP).toBeUndefined()
    expect(() => parseEnv({ ...db, MEDIA_ORPHAN_SWEEP: 'xoa-het' })).toThrow(ConfigError)
  })

  it('phân trang: trần 1 trang × 2 file → mỗi lượt đi một trang, con trỏ lưu ở settings, hết thì quay về đầu', async () => {
    await bulkMediaAssets(Array.from({ length: 5 }, () => file('public', 30)))
    const limits = { pageSize: 2, maxPages: 1 }
    const cursorOf = async () => ((await getStateValue(handle.db, ORPHAN_CURSORS_KEY)) as Record<string, string | null>).public_image
    expect(await sweep({ limits })).toMatchObject({ scanned: 2 })
    const c1 = await cursorOf()
    expect(typeof c1).toBe('string')
    expect(await sweep({ limits })).toMatchObject({ scanned: 2 })
    const c2 = await cursorOf()
    expect(c2).not.toBe(c1)
    expect(await sweep({ limits })).toMatchObject({ scanned: 1 })
    expect(await cursorOf()).toBeNull()
    expect(await sweep({ limits })).toMatchObject({ scanned: 2 })
  })

  it('kho lỗi: liệt kê RATE_LIMITED → loại đó dừng, loại khác vẫn chạy, không ném; xoá lỗi tạm → giữ để lượt sau', async () => {
    const pub = file('public', 30)
    const raw = file('private_raw', 30)
    fake.failNext(420) // lời gọi đầu: liệt kê public_image
    expect(await sweep()).toMatchObject({ storeErrors: 1, orphans: 1, deleted: 1 })
    expect(onKho(pub)).toBe(true)
    expect(onKho(raw)).toBe(false)
    expect(logLines.join('')).toContain('"error":"RATE_LIMITED"')

    // Xoá lỗi tạm (destroy 503) → dừng lượt, file còn, con trỏ giữ; lượt sau xoá được.
    let failed = false
    const failFirstDestroy = (async (input: string | URL | Request, init?: RequestInit) => {
      if ((init?.method ?? 'GET').toUpperCase() === 'POST' && !failed) {
        failed = true
        return new Response('{"error":{"message":"tạm"}}', { status: 503 })
      }
      return fake.fetch(input, init)
    }) as typeof fetch
    const flaky = createMediaStores({ CLOUDINARY_URL: CREDS, CLOUDINARY_FOLDER: FOLDER }, { fetch: failFirstDestroy })
    expect(await sweepOrphanFiles({ db: handle.db, media: flaky, mode: 'on', now: () => NOW })).toMatchObject({ deleted: 0, fileErrors: 1 })
    expect(onKho(pub)).toBe(true)
    expect(await sweep()).toMatchObject({ deleted: 1, fileErrors: 0 })
    expect(onKho(pub)).toBe(false)
  })

  it('kho chưa cấu hình → bỏ qua, không lỗi', async () => {
    const none = createMediaStores({ CLOUDINARY_FOLDER: FOLDER })
    expect(await sweep({ media: none })).toMatchObject({ skipped: 'not_configured', deleted: 0 })
  })
})

// ---------------------------------------------------------------------------------------------------------
// Khai báo + trang chính sách
// ---------------------------------------------------------------------------------------------------------

describe('khai báo cron + trang chính sách', () => {
  it('hai cron giờ VN, standard, retry 1, concurrency 1', () => {
    for (const name of ['privacy.retention', 'privacy.orphan_files'] as const) {
      expect(QUEUES[name]).toMatchObject({ policy: 'standard', retryLimit: 1, concurrency: 1, cron: { tz: 'Asia/Ho_Chi_Minh' } })
    }
    expect(QUEUES['privacy.retention'].cron.expression).toBe('30 3 * * *')
    expect(QUEUES['privacy.orphan_files'].cron.expression).toBe('0 5 * * *')
  })

  it('mục "Thời gian lưu trữ" hiện đúng bảng RETENTION', () => {
    const html = policyHtml({})
    const section = html.slice(html.indexOf('5. Thời gian lưu trữ'), html.indexOf('6. Bảo mật'))
    expect(section).toContain(`Bản sao sự kiện Meta gửi tới: ${RETENTION.webhookPayloadDays} ngày`)
    expect(section).toContain(`Nhật ký các lượt AI trả lời: ${RETENTION.autoreplyRunDays} ngày`)
    expect(section).toContain(`sau ${RETENTION.aiUsageRefDays} ngày`)
    expect(section).toContain(`${RETENTION.jobDays} ngày sau khi tác vụ kết thúc`)
    expect(section).toContain(`tối đa ${RETENTION.removedPageDays} ngày sau khi trang được gỡ`)
    expect(section).toContain(`ít nhất ${RETENTION.orphanFileMinAgeDays} ngày`)
  })
})
