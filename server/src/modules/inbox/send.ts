// Gửi tin từ Hộp thư (Story 4.7, AD-10, AD-9, AD-11, AD-24).
// - `canSend(conversationId, mode)`: chỗ DUY NHẤT tính cửa sổ gửi — DM ≤24 giờ từ tin cuối của khách; trả lời công khai
//   luôn được (trừ bình luận gốc đã bị xoá); nhắn riêng một lần mỗi bình luận, ≤7 ngày, chỉ FB/IG. Epic 5 gọi lại hàm này.
// - `sendMessage` / `resendMessage` (REST): MỘT transaction sau khoá luồng — cho phép → tin outbound `pending` + job
//   `inbox.send` cùng transaction (AD-2) + `applyHumanReply`; từ chối → tin vẫn lưu `failed` + mã, phát `message.failed`.
//   Không gọi Meta ở đây.
// - Job `inbox.send` (`deliverMessage`): chiếm tin bằng `UPDATE … WHERE status='pending'` (không thấy dòng = tin đã bị
//   huỷ, vd Tiếp quản xoá tin AI `pending` → kết thúc êm), lấy token ngay trước khi gọi (AD-5), gửi qua `adapters/meta`
//   hạng `interactive`, Messenger kèm `metadata = messages.id` (AD-20). Lỗi retry được trả tin về `pending` trước khi
//   ném; `RATE_LIMITED` hoãn bằng job mới `startAfter` (không đốt lượt retry); lỗi khác → `failed` + mã.
// - Cron `inbox.send_sweep`: tin kẹt `sending` quá 15 phút → `failed` `SEND_UNKNOWN` (có thể đã tới khách, không tự gửi lại).
// Không log nội dung tin hay token.
import { sendModesFor, sendTextLimit, type MessageDelivery, type Platform, type SendErrorCode } from '@ottm/shared'
import { and, desc, eq, isNull, lt, ne, or, sql } from 'drizzle-orm'
import type { SecretCipher } from '../../adapters/crypto/index.ts'
import type { MetaClient, MetaErrorKind, MetaFailure } from '../../adapters/meta/index.ts'
import { bossDbFor, type Db, type DbExecutor } from '../../platform/db/index.ts'
import { AppError } from '../../platform/errors/index.ts'
import type { EventPublisher } from '../../platform/events/index.ts'
import type { JobSender } from '../../platform/jobs/index.ts'
import { getAccessToken } from '../connections/index.ts'
import { getPage, getPlatformAccountId } from '../pages/index.ts'
import { reportTokenInvalid } from './meta-token.ts'
import { suggestMerge } from './contacts.ts'
import { contactIdentities, conversations, messages } from './schema.ts'
import { applyHumanReply, lockConversation } from './state.ts'

/** Cửa sổ tin thường của DM (Messenger / Instagram) tính từ tin cuối của khách. */
export const DM_WINDOW_MS = 24 * 60 * 60_000
/** Cửa sổ nhắn riêng người bình luận tính từ lúc bình luận. */
export const PRIVATE_REPLY_WINDOW_MS = 7 * 24 * 60 * 60_000
/** Tin kẹt `sending` lâu hơn chừng này → `SEND_UNKNOWN`. */
export const SENDING_STUCK_MS = 15 * 60_000
/** Hoãn vì `RATE_LIMITED` tối đa tới chừng này sau lần đưa vào hàng gửi; quá → `failed` `RATE_LIMITED`. */
export const RATE_LIMIT_DEFER_MAX_MS = 30 * 60_000

// ---------------------------------------------------------------------------------------------------------
// canSend
// ---------------------------------------------------------------------------------------------------------

export type SendCheck =
  /** `replyTo`: id bình luận đích (trả lời công khai / nhắn riêng); `null` với DM. */
  | { ok: true; replyTo: string | null }
  | { ok: false; code: SendErrorCode }

export interface CanSendOptions {
  now?: Date
  /** Gửi lại: không tính chính tin này khi xét "đã nhắn riêng bình luận này chưa". */
  excludeMessageId?: string
}

/** Cửa sổ gửi của một hội thoại theo `mode` (AD-10). Chạy được trong transaction của bên gọi. */
export async function canSend(db: DbExecutor, conversationId: string, mode: MessageDelivery, options: CanSendOptions = {}): Promise<SendCheck> {
  const now = options.now ?? new Date()
  const [conv] = await db.select().from(conversations).where(eq(conversations.id, conversationId))
  const page = conv ? await getPage(db, conv.pageId) : null
  if (!conv || !page) return { ok: false, code: 'PAGE_REMOVED' }
  if (page.connectionStatus === 'disconnected') return { ok: false, code: 'PAGE_DISCONNECTED' }
  if (!sendModesFor(page.platform, conv.channel as 'dm' | 'comment').includes(mode)) {
    // Threads không có nhắn riêng; mode lệch kênh (DM ↔ bình luận) là lỗi của bên gọi.
    return { ok: false, code: mode === 'private_reply' && conv.channel === 'comment' ? 'PRIVATE_REPLY_INVALID' : 'SEND_REJECTED' }
  }

  if (mode === 'dm') {
    const last = conv.lastCustomerMessageAt
    if (!last || now.getTime() - last.getTime() > DM_WINDOW_MS) return { ok: false, code: 'OUTSIDE_24H' }
    return { ok: true, replyTo: null }
  }

  if (mode === 'public_reply') {
    const [root] = await db
      .select({ removal: messages.removal })
      .from(messages)
      .where(and(eq(messages.pageId, conv.pageId), eq(messages.platformMessageId, conv.threadKey)))
    if (root?.removal === 'deleted') return { ok: false, code: 'SEND_REJECTED' }
    return { ok: true, replyTo: conv.threadKey }
  }

  // Nhắn riêng: bình luận mới nhất chưa bị xoá của chính khách của hội thoại ("một lần mỗi bình luận").
  const [target] = await db
    .select({ platformMessageId: messages.platformMessageId, at: messages.platformTimestamp })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, conv.id),
        eq(messages.origin, 'customer'),
        or(eq(messages.senderIdentityId, conv.contactIdentityId), isNull(messages.senderIdentityId)),
        or(isNull(messages.removal), ne(messages.removal, 'deleted')),
        sql`${messages.platformMessageId} is not null`,
      ),
    )
    .orderBy(desc(messages.platformTimestamp), desc(messages.id))
    .limit(1)
  if (!target?.platformMessageId || now.getTime() - target.at.getTime() > PRIVATE_REPLY_WINDOW_MS) {
    return { ok: false, code: 'PRIVATE_REPLY_INVALID' }
  }
  const [used] = await db
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, conv.id),
        eq(messages.delivery, 'private_reply'),
        eq(messages.replyToPlatformId, target.platformMessageId),
        ne(messages.status, 'failed'),
        options.excludeMessageId ? ne(messages.id, options.excludeMessageId) : undefined,
      ),
    )
    .limit(1)
  if (used) return { ok: false, code: 'PRIVATE_REPLY_USED' }
  return { ok: true, replyTo: target.platformMessageId }
}

// ---------------------------------------------------------------------------------------------------------
// Gửi / gửi lại (REST)
// ---------------------------------------------------------------------------------------------------------

export interface SendDeps {
  db: Db
  events: EventPublisher
  jobs: JobSender
  now?: () => Date
}

export interface SendInput {
  text: string
  /** Bỏ trống → mặc định của kênh (`sendModesFor`). */
  mode?: MessageDelivery | undefined
}

export type SendResult =
  | { status: 'queued'; messageId: string }
  /** `canSend` từ chối: tin vẫn lưu `failed` với `code`. */
  | { status: 'refused'; messageId: string; code: SendErrorCode }
  | { status: 'missing' }

export type ResendResult =
  | { status: 'queued'; messageId: string }
  | { status: 'refused'; messageId: string; code: SendErrorCode }
  /** Tin không ở `failed` hoặc không phải tin của chủ shop. */
  | { status: 'conflict' }
  | { status: 'missing' }

const invalid = (message: string) => new AppError('VALIDATION_FAILED', 400, { message })

/** Tin mới đứng sau tin mới nhất (đồng hồ Meta có thể nhanh hơn máy chủ vài mili giây). */
const placeAt = (lastMessageAt: Date, now: Date): Date => (lastMessageAt > now ? lastMessageAt : now)

/**
 * Chủ shop gửi một tin (`origin=app_human`). Chữ rỗng / quá giới hạn nền tảng / mode lệch kênh → `VALIDATION_FAILED`
 * (không ghi gì). Hội thoại không có / trang đã gỡ → `missing`.
 */
export async function sendMessage(deps: SendDeps, conversationId: string, input: SendInput): Promise<SendResult> {
  const now = deps.now?.() ?? new Date()
  const text = input.text.trim()
  return deps.db.transaction(async (tx): Promise<SendResult> => {
    const conv = await lockConversation(tx, conversationId)
    const page = conv ? await getPage(tx, conv.pageId) : null
    if (!conv || !page) return { status: 'missing' }
    const modes = sendModesFor(page.platform, conv.channel as 'dm' | 'comment')
    const mode = input.mode ?? modes[0]!
    if (!modes.includes(mode)) throw invalid('Cách gửi không hợp lệ cho hội thoại này')
    if (text === '') throw invalid('Tin nhắn trống')
    if (text.length > sendTextLimit(page.platform, mode)) throw invalid('Tin nhắn quá dài cho nền tảng này')

    const check = await canSend(tx, conv.id, mode, { now })
    const at = placeAt(conv.lastMessageAt, now)
    const [row] = await tx
      .insert(messages)
      .values({
        conversationId: conv.id,
        pageId: conv.pageId,
        direction: 'outbound',
        origin: 'app_human',
        text,
        delivery: mode,
        status: check.ok ? 'pending' : 'failed',
        errorCode: check.ok ? null : check.code,
        replyToPlatformId: check.ok ? check.replyTo : null,
        queuedAt: now,
        platformTimestamp: at,
      })
      .returning({ id: messages.id })
    const messageId = row!.id
    if (!check.ok) {
      await deps.events.publishEvent(tx, 'message.failed', { id: messageId, pageId: conv.pageId, conversationId: conv.id, errorCode: check.code })
      return { status: 'refused', messageId, code: check.code }
    }
    await deps.jobs.send('inbox.send', { messageId }, { db: bossDbFor(tx) })
    await applyHumanReply(tx, deps, conv, at, now)
    return { status: 'queued', messageId }
  })
}

/** "Gửi lại" tin `failed` của chủ shop: kiểm lại cửa sổ, đặt `pending`, dời về cuối hội thoại, enqueue job MỚI. */
export async function resendMessage(deps: SendDeps, messageId: string): Promise<ResendResult> {
  const now = deps.now?.() ?? new Date()
  return deps.db.transaction(async (tx): Promise<ResendResult> => {
    const [peek] = await tx.select({ conversationId: messages.conversationId }).from(messages).where(eq(messages.id, messageId))
    if (!peek) return { status: 'missing' }
    const conv = await lockConversation(tx, peek.conversationId)
    const page = conv ? await getPage(tx, conv.pageId) : null
    if (!conv || !page) return { status: 'missing' }
    const [msg] = await tx.select().from(messages).where(eq(messages.id, messageId)).for('update')
    if (!msg) return { status: 'missing' }
    if (msg.status !== 'failed' || msg.origin !== 'app_human' || msg.direction !== 'outbound') return { status: 'conflict' }

    const mode = (msg.delivery as MessageDelivery | null) ?? sendModesFor(page.platform, conv.channel as 'dm' | 'comment')[0]!
    const check = await canSend(tx, conv.id, mode, { now, excludeMessageId: msg.id })
    if (!check.ok) {
      await tx.update(messages).set({ errorCode: check.code }).where(eq(messages.id, msg.id))
      await deps.events.publishEvent(tx, 'message.failed', { id: msg.id, pageId: conv.pageId, conversationId: conv.id, errorCode: check.code })
      return { status: 'refused', messageId: msg.id, code: check.code }
    }
    const at = placeAt(conv.lastMessageAt, now)
    await tx
      .update(messages)
      .set({ status: 'pending', errorCode: null, delivery: mode, replyToPlatformId: check.replyTo, queuedAt: now, sendingAt: null, platformTimestamp: at })
      .where(eq(messages.id, msg.id))
    await deps.jobs.send('inbox.send', { messageId: msg.id }, { db: bossDbFor(tx) })
    await applyHumanReply(tx, deps, conv, at, now)
    return { status: 'queued', messageId: msg.id }
  })
}

// ---------------------------------------------------------------------------------------------------------
// Job `inbox.send`
// ---------------------------------------------------------------------------------------------------------

export interface DeliverDeps {
  db: Db
  events: EventPublisher
  jobs: JobSender
  cipher: SecretCipher | null
  graph: MetaClient
  /** `undefined` khi chưa cấu hình app Threads → tin Threads `failed` `SEND_FAILED`. */
  threads?: MetaClient | undefined
  log?: { warn(obj: Record<string, unknown>, msg: string): void } | undefined
  now?: () => Date
}

export type DeliverOutcome =
  | 'sent'
  | 'failed'
  /** `RATE_LIMITED`: tin về `pending`, job mới chạy sau `blocked_until`. */
  | 'deferred'
  /** Không còn dòng tin (đã huỷ trước khi gửi). */
  | 'cancelled'
  /** Tin không còn `pending` (job chạy trùng / đã xử lý). */
  | 'skipped'

export class SendRetryableError extends Error {
  readonly kind: string
  constructor(kind: string) {
    super(`inbox.send: ${kind}`)
    this.name = 'SendRetryableError'
    this.kind = kind
  }
}

/** Lỗi Meta (không retry được) → mã gửi tin. */
export function sendErrorOf(kind: MetaErrorKind, delivery: MessageDelivery): SendErrorCode {
  switch (kind) {
    case 'TOKEN_INVALID':
      return 'PAGE_DISCONNECTED'
    case 'OUTSIDE_WINDOW':
      return delivery === 'private_reply' ? 'PRIVATE_REPLY_INVALID' : 'OUTSIDE_24H'
    case 'RECIPIENT_UNAVAILABLE':
      return 'RECIPIENT_UNAVAILABLE'
    case 'PRIVATE_REPLY_INVALID':
      return 'PRIVATE_REPLY_INVALID'
    case 'PERMISSION_DENIED':
    case 'REJECTED':
      return 'SEND_REJECTED'
    case 'RATE_LIMITED':
      return 'RATE_LIMITED'
    case 'TRANSIENT':
    case 'ABORTED':
      return 'SEND_FAILED'
  }
}

type MessageRow = typeof messages.$inferSelect

interface Delivered {
  ok: true
  platformMessageId: string | null
  /** Nhắn riêng: PSID/IGSID của người bình luận do Meta trả về. */
  recipientId: string | null
}

const idOf = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)

interface CallContext {
  client: MetaClient
  token: string
  scope: string
  platform: Platform
  msg: MessageRow
  delivery: MessageDelivery
  /** DM: PSID/IGSID (`thread_key`). */
  recipient: string
}

/** Một lời gọi gửi theo nền tảng + cách gửi (AD-10). */
async function callMeta(ctx: CallContext): Promise<Delivered | MetaFailure> {
  const { client, token, scope, platform, msg, delivery } = ctx
  const base = { token, tier: 'interactive' as const, scope }
  const text = msg.text ?? ''
  if (platform === 'threads') {
    // Threads: tạo container trả lời rồi publish (2 bước). Container mồ côi khi bước 2 lỗi thì vô hại.
    const created = await client.post<{ id?: unknown }>('/me/threads', { ...base, form: { media_type: 'TEXT', text, reply_to_id: msg.replyToPlatformId ?? undefined } })
    if (!created.ok) return created
    const creationId = idOf(created.data?.id)
    if (!creationId) return { ok: false, kind: 'TRANSIENT' }
    const published = await client.post<{ id?: unknown }>('/me/threads_publish', { ...base, form: { creation_id: creationId } })
    if (!published.ok) return published
    return { ok: true, platformMessageId: idOf(published.data?.id), recipientId: null }
  }
  if (delivery === 'public_reply') {
    // FB: trả lời trong luồng bình luận; IG: chỉ trả lời được bình luận cấp một (bình luận gốc).
    const path = platform === 'facebook' ? `/${msg.replyToPlatformId}/comments` : `/${msg.replyToPlatformId}/replies`
    const res = await client.post<{ id?: unknown }>(path, { ...base, form: { message: text } })
    if (!res.ok) return res
    return { ok: true, platformMessageId: idOf(res.data?.id), recipientId: null }
  }
  // DM hoặc nhắn riêng qua Send API (token Page; IG dùng token Fanpage nguồn). Messenger echo lại `metadata` (AD-20).
  const message = platform === 'facebook' ? { text, metadata: msg.id } : { text }
  const body =
    delivery === 'private_reply'
      ? { recipient: { comment_id: msg.replyToPlatformId }, message }
      : { recipient: { id: ctx.recipient }, messaging_type: 'RESPONSE', message }
  const res = await client.post<{ message_id?: unknown; recipient_id?: unknown }>('/me/messages', { ...base, body })
  if (!res.ok) return res
  return { ok: true, platformMessageId: idOf(res.data?.message_id), recipientId: idOf(res.data?.recipient_id) }
}

/** Ghi `failed` + mã cho tin đang `sending`, phát `message.failed`. */
async function markFailed(deps: DeliverDeps, msg: MessageRow, code: SendErrorCode): Promise<DeliverOutcome> {
  await deps.db.transaction(async (tx) => {
    const [row] = await tx
      .update(messages)
      .set({ status: 'failed', errorCode: code })
      .where(and(eq(messages.id, msg.id), eq(messages.status, 'sending')))
      .returning({ id: messages.id })
    if (row) await deps.events.publishEvent(tx, 'message.failed', { id: msg.id, pageId: msg.pageId, conversationId: msg.conversationId, errorCode: code })
  })
  return 'failed'
}

/**
 * Trả tin về `pending` để lần retry (hoặc job hoãn) chiếm lại. Giữ `sending_at`: tin đã từng gọi Meta (có thể đã tới
 * khách) — nhận diện echo (Story 4.5) chỉ khớp theo nội dung với tin `pending` đã từng gửi.
 */
async function returnToPending(db: DbExecutor, messageId: string): Promise<void> {
  await db
    .update(messages)
    .set({ status: 'pending' })
    .where(and(eq(messages.id, messageId), eq(messages.status, 'sending')))
}

/**
 * Nhắn riêng thành công: gắn `recipient_id` vào cùng contact của người bình luận (AD-11). Định danh đã thuộc khách khác
 * → không tự gộp, chỉ ghi gợi ý gộp (Story 4.9) để chủ shop gộp bằng tay.
 */
async function linkRecipient(tx: DbExecutor, deps: DeliverDeps, msg: MessageRow, recipientId: string, now: Date): Promise<void> {
  const [owner] = await tx
    .select({ contactId: contactIdentities.contactId })
    .from(conversations)
    .innerJoin(contactIdentities, eq(contactIdentities.id, conversations.contactIdentityId))
    .where(eq(conversations.id, msg.conversationId))
  if (!owner) return
  const [inserted] = await tx
    .insert(contactIdentities)
    .values({ contactId: owner.contactId, pageId: msg.pageId, platformUserId: recipientId, profileFetchedAt: now })
    .onConflictDoNothing({ target: [contactIdentities.pageId, contactIdentities.platformUserId] })
    .returning({ id: contactIdentities.id })
  if (inserted) return
  const [existing] = await tx
    .select({ contactId: contactIdentities.contactId })
    .from(contactIdentities)
    .where(and(eq(contactIdentities.pageId, msg.pageId), eq(contactIdentities.platformUserId, recipientId)))
  if (existing && existing.contactId !== owner.contactId) {
    if (await suggestMerge(tx, owner.contactId, existing.contactId, 'private_reply')) {
      await deps.events.publishEvent(tx, 'contact.updated', { id: owner.contactId, pageId: msg.pageId })
      await deps.events.publishEvent(tx, 'contact.updated', { id: existing.contactId, pageId: msg.pageId })
    }
    deps.log?.warn({ messageId: msg.id, pageId: msg.pageId }, 'inbox: định danh nhắn riêng đã thuộc khách khác — ghi gợi ý gộp, gộp bằng tay')
  }
}

/** Handler job `inbox.send` cho một tin. `finalAttempt`: lần thử cuối của job → lỗi tạm thành `failed` thay vì ném. */
export async function deliverMessage(deps: DeliverDeps, messageId: string, opts: { finalAttempt: boolean }): Promise<DeliverOutcome> {
  const now = deps.now?.() ?? new Date()
  const [msg] = await deps.db
    .update(messages)
    .set({ status: 'sending', sendingAt: now })
    .where(and(eq(messages.id, messageId), eq(messages.status, 'pending')))
    .returning()
  if (!msg) {
    const [exists] = await deps.db.select({ id: messages.id }).from(messages).where(eq(messages.id, messageId))
    return exists ? 'skipped' : 'cancelled'
  }
  const delivery = (msg.delivery as MessageDelivery | null) ?? 'dm'

  // Trước lời gọi Meta: lỗi bất ngờ (DB…) → trả `pending` rồi ném để retry chiếm lại.
  let ctx: CallContext
  try {
    const [conv] = await deps.db.select().from(conversations).where(eq(conversations.id, msg.conversationId))
    const page = conv ? await getPage(deps.db, conv.pageId) : null
    if (!conv || !page) return markFailed(deps, msg, 'PAGE_REMOVED')
    if (page.connectionStatus === 'disconnected') return markFailed(deps, msg, 'PAGE_DISCONNECTED')
    const client = page.platform === 'threads' ? deps.threads : deps.graph
    if (!client) {
      deps.log?.warn({ messageId, pageId: page.id }, 'inbox: chưa cấu hình app Threads — không gửi được')
      return markFailed(deps, msg, 'SEND_FAILED')
    }
    let token: string
    try {
      token = await getAccessToken({ db: deps.db, cipher: deps.cipher }, page.id)
    } catch (err) {
      if (err instanceof AppError && (err.code === 'PAGE_REMOVED' || err.code === 'PAGE_DISCONNECTED')) return markFailed(deps, msg, err.code)
      throw err
    }
    const scope = page.platform === 'threads' ? `threads:${page.id}` : `page:${(await getPlatformAccountId(deps.db, page.id)) ?? page.id}`
    ctx = { client, token, scope, platform: page.platform, msg, delivery, recipient: conv.threadKey }
  } catch (err) {
    // Lần thử cuối: không còn lượt nào chiếm lại → `failed` `SEND_FAILED` (không kẹt `pending` mãi, chủ shop "Gửi lại"
    // được), rồi vẫn ném để báo `system_error`.
    if (opts.finalAttempt) await markFailed(deps, msg, 'SEND_FAILED')
    else await returnToPending(deps.db, msg.id)
    throw err
  }

  const res = await callMeta(ctx)
  if (res.ok) {
    await deps.db.transaction(async (tx) => {
      const [row] = await tx
        .update(messages)
        .set({ status: 'sent', platformMessageId: res.platformMessageId, errorCode: null })
        .where(and(eq(messages.id, msg.id), eq(messages.status, 'sending')))
        .returning({ id: messages.id })
      // Gắn định danh nhắn riêng kể cả khi echo (Story 4.5) đã đặt `sent` trước khi Meta trả lời: `recipient_id` chỉ có
      // trong phản hồi Send API, bỏ lỡ ở đây thì khách trả lời qua Messenger thành khách mới.
      if (delivery === 'private_reply' && res.recipientId) await linkRecipient(tx, deps, msg, res.recipientId, now)
      if (!row) return
      await deps.events.publishEvent(tx, 'message.sent', { id: msg.id, pageId: msg.pageId, conversationId: msg.conversationId })
    })
    if (!res.platformMessageId) deps.log?.warn({ messageId }, 'inbox: Meta nhận tin nhưng không trả id')
    return 'sent'
  }

  deps.log?.warn({ messageId, pageId: msg.pageId, kind: res.kind, code: res.code, subcode: res.subcode }, 'inbox: gửi tin lỗi')
  if (res.kind === 'RATE_LIMITED') {
    const retryAfterMs = Math.max(1000, res.retryAfterMs ?? 0)
    const queuedAt = msg.queuedAt ?? msg.createdAt
    if (now.getTime() + retryAfterMs - queuedAt.getTime() > RATE_LIMIT_DEFER_MAX_MS) return markFailed(deps, msg, 'RATE_LIMITED')
    // Hoãn tới `blocked_until` bằng job mới: không tính vào số lần retry của job này.
    await deps.db.transaction(async (tx) => {
      await returnToPending(tx, msg.id)
      await deps.jobs.send('inbox.send', { messageId: msg.id }, { startAfter: new Date(now.getTime() + retryAfterMs), db: bossDbFor(tx) })
    })
    return 'deferred'
  }
  if (res.kind === 'TRANSIENT') {
    if (opts.finalAttempt) return markFailed(deps, msg, 'SEND_FAILED')
    await returnToPending(deps.db, msg.id)
    throw new SendRetryableError(res.kind)
  }
  if (res.kind === 'TOKEN_INVALID') await reportTokenInvalid(deps, msg.pageId)
  return markFailed(deps, msg, sendErrorOf(res.kind, delivery))
}

export function parseSendJobData(data: unknown): { messageId: string } {
  const id = (data as { messageId?: unknown } | null)?.messageId
  if (typeof id !== 'string' || id === '') throw new Error('inbox.send: thiếu messageId')
  return { messageId: id }
}

/** Handler job `inbox.send` cho worker. */
export async function handleSendJob(deps: DeliverDeps, job: { data: unknown; retryCount: number; retryLimit: number }): Promise<DeliverOutcome> {
  const { messageId } = parseSendJobData(job.data)
  return deliverMessage(deps, messageId, { finalAttempt: job.retryCount >= job.retryLimit })
}

// ---------------------------------------------------------------------------------------------------------
// Cron `inbox.send_sweep`
// ---------------------------------------------------------------------------------------------------------

/** Tin kẹt `sending` quá 15 phút → `failed` `SEND_UNKNOWN` + `message.failed`. Trả số tin đã đổi. */
export async function sweepStuckSending(deps: { db: Db; events: EventPublisher; now?: () => Date }): Promise<number> {
  const now = deps.now?.() ?? new Date()
  const cutoff = new Date(now.getTime() - SENDING_STUCK_MS)
  return deps.db.transaction(async (tx) => {
    const rows = await tx
      .update(messages)
      .set({ status: 'failed', errorCode: 'SEND_UNKNOWN' })
      .where(and(eq(messages.status, 'sending'), lt(messages.sendingAt, cutoff)))
      .returning({ id: messages.id, pageId: messages.pageId, conversationId: messages.conversationId })
    for (const r of rows) {
      await deps.events.publishEvent(tx, 'message.failed', { id: r.id, pageId: r.pageId, conversationId: r.conversationId, errorCode: 'SEND_UNKNOWN' })
    }
    return rows.length
  })
}
