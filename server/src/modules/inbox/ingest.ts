// `inbox.ingest` (AD-9, AD-11): một tin khách đã chuẩn hoá (`adapters/meta`) → định danh → khách → hội thoại → tin,
// trong MỘT transaction (AD-2, AD-3). Story 4.3: DM Messenger / IG Direct (`ingestDm`). Story 4.4: bình luận FB/IG và
// trả lời Threads (`ingestComment`) — cùng lõi `ingestInbound`, khác khoá luồng và định danh:
// - Khoá `pg_advisory_xact_lock` theo `(page_id, channel, thread_key)`: hai job song song của cùng một luồng không tạo
//   hai contact / hai hội thoại, và không chuyển trạng thái chồng nhau.
// - Định danh mới → contact mới (không tự gộp). DM: job `inbox.fetch_profile` lấy tên. Bình luận: tên/username có sẵn
//   trong payload → ghi ngay, không gọi Meta.
// - Bình luận: `thread_key` = id bình luận gốc; trả lời trong luồng vào hội thoại của bình luận cha (tra theo tin đã
//   có). Hội thoại mới lưu `platform_post_id` + job `inbox.fetch_post_text` lấy caption bài một lần.
// - Tin trùng `(page_id, platform_message_id)` → không đổi gì, không phát sự kiện (route chạy lại / Meta gửi lại).
// - `last_customer_message_at`, `last_message_at` chỉ tăng; tin tới lệch thứ tự vẫn hiển thị theo `platform_timestamp`.
// - Hội thoại mới hoặc `done` → `triage` (tăng `state_version`; không ghi tin `system`, không phát `state_changed`
//   — `autoreply.triage` giải ngay và ghi lần chuyển có lý do). `human` mà chưa chờ → đặt `waiting_since`.
// - Đính kèm → dòng `pending` + job `inbox.fetch_attachment` (tải ngoài transaction).
// - Phát `message.received` (chỉ tin inbound).
// Không gọi mạng ở đây. Không log nội dung tin.
import type { CommentAuthor, DmAttachment, DmMessage, NewComment } from '../../adapters/meta/index.ts'
import { and, eq, sql } from 'drizzle-orm'
import { bossDbFor, type Db, type DbExecutor } from '../../platform/db/index.ts'
import type { EventPublisher } from '../../platform/events/index.ts'
import type { JobSender } from '../../platform/jobs/index.ts'
import { contactIdentities, contacts, conversations, messageAttachments, messages } from './schema.ts'

export interface IngestDeps {
  db: Db
  events: EventPublisher
  jobs: JobSender
}

export interface IngestDmInput {
  /** Trang nội bộ đã khớp ở `webhook.route` (chưa gỡ). */
  pageId: string
  message: DmMessage
}

export interface IngestCommentInput {
  /** Trang nội bộ đã khớp ở `webhook.route` (chưa gỡ). */
  pageId: string
  comment: NewComment
}

export type IngestResult =
  | { status: 'created'; conversationId: string; messageId: string; newConversation: boolean; newContact: boolean }
  /** Tin đã có (cùng `mid` trên trang) — không đổi gì. */
  | { status: 'duplicate'; messageId: string }

/** Khoá advisory 64-bit của một luồng hội thoại (serialize ingest + chuyển trạng thái của cùng khách). */
export function threadLockKey(pageId: string, channel: 'dm' | 'comment', threadKey: string): string {
  return `inbox:${pageId}:${channel}:${threadKey}`
}

export async function lockThread(tx: DbExecutor, key: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`)
}

/** Một tin inbound đã chuẩn hoá, chung cho DM và bình luận. */
interface InboundMessage {
  pageId: string
  channel: 'dm' | 'comment'
  threadKey: string
  platformMessageId: string
  /** Khoá định danh theo trang (PSID/IGSID/id người bình luận). */
  author: CommentAuthor
  /** DM: chưa có tên → job hồ sơ. Bình luận: tên lấy từ payload. */
  fetchProfile: boolean
  text: string | null
  timestamp: Date
  attachments: DmAttachment[]
  /** Chỉ hội thoại `comment`. */
  platformPostId: string | null
}

export async function ingestDm(deps: IngestDeps, input: IngestDmInput): Promise<IngestResult> {
  const { pageId, message } = input
  return ingestInbound(deps, {
    pageId,
    channel: 'dm',
    threadKey: message.senderId,
    platformMessageId: message.mid,
    author: { id: message.senderId, name: null, username: null },
    fetchProfile: true,
    text: message.text,
    timestamp: message.timestamp,
    attachments: message.attachments,
    platformPostId: null,
  })
}

/**
 * Bình luận FB/IG, trả lời Threads (Story 4.4). Luồng = bình luận gốc: bình luận trên bài → chính nó; trả lời →
 * hội thoại chứa tin `parentId` cùng trang (Threads lồng nhiều cấp), chưa có tin đó thì `parentId` (FB/IG: cha luôn là
 * bình luận gốc). Tra cứu chạy trước khoá luồng (chưa biết khoá) — đua với chính bình luận cha thì vẫn ra `parentId`.
 */
export async function ingestComment(deps: IngestDeps, input: IngestCommentInput): Promise<IngestResult> {
  const { pageId, comment } = input
  let threadKey = comment.commentId
  if (comment.parentId) {
    const [parent] = await deps.db
      .select({ threadKey: conversations.threadKey })
      .from(messages)
      .innerJoin(conversations, eq(conversations.id, messages.conversationId))
      .where(and(eq(messages.pageId, pageId), eq(messages.platformMessageId, comment.parentId), eq(conversations.channel, 'comment')))
    threadKey = parent?.threadKey ?? comment.parentId
  }
  return ingestInbound(deps, {
    pageId,
    channel: 'comment',
    threadKey,
    platformMessageId: comment.commentId,
    author: comment.author,
    fetchProfile: false,
    text: comment.text,
    timestamp: comment.timestamp,
    attachments: comment.attachments,
    platformPostId: comment.platformPostId,
  })
}

/** Tên hiển thị của khách lấy từ payload bình luận (FB `from.name`, IG/Threads username). */
const authorLabel = (author: CommentAuthor): string | null => author.name ?? (author.username ? `@${author.username}` : null)

async function ingestInbound(deps: IngestDeps, input: InboundMessage): Promise<IngestResult> {
  const { pageId, channel, threadKey } = input
  const at = input.timestamp
  const atSql = sql`${at.toISOString()}::timestamptz`
  return deps.db.transaction(async (tx) => {
    await lockThread(tx, threadLockKey(pageId, channel, threadKey))

    // Tin đã có → không đổi gì (khoá luồng bảo đảm bản gốc đã commit hoặc chưa bắt đầu).
    const [existing] = await tx
      .select({ id: messages.id })
      .from(messages)
      .where(and(eq(messages.pageId, pageId), eq(messages.platformMessageId, input.platformMessageId)))
    if (existing) return { status: 'duplicate', messageId: existing.id }

    // Định danh → contact (định danh mới tạo khách mới, AD-11). Hai luồng bình luận của cùng người chạy song song
    // (khoá luồng khác nhau) có thể cùng tạo định danh → bên thua vi phạm UNIQUE, cả transaction huỷ và job
    // `webhook.route` retry, lần sau thấy định danh đã có.
    let [identity] = await tx
      .select({ id: contactIdentities.id, contactId: contactIdentities.contactId })
      .from(contactIdentities)
      .where(and(eq(contactIdentities.pageId, pageId), eq(contactIdentities.platformUserId, input.author.id)))
    const newContact = !identity
    if (!identity) {
      const name = input.fetchProfile ? null : authorLabel(input.author)
      const [contact] = await tx.insert(contacts).values({ name }).returning({ id: contacts.id })
      ;[identity] = await tx
        .insert(contactIdentities)
        .values({
          contactId: contact!.id,
          pageId,
          platformUserId: input.author.id,
          displayName: input.author.name,
          username: input.author.username,
          // Bình luận đã mang tên → không cần job hồ sơ.
          profileFetchedAt: input.fetchProfile ? null : new Date(),
        })
        .returning({ id: contactIdentities.id, contactId: contactIdentities.contactId })
      if (input.fetchProfile) await deps.jobs.send('inbox.fetch_profile', { identityId: identity!.id }, { db: bossDbFor(tx) })
    }

    // Hội thoại `(page_id, channel, thread_key)`.
    let [conv] = await tx
      .select()
      .from(conversations)
      .where(and(eq(conversations.pageId, pageId), eq(conversations.channel, channel), eq(conversations.threadKey, threadKey)))
      .for('update')
    const newConversation = !conv
    if (!conv) {
      ;[conv] = await tx
        .insert(conversations)
        .values({
          pageId,
          channel,
          threadKey,
          contactIdentityId: identity!.id,
          state: 'triage',
          lastMessageAt: at,
          lastCustomerMessageAt: at,
          platformPostId: input.platformPostId,
        })
        .returning()
      if (input.platformPostId) await deps.jobs.send('inbox.fetch_post_text', { conversationId: conv!.id }, { db: bossDbFor(tx) })
    }

    const [inserted] = await tx
      .insert(messages)
      .values({
        conversationId: conv!.id,
        pageId,
        platformMessageId: input.platformMessageId,
        direction: 'inbound',
        origin: 'customer',
        text: input.text,
        senderIdentityId: identity!.id,
        platformTimestamp: at,
      })
      .onConflictDoNothing({ target: [messages.pageId, messages.platformMessageId], where: sql`platform_message_id is not null` })
      .returning({ id: messages.id })
    if (!inserted) {
      // Không thể xảy ra dưới khoá luồng (đã kiểm ở trên); phòng hờ → huỷ mọi thứ vừa tạo.
      throw new Error('inbox.ingest: tin trùng xuất hiện giữa transaction')
    }

    for (const [position, attachment] of input.attachments.entries()) {
      const [row] = await tx
        .insert(messageAttachments)
        .values({ messageId: inserted.id, position, kind: attachment.kind, sourceUrl: attachment.url })
        .returning({ id: messageAttachments.id })
      await deps.jobs.send('inbox.fetch_attachment', { attachmentId: row!.id }, { db: bossDbFor(tx) })
    }

    if (!newConversation) {
      const c = conv!
      const reopen = c.state === 'done'
      await tx
        .update(conversations)
        .set({
          lastMessageAt: sql`greatest(${conversations.lastMessageAt}, ${atSql})`,
          lastCustomerMessageAt: sql`greatest(${conversations.lastCustomerMessageAt}, ${atSql})`,
          ...(reopen ? { state: 'triage', stateVersion: c.stateVersion + 1 } : {}),
          // `human`: khách nhắn mà chưa ai trả lời → bắt đầu đếm chờ (AD-9). Đang chờ thì giữ mốc cũ.
          ...(c.state === 'human' && c.waitingSince === null ? { waitingSince: at } : {}),
          updatedAt: new Date(),
        })
        .where(eq(conversations.id, c.id))
    }

    await deps.events.publishEvent(tx, 'message.received', { id: inserted.id, pageId, conversationId: conv!.id })
    return { status: 'created', conversationId: conv!.id, messageId: inserted.id, newConversation, newContact }
  })
}
