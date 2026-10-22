// Đường phát sự kiện miền DUY NHẤT (AD-3).
// - pg-boss `publish` trong transaction của caller → mọi queue đã subscribe nhận job khi commit.
// - Sự kiện `realtime=true` → `pg_notify('realtime', {type, entity, id, pageId})` trong CÙNG transaction:
//   Postgres chỉ giao NOTIFY khi commit, rollback thì không — không cần outbox riêng.
// - Module không tự NOTIFY; chỉ gọi `publishEvent`.
import {
  EVENTS,
  REALTIME_HINT_MAX_BYTES,
  isEventName,
  parseEventPayload,
  realtimeHint,
  type EventName,
  type EventPayload,
} from '@ottm/shared'
import { sql as dsql } from 'drizzle-orm'
import type { PgBoss } from 'pg-boss'
import { bossDbFor, type DbExecutor } from '../db/index.ts'

/** Kênh LISTEN/NOTIFY mà `platform/realtime` nghe. */
export const REALTIME_CHANNEL = 'realtime'

/**
 * Dữ liệu job mà consumer nhận: một queue có thể subscribe nhiều sự kiện nên job mang kèm tên
 * sự kiện, payload giữ nguyên như đã kiểm bằng zod.
 */
export interface EventEnvelope<N extends EventName = EventName> {
  event: N
  payload: EventPayload<N>
}

export function isEventEnvelope(data: unknown): data is EventEnvelope {
  return (
    typeof data === 'object' &&
    data !== null &&
    typeof (data as { event?: unknown }).event === 'string' &&
    isEventName((data as { event: string }).event) &&
    typeof (data as { payload?: unknown }).payload === 'object'
  )
}

/** Kiểm lại envelope từ job (dữ liệu từ DB coi như không tin cậy) — ném ZodError nếu sai. */
export function parseEventEnvelope(data: unknown): EventEnvelope {
  if (!isEventEnvelope(data)) throw new Error('job không phải envelope sự kiện hợp lệ')
  return { event: data.event, payload: parseEventPayload(data.event, data.payload) }
}

export class RealtimeHintTooLargeError extends Error {
  readonly code = 'REALTIME_HINT_TOO_LARGE'
}

export interface EventPublisher {
  /**
   * Phát `name` với `payload` (kiểm bằng zod của danh mục). Gọi bên trong transaction của thay đổi
   * trạng thái; truyền `db` (không transaction) chỉ khi không có thay đổi nào khác cần nguyên tử.
   */
  publishEvent<N extends EventName>(tx: DbExecutor, name: N, payload: EventPayload<N>): Promise<void>
}

export function createEventPublisher(boss: Pick<PgBoss, 'publish'>): EventPublisher {
  return {
    async publishEvent(tx, name, payload) {
      if (!isEventName(name)) throw new Error(`sự kiện "${String(name)}" không có trong packages/shared/events.ts`)
      const parsed = parseEventPayload(name, payload)
      let hint: string | undefined
      if (EVENTS[name].realtime) {
        hint = JSON.stringify(realtimeHint(name, parsed))
        const bytes = Buffer.byteLength(hint, 'utf8')
        if (bytes > REALTIME_HINT_MAX_BYTES) {
          // Lỗi lập trình: id/pageId bất thường. Từ chối trước khi ghi gì.
          throw new RealtimeHintTooLargeError(`payload realtime của "${name}" ${bytes} byte > ${REALTIME_HINT_MAX_BYTES}`)
        }
      }
      const envelope: EventEnvelope = { event: name, payload: parsed }
      await boss.publish(name, envelope, { db: bossDbFor(tx) })
      if (hint !== undefined) {
        await tx.execute(dsql`select pg_notify(${REALTIME_CHANNEL}, ${hint})`)
      }
    },
  }
}
