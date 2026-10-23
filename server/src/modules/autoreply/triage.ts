// Bước triage của AI trả lời tự động (Story 4.3, AD-9, AD-16): consumer queue `autoreply.triage` nghe
// `message.received` (chỉ tin inbound) và đưa hội thoại đang `triage` về đích NGAY, qua
// `inbox.applyTriageDecision` (khoá lạc quan theo `state_version`). Hội thoại không ở `triage` (đang `human`, `ai`,
// `handoff`…) → bỏ qua, không ghi gì.
// Trước Epic 5 chưa có cấu hình AI trả lời (`CONFIG_KINDS` chỉ có `brand`) → cổng "cấu hình hiệu lực bật" đóng với
// lý do không áp dụng `AI_OFF` → `human`. Epic 5 thay `decideTriage` bằng chuỗi cổng đầy đủ của AD-16.
import { applyTriageDecision, getTriageState, type TriageDecision, type TriageState } from '../inbox/index.ts'
import type { Db } from '../../platform/db/index.ts'
import { isEventEnvelope, type EventPublisher } from '../../platform/events/index.ts'

export interface TriageDeps {
  db: Db
  events: EventPublisher
}

export type TriageOutcome = 'ignored' | 'skipped' | 'applied' | 'stale'

/** Quyết định đích của một hội thoại `triage`. Trước Epic 5: luôn `human` vì AI chưa bật (`AI_OFF`). */
export function decideTriage(_state: TriageState): TriageDecision {
  return { to: 'human', reasonCode: 'AI_OFF' }
}

export async function handleTriageEvent(deps: TriageDeps, data: unknown): Promise<TriageOutcome> {
  if (!isEventEnvelope(data) || data.event !== 'message.received') return 'ignored'
  const conversationId = (data.payload as { conversationId?: unknown }).conversationId
  if (typeof conversationId !== 'string' || conversationId === '') return 'ignored'
  const state = await getTriageState(deps.db, conversationId)
  if (!state || state.state !== 'triage') return 'skipped'
  const result = await applyTriageDecision(deps, conversationId, state.stateVersion, decideTriage(state))
  return result.applied ? 'applied' : 'stale'
}
