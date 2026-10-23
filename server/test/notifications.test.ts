// Ma trận Story 1.4 — trung tâm thông báo: consumer sự kiện, cài đặt bật/tắt, REST, job.failed.
import {
  DEFAULT_NOTIFICATION_PREFS,
  ErrorResponse,
  ListNotificationsResponse,
  NotificationPrefs,
  type EventName,
  type EventPayload,
} from '@ottm/shared'
import type { FastifyInstance } from 'fastify'
import type { PgBoss } from 'pg-boss'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest'
import { buildApp } from '../src/app/app.ts'
import { SESSION_COOKIE } from '../src/app/auth/index.ts'
import { createDb, newId, type DbHandle } from '../src/platform/db/index.ts'
import { createEventPublisher, parseEventEnvelope, type EventEnvelope, type EventPublisher } from '../src/platform/events/index.ts'
import {
  BOSS_SCHEMA,
  QUEUES,
  createBoss,
  ensureQueues,
  isCriticalQueue,
  isFinalAttempt,
  startWorkers,
  type QueueRegistry,
} from '../src/platform/jobs/index.ts'
import { createLogger } from '../src/platform/log/index.ts'
import { dedupeKey, handleEvent, type HandleEventDeps } from '../src/modules/notifications/index.ts'
import { createSession, getNotificationPrefs, setNotificationPrefs } from '../src/modules/settings/index.ts'
import { listenRealtime, sleep, waitFor } from './helpers/realtime.ts'

const ORIGIN = 'http://localhost:5173'
const CRITICAL = 'testonly.critical'

let handle: DbHandle
let boss: PgBoss
let events: EventPublisher
let deps: HandleEventDeps
let realtime: Awaited<ReturnType<typeof listenRealtime>>

beforeAll(async () => {
  handle = createDb(inject('databaseUrl'), { max: 3 })
  boss = createBoss(inject('databaseUrl'), 'ottm-test-notifications', { background: false })
  boss.on('error', () => {})
  await boss.start()
  events = createEventPublisher(boss)
  deps = { db: handle.db, events, isCriticalQueue: (q) => q === CRITICAL }
  realtime = await listenRealtime(handle.sql)
})
afterAll(async () => {
  await realtime.stop()
  await boss.stop({ graceful: false })
  await handle.close()
})
beforeEach(async () => {
  await handle.sql`delete from notifications`
  await handle.sql`delete from settings`
  realtime.messages.length = 0
})

function envelope<N extends EventName>(event: N, payload: EventPayload<N>): EventEnvelope {
  return { event, payload } as EventEnvelope
}

const handoff = (id = newId(), extra: Partial<EventPayload<'conversation.state_changed'>> = {}) =>
  envelope('conversation.state_changed', {
    id,
    pageId: 'page-1',
    from: 'ai',
    to: 'handoff',
    reasonCode: 'CUSTOMER_ASKED_HUMAN',
    ...extra,
  })

async function rows() {
  return handle.sql<{ id: string; type: string; title: string; entity: string; entity_id: string; page_id: string | null }[]>`
    select id, type, title, entity, entity_id, page_id from notifications order by id`
}

describe('handleEvent (consumer events.notifications)', () => {
  it('conversation.state_changed to=handoff + ai_handoff bật → 1 thông báo, phát notification.created (realtime)', async () => {
    const conv = newId()
    expect(await handleEvent(deps, handoff(conv))).toBe('created')
    const [row] = await rows()
    expect(row).toMatchObject({ type: 'ai_handoff', entity: 'conversation', entity_id: conv, page_id: 'page-1' })
    expect(row!.title).toBe('AI chuyển một hội thoại cho bạn')
    const msg = await waitFor(() => realtime.messages.find((m) => m.type === 'notification.created'))
    expect(msg).toEqual({ type: 'notification.created', entity: 'notification', id: row!.id, pageId: 'page-1' })
  })

  it('loại tương ứng tắt ở Cài đặt › Thông báo → không tạo', async () => {
    await setNotificationPrefs(handle.db, events, { ...DEFAULT_NOTIFICATION_PREFS, ai_handoff: false })
    realtime.messages.length = 0
    expect(await handleEvent(deps, handoff())).toBe('disabled')
    expect(await rows()).toEqual([])
    await sleep(200)
    expect(realtime.messages.filter((m) => m.type === 'notification.created')).toEqual([])
  })

  it('cùng (event, id, version) tới 2 lần → chỉ 1 thông báo', async () => {
    const conv = newId()
    expect(await handleEvent(deps, handoff(conv, { version: 3 }))).toBe('created')
    expect(await handleEvent(deps, handoff(conv, { version: 3 }))).toBe('duplicate')
    expect(await rows()).toHaveLength(1)
    // version khác = lần chuyển người mới → thông báo mới
    expect(await handleEvent(deps, handoff(conv, { version: 4 }))).toBe('created')
    expect(await rows()).toHaveLength(2)
  })

  it('không có version: phát lại cùng payload → 1 thông báo; lý do khác → thông báo mới', async () => {
    const conv = newId()
    expect(await handleEvent(deps, handoff(conv))).toBe('created')
    expect(await handleEvent(deps, handoff(conv))).toBe('duplicate')
    expect(await handleEvent(deps, handoff(conv, { reasonCode: 'KEYWORD' }))).toBe('created')
    expect(await rows()).toHaveLength(2)
  })

  it('phát lại cùng page.expiring (vd hằng ngày) → 1 thông báo; hạn mới → thông báo mới', async () => {
    const page = newId()
    const expiring = (expiresAt: string) => envelope('page.expiring', { id: page, expiresAt })
    expect(await handleEvent(deps, expiring('2026-11-01T00:00:00.000Z'))).toBe('created')
    expect(await handleEvent(deps, expiring('2026-11-01T00:00:00.000Z'))).toBe('duplicate')
    expect(await handleEvent(deps, expiring('2026-11-01T00:00:00.000Z'))).toBe('duplicate')
    expect(await rows()).toHaveLength(1)
    expect(await handleEvent(deps, expiring('2027-01-01T00:00:00.000Z'))).toBe('created')
  })

  it('dedupeKey: version thắng; không version → trường ổn định theo loại sự kiện', () => {
    expect(dedupeKey(handoff('c1', { version: 7 }))).toBe('conversation.state_changed:c1:v7')
    expect(dedupeKey(handoff('c1'))).toBe('conversation.state_changed:c1:handoff:CUSTOMER_ASKED_HUMAN')
    expect(dedupeKey(envelope('page.expiring', { id: 'p', expiresAt: '2026-11-01T00:00:00.000Z' }))).toBe(
      'page.expiring:p:2026-11-01T00:00:00.000Z',
    )
    expect(dedupeKey(envelope('post_target.failed', { id: 't', pageId: 'p', campaignId: null, errorCode: 'PUBLISH_FAILED' }))).toBe(
      'post_target.failed:t:PUBLISH_FAILED',
    )
    expect(dedupeKey(envelope('campaign.paused', { id: 'c', reason: 'PAGE_DISCONNECTED' }))).toBe('campaign.paused:c:PAGE_DISCONNECTED')
    expect(dedupeKey(envelope('job.failed', { id: 'j', queue: 'a.b', jobId: 'j' }))).toBe('job.failed:j:a.b:j')
  })

  it('to khác handoff → không tạo', async () => {
    expect(await handleEvent(deps, handoff(newId(), { to: 'human', reasonCode: 'TAKEOVER' }))).toBe('ignored')
    expect(await rows()).toEqual([])
  })

  it('page.expiring → token_expiring; post_target.failed → publish_failed', async () => {
    const page = newId()
    expect(await handleEvent(deps, envelope('page.expiring', { id: page, expiresAt: '2026-11-01T20:00:00.000Z' }))).toBe('created')
    expect(
      await handleEvent(deps, envelope('post_target.failed', { id: newId(), pageId: page, campaignId: null, errorCode: 'PUBLISH_FAILED' })),
    ).toBe('created')
    const all = await handle.sql<{ type: string; body: string; page_id: string }[]>`select type, body, page_id from notifications order by id`
    expect(all.map((r) => r.type)).toEqual(['token_expiring', 'publish_failed'])
    // Giờ Việt Nam: 20:00Z ngày 01/11 = 03:00 ngày 02/11.
    expect(all[0]!.body).toContain('02/11/2026')
    expect(all.every((r) => r.page_id === page)).toBe(true)
  })

  it('campaign.paused: mặc định tắt; bật thì tạo; MANUAL thì không báo', async () => {
    const paused = envelope('campaign.paused', { id: newId(), reason: 'PAGE_DISCONNECTED' })
    expect(await handleEvent(deps, paused)).toBe('disabled')
    await setNotificationPrefs(handle.db, events, { ...DEFAULT_NOTIFICATION_PREFS, campaign_paused: true })
    expect(await handleEvent(deps, paused)).toBe('created')
    expect(await handleEvent(deps, envelope('campaign.paused', { id: newId(), reason: 'MANUAL' }))).toBe('ignored')
  })

  it('job.failed: system_error chỉ khi queue thuộc danh sách quan trọng', async () => {
    const jobId = newId()
    expect(await handleEvent(deps, envelope('job.failed', { id: jobId, queue: 'testonly.boring', jobId }))).toBe('ignored')
    expect(await handleEvent(deps, envelope('job.failed', { id: jobId, queue: CRITICAL, jobId }))).toBe('created')
    const [row] = await rows()
    expect(row).toMatchObject({ type: 'system_error', entity: 'job', entity_id: jobId, page_id: null })
    const [{ body }] = await handle.sql<{ body: string }[]>`select body from notifications`
    expect(body).toContain(CRITICAL)
    expect(body).toContain(jobId)
  })

  it('registry thật: events.notifications không critical (tránh vòng lặp job.failed)', () => {
    expect(isCriticalQueue('events.notifications')).toBe(false)
    expect(QUEUES['events.notifications'].subscribes).toEqual(
      expect.arrayContaining(['conversation.state_changed', 'page.expiring', 'post_target.failed', 'campaign.paused', 'job.failed']),
    )
  })
})

describe('cài đặt thông báo (module settings)', () => {
  it('chưa lưu → mặc định (bật cả, trừ campaign_paused)', async () => {
    expect(await getNotificationPrefs(handle.db)).toEqual(DEFAULT_NOTIFICATION_PREFS)
    expect(DEFAULT_NOTIFICATION_PREFS).toEqual({
      ai_handoff: true,
      token_expiring: true,
      publish_failed: true,
      campaign_paused: false,
      system_error: true,
    })
  })

  it('giá trị đã lưu thiếu khoá (loại mới) → khoá đó lấy mặc định', async () => {
    await handle.sql`insert into settings (key, value) values ('notification_prefs', ${JSON.stringify({ ai_handoff: false })}::jsonb)`
    expect(await getNotificationPrefs(handle.db)).toEqual({ ...DEFAULT_NOTIFICATION_PREFS, ai_handoff: false })
  })
})

describe('REST /api/v1/notifications, /api/v1/settings/notifications', () => {
  let app: FastifyInstance
  let token: string

  beforeEach(async () => {
    app = buildApp({
      sql: handle.sql,
      db: handle.db,
      logger: createLogger({ level: 'silent' }),
      http: { allowedOrigins: [ORIGIN] },
      events,
    })
    token = (await createSession(handle.db)).token
  })
  afterEach(async () => {
    await app.close()
  })

  const call = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: object, auth = true) =>
    app.inject({
      method,
      url,
      headers: { ...(auth ? { cookie: `${SESSION_COOKIE}=${token}` } : {}), ...(method === 'GET' ? {} : { origin: ORIGIN }) },
      ...(payload ? { payload } : {}),
    })

  it('chưa đăng nhập → 401 UNAUTHENTICATED', async () => {
    for (const [m, u] of [
      ['GET', '/api/v1/notifications'],
      ['POST', '/api/v1/notifications/read'],
      ['GET', '/api/v1/settings/notifications'],
      ['PUT', '/api/v1/settings/notifications'],
    ] as const) {
      const res = await call(m, u, m === 'GET' ? undefined : {}, false)
      expect(res.statusCode).toBe(401)
      expect(ErrorResponse.parse(res.json()).error.code).toBe('UNAUTHENTICATED')
    }
  })

  it('danh sách mới nhất trước + unreadCount; since; phân trang cursor', async () => {
    for (let i = 0; i < 3; i++) await handleEvent(deps, handoff())
    const res = await call('GET', '/api/v1/notifications')
    expect(res.statusCode).toBe(200)
    const body = ListNotificationsResponse.parse(res.json())
    expect(body.unreadCount).toBe(3)
    expect(body.items).toHaveLength(3)
    expect(body.nextCursor).toBeNull()
    const ids = body.items.map((n) => n.id)
    expect([...ids].sort().reverse()).toEqual(ids)
    expect(body.items[0]).toMatchObject({ type: 'ai_handoff', readAt: null, pageId: 'page-1' })
    expect(body.items[0]!.createdAt).toMatch(/Z$/)

    const page1 = ListNotificationsResponse.parse((await call('GET', '/api/v1/notifications?limit=2')).json())
    expect(page1.items.map((n) => n.id)).toEqual(ids.slice(0, 2))
    expect(page1.nextCursor).toBe(ids[1])
    const page2 = ListNotificationsResponse.parse((await call('GET', `/api/v1/notifications?limit=2&cursor=${page1.nextCursor}`)).json())
    expect(page2.items.map((n) => n.id)).toEqual(ids.slice(2))
    expect(page2.nextCursor).toBeNull()

    const oldest = body.items[2]!
    const since = ListNotificationsResponse.parse(
      (await call('GET', `/api/v1/notifications?since=${encodeURIComponent(oldest.createdAt)}`)).json(),
    )
    expect(since.items.map((n) => n.id)).not.toContain(oldest.id)
    expect(since.unreadCount).toBe(3)
  })

  it('cursor / since / ids sai → 400 VALIDATION_FAILED', async () => {
    for (const res of [
      await call('GET', '/api/v1/notifications?cursor=khong-phai-uuid'),
      await call('GET', '/api/v1/notifications?since=hom-qua'),
      await call('POST', '/api/v1/notifications/read', { ids: ['khong-phai-uuid'] }),
    ]) {
      expect(res.statusCode).toBe(400)
      expect(ErrorResponse.parse(res.json()).error.code).toBe('VALIDATION_FAILED')
    }
  })

  it('Đánh dấu đã đọc tất cả → unreadCount về 0; theo ids chỉ đọc các mục đó', async () => {
    for (let i = 0; i < 3; i++) await handleEvent(deps, handoff())
    const { items } = ListNotificationsResponse.parse((await call('GET', '/api/v1/notifications')).json())
    const one = await call('POST', '/api/v1/notifications/read', { ids: [items[0]!.id] })
    expect(one.statusCode).toBe(200)
    expect(one.json()).toEqual({ unreadCount: 2 })
    const all = await call('POST', '/api/v1/notifications/read', { all: true })
    expect(all.json()).toEqual({ unreadCount: 0 })
    const after = ListNotificationsResponse.parse((await call('GET', '/api/v1/notifications')).json())
    expect(after.unreadCount).toBe(0)
    expect(after.items.every((n) => n.readAt !== null)).toBe(true)
    expect((await call('POST', '/api/v1/notifications/read', {})).statusCode).toBe(400)
  })

  it('GET/PUT cài đặt: mặc định, lưu, phát settings.updated (realtime)', async () => {
    expect(NotificationPrefs.parse((await call('GET', '/api/v1/settings/notifications')).json())).toEqual(DEFAULT_NOTIFICATION_PREFS)
    const next = { ...DEFAULT_NOTIFICATION_PREFS, ai_handoff: false, campaign_paused: true }
    const put = await call('PUT', '/api/v1/settings/notifications', next)
    expect(put.statusCode).toBe(200)
    expect(put.json()).toEqual(next)
    expect((await call('GET', '/api/v1/settings/notifications')).json()).toEqual(next)
    const msg = await waitFor(() => realtime.messages.find((m) => m.type === 'settings.updated'))
    expect(msg).toEqual({ type: 'settings.updated', entity: 'settings', id: 'notification_prefs' })
  })

  it('PUT thiếu khoá / khoá lạ → 400, không lưu', async () => {
    expect((await call('PUT', '/api/v1/settings/notifications', { ai_handoff: false })).statusCode).toBe(400)
    expect((await call('PUT', '/api/v1/settings/notifications', { ...DEFAULT_NOTIFICATION_PREFS, extra: true })).statusCode).toBe(400)
    expect(await getNotificationPrefs(handle.db)).toEqual(DEFAULT_NOTIFICATION_PREFS)
  })

  it('AC2: tắt ai_handoff qua API rồi phát lại sự kiện → không có thông báo mới', async () => {
    await call('PUT', '/api/v1/settings/notifications', { ...DEFAULT_NOTIFICATION_PREFS, ai_handoff: false })
    expect(await handleEvent(deps, handoff())).toBe('disabled')
    expect(ListNotificationsResponse.parse((await call('GET', '/api/v1/notifications')).json()).items).toEqual([])
  })
})

describe('worker thật: publish → events.notifications → thông báo; job hỏng → job.failed', () => {
  const FLAKY = CRITICAL
  /** Subscriber của job.failed luôn hỏng: dùng để kiểm chặn vòng lặp. */
  const FAILSINK = 'testonly.failsink'
  let workerBoss: PgBoss
  let attempts = 0
  let failsinkAttempts = 0
  const registry: QueueRegistry = {
    ...QUEUES,
    [FLAKY]: { policy: 'standard', retryLimit: 1, retryDelay: 0, concurrency: 1, critical: true, pollingIntervalSeconds: 0.5 },
    [FAILSINK]: { policy: 'standard', retryLimit: 0, concurrency: 1, pollingIntervalSeconds: 0.5, subscribes: ['job.failed'] },
  }
  const countJobs = async (where: string, params: unknown[]) => {
    const [row] = await handle.sql.unsafe<{ n: number }[]>(`select count(*)::int as n from ${BOSS_SCHEMA}.job where ${where}`, params as never[])
    return row!.n
  }

  beforeAll(async () => {
    workerBoss = createBoss(inject('databaseUrl'), 'ottm-test-worker')
    workerBoss.on('error', () => {})
    await workerBoss.start()
    await ensureQueues(workerBoss, registry)
    await workerBoss.deleteAllJobs('events.notifications')
    const workerDeps: HandleEventDeps = { db: handle.db, events, isCriticalQueue: (q) => isCriticalQueue(q, registry) }
    await startWorkers(
      workerBoss,
      {
        'platform.heartbeat': async () => {},
        'events.ai': async () => {},
        'events.profiles': async () => {},
        'ai.reservations_gc': async () => {},
        'connections.oauth_gc': async () => {},
        'connections.token_check': async () => {},
        'webhook.route': async () => {},
        'connections.subscribe_page': async () => {},
        'webhooks.health': async () => {},
        'autoreply.triage': async () => {},
        'inbox.fetch_attachment': async () => {},
        'inbox.fetch_profile': async () => {},
        'inbox.fetch_post_text': async () => {},
        'inbox.send': async () => {},
        'inbox.send_sweep': async () => {},
        'inbox.echo_match': async () => {},
        'inbox.contact_summary': async () => {},
        'events.notifications': async (job) => {
          await handleEvent(workerDeps, parseEventEnvelope(job.data))
        },
        [FLAKY]: async () => {
          attempts += 1
          throw new Error('hỏng')
        },
        [FAILSINK]: async () => {
          failsinkAttempts += 1
          throw new Error('subscriber job.failed hỏng')
        },
      },
      createLogger({ level: 'silent' }),
      registry,
      { failures: { events, db: handle.db } },
    )
  })
  afterAll(async () => {
    for (const name of Object.keys(registry)) await workerBoss.offWork(name)
    await workerBoss.unsubscribe('job.failed', FAILSINK)
    await workerBoss.deleteQueue(FAILSINK)
    await workerBoss.deleteQueue(FLAKY)
    await ensureQueues(workerBoss) // trả lại đúng registry thật
    await workerBoss.stop({ graceful: false })
  })

  it('emit conversation.state_changed (handoff) → thông báo + notification.created trong ≤ 3 giây', async () => {
    const conv = newId()
    const startedAt = Date.now()
    await handle.db.transaction((tx) =>
      events.publishEvent(tx, 'conversation.state_changed', {
        id: conv,
        pageId: 'page-9',
        from: 'ai',
        to: 'handoff',
        reasonCode: 'KEYWORD',
      }),
    )
    const msg = await waitFor(() => realtime.messages.find((m) => m.type === 'notification.created'), 3_000)
    expect(Date.now() - startedAt).toBeLessThan(3_000)
    const [row] = await rows()
    expect(row).toMatchObject({ id: msg.id, type: 'ai_handoff', entity_id: conv })
  })

  it('handler ném lỗi ở lần thử cuối → phát job.failed {queue, jobId} → system_error (queue critical)', async () => {
    const jobId = await workerBoss.send(FLAKY, {})
    expect(jobId).toBeTruthy()
    const row = await waitFor(async () => (await rows()).find((r) => r.type === 'system_error'), 10_000)
    expect(row).toMatchObject({ entity: 'job', entity_id: jobId })
    expect(attempts).toBe(2) // lần đầu + 1 retry; job.failed chỉ phát ở lần cuối
    const [job] = await handle.sql.unsafe<{ state: string }[]>(`select state from ${BOSS_SCHEMA}.job where id = $1`, [jobId])
    expect(job?.state).toBe('failed')
    await sleep(1_500) // đủ cho mọi lượt xử lý còn lại
    expect((await rows()).filter((r) => r.type === 'system_error')).toHaveLength(1)
    // Đúng một job.failed được phát cho job này (lần thử đầu không phát).
    expect(await countJobs(`name = 'events.notifications' and data->>'event' = 'job.failed' and data->'payload'->>'jobId' = $1`, [jobId])).toBe(1)
  })

  it('subscriber của job.failed hỏng ở lần cuối → KHÔNG phát job.failed mới (chặn vòng lặp)', async () => {
    const before = failsinkAttempts
    const jobId = newId()
    await handle.db.transaction((tx) => events.publishEvent(tx, 'job.failed', { id: jobId, queue: 'testonly.other', jobId }))
    await waitFor(() => failsinkAttempts > before, 5_000)
    await waitFor(
      async () =>
        (await countJobs(`name = $1 and data->'payload'->>'jobId' = $2 and state = 'failed'`, [FAILSINK, jobId])) === 1,
      5_000,
    )
    await sleep(1_500)
    expect(await countJobs(`name = $1 and data->'payload'->>'jobId' = $2`, [FAILSINK, jobId])).toBe(1)
    // Không có job.failed nào nói về chính queue FAILSINK.
    expect(await countJobs(`data->>'event' = 'job.failed' and data->'payload'->>'queue' = $1`, [FAILSINK])).toBe(0)
  })
})

describe('isFinalAttempt', () => {
  it.each([
    [0, 0, true],
    [0, 1, false],
    [1, 1, true],
    [2, 3, false],
    [3, 3, true],
    [4, 3, true],
  ])('retryCount %i / retryLimit %i → %s', (retryCount, retryLimit, final) => {
    expect(isFinalAttempt({ retryCount, retryLimit })).toBe(final)
  })
})
