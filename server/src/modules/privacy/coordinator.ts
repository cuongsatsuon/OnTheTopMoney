// Điều phối luồng xoá (Story 9.2, AD-22, AD-3). `privacy` là điều phối DUY NHẤT; module khác báo cho nó qua sự kiện.
// - `handlePrivacyEvent` (queue `events.privacy`): nghe `privacy.purge_part_completed{id, module}` → ghi phần đã xong
//   (`deletion_request_parts`, trùng thì bỏ), `pending → processing`; đủ phần giai đoạn 1 (`PURGE_MODULES[scope]`) → phát
//   `privacy.purge_final_requested` đúng MỘT lần (`final_requested_at`); phần cuối (`inbox`) về → `completed` +
//   `privacy.purge_completed`. Khoá dòng yêu cầu `FOR UPDATE` nên các phần về song song không đè nhau.
// - `resumeStalledRequests` (cron `privacy.purge_resume`): yêu cầu mở quá 1 giờ không tiến triển (job hết retry, worker
//   tắt lâu, sự kiện phát lúc chưa có consumer) → phát lại giai đoạn đang dở. Handler của module idempotent nên phát lại
//   chỉ xoá tiếp phần còn lại. Yêu cầu `all` của 9.1 thiếu ảnh chụp trang → bỏ qua + cảnh báo (không đoán phạm vi).
// - `sweepRemovedPages` (cron `privacy.removed_pages`): trang gỡ quá 30 ngày chưa có yêu cầu sau lần gỡ → `scope=page`.
// - Yêu cầu của cron trang gỡ (`source=page_removed`) mà trang đã được kết nối lại (review 9.2) → đóng yêu cầu thay vì
//   phát giai đoạn cuối / phát lại: không xoá dữ liệu của trang đang dùng (kể cả tin mới sau khi kết nối lại).
// Log chỉ mang id yêu cầu, module, số đếm (AD-12).
import { PURGE_FINAL_MODULE, PURGE_MODULES, PURGE_MODULE_NAMES, type DeletionScope, type PurgeModule } from '@ottm/shared'
import { eq, sql } from 'drizzle-orm'
import { getPage, listRemovedBefore } from '../pages/index.ts'
import type { Db, DbExecutor } from '../../platform/db/index.ts'
import { isEventEnvelope, type EventPublisher } from '../../platform/events/index.ts'
import type { Logger } from '../../platform/log/index.ts'
import { latestTargetRequest, publishPurgeRequested, requestTargetDeletion, type Row } from './requests.ts'
import { deletionRequestParts, deletionRequests } from './schema.ts'

/** Trang gỡ quá mức này thì dữ liệu khách / hội thoại bị xoá (AD-22 retention [ASSUMPTION]). */
export const REMOVED_PAGE_RETENTION_MS = 30 * 24 * 60 * 60_000
/** Yêu cầu mở không có hoạt động quá mức này → cron phát lại giai đoạn đang dở. */
export const PURGE_STALL_MS = 60 * 60_000

export interface CoordinatorDeps {
  db: Db
  events: EventPublisher
  log?: Logger | undefined
  now?: () => Date
}

const isPurgeModule = (m: unknown): m is PurgeModule => typeof m === 'string' && (PURGE_MODULE_NAMES as readonly string[]).includes(m)

async function publishFinal(tx: DbExecutor, events: EventPublisher, row: Row): Promise<void> {
  await events.publishEvent(tx, 'privacy.purge_final_requested', {
    id: row.id,
    scope: row.scope as DeletionScope,
    targetId: row.targetId,
    ...(row.conversationIds ? { conversationIds: row.conversationIds } : {}),
    ...(row.pageIds ? { pageIds: row.pageIds } : {}),
  })
}

/** Yêu cầu của cron trang gỡ mà trang đã kết nối lại (`getPage` chỉ trả trang chưa gỡ). */
async function pageReconnected(tx: DbExecutor, row: Row): Promise<boolean> {
  return row.source === 'page_removed' && row.targetId !== null && (await getPage(tx, row.targetId)) !== null
}

/** Đóng yêu cầu không xoá tiếp (trang đã kết nối lại) — không phát `purge_completed` vì dữ liệu được giữ. */
async function closeReconnected(tx: DbExecutor, row: Row): Promise<void> {
  await tx.update(deletionRequests).set({ status: 'completed', completedAt: sql`now()`, lastPublishedAt: sql`now()` }).where(eq(deletionRequests.id, row.id))
}

export type PrivacyEventResult = 'ignored' | 'missing' | 'already_completed' | 'recorded' | 'final_requested' | 'completed' | 'page_reconnected'

export async function handlePrivacyEvent(deps: CoordinatorDeps, data: unknown): Promise<PrivacyEventResult> {
  if (!isEventEnvelope(data) || data.event !== 'privacy.purge_part_completed') return 'ignored'
  const { id, module } = data.payload as { id?: unknown; module?: unknown }
  if (typeof id !== 'string' || !isPurgeModule(module)) return 'ignored'
  return deps.db.transaction(async (tx) => {
    const [row] = await tx.select().from(deletionRequests).where(eq(deletionRequests.id, id)).for('update')
    if (!row) return 'missing'
    if (row.status === 'completed') return 'already_completed'
    const expected = PURGE_MODULES[row.scope as DeletionScope]
    if (module !== PURGE_FINAL_MODULE && !expected.includes(module)) return 'ignored'

    await tx.insert(deletionRequestParts).values({ requestId: row.id, module }).onConflictDoNothing()
    const done = new Set((await tx.select({ module: deletionRequestParts.module }).from(deletionRequestParts).where(eq(deletionRequestParts.requestId, row.id))).map((p) => p.module))
    const dependentsDone = expected.every((m) => done.has(m))

    if (module === PURGE_FINAL_MODULE && dependentsDone) {
      await tx.update(deletionRequests).set({ status: 'completed', completedAt: sql`now()`, lastPublishedAt: sql`now()` }).where(eq(deletionRequests.id, row.id))
      await deps.events.publishEvent(tx, 'privacy.purge_completed', { id: row.id })
      return 'completed'
    }
    await tx.update(deletionRequests).set({ status: 'processing', lastPublishedAt: sql`now()` }).where(eq(deletionRequests.id, row.id))
    if (dependentsDone && row.finalRequestedAt === null) {
      if (await pageReconnected(tx, row)) {
        await closeReconnected(tx, row)
        return 'page_reconnected'
      }
      await tx.update(deletionRequests).set({ finalRequestedAt: sql`now()` }).where(eq(deletionRequests.id, row.id))
      await publishFinal(tx, deps.events, row)
      return 'final_requested'
    }
    return 'recorded'
  })
}

export interface ResumeResult {
  republished: number
  /** Yêu cầu `all` của 9.1 không có ảnh chụp trang — không phát lại được. */
  skippedLegacy: number
  /** Yêu cầu của cron trang gỡ mà trang đã kết nối lại — đóng, không phát lại. */
  closedReconnected: number
}

export async function resumeStalledRequests(deps: CoordinatorDeps): Promise<ResumeResult> {
  const cutoff = new Date((deps.now?.() ?? new Date()).getTime() - PURGE_STALL_MS)
  const stalled = await deps.db
    .select({ id: deletionRequests.id })
    .from(deletionRequests)
    .where(sql`${deletionRequests.status} <> 'completed' and coalesce(${deletionRequests.lastPublishedAt}, ${deletionRequests.requestedAt}) < ${cutoff.toISOString()}::timestamptz`)
  const result: ResumeResult = { republished: 0, skippedLegacy: 0, closedReconnected: 0 }
  for (const { id } of stalled) {
    const outcome = await deps.db.transaction(async (tx) => {
      const [row] = await tx.select().from(deletionRequests).where(eq(deletionRequests.id, id)).for('update')
      if (!row || row.status === 'completed') return 'none' as const
      if (row.scope === 'all' && row.pageIds === null) return 'legacy' as const
      if (await pageReconnected(tx, row)) {
        await closeReconnected(tx, row)
        return 'reconnected' as const
      }
      if (row.finalRequestedAt !== null) {
        await publishFinal(tx, deps.events, row)
        await tx.update(deletionRequests).set({ lastPublishedAt: sql`now()` }).where(eq(deletionRequests.id, row.id))
      } else {
        await publishPurgeRequested(tx, deps.events, row)
      }
      return 'republished' as const
    })
    if (outcome === 'legacy') {
      result.skippedLegacy++
      deps.log?.warn({ requestId: id }, 'privacy: yêu cầu cũ thiếu ảnh chụp phạm vi trang — không phát lại, cần xử lý tay')
    } else if (outcome === 'reconnected') {
      result.closedReconnected++
      deps.log?.warn({ requestId: id }, 'privacy: trang đã kết nối lại — đóng yêu cầu xoá của trang gỡ, không xoá tiếp')
    } else if (outcome === 'republished') {
      result.republished++
      deps.log?.info({ requestId: id }, 'privacy: phát lại yêu cầu xoá đang dở')
    }
  }
  return result
}

/** Tạo yêu cầu `scope=page` cho trang gỡ quá 30 ngày; trả số yêu cầu mới. */
export async function sweepRemovedPages(deps: CoordinatorDeps): Promise<number> {
  const cutoff = new Date((deps.now?.() ?? new Date()).getTime() - REMOVED_PAGE_RETENTION_MS)
  let created = 0
  for (const page of await listRemovedBefore(deps.db, cutoff)) {
    const latest = await latestTargetRequest(deps.db, 'page', page.id)
    // Đã có yêu cầu sau lần gỡ này (đang chạy hoặc đã xong) → không tạo lại. Gỡ lại sau khi kết nối lại → mốc mới.
    if (latest && (latest.status !== 'completed' || latest.requestedAt >= page.removedAt)) continue
    // Kiểm lại trong transaction: trang kết nối lại giữa lúc liệt kê và lúc ghi → không tạo yêu cầu.
    const res = await deps.db.transaction(async (tx) =>
      (await getPage(tx, page.id)) ? null : requestTargetDeletion(tx, deps.events, { scope: 'page', targetId: page.id, source: 'page_removed' }),
    )
    if (res?.created) {
      created++
      deps.log?.info({ requestId: res.request.id }, 'privacy: tạo yêu cầu xoá dữ liệu trang gỡ quá 30 ngày')
    }
  }
  return created
}

