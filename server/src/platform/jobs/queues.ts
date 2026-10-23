// AD-24: mọi queue pg-boss khai báo DUY NHẤT ở file này (policy, retry, concurrency, cron).
// - `singletonKey` chỉ dùng với policy `stately`; queue `standard` chống trùng bằng điều kiện trạng thái.
// - Cron luôn `tz: 'Asia/Ho_Chi_Minh'`.
// - `send()` từ chối tên không có trong registry (`UNKNOWN_QUEUE`).
// - Consumer sự kiện (AD-3): queue khai báo `subscribes` — `ensureQueues` đồng bộ subscription pg-boss.
// - Job hết retry phát `job.failed`; `critical: true` → thông báo `system_error` cho chủ shop.
import { isEventName, type EventName } from '@ottm/shared'
import type { Db as BossDb, PgBoss, SendOptions } from 'pg-boss'
import type { EventEnvelope } from '../events/index.ts'

export const CRON_TZ = 'Asia/Ho_Chi_Minh'

interface QueueDefBase {
  retryLimit: number
  /** Giây giữa hai lần retry; với `retryBackoff` là giá trị khởi điểm. */
  retryDelay?: number
  retryBackoff?: boolean
  /** Số worker song song mỗi tiến trình (`localConcurrency` của pg-boss). */
  concurrency: number
  expireInSeconds?: number
  /** Cron 5 trường. pg-boss 12 gửi tối đa một job mỗi phút cho một lịch. */
  cron?: { expression: string; tz: typeof CRON_TZ }
  /** Giây giữa hai lần hỏi job mới (pg-boss mặc định 2, tối thiểu 0.5). */
  pollingIntervalSeconds?: number
  /** Sự kiện miền mà queue nhận (pg-boss subscribe); job mang `EventEnvelope`. */
  subscribes?: readonly EventName[]
  /** Hết retry ở queue này → thông báo `system_error` (qua `job.failed`). */
  critical?: boolean
}

export interface StandardQueueDef extends QueueDefBase {
  policy: 'standard'
  singletonKey?: never
}

export interface StatelyQueueDef<D = never> extends QueueDefBase {
  policy: 'stately'
  /** Khoá singleton suy từ payload, vd `conversationId`. */
  singletonKey: (data: D) => string
  cron?: never
}

export type QueueDef = StandardQueueDef | StatelyQueueDef<never>

/** Payload của từng queue — thêm khoá mới cùng lúc với khai báo trong `QUEUES`. */
export interface QueuePayloads {
  'platform.heartbeat': Record<string, never>
  'events.notifications': EventEnvelope
  'events.ai': EventEnvelope
  'events.profiles': EventEnvelope
  'ai.reservations_gc': Record<string, never>
  'connections.oauth_gc': Record<string, never>
  'connections.token_check': Record<string, never>
  'webhook.route': { eventId: string }
  'connections.subscribe_page': { pageId: string }
  'webhooks.health': Record<string, never>
  'autoreply.triage': EventEnvelope
  'inbox.fetch_attachment': { attachmentId: string }
  'inbox.fetch_profile': { identityId: string }
  'inbox.fetch_post_text': { conversationId: string }
  'inbox.send': { messageId: string }
  'inbox.send_sweep': Record<string, never>
  /** Story 4.5: tin của chính trang chưa khớp tin nào của app — bản chuẩn hoá (dạng JSON) để thử khớp lại. */
  'inbox.echo_match': {
    pageId: string
    echo: {
      channel: 'dm' | 'comment'
      threadRef: string | null
      platformMessageId: string
      text: string | null
      /** ISO 8601. */
      timestamp: string
      attachments: { kind: string; url: string }[]
      appId: string | null
      metadata: string | null
    }
  }
}

export const QUEUES = {
  // Ghi `worker_heartbeats` cho `/healthz` (AD-24 dòng Cron: retry 1, concurrency 1).
  'platform.heartbeat': {
    policy: 'standard',
    retryLimit: 1,
    concurrency: 1,
    expireInSeconds: 60,
    cron: { expression: '* * * * *', tz: CRON_TZ },
  },
  // Module `notifications` (Story 1.4): sự kiện → thông báo trong app. Idempotent theo `dedupe_key`,
  // nên retry an toàn. Hỏi job mỗi 0,5 giây để toast tới trong ≤3 giây. Không `critical`: lỗi ở đây
  // không được sinh thêm thông báo (tránh vòng lặp job.failed → thông báo → lỗi).
  'events.notifications': {
    policy: 'standard',
    retryLimit: 3,
    retryDelay: 2,
    retryBackoff: true,
    concurrency: 2,
    expireInSeconds: 60,
    pollingIntervalSeconds: 0.5,
    subscribes: ['conversation.state_changed', 'page.expiring', 'post_target.failed', 'campaign.paused', 'job.failed'],
  },
  // Module `ai` (Story 1.6): đổi hạn mức / tỉ giá / cảnh báo 80% → tính lại cờ cảnh báo, phát
  // `ai_budget.restored` khi xuống dưới ngưỡng. Idempotent (đối chiếu cờ với số đã tiêu) nên retry an toàn.
  'events.ai': {
    policy: 'standard',
    retryLimit: 3,
    retryDelay: 2,
    retryBackoff: true,
    concurrency: 1,
    expireInSeconds: 60,
    pollingIntervalSeconds: 0.5,
    subscribes: ['settings.updated'],
  },
  // Module `profiles` (Story 3.3, AD-8): nghe đổi thành viên nhóm → giữ cấu hình kế thừa (brand nay; AI ở Epic 5).
  // Idempotent (dựa trên "trang đã có cấu hình riêng chưa") nên retry an toàn. Hỏi job 0,5 giây để UI cập nhật nhanh.
  'events.profiles': {
    policy: 'standard',
    retryLimit: 3,
    retryDelay: 2,
    retryBackoff: true,
    concurrency: 1,
    expireInSeconds: 60,
    pollingIntervalSeconds: 0.5,
    subscribes: ['page.group_changed', 'group.deleted'],
  },
  // Dọn chỗ giữ chi phí AI bị bỏ rơi (tiến trình chết giữa lời gọi) cũ hơn 15 phút, mỗi 5 phút.
  'ai.reservations_gc': {
    policy: 'standard',
    retryLimit: 1,
    concurrency: 1,
    expireInSeconds: 60,
    cron: { expression: '*/5 * * * *', tz: CRON_TZ },
  },
  // Module `connections` (Story 2.2): xoá `oauth_states` / `oauth_results` hết hạn (kết quả giữ envelope token
  // Page) mỗi giờ — kể cả khi không ai dùng OAuth nữa. Idempotent.
  'connections.oauth_gc': {
    policy: 'standard',
    retryLimit: 1,
    concurrency: 1,
    expireInSeconds: 60,
    cron: { expression: '0 * * * *', tz: CRON_TZ },
  },
  // Module `connections` (Story 2.4): mỗi ngày lúc 3h sáng (giờ VN) làm mới token Threads sắp hết hạn, tính lại
  // trạng thái mọi trang (`expiring`) và phát `page.expiring` một lần/chu kỳ. Handler bắt lỗi không retry được,
  // ghi trạng thái rồi kết thúc bình thường → retry 1 là đủ (cron chạy lại ngày sau).
  'connections.token_check': {
    policy: 'standard',
    retryLimit: 1,
    concurrency: 1,
    expireInSeconds: 300,
    cron: { expression: '0 3 * * *', tz: CRON_TZ },
  },
  // Module `webhooks` (Story 4.1, AD-4): mỗi mục webhook một job — chuẩn hoá + đặt `status`. Chống trùng bằng
  // UNIQUE(product, dedupe_key) ở lúc ghi (mỗi mục một job duy nhất) + handler idempotent (tính lại trạng thái
  // xác định), nên retry an toàn. Retry 5 backoff, concurrency 10 (AD-24). Chưa `critical` ở 4.1 → job hết retry
  // vẫn phát `job.failed` nhưng KHÔNG sinh thông báo (consumer `events.notifications` chỉ báo queue critical).
  // Việc ghi mục `failed` do handler webhook.route tự làm ở lần thử cuối (không qua `job.failed`); chủ shop thấy
  // mục lỗi ở nhật ký Cài đặt › Webhook và bấm "Xử lý lại". Story 4.2 giữ không critical (chỉ có banner sức khoẻ);
  // dead-letter + thông báo cho `webhook.route` hoãn (deferred-work.md).
  // Story 4.3/4.4: tin/bình luận gọi `inbox.ingest` → hỏi job mỗi 0,5 giây để tin hiện trên Hộp thư trong ≤3 giây.
  'webhook.route': {
    policy: 'standard',
    retryLimit: 5,
    retryDelay: 2,
    retryBackoff: true,
    concurrency: 10,
    expireInSeconds: 120,
    pollingIntervalSeconds: 0.5,
  },
  // Module `connections` (Story 4.2, AD-4/AD-24 `connections.*`): đăng ký webhook cho một trang
  // (`POST /{page}/subscribed_apps`). Enqueue trong transaction xác nhận/kết nối lại + chạy bù khi worker khởi động.
  // Idempotent (đăng ký lại cùng field không đổi gì) nên retry an toàn. Chỉ `RATE_LIMITED`/`TRANSIENT` ném để retry;
  // lỗi khác ghi `webhook_subscribe_error` rồi kết thúc; hết retry → `FAILED`.
  'connections.subscribe_page': {
    policy: 'standard',
    retryLimit: 3,
    // Chặn tần suất của Meta thường kéo dài vài phút → bắt đầu từ 60 giây (60/120/240) thay vì hết retry trong
    // chưa tới một phút rồi thành `FAILED` vĩnh viễn (nhất là lúc chạy bù nhiều trang).
    retryDelay: 60,
    retryBackoff: true,
    concurrency: 2,
    expireInSeconds: 120,
  },
  // Module `webhooks` (Story 4.2, AD-4): mỗi 5 phút (giờ VN) tính sức khoẻ `meta`/`threads`, phát
  // `webhook.stalled|recovered` khi đổi trạng thái (cùng transaction với lần ghi). Cron chạy lại sau 5 phút → retry 1.
  'webhooks.health': {
    policy: 'standard',
    retryLimit: 1,
    concurrency: 1,
    expireInSeconds: 60,
    cron: { expression: '*/5 * * * *', tz: CRON_TZ },
  },
  // Module `autoreply` (Story 4.3, AD-16, AD-24): tin khách (`message.received`) → đưa hội thoại `triage` về đích
  // NGAY. Trước Epic 5 luôn `human` với `AI_OFF`. Idempotent (chỉ áp khi còn `triage` + đúng `state_version`) nên
  // retry an toàn. Hỏi job 0,5 giây để chip trạng thái đổi trong ≤3 giây.
  'autoreply.triage': {
    policy: 'standard',
    retryLimit: 3,
    retryDelay: 2,
    retryBackoff: true,
    concurrency: 10,
    expireInSeconds: 60,
    pollingIntervalSeconds: 0.5,
    subscribes: ['message.received'],
  },
  // Module `inbox` (Story 4.3, AD-11, AD-14): tải đính kèm của khách từ CDN Meta về kho riêng tư. Chống trùng bằng
  // `UPDATE … WHERE status='pending'`. Chỉ lỗi tạm (CDN/kho 5xx, chặn tần suất) ném để retry; lần thử cuối ghi
  // `failed` (tin vẫn còn, chỉ đính kèm lỗi). Link CDN hết hạn sau vài giờ → retry trong vài phút là đủ.
  'inbox.fetch_attachment': {
    policy: 'standard',
    retryLimit: 3,
    retryDelay: 10,
    retryBackoff: true,
    concurrency: 3,
    expireInSeconds: 120,
    pollingIntervalSeconds: 0.5,
  },
  // Module `inbox` (Story 4.3): lấy tên khách từ Meta cho định danh mới (`GET /{PSID|IGSID}`). Không ghi đè tên đã
  // có. Theo policy `connections.*` của AD-24 (gọi Meta nền): retry 3, concurrency 2.
  'inbox.fetch_profile': {
    policy: 'standard',
    retryLimit: 3,
    retryDelay: 30,
    retryBackoff: true,
    concurrency: 2,
    expireInSeconds: 60,
  },
  // Module `inbox` (Story 4.4, AD-16): caption bài được bình luận, lấy một lần khi tạo hội thoại `comment`
  // (`post_text_snapshot` cho autoreply Epic 5). Gọi Meta nền như `inbox.fetch_profile`: retry 3, concurrency 2.
  'inbox.fetch_post_text': {
    policy: 'standard',
    retryLimit: 3,
    retryDelay: 30,
    retryBackoff: true,
    concurrency: 2,
    expireInSeconds: 60,
  },
  // Module `inbox` (Story 4.7, AD-10, AD-24): gửi một tin outbound qua Meta. Chống trùng bằng
  // `UPDATE … SET status='sending' WHERE status='pending'` (không singletonKey). Chỉ `TRANSIENT` ném để retry (tin trả
  // về `pending` trước); `RATE_LIMITED` hoãn bằng job mới `startAfter` (không tính lượt); lần thử cuối / lỗi khác ghi
  // `failed` + mã rồi kết thúc êm. Retry 5 backoff (5/10/20/40/80 giây), concurrency 5. `critical`: handler chỉ ném ở
  // lần cuối khi lỗi bất ngờ (DB…) → thông báo `system_error`. Hỏi job 0,5 giây để tin đi ngay.
  'inbox.send': {
    policy: 'standard',
    retryLimit: 5,
    retryDelay: 5,
    retryBackoff: true,
    concurrency: 5,
    // Threads gửi 2 lời gọi (mỗi lời ≤30 giây).
    expireInSeconds: 120,
    pollingIntervalSeconds: 0.5,
    critical: true,
  },
  // Module `inbox` (Story 4.7): mỗi 5 phút đưa tin kẹt `sending` quá 15 phút về `failed` `SEND_UNKNOWN` (worker chết giữa
  // lời gọi Meta — có thể đã tới khách nên không tự gửi lại). Idempotent; cron chạy lại sau 5 phút → retry 1.
  'inbox.send_sweep': {
    policy: 'standard',
    retryLimit: 1,
    concurrency: 1,
    expireInSeconds: 60,
    cron: { expression: '*/5 * * * *', tz: CRON_TZ },
  },
  // Module `inbox` (Story 4.5, AD-20, AD-24): tin của chính trang (echo) chưa khớp tin nào app gửi → thử khớp lại.
  // `webhook.route` thử lần đầu ngay rồi enqueue job `startAfter` 5 giây; chưa khớp thì handler ném để retry sau 5 giây
  // (không backoff). Lần chạy thứ 3 chèn `app_unmatched` / `external_human`; lượt retry thứ 4 chỉ dự phòng lỗi bất ngờ
  // (DB…). Idempotent: tin đã gắn id → `duplicate`. Hỏi job 0,5 giây như `webhook.route`.
  'inbox.echo_match': {
    policy: 'standard',
    retryLimit: 3,
    retryDelay: 5,
    concurrency: 5,
    expireInSeconds: 60,
    pollingIntervalSeconds: 0.5,
  },
} as const satisfies { [N in keyof QueuePayloads]: QueueDef }

export type QueueName = keyof typeof QUEUES
export type QueueRegistry = Readonly<Record<string, QueueDef>>

export class UnknownQueueError extends Error {
  readonly code = 'UNKNOWN_QUEUE'
  readonly queue: string
  constructor(queue: string) {
    super(`UNKNOWN_QUEUE: queue "${queue}" không khai báo trong platform/jobs/queues.ts`)
    this.name = 'UnknownQueueError'
    this.queue = queue
  }
}

export class InvalidQueueRegistryError extends Error {
  readonly code = 'INVALID_QUEUE_REGISTRY'
}

const QUEUE_NAME = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/

/** Kiểm luật AD-24 trên registry; ném lỗi ở lúc khởi động thay vì để pg-boss âm thầm bỏ qua. */
export function validateRegistry(registry: QueueRegistry): void {
  for (const [name, def] of Object.entries(registry)) {
    const fail = (why: string) => {
      throw new InvalidQueueRegistryError(`queue "${name}": ${why}`)
    }
    if (!QUEUE_NAME.test(name)) fail('tên phải dạng <module>.<action>')
    if (def.policy !== 'standard' && def.policy !== 'stately') fail(`policy "${String((def as { policy: unknown }).policy)}" không được dùng`)
    if (def.singletonKey !== undefined && def.policy !== 'stately') fail('singletonKey chỉ dùng với policy stately')
    if (def.policy === 'stately' && typeof def.singletonKey !== 'function') fail('queue stately cần hàm singletonKey')
    if (!Number.isInteger(def.concurrency) || def.concurrency < 1) fail('concurrency phải là số nguyên ≥ 1')
    if (!Number.isInteger(def.retryLimit) || def.retryLimit < 0) fail('retryLimit phải là số nguyên ≥ 0')
    if (def.cron) {
      if (def.policy !== 'standard') fail('cron chỉ khai báo trên queue standard')
      if (def.cron.tz !== CRON_TZ) fail(`cron phải dùng tz "${CRON_TZ}"`)
    }
    if (def.pollingIntervalSeconds !== undefined && !(def.pollingIntervalSeconds >= 0.5)) {
      fail('pollingIntervalSeconds phải ≥ 0.5')
    }
    for (const event of def.subscribes ?? []) {
      if (!isEventName(event)) fail(`subscribes "${String(event)}" không có trong packages/shared/events.ts`)
    }
  }
}

/** Queue có `critical: true` (job hết retry ở đây → thông báo `system_error`). */
export function isCriticalQueue(name: string, registry: QueueRegistry = QUEUES): boolean {
  return isQueueName(name, registry) && registry[name]!.critical === true
}

export function isQueueName(name: string, registry: QueueRegistry = QUEUES): boolean {
  return Object.hasOwn(registry, name)
}

export function getQueueDef(name: string, registry: QueueRegistry = QUEUES): QueueDef {
  if (!isQueueName(name, registry)) throw new UnknownQueueError(name)
  return registry[name]!
}

export interface SendJobOptions {
  startAfter?: Date | number | string
  /** Executor của transaction đang mở (pg-boss `db`), để enqueue cùng transaction (AD-2). */
  db?: BossDb
}

export interface JobSender {
  send<N extends QueueName>(name: N, data: QueuePayloads[N], options?: SendJobOptions): Promise<string | null>
}

/** Wrapper duy nhất để enqueue: chỉ tên trong registry, singletonKey tự suy cho queue stately. */
export function createJobSender(
  boss: Pick<PgBoss, 'send'>,
  registry: QueueRegistry = QUEUES,
): JobSender {
  validateRegistry(registry)
  return {
    async send(name, data, options = {}) {
      const def = getQueueDef(name, registry)
      const sendOptions: SendOptions = {}
      if (options.startAfter !== undefined) sendOptions.startAfter = options.startAfter
      if (options.db) sendOptions.db = options.db
      if (def.policy === 'stately') {
        const key = (def.singletonKey as (d: unknown) => string)(data)
        if (typeof key !== 'string' || key === '') {
          throw new InvalidQueueRegistryError(`queue "${name}": singletonKey suy từ payload rỗng`)
        }
        sendOptions.singletonKey = key
      }
      return boss.send(name, data as object, sendOptions)
    },
  }
}
