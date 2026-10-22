import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest'
import type { PgBoss } from 'pg-boss'
import {
  BOSS_INTERNAL_PREFIX,
  BOSS_SCHEMA,
  CRON_TZ,
  InvalidQueueRegistryError,
  QUEUES,
  UnknownQueueError,
  createBoss,
  createJobSender,
  ensureQueues,
  validateRegistry,
  type QueueName,
  type QueueRegistry,
} from '../src/platform/jobs/index.ts'

function fakeBoss() {
  const send = vi.fn(async () => 'job-id')
  return { boss: { send } as unknown as Pick<PgBoss, 'send'>, send }
}

describe('platform/jobs/queues — send()', () => {
  it('ném UNKNOWN_QUEUE với tên không có trong registry và không gọi pg-boss', async () => {
    const { boss, send } = fakeBoss()
    const jobs = createJobSender(boss)
    const err = await jobs.send('inbox.nope' as QueueName, {}).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(UnknownQueueError)
    expect((err as UnknownQueueError).code).toBe('UNKNOWN_QUEUE')
    expect(send).not.toHaveBeenCalled()
  })

  it('không nhận tên kế thừa từ Object.prototype', async () => {
    const { boss } = fakeBoss()
    await expect(createJobSender(boss).send('toString' as QueueName, {})).rejects.toMatchObject({ code: 'UNKNOWN_QUEUE' })
  })

  it('gửi tới queue đã khai báo, không kèm singletonKey cho queue standard', async () => {
    const { boss, send } = fakeBoss()
    await createJobSender(boss).send('platform.heartbeat', {})
    expect(send).toHaveBeenCalledWith('platform.heartbeat', {}, {})
  })

  it('queue stately tự suy singletonKey từ payload', async () => {
    const { boss, send } = fakeBoss()
    const registry: QueueRegistry = {
      'autoreply.run': {
        policy: 'stately',
        retryLimit: 2,
        concurrency: 5,
        singletonKey: ((d: { conversationId: string }) => d.conversationId) as never,
      },
    }
    await createJobSender(boss, registry).send('autoreply.run' as QueueName, { conversationId: 'c1' } as never)
    expect(send).toHaveBeenCalledWith('autoreply.run', { conversationId: 'c1' }, { singletonKey: 'c1' })
  })
})

describe('platform/jobs/queues — singletonKey rỗng', () => {
  it('send() ném lỗi khi khoá suy từ payload rỗng, không gọi pg-boss', async () => {
    const { boss, send } = fakeBoss()
    const registry: QueueRegistry = {
      'autoreply.run': {
        policy: 'stately',
        retryLimit: 2,
        concurrency: 5,
        singletonKey: ((d: { conversationId: string }) => d.conversationId) as never,
      },
    }
    await expect(
      createJobSender(boss, registry).send('autoreply.run' as QueueName, { conversationId: '' } as never),
    ).rejects.toBeInstanceOf(InvalidQueueRegistryError)
    expect(send).not.toHaveBeenCalled()
  })
})

describe('platform/jobs/queues — luật AD-24', () => {
  it('registry thật hợp lệ, mọi cron dùng Asia/Ho_Chi_Minh', () => {
    expect(() => validateRegistry(QUEUES)).not.toThrow()
    for (const def of Object.values(QUEUES as QueueRegistry)) {
      if (def.cron) expect(def.cron.tz).toBe(CRON_TZ)
    }
  })

  it.each<[string, QueueRegistry]>([
    ['singletonKey trên queue standard', { 'a.b': { policy: 'standard', retryLimit: 1, concurrency: 1, singletonKey: (() => 'k') as never } }],
    ['cron sai múi giờ', { 'a.b': { policy: 'standard', retryLimit: 1, concurrency: 1, cron: { expression: '* * * * *', tz: 'UTC' as never } } }],
    ['tên không theo <module>.<action>', { Heartbeat: { policy: 'standard', retryLimit: 1, concurrency: 1 } }],
    ['policy ngoài standard/stately', { 'a.b': { policy: 'singleton' as never, retryLimit: 1, concurrency: 1 } }],
    ['queue stately thiếu hàm singletonKey', { 'a.b': { policy: 'stately', retryLimit: 1, concurrency: 1 } as never }],
    ['dấu - trong đoạn module', { 'web-hooks.route': { policy: 'standard', retryLimit: 1, concurrency: 1 } }],
    ['dấu - trong đoạn action', { 'webhooks.re-route': { policy: 'standard', retryLimit: 1, concurrency: 1 } }],
    ['concurrency 0', { 'a.b': { policy: 'standard', retryLimit: 1, concurrency: 0 } }],
    ['subscribes sự kiện ngoài danh mục', { 'a.b': { policy: 'standard', retryLimit: 1, concurrency: 1, subscribes: ['nope.happened' as never] } }],
    ['pollingIntervalSeconds < 0.5', { 'a.b': { policy: 'standard', retryLimit: 1, concurrency: 1, pollingIntervalSeconds: 0.1 } }],
  ])('từ chối: %s', (_label, registry) => {
    expect(() => validateRegistry(registry)).toThrow(InvalidQueueRegistryError)
  })
})

describe('pg-boss thật — worker khởi động chỉ tạo queue trong registry', () => {
  let boss: PgBoss

  beforeAll(async () => {
    boss = createBoss(inject('databaseUrl'), 'ottm-test')
    boss.on('error', () => {})
    await boss.start()
  })
  afterAll(async () => {
    await boss.stop({ graceful: false })
  })

  it('getQueues (bỏ queue nội bộ của pg-boss) đúng bằng registry, có policy/retry; cron có tz VN', async () => {
    const { unknownQueues } = await ensureQueues(boss)
    expect(unknownQueues).toEqual([])

    const queues = (await boss.getQueues()).filter((q) => !q.name.startsWith(BOSS_INTERNAL_PREFIX))
    expect(queues.map((q) => q.name).sort()).toEqual(Object.keys(QUEUES).sort())
    const heartbeat = queues.find((q) => q.name === 'platform.heartbeat')
    expect(heartbeat).toMatchObject({ policy: 'standard', retryLimit: 1 })

    const schedules = await boss.getSchedules()
    const cronQueues = Object.entries(QUEUES as QueueRegistry)
      .filter(([, def]) => def.cron)
      .map(([name]) => [name, CRON_TZ])
    expect(cronQueues).toEqual(expect.arrayContaining([['platform.heartbeat', CRON_TZ], ['ai.reservations_gc', CRON_TZ]]))
    expect(schedules.map((s) => [s.name, s.timezone]).sort()).toEqual(cronQueues.sort())
  })

  it('subscription sự kiện → queue đúng bằng `subscribes` của registry', async () => {
    await ensureQueues(boss)
    const rows = await boss.getDb().executeSql(`select event, name from ${BOSS_SCHEMA}.subscription where name = $1`, ['events.notifications'])
    expect((rows.rows as { event: string }[]).map((r) => r.event).sort()).toEqual([...QUEUES['events.notifications'].subscribes].sort())
  })

  it('chạy lại ensureQueues là idempotent', async () => {
    await ensureQueues(boss)
    await expect(ensureQueues(boss)).resolves.toEqual({ unknownQueues: [] })
  })

  describe('đồng bộ khi registry đổi (queue chỉ dùng trong test)', () => {
    const NAME = 'testonly.reconcile'
    afterAll(async () => {
      await boss.deleteQueue(NAME)
      await ensureQueues(boss) // trả lại đúng registry thật (gồm cron heartbeat)
    })

    it('cập nhật retryLimit và gỡ cron không còn khai báo', async () => {
      const a: QueueRegistry = {
        [NAME]: { policy: 'standard', retryLimit: 1, concurrency: 1, cron: { expression: '0 3 * * *', tz: CRON_TZ } },
      }
      await ensureQueues(boss, a)
      expect((await boss.getSchedules()).map((s) => s.name)).toContain(NAME)

      const b: QueueRegistry = { [NAME]: { policy: 'standard', retryLimit: 3, concurrency: 1 } }
      await ensureQueues(boss, b)
      expect((await boss.getQueue(NAME))?.retryLimit).toBe(3)
      expect((await boss.getSchedules()).map((s) => s.name)).not.toContain(NAME)
    })

    it('gỡ subscription mà registry không còn khai báo', async () => {
      const subs = async () =>
        ((await boss.getDb().executeSql(`select event from ${BOSS_SCHEMA}.subscription where name = $1`, [NAME])).rows as { event: string }[]).map(
          (r) => r.event,
        )
      await ensureQueues(boss, { [NAME]: { policy: 'standard', retryLimit: 3, concurrency: 1, subscribes: ['page.expiring', 'job.failed'] } })
      expect((await subs()).sort()).toEqual(['job.failed', 'page.expiring'])
      await ensureQueues(boss, { [NAME]: { policy: 'standard', retryLimit: 3, concurrency: 1, subscribes: ['job.failed'] } })
      expect(await subs()).toEqual(['job.failed'])
      await ensureQueues(boss, { [NAME]: { policy: 'standard', retryLimit: 3, concurrency: 1 } })
      expect(await subs()).toEqual([])
    })

    it('đổi policy của queue đã có → từ chối', async () => {
      const c: QueueRegistry = {
        [NAME]: { policy: 'stately', retryLimit: 3, concurrency: 1, singletonKey: (() => 'k') as never },
      }
      await expect(ensureQueues(boss, c)).rejects.toThrow(/policy/)
    })
  })
})
