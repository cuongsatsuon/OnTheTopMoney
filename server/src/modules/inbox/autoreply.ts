// Phía `inbox` của AI trả lời tự động (Story 5.4, AD-9, AD-16, AD-10). `autoreply` chỉ đọc / ghi hội thoại qua đây:
// - `readAutoreplyTurn`: ảnh chụp lúc bắt đầu lượt — `{state, stateVersion, lastInboundId}` (khoá lạc quan), các tin
//   khách CHƯA được trả lời (sau tin outbound hiệu lực cuối) và bản ghi hội thoại cho prompt.
// - `applyAutoreplyDecision`: MỘT transaction sau khoá luồng — hội thoại không còn `ai`, `state_version` lệch, hoặc đã có
//   tin khách mới hơn `lastInboundId`, hoặc đã có tin outbound hiệu lực ghi sau nó → bỏ (`superseded`), không ghi gì. Ngược lại: tin `app_ai` `pending` + job
//   `inbox.send` (cùng transaction, AD-2; `canSend` từ chối → tin `failed` + mã), rồi chuyển trạng thái nếu có (tin
//   `system` đứng sau tin AI), tắt "đang gõ".
// - `setAiTyping`: chấm "đang gõ" (`ai_typing_at` + sự kiện `conversation.ai_typing`).
// Story 5.5 (bình luận): tin cần trả lời chỉ là tin của chính khách hội thoại (người khác trong luồng chỉ vào prompt);
// `autoreplySendCheck` = `canSend` + luật riêng của AI: bình luận đích đã xoá/ẩn → "đã gỡ" (AI không gửi gì). Lúc áp,
// mọi tin cần trả lời đã xoá/ẩn hoặc đích đã gỡ → `superseded` (`removed`), không ghi gì.
// Tin AI không tới được khách (job gửi, cron kẹt `sending`, `canSend` lúc áp) khi hội thoại còn `ai` → `handoff`
// (`state.ts` `onAiMessageFailed`) để khách không chờ trong im lặng.
// Story 5.6 (AD-9): ảnh chụp và áp quyết định nhận cả `handoff` tạm đóng (`resumableHandoff`). Có tin AI để gửi / AI trả
// lời → `handoff → ai` (`GATE_OPEN`) trước, rồi áp như `ai`; không tin mà đích là `human` / chủ ý → chuyển thẳng; vẫn tạm
// đóng → `unchanged`, không ghi gì.
// Không log nội dung tin.
import { HANDOFF_REASON_KIND, type ConversationState, type HandoffReason, type MessageDelivery, type Platform, type SendErrorCode, type StateChangeReason } from '@ottm/shared'
import { and, desc, eq, gt, inArray, isNotNull, isNull, ne, or, sql } from 'drizzle-orm'
import { bossDbFor, type DbExecutor } from '../../platform/db/index.ts'
import type { JobSender } from '../../platform/jobs/index.ts'
import type { ReplyTurn } from '../ai/index.ts'
import { getPage } from '../pages/index.ts'
import { getConversation, listMessages } from './queries.ts'
import { messageAttachments, conversations, messages } from './schema.ts'
import { canSend, type CanSendOptions, type SendCheck } from './send.ts'
import {
  aiSendFailureReason,
  effectiveMessage,
  lockConversation,
  resumableHandoff,
  transition,
  waitingFrom,
  type ConversationRow,
  type StateDeps,
} from './state.ts'
import { replyTurns } from './suggest.ts'

/** Số dòng tin đọc để dựng bản ghi hội thoại / tìm tin khách chưa trả lời. */
const TURN_SCAN_MESSAGES = 60

/**
 * Tin do chính khách của hội thoại viết: định danh của hội thoại, hoặc tin trước Story 4.4 chưa ghi người viết. Người khác
 * trả lời trong luồng bình luận (Story 5.5) không phải tin AI cần trả lời.
 */
const byContact = (identityId: string) => or(eq(messages.senderIdentityId, identityId), isNull(messages.senderIdentityId))

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Tin `messageId` là bình luận của người khác (không phải khách của hội thoại) — Story 5.5 (review): AI không trả lời
 * họ, triage chuyển hội thoại cho chủ shop (`OTHER_COMMENTER`) để tin không bị bỏ im lặng. Id lạ / không có → `false`.
 */
export async function isOtherCommenter(db: DbExecutor, messageId: string): Promise<boolean> {
  if (!UUID.test(messageId)) return false
  const [row] = await db
    .select({ id: messages.id })
    .from(messages)
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .where(
      and(
        eq(messages.id, messageId),
        eq(conversations.channel, 'comment'),
        eq(messages.origin, 'customer'),
        isNotNull(messages.senderIdentityId),
        sql`${messages.senderIdentityId} <> ${conversations.contactIdentityId}`,
      ),
    )
  return !!row
}

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
  /** Lý do của lần chuyển trạng thái cuối — Story 5.6: `handoff` tạm đóng thì lượt được chạy để khôi phục. */
  stateReason: StateChangeReason | null
  /**
   * Id tin `system` cuối (lần chuyển trạng thái cuối, uuidv7 theo thứ tự ghi); `null` khi chưa có. Story 5.6: tin khách có
   * id lớn hơn = tin tới SAU khi vào `handoff` — chỉ tin như vậy mới khôi phục được.
   */
  stateChangeId: string | null
  aiEnabled: boolean
  /** Id tin khách mới nhất (thứ tự ghi) — khoá lạc quan; `null` khi chưa có tin khách. */
  lastInboundId: string | null
  /** Tin khách sau tin outbound hiệu lực cuối, cũ → mới; rỗng = đã có người/AI trả lời sau tin khách cuối. */
  pending: PendingInbound[]
  /** Bản ghi hội thoại cho prompt (một dòng mỗi lượt, cắt độ dài), cũ → mới. */
  turns: ReplyTurn[]
  /** Hội thoại `comment`: caption bài (Story 5.5). */
  postText: string | null
  /** Bình luận của người khác chưa ai trả lời (sau tin outbound hiệu lực cuối) — Story 5.6: không khôi phục khi còn. */
  othersPending: boolean
  /** Hội thoại `comment` mà job `inbox.fetch_post_text` chưa chạy xong — lượt có thể chờ caption một chút (Story 5.5). */
  postTextPending: boolean
}

/** Id tin mới nhất của khách hội thoại theo thứ tự ghi (uuidv7). */
async function latestInboundId(db: DbExecutor, conversationId: string, identityId: string): Promise<string | null> {
  const [row] = await db
    .select({ id: messages.id })
    .from(messages)
    .where(and(eq(messages.conversationId, conversationId), eq(messages.origin, 'customer'), byContact(identityId)))
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
    .select({
      stateVersion: conversations.stateVersion,
      stateReason: conversations.stateReason,
      contactIdentityId: conversations.contactIdentityId,
      platformPostId: conversations.platformPostId,
      postTextFetchedAt: conversations.postTextFetchedAt,
    })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
  const lastInboundId = await latestInboundId(db, conversationId, row!.contactIdentityId)

  // Tin hiệu lực mới nhất trước: gom tin khách tới tin outbound đầu tiên gặp (đã trả lời). Tin khách đã xoá/ẩn bỏ qua.
  // Theo thứ tự GHI (id uuidv7, dưới khoá luồng), không theo `platform_timestamp`: tin khách gửi trước lúc AI áp nhưng
  // webhook tới sau (mốc Meta < mốc tin AI) vẫn là tin chưa ai trả lời — xếp theo mốc thì nó bị coi đã trả lời, mất tin.
  // Tin người khác trong luồng không chặn việc quét (không phải "đã trả lời") và không vào danh sách cần trả lời.
  const recent = await db
    .select({
      id: messages.id,
      direction: messages.direction,
      text: messages.text,
      removal: messages.removal,
      senderIdentityId: messages.senderIdentityId,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .where(and(eq(messages.conversationId, conversationId), effectiveMessage))
    .orderBy(desc(messages.id))
    .limit(TURN_SCAN_MESSAGES)
  const trailing: typeof recent = []
  let othersPending = false
  for (const m of recent) {
    if (m.direction === 'outbound') break
    const own = m.senderIdentityId === null || m.senderIdentityId === row!.contactIdentityId
    if (m.removal === null && own) trailing.push(m)
    else if (m.removal === null) othersPending = true
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

  const [changed] = await db
    .select({ id: messages.id })
    .from(messages)
    .where(and(eq(messages.conversationId, conversationId), eq(messages.origin, 'system')))
    .orderBy(desc(messages.id))
    .limit(1)

  const history = await listMessages(db, conversationId, { limit: TURN_SCAN_MESSAGES })
  return {
    conversationId,
    pageId: conv.pageId,
    platform: page.platform,
    channel: conv.channel,
    state: conv.state,
    stateVersion: row!.stateVersion,
    stateReason: (row!.stateReason as StateChangeReason | null) ?? null,
    stateChangeId: changed?.id ?? null,
    aiEnabled: conv.aiEnabled,
    lastInboundId,
    pending: trailing.map((m) => ({ id: m.id, text: m.text, attachmentCount: counts.get(m.id) ?? 0, createdAt: m.createdAt })),
    turns: replyTurns(history.items, conv.contact.id),
    othersPending,
    postText: conv.post?.text ?? null,
    postTextPending: conv.channel === 'comment' && row!.platformPostId !== null && row!.postTextFetchedAt === null,
  }
}

// ---------------------------------------------------------------------------------------------------------
// Cửa sổ gửi của AI (Story 5.5)
// ---------------------------------------------------------------------------------------------------------

/** Bình luận AI định trả lời đã bị xoá / ẩn — AI không gửi gì (khác `canSend` của chủ shop: người vẫn trả lời được). */
export const COMMENT_REMOVED = 'COMMENT_REMOVED'

export type AutoreplySendCheck = SendCheck | { ok: false; code: typeof COMMENT_REMOVED }

/** Bình luận `(page, platform_message_id)` đã xoá / ẩn? Không có dòng → không. */
async function commentRemoved(db: DbExecutor, pageId: string, platformMessageId: string): Promise<boolean> {
  const [row] = await db
    .select({ removal: messages.removal })
    .from(messages)
    .where(and(eq(messages.pageId, pageId), eq(messages.platformMessageId, platformMessageId)))
  return !!row?.removal
}

/**
 * Cửa sổ gửi cho tin AI: `canSend` (chỗ duy nhất tính cửa sổ) + luật riêng của AI cho bình luận — trả lời công khai mà
 * bình luận gốc đã xoá/ẩn, hoặc nhắn riêng mà bình luận đích đã ẩn → `COMMENT_REMOVED`. Chạy được trong transaction.
 */
export async function autoreplySendCheck(db: DbExecutor, conversationId: string, mode: MessageDelivery, options: CanSendOptions = {}): Promise<AutoreplySendCheck> {
  if (mode === 'public_reply') {
    const [conv] = await db.select({ pageId: conversations.pageId, threadKey: conversations.threadKey }).from(conversations).where(eq(conversations.id, conversationId))
    if (conv && (await commentRemoved(db, conv.pageId, conv.threadKey))) return { ok: false, code: COMMENT_REMOVED }
  }
  const check = await canSend(db, conversationId, mode, options)
  if (check.ok && mode === 'private_reply' && check.replyTo) {
    const [conv] = await db.select({ pageId: conversations.pageId }).from(conversations).where(eq(conversations.id, conversationId))
    if (conv && (await commentRemoved(db, conv.pageId, check.replyTo))) return { ok: false, code: COMMENT_REMOVED }
  }
  return check
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
  /** Tin khách lượt này trả lời (Story 5.5): hội thoại bình luận mà tất cả đã xoá/ẩn lúc áp → `removed`. */
  pendingIds?: readonly string[]
}

export interface AutoreplyApplyInput {
  /** Tin AI gửi theo thứ tự (câu trả lời / câu chuyển tiếp). Rỗng = không gửi gì. */
  messages: readonly { mode: MessageDelivery; text: string }[]
  /**
   * `null` = giữ / về `ai` (AI vừa trả lời). `human` cho lý do không áp dụng; `handoff` cho tạm đóng / chủ ý (AD-9). Ảnh
   * chụp `handoff` tạm đóng mà đích vẫn tạm đóng, không tin → `unchanged` (Story 5.6).
   */
  transition: { to: 'handoff' | 'human'; reasonCode: HandoffReason } | null
}

export type AutoreplyApplyResult =
  | { applied: true; messageIds: string[]; state: 'ai' | 'handoff' | 'human'; reasonCode: StateChangeReason | null }
  /**
   * `removed` (Story 5.5): bình luận AI định trả lời đã bị xoá / ẩn trước khi áp. `unchanged` (Story 5.6): hội thoại
   * `handoff` tạm đóng mà quyết định vẫn tạm đóng — giữ nguyên, không ghi tin `system` mới.
   */
  | { applied: false; reason: 'missing' | 'superseded' | 'removed' | 'unchanged' }

export async function applyAutoreplyDecision(
  deps: AutoreplyApplyDeps,
  conversationId: string,
  expected: AutoreplyExpected,
  input: AutoreplyApplyInput,
): Promise<AutoreplyApplyResult> {
  const now = deps.now?.() ?? new Date()
  return deps.db.transaction(async (tx): Promise<AutoreplyApplyResult> => {
    let conv = await lockConversation(tx, conversationId)
    if (!conv) return { applied: false, reason: 'missing' }
    // Tiếp quản / người gửi tin / bật-tắt giữa lượt (tăng `state_version`), hoặc khách nhắn thêm → lượt sau lo.
    const resuming = resumableHandoff(conv.state, conv.stateReason)
    if ((conv.state !== 'ai' && !resuming) || conv.stateVersion !== expected.stateVersion) return { applied: false, reason: 'superseded' }
    // Story 5.6: vẫn tạm đóng (hạn mức / khoá / nhà cung cấp / ngoài giờ) → giữ `handoff` như cũ.
    if (resuming && input.messages.length === 0 && input.transition?.to === 'handoff' && HANDOFF_REASON_KIND[input.transition.reasonCode] === 'transient') {
      return { applied: false, reason: 'unchanged' }
    }
    if ((await latestInboundId(tx, conv.id, conv.contactIdentityId)) !== expected.lastInboundId) return { applied: false, reason: 'superseded' }
    // Story 5.6 (review): người khác bình luận trong luồng lúc lượt khôi phục đang nghĩ — triage bỏ qua tin đó vì hội thoại
    // còn `handoff` (không tăng `state_version`) → không kéo hội thoại khỏi "Cần xử lý". Tin trước `lastInboundId` đã được
    // ảnh chụp xét (`othersPending`).
    if (resuming && conv.channel === 'comment') {
      const [other] = await tx
        .select({ id: messages.id })
        .from(messages)
        .where(
          and(
            eq(messages.conversationId, conv.id),
            eq(messages.origin, 'customer'),
            isNull(messages.removal),
            isNotNull(messages.senderIdentityId),
            ne(messages.senderIdentityId, conv.contactIdentityId),
            gt(messages.id, expected.lastInboundId),
          ),
        )
        .limit(1)
      if (other) return { applied: false, reason: 'superseded' }
    }
    // Đã có tin outbound hiệu lực ghi sau tin khách đó (lượt khác chạy chồng khi job quá hạn, người trả lời không đổi
    // `state_version`) → tin khách đã được trả lời, không gửi lần hai.
    const [answered] = await tx
      .select({ id: messages.id })
      .from(messages)
      .where(and(eq(messages.conversationId, conv.id), eq(messages.direction, 'outbound'), effectiveMessage, gt(messages.id, expected.lastInboundId)))
      .limit(1)
    if (answered) return { applied: false, reason: 'superseded' }
    // Bình luận: khách xoá / trang ẩn bình luận trong lúc AI nghĩ → không gửi gì (cả câu công khai lẫn nhắn riêng).
    if (conv.channel === 'comment' && expected.pendingIds?.length) {
      const [visible] = await tx
        .select({ id: messages.id })
        .from(messages)
        .where(and(inArray(messages.id, [...expected.pendingIds]), isNull(messages.removal)))
        .limit(1)
      if (!visible) return { applied: false, reason: 'removed' }
    }
    // Kiểm hết trước khi ghi: một tin gặp bình luận đã gỡ thì bỏ cả quyết định (câu công khai thường nhắc tới tin riêng).
    const checks: AutoreplySendCheck[] = []
    for (const m of input.messages) checks.push(await autoreplySendCheck(tx, conv.id, m.mode, { now }))
    if (checks.some((c) => !c.ok && c.code === COMMENT_REMOVED)) return { applied: false, reason: 'removed' }

    // Story 5.6: AI trả lời / gửi câu chuyển tiếp → hội thoại về `ai` trước (tin `system` đứng trước tin AI). Không tin
    // mà đích là `human` / chủ ý → chuyển thẳng từ `handoff` ở dưới.
    if (resuming && (input.messages.length > 0 || input.transition === null)) {
      const version = await transition(tx, deps, conv, { to: 'ai', reasonCode: 'GATE_OPEN', waitingSince: null }, now)
      const placed = conv.lastMessageAt > now ? conv.lastMessageAt : now
      conv = { ...conv, state: 'ai', stateVersion: version, stateReason: 'GATE_OPEN', waitingSince: null, lastMessageAt: placed }
    }
    const at = conv.lastMessageAt > now ? conv.lastMessageAt : now
    const messageIds: string[] = []
    let refused: SendErrorCode | null = null
    for (const [i, m] of input.messages.entries()) {
      const check = checks[i] as SendCheck
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
