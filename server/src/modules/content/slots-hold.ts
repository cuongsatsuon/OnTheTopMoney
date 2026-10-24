// Giữ / thả / huỷ hàng loạt slot của một chiến dịch (Story 7.5, AD-15, AD-13). `campaigns` gọi trong transaction tạm
// dừng / tiếp tục / xoá của nó (đã khoá dòng chiến dịch) — `content` không biết lý do dừng hay trạng thái chiến dịch (AD-1):
// - `holdCampaignTargets`: mọi bài chưa đăng xong (`planned|pending_approval|scheduled|publishing|failed`) → `held`. Job
//   `publish.target` đã chờ sẵn tự bỏ qua (kiểm `held` cả lúc đọc lẫn lúc chiếm), cron `content.requeue` không enqueue lại.
//   Bài `publishing` (đang gọi Meta) chạy hết lần đó; nếu lỗi tạm đưa bài về `scheduled` thì vẫn `held` → lần retry bỏ qua.
// - `releaseCampaignTargets`: bài lỡ giờ trong lúc dừng → `cancelled MISSED_WHILE_PAUSED` (không đăng dồn); bài
//   `scheduled` còn tương lai → bỏ `held`, `schedule_version + 1`, enqueue lại `publish.target`; còn lại chỉ bỏ `held`.
// - `cancelCampaignTargets`: xoá chiến dịch (Story 7.6: trang rời nhóm nhãn — theo `pageId`) — huỷ bài chưa đăng, giữ bài
//   `publishing` / `published`. Xoá cả chiến dịch: bài `publishing` thêm `held` — lỗi tạm đưa bài về `scheduled` thì lần
//   retry bỏ qua (không đăng sau khi đã xoá); cron `campaigns.complete_check` huỷ nốt qua `heldCampaignIds`.
// - `cancelPageTargets` (Story 7.6): gỡ trang — huỷ bài chưa đăng của trang đó (cả bài thủ công), consumer `events.content`.
// Không phát `post_target.cancelled` từng bài: bên gọi phát một sự kiện cấp chiến dịch (Lịch / danh sách làm cũ theo đó).
// Thứ tự khoá: dòng chiến dịch (bên gọi) → dòng slot theo id — cùng chiều "Bắt đầu" và "Tự đăng".
import { CAMPAIGN_SLOT_MIN_LEAD_MS, type CancelReason, type PostTargetStatus } from '@ottm/shared'
import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import { bossDbFor, type DbExecutor } from '../../platform/db/index.ts'
import { postTargets } from './schema.ts'
import type { TransitionDeps } from './transitions.ts'

/** Bài chưa đăng xong — tạm dừng giữ lại. */
const HOLDABLE: readonly PostTargetStatus[] = ['planned', 'pending_approval', 'scheduled', 'publishing', 'failed']
/** Bài còn chờ tới giờ — tiếp tục huỷ nếu lỡ giờ. */
const UPCOMING: readonly PostTargetStatus[] = ['planned', 'pending_approval', 'scheduled']
/** Bài chưa lên trang và không đang gọi Meta — xoá chiến dịch huỷ được. */
const CANCELLABLE: readonly PostTargetStatus[] = ['planned', 'pending_approval', 'scheduled', 'failed']
/** Slot còn mở — chiến dịch chưa xong (cron `campaigns.complete_check`). */
const OPEN: readonly PostTargetStatus[] = ['planned', 'pending_approval', 'scheduled', 'publishing']

/** Khoá mọi slot của chiến dịch theo id (tới hết transaction của bên gọi). */
async function lockSlots(tx: DbExecutor, campaignId: string): Promise<void> {
  await tx.select({ id: postTargets.id }).from(postTargets).where(eq(postTargets.campaignId, campaignId)).orderBy(asc(postTargets.id)).for('update')
}

/** Tạm dừng: đặt `held` cho mọi bài chưa đăng xong của chiến dịch. Trả số bài vừa giữ. */
export async function holdCampaignTargets(tx: DbExecutor, campaignId: string): Promise<number> {
  await lockSlots(tx, campaignId)
  const rows = await tx
    .update(postTargets)
    .set({ held: true, version: sql`${postTargets.version} + 1`, updatedAt: sql`now()` })
    .where(and(eq(postTargets.campaignId, campaignId), eq(postTargets.held, false), inArray(postTargets.status, [...HOLDABLE])))
    .returning({ id: postTargets.id })
  return rows.length
}

export interface ReleaseResult {
  /** Bài lỡ giờ trong lúc dừng → `cancelled MISSED_WHILE_PAUSED`. */
  missed: number
  /** Bài `scheduled` còn tương lai → enqueue lại `publish.target`. */
  rescheduled: number
  /** Bài còn lại chỉ bỏ `held`. */
  released: number
}

/**
 * Tiếp tục: thả các bài `held` của chiến dịch. "Lỡ giờ" = giờ đăng (`scheduled_at`, chưa có thì `slot_at`) không còn
 * quá `CAMPAIGN_SLOT_MIN_LEAD_MS` sau `now` — cùng mốc `SCHEDULE_IN_PAST` của duyệt.
 */
export async function releaseCampaignTargets(tx: DbExecutor, deps: Pick<TransitionDeps, 'jobs'>, campaignId: string, now: Date): Promise<ReleaseResult> {
  await lockSlots(tx, campaignId)
  const cutoff = new Date(now.getTime() + CAMPAIGN_SLOT_MIN_LEAD_MS).toISOString()
  const due = sql`coalesce(${postTargets.scheduledAt}, ${postTargets.slotAt}) <= ${cutoff}::timestamptz`
  const mine = and(eq(postTargets.campaignId, campaignId), eq(postTargets.held, true))

  const missed = await tx
    .update(postTargets)
    .set({
      status: 'cancelled' satisfies PostTargetStatus,
      cancelReason: 'MISSED_WHILE_PAUSED' satisfies CancelReason,
      errorCode: null,
      held: false,
      generateLeaseUntil: null,
      // Rời `scheduled` → job đang chờ (nếu có) thấy lệch rồi bỏ qua.
      scheduleVersion: sql`case when ${postTargets.status} = 'scheduled' then ${postTargets.scheduleVersion} + 1 else ${postTargets.scheduleVersion} end`,
      version: sql`${postTargets.version} + 1`,
      updatedAt: sql`now()`,
    })
    .where(and(mine, inArray(postTargets.status, [...UPCOMING]), due))
    .returning({ id: postTargets.id })

  const rescheduled = await tx
    .update(postTargets)
    .set({ held: false, scheduleVersion: sql`${postTargets.scheduleVersion} + 1`, version: sql`${postTargets.version} + 1`, updatedAt: sql`now()` })
    .where(and(mine, eq(postTargets.status, 'scheduled' satisfies PostTargetStatus)))
    .returning({ id: postTargets.id, scheduleVersion: postTargets.scheduleVersion, scheduledAt: postTargets.scheduledAt })
  for (const t of rescheduled) {
    await deps.jobs.send('publish.target', { targetId: t.id, scheduleVersion: t.scheduleVersion }, { startAfter: t.scheduledAt!, db: bossDbFor(tx) })
  }

  // Bài chưa tới giờ (`planned|pending_approval`), `failed`, `publishing` (đang gọi Meta), và bài vừa đăng xong lúc dừng.
  const released = await tx
    .update(postTargets)
    .set({ held: false, version: sql`${postTargets.version} + 1`, updatedAt: sql`now()` })
    .where(mine)
    .returning({ id: postTargets.id })
  return { missed: missed.length, rescheduled: rescheduled.length, released: released.length }
}

export interface CancelCampaignResult {
  /** Bài chưa đăng vừa huỷ. */
  cancelled: number
  /** Bài đã đăng / đang đăng giữ nguyên. */
  kept: number
}

/**
 * Huỷ bài chưa đăng của chiến dịch (`pageId` = chỉ của trang đó) với lý do `reason`; bài `publishing` / `published`
 * giữ nguyên (bài đang gọi Meta chạy hết lần đăng đó).
 */
export async function cancelCampaignTargets(
  tx: DbExecutor,
  campaignId: string,
  reason: CancelReason,
  opts: { pageId?: string } = {},
): Promise<CancelCampaignResult> {
  await lockSlots(tx, campaignId)
  const scope = and(eq(postTargets.campaignId, campaignId), opts.pageId ? eq(postTargets.pageId, opts.pageId) : undefined)
  const cancelled = await tx
    .update(postTargets)
    .set({
      status: 'cancelled' satisfies PostTargetStatus,
      cancelReason: reason,
      errorCode: null,
      held: false,
      generateLeaseUntil: null,
      scheduleVersion: sql`case when ${postTargets.status} = 'scheduled' then ${postTargets.scheduleVersion} + 1 else ${postTargets.scheduleVersion} end`,
      version: sql`${postTargets.version} + 1`,
      updatedAt: sql`now()`,
    })
    .where(and(scope, inArray(postTargets.status, [...CANCELLABLE])))
    .returning({ id: postTargets.id })
  if (!opts.pageId) {
    await tx
      .update(postTargets)
      .set({ held: true, version: sql`${postTargets.version} + 1`, updatedAt: sql`now()` })
      .where(and(scope, eq(postTargets.status, 'publishing' satisfies PostTargetStatus), eq(postTargets.held, false)))
  }
  const [kept] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(postTargets)
    .where(and(scope, inArray(postTargets.status, ['publishing', 'published'] satisfies PostTargetStatus[])))
  return { cancelled: cancelled.length, kept: kept?.n ?? 0 }
}

/**
 * Story 7.6 (AD-23): huỷ bài chưa đăng của trang `pageId` (bài thủ công lẫn slot chiến dịch) với lý do `reason` — gỡ
 * trang. `planned|pending_approval|scheduled|failed` → `cancelled`; nháp thủ công (`draft` — chưa lên lịch, không tự đăng),
 * `publishing` / `published` giữ nguyên. Idempotent (bài đã huỷ không khớp lần sau). Trả số bài vừa huỷ.
 */
export async function cancelPageTargets(tx: DbExecutor, pageId: string, reason: CancelReason): Promise<number> {
  await tx.select({ id: postTargets.id }).from(postTargets).where(eq(postTargets.pageId, pageId)).orderBy(asc(postTargets.id)).for('update')
  const rows = await tx
    .update(postTargets)
    .set({
      status: 'cancelled' satisfies PostTargetStatus,
      cancelReason: reason,
      errorCode: null,
      held: false,
      generateLeaseUntil: null,
      scheduleVersion: sql`case when ${postTargets.status} = 'scheduled' then ${postTargets.scheduleVersion} + 1 else ${postTargets.scheduleVersion} end`,
      version: sql`${postTargets.version} + 1`,
      updatedAt: sql`now()`,
    })
    .where(and(eq(postTargets.pageId, pageId), inArray(postTargets.status, [...CANCELLABLE])))
    .returning({ id: postTargets.id })
  return rows.length
}

/** Số slot còn mở (`planned|pending_approval|scheduled|publishing`) theo chiến dịch; chiến dịch không có → 0 (không có trong map). */
export async function openCampaignSlots(db: DbExecutor, campaignIds: readonly string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  if (!campaignIds.length) return out
  const rows = await db
    .select({ campaignId: postTargets.campaignId, n: sql<number>`count(*)::int` })
    .from(postTargets)
    .where(and(inArray(postTargets.campaignId, [...campaignIds]), inArray(postTargets.status, [...OPEN])))
    .groupBy(postTargets.campaignId)
  for (const r of rows) out.set(r.campaignId!, r.n)
  return out
}

/** Chiến dịch có bài `held` chưa đăng (`planned|pending_approval|scheduled|failed`) — cron tìm bài sót của chiến dịch đã xoá. */
export async function heldCampaignIds(db: DbExecutor): Promise<string[]> {
  const rows = await db
    .selectDistinct({ campaignId: postTargets.campaignId })
    .from(postTargets)
    .where(and(eq(postTargets.held, true), inArray(postTargets.status, [...CANCELLABLE])))
  return rows.flatMap((r) => (r.campaignId ? [r.campaignId] : []))
}

/** Chiến dịch xong (`done`): bỏ `held` còn sót (bài `failed` giữ lúc tạm dừng) — chủ shop "Đăng lại" được. */
export async function clearCampaignHolds(tx: DbExecutor, campaignId: string): Promise<void> {
  await tx
    .update(postTargets)
    .set({ held: false, version: sql`${postTargets.version} + 1`, updatedAt: sql`now()` })
    .where(and(eq(postTargets.campaignId, campaignId), eq(postTargets.held, true)))
}
