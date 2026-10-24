// Tạm dừng, tiếp tục, xoá và hoàn tất chiến dịch (Story 7.5, AD-15, AD-13). Một cặp hàm DUY NHẤT cho cả chủ shop
// (`MANUAL`) lẫn hệ thống (Story 7.6 — trang mất kết nối, hết hạn mức AI, thiếu hồ sơ, đăng lỗi liên tiếp):
// - `pauseCampaign`: MỘT transaction của bên gọi — `paused` + `pause_reason` + `content.holdCampaignTargets` (`held` cho
//   mọi bài chưa đăng xong; job đăng tới giờ bỏ qua, cron sinh nội dung bỏ qua chiến dịch `paused`), phát `campaign.paused`
//   (thông báo bỏ qua `MANUAL`). Đã dừng vì `MANUAL` mà hệ thống báo sự cố → đổi lý do (Tiếp tục khi đó vẫn kiểm sự cố).
// - `resumeCampaign`: lý do tự dừng còn (trang vẫn mất kết nối / thiếu hồ sơ, hạn mức vẫn 100%) → 409 mã = lý do. Ngược
//   lại `content.releaseCampaignTargets` (bài lỡ giờ → `cancelled MISSED_WHILE_PAUSED`, không đăng dồn; bài tương lai
//   enqueue lại), `consecutive_failures = 0`, `campaign.resumed`, enqueue `campaigns.generate` (viết tiếp ngay). Story 7.6:
//   khoá OpenAI vẫn chưa dùng được → 409 mã = lỗi khoá (`OPENAI_KEY_UNAVAILABLE`); bỏ cả danh sách target đã đếm lỗi.
// - `deleteCampaign`: `content.cancelCampaignTargets(CAMPAIGN_DELETED)` (bài đã đăng / đang đăng giữ nguyên) rồi xoá dòng.
// - `runCompleteCheck` (cron `campaigns.complete_check`): chiến dịch `running|paused` không còn slot mở → `done` (bỏ
//   `held` còn sót). Kèm dọn bài `held` của chiến dịch đã xoá (bài `publishing` lúc xoá, lỗi tạm → về `scheduled`).
// Thứ tự khoá: dòng chiến dịch (`FOR UPDATE`) → dòng slot theo id (`content`) — cùng chiều "Bắt đầu" và lượt sinh.
import type { CampaignStatus, PauseReason } from '@ottm/shared'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { bossDbFor, type Db, type DbExecutor } from '../../platform/db/index.ts'
import { AppError } from '../../platform/errors/index.ts'
import type { EventPublisher } from '../../platform/events/index.ts'
import type { JobSender } from '../../platform/jobs/index.ts'
import { getBudgetSummary, getUsableOpenAiKey, type AiDeps } from '../ai/index.ts'
import {
  cancelCampaignTargets,
  clearCampaignHolds,
  heldCampaignIds,
  holdCampaignTargets,
  openCampaignSlots,
  releaseCampaignTargets,
  type CancelCampaignResult,
} from '../content/index.ts'
import { getPage } from '../pages/index.ts'
import { getCampaign } from './drafts.ts'
import { pageBlockReason } from './pages.ts'
import { campaigns } from './schema.ts'

export interface LifecycleDeps {
  jobs: JobSender
  events: EventPublisher
  /** Story 7.6: giải mã khoá OpenAI khi kiểm lý do `OPENAI_KEY_UNAVAILABLE` lúc tiếp tục (thiếu → coi như chưa cấu hình mã hoá). */
  cipher?: AiDeps['cipher'] | undefined
}

export interface LifecycleResult {
  /** Có đổi trạng thái / lý do không (bấm lại → `false`, không đổi gì). */
  changed: boolean
  /** Bài vừa huỷ vì lỡ giờ trong lúc dừng (chỉ khi tiếp tục). */
  missed: number
}

const notFound = (id: string) => new AppError('NOT_FOUND', 404, { message: 'Chiến dịch không tồn tại', details: { campaignId: id } })
const wrongStatus = (id: string, status: CampaignStatus) =>
  new AppError('VERSION_CONFLICT', 409, {
    message: status === 'draft' ? 'Chiến dịch chưa bắt đầu' : 'Chiến dịch đã xong',
    details: { campaignId: id, status },
  })

async function lockCampaign(tx: DbExecutor, id: string) {
  const [row] = await tx
    .select({ status: campaigns.status, pauseReason: campaigns.pauseReason, pausedAt: campaigns.pausedAt })
    .from(campaigns)
    .where(eq(campaigns.id, id))
    .for('update')
  if (!row) throw notFound(id)
  return { status: row.status as CampaignStatus, pauseReason: row.pauseReason as PauseReason | null, pausedAt: row.pausedAt }
}

/**
 * Tạm dừng chiến dịch `id` với lý do `reason` (chạy trong transaction của bên gọi). Không có → 404; nháp / đã xong →
 * 409. Đã dừng → không đổi gì, trừ khi lý do đang là `MANUAL` và `reason` là sự cố hệ thống (đổi lý do, phát lại sự kiện).
 */
export async function pauseCampaign(tx: DbExecutor, deps: LifecycleDeps, id: string, reason: PauseReason, now: Date): Promise<LifecycleResult> {
  const row = await lockCampaign(tx, id)
  if (row.status === 'draft' || row.status === 'done') throw wrongStatus(id, row.status)
  if (row.status === 'paused') {
    if (row.pauseReason !== 'MANUAL' || reason === 'MANUAL') return { changed: false, missed: 0 }
    await tx.update(campaigns).set({ pauseReason: reason, updatedAt: sql`now()` }).where(eq(campaigns.id, id))
    await deps.events.publishEvent(tx, 'campaign.paused', { id, reason, pausedAt: (row.pausedAt ?? now).toISOString() })
    return { changed: true, missed: 0 }
  }
  await tx
    .update(campaigns)
    .set({ status: 'paused' satisfies CampaignStatus, pauseReason: reason, pausedAt: now, updatedAt: sql`now()` })
    .where(eq(campaigns.id, id))
  await holdCampaignTargets(tx, id)
  await deps.events.publishEvent(tx, 'campaign.paused', { id, reason, pausedAt: now.toISOString() })
  return { changed: true, missed: 0 }
}

/**
 * Story 7.6: hệ thống tự tạm dừng chiến dịch `id` trong transaction riêng (consumer sự kiện, lượt sinh). Chiến dịch vừa xoá
 * / chưa bắt đầu / đã xong giữa chừng (404 / 409) → bỏ qua. Trả `true` khi vừa đổi trạng thái / lý do.
 */
export async function pauseBySystem(db: Db, deps: LifecycleDeps, id: string, reason: Exclude<PauseReason, 'MANUAL'>, now: Date): Promise<boolean> {
  return db.transaction(async (tx) => {
    try {
      return (await pauseCampaign(tx, deps, id, reason, now)).changed
    } catch (err) {
      if (err instanceof AppError && (err.statusCode === 404 || err.statusCode === 409)) return false
      throw err
    }
  })
}

/**
 * Lý do tự dừng còn không: trang (chưa gỡ) vẫn bị chặn, hạn mức vẫn hết, khoá OpenAI vẫn chưa dùng được (Story 7.6).
 * `MANUAL` / `PUBLISH_FAILURES` không kiểm.
 */
async function assertReasonCleared(tx: DbExecutor, deps: LifecycleDeps, id: string, reason: PauseReason): Promise<void> {
  if (reason === 'PAGE_DISCONNECTED' || reason === 'CONFIG_MISSING') {
    const campaign = (await getCampaign(tx, id))!
    for (const p of campaign.pages) {
      const page = await getPage(tx, p.pageId)
      if (!page) continue
      const blocked = await pageBlockReason(tx, page)
      if (blocked) {
        throw new AppError(blocked, 409, {
          message: blocked === 'PAGE_DISCONNECTED' ? 'Trang của chiến dịch vẫn mất kết nối' : 'Trang của chiến dịch vẫn chưa có hồ sơ thương hiệu',
          details: { campaignId: id, pageId: page.id },
        })
      }
    }
  }
  if (reason === 'AI_BUDGET_EXCEEDED' && (await getBudgetSummary({ db: tx })).state === 'blocked') {
    throw new AppError('AI_BUDGET_EXCEEDED', 409, { message: 'Hạn mức AI tháng này vẫn hết', details: { campaignId: id } })
  }
  if (reason === 'OPENAI_KEY_UNAVAILABLE') {
    try {
      await getUsableOpenAiKey({ db: tx, cipher: deps.cipher ?? null })
    } catch (err) {
      if (!(err instanceof AppError)) throw err
      throw new AppError(err.code, 409, { message: 'Khoá OpenAI vẫn chưa dùng được', details: { campaignId: id } })
    }
  }
}

/**
 * Tiếp tục chiến dịch `id` (chạy trong transaction của bên gọi). Không có → 404; đang chạy → `changed: false`; nháp / đã
 * xong → 409; lý do tự dừng còn → 409 mã = lý do, không đổi gì.
 */
export async function resumeCampaign(tx: DbExecutor, deps: LifecycleDeps, id: string, now: Date): Promise<LifecycleResult> {
  const row = await lockCampaign(tx, id)
  if (row.status === 'running') return { changed: false, missed: 0 }
  if (row.status !== 'paused') throw wrongStatus(id, row.status)
  await assertReasonCleared(tx, deps, id, row.pauseReason ?? 'MANUAL')
  const released = await releaseCampaignTargets(tx, deps, id, now)
  await tx
    .update(campaigns)
    .set({ status: 'running' satisfies CampaignStatus, pauseReason: null, pausedAt: null, consecutiveFailures: 0, failureTargetIds: [], updatedAt: sql`now()` })
    .where(eq(campaigns.id, id))
  await deps.events.publishEvent(tx, 'campaign.resumed', { id })
  // Viết tiếp ngay (slot trong cửa sổ đã chờ suốt lúc dừng); "Tự đăng" duyệt bài chờ duyệt vừa bỏ `held`.
  await deps.jobs.send('campaigns.generate', { campaignId: id }, { db: bossDbFor(tx) })
  return { changed: true, missed: released.missed }
}

/**
 * Xoá chiến dịch `id` ở mọi trạng thái (chạy trong transaction của bên gọi; bên gọi đã hỏi xác nhận). Bài chưa đăng huỷ
 * `CAMPAIGN_DELETED`; bài đã đăng / đang đăng giữ nguyên. Không có → 404.
 */
export async function deleteCampaign(tx: DbExecutor, deps: Pick<LifecycleDeps, 'events'>, id: string): Promise<CancelCampaignResult> {
  await lockCampaign(tx, id)
  const result = await cancelCampaignTargets(tx, id, 'CAMPAIGN_DELETED')
  await tx.delete(campaigns).where(eq(campaigns.id, id))
  await deps.events.publishEvent(tx, 'campaign.deleted', { id })
  return result
}

export interface CompleteCheckDeps {
  db: Db
  events: EventPublisher
}

/** Handler cron `campaigns.complete_check`: chiến dịch `running|paused` không còn slot mở → `done`. Trả số chiến dịch vừa xong. */
export async function runCompleteCheck(deps: CompleteCheckDeps): Promise<number> {
  // Bài `held` sót của chiến dịch đã xoá (đang `publishing` lúc xoá rồi về `scheduled` / `failed`) → huỷ `CAMPAIGN_DELETED`.
  const heldIds = await heldCampaignIds(deps.db)
  if (heldIds.length) {
    const alive = new Set((await deps.db.select({ id: campaigns.id }).from(campaigns).where(inArray(campaigns.id, heldIds))).map((r) => r.id))
    for (const id of heldIds) {
      if (!alive.has(id)) await deps.db.transaction((tx) => cancelCampaignTargets(tx, id, 'CAMPAIGN_DELETED'))
    }
  }

  const active: readonly CampaignStatus[] = ['running', 'paused']
  const rows = await deps.db.select({ id: campaigns.id }).from(campaigns).where(inArray(campaigns.status, [...active]))
  const open = await openCampaignSlots(
    deps.db,
    rows.map((r) => r.id),
  )
  let done = 0
  for (const { id } of rows) {
    if (open.has(id)) continue
    // Kiểm lại dưới khoá dòng (slot chỉ được tạo dưới cùng khoá — "Bắt đầu").
    const completed = await deps.db.transaction(async (tx) => {
      const [row] = await tx.select({ status: campaigns.status }).from(campaigns).where(eq(campaigns.id, id)).for('update')
      if (!row || !active.includes(row.status as CampaignStatus) || (await openCampaignSlots(tx, [id])).has(id)) return false
      await tx
        .update(campaigns)
        .set({ status: 'done' satisfies CampaignStatus, pauseReason: null, pausedAt: null, updatedAt: sql`now()` })
        .where(and(eq(campaigns.id, id), inArray(campaigns.status, [...active])))
      await clearCampaignHolds(tx, id)
      await deps.events.publishEvent(tx, 'campaign.completed', { id })
      return true
    })
    if (completed) done++
  }
  return done
}
