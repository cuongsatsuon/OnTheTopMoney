// `inbox.ingest` cho tin DM (Story 4.3, AD-9, AD-11): một tin khách Messenger / IG Direct đã chuẩn hoá
// (`adapters/meta`) → định danh → khách → hội thoại → tin, trong MỘT transaction (AD-2, AD-3):
// - Khoá `pg_advisory_xact_lock` theo `(page_id,'dm',thread_key)`: hai job song song của cùng một khách không tạo
//   hai contact / hai hội thoại, và không chuyển trạng thái chồng nhau.
// - Định danh mới → contact mới (không tự gộp) + job `inbox.fetch_profile` lấy tên.
// - Tin trùng `(page_id, platform_message_id)` → không đổi gì, không phát sự kiện (route chạy lại / Meta gửi lại).
// - `last_customer_message_at`, `last_message_at` chỉ tăng; tin tới lệch thứ tự vẫn hiển thị theo `platform_timestamp`.
// - Hội thoại mới hoặc `done` → `triage` (tăng `state_version`; không ghi tin `system`, không phát `state_changed`
//   — `autoreply.triage` giải ngay và ghi lần chuyển có lý do). `human` mà chưa chờ → đặt `waiting_since`.
// - Đính kèm → dòng `pending` + job `inbox.fetch_attachment` (tải ngoài transaction).
// - Phát `message.received` (chỉ tin inbound).
// Không gọi mạng ở đây. Không log nội dung tin.
import type { DmMessage } from '../../adapters/meta/index.ts'
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

export async function ingestDm(deps: IngestDeps, input: IngestDmInput): Promise<IngestResult> {
  const { pageId, message } = input
  const at = message.timestamp
  const atSql = sql`${at.toISOString()}::timestamptz`
  return deps.db.transaction(async (tx) => {
    await lockThread(tx, threadLockKey(pageId, 'dm', message.senderId))

    // Tin đã có → không đổi gì (khoá luồng bảo đảm bản gốc đã commit hoặc chưa bắt đầu).
    const [existing] = await tx
      .select({ id: messages.id })
      .from(messages)
      .where(and(eq(messages.pageId, pageId), eq(messages.platformMessageId, message.mid)))
    if (existing) return { status: 'duplicate', messageId: existing.id }

    // Định danh → contact (định danh mới tạo khách mới, AD-11).
    let [identity] = await tx
      .select({ id: contactIdentities.id, contactId: contactIdentities.contactId })
      .from(contactIdentities)
      .where(and(eq(contactIdentities.pageId, pageId), eq(contactIdentities.platformUserId, message.senderId)))
    const newContact = !identity
    if (!identity) {
      const [contact] = await tx.insert(contacts).values({}).returning({ id: contacts.id })
      ;[identity] = await tx
        .insert(contactIdentities)
        .values({ contactId: contact!.id, pageId, platformUserId: message.senderId })
        .returning({ id: contactIdentities.id, contactId: contactIdentities.contactId })
      await deps.jobs.send('inbox.fetch_profile', { identityId: identity!.id }, { db: bossDbFor(tx) })
    }

    // Hội thoại `(page_id, 'dm', PSID|IGSID)`.
    let [conv] = await tx
      .select()
      .from(conversations)
      .where(and(eq(conversations.pageId, pageId), eq(conversations.channel, 'dm'), eq(conversations.threadKey, message.senderId)))
      .for('update')
    const newConversation = !conv
    if (!conv) {
      ;[conv] = await tx
        .insert(conversations)
        .values({
          pageId,
          channel: 'dm',
          threadKey: message.senderId,
          contactIdentityId: identity!.id,
          state: 'triage',
          lastMessageAt: at,
          lastCustomerMessageAt: at,
        })
        .returning()
    }

    const [inserted] = await tx
      .insert(messages)
      .values({
        conversationId: conv!.id,
        pageId,
        platformMessageId: message.mid,
        direction: 'inbound',
        origin: 'customer',
        text: message.text,
        platformTimestamp: at,
      })
      .onConflictDoNothing({ target: [messages.pageId, messages.platformMessageId], where: sql`platform_message_id is not null` })
      .returning({ id: messages.id })
    if (!inserted) {
      // Không thể xảy ra dưới khoá luồng (đã kiểm ở trên); phòng hờ → huỷ mọi thứ vừa tạo.
      throw new Error('inbox.ingest: tin trùng xuất hiện giữa transaction')
    }

    for (const [position, attachment] of message.attachments.entries()) {
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
