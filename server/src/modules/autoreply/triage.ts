// Bước triage của AI trả lời tự động (Story 4.3, AD-9, AD-16): consumer queue `autoreply.triage` nghe
// `message.received` (chỉ tin inbound) và đưa hội thoại đang `triage` về đích NGAY, qua
// `inbox.applyTriageDecision` (khoá lạc quan theo `state_version`). Story 4.6: hội thoại `ai` (chủ shop bật lại AI)
// có tin khách mới cũng qua cổng — cổng đóng thì `ai → human` (AD-9 "cổng không áp dụng"), khách vào "Cần xử lý".
// Trạng thái khác (`human`, `handoff`, `done`) → bỏ qua, không ghi gì.
// Story 5.1 đã lưu cấu hình AI (`profiles.resolveEffective(pageId, 'autoreply')`) nhưng AI chưa tự trả lời: tới khi
// Story 5.4 thay `decideTriage` bằng chuỗi cổng đầy đủ của AD-16, cổng vẫn đóng với lý do không áp dụng `AI_OFF` → `human`.
import { applyTriageDecision, getTriageState, type TriageDecision, type TriageState } from '../inbox/index.ts'
import type { Db } from '../../platform/db/index.ts'
import { isEventEnvelope, type EventPublisher } from '../../platform/events/index.ts'

export interface TriageDeps {
  db: Db
  events: EventPublisher
}

export type TriageOutcome = 'ignored' | 'skipped' | 'applied' | 'stale'

/** Quyết định đích của một hội thoại `triage` / `ai`. Tới Story 5.4: luôn `human` (`AI_OFF`). */
export function decideTriage(_state: TriageState): TriageDecision {
  return { to: 'human', reasonCode: 'AI_OFF' }
}

export async function handleTriageEvent(deps: TriageDeps, data: unknown): Promise<TriageOutcome> {
  if (!isEventEnvelope(data) || data.event !== 'message.received') return 'ignored'
  const conversationId = (data.payload as { conversationId?: unknown }).conversationId
  if (typeof conversationId !== 'string' || conversationId === '') return 'ignored'
  const state = await getTriageState(deps.db, conversationId)
  if (!state || (state.state !== 'triage' && state.state !== 'ai')) return 'skipped'
  const result = await applyTriageDecision(deps, conversationId, state.stateVersion, decideTriage(state))
  if (result.applied) return 'applied'
  return result.reason === 'noop' ? 'skipped' : 'stale'
}
