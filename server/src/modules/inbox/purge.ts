// Phía `inbox` của luồng xoá dữ liệu (Story 9.2, AD-22, AD-1). `inbox` là phần CUỐI: module khác (vd `webhooks`) cần dữ
// liệu của nó để tìm phần liên quan, nên chỉ chạy khi `privacy` phát `privacy.purge_final_requested`.
// - `markContactForDeletion` (entrypoint, cùng transaction với yêu cầu của `privacy`): khoá dòng khách, đặt
//   `deletion_requested_at` (ẩn khỏi danh sách / chi tiết / ⌘K / gộp), trả hội thoại hiện có để `privacy` chụp lại.
// - `purgeMatchKeys`: id nền tảng của khách (id người dùng các định danh, `thread_key`, id tin) cho `webhooks` tìm payload
//   thô — chỉ trả trong bộ nhớ, không log, không vào payload job.
// - `isSenderPendingDeletion` (Story 9.3): tin vừa ingest thuộc khách đang chờ xoá → `webhooks` bỏ payload thô của mục đó
//   ngay (mục tới sau khi phần `webhooks` của giai đoạn 1 đã chạy thì không còn ai xoá nó).
// - `handleInboxPurge` (queue `inbox.purge`): xoá theo lô — tin (+ `message_attachments`) → hội thoại → định danh → khách.
//   `contact`: tin trong hội thoại của khách (ảnh chụp + hội thoại hiện có của các định danh) và tin khách viết ở luồng bình
//   luận của người khác. `page|all`: mọi tin / hội thoại / định danh của `pageIds`; khách chỉ bị xoá khi không còn định
//   danh nào (khách còn nhắn ở trang khác giữ hồ sơ).
//   File đính kèm riêng tư xoá TRƯỚC khi xoá dòng, trong cùng transaction với dòng đính kèm khoá `FOR UPDATE` (job tải
//   đính kèm đang chạy phải chờ, rồi thấy dòng mất → tự bỏ file vừa tải): lỗi kho tạm thời → ném để retry, lô rollback, dòng
//   còn nguyên → không có file mồ côi lẫn dòng trỏ tới file đã xoá. Kho chưa cấu hình / ref hỏng → vẫn xoá dòng, cảnh báo.
//   Mỗi lô một transaction → worker chết giữa chừng thì lần chạy lại xoá tiếp. Cuối cùng phát `contact.deleted` (scope
//   `contact`) + `privacy.purge_part_completed{module:'inbox'}`.
import { type DeletionScope } from '@ottm/shared'
import { and, eq, inArray, notExists, or, sql, type SQL } from 'drizzle-orm'
import type { MediaStores, PrivateFileRef } from '../../adapters/media/index.ts'
import type { Db, DbExecutor } from '../../platform/db/index.ts'
import { envelopePayload, type EventPublisher } from '../../platform/events/index.ts'
import type { Logger } from '../../platform/log/index.ts'
import { contactIdentities, contacts, conversations, messageAttachments, messages } from './schema.ts'

/** Tin mỗi lô — nhỏ vì lô giữ transaction trong lúc gọi kho xoá file. */
export const PURGE_MESSAGE_BATCH = 50
export const PURGE_ROW_BATCH = 500

export class InboxPurgeRetryableError extends Error {
  override name = 'InboxPurgeRetryableError'
}

export interface InboxPurgeDeps {
  db: Db
  events: EventPublisher
  media: Pick<MediaStores, 'privateStore'>
  log?: Logger | undefined
  batchSize?: { messages?: number; rows?: number }
}

export interface InboxPurgeResult {
  requestId: string
  messages: number
  files: number
  /** File không xoá được mà vẫn xoá dòng (kho chưa cấu hình / ref hỏng) — mồ côi trên kho. */
  fileWarnings: number
  conversations: number
  identities: number
  contacts: number
}

// ---------------------------------------------------------------------------------------------------------
// Entrypoint: đánh dấu khách + khoá tra cứu cho `webhooks`
// ---------------------------------------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const identitiesOf = (db: DbExecutor, contactId: string) =>
  db.select({ id: contactIdentities.id }).from(contactIdentities).where(eq(contactIdentities.contactId, contactId))

const conversationsOfContact = (db: DbExecutor, contactId: string) =>
  db.select({ id: conversations.id }).from(conversations).where(inArray(conversations.contactIdentityId, identitiesOf(db, contactId)))

/**
 * Đánh dấu khách chờ xoá (idempotent) trong transaction của bên gọi; `null` khi khách không có. Trả hội thoại hiện có
 * của các định danh (ảnh chụp cho yêu cầu).
 */
export async function markContactForDeletion(tx: DbExecutor, contactId: string): Promise<{ conversationIds: string[] } | null> {
  if (!UUID_RE.test(contactId)) return null
  const [row] = await tx.select({ id: contacts.id, at: contacts.deletionRequestedAt }).from(contacts).where(eq(contacts.id, contactId)).for('update')
  if (!row) return null
  if (!row.at) await tx.update(contacts).set({ deletionRequestedAt: sql`now()` }).where(eq(contacts.id, contactId))
  const convs = await conversationsOfContact(tx, contactId).orderBy(conversations.id)
  return { conversationIds: convs.map((c) => c.id) }
}

/** Id nền tảng của khách để `webhooks` tìm payload thô liên quan (bỏ trùng). Không log. */
export async function purgeMatchKeys(db: DbExecutor, contactId: string, conversationIds: readonly string[]): Promise<string[]> {
  if (!UUID_RE.test(contactId)) return []
  const ids = await db.select({ key: contactIdentities.platformUserId }).from(contactIdentities).where(eq(contactIdentities.contactId, contactId))
  const convWhere = or(inArray(conversations.id, conversationsOfContact(db, contactId)), conversationIds.length > 0 ? inArray(conversations.id, [...conversationIds]) : undefined)!
  const threads = await db.select({ key: conversations.threadKey }).from(conversations).where(convWhere)
  const msgs = await db
    .select({ key: messages.platformMessageId })
    .from(messages)
    .where(and(sql`${messages.platformMessageId} is not null`, or(inArray(messages.conversationId, db.select({ id: conversations.id }).from(conversations).where(convWhere)), inArray(messages.senderIdentityId, identitiesOf(db, contactId)))))
  const keys = new Set<string>()
  for (const r of [...ids, ...threads, ...msgs]) if (r.key) keys.add(r.key)
  return [...keys]
}

// ---------------------------------------------------------------------------------------------------------
// Consumer `inbox.purge`
// ---------------------------------------------------------------------------------------------------------

/** Xoá file của các đính kèm đã lưu; lỗi tạm → ném (lô rollback). Trả số file đã xoá + cảnh báo. */
async function deleteFiles(
  deps: InboxPurgeDeps,
  requestId: string,
  rows: { filePublicId: string | null; fileResourceType: string | null; fileFormat: string | null }[],
): Promise<{ files: number; warnings: number }> {
  let files = 0
  let warnings = 0
  for (const r of rows) {
    if (!r.filePublicId) continue
    const ref: PrivateFileRef = { publicId: r.filePublicId, resourceType: r.fileResourceType === 'raw' ? 'raw' : 'image', format: r.fileFormat }
    const res = await deps.media.privateStore.delete(ref)
    if (res.ok) {
      files++
      continue
    }
    if (res.kind === 'TRANSIENT' || res.kind === 'RATE_LIMITED' || res.kind === 'AUTH_FAILED') {
      throw new InboxPurgeRetryableError(`kho file lỗi ${res.kind} khi xoá đính kèm`)
    }
    warnings++
    deps.log?.warn({ requestId, kind: res.kind }, 'inbox: không xoá được file đính kèm trên kho — vẫn xoá dòng')
  }
  return { files, warnings }
}

/** Xoá tin khớp `where` theo lô (kèm file đính kèm). */
async function purgeMessages(deps: InboxPurgeDeps, requestId: string, where: SQL, out: InboxPurgeResult): Promise<void> {
  const batch = deps.batchSize?.messages ?? PURGE_MESSAGE_BATCH
  for (;;) {
    const n = await deps.db.transaction(async (tx) => {
      const ids = (await tx.select({ id: messages.id }).from(messages).where(where).limit(batch).for('update')).map((r) => r.id)
      if (ids.length === 0) return 0
      const atts = await tx
        .select({ filePublicId: messageAttachments.filePublicId, fileResourceType: messageAttachments.fileResourceType, fileFormat: messageAttachments.fileFormat })
        .from(messageAttachments)
        .where(inArray(messageAttachments.messageId, ids))
        .for('update')
      const { files, warnings } = await deleteFiles(deps, requestId, atts)
      await tx.delete(messages).where(inArray(messages.id, ids))
      out.messages += ids.length
      out.files += files
      out.fileWarnings += warnings
      return ids.length
    })
    if (n < batch) return
  }
}

async function deleteInBatches(db: Db, table: typeof conversations | typeof contactIdentities, where: SQL, batch: number): Promise<number> {
  let deleted = 0
  for (;;) {
    const rows = await db
      .delete(table)
      .where(inArray(table.id, db.select({ id: table.id }).from(table).where(where).limit(batch)))
      .returning({ id: table.id })
    deleted += rows.length
    if (rows.length < batch) return deleted
  }
}

async function purgeContact(deps: InboxPurgeDeps, requestId: string, contactId: string, snapshot: readonly string[], out: InboxPurgeResult): Promise<void> {
  const db = deps.db
  const convWhere = or(inArray(conversations.id, conversationsOfContact(db, contactId)), snapshot.length > 0 ? inArray(conversations.id, [...snapshot]) : undefined)!
  await purgeMessages(
    deps,
    requestId,
    or(inArray(messages.conversationId, db.select({ id: conversations.id }).from(conversations).where(convWhere)), inArray(messages.senderIdentityId, identitiesOf(db, contactId)))!,
    out,
  )
  await db.transaction(async (tx) => {
    // Tin tới giữa chừng (sau vòng lô): xoá nốt trong transaction cuối — `sender_identity_id` là `set null`, không để tin
    // của khách còn lại vô danh ở luồng bình luận của người khác.
    await tx.delete(messages).where(inArray(messages.senderIdentityId, identitiesOf(tx, contactId)))
    const convs = await tx.delete(conversations).where(convWhere).returning({ id: conversations.id })
    const ids = await tx.delete(contactIdentities).where(eq(contactIdentities.contactId, contactId)).returning({ id: contactIdentities.id })
    const gone = await tx.delete(contacts).where(eq(contacts.id, contactId)).returning({ id: contacts.id })
    out.conversations += convs.length
    out.identities += ids.length
    out.contacts += gone.length
    if (gone.length > 0) await deps.events.publishEvent(tx, 'contact.deleted', { id: contactId })
    await deps.events.publishEvent(tx, 'privacy.purge_part_completed', { id: requestId, module: 'inbox' })
  })
}

async function purgePages(deps: InboxPurgeDeps, requestId: string, pageIds: readonly string[], out: InboxPurgeResult): Promise<void> {
  const db = deps.db
  const rowBatch = deps.batchSize?.rows ?? PURGE_ROW_BATCH
  if (pageIds.length > 0) {
    await purgeMessages(deps, requestId, inArray(messages.pageId, [...pageIds]), out)
    out.conversations += await deleteInBatches(db, conversations, inArray(conversations.pageId, [...pageIds]), rowBatch)
    // Định danh + khách rỗng cùng một transaction mỗi lô → chạy lại không để khách không còn định danh nào.
    for (;;) {
      const n = await db.transaction(async (tx) => {
        const removed = await tx
          .delete(contactIdentities)
          .where(inArray(contactIdentities.id, tx.select({ id: contactIdentities.id }).from(contactIdentities).where(inArray(contactIdentities.pageId, [...pageIds])).limit(rowBatch)))
          .returning({ contactId: contactIdentities.contactId })
        if (removed.length === 0) return 0
        const gone = await tx
          .delete(contacts)
          .where(
            and(
              inArray(contacts.id, [...new Set(removed.map((r) => r.contactId))]),
              notExists(sql`(select 1 from ${contactIdentities} where ${contactIdentities.contactId} = ${contacts.id})`),
            ),
          )
          .returning({ id: contacts.id })
        out.identities += removed.length
        out.contacts += gone.length
        return removed.length
      })
      if (n < rowBatch) break
    }
  }
  await db.transaction((tx) => deps.events.publishEvent(tx, 'privacy.purge_part_completed', { id: requestId, module: 'inbox' }))
}

export async function handleInboxPurge(deps: InboxPurgeDeps, data: unknown): Promise<InboxPurgeResult | 'ignored'> {
  const p = envelopePayload(data, 'privacy.purge_final_requested')
  if (!p) return 'ignored'
  const out: InboxPurgeResult = { requestId: p.id, messages: 0, files: 0, fileWarnings: 0, conversations: 0, identities: 0, contacts: 0 }
  const scope: DeletionScope = p.scope
  if (scope === 'contact') {
    if (!p.targetId || !UUID_RE.test(p.targetId)) return 'ignored'
    await purgeContact(deps, p.id, p.targetId, p.conversationIds ?? [], out)
  } else {
    await purgePages(deps, p.id, p.pageIds ?? [], out)
  }
  return out
}

/** Story 9.3: người gửi tin `messageId` là khách đang chờ xoá (`deletion_requested_at` đã đặt). Không có tin → false. */
export async function isSenderPendingDeletion(db: DbExecutor, messageId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: contacts.id })
    .from(messages)
    .innerJoin(contactIdentities, eq(contactIdentities.id, messages.senderIdentityId))
    .innerJoin(contacts, eq(contacts.id, contactIdentities.contactId))
    .where(and(eq(messages.id, messageId), sql`${contacts.deletionRequestedAt} is not null`))
  return row !== undefined
}
