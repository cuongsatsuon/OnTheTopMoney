// Máy trạng thái hội thoại (AD-9): chỉ hàm của `inbox` được chuyển trạng thái. Mỗi lần chuyển: tăng `state_version`,
// lưu `state_reason`, ghi tin `system` có `reason_code`, phát `conversation.state_changed {from,to,reasonCode,version}`
// — cùng một transaction, sau khoá luồng (cùng khoá với ingest: tin khách tới giữa chừng không chen vào giữa đọc và ghi).
// - Story 4.3: bước giải `triage` — `autoreply.triage` đọc `getTriageState` rồi áp quyết định qua
//   `applyTriageDecision` với khoá lạc quan (`state_version=?`). Lệch phiên bản → bỏ, không ghi gì.
// - Story 4.6: hội thoại `ai` có tin khách mới cũng qua `applyTriageDecision` (cổng AI: trước Epic 5 luôn đóng
//   → `human` `AI_OFF`, để bật lại AI không làm khách rơi khỏi "Cần xử lý"). Lệnh của chủ shop `applyUserAction`:
//   Tiếp quản (→ `human`, tắt AI, huỷ tin AI `pending`), bật lại AI (→ `ai`), Đánh dấu xong (→ `done`, bật AI, xoá
//   mốc chờ). Lệnh tăng `state_version` nên quyết định autoreply đang bay tới sau sẽ `stale`.
// - Story 4.7: chủ shop gửi tin từ Hộp thư (`applyHumanReply`, trong transaction gửi của `send.ts`) → huỷ tin AI
//   `pending`, `triage|ai|handoff|done → human` (`HUMAN_REPLIED`), tắt AI, xoá mốc chờ. Tin outbound `failed` không tính là
//   "đã trả lời" khi xét khách còn chờ.
// - Story 5.4: quyết định của lượt AI trả lời áp qua `applyAutoreplyDecision` (`autoreply.ts`, cùng khoá luồng + khoá
//   lạc quan theo `state_version` và tin khách mới nhất); triage đóng cổng ở `ai` không còn đi qua `applyTriageDecision`.
import type { ConversationAction, ConversationState, HandoffReason, SendErrorCode, StateChangeReason } from '@ottm/shared'
import { and, desc, eq, isNull, ne, or, sql } from 'drizzle-orm'
import type { Db, DbExecutor } from '../../platform/db/index.ts'
import type { EventPublisher } from '../../platform/events/index.ts'
import { lockThread, threadLockKey } from './ingest.ts'
import { conversations, messages } from './schema.ts'

export interface TriageState {
  conversationId: string
  pageId: string
  channel: 'dm' | 'comment'
  state: ConversationState
  stateVersion: number
  aiEnabled: boolean
}

/** Trạng thái hiện tại để autoreply quyết định; `null` khi hội thoại không còn. */
export async function getTriageState(db: Db, conversationId: string): Promise<TriageState | null> {
  const [row] = await db
    .select({
      pageId: conversations.pageId,
      channel: conversations.channel,
      state: conversations.state,
      stateVersion: conversations.stateVersion,
      aiEnabled: conversations.aiEnabled,
    })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
  return row
    ? {
        conversationId,
        pageId: row.pageId,
        channel: row.channel as 'dm' | 'comment',
        state: row.state as ConversationState,
        stateVersion: row.stateVersion,
        aiEnabled: row.aiEnabled,
      }
    : null
}

/** Đích của bước triage / cổng AI (AD-9): `human` (không áp dụng), `handoff` (tạm đóng / chủ ý), `ai` (cổng mở). */
export interface TriageDecision {
  to: Extract<ConversationState, 'ai' | 'handoff' | 'human'>
  reasonCode: StateChangeReason
}

export type ApplyTriageResult =
  | { applied: true; version: number }
  /** `noop`: hội thoại đã ở đúng đích (vd `ai` mà cổng mở) — không ghi gì. */
  | { applied: false; reason: 'missing' | 'stale' | 'noop' }

export interface StateDeps {
  db: Db
  events: EventPublisher
  now?: () => Date
}

/** Trạng thái autoreply được quyết định: `triage` (tin đầu / mở lại) và `ai` (tin khách mới khi AI đang trả lời). */
const DECIDABLE: readonly ConversationState[] = ['triage', 'ai']

export type ConversationRow = typeof conversations.$inferSelect

/** Tin "hiệu lực" để xét ai nói sau cùng: không phải `system`, không phải tin outbound gửi lỗi (`failed`). */
export const effectiveMessage = and(ne(messages.origin, 'system'), or(isNull(messages.status), ne(messages.status, 'failed')))

/** Xoá tin AI chưa gửi (`pending`) của hội thoại (AD-9: người tiếp quản / người trả lời). Tin `sending` không chặn được nữa. */
async function cancelPendingAi(tx: DbExecutor, conversationId: string, keepMessageId?: string): Promise<void> {
  await tx
    .delete(messages)
    .where(
      and(
        eq(messages.conversationId, conversationId),
        eq(messages.origin, 'app_ai'),
        eq(messages.status, 'pending'),
        keepMessageId ? ne(messages.id, keepMessageId) : undefined,
      ),
    )
}

/** Khoá luồng của hội thoại rồi đọc dòng `FOR UPDATE`; `null` khi không còn. */
export async function lockConversation(tx: DbExecutor, conversationId: string): Promise<ConversationRow | null> {
  const [peek] = await tx
    .select({ pageId: conversations.pageId, channel: conversations.channel, threadKey: conversations.threadKey })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
  if (!peek) return null
  await lockThread(tx, threadLockKey(peek.pageId, peek.channel as 'dm' | 'comment', peek.threadKey))
  const [conv] = await tx.select().from(conversations).where(eq(conversations.id, conversationId)).for('update')
  return conv ?? null
}

/** Một lần chuyển trạng thái: cập nhật dòng, ghi tin `system`, phát `conversation.state_changed`. Trả phiên bản mới. */
export async function transition(
  tx: DbExecutor,
  deps: StateDeps,
  conv: ConversationRow,
  change: { to: ConversationState; reasonCode: StateChangeReason; waitingSince: Date | null; aiEnabled?: boolean },
  now: Date,
): Promise<number> {
  const version = conv.stateVersion + 1
  await tx
    .update(conversations)
    .set({
      state: change.to,
      stateVersion: version,
      stateReason: change.reasonCode,
      waitingSince: change.waitingSince,
      ...(change.aiEnabled !== undefined ? { aiEnabled: change.aiEnabled } : {}),
      updatedAt: now,
    })
    .where(eq(conversations.id, conv.id))
  // Tin `system` đứng sau tin mới nhất (đồng hồ Meta có thể nhanh hơn máy chủ vài mili giây).
  const systemAt = conv.lastMessageAt > now ? conv.lastMessageAt : now
  await tx.insert(messages).values({
    conversationId: conv.id,
    pageId: conv.pageId,
    direction: null,
    origin: 'system',
    reasonCode: change.reasonCode,
    platformTimestamp: systemAt,
  })
  await deps.events.publishEvent(tx, 'conversation.state_changed', {
    id: conv.id,
    pageId: conv.pageId,
    from: conv.state as ConversationState,
    to: change.to,
    reasonCode: change.reasonCode,
    version,
  })
  return version
}

export async function applyTriageDecision(
  deps: StateDeps,
  conversationId: string,
  expectedVersion: number,
  decision: TriageDecision,
): Promise<ApplyTriageResult> {
  const now = deps.now?.() ?? new Date()
  return deps.db.transaction(async (tx) => {
    const conv = await lockConversation(tx, conversationId)
    if (!conv) return { applied: false, reason: 'missing' }
    if (!DECIDABLE.includes(conv.state as ConversationState) || conv.stateVersion !== expectedVersion) return { applied: false, reason: 'stale' }
    if (conv.state === decision.to) return { applied: false, reason: 'noop' }
    // Khách đang chờ từ tin khách cuối khi về tay người (`human`/`handoff`); `ai` không đếm chờ.
    const waitingSince = decision.to === 'ai' ? null : (conv.waitingSince ?? conv.lastCustomerMessageAt ?? now)
    const version = await transition(tx, deps, conv, { to: decision.to, reasonCode: decision.reasonCode, waitingSince }, now)
    return { applied: true, version }
  })
}

// ---------------------------------------------------------------------------------------------------------
// Lệnh của chủ shop (Story 4.6)
// ---------------------------------------------------------------------------------------------------------

interface ActionRule {
  to: ConversationState
  /** Trạng thái nguồn hợp lệ; ngoài danh sách (và khác `to`) → xung đột. */
  from: readonly ConversationState[]
  reasonCode: StateChangeReason
  aiEnabled: boolean
}

const ACTION_RULES: Record<ConversationAction, ActionRule> = {
  // `triage` là trạng thái chốc lát: chủ shop bấm trước khi autoreply giải xong thì lệnh thắng (quyết định sau `stale`).
  takeover: { to: 'human', from: ['triage', 'ai', 'handoff'], reasonCode: 'TAKEOVER', aiEnabled: false },
  'enable-ai': { to: 'ai', from: ['human', 'handoff'], reasonCode: 'AI_REENABLED', aiEnabled: true },
  done: { to: 'done', from: ['triage', 'ai', 'handoff', 'human'], reasonCode: 'MARKED_DONE', aiEnabled: true },
}

export type UserActionResult =
  | { status: 'applied'; version: number }
  /** Đã ở trạng thái đích — không ghi gì. */
  | { status: 'unchanged' }
  /** Trạng thái hiện tại không cho lệnh này (vd bật AI cho hội thoại đã xong). */
  | { status: 'conflict'; state: ConversationState }
  | { status: 'missing' }

/** Tiếp quản / bật lại AI / Đánh dấu xong (AD-9). Bên gọi (REST) đã kiểm hội thoại tồn tại và trang chưa gỡ. */
export async function applyUserAction(deps: StateDeps, conversationId: string, action: ConversationAction): Promise<UserActionResult> {
  const rule = ACTION_RULES[action]
  const now = deps.now?.() ?? new Date()
  return deps.db.transaction(async (tx) => {
    const conv = await lockConversation(tx, conversationId)
    if (!conv) return { status: 'missing' }
    const state = conv.state as ConversationState
    if (state === rule.to) return { status: 'unchanged' }
    if (!rule.from.includes(state)) return { status: 'conflict', state }

    let waitingSince: Date | null = null
    if (action === 'takeover') {
      // Huỷ tin AI chưa gửi (AD-9): job `inbox.send` chiếm tin bằng `status='pending'` → không thấy dòng = đã huỷ.
      await cancelPendingAi(tx, conv.id)
      // Khách vẫn chờ nếu tin hiệu lực mới nhất là của khách → giữ/đặt mốc chờ (vẫn ở "Cần xử lý").
      const [last] = await tx
        .select({ origin: messages.origin })
        .from(messages)
        .where(and(eq(messages.conversationId, conv.id), effectiveMessage))
        .orderBy(desc(messages.platformTimestamp), desc(messages.id))
        .limit(1)
      if (last?.origin === 'customer') waitingSince = conv.waitingSince ?? conv.lastCustomerMessageAt ?? now
    }
    const version = await transition(tx, deps, conv, { to: rule.to, reasonCode: rule.reasonCode, waitingSince, aiEnabled: rule.aiEnabled }, now)
    return { status: 'applied', version }
  })
}

// ---------------------------------------------------------------------------------------------------------
// Chủ shop gửi tin (Story 4.7)
// ---------------------------------------------------------------------------------------------------------

/**
 * Trạng thái chuyển sang `human` khi chủ shop gửi tin (AD-9: người gửi tin → `human`, tắt AI). Gồm cả `done`: chủ shop
 * chủ động nhắn lại thì tin khách sau đó phải về tay người, không mở lại `triage` cho AI tự trả lời. `human` giữ nguyên.
 */
const HUMAN_REPLY_FROM: readonly ConversationState[] = ['triage', 'ai', 'handoff', 'done']

/**
 * Chủ shop vừa gửi một tin (đã vào hàng gửi) — chạy TRONG transaction gửi, sau `lockConversation`: huỷ tin AI `pending`,
 * `triage|ai|handoff|done → human` (`HUMAN_REPLIED`), `ai_enabled=false` (cả khi đã ở `human`), xoá mốc chờ, đẩy
 * `last_message_at` tới `at`.
 */
export async function applyHumanReply(
  tx: DbExecutor,
  deps: StateDeps,
  conv: ConversationRow,
  at: Date,
  now: Date,
  /** Story 5.4: chủ shop Gửi lại tin AI — chính tin đó (vừa về `pending`) không bị huỷ. */
  opts: { keepMessageId?: string } = {},
): Promise<void> {
  await cancelPendingAi(tx, conv.id, opts.keepMessageId)
  if (HUMAN_REPLY_FROM.includes(conv.state as ConversationState)) {
    await transition(tx, deps, conv, { to: 'human', reasonCode: 'HUMAN_REPLIED', waitingSince: null, aiEnabled: false }, now)
  }
  await tx
    .update(conversations)
    .set({
      waitingSince: null,
      aiEnabled: false,
      lastMessageAt: sql`greatest(${conversations.lastMessageAt}, ${at.toISOString()}::timestamptz)`,
      updatedAt: now,
    })
    .where(eq(conversations.id, conv.id))
}

// ---------------------------------------------------------------------------------------------------------
// Tin AI gửi lỗi (Story 5.4)
// ---------------------------------------------------------------------------------------------------------

/** Chấm "đang gõ" của AI tự hết sau chừng này (worker chết giữa lượt không để chấm treo mãi). */
export const AI_TYPING_TTL_MS = 120_000

/** Mốc chờ khi về tay người: giữ mốc cũ, else từ tin khách cuối (AD-9). */
export const waitingFrom = (conv: ConversationRow, now: Date): Date => conv.waitingSince ?? conv.lastCustomerMessageAt ?? now

/** Lý do chuyển người khi tin AI không gửi được: ngoài cửa sổ → `OUTSIDE_24H` (chủ ý); còn lại → sự cố phía gửi (tạm đóng). */
export function aiSendFailureReason(code: SendErrorCode): HandoffReason {
  return code === 'OUTSIDE_24H' || code === 'PRIVATE_REPLY_INVALID' || code === 'PRIVATE_REPLY_USED' ? 'OUTSIDE_24H' : 'AI_PROVIDER_ERROR'
}

/**
 * Tin `app_ai` vừa thành `failed` (trong `tx` của bên gọi — bên gọi khoá luồng TRƯỚC khi đổi dòng tin, cùng thứ tự với
 * Gửi lại / Tiếp quản): hội thoại còn `ai` → `handoff` theo `aiSendFailureReason`, khách vào "Cần xử lý". Trạng thái
 * khác (đã chuyển, người đã nhận) → không đổi.
 */
export async function onAiMessageFailed(tx: DbExecutor, deps: StateDeps, conversationId: string, code: SendErrorCode): Promise<void> {
  const now = deps.now?.() ?? new Date()
  const conv = await lockConversation(tx, conversationId)
  if (!conv || conv.state !== 'ai') return
  await transition(tx, deps, conv, { to: 'handoff', reasonCode: aiSendFailureReason(code), waitingSince: waitingFrom(conv, now) }, now)
}
