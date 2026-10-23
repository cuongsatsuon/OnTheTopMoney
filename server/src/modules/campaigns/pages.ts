// Trang chọn được làm đích chiến dịch (Story 7.1, AD-15, AD-8). Nguồn DUY NHẤT của luật cho cả API
// `GET /campaigns/page-options` (wizard làm mờ trang + nêu lý do) lẫn kiểm khi lưu nháp (`drafts.ts`):
// - trang `disconnected` → `PAGE_DISCONNECTED` (xét trước; trang `expiring` vẫn chọn được — chiến dịch vẫn chạy);
// - trang chưa có hồ sơ thương hiệu hiệu lực → `CONFIG_MISSING` (giải kế thừa ở `profiles.resolveEffective`).
import type { CampaignPageBlockReason, CampaignPageOption, PageDto } from '@ottm/shared'
import type { DbExecutor } from '../../platform/db/index.ts'
import { listPages } from '../pages/index.ts'
import { resolveEffectiveOrNull } from '../profiles/index.ts'

/** Lý do trang không làm đích được; `null` = chọn được. */
export async function pageBlockReason(db: DbExecutor, page: Pick<PageDto, 'id' | 'connectionStatus'>): Promise<CampaignPageBlockReason | null> {
  if (page.connectionStatus === 'disconnected') return 'PAGE_DISCONNECTED'
  if ((await resolveEffectiveOrNull(db, page.id, 'brand')) === null) return 'CONFIG_MISSING'
  return null
}

/** Mọi trang chưa gỡ (thứ tự như `GET /pages`) kèm có chọn được không. */
export async function listPageOptions(db: DbExecutor): Promise<CampaignPageOption[]> {
  const out: CampaignPageOption[] = []
  for (const page of await listPages(db)) {
    const reason = await pageBlockReason(db, page)
    out.push({ pageId: page.id, selectable: reason === null, reason })
  }
  return out
}
