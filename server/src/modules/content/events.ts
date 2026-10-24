// Consumer sự kiện của `content` (queue `events.content`, Story 7.6, AD-23): nghe `page.removed` → huỷ bài chưa đăng của
// trang vừa gỡ (`PAGE_REMOVED`) — bài thủ công lẫn slot chiến dịch; `campaigns` tự bỏ trang khỏi `campaign_pages` ở
// consumer của nó. Idempotent (bài đã huỷ không khớp lần sau) nên retry an toàn. Dữ liệu job coi như không tin cậy: sai
// dạng → bỏ qua (không đốt lượt retry). Không phát `post_target.cancelled` từng bài: web làm cũ Lịch theo `page.removed`.
import { isEventEnvelope } from '../../platform/events/index.ts'
import type { Db } from '../../platform/db/index.ts'
import { cancelPageTargets } from './slots-hold.ts'

export interface ContentEventDeps {
  db: Db
}

export type ContentEventResult = { cancelled: number } | 'ignored'

export async function handleContentEvent(deps: ContentEventDeps, data: unknown): Promise<ContentEventResult> {
  if (!isEventEnvelope(data) || data.event !== 'page.removed') return 'ignored'
  const { id, pageId } = data.payload as { id?: unknown; pageId?: unknown }
  const page = typeof pageId === 'string' ? pageId : id
  if (typeof page !== 'string' || page === '') return 'ignored'
  const cancelled = await deps.db.transaction((tx) => cancelPageTargets(tx, page, 'PAGE_REMOVED'))
  return { cancelled }
}
