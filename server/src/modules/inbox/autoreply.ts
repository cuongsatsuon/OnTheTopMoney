// Phía `inbox` của AI trả lời tự động (Story 5.4, AD-9, AD-16, AD-10). `autoreply` chỉ đọc / ghi hội thoại qua đây:
// - `readAutoreplyTurn`: ảnh chụp lúc bắt đầu lượt — `{state, stateVersion, lastInboundId}` (khoá lạc quan), các tin
//   khách CHƯA được trả lời (sau tin outbound hiệu lực cuối) và bản ghi hội thoại cho prompt.
// - `applyAutoreplyDecision`: MỘT transaction sau khoá luồng — hội thoại không còn `ai`, `state_version` lệch, hoặc đã có
//   tin khách mới hơn `lastInboundId`, hoặc đã có tin outbound hiệu lực ghi sau nó → bỏ (`superseded`), không ghi gì. Ngược lại: tin `app_ai` `pending` + job
//   `inbox.send` (cùng transaction, AD-2; `canSend` từ chối → tin `failed` + mã), rồi chuyển trạng thái nếu có (tin
//   `system` đứng sau tin AI), tắt "đang gõ".
// - `setAiTyping`: chấm "đang gõ" (`ai_typing_at` + sự kiện `conversation.ai_typing`).
// Tin AI không tới được khách (job gửi, cron kẹt `sending`, `canSend` lúc áp) khi hội thoại còn `ai` → `handoff`
// (`state.ts` `onAiMessageFailed`) để khách không chờ trong im lặng.
// Không log nội dung tin.
import type { ConversationState, HandoffReason, MessageDelivery, Platform, SendErrorCode, StateChangeReason } from '@ottm/shared'
import { and, desc, eq, gt, inArray, isNotNull, sql } from 'drizzle-orm'
import { bossDbFor, type DbExecutor } from '../../platform/db/index.ts'
import type { JobSender } from '../../platform/jobs/index.ts'
import type { ReplyTurn } from '../ai/index.ts'
import { getPage } from '../pages/index.ts'
import { getConversation, listMessages } from './queries.ts'
import { messageAttachments, conversations, messages } from './schema.ts'
import { canSend } from './send.ts'
import { aiSendFailureReason, effectiveMessage, lockConversation, transition, waitingFrom, type ConversationRow, type StateDeps } from './state.ts'
import { replyTurns } from './suggest.ts'

/** Số dòng tin đọc để dựng bản ghi hội thoại / tìm tin khách chưa trả lời. */
const TURN_SCAN_MESSAGES = 60

/** Một tin khách chưa được trả lời trong lượt này. */
export interface PendingInbound {
  id: string
  text: string | null
  attachmentCount: number
  /** Lúc vào hệ thống (≈ webhook) — mốc đo độ trễ. */
  createdAt: Date
}

export interface AutoreplyTurn {
  conversationId: string
  pageId: string
  platform: Platform
  channel: 'dm' | 'comment'
  state: ConversationState
  stateVersion: number
  aiEnabled: boolean
  /** Id tin khách mới nhất (thứ tự ghi) — khoá lạc quan; `null` khi chưa có tin khách. */
  lastInboundId: string | null
  /** Tin khách sau tin outbound hiệu lực cuối, cũ → mới; rỗng = đã có người/AI trả lời sau tin khách cuối. */
  pending: PendingInbound[]
  /** Bản ghi hội thoại cho prompt (một dòng mỗi lượt, cắt độ dài), cũ → mới. */
  turns: ReplyTurn[]
  /** Hội thoại `comment`: caption bài (Story 5.5). */
  postText: string | null
}

/** Id tin khách mới nhất theo thứ tự ghi (uuidv7). */
async function latestInboundId(db: DbExecutor, conversationId: string): Promise<string | null> {
  const [row] = await db
    .select({ id: messages.id })
    .from(messages)
    .where(and(eq(messages.conversationId, conversationId), eq(messages.origin, 'customer')))
    .orderBy(desc(messages.id))
    .limit(1)
  return row?.id ?? null
}

/** Ảnh chụp cho một lượt AI; `null` khi hội thoại không còn hoặc trang đã gỡ. */
export async function readAutoreplyTurn(db: DbExecutor, conversationId: string): Promise<AutoreplyTurn | null> {
  const conv = await getConversation(db, conversationId)
  const page = conv ? await getPage(db, conv.pageId) : null
  if (!conv || !page) return null
  const [row] = await db
    .select({ stateVersion: conversations.stateVersion })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
  const lastInboundId = await latestInboundId(db, conversationId)

  // Tin hiệu lực mới nhất trước: gom tin khách tới tin outbound đầu tiên gặp (đã trả lời). Tin khách đã xoá/ẩn bỏ qua.
  // Theo thứ tự GHI (id uuidv7, dưới khoá luồng), không theo `platform_timestamp`: tin khách gửi trước lúc AI áp nhưng
  // webhook tới sau (mốc Meta < mốc tin AI) vẫn là tin chưa ai trả lời — xếp theo mốc thì nó bị coi đã trả lời, mất tin.
  const recent = await db
    .select({ id: messages.id, direction: messages.direction, text: messages.text, removal: messages.removal, createdAt: messages.createdAt })
    .from(messages)
    .where(and(eq(messages.conversationId, conversationId), effectiveMessage))
    .orderBy(desc(messages.id))
    .limit(TURN_SCAN_MESSAGES)
  const trailing: typeof recent = []
  for (const m of recent) {
    if (m.direction === 'outbound') break
    if (m.removal === null) trailing.push(m)
  }
  trailing.reverse()
  const counts = new Map<string, number>()
  if (trailing.length > 0) {
    const rows = await db
      .select({ messageId: messageAttachments.messageId, n: sql<number>`count(*)::int` })
      .from(messageAttachments)
      .where(inArray(messageAttachments.messageId, trailing.map((m) => m.id)))
      .groupBy(messageAttachments.messageId)
    for (const r of rows) counts.set(r.messageId, r.n)
  }

  const history = await listMessages(db, conversationId, { limit: TURN_SCAN_MESSAGES })
  return {
    conversationId,
    pageId: conv.pageId,
    platform: page.platform,
    channel: conv.channel,
    state: conv.state,
    stateVersion: row!.stateVersion,
    aiEnabled: conv.aiEnabled,
    lastInboundId,
    pending: trailing.map((m) => ({ id: m.id, text: m.text, attachmentCount: counts.get(m.id) ?? 0, createdAt: m.createdAt })),
    turns: replyTurns(history.items, conv.contact.id),
    postText: conv.post?.text ?? null,
  }
}

// ---------------------------------------------------------------------------------------------------------
// Áp quyết định
// ---------------------------------------------------------------------------------------------------------

export interface AutoreplyApplyDeps extends StateDeps {
  jobs: JobSender
}

/** Ảnh chụp đã đọc lúc bắt đầu lượt (khoá lạc quan). */
export interface AutoreplyExpected {
  stateVersion: number
  lastInboundId: string
}

export interface AutoreplyApplyInput {
  /** Tin AI gửi theo thứ tự (câu trả lời / câu chuyển tiếp). Rỗng = không gửi gì. */
  messages: readonly { mode: MessageDelivery; text: string }[]
  /** `null` = giữ `ai` (AI vừa trả lời). `human` cho lý do không áp dụng; `handoff` cho tạm đóng / chủ ý (AD-9). */
  transition: { to: 'handoff' | 'human'; reasonCode: HandoffReason } | null
}

export type AutoreplyApplyResult =
  | { applied: true; messageIds: string[]; state: 'ai' | 'handoff' | 'human'; reasonCode: StateChangeReason | null }
  | { applied: false; reason: 'missing' | 'superseded' }

export async function applyAutoreplyDecision(
  deps: AutoreplyApplyDeps,
  conversationId: string,
  expected: AutoreplyExpected,
  input: AutoreplyApplyInput,
): Promise<AutoreplyApplyResult> {
  const now = deps.now?.() ?? new Date()
  return deps.db.transaction(async (tx): Promise<AutoreplyApplyResult> => {
    const conv = await lockConversation(tx, conversationId)
    if (!conv) return { applied: false, reason: 'missing' }
    // Tiếp quản / người gửi tin / bật-tắt giữa lượt (tăng `state_version`), hoặc khách nhắn thêm → lượt sau lo.
    if (conv.state !== 'ai' || conv.stateVersion !== expected.stateVersion) return { applied: false, reason: 'superseded' }
    if ((await latestInboundId(tx, conv.id)) !== expected.lastInboundId) return { applied: false, reason: 'superseded' }
    // Đã có tin outbound hiệu lực ghi sau tin khách đó (lượt khác chạy chồng khi job quá hạn, người trả lời không đổi
    // `state_version`) → tin khách đã được trả lời, không gửi lần hai.
    const [answered] = await tx
      .select({ id: messages.id })
      .from(messages)
      .where(and(eq(messages.conversationId, conv.id), eq(messages.direction, 'outbound'), effectiveMessage, gt(messages.id, expected.lastInboundId)))
      .limit(1)
    if (answered) return { applied: false, reason: 'superseded' }

    const at = conv.lastMessageAt > now ? conv.lastMessageAt : now
    const messageIds: string[] = []
    let refused: SendErrorCode | null = null
    for (const m of input.messages) {
      const check = await canSend(tx, conv.id, m.mode, { now })
      const [row] = await tx
        .insert(messages)
        .values({
          conversationId: conv.id,
          pageId: conv.pageId,
          direction: 'outbound',
          origin: 'app_ai',
          text: m.text,
          delivery: m.mode,
          status: check.ok ? 'pending' : 'failed',
          errorCode: check.ok ? null : check.code,
          replyToPlatformId: check.ok ? check.replyTo : null,
          queuedAt: now,
          platformTimestamp: at,
        })
        .returning({ id: messages.id })
      const messageId = row!.id
      messageIds.push(messageId)
      if (check.ok) {
        await deps.jobs.send('inbox.send', { messageId }, { db: bossDbFor(tx) })
      } else {
        refused ??= check.code
        await deps.events.publishEvent(tx, 'message.failed', { id: messageId, pageId: conv.pageId, conversationId: conv.id, errorCode: check.code })
      }
    }
    if (messageIds.length > 0) {
      await tx
        .update(conversations)
        .set({ lastMessageAt: sql`greatest(${conversations.lastMessageAt}, ${at.toISOString()}::timestamptz)`, updatedAt: now })
        .where(eq(conversations.id, conv.id))
    }

    const change = input.transition ?? (refused ? { to: 'handoff' as const, reasonCode: aiSendFailureReason(refused) } : null)
    if (change) {
      // Tin `system` cùng mốc với tin AI (id lớn hơn) → đứng sau câu chuyển tiếp.
      const placed = { ...conv, lastMessageAt: messageIds.length > 0 ? at : conv.lastMessageAt }
      await transition(tx, deps, placed, { to: change.to, reasonCode: change.reasonCode, waitingSince: waitingFrom(conv, now) }, now)
    }
    await clearTyping(tx, deps, conv)
    return { applied: true, messageIds, state: change?.to ?? 'ai', reasonCode: change?.reasonCode ?? null }
  })
}

async function clearTyping(tx: DbExecutor, deps: StateDeps, conv: ConversationRow): Promise<void> {
  await tx.update(conversations).set({ aiTypingAt: null }).where(eq(conversations.id, conv.id))
  // Luôn phát: web làm cũ hội thoại + tin (tin AI `pending` vừa ghi chưa có sự kiện riêng).
  await deps.events.publishEvent(tx, 'conversation.ai_typing', { id: conv.id, pageId: conv.pageId })
}

/** Bật / tắt chấm "đang gõ" của AI. Bật chỉ khi hội thoại còn `ai`; tắt chỉ khi đang bật. */
export async function setAiTyping(deps: StateDeps, conversationId: string, typing: boolean): Promise<void> {
  const now = deps.now?.() ?? new Date()
  await deps.db.transaction(async (tx) => {
    const [row] = await tx
      .update(conversations)
      .set({ aiTypingAt: typing ? now : null })
      .where(and(eq(conversations.id, conversationId), typing ? eq(conversations.state, 'ai') : isNotNull(conversations.aiTypingAt)))
      .returning({ pageId: conversations.pageId })
    if (row) await deps.events.publishEvent(tx, 'conversation.ai_typing', { id: conversationId, pageId: row.pageId })
  })
}
