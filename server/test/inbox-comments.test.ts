// Story 4.4 — bình luận Facebook/Instagram và trả lời Threads vào Hộp thư: `webhook.route` → chuẩn hoá bình luận →
// `inbox.ingestComment` (hội thoại `comment` theo bình luận gốc, `platform_post_id` chuẩn, người trả lời khác trong luồng,
// chống trùng, triage), sửa/xoá/ẩn/bỏ ẩn (`updateMessageText`/`markMessageRemoved`/`markMessageUnhidden`, không tạo tin
// mới), mục chỉ lưu (`ignored`), caption bài (`inbox.fetch_post_text`) và DTO API.
import { createHmac, randomBytes } from 'node:crypto'
import { ConversationDto, ListMessagesResponse, type EventName } from '@ottm/shared'
import type { FastifyInstance } from 'fastify'
import type { PgBoss } from 'pg-boss'
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest'
import { buildApp } from '../src/app/app.ts'
import { SESSION_COOKIE } from '../src/app/auth/index.ts'
import { createSecretCipher } from '../src/adapters/crypto/index.ts'
import { createFakeMetaClient } from '../src/adapters/meta/fake.ts'
import { handleTriageEvent } from '../src/modules/autoreply/index.ts'
import { PostTextRetryableError, fetchPostText, handleFetchPostTextJob, postTextFromGraph } from '../src/modules/inbox/index.ts'
import { setRemoved, upsertFromPlatform } from '../src/modules/pages/index.ts'
import { createSession } from '../src/modules/settings/index.ts'
import { ingestWebhook, routeWebhookEvent, webhookEventsTable } from '../src/modules/webhooks/index.ts'
import { createDb, type DbHandle } from '../src/platform/db/index.ts'
import { createEventPublisher, type EventEnvelope, type EventPublisher } from '../src/platform/events/index.ts'
import { createBoss, createJobSender, ensureQueues, type JobSender } from '../src/platform/jobs/index.ts'
import { createLogger } from '../src/platform/log/index.ts'

const cipher = createSecretCipher({ keys: new Map([['k1', randomBytes(32)]]), activeKeyId: 'k1' })
const T0 = 1_792_000_000 // giây epoch (FB `created_time`)

let handle: DbHandle
let boss: PgBoss
let realEvents: EventPublisher
let jobs: JobSender
let app: FastifyInstance

const emitted: { name: EventName; payload: Record<string, unknown> }[] = []
const events: EventPublisher = {
  async publishEvent(tx, name, payload) {
    await realEvents.publishEvent(tx, name, payload)
    emitted.push({ name, payload: payload as Record<string, unknown> })
  },
}
const emittedOf = (name: EventName) => emitted.filter((e) => e.name === name)

beforeAll(async () => {
  handle = createDb(inject('databaseUrl'), { max: 4 })
  boss = createBoss(inject('databaseUrl'), 'ottm-test-inbox-comments', { background: false })
  boss.on('error', () => {})
  await boss.start()
  await ensureQueues(boss)
  realEvents = createEventPublisher(boss)
  jobs = createJobSender(boss)
  app = buildApp({ sql: handle.sql, db: handle.db, logger: createLogger({ level: 'silent' }) })
  await app.ready()
})
afterAll(async () => {
  await app.close()
  await boss.stop({ graceful: false })
  await handle.close()
})
beforeEach(async () => {
  await handle.sql`delete from webhook_events`
  await handle.sql`delete from page_credentials`
  await handle.sql`delete from pages`
  await handle.sql`delete from contacts`
  await handle.sql`delete from sessions`
  await handle.sql`delete from pgboss.job where name in ('inbox.fetch_attachment', 'inbox.fetch_profile', 'inbox.fetch_post_text', 'webhook.route')`
  emitted.length = 0
})

// ---------------------------------------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------------------------------------

async function page(platform: 'facebook' | 'instagram' | 'threads', accountId: string, pageHandle: string | null = null): Promise<string> {
  const { page: p } = await upsertFromPlatform(handle.db, { platform, platformAccountId: accountId, name: `Trang ${accountId}`, handle: pageHandle, avatarUrl: null })
  await handle.sql`insert into page_credentials (page_id, access_token) values (${p.id}, ${cipher.encrypt(`TOKEN_${accountId}`)})`
  return p.id
}

/** Ghi một mục webhook rồi chạy `webhook.route` như worker. */
async function deliver(pageAccount: string, payload: unknown, field: string, product: 'meta' | 'threads' = 'meta') {
  const [row] = await handle.db
    .insert(webhookEventsTable)
    .values({ product, platformPageId: pageAccount, field, dedupeKey: `k_${Math.random().toString(36).slice(2)}`, payload })
    .returning({ id: webhookEventsTable.id })
  await routeWebhookEvent({ db: handle.db, events, jobs }, { eventId: row!.id })
  const [ev] = await handle.sql<{ status: string }[]>`select status from webhook_events where id = ${row!.id}`
  return ev!.status
}

let seq = 0
const fbComment = (pageAccount: string, v: Record<string, unknown> = {}) => {
  seq += 1
  return {
    field: 'feed',
    value: {
      item: 'comment',
      verb: 'add',
      comment_id: `POST1_c${seq}`,
      post_id: `${pageAccount}_POST1`,
      parent_id: `${pageAccount}_POST1`,
      from: { id: 'U_HA', name: 'Nguyễn Thu Hà' },
      message: `bình luận ${seq}`,
      created_time: T0 + seq,
      ...v,
    },
  }
}
const fb = (pageAccount: string, v: Record<string, unknown> = {}) => deliver(pageAccount, fbComment(pageAccount, v), 'feed')
const igComment = (v: Record<string, unknown> = {}) => {
  seq += 1
  return { field: 'comments', value: { id: `igc_${seq}`, text: `ig ${seq}`, from: { id: 'IGU_1', username: 'thuha' }, media: { id: 'media_1' }, ...v } }
}
const threadsReply = (v: Record<string, unknown> = {}) => {
  seq += 1
  return {
    field: 'replies',
    value: {
      id: `r_${seq}`,
      username: 'khach.threads',
      text: `threads ${seq}`,
      timestamp: '2026-10-23T03:00:00+0000',
      replied_to: { id: 'tpost_1' },
      root_post: { id: 'tpost_1', owner_id: 'TH_1', username: 'shop.threads' },
      ...v,
    },
  }
}

let triaged = 0
async function runTriage() {
  const received = emittedOf('message.received').slice(triaged)
  triaged = emittedOf('message.received').length
  for (const e of received) {
    const envelope: EventEnvelope = { event: 'message.received', payload: e.payload as never }
    await handleTriageEvent({ db: handle.db, events, jobs, cipher: null }, envelope)
  }
}
beforeEach(() => {
  triaged = 0
})

const conversationsRows = () =>
  handle.sql<{ id: string; page_id: string; channel: string; thread_key: string; platform_post_id: string | null; state: string; contact_identity_id: string }[]>`
    select id, page_id, channel, thread_key, platform_post_id, state, contact_identity_id from conversations order by created_at`
const messagesRows = () =>
  handle.sql<{ id: string; conversation_id: string; text: string | null; origin: string; platform_message_id: string | null; edited_at: Date | null; removal: string | null; removed_at: Date | null; sender_identity_id: string | null }[]>`
    select id, conversation_id, text, origin, platform_message_id, edited_at, removal, removed_at, sender_identity_id from messages order by platform_timestamp, id`
const jobsOf = (name: string) => handle.sql<{ data: Record<string, string> }[]>`select data from pgboss.job where name = ${name} order by created_on`
const count = async (table: string) => (await handle.sql.unsafe<{ n: number }[]>(`select count(*)::int as n from ${table}`))[0]!.n
async function cookie() {
  const { token } = await createSession(handle.db)
  return `${SESSION_COOKIE}=${token}`
}

// ---------------------------------------------------------------------------------------------------------
// Ingest bình luận
// ---------------------------------------------------------------------------------------------------------

describe('bình luận vào Hộp thư', () => {
  it('bình luận FB mới → hội thoại comment theo bình luận gốc, platform_post_id chuẩn, tên từ payload, triage, job caption', async () => {
    const pageId = await page('facebook', 'FB_1')
    expect(await fb('FB_1', { comment_id: 'POST1_root', post_id: 'POST1', parent_id: 'POST1' })).toBe('routed')

    const [conv] = await conversationsRows()
    expect(conv).toMatchObject({ page_id: pageId, channel: 'comment', thread_key: 'POST1_root', platform_post_id: 'FB_1_POST1', state: 'triage' })
    const [msg] = await messagesRows()
    expect(msg).toMatchObject({ origin: 'customer', platform_message_id: 'POST1_root', sender_identity_id: conv!.contact_identity_id })
    const [contact] = await handle.sql<{ name: string | null }[]>`select name from contacts`
    expect(contact!.name).toBe('Nguyễn Thu Hà')
    expect(emittedOf('message.received')).toHaveLength(1)
    expect(await jobsOf('inbox.fetch_profile')).toHaveLength(0)
    expect((await jobsOf('inbox.fetch_post_text')).map((j) => j.data)).toEqual([{ conversationId: conv!.id }])

    await runTriage()
    const [after] = await conversationsRows()
    expect(after!.state).toBe('human')
    expect(emittedOf('conversation.state_changed')[0]!.payload).toMatchObject({ to: 'human', reasonCode: 'CONFIG_MISSING' })
  })

  it('trả lời trong luồng → cùng hội thoại; người khác trả lời → khách riêng, khách của hội thoại không đổi', async () => {
    await page('facebook', 'FB_2')
    await fb('FB_2', { comment_id: 'P_root' })
    await fb('FB_2', { comment_id: 'P_r1', parent_id: 'P_root' })
    await fb('FB_2', { comment_id: 'P_r2', parent_id: 'P_root', from: { id: 'U_OTHER', name: 'Trần Văn B' } })

    const convs = await conversationsRows()
    expect(convs).toHaveLength(1)
    const msgs = await messagesRows()
    expect(msgs.map((m) => m.platform_message_id)).toEqual(['P_root', 'P_r1', 'P_r2'])
    expect(msgs[0]!.sender_identity_id).toBe(convs[0]!.contact_identity_id)
    expect(msgs[1]!.sender_identity_id).toBe(convs[0]!.contact_identity_id)
    expect(msgs[2]!.sender_identity_id).not.toBe(convs[0]!.contact_identity_id)
    expect(await count('contacts')).toBe(2)
    // Hội thoại đã có → không thêm job caption.
    expect(await jobsOf('inbox.fetch_post_text')).toHaveLength(1)

    const c = await cookie()
    const conv = ConversationDto.parse((await app.inject({ method: 'GET', url: `/api/v1/conversations/${convs[0]!.id}`, headers: { cookie: c } })).json())
    expect(conv.contact.name).toBe('Nguyễn Thu Hà')
    expect(conv.post).toEqual({ platformPostId: 'FB_2_POST1', text: null })
    const list = ListMessagesResponse.parse((await app.inject({ method: 'GET', url: `/api/v1/conversations/${conv.id}/messages`, headers: { cookie: c } })).json())
    expect(list.items.map((m) => m.sender?.name)).toEqual(['Nguyễn Thu Hà', 'Nguyễn Thu Hà', 'Trần Văn B'])
    expect(list.items[2]!.sender!.contactId).not.toBe(conv.contact.id)
    expect(list.items[0]).toMatchObject({ editedAt: null, removal: null })
  })

  it('bình luận IG → trang IG, id bài = media id; hai bình luận cùng bài → hai hội thoại; trả lời → hội thoại của bình luận gốc', async () => {
    const igPage = await page('instagram', 'IG_1', 'shop.ig')
    expect(await deliver('IG_1', igComment({ id: 'igc_a' }), 'comments')).toBe('routed')
    expect(await deliver('IG_1', igComment({ id: 'igc_b', from: { id: 'IGU_2', username: 'khach2' } }), 'comments')).toBe('routed')
    expect(await deliver('IG_1', igComment({ id: 'igc_c', parent_id: 'igc_a' }), 'comments')).toBe('routed')

    const convs = await conversationsRows()
    expect(convs.map((c) => [c.page_id, c.thread_key, c.platform_post_id])).toEqual([
      [igPage, 'igc_a', 'media_1'],
      [igPage, 'igc_b', 'media_1'],
    ])
    const names = await handle.sql<{ name: string }[]>`select name from contacts order by created_at`
    expect(names.map((n) => n.name)).toEqual(['@thuha', '@khach2'])
    expect((await messagesRows()).filter((m) => m.conversation_id === convs[0]!.id)).toHaveLength(2)
  })

  it('trả lời Threads (dạng `values`, qua cổng webhook) → hội thoại comment trên trang Threads; trả lời lồng → cùng hội thoại', async () => {
    const thPage = await page('threads', 'TH_1', 'shop.threads')
    const secret = 'threads-secret'
    const send = async (change: ReturnType<typeof threadsReply>) => {
      const raw = Buffer.from(JSON.stringify({ app_id: 'A', topic: 'moderate', target_id: 'TH_TARGET', time: 1, values: change }))
      const signature = `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`
      expect(await ingestWebhook({ db: handle.db, jobs }, { product: 'threads', rawBody: raw, signature, appSecret: secret })).toMatchObject({ ok: true, accepted: 1 })
      const [row] = await handle.sql<{ id: string }[]>`select id from webhook_events where dedupe_key = ${`replies:${change.value.id}`}`
      return routeWebhookEvent({ db: handle.db, events, jobs }, { eventId: row!.id })
    }
    expect(await send(threadsReply({ id: 'r_root' }))).toBe('routed')
    expect(await send(threadsReply({ id: 'r_child', replied_to: { id: 'r_root' }, username: 'nguoi.khac' }))).toBe('routed')
    expect(await send(threadsReply({ id: 'r_grand', replied_to: { id: 'r_child' } }))).toBe('routed')

    const convs = await conversationsRows()
    expect(convs).toHaveLength(1)
    expect(convs[0]).toMatchObject({ page_id: thPage, channel: 'comment', thread_key: 'r_root', platform_post_id: 'tpost_1' })
    expect((await messagesRows()).map((m) => m.platform_message_id)).toEqual(['r_root', 'r_child', 'r_grand'])
    const ids = await handle.sql<{ platform_user_id: string }[]>`select platform_user_id from contact_identities order by created_at`
    expect(ids.map((i) => i.platform_user_id)).toEqual(['@khach.threads', '@nguoi.khac'])
  })

  it('trùng (route chạy lại / Meta gửi lại) → một tin, không sự kiện mới', async () => {
    await page('facebook', 'FB_D')
    const item = fbComment('FB_D', { comment_id: 'P_dup' })
    expect(await deliver('FB_D', item, 'feed')).toBe('routed')
    expect(await deliver('FB_D', item, 'feed')).toBe('routed')
    expect(await count('messages')).toBe(1)
    expect(emittedOf('message.received')).toHaveLength(1)
  })

  it('hội thoại đã xong → bình luận mới mở lại (triage → human)', async () => {
    await page('facebook', 'FB_DONE')
    await fb('FB_DONE', { comment_id: 'P_x' })
    await runTriage()
    await handle.sql`update conversations set state = 'done', waiting_since = null`
    await fb('FB_DONE', { comment_id: 'P_x2', parent_id: 'P_x' })
    expect((await conversationsRows())[0]!.state).toBe('triage')
    await runTriage()
    expect((await conversationsRows())[0]!.state).toBe('human')
  })
})

// ---------------------------------------------------------------------------------------------------------
// Sửa / xoá / ẩn
// ---------------------------------------------------------------------------------------------------------

describe('sửa / xoá / ẩn bình luận', () => {
  it('edited → cùng tin đổi text + edited_at, message.updated, không tin mới; lặp lại → không sự kiện', async () => {
    await page('facebook', 'FB_E')
    await fb('FB_E', { comment_id: 'P_e' })
    emitted.length = 0
    expect(await fb('FB_E', { comment_id: 'P_e', verb: 'edited', message: 'Đã sửa nội dung' })).toBe('routed')
    const [msg] = await messagesRows()
    expect(msg).toMatchObject({ text: 'Đã sửa nội dung', platform_message_id: 'P_e' })
    expect(msg!.edited_at).not.toBeNull()
    expect(await count('messages')).toBe(1)
    expect(emittedOf('message.updated').map((e) => e.payload)).toEqual([{ id: msg!.id, pageId: expect.any(String), conversationId: msg!.conversation_id }])
    expect(emittedOf('message.received')).toHaveLength(0)

    expect(await fb('FB_E', { comment_id: 'P_e', verb: 'edited', message: 'Đã sửa nội dung' })).toBe('routed')
    expect(emittedOf('message.updated')).toHaveLength(1)
  })

  it('remove → deleted; hide sau remove không đổi; hide/unhide trên tin khác', async () => {
    await page('facebook', 'FB_R')
    await fb('FB_R', { comment_id: 'P_del' })
    await fb('FB_R', { comment_id: 'P_hid', parent_id: 'P_del' })
    emitted.length = 0

    expect(await fb('FB_R', { comment_id: 'P_del', verb: 'remove' })).toBe('routed')
    expect(await fb('FB_R', { comment_id: 'P_del', verb: 'hide' })).toBe('routed')
    expect(await fb('FB_R', { comment_id: 'P_hid', verb: 'hide' })).toBe('routed')
    let [del, hid] = await messagesRows()
    // Nội dung vẫn giữ để chủ shop biết khách đã viết gì.
    expect(del).toMatchObject({ removal: 'deleted', text: expect.stringMatching(/^bình luận \d+$/) })
    expect(del!.removed_at).not.toBeNull()
    expect(hid!.removal).toBe('hidden')
    expect(emittedOf('message.updated')).toHaveLength(2)

    expect(await fb('FB_R', { comment_id: 'P_hid', verb: 'unhide' })).toBe('routed')
    expect(await fb('FB_R', { comment_id: 'P_del', verb: 'unhide' })).toBe('routed')
    ;[del, hid] = await messagesRows()
    expect(hid).toMatchObject({ removal: null, removed_at: null })
    expect(del!.removal).toBe('deleted')
    expect(emittedOf('message.updated')).toHaveLength(3)
    expect(await count('messages')).toBe(2)

    const c = await cookie()
    const list = ListMessagesResponse.parse((await app.inject({ method: 'GET', url: `/api/v1/conversations/${del!.conversation_id}/messages`, headers: { cookie: c } })).json())
    expect(list.items.map((m) => m.removal)).toEqual(['deleted', null])
  })

  it('sửa / xoá tin chưa có → ignored, không tạo gì', async () => {
    await page('facebook', 'FB_M')
    expect(await fb('FB_M', { comment_id: 'P_none', verb: 'edited', message: 'x' })).toBe('ignored')
    expect(await fb('FB_M', { comment_id: 'P_none', verb: 'remove' })).toBe('ignored')
    expect(await fb('FB_M', { comment_id: 'P_none', verb: 'unhide' })).toBe('ignored')
    expect(await count('messages')).toBe(0)
    expect(await count('conversations')).toBe(0)
  })
})

// ---------------------------------------------------------------------------------------------------------
// Chỉ lưu (ignored)
// ---------------------------------------------------------------------------------------------------------

describe('mục chỉ lưu', () => {
  it.each([
    ['bình luận của chính trang FB', 'FB_I', 'feed', (acc: string) => fbComment(acc, { from: { id: acc, name: 'Shop' } }), 'meta'],
    ['reaction', 'FB_I', 'feed', (acc: string) => ({ field: 'feed', value: { item: 'reaction', verb: 'add', post_id: `${acc}_P`, reaction_type: 'like', from: { id: 'U' } } }), 'meta'],
    ['bài mới (status)', 'FB_I', 'feed', (acc: string) => ({ field: 'feed', value: { item: 'status', verb: 'add', post_id: `${acc}_P` } }), 'meta'],
    ['postback', 'FB_I', 'messaging_postbacks', (acc: string) => ({ sender: { id: 'U' }, recipient: { id: acc }, postback: { payload: 'P' } }), 'meta'],
    ['echo', 'FB_I', 'message_echoes', (acc: string) => ({ sender: { id: acc }, recipient: { id: 'U' }, message: { mid: 'm_e', is_echo: true, text: 'x' } }), 'meta'],
    ['mentions', 'FB_I', 'mentions', () => ({ field: 'mentions', value: { media_id: 'M' } }), 'meta'],
    ['trả lời Threads của chính trang', 'TH_I', 'replies', () => threadsReply({ username: 'Shop.Threads', root_post: { id: 'tp', owner_id: 'TH_I' } }), 'threads'],
  ] as const)('%s → ignored, không tạo hội thoại', async (_name, acc, field, payload, product) => {
    if (product === 'threads') await page('threads', acc, 'shop.threads')
    else await page('facebook', acc)
    expect(await deliver(acc, payload(acc), field, product)).toBe('ignored')
    expect(await count('conversations')).toBe(0)
    expect(emittedOf('message.received')).toHaveLength(0)
  })

  it('trang không có / đã gỡ → ignored', async () => {
    expect(await fb('FB_NONE')).toBe('ignored')
    const gone = await page('facebook', 'FB_GONE')
    await handle.db.transaction((tx) => setRemoved(tx, events, gone))
    expect(await fb('FB_GONE')).toBe('ignored')
    expect(await count('conversations')).toBe(0)
  })
})

// ---------------------------------------------------------------------------------------------------------
// Caption bài (`inbox.fetch_post_text`)
// ---------------------------------------------------------------------------------------------------------

describe('caption bài được bình luận', () => {
  async function commentConversation(platform: 'facebook' | 'instagram' | 'threads', acc: string): Promise<string> {
    await page(platform, acc, platform === 'threads' ? 'shop.threads' : null)
    if (platform === 'facebook') await fb(acc, { comment_id: `${acc}_c` })
    else if (platform === 'instagram') await deliver(acc, igComment(), 'comments')
    else await deliver(acc, threadsReply({ root_post: { id: 'tpost_1', owner_id: acc } }), 'replies', 'threads')
    return (await conversationsRows())[0]!.id
  }
  const snapshot = async (id: string) =>
    (await handle.sql<{ post_text_snapshot: string | null; post_text_fetched_at: Date | null }[]>`select post_text_snapshot, post_text_fetched_at from conversations where id = ${id}`)[0]!

  it('FB: GET /{post}?fields=message → snapshot + conversation.updated; chạy lại → bỏ qua', async () => {
    const id = await commentConversation('facebook', 'FB_P')
    const graph = createFakeMetaClient()
    graph.on('GET', '/FB_P_POST1', { ok: true, data: { message: '  Áo thun cotton giảm 20%  ' } })
    expect(await fetchPostText({ db: handle.db, events, cipher, graph }, id, { finalAttempt: false })).toBe('updated')
    expect(graph.calls[0]!.options).toMatchObject({ params: { fields: 'message' }, token: 'TOKEN_FB_P', tier: 'background' })
    expect((await snapshot(id)).post_text_snapshot).toBe('Áo thun cotton giảm 20%')
    expect(emittedOf('conversation.updated').map((e) => e.payload)).toEqual([{ id, pageId: expect.any(String) }])
    expect(await fetchPostText({ db: handle.db, events, cipher, graph }, id, { finalAttempt: false })).toBe('skipped')
    const c = await cookie()
    const conv = ConversationDto.parse((await app.inject({ method: 'GET', url: `/api/v1/conversations/${id}`, headers: { cookie: c } })).json())
    expect(conv.post).toEqual({ platformPostId: 'FB_P_POST1', text: 'Áo thun cotton giảm 20%' })
  })

  it('IG dùng `caption`, Threads dùng client Threads + `text`', async () => {
    const igId = await commentConversation('instagram', 'IG_P')
    const graph = createFakeMetaClient()
    graph.on('GET', '/media_1', { ok: true, data: { caption: 'Váy mới' } })
    expect(await fetchPostText({ db: handle.db, events, cipher, graph }, igId, { finalAttempt: false })).toBe('updated')
    expect(graph.calls[0]!.options.params).toEqual({ fields: 'caption' })

    await handle.sql`delete from pages`
    const thId = await commentConversation('threads', 'TH_P')
    const threads = createFakeMetaClient('https://graph.threads.net/v1.0')
    threads.on('GET', '/tpost_1', { ok: true, data: { text: 'Bài Threads' } })
    expect(await fetchPostText({ db: handle.db, events, cipher, graph, threads }, thId, { finalAttempt: false })).toBe('updated')
    expect(threads.calls[0]!.options).toMatchObject({ params: { fields: 'text' } })
    expect((await snapshot(thId)).post_text_snapshot).toBe('Bài Threads')
  })

  it('lỗi tạm → ném để retry; lần thử cuối → bỏ qua; lỗi khác → bỏ qua, snapshot trống', async () => {
    const id = await commentConversation('facebook', 'FB_Q')
    const graph = createFakeMetaClient()
    graph.on('GET', '/FB_Q_POST1', { ok: false, kind: 'TRANSIENT' })
    await expect(fetchPostText({ db: handle.db, events, cipher, graph }, id, { finalAttempt: false })).rejects.toBeInstanceOf(PostTextRetryableError)
    expect((await snapshot(id)).post_text_fetched_at).toBeNull()
    expect(await handleFetchPostTextJob({ db: handle.db, events, cipher, graph }, { data: { conversationId: id }, retryCount: 3, retryLimit: 3 })).toBe('skipped')
    expect(await snapshot(id)).toMatchObject({ post_text_snapshot: null })
    expect((await snapshot(id)).post_text_fetched_at).not.toBeNull()

    await handle.sql`delete from pages`
    const id2 = await commentConversation('facebook', 'FB_Q2')
    graph.on('GET', '/FB_Q2_POST1', { ok: false, kind: 'REJECTED' })
    expect(await fetchPostText({ db: handle.db, events, cipher, graph }, id2, { finalAttempt: false })).toBe('skipped')
    expect(emittedOf('conversation.updated')).toHaveLength(0)
  })

  it('postTextFromGraph: lấy trường có chữ, cắt 2.000 ký tự; không có → null', () => {
    expect(postTextFromGraph({ message: ' a ' })).toBe('a')
    expect(postTextFromGraph({ caption: 'x'.repeat(2500) })).toHaveLength(2000)
    expect(postTextFromGraph({ message: '  ' })).toBeNull()
    expect(postTextFromGraph(null)).toBeNull()
  })
})
