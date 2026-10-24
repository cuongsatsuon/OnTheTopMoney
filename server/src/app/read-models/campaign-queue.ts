// Read-model hàng đợi "Bài chờ duyệt" (Story 7.4, AD-18, AD-15): ghép slot `pending_approval` (`content`) với tên / chế độ
// chiến dịch đã bắt đầu (`campaigns`) cho `/chien-dich`. Chỉ đọc. Phạm vi lọc theo trang của từng bài (không theo cả chiến
// dịch); bài xem trước của nháp còn `held` nên không vào hàng đợi.
import { PENDING_SLOTS_MAX, type PendingSlotsResponse } from '@ottm/shared'
import { listCampaigns } from '../../modules/campaigns/index.ts'
import { listPendingSlots } from '../../modules/content/index.ts'
import type { DbExecutor } from '../../platform/db/index.ts'

/** `pageIds` = tập trang của phạm vi (`null` = mọi trang). */
export async function pendingQueue(db: DbExecutor, pageIds: readonly string[] | null): Promise<PendingSlotsResponse> {
  const started = (await listCampaigns(db, pageIds)).filter((c) => c.status === 'running' || c.status === 'paused')
  const byId = new Map(started.map((c) => [c.id, c]))
  const rows = await listPendingSlots(db, { campaignIds: [...byId.keys()], pageIds, limit: PENDING_SLOTS_MAX + 1 })
  const items = rows.slice(0, PENDING_SLOTS_MAX).map((slot) => {
    const c = byId.get(slot.campaignId)!
    return { ...slot, campaignName: c.name, campaignMode: c.mode }
  })
  return { items, truncated: rows.length > PENDING_SLOTS_MAX }
}
