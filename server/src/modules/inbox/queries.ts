// Đọc Hộp thư cho REST (Story 4.3, AD-18): danh sách hội thoại theo tập trang đã giải phạm vi (bên gọi dùng
// `pages.resolveScope`), một hội thoại, trang tin của hội thoại. Cursor mờ `{items, nextCursor}`, mặc định 50.
// - Danh sách: mới nhất trước theo `(last_message_at, id)`; xem trước = tin mới nhất không phải `system`.
// - Tin: trang MỚI NHẤT theo `(platform_timestamp, id)`, trả theo thứ tự hiển thị (cũ → mới); cursor lùi về tin cũ.
// - Story 4.4: hội thoại `comment` kèm bài được bình luận; tin kèm sửa/xoá/ẩn và khách viết tin (luồng bình luận có
//   thể có nhiều người).
// Trang đã gỡ → hội thoại không còn hiện (danh sách lọc theo trang chưa gỡ; `getConversation` kiểm `getPage`).
import type {
  AttachmentDto,
  ContactStage,
  ConversationChannel,
  ConversationDto,
  ConversationPreview,
  ConversationState,
  MessageDirection,
  MessageDto,
  MessageOrigin,
  MessageRemoval,
  MessageSender,
  MessageStatus,
  StateChangeReason,
  AttachmentError,
  AttachmentKind,
  AttachmentStatus,
} from '@ottm/shared'
import { and, asc, count, desc, eq, inArray, lt, ne, or } from 'drizzle-orm'
import type { DbExecutor } from '../../platform/db/index.ts'
import { AppError } from '../../platform/errors/index.ts'
import { getPage } from '../pages/index.ts'
import { contactIdentities, contacts, conversations, messageAttachments, messages } from './schema.ts'

export interface PageQuery {
  cursor?: string | undefined
  limit: number
}

export interface Paged<T> {
  items: T[]
  nextCursor: string | null
}

// ---------------------------------------------------------------------------------------------------------
// Cursor `(thời điểm, id)` mờ — base64url của JSON `[iso, id]`.
// ---------------------------------------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function encodeCursor(at: Date, id: string): string {
  return Buffer.from(JSON.stringify([at.toISOString(), id]), 'utf8').toString('base64url')
}

export function decodeCursor(raw: string): { at: Date; id: string } {
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown
    if (Array.isArray(parsed) && parsed.length === 2 && typeof parsed[0] === 'string' && typeof parsed[1] === 'string') {
      const at = new Date(parsed[0])
      if (!Number.isNaN(at.getTime()) && UUID_RE.test(parsed[1])) return { at, id: parsed[1] }
    }
  } catch {
    // rơi xuống lỗi chung
  }
  throw new AppError('VALIDATION_FAILED', 400, { message: 'Cursor không hợp lệ' })
}

// ---------------------------------------------------------------------------------------------------------
// Hội thoại
// ---------------------------------------------------------------------------------------------------------

type ConversationRow = typeof conversations.$inferSelect & { contactId: string; contactName: string | null; contactStage: string }

const conversationColumns = {
  conv: conversations,
  contactId: contacts.id,
  contactName: contacts.name,
  contactStage: contacts.stage,
}

/** Danh sách hội thoại của các trang `pageIds` (đã giải phạm vi, chỉ trang chưa gỡ). */
export async function listConversations(db: DbExecutor, pageIds: readonly string[], query: PageQuery): Promise<Paged<ConversationDto>> {
  if (pageIds.length === 0) return { items: [], nextCursor: null }
  const cursor = query.cursor ? decodeCursor(query.cursor) : null
  const rows = await db
    .select(conversationColumns)
    .from(conversations)
    .innerJoin(contactIdentities, eq(contactIdentities.id, conversations.contactIdentityId))
    .innerJoin(contacts, eq(contacts.id, contactIdentities.contactId))
    .where(
      and(
        inArray(conversations.pageId, [...pageIds]),
        cursor
          ? or(
              lt(conversations.lastMessageAt, cursor.at),
              and(eq(conversations.lastMessageAt, cursor.at), lt(conversations.id, cursor.id)),
            )
          : undefined,
      ),
    )
    .orderBy(desc(conversations.lastMessageAt), desc(conversations.id))
    .limit(query.limit + 1)
  const page = rows.slice(0, query.limit)
  const items = await toConversationDtos(db, page.map((r) => ({ ...r.conv, contactId: r.contactId, contactName: r.contactName, contactStage: r.contactStage })))
  const last = page.at(-1)
  return { items, nextCursor: rows.length > query.limit && last ? encodeCursor(last.conv.lastMessageAt, last.conv.id) : null }
}

/** Một hội thoại; `null` khi không có hoặc trang của nó đã gỡ. */
export async function getConversation(db: DbExecutor, id: string): Promise<ConversationDto | null> {
  if (!UUID_RE.test(id)) return null
  const [row] = await db
    .select(conversationColumns)
    .from(conversations)
    .innerJoin(contactIdentities, eq(contactIdentities.id, conversations.contactIdentityId))
    .innerJoin(contacts, eq(contacts.id, contactIdentities.contactId))
    .where(eq(conversations.id, id))
  if (!row || !(await getPage(db, row.conv.pageId))) return null
  const [dto] = await toConversationDtos(db, [{ ...row.conv, contactId: row.contactId, contactName: row.contactName, contactStage: row.contactStage }])
  return dto ?? null
}

async function toConversationDtos(db: DbExecutor, rows: ConversationRow[]): Promise<ConversationDto[]> {
  if (rows.length === 0) return []
  const ids = rows.map((r) => r.id)
  // Tin mới nhất không phải `system` của từng hội thoại (DISTINCT ON theo index (conversation_id, ts, id)).
  const previews = await db
    .selectDistinctOn([messages.conversationId], {
      conversationId: messages.conversationId,
      id: messages.id,
      text: messages.text,
      origin: messages.origin,
      at: messages.platformTimestamp,
    })
    .from(messages)
    .where(and(inArray(messages.conversationId, ids), ne(messages.origin, 'system')))
    .orderBy(messages.conversationId, desc(messages.platformTimestamp), desc(messages.id))
  const previewIds = previews.map((p) => p.id)
  const attachmentCounts = previewIds.length
    ? await db
        .select({ messageId: messageAttachments.messageId, n: count() })
        .from(messageAttachments)
        .where(inArray(messageAttachments.messageId, previewIds))
        .groupBy(messageAttachments.messageId)
    : []
  const countOf = new Map(attachmentCounts.map((c) => [c.messageId, Number(c.n)]))
  const previewOf = new Map(previews.map((p) => [p.conversationId, p]))
  // Trang khách đã nhắn (dẫn xuất từ định danh — AD-11).
  const contactIds = [...new Set(rows.map((r) => r.contactId))]
  const identities = await db
    .select({ contactId: contactIdentities.contactId, pageId: contactIdentities.pageId })
    .from(contactIdentities)
    .where(inArray(contactIdentities.contactId, contactIds))
    .orderBy(asc(contactIdentities.createdAt))
  const pagesOf = new Map<string, string[]>()
  for (const i of identities) {
    const list = pagesOf.get(i.contactId) ?? []
    if (!list.includes(i.pageId)) list.push(i.pageId)
    pagesOf.set(i.contactId, list)
  }

  return rows.map((r) => {
    const p = previewOf.get(r.id)
    const preview: ConversationPreview | null = p
      ? { text: p.text, origin: p.origin as MessageOrigin, attachmentCount: countOf.get(p.id) ?? 0, at: p.at.toISOString() }
      : null
    const state = r.state as ConversationState
    return {
      id: r.id,
      pageId: r.pageId,
      channel: r.channel as ConversationChannel,
      state,
      aiEnabled: r.aiEnabled,
      stateReason: (r.stateReason as StateChangeReason | null) ?? null,
      waitingSince: r.waitingSince?.toISOString() ?? null,
      lastMessageAt: r.lastMessageAt.toISOString(),
      lastCustomerMessageAt: r.lastCustomerMessageAt?.toISOString() ?? null,
      needsAttention: needsAttention(state, preview?.origin ?? null),
      contact: { id: r.contactId, name: r.contactName, stage: r.contactStage as ContactStage, pageIds: pagesOf.get(r.contactId) ?? [] },
      preview,
      post: r.platformPostId ? { platformPostId: r.platformPostId, text: r.postTextSnapshot } : null,
    }
  })
}

/** Điều kiện tab "Cần xử lý" (AD-9): `handoff`, hoặc `human` mà tin không phải `system` mới nhất là của khách. */
export function needsAttention(state: ConversationState, lastOrigin: MessageOrigin | null): boolean {
  return state === 'handoff' || (state === 'human' && lastOrigin === 'customer')
}

// ---------------------------------------------------------------------------------------------------------
// Tin
// ---------------------------------------------------------------------------------------------------------

/** Trang tin mới nhất của hội thoại (đã kiểm tồn tại + trang chưa gỡ ở bên gọi qua `getConversation`). */
export async function listMessages(db: DbExecutor, conversationId: string, query: PageQuery): Promise<Paged<MessageDto>> {
  const cursor = query.cursor ? decodeCursor(query.cursor) : null
  const rows = await db
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, conversationId),
        cursor
          ? or(
              lt(messages.platformTimestamp, cursor.at),
              and(eq(messages.platformTimestamp, cursor.at), lt(messages.id, cursor.id)),
            )
          : undefined,
      ),
    )
    .orderBy(desc(messages.platformTimestamp), desc(messages.id))
    .limit(query.limit + 1)
  const page = rows.slice(0, query.limit)
  const oldest = page.at(-1)
  const ids = page.map((m) => m.id)
  const attachments = ids.length
    ? await db
        .select()
        .from(messageAttachments)
        .where(inArray(messageAttachments.messageId, ids))
        .orderBy(asc(messageAttachments.messageId), asc(messageAttachments.position))
    : []
  const attachmentsOf = new Map<string, AttachmentDto[]>()
  for (const a of attachments) {
    const list = attachmentsOf.get(a.messageId) ?? []
    list.push({
      id: a.id,
      kind: a.kind as AttachmentKind,
      status: a.status as AttachmentStatus,
      mime: a.status === 'stored' ? a.mime : null,
      bytes: a.status === 'stored' ? (a.bytes ?? null) : null,
      errorCode: (a.errorCode as AttachmentError | null) ?? null,
    })
    attachmentsOf.set(a.messageId, list)
  }
  // Khách viết tin inbound: định danh của tin; tin trước Story 4.4 chưa có → định danh của hội thoại.
  const [conv] = await db
    .select({ identityId: conversations.contactIdentityId })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
  const senderIdOf = (m: (typeof page)[number]) => (m.direction === 'inbound' ? (m.senderIdentityId ?? conv?.identityId ?? null) : null)
  const identityIds = [...new Set(page.map(senderIdOf).filter((id): id is string => id !== null))]
  const senders = identityIds.length
    ? await db
        .select({ identityId: contactIdentities.id, contactId: contacts.id, name: contacts.name })
        .from(contactIdentities)
        .innerJoin(contacts, eq(contacts.id, contactIdentities.contactId))
        .where(inArray(contactIdentities.id, identityIds))
    : []
  const senderOf = new Map<string, MessageSender>(senders.map((x) => [x.identityId, { contactId: x.contactId, name: x.name }]))

  const items: MessageDto[] = page.reverse().map((m) => ({
    id: m.id,
    conversationId: m.conversationId,
    direction: (m.direction as MessageDirection | null) ?? null,
    origin: m.origin as MessageOrigin,
    text: m.text,
    reasonCode: (m.reasonCode as StateChangeReason | null) ?? null,
    status: (m.status as MessageStatus | null) ?? null,
    platformTimestamp: m.platformTimestamp.toISOString(),
    attachments: attachmentsOf.get(m.id) ?? [],
    editedAt: m.editedAt?.toISOString() ?? null,
    removal: (m.removal as MessageRemoval | null) ?? null,
    sender: senderOf.get(senderIdOf(m) ?? '') ?? null,
  }))
  return { items, nextCursor: rows.length > query.limit && oldest ? encodeCursor(oldest.platformTimestamp, oldest.id) : null }
}
