// Khách hàng (Story 4.9, AD-11, AD-18): đọc / sửa hồ sơ khách, lịch sử nhiều trang, gộp khách bằng tay, gợi ý gộp.
// - Danh sách theo tập trang đã giải phạm vi (bên gọi dùng `pages.resolveScope`): khách thuộc phạm vi khi có định danh
//   trên một trang của tập. Mới hoạt động nhất trước theo `(tin mới nhất trong tập, id)` — khách chưa có hội thoại lấy
//   `created_at`. Cursor mờ `{items, nextCursor}` như Hộp thư.
// - Trường dẫn xuất (`pageIds` chỉ trang chưa gỡ, `handledBy`) KHÔNG tính ở đây: `contactActivity` trả nguyên liệu,
//   read-model `app/read-models/contacts.ts` ghép (AD-1). `inbox` không đọc bảng `pages`.
// - Gộp khách chỉ bằng tay (`mergeContacts`): chuyển định danh (hội thoại đi theo định danh), hợp thẻ, xoá khách nguồn.
//   Nhắn riêng trả `recipient_id` đã thuộc khách khác → chỉ ghi gợi ý gộp (`suggestMerge`).
// - Tìm không dấu (Story 4.10): `q` của danh sách và `searchContacts` (⌘K) dùng helper `platform/db/search.ts` — mỗi từ
//   là chuỗi con của `search_norm(tên)` (danh sách: hoặc của một thẻ), hoặc SĐT chứa chữ số của truy vấn (`search_phone`).
//   Chỉ ⌘K có khớp gần đúng (chịu lỗi gõ) — lọc danh sách giữ đúng chữ.
// Không log SĐT, ghi chú, thẻ hay nội dung tin.
import {
  dedupeTags,
  type ContactConversation,
  type ContactHistoryItem,
  type ContactMergeSuggestion,
  type ContactStage,
  type ConversationChannel,
  type ConversationState,
  type MergeSuggestionReason,
} from '@ottm/shared'
import { and, desc, eq, inArray, isNull, lt, ne, or, sql, type SQL } from 'drizzle-orm'
import type { Db, DbExecutor } from '../../platform/db/index.ts'
import { phoneMatch, searchTerms, textMatch, textRank } from '../../platform/db/search.ts'
import { AppError } from '../../platform/errors/index.ts'
import type { EventPublisher } from '../../platform/events/index.ts'
import { decodeCursor, encodeCursor, previewsOf, toMessageDtos, type PageQuery, type Paged } from './queries.ts'
import { contactIdentities, contactMergeSuggestions, contacts, conversations, messages } from './schema.ts'

/** Dòng khách (cột của `contacts`) — DTO đầy đủ do read-model ghép. */
export type ContactRecord = Omit<typeof contacts.$inferSelect, 'stage'> & { stage: ContactStage }

export interface ContactListQuery extends PageQuery {
  stage?: ContactStage | undefined
  tag?: string | undefined
  q?: string | undefined
}

export interface ContactsDeps {
  db: Db
  events: EventPublisher
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const toRecord = (row: typeof contacts.$inferSelect): ContactRecord => ({ ...row, stage: row.stage as ContactStage })

const inList = (ids: readonly string[]) => sql.join(ids.map((id) => sql`${id}`), sql`, `)

/** Khách có định danh trên một trang của tập (tập khác rỗng). */
/** Khách có định danh trên tập trang và KHÔNG đang chờ xoá (Story 9.2: ẩn ngay khi chủ shop yêu cầu xoá). */
const hasIdentityIn = (pageIds: readonly string[]) =>
  sql`(${contacts.deletionRequestedAt} is null and exists (select 1 from ${contactIdentities} ci where ci.contact_id = ${contacts.id} and ci.page_id in (${inList(pageIds)})))`

/** Mốc hoạt động: tin mới nhất (không tính `system`) của hội thoại trên các trang của tập; chưa có → lúc tạo khách. */
const activityIn = (pageIds: readonly string[]) => sql<Date>`coalesce((
  select max(cv.last_message_at) from ${conversations} cv
  join ${contactIdentities} ci on ci.id = cv.contact_identity_id
  where ci.contact_id = ${contacts.id} and cv.page_id in (${inList(pageIds)})
), ${contacts.createdAt})`

/**
 * So khớp không phân biệt hoa thường cho chữ tiếng Việt: collation `pg_c_utf8` (builtin, Postgres ≥17) — DB khởi tạo
 * `--locale=C` thì `lower('Đ')` mặc định không đổi chữ ngoài ASCII.
 */
const lowerVi = (x: SQL | string) => sql`lower(${x} collate pg_c_utf8)`
const tagIn = (tag: string) => sql`exists (select 1 from unnest(${contacts.tags}) as t(v) where ${lowerVi(sql`t.v`)} = ${lowerVi(tag)})`

/** Điều kiện lọc giai đoạn / thẻ (không phân biệt hoa thường) / chữ (không dấu: tên, thẻ; SĐT theo chữ số). */
function filterCondition(query: Pick<ContactListQuery, 'stage' | 'tag' | 'q'>): SQL | undefined {
  const parts: SQL[] = []
  if (query.stage) parts.push(eq(contacts.stage, query.stage))
  if (query.tag) parts.push(tagIn(query.tag))
  const terms = query.q ? searchTerms(query.q) : null
  if (terms) {
    const any = [
      textMatch(contacts.name, terms),
      sql`exists (select 1 from unnest(${contacts.tags}) as t(v) where ${textMatch(sql`t.v`, terms)})`,
      phoneMatch(contacts.phone, terms),
    ].filter((c): c is SQL => c !== undefined)
    parts.push(sql`(${sql.join(any, sql` or `)})`)
  }
  return parts.length ? and(...parts) : undefined
}

/** Danh sách khách thuộc tập trang `pageIds` (đã giải phạm vi, chỉ trang chưa gỡ), mới hoạt động nhất trước. */
export async function listContacts(db: DbExecutor, pageIds: readonly string[], query: ContactListQuery): Promise<Paged<ContactRecord>> {
  if (pageIds.length === 0) return { items: [], nextCursor: null }
  const cursor = query.cursor ? decodeCursor(query.cursor) : null
  const activity = activityIn(pageIds)
  const at = cursor?.at.toISOString()
  const rows = await db
    .select({ contact: contacts, activity: sql<Date>`${activity}`.mapWith(contacts.createdAt) })
    .from(contacts)
    .where(
      and(
        hasIdentityIn(pageIds),
        filterCondition(query),
        cursor ? sql`(${activity} < ${at}::timestamptz or (${activity} = ${at}::timestamptz and ${contacts.id} < ${cursor.id}))` : undefined,
      ),
    )
    .orderBy(desc(activity), desc(contacts.id))
    .limit(query.limit + 1)
  const page = rows.slice(0, query.limit)
  const last = page.at(-1)
  return {
    items: page.map((r) => toRecord(r.contact)),
    nextCursor: rows.length > query.limit && last ? encodeCursor(last.activity, last.contact.id) : null,
  }
}

/** Khách khớp tìm nhanh: `pageIds` = trang có định danh của khách, trong tập trang bên gọi truyền (thứ tự định danh). */
export interface ContactSearchHit {
  id: string
  name: string | null
  phone: string | null
  stage: ContactStage
  pageIds: string[]
}

/**
 * Tìm khách cho ⌘K (AD-18): khách có định danh trên một trang của `pageIds` (bên gọi truyền trang chưa gỡ) mà tên khớp
 * không dấu (kể cả gần đúng) hoặc SĐT chứa chữ số của truy vấn. Xếp khớp tên tốt nhất trước (khớp chỉ theo SĐT xếp
 * sau), rồi mới hoạt động nhất; tối đa `limit`.
 */
export async function searchContacts(db: DbExecutor, q: string, pageIds: readonly string[], limit: number): Promise<ContactSearchHit[]> {
  const terms = searchTerms(q)
  if (!terms || pageIds.length === 0) return []
  const match = [textMatch(contacts.name, terms, { fuzzy: true }), phoneMatch(contacts.phone, terms)].filter((c): c is SQL => c !== undefined)
  const rows = await db
    .select({ id: contacts.id, name: contacts.name, phone: contacts.phone, stage: contacts.stage })
    .from(contacts)
    .where(and(hasIdentityIn(pageIds), sql`(${sql.join(match, sql` or `)})`))
    .orderBy(
      sql`case when ${contacts.name} is null or not ${textMatch(contacts.name, terms, { fuzzy: true })} then 1 else 0 end`,
      ...textRank(contacts.name, terms),
      desc(activityIn(pageIds)),
      desc(contacts.id),
    )
    .limit(limit)
  if (rows.length === 0) return []
  const identities = await db
    .select({ contactId: contactIdentities.contactId, pageId: contactIdentities.pageId })
    .from(contactIdentities)
    .where(and(inArray(contactIdentities.contactId, rows.map((r) => r.id)), inArray(contactIdentities.pageId, [...pageIds])))
    .orderBy(contactIdentities.createdAt, contactIdentities.id)
  const pagesOf = new Map<string, string[]>(rows.map((r) => [r.id, []]))
  for (const i of identities) {
    const list = pagesOf.get(i.contactId)!
    if (!list.includes(i.pageId)) list.push(i.pageId)
  }
  return rows.map((r) => ({ ...r, stage: r.stage as ContactStage, pageIds: pagesOf.get(r.id)! }))
}

export interface ContactFacets {
  total: number
  stages: Record<ContactStage, number>
  tags: string[]
}

/** Số khách theo giai đoạn + thẻ đang dùng (bỏ trùng không phân biệt hoa thường, sắp theo tiếng Việt) trong tập trang. */
export async function contactFacets(db: DbExecutor, pageIds: readonly string[]): Promise<ContactFacets> {
  const stages: Record<ContactStage, number> = { new: 0, consulting: 0, ordered: 0, loyal: 0, complaint: 0 }
  if (pageIds.length === 0) return { total: 0, stages, tags: [] }
  const byStage = await db
    .select({ stage: contacts.stage, n: sql<number>`count(*)::int` })
    .from(contacts)
    .where(hasIdentityIn(pageIds))
    .groupBy(contacts.stage)
  let total = 0
  for (const r of byStage) {
    stages[r.stage as ContactStage] = r.n
    total += r.n
  }
  const tagRows = await db
    .selectDistinct({ tag: sql<string>`unnest(${contacts.tags})` })
    .from(contacts)
    .where(hasIdentityIn(pageIds))
  // Sắp không phân biệt hoa thường, cùng chữ thì bản viết hoa trước → bỏ trùng giữ bản đó (ổn định giữa các lần tải).
  const tags = dedupeTags(tagRows.map((r) => r.tag).sort((a, b) => a.localeCompare(b, 'vi', { sensitivity: 'base' }) || (a < b ? -1 : a > b ? 1 : 0)))
  return { total, stages, tags }
}

/**
 * Một khách theo id; `null` khi không có hoặc đang chờ xoá (Story 9.2). Bên gọi kiểm khách còn định danh trên trang chưa
 * gỡ (`contactActivity`).
 */
export async function getContact(db: DbExecutor, id: string): Promise<ContactRecord | null> {
  if (!UUID_RE.test(id)) return null
  const [row] = await db.select().from(contacts).where(and(eq(contacts.id, id), isNull(contacts.deletionRequestedAt)))
  return row ? toRecord(row) : null
}

export interface ContactActivity {
  /** Mọi trang có định danh của khách (kể cả trang đã gỡ — read-model lọc), theo thứ tự định danh tạo trước. */
  identityPageIds: string[]
  /** Hội thoại của khách trên các trang của tập, mới nhất trước. */
  conversations: ContactConversation[]
}

/** Nguyên liệu cho trường dẫn xuất của khách: trang theo định danh + hội thoại (kèm xem trước) trên tập trang `pageIds`. */
export async function contactActivity(db: DbExecutor, contactIds: readonly string[], pageIds: readonly string[]): Promise<Map<string, ContactActivity>> {
  const out = new Map<string, ContactActivity>(contactIds.map((id) => [id, { identityPageIds: [], conversations: [] }]))
  if (contactIds.length === 0) return out
  const identities = await db
    .select({ contactId: contactIdentities.contactId, pageId: contactIdentities.pageId })
    .from(contactIdentities)
    .where(inArray(contactIdentities.contactId, [...contactIds]))
    .orderBy(contactIdentities.createdAt, contactIdentities.id)
  for (const i of identities) {
    const list = out.get(i.contactId)!.identityPageIds
    if (!list.includes(i.pageId)) list.push(i.pageId)
  }
  if (pageIds.length === 0) return out
  const convs = await db
    .select({ conv: conversations, contactId: contactIdentities.contactId })
    .from(conversations)
    .innerJoin(contactIdentities, eq(contactIdentities.id, conversations.contactIdentityId))
    .where(and(inArray(contactIdentities.contactId, [...contactIds]), inArray(conversations.pageId, [...pageIds])))
    .orderBy(desc(conversations.lastMessageAt), desc(conversations.id))
  const previews = await previewsOf(
    db,
    convs.map((c) => c.conv.id),
  )
  for (const { conv, contactId } of convs) {
    out.get(contactId)!.conversations.push({
      id: conv.id,
      pageId: conv.pageId,
      channel: conv.channel as ConversationChannel,
      state: conv.state as ConversationState,
      lastMessageAt: conv.lastMessageAt.toISOString(),
      preview: previews.get(conv.id) ?? null,
    })
  }
  return out
}

/**
 * Lịch sử của khách: tin (không phải `system`) của mọi hội thoại của khách trên tập trang `pageIds`, trang MỚI NHẤT
 * theo `(platform_timestamp, id)`, trả theo thứ tự hiển thị (cũ → mới); cursor lùi về tin cũ. Mỗi tin kèm trang + kênh.
 */
export async function listContactMessages(
  db: DbExecutor,
  contactId: string,
  pageIds: readonly string[],
  query: PageQuery,
): Promise<Paged<ContactHistoryItem>> {
  if (pageIds.length === 0) return { items: [], nextCursor: null }
  const cursor = query.cursor ? decodeCursor(query.cursor) : null
  const rows = await db
    .select({ msg: messages, channel: conversations.channel })
    .from(messages)
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .innerJoin(contactIdentities, eq(contactIdentities.id, conversations.contactIdentityId))
    .where(
      and(
        eq(contactIdentities.contactId, contactId),
        inArray(conversations.pageId, [...pageIds]),
        ne(messages.origin, 'system'),
        cursor
          ? or(lt(messages.platformTimestamp, cursor.at), and(eq(messages.platformTimestamp, cursor.at), lt(messages.id, cursor.id)))
          : undefined,
      ),
    )
    .orderBy(desc(messages.platformTimestamp), desc(messages.id))
    .limit(query.limit + 1)
  const page = rows.slice(0, query.limit)
  const oldest = page.at(-1)
  const ordered = [...page].reverse()
  const dtos = await toMessageDtos(
    db,
    ordered.map((r) => r.msg),
  )
  const items = dtos.map((m, i) => ({ ...m, pageId: ordered[i]!.msg.pageId, channel: ordered[i]!.channel as ConversationChannel }))
  return { items, nextCursor: rows.length > query.limit && oldest ? encodeCursor(oldest.msg.platformTimestamp, oldest.msg.id) : null }
}

export interface ContactPatch {
  name?: string | null | undefined
  phone?: string | null | undefined
  note?: string | null | undefined
  tags?: readonly string[] | undefined
  stage?: ContactStage | undefined
}

/** Sửa hồ sơ khách (trường `undefined` giữ nguyên) → phát `contact.updated`. `null` khi khách không có. */
export async function updateContact(deps: ContactsDeps, id: string, patch: ContactPatch): Promise<ContactRecord | null> {
  if (!UUID_RE.test(id)) return null
  const set: Partial<typeof contacts.$inferInsert> = { updatedAt: new Date() }
  if (patch.name !== undefined) set.name = patch.name
  if (patch.phone !== undefined) set.phone = patch.phone
  if (patch.note !== undefined) set.note = patch.note
  if (patch.tags !== undefined) set.tags = dedupeTags(patch.tags)
  if (patch.stage !== undefined) set.stage = patch.stage
  return deps.db.transaction(async (tx) => {
    const [row] = await tx.update(contacts).set(set).where(eq(contacts.id, id)).returning()
    if (!row) return null
    await deps.events.publishEvent(tx, 'contact.updated', { id })
    return toRecord(row)
  })
}

export type BulkContactOp = { addTag: string; stage?: undefined } | { stage: ContactStage; addTag?: undefined }

/** Gắn một thẻ (bỏ qua khách đã có thẻ đó, không phân biệt hoa thường) hoặc đổi giai đoạn cho nhiều khách. Trả số khách đổi. */
export async function bulkUpdateContacts(deps: ContactsDeps, ids: readonly string[], op: BulkContactOp): Promise<number> {
  const valid = ids.filter((id) => UUID_RE.test(id))
  if (valid.length === 0) return 0
  return deps.db.transaction(async (tx) => {
    const rows =
      op.addTag !== undefined
        ? await tx
            .update(contacts)
            .set({ tags: sql`array_append(${contacts.tags}, ${op.addTag.trim()})`, updatedAt: new Date() })
            .where(
              and(
                inArray(contacts.id, valid),
                sql`not ${tagIn(op.addTag.trim())}`,
              ),
            )
            .returning({ id: contacts.id })
        : await tx
            .update(contacts)
            .set({ stage: op.stage, updatedAt: new Date() })
            .where(and(inArray(contacts.id, valid), ne(contacts.stage, op.stage)))
            .returning({ id: contacts.id })
    for (const r of rows) await deps.events.publishEvent(tx, 'contact.updated', { id: r.id })
    return rows.length
  })
}

// ---------------------------------------------------------------------------------------------------------
// Gộp khách
// ---------------------------------------------------------------------------------------------------------

export type MergeResult = { status: 'ok' } | { status: 'missing' }

/**
 * Gộp khách `sourceId` VÀO `targetId` (AD-11, chỉ bằng tay). Một transaction, khoá hai dòng theo thứ tự id:
 * - mọi định danh của nguồn → đích (hội thoại, tin đi theo định danh);
 * - hồ sơ: tên / SĐT của đích nếu có, không thì của nguồn; ghi chú nối (đích trước); thẻ hợp (bỏ trùng); giai đoạn của
 *   đích, trừ khi đích còn `new`; tóm tắt AI của đích nếu có;
 * - gợi ý gộp của nguồn với khách thứ ba chuyển sang đích; xoá nguồn (cascade gợi ý còn lại).
 * Phát `contact.merged` (nguồn) + `contact.updated` (đích). Cùng một khách → `VALIDATION_FAILED`.
 */
export async function mergeContacts(deps: ContactsDeps, targetId: string, sourceId: string): Promise<MergeResult> {
  if (targetId === sourceId) throw new AppError('VALIDATION_FAILED', 400, { message: 'Không gộp được một khách với chính nó' })
  if (!UUID_RE.test(targetId) || !UUID_RE.test(sourceId)) return { status: 'missing' }
  return deps.db.transaction(async (tx): Promise<MergeResult> => {
    const locked = await tx
      .select()
      .from(contacts)
      .where(inArray(contacts.id, [targetId, sourceId]))
      .orderBy(contacts.id)
      .for('update')
    const target = locked.find((c) => c.id === targetId)
    const source = locked.find((c) => c.id === sourceId)
    // Story 9.2: khách đang chờ xoá coi như không còn (khoá dòng trước nên không đua với yêu cầu xoá).
    if (!target || !source || target.deletionRequestedAt || source.deletionRequestedAt) return { status: 'missing' }

    await tx.update(contactIdentities).set({ contactId: targetId }).where(eq(contactIdentities.contactId, sourceId))
    const keepSummary = target.aiSummary !== null
    await tx
      .update(contacts)
      .set({
        name: target.name ?? source.name,
        phone: target.phone ?? source.phone,
        note: [target.note, source.note].filter((n): n is string => !!n?.trim()).join('\n\n') || null,
        tags: dedupeTags([...target.tags, ...source.tags]),
        stage: target.stage === 'new' ? source.stage : target.stage,
        aiSummary: keepSummary ? target.aiSummary : source.aiSummary,
        aiSummaryAt: keepSummary ? target.aiSummaryAt : source.aiSummaryAt,
        updatedAt: new Date(),
      })
      .where(eq(contacts.id, targetId))

    // Gợi ý gộp của nguồn với khách thứ ba → đích (cặp đã có — theo chiều nào — thì bỏ qua); cặp đích–nguồn mất theo
    // cascade. UNIQUE chỉ chặn cùng chiều nên kiểm thêm chiều ngược, không thì đích có hai dòng gợi ý cùng một khách.
    await tx.execute(sql`
      insert into ${contactMergeSuggestions} (contact_id, other_contact_id, reason)
      select m.a, m.b, m.reason from (
        select case when s.contact_id = ${sourceId} then ${targetId}::uuid else s.contact_id end as a,
               case when s.other_contact_id = ${sourceId} then ${targetId}::uuid else s.other_contact_id end as b,
               s.reason
        from ${contactMergeSuggestions} s
        where (s.contact_id = ${sourceId} and s.other_contact_id <> ${targetId})
           or (s.other_contact_id = ${sourceId} and s.contact_id <> ${targetId})
      ) m
      where not exists (select 1 from ${contactMergeSuggestions} e where e.contact_id = m.b and e.other_contact_id = m.a)
      on conflict do nothing`)
    await tx.delete(contacts).where(eq(contacts.id, sourceId))

    await deps.events.publishEvent(tx, 'contact.merged', { id: sourceId, intoId: targetId })
    await deps.events.publishEvent(tx, 'contact.updated', { id: targetId })
    return { status: 'ok' }
  })
}

/**
 * Ghi gợi ý gộp `contactId` ↔ `otherContactId` (bỏ qua nếu cặp — theo chiều nào — đã có). Gọi trong transaction của
 * bên gọi (nhắn riêng, `send.ts`). Trả `true` khi vừa ghi.
 */
export async function suggestMerge(tx: DbExecutor, contactId: string, otherContactId: string, reason: MergeSuggestionReason): Promise<boolean> {
  if (contactId === otherContactId) return false
  const [existing] = await tx
    .select({ id: contactMergeSuggestions.id })
    .from(contactMergeSuggestions)
    .where(
      or(
        and(eq(contactMergeSuggestions.contactId, contactId), eq(contactMergeSuggestions.otherContactId, otherContactId)),
        and(eq(contactMergeSuggestions.contactId, otherContactId), eq(contactMergeSuggestions.otherContactId, contactId)),
      ),
    )
  if (existing) return false
  const inserted = await tx
    .insert(contactMergeSuggestions)
    .values({ contactId, otherContactId, reason })
    .onConflictDoNothing()
    .returning({ id: contactMergeSuggestions.id })
  return inserted.length > 0
}

/** Khách được gợi ý gộp với `contactId` (cả hai chiều), cũ trước. */
export async function listMergeSuggestions(db: DbExecutor, contactId: string): Promise<ContactMergeSuggestion[]> {
  const rows = await db
    .select({ s: contactMergeSuggestions, otherName: contacts.name, otherId: contacts.id })
    .from(contactMergeSuggestions)
    .innerJoin(
      contacts,
      sql`${contacts.id} = case when ${contactMergeSuggestions.contactId} = ${contactId} then ${contactMergeSuggestions.otherContactId} else ${contactMergeSuggestions.contactId} end`,
    )
    .where(or(eq(contactMergeSuggestions.contactId, contactId), eq(contactMergeSuggestions.otherContactId, contactId)))
    .orderBy(contactMergeSuggestions.createdAt)
  return rows.map((r) => ({ contactId: r.otherId, name: r.otherName, reason: r.s.reason as MergeSuggestionReason }))
}
