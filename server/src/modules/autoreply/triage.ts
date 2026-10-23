// Bước triage của AI trả lời tự động (Story 4.3 → Story 5.4, AD-9, AD-16): consumer queue `autoreply.triage`.
// - `message.received` (chỉ tin inbound):
//   - hội thoại `triage` → cổng 1–5 (`gates.ts`) → `inbox.applyTriageDecision` (khoá lạc quan theo `state_version`):
//     không áp dụng → `human`; tạm đóng → `handoff`; mở → `ai` (`GATE_OPEN`) rồi enqueue `autoreply.run` trễ 4 giây;
//   - hội thoại đã `ai` → enqueue `autoreply.run` trễ 4 giây (stately: đang có job chờ thì tin này đi chung lượt đó);
//   - trạng thái khác (`human`, `handoff`, `done`) → bỏ qua. `handoff` tạm đóng quay lại `ai` là Story 5.6.
//   - Story 5.5 (review, vượt spec theo yêu cầu chủ dự án): bình luận của NGƯỜI KHÁC (không phải khách của hội thoại)
//     tới hội thoại `triage`/`ai` mà cổng mở → `handoff` `OTHER_COMMENTER`, không chạy AI: AI chỉ trả lời khách của
//     hội thoại, tin người khác phải vào "Cần xử lý" cho chủ shop (trước 5.5 các tin này nằm ở `human`).
// - `conversation.state_changed` sang `ai` với `AI_REENABLED` (chủ shop bật lại AI) → enqueue run NGAY: khách đang chờ
//   thì AI trả lời tin chờ sẵn; không chờ thì lượt chạy tự `skipped`.
// Idempotent: áp chỉ khi đúng `state_version`; enqueue trùng bị queue stately bỏ.
import { getTriageState, applyTriageDecision, isOtherCommenter, type TriageDecision, type TriageState } from '../inbox/index.ts'
import { getPage } from '../pages/index.ts'
import { isEventEnvelope } from '../../platform/events/index.ts'
import { HANDOFF_REASON_KIND } from '@ottm/shared'
import { preGates } from './gates.ts'
import { enqueueAutoreplyRun, type RunDeps } from './run.ts'

export type TriageDeps = Pick<RunDeps, 'db' | 'events' | 'jobs' | 'cipher' | 'now'>

export type TriageOutcome = 'ignored' | 'skipped' | 'applied' | 'stale' | 'queued'

/** Đích của một hội thoại `triage` theo cổng 1–5 (AD-9: không áp dụng → `human`, tạm đóng → `handoff`, mở → `ai`). */
export async function decideTriage(deps: TriageDeps, state: TriageState): Promise<TriageDecision> {
  const page = await getPage(deps.db, state.pageId)
  if (!page) return { to: 'human', reasonCode: 'CONFIG_MISSING' }
  const gate = await preGates(deps, { pageId: state.pageId, platform: page.platform, channel: state.channel, aiEnabled: state.aiEnabled })
  if (gate.open) return { to: 'ai', reasonCode: 'GATE_OPEN' }
  return { to: HANDOFF_REASON_KIND[gate.reason] === 'not_applicable' ? 'human' : 'handoff', reasonCode: gate.reason }
}

/**
 * Bình luận của người khác trong hội thoại AI đang (hoặc sắp) phục vụ → chuyển chủ shop. `triage`: cổng đóng thì áp
 * quyết định cổng như thường (`human`/`handoff`). Lệch phiên bản → đọc lại một lần (vd triage tin của khách vừa áp).
 */
async function routeOtherCommenter(deps: TriageDeps, initial: TriageState): Promise<TriageOutcome> {
  let state: TriageState | null = initial
  for (let attempt = 0; attempt < 2 && state && (state.state === 'ai' || state.state === 'triage'); attempt += 1) {
    const gate = state.state === 'triage' ? await decideTriage(deps, state) : null
    const decision: TriageDecision = gate && gate.to !== 'ai' ? gate : { to: 'handoff', reasonCode: 'OTHER_COMMENTER' }
    const result = await applyTriageDecision(deps, state.conversationId, state.stateVersion, decision)
    if (result.applied) return 'applied'
    if (result.reason !== 'stale') return 'skipped'
    state = await getTriageState(deps.db, state.conversationId)
  }
  return 'stale'
}

export async function handleTriageEvent(deps: TriageDeps, data: unknown): Promise<TriageOutcome> {
  if (!isEventEnvelope(data)) return 'ignored'
  if (data.event === 'conversation.state_changed') {
    const { id, to, reasonCode } = data.payload as { id: string; to: string; reasonCode: string }
    if (to !== 'ai' || reasonCode !== 'AI_REENABLED') return 'ignored'
    await enqueueAutoreplyRun(deps, id, 0)
    return 'queued'
  }
  if (data.event !== 'message.received') return 'ignored'
  const conversationId = (data.payload as { conversationId?: unknown }).conversationId
  if (typeof conversationId !== 'string' || conversationId === '') return 'ignored'

  const state = await getTriageState(deps.db, conversationId)
  if (!state) return 'skipped'
  const messageId = (data.payload as { id?: unknown }).id
  if ((state.state === 'ai' || state.state === 'triage') && typeof messageId === 'string' && (await isOtherCommenter(deps.db, messageId))) {
    return routeOtherCommenter(deps, state)
  }
  if (state.state === 'ai') {
    await enqueueAutoreplyRun(deps, conversationId)
    return 'queued'
  }
  if (state.state !== 'triage') return 'skipped'
  const decision = await decideTriage(deps, state)
  const result = await applyTriageDecision(deps, conversationId, state.stateVersion, decision)
  if (result.applied) {
    if (decision.to !== 'ai') return 'applied'
    await enqueueAutoreplyRun(deps, conversationId)
    return 'queued'
  }
  if (result.reason === 'noop') return 'skipped'
  // Lệch phiên bản: triage của tin khác (cùng hội thoại) đã giải trước. Đã `ai` → bảo đảm có lượt chạy cho tin này.
  const now = await getTriageState(deps.db, conversationId)
  if (now?.state === 'ai') {
    await enqueueAutoreplyRun(deps, conversationId)
    return 'queued'
  }
  return 'stale'
}
