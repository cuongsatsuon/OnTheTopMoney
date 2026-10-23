// Máy trạng thái hội thoại (AD-9): chỉ hàm của `inbox` được chuyển trạng thái. Story 4.3 có bước giải `triage`:
// `autoreply.triage` đọc `getTriageState` rồi áp quyết định qua `applyTriageDecision` với khoá lạc quan
// (`state='triage' AND state_version=?`). Lệch phiên bản (đã có lần chuyển khác) → bỏ quyết định, không ghi gì.
// Mỗi lần chuyển: tăng `state_version`, lưu `state_reason`, ghi tin `system` có `reason_code`, phát
// `conversation.state_changed {from,to,reasonCode,version}` — cùng một transaction.
import type { ConversationState, StateChangeReason } from '@ottm/shared'
import { and, eq } from 'drizzle-orm'
import type { Db } from '../../platform/db/index.ts'
import type { EventPublisher } from '../../platform/events/index.ts'
import { lockThread, threadLockKey } from './ingest.ts'
import { conversations, messages } from './schema.ts'

export interface TriageState {
  conversationId: string
  pageId: string
  state: ConversationState
  stateVersion: number
}

/** Trạng thái hiện tại để autoreply quyết định; `null` khi hội thoại không còn. */
export async function getTriageState(db: Db, conversationId: string): Promise<TriageState | null> {
  const [row] = await db
    .select({ pageId: conversations.pageId, state: conversations.state, stateVersion: conversations.stateVersion })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
  return row ? { conversationId, pageId: row.pageId, state: row.state as ConversationState, stateVersion: row.stateVersion } : null
}

/** Đích của bước triage (AD-9): `human` (không áp dụng), `handoff` (tạm đóng / chủ ý), `ai` (cổng mở). */
export interface TriageDecision {
  to: Extract<ConversationState, 'ai' | 'handoff' | 'human'>
  reasonCode: StateChangeReason
}

export type ApplyTriageResult = { applied: true; version: number } | { applied: false; reason: 'missing' | 'stale' }

export interface StateDeps {
  db: Db
  events: EventPublisher
  now?: () => Date
}

export async function applyTriageDecision(
  deps: StateDeps,
  conversationId: string,
  expectedVersion: number,
  decision: TriageDecision,
): Promise<ApplyTriageResult> {
  const now = deps.now?.() ?? new Date()
  return deps.db.transaction(async (tx) => {
    const [peek] = await tx
      .select({ pageId: conversations.pageId, channel: conversations.channel, threadKey: conversations.threadKey })
      .from(conversations)
      .where(eq(conversations.id, conversationId))
    if (!peek) return { applied: false, reason: 'missing' }
    // Cùng khoá luồng với ingest: tin khách tới giữa chừng không chen vào giữa đọc và ghi.
    await lockThread(tx, threadLockKey(peek.pageId, peek.channel as 'dm' | 'comment', peek.threadKey))
    const [conv] = await tx
      .select()
      .from(conversations)
      .where(and(eq(conversations.id, conversationId), eq(conversations.state, 'triage'), eq(conversations.stateVersion, expectedVersion)))
      .for('update')
    if (!conv) return { applied: false, reason: 'stale' }

    const version = conv.stateVersion + 1
    // Khách đang chờ từ tin khách cuối khi về tay người (`human`/`handoff`); `ai` không đếm chờ.
    const waitingSince = decision.to === 'ai' ? null : (conv.waitingSince ?? conv.lastCustomerMessageAt ?? now)
    await tx
      .update(conversations)
      .set({ state: decision.to, stateVersion: version, stateReason: decision.reasonCode, waitingSince, updatedAt: now })
      .where(eq(conversations.id, conv.id))
    // Tin `system` đứng sau tin mới nhất (đồng hồ Meta có thể nhanh hơn máy chủ vài mili giây).
    const systemAt = conv.lastMessageAt > now ? conv.lastMessageAt : now
    await tx.insert(messages).values({
      conversationId: conv.id,
      pageId: conv.pageId,
      direction: null,
      origin: 'system',
      reasonCode: decision.reasonCode,
      platformTimestamp: systemAt,
    })
    await deps.events.publishEvent(tx, 'conversation.state_changed', {
      id: conv.id,
      pageId: conv.pageId,
      from: 'triage',
      to: decision.to,
      reasonCode: decision.reasonCode,
      version,
    })
    return { applied: true, version }
  })
}
