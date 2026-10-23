// Đọc Hộp thư cho REST (Story 4.3, AD-18): danh sách hội thoại theo tập trang đã giải phạm vi (bên gọi dùng
// `pages.resolveScope`), một hội thoại, trang tin của hội thoại. Cursor mờ `{items, nextCursor}`, mặc định 50.
// - Danh sách: mới nhất trước theo `(last_message_at, id)`; xem trước = tin mới nhất không phải `system`.
// - Tin: trang MỚI NHẤT theo `(platform_timestamp, id)`, trả theo thứ tự hiển thị (cũ → mới); cursor lùi về tin cũ.
// - Story 4.4: hội thoại `comment` kèm bài được bình luận; tin kèm sửa/xoá/ẩn và khách viết tin (luồng bình luận có
//   thể có nhiều người).
// - Story 4.6: lọc + đếm theo tab ở server (AD-9) bằng MỘT điều kiện `tabCondition` dùng chung cho danh sách, số đếm
//   và badge. "Cần xử lý" sắp chờ lâu nhất trước theo `coalesce(waiting_since, last_customer_message_at,
//   last_message_at)` — phòng hờ hội thoại `human` chưa có mốc chờ (dữ liệu trước 4.6) vẫn có chỗ đứng.
// - Story 4.7: tin outbound `failed` không tính là "đã trả lời" — điều kiện "Cần xử lý" và xem trước bỏ qua nó; tin kèm
//   `delivery`, `errorCode`; `getMessage` cho route gửi.
// - Story 5.4: `aiTyping` (chấm "đang gõ") từ `ai_typing_at` còn hạn, chỉ khi `ai`.
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
  MessageDelivery,
  SendErrorCode,
  StateChangeReason,
  AttachmentError,
  AttachmentKind,
  AttachmentStatus,
  InboxTab,
} from '@ottm/shared'
import { and, asc, count, desc, eq, inArray, lt, or, sql, type SQL } from 'drizzle-orm'
import type { DbExecutor } from '../../platform/db/index.ts'
import { AppError } from '../../platform/errors/index.ts'
import { getPage } from '../pages/index.ts'
import { contactIdentities, contacts, conversations, messageAttachments, messages } from './schema.ts'
import { AI_TYPING_TTL_MS, effectiveMessage } from './state.ts'

export interface PageQuery {
  cursor?: string | undefined
  limit: number
}

export interface ConversationPageQuery extends PageQuery {
  /** Mặc định `all`. */
  tab?: InboxTab | undefined
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

/**
 * Gốc của tin hiệu lực mới nhất trong hội thoại (không phải `system`, không phải tin outbound `failed` — Story 4.7;
 * subquery tương quan, chạy trên index `(conversation_id, platform_timestamp, id)`) — cùng định nghĩa với `preview`
 * của DTO (`effectiveMessage`).
 */
const lastNonSystemOrigin = sql`(
  select m.origin from ${messages} m
  where m.conversation_id = ${conversations.id} and m.origin <> 'system' and m.status is distinct from 'failed'
  order by m.platform_timestamp desc, m.id desc
  limit 1
)`

/** Điều kiện của tab (AD-9); `undefined` = không lọc (`all`, gồm cả `triage`). */
export function tabCondition(tab: InboxTab): SQL | undefined {
  switch (tab) {
    case 'all':
      return undefined
    case 'ai':
      return eq(conversations.state, 'ai')
    case 'done':
      return eq(conversations.state, 'done')
    case 'needs_human':
      return sql`(${conversations.state} = 'handoff' or (${conversations.state} = 'human' and ${lastNonSystemOrigin} = 'customer'))`
  }
}

/** Khoá sắp tab "Cần xử lý": mốc khách bắt đầu chờ. Giữ khớp với `waitKeyOf`. */
const waitKey = sql`coalesce(${conversations.waitingSince}, ${conversations.lastCustomerMessageAt}, ${conversations.lastMessageAt})`
const waitKeyOf = (c: typeof conversations.$inferSelect): Date => c.waitingSince ?? c.lastCustomerMessageAt ?? c.lastMessageAt

/**
 * Danh sách hội thoại của các trang `pageIds` (đã giải phạm vi, chỉ trang chưa gỡ) theo tab. `needs_human`: chờ lâu
 * nhất trước `(waitKey, id)` tăng dần; tab khác: mới nhất trước `(last_message_at, id)` giảm dần.
 */
export async function listConversations(db: DbExecutor, pageIds: readonly string[], query: ConversationPageQuery): Promise<Paged<ConversationDto>> {
  if (pageIds.length === 0) return { items: [], nextCursor: null }
  const tab = query.tab ?? 'all'
  const cursor = query.cursor ? decodeCursor(query.cursor) : null
  const byWait = tab === 'needs_human'
  const after = !cursor
    ? undefined
    : byWait
      ? sql`(${waitKey} > ${cursor.at.toISOString()}::timestamptz or (${waitKey} = ${cursor.at.toISOString()}::timestamptz and ${conversations.id} > ${cursor.id}))`
      : or(lt(conversations.lastMessageAt, cursor.at), and(eq(conversations.lastMessageAt, cursor.at), lt(conversations.id, cursor.id)))
  const rows = await db
    .select(conversationColumns)
    .from(conversations)
    .innerJoin(contactIdentities, eq(contactIdentities.id, conversations.contactIdentityId))
    .innerJoin(contacts, eq(contacts.id, contactIdentities.contactId))
    .where(and(inArray(conversations.pageId, [...pageIds]), tabCondition(tab), after))
    .orderBy(...(byWait ? [asc(waitKey), asc(conversations.id)] : [desc(conversations.lastMessageAt), desc(conversations.id)]))
    .limit(query.limit + 1)
  const page = rows.slice(0, query.limit)
  const items = await toConversationDtos(db, page.map((r) => ({ ...r.conv, contactId: r.contactId, contactName: r.contactName, contactStage: r.contactStage })))
  const last = page.at(-1)
  const nextCursor =
    rows.length > query.limit && last ? encodeCursor(byWait ? waitKeyOf(last.conv) : last.conv.lastMessageAt, last.conv.id) : null
  return { items, nextCursor }
}

/** Số hội thoại của tab trong các trang `pageIds` (badge "Cần xử lý" = `needs_human`). */
export async function countConversations(db: DbExecutor, pageIds: readonly string[], tab: InboxTab): Promise<number> {
  if (pageIds.length === 0) return 0
  const [row] = await db
    .select({ n: count() })
    .from(conversations)
    .where(and(inArray(conversations.pageId, [...pageIds]), tabCondition(tab)))
  return Number(row?.n ?? 0)
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
  const previewOf = await previewsOf(db, rows.map((r) => r.id))
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

  const now = Date.now()
  return rows.map((r) => {
    const preview = previewOf.get(r.id) ?? null
    const state = r.state as ConversationState
    return {
      id: r.id,
      pageId: r.pageId,
      channel: r.channel as ConversationChannel,
      state,
      aiEnabled: r.aiEnabled,
      aiTyping: state === 'ai' && r.aiTypingAt !== null && now - r.aiTypingAt.getTime() < AI_TYPING_TTL_MS,
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

/**
 * Xem trước của từng hội thoại: tin hiệu lực mới nhất (DISTINCT ON theo index (conversation_id, ts, id)) kèm số đính
 * kèm. Dùng chung cho danh sách Hộp thư và hội thoại của khách (Story 4.9).
 */
export async function previewsOf(db: DbExecutor, conversationIds: readonly string[]): Promise<Map<string, ConversationPreview>> {
  if (conversationIds.length === 0) return new Map()
  const previews = await db
    .selectDistinctOn([messages.conversationId], {
      conversationId: messages.conversationId,
      id: messages.id,
      text: messages.text,
      origin: messages.origin,
      at: messages.platformTimestamp,
    })
    .from(messages)
    .where(and(inArray(messages.conversationId, [...conversationIds]), effectiveMessage))
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
  return new Map(
    previews.map((p) => [
      p.conversationId,
      { text: p.text, origin: p.origin as MessageOrigin, attachmentCount: countOf.get(p.id) ?? 0, at: p.at.toISOString() },
    ]),
  )
}

/**
 * Điều kiện tab "Cần xử lý" (AD-9): `handoff`, hoặc `human` mà tin không phải `system` mới nhất là của khách. Bản
 * TypeScript của `tabCondition('needs_human')` cho DTO — đổi một bên thì đổi cả bên kia.
 */
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
  const items = await toMessageDtos(db, page.reverse())
  return { items, nextCursor: rows.length > query.limit && oldest ? encodeCursor(oldest.platformTimestamp, oldest.id) : null }
}

export type MessageRow = typeof messages.$inferSelect

/**
 * Dòng tin (đúng thứ tự hiển thị) → DTO kèm đính kèm và người viết. Story 4.9: dòng có thể thuộc nhiều hội thoại (lịch
 * sử khách).
 */
export async function toMessageDtos(db: DbExecutor, rows: MessageRow[]): Promise<MessageDto[]> {
  const ids = rows.map((m) => m.id)
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
  const convIds = [...new Set(rows.map((m) => m.conversationId))]
  const convs = convIds.length
    ? await db
        .select({ id: conversations.id, identityId: conversations.contactIdentityId })
        .from(conversations)
        .where(inArray(conversations.id, convIds))
    : []
  const identityOfConv = new Map(convs.map((c) => [c.id, c.identityId]))
  const senderIdOf = (m: MessageRow) => (m.direction === 'inbound' ? (m.senderIdentityId ?? identityOfConv.get(m.conversationId) ?? null) : null)
  const identityIds = [...new Set(rows.map(senderIdOf).filter((id): id is string => id !== null))]
  const senders = identityIds.length
    ? await db
        .select({ identityId: contactIdentities.id, contactId: contacts.id, name: contacts.name })
        .from(contactIdentities)
        .innerJoin(contacts, eq(contacts.id, contactIdentities.contactId))
        .where(inArray(contactIdentities.id, identityIds))
    : []
  const senderOf = new Map<string, MessageSender>(senders.map((x) => [x.identityId, { contactId: x.contactId, name: x.name }]))

  const items: MessageDto[] = rows.map((m) => ({
    id: m.id,
    conversationId: m.conversationId,
    direction: (m.direction as MessageDirection | null) ?? null,
    origin: m.origin as MessageOrigin,
    text: m.text,
    reasonCode: (m.reasonCode as StateChangeReason | null) ?? null,
    status: (m.status as MessageStatus | null) ?? null,
    delivery: (m.delivery as MessageDelivery | null) ?? null,
    errorCode: (m.errorCode as SendErrorCode | null) ?? null,
    platformTimestamp: m.platformTimestamp.toISOString(),
    attachments: attachmentsOf.get(m.id) ?? [],
    editedAt: m.editedAt?.toISOString() ?? null,
    removal: (m.removal as MessageRemoval | null) ?? null,
    sender: senderOf.get(senderIdOf(m) ?? '') ?? null,
  }))
  return items
}

/** Một tin theo id (route gửi / gửi lại); `null` khi không có. Bên gọi đã kiểm hội thoại + trang. */
export async function getMessage(db: DbExecutor, id: string): Promise<MessageDto | null> {
  if (!UUID_RE.test(id)) return null
  const [row] = await db.select().from(messages).where(eq(messages.id, id))
  if (!row) return null
  const [dto] = await toMessageDtos(db, [row])
  return dto ?? null
}
