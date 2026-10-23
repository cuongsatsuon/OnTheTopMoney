// Tin của chính trang (Story 4.5, AD-20, AD-9, AD-4). `webhook.route` chuyển vào đây mọi tin/bình luận có tác giả là
// trang (echo Messenger/IG, bình luận của trang trên FB/IG, trả lời Threads của tài khoản) — PHÂN LOẠI TRƯỚC KHI GHI:
// - Tin app đã gửi: đã có `(page_id, platform_message_id)` → `duplicate`; khớp `metadata` = `messages.id` (Messenger), hoặc
//   khớp tin `sending|sent` (hay `pending` đã từng gọi Meta) chưa có id, cùng chữ, cách thời điểm echo ≤120 giây → gắn id,
//   `sent`, phát
//   `message.sent`. Không tạo tin, không phát `message.received`, không đổi trạng thái hội thoại.
// - Chưa khớp: `app_id` của app khác (Business Suite, app Facebook…) → chủ shop trả lời ngoài app: chèn `external_human`
//   và `applyHumanReply` (`human` `HUMAN_REPLIED`, tắt AI). Còn lại (app mình / không rõ app) → job `inbox.echo_match`
//   thử lại sau 5 giây × 3; hết lượt → `app_unmatched` (app mình, không đổi trạng thái) hoặc `external_human` (không rõ).
// - Luồng chưa có hội thoại (khách chưa có trong Hộp thư, trang bình luận thẳng trên bài) → `no_conversation`, không tạo gì.
// - "Đã nhận / đã xem" của tin outbound (`markOutboundReceipt`): `sent → delivered → read`, không bao giờ hạ.
// Cùng khoá luồng với ingest/gửi tin. Không gọi mạng. Không log nội dung tin.
import { ATTACHMENT_KINDS, type MessageOrigin } from '@ottm/shared'
import { and, asc, eq, inArray, isNotNull, isNull, lte, max, or, sql } from 'drizzle-orm'
import { z } from 'zod'
import type { DmAttachment, DmEcho, DmReceipt, PageComment } from '../../adapters/meta/index.ts'
import { bossDbFor, type Db, type DbExecutor } from '../../platform/db/index.ts'
import type { EventPublisher } from '../../platform/events/index.ts'
import type { JobSender } from '../../platform/jobs/index.ts'
import { commentThreadKey, insertAttachments, lockThread, threadLockKey } from './ingest.ts'
import { conversations, messages } from './schema.ts'
import { applyHumanReply, type ConversationRow } from './state.ts'

/** Echo khớp tin vào hàng cách nó tối đa chừng này (AD-20). */
export const ECHO_MATCH_WINDOW_MS = 120_000
/** Lần thử lại đầu tiên sau lần thử trong `webhook.route`. */
export const ECHO_MATCH_DELAY_MS = 5_000
/** Số lần thử lại (job `inbox.echo_match`) trước khi chèn tin chưa khớp. */
export const ECHO_MATCH_ATTEMPTS = 3

/** Tin của chính trang, dạng chung cho DM và bình luận. */
export interface EchoMessage {
  channel: 'dm' | 'comment'
  /** DM: PSID/IGSID của khách; bình luận: id bình luận được trả lời (`null` = trang bình luận thẳng trên bài). */
  threadRef: string | null
  platformMessageId: string
  text: string | null
  timestamp: Date
  attachments: DmAttachment[]
  /** App đã gửi (Messenger `app_id`); `null` khi nền tảng không cho biết. */
  appId: string | null
  /** Messenger `metadata` (app này gửi `messages.id`). */
  metadata: string | null
}

export const echoFromDm = (e: DmEcho): EchoMessage => ({
  channel: 'dm',
  threadRef: e.customerId,
  platformMessageId: e.mid,
  text: e.text,
  timestamp: e.timestamp,
  attachments: e.attachments,
  appId: e.appId,
  metadata: e.metadata,
})

export const echoFromComment = (c: PageComment): EchoMessage => ({
  channel: 'comment',
  threadRef: c.parentId,
  platformMessageId: c.commentId,
  text: c.text,
  timestamp: c.timestamp,
  attachments: c.attachments,
  appId: null,
  metadata: null,
})

export interface EchoDeps {
  db: Db
  events: EventPublisher
  jobs: JobSender
  /** Id app Meta/Threads của chính máy chủ này (`META_APP_ID`…); rỗng = không phân biệt được theo `app_id`. */
  appIds?: readonly string[] | undefined
  now?: () => Date
}

export interface EchoInput {
  /** Trang nội bộ đã khớp ở `webhook.route` (chưa gỡ). */
  pageId: string
  echo: EchoMessage
}

/** `first`: trong `webhook.route` (chưa khớp → enqueue job); `retry`: job chưa phải lần cuối; `final`: lần cuối. */
export type EchoAttempt = 'first' | 'retry' | 'final'

export type EchoResult =
  /** Tin đã có id này — không đổi gì. */
  | { status: 'duplicate'; messageId: string }
  /** Khớp tin app đã gửi: gắn id (+ `sent`). */
  | { status: 'matched'; messageId: string }
  | { status: 'inserted'; messageId: string; origin: Extract<MessageOrigin, 'external_human' | 'app_unmatched'> }
  /** Lần đầu chưa khớp: đã enqueue `inbox.echo_match`. */
  | { status: 'deferred' }
  /** Lần thử lại chưa khớp (handler ném để pg-boss thử lại). */
  | { status: 'unmatched' }
  | { status: 'no_conversation' }

const OWN_ORIGINS = ['app_human', 'app_ai'] as const
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type MessageRow = typeof messages.$inferSelect

/**
 * Ai viết tin (khi chưa khớp): `other_app` — `app_id` có và không phải app mình (chắc chắn ngoài app); `own_app` — `app_id`
 * của app mình, hoặc có `metadata` (chỉ app gọi Send API mới gắn); `unknown` — nền tảng không cho biết.
 */
export function echoAuthor(echo: Pick<EchoMessage, 'appId' | 'metadata'>, appIds: readonly string[]): 'other_app' | 'own_app' | 'unknown' {
  if (echo.appId && appIds.length > 0) return appIds.includes(echo.appId) ? 'own_app' : 'other_app'
  return echo.metadata ? 'own_app' : 'unknown'
}

/** Tin outbound của app mà echo này là bản phản hồi; `null` khi chưa khớp. Chạy trong transaction, sau khoá luồng. */
async function findOwnMessage(tx: DbExecutor, pageId: string, echo: EchoMessage, conv: ConversationRow | null): Promise<MessageRow | null> {
  const own = and(eq(messages.pageId, pageId), eq(messages.direction, 'outbound'), inArray(messages.origin, [...OWN_ORIGINS]))
  if (echo.metadata && UUID_RE.test(echo.metadata)) {
    const [row] = await tx
      .select()
      .from(messages)
      .where(and(own, eq(messages.id, echo.metadata)))
      .for('update')
    // Tin đã gắn id KHÁC (không thể với Messenger) → không phải echo của tin này.
    if (row && (row.platformMessageId === null || row.platformMessageId === echo.platformMessageId)) return row
  }
  const text = echo.text?.trim()
  if (!text) return null
  // DM: tin thường của hội thoại DM, hoặc nhắn riêng (nằm ở hội thoại bình luận) của cùng trang. Bình luận: trả lời công
  // khai trong đúng luồng.
  const scope =
    echo.channel === 'dm'
      ? or(conv ? and(eq(messages.conversationId, conv.id), eq(messages.delivery, 'dm')) : undefined, eq(messages.delivery, 'private_reply'))
      : conv
        ? and(eq(messages.conversationId, conv.id), eq(messages.delivery, 'public_reply'))
        : undefined
  if (!scope) return null
  const queued = sql`coalesce(${messages.sendingAt}, ${messages.queuedAt}, ${messages.createdAt})`
  const [row] = await tx
    .select()
    .from(messages)
    .where(
      and(
        own,
        scope,
        isNull(messages.platformMessageId),
        // `pending` chưa từng gọi Meta (`sending_at` trống) không thể là echo; đã gọi rồi trả về chờ retry thì có thể.
        or(inArray(messages.status, ['sending', 'sent']), and(eq(messages.status, 'pending'), isNotNull(messages.sendingAt))),
        eq(messages.text, text),
        sql`abs(extract(epoch from (${queued} - ${echo.timestamp.toISOString()}::timestamptz))) * 1000 <= ${ECHO_MATCH_WINDOW_MS}`,
      ),
    )
    .orderBy(asc(queued), asc(messages.id))
    .limit(1)
    .for('update')
  return row ?? null
}

/** Gắn id nền tảng vào tin của app; tin chưa xong (`pending|sending`) hoặc lỗi không rõ → `sent` (echo = đã tới khách). */
async function attachEcho(tx: DbExecutor, deps: EchoDeps, row: MessageRow, echo: EchoMessage): Promise<EchoResult> {
  const toSent = row.status === 'pending' || row.status === 'sending' || row.status === 'failed'
  if (!toSent && row.platformMessageId === echo.platformMessageId) return { status: 'duplicate', messageId: row.id }
  await tx
    .update(messages)
    .set({
      platformMessageId: echo.platformMessageId,
      ...(toSent ? { status: 'sent', errorCode: null, sentAt: sql`coalesce(${messages.sentAt}, now())` } : {}),
    })
    .where(eq(messages.id, row.id))
  const payload = { id: row.id, pageId: row.pageId, conversationId: row.conversationId }
  await deps.events.publishEvent(tx, toSent ? 'message.sent' : 'message.updated', payload)
  return { status: 'matched', messageId: row.id }
}

/** Chèn tin của trang (chưa khớp tin nào của app) vào hội thoại; `external_human` → chuyển `human` (AD-9). */
async function insertPageMessage(
  tx: DbExecutor,
  deps: EchoDeps,
  conv: ConversationRow,
  echo: EchoMessage,
  origin: 'external_human' | 'app_unmatched',
  now: Date,
): Promise<EchoResult> {
  const at = echo.timestamp
  const [row] = await tx
    .insert(messages)
    .values({
      conversationId: conv.id,
      pageId: conv.pageId,
      platformMessageId: echo.platformMessageId,
      direction: 'outbound',
      origin,
      status: 'sent',
      delivery: echo.channel === 'dm' ? 'dm' : 'public_reply',
      replyToPlatformId: echo.channel === 'comment' ? echo.threadRef : null,
      text: echo.text,
      platformTimestamp: at,
    })
    .returning({ id: messages.id })
  const messageId = row!.id
  await insertAttachments(tx, deps.jobs, messageId, echo.attachments)
  if (origin === 'external_human') {
    await applyHumanReply(tx, { db: deps.db, events: deps.events }, conv, at, now)
  } else {
    // Không đổi trạng thái; đã có tin trả lời → khách hết chờ ở `human` (mốc chờ cũ không được giữ cho tin khách sau).
    await tx
      .update(conversations)
      .set({
        lastMessageAt: sql`greatest(${conversations.lastMessageAt}, ${at.toISOString()}::timestamptz)`,
        ...(conv.state === 'human' ? { waitingSince: null } : {}),
        updatedAt: now,
      })
      .where(eq(conversations.id, conv.id))
  }
  await deps.events.publishEvent(tx, 'message.sent', { id: messageId, pageId: conv.pageId, conversationId: conv.id })
  return { status: 'inserted', messageId, origin }
}

/** Phân loại + ghi một tin của chính trang (xem đầu file). Idempotent theo `(page_id, platform_message_id)`. */
export async function ingestEcho(deps: EchoDeps, input: EchoInput, attempt: EchoAttempt = 'first'): Promise<EchoResult> {
  const { pageId, echo } = input
  const now = deps.now?.() ?? new Date()
  // Luồng: DM → khách; bình luận → luồng của bình luận được trả lời (tra trước khoá như `ingestComment`).
  const threadKey = echo.channel === 'comment' && echo.threadRef ? await commentThreadKey(deps.db, pageId, echo.threadRef) : echo.threadRef
  return deps.db.transaction(async (tx): Promise<EchoResult> => {
    if (threadKey) await lockThread(tx, threadLockKey(pageId, echo.channel, threadKey))
    const [existing] = await tx
      .select({ id: messages.id })
      .from(messages)
      .where(and(eq(messages.pageId, pageId), eq(messages.platformMessageId, echo.platformMessageId)))
    if (existing) return { status: 'duplicate', messageId: existing.id }

    const [conv] = threadKey
      ? await tx
          .select()
          .from(conversations)
          .where(and(eq(conversations.pageId, pageId), eq(conversations.channel, echo.channel), eq(conversations.threadKey, threadKey)))
          .for('update')
      : []
    const own = await findOwnMessage(tx, pageId, echo, conv ?? null)
    if (own) return attachEcho(tx, deps, own, echo)
    if (!conv) return { status: 'no_conversation' }

    const author = echoAuthor(echo, deps.appIds ?? [])
    if (author !== 'other_app' && attempt !== 'final') {
      if (attempt === 'retry') return { status: 'unmatched' }
      await deps.jobs.send('inbox.echo_match', echoJobData(pageId, echo), {
        startAfter: new Date(now.getTime() + ECHO_MATCH_DELAY_MS),
        db: bossDbFor(tx),
      })
      return { status: 'deferred' }
    }
    return insertPageMessage(tx, deps, conv, echo, author === 'own_app' ? 'app_unmatched' : 'external_human', now)
  })
}

// ---------------------------------------------------------------------------------------------------------
// Job `inbox.echo_match`
// ---------------------------------------------------------------------------------------------------------

/** Chưa khớp ở lần thử lại chưa cuối — handler ném để pg-boss chạy lại sau `retryDelay` (5 giây). */
export class EchoUnmatchedError extends Error {
  constructor() {
    super('inbox.echo_match: chưa khớp')
    this.name = 'EchoUnmatchedError'
  }
}

const EchoJobSchema = z.object({
  pageId: z.string().min(1),
  echo: z.object({
    channel: z.enum(['dm', 'comment']),
    threadRef: z.string().min(1).nullable(),
    platformMessageId: z.string().min(1),
    text: z.string().nullable(),
    timestamp: z.iso.datetime({ offset: true }),
    attachments: z.array(z.object({ kind: z.enum(ATTACHMENT_KINDS), url: z.string().min(1) })),
    appId: z.string().nullable(),
    metadata: z.string().nullable(),
  }),
})

/** Payload JSON của job (thời điểm dạng ISO). */
export function echoJobData(pageId: string, echo: EchoMessage) {
  return { pageId, echo: { ...echo, timestamp: echo.timestamp.toISOString() } }
}

export function parseEchoMatchJobData(data: unknown): EchoInput {
  const parsed = EchoJobSchema.safeParse(data)
  if (!parsed.success) throw new Error('inbox.echo_match: payload không hợp lệ')
  const { pageId, echo } = parsed.data
  return { pageId, echo: { ...echo, timestamp: new Date(echo.timestamp) } }
}

/** Handler job `inbox.echo_match`: lần chạy thứ `ECHO_MATCH_ATTEMPTS` (và lượt dự phòng sau đó) là lần cuối. */
export async function handleEchoMatchJob(deps: EchoDeps, job: { data: unknown; retryCount: number }): Promise<EchoResult> {
  const input = parseEchoMatchJobData(job.data)
  const result = await ingestEcho(deps, input, job.retryCount >= ECHO_MATCH_ATTEMPTS - 1 ? 'final' : 'retry')
  if (result.status === 'unmatched') throw new EchoUnmatchedError()
  return result
}

// ---------------------------------------------------------------------------------------------------------
// Đã nhận / đã xem
// ---------------------------------------------------------------------------------------------------------

export interface ReceiptInput {
  pageId: string
  receipt: DmReceipt
}

export type ReceiptResult =
  | { status: 'updated'; count: number }
  /** Có hội thoại nhưng không tin nào đổi (đã ở trạng thái đó / chưa có id). */
  | { status: 'unchanged' }
  /** Không có hội thoại DM của khách và không tin nào khớp `mids`. */
  | { status: 'missing' }

/**
 * Webhook "đã nhận / đã xem" (AD-4) → trạng thái tin outbound của trang: `delivered` cho tin `sent`; `read` cho tin
 * `sent|delivered`. Tin trong hội thoại DM có `platform_timestamp ≤` mốc (`watermark`; IG: thời điểm tin có `mid`), cộng
 * tin có id thuộc `mids` (gồm cả nhắn riêng ở hội thoại bình luận). Phát `message.updated` cho mỗi hội thoại có đổi.
 */
export async function markOutboundReceipt(deps: { db: Db; events: EventPublisher }, input: ReceiptInput): Promise<ReceiptResult> {
  const { pageId, receipt } = input
  return deps.db.transaction(async (tx): Promise<ReceiptResult> => {
    const [conv] = await tx
      .select({ id: conversations.id })
      .from(conversations)
      .where(and(eq(conversations.pageId, pageId), eq(conversations.channel, 'dm'), eq(conversations.threadKey, receipt.customerId)))
    let mark = receipt.watermark
    if (!mark && conv && receipt.mids.length > 0) {
      const [row] = await tx
        .select({ at: max(messages.platformTimestamp) })
        .from(messages)
        .where(and(eq(messages.conversationId, conv.id), inArray(messages.platformMessageId, receipt.mids)))
      mark = row?.at ?? null
    }
    const target = or(
      receipt.mids.length > 0 ? inArray(messages.platformMessageId, receipt.mids) : undefined,
      conv && mark ? and(eq(messages.conversationId, conv.id), lte(messages.platformTimestamp, mark)) : undefined,
    )
    if (!target) return conv ? { status: 'unchanged' } : { status: 'missing' }
    const from = receipt.status === 'delivered' ? ['sent'] : ['sent', 'delivered']
    const rows = await tx
      .update(messages)
      .set({ status: receipt.status })
      .where(and(eq(messages.pageId, pageId), eq(messages.direction, 'outbound'), inArray(messages.status, from), target))
      .returning({ id: messages.id, conversationId: messages.conversationId })
    if (rows.length === 0) return conv ? { status: 'unchanged' } : { status: 'missing' }
    const lastOf = new Map(rows.map((r) => [r.conversationId, r.id]))
    for (const [conversationId, id] of lastOf) await deps.events.publishEvent(tx, 'message.updated', { id, pageId, conversationId })
    return { status: 'updated', count: rows.length }
  })
}
