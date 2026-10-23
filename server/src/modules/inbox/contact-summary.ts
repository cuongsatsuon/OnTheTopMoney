// Tóm tắt khách bằng AI (Story 4.9, AD-2, AD-7): chủ shop bấm "Tóm tắt bằng AI" → route đánh dấu đang chờ
// (`ai_summary_requested_at`) và enqueue job `inbox.contact_summary` trong CÙNG transaction; đang chờ (<10 phút) thì không
// enqueue lại. Job đọc tối đa 40 tin gần nhất có chữ của mọi hội thoại của khách trên trang chưa gỡ (mỗi tin ghi trang),
// dựng prompt ở `ai/prompts/contact-summary.ts`, gọi gateway `feature=contact_summary` (`pageId` = trang của tin mới
// nhất, `ref` = contactId), lưu `ai_summary` + `ai_summary_at` → phát `contact.updated` (FE gắn nhãn "AI tạo").
// - Lỗi không retry được (khoá thiếu/hỏng, hết hạn mức, chính sách, request hỏng) → ghi `ai_summary_error`, kết thúc êm.
// - Lỗi tạm (`RATE_LIMITED`, OpenAI 5xx) → ném để retry; lần thử cuối ghi mã lỗi.
// - `job.signal` (pg-boss huỷ khi job quá hạn) truyền vào gateway: huỷ thì ném lại, không ghi lỗi — job đã bị đánh
//   lỗi/retry, không để lời gọi cũ chạy song song lần thử mới (tính tiền hai lần, chặn worker).
// Không log tên, SĐT, nội dung tin hay bản tóm tắt.
import { AI_SUMMARY_PENDING_MS, type AiSummaryStatus, type ConversationChannel, type ErrorCode, type Platform } from '@ottm/shared'
import { and, desc, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm'
import { bossDbFor, type Db, type DbExecutor } from '../../platform/db/index.ts'
import { AppError } from '../../platform/errors/index.ts'
import type { EventPublisher } from '../../platform/events/index.ts'
import type { JobSender } from '../../platform/jobs/index.ts'
import { buildContactSummaryPrompt, generateText, type AiDeps, type ContactSummaryTurn } from '../ai/index.ts'
import { listPages } from '../pages/index.ts'
import type { ContactRecord } from './contacts.ts'
import { contactIdentities, contacts, conversations, messages } from './schema.ts'

/** Số tin gần nhất (có chữ) đưa vào prompt. */
export const SUMMARY_CONTEXT_MESSAGES = 40
/** Cắt mỗi tin để prompt không phình (chi phí, AD-7). */
export const SUMMARY_TEXT_MAX = 500

export interface RequestSummaryDeps {
  db: Db
  events: EventPublisher
  jobs: JobSender
  now?: () => Date
}

export type ContactSummaryDeps = Pick<AiDeps, 'db' | 'events' | 'cipher' | 'openai' | 'log' | 'now'>

export type SummaryOutcome = 'updated' | 'failed' | 'skipped'

export class ContactSummaryRetryableError extends Error {
  readonly code: ErrorCode
  constructor(code: ErrorCode) {
    super(`inbox.contact_summary: ${code}`)
    this.name = 'ContactSummaryRetryableError'
    this.code = code
  }
}

type SummaryFields = Pick<ContactRecord, 'aiSummaryAt' | 'aiSummaryRequestedAt' | 'aiSummaryError'>

/** Có yêu cầu chưa xong (mới hơn bản tóm tắt, chưa ghi lỗi) — không xét hạn 10 phút. */
const awaiting = (c: SummaryFields): boolean =>
  c.aiSummaryRequestedAt !== null && c.aiSummaryError === null && (c.aiSummaryAt === null || c.aiSummaryAt < c.aiSummaryRequestedAt)

/**
 * Trạng thái tóm tắt cho DTO: lỗi đã ghi → `failed` + mã; đang chờ quá 10 phút (job mất) → `failed` không mã; đang chờ →
 * `pending`; còn lại `idle`.
 */
export function aiSummaryStatusOf(c: SummaryFields, now: Date): { status: AiSummaryStatus; error: ErrorCode | null } {
  if (c.aiSummaryError !== null) return { status: 'failed', error: c.aiSummaryError as ErrorCode }
  if (!awaiting(c)) return { status: 'idle', error: null }
  return now.getTime() - c.aiSummaryRequestedAt!.getTime() < AI_SUMMARY_PENDING_MS ? { status: 'pending', error: null } : { status: 'failed', error: null }
}

/** Tin có chữ của mọi hội thoại của khách trên các trang `pageIds` (bỏ `system`, tin gửi lỗi, tin đã xoá/ẩn). */
const summarizable = (contactId: string, pageIds: readonly string[]) =>
  and(
    eq(contactIdentities.contactId, contactId),
    inArray(conversations.pageId, [...pageIds]),
    ne(messages.origin, 'system'),
    sql`${messages.status} is distinct from 'failed'`,
    isNull(messages.removal),
    sql`coalesce(btrim(${messages.text}), '') <> ''`,
  )

export type RequestSummaryResult = { status: 'queued' } | { status: 'pending' } | { status: 'missing' } | { status: 'no_messages' }

/**
 * Yêu cầu tóm tắt cho khách (bên gọi đã kiểm khách còn trên trang chưa gỡ, `pageIds` = trang chưa gỡ). Khách chưa có tin
 * có chữ → `no_messages`; đang chờ → `pending` (không enqueue lại); còn lại đánh dấu chờ + enqueue cùng transaction.
 */
export async function requestContactSummary(deps: RequestSummaryDeps, contactId: string, pageIds: readonly string[]): Promise<RequestSummaryResult> {
  const now = deps.now?.() ?? new Date()
  if (pageIds.length === 0) return { status: 'no_messages' }
  const [has] = await deps.db
    .select({ id: messages.id })
    .from(messages)
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .innerJoin(contactIdentities, eq(contactIdentities.id, conversations.contactIdentityId))
    .where(summarizable(contactId, pageIds))
    .limit(1)
  if (!has) return { status: 'no_messages' }
  const staleBefore = new Date(now.getTime() - AI_SUMMARY_PENDING_MS)
  return deps.db.transaction(async (tx): Promise<RequestSummaryResult> => {
    const [row] = await tx
      .update(contacts)
      .set({ aiSummaryRequestedAt: now, aiSummaryError: null })
      .where(
        and(
          eq(contacts.id, contactId),
          // Không đang chờ: chưa yêu cầu, đã xong, đã lỗi, hoặc chờ quá 10 phút (job mất).
          or(
            isNull(contacts.aiSummaryRequestedAt),
            sql`${contacts.aiSummaryAt} >= ${contacts.aiSummaryRequestedAt}`,
            sql`${contacts.aiSummaryError} is not null`,
            sql`${contacts.aiSummaryRequestedAt} < ${staleBefore.toISOString()}::timestamptz`,
          ),
        ),
      )
      .returning({ id: contacts.id })
    if (!row) {
      const [exists] = await tx.select({ id: contacts.id }).from(contacts).where(eq(contacts.id, contactId))
      return exists ? { status: 'pending' } : { status: 'missing' }
    }
    await deps.jobs.send('inbox.contact_summary', { contactId }, { db: bossDbFor(tx) })
    await deps.events.publishEvent(tx, 'contact.updated', { id: contactId })
    return { status: 'queued' }
  })
}

const CHANNEL_WORD: Record<ConversationChannel, string> = { dm: 'tin nhắn', comment: 'bình luận' }
const PLATFORM_LABEL: Record<Platform, string> = { facebook: 'Facebook', instagram: 'Instagram', threads: 'Threads' }

/** Gộp mọi xuống dòng thành một khoảng trắng (mỗi tin đúng một dòng — chống giả lượt) rồi cắt. */
const cut = (text: string) => {
  const chars = [...text.replace(/\s+/g, ' ').trim()]
  return chars.length > SUMMARY_TEXT_MAX ? `${chars.slice(0, SUMMARY_TEXT_MAX).join('')}…` : chars.join('')
}

/** Lịch sử cho prompt (cũ → mới) + trang của tin mới nhất (ghi `ai_usage.page_id`). */
async function summaryTurns(db: DbExecutor, contactId: string): Promise<{ turns: ContactSummaryTurn[]; pageId: string | null }> {
  const pages = await listPages(db)
  if (pages.length === 0) return { turns: [], pageId: null }
  const pageOf = new Map(pages.map((p) => [p.id, p]))
  const identityIds = new Set(
    (await db.select({ id: contactIdentities.id }).from(contactIdentities).where(eq(contactIdentities.contactId, contactId))).map((r) => r.id),
  )
  const rows = await db
    .select({
      pageId: conversations.pageId,
      channel: conversations.channel,
      convIdentityId: conversations.contactIdentityId,
      direction: messages.direction,
      senderIdentityId: messages.senderIdentityId,
      text: messages.text,
    })
    .from(messages)
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .innerJoin(contactIdentities, eq(contactIdentities.id, conversations.contactIdentityId))
    .where(summarizable(contactId, [...pageOf.keys()]))
    .orderBy(desc(messages.platformTimestamp), desc(messages.id))
    .limit(SUMMARY_CONTEXT_MESSAGES)
  const turns = [...rows].reverse().map((r): ContactSummaryTurn => {
    const page = pageOf.get(r.pageId)!
    const sender = r.senderIdentityId ?? r.convIdentityId
    const author = r.direction === 'outbound' ? 'shop' : identityIds.has(sender) ? 'customer' : 'other'
    return { page: `${page.name} · ${CHANNEL_WORD[r.channel as ConversationChannel]} ${PLATFORM_LABEL[page.platform]}`, author, text: cut(r.text ?? '') }
  })
  return { turns, pageId: rows[0]?.pageId ?? null }
}

/** Lỗi gateway đáng thử lại: chặn tần suất, OpenAI lỗi tạm (5xx). */
const retryable = (err: AppError) => err.code === 'RATE_LIMITED' || (err.code === 'AI_PROVIDER_ERROR' && err.statusCode >= 500)

async function writeOutcome(deps: ContactSummaryDeps, contactId: string, fields: Partial<typeof contacts.$inferInsert>): Promise<void> {
  await deps.db.transaction(async (tx) => {
    const [row] = await tx.update(contacts).set(fields).where(eq(contacts.id, contactId)).returning({ id: contacts.id })
    if (row) await deps.events.publishEvent(tx, 'contact.updated', { id: contactId })
  })
}

/**
 * Handler job `inbox.contact_summary`. `finalAttempt`: lần thử cuối → lỗi tạm thành mã lỗi thay vì ném. `signal`: huỷ
 * khi job quá hạn → ném lại (không ghi lỗi).
 */
export async function summarizeContact(
  deps: ContactSummaryDeps,
  contactId: string,
  opts: { finalAttempt: boolean; signal?: AbortSignal | undefined },
): Promise<SummaryOutcome> {
  const [contact] = await deps.db.select().from(contacts).where(eq(contacts.id, contactId))
  if (!contact || !awaiting(contact)) return 'skipped'
  const fail = async (code: ErrorCode): Promise<SummaryOutcome> => {
    await writeOutcome(deps, contactId, { aiSummaryError: code })
    deps.log?.warn({ contactId, code }, 'inbox: tóm tắt khách lỗi')
    return 'failed'
  }

  const { turns, pageId } = await summaryTurns(deps.db, contactId)
  if (turns.length === 0) return fail('VALIDATION_FAILED')
  const prompt = buildContactSummaryPrompt(turns)
  let text: string
  try {
    const res = await generateText(deps, {
      feature: 'contact_summary',
      pageId,
      ref: contactId,
      instructions: prompt.instructions,
      input: prompt.input,
      maxOutputTokens: prompt.maxOutputTokens,
      ...(opts.signal ? { signal: opts.signal } : {}),
    })
    text = res.text.trim()
  } catch (err) {
    if (opts.signal?.aborted) throw err
    if (err instanceof AppError) {
      if (retryable(err) && !opts.finalAttempt) throw new ContactSummaryRetryableError(err.code)
      return fail(err.code)
    }
    if (!opts.finalAttempt) throw err
    return fail('INTERNAL')
  }
  if (!text) return fail('AI_PROVIDER_ERROR')
  const now = deps.now?.() ?? new Date()
  await writeOutcome(deps, contactId, { aiSummary: text, aiSummaryAt: now, aiSummaryError: null, updatedAt: now })
  return 'updated'
}

export function parseContactSummaryJobData(data: unknown): { contactId: string } {
  const id = (data as { contactId?: unknown } | null)?.contactId
  if (typeof id !== 'string' || id === '') throw new Error('inbox.contact_summary: thiếu contactId')
  return { contactId: id }
}

export async function handleContactSummaryJob(
  deps: ContactSummaryDeps,
  job: { data: unknown; retryCount: number; retryLimit: number; signal?: AbortSignal | undefined },
): Promise<SummaryOutcome> {
  const { contactId } = parseContactSummaryJobData(job.data)
  return summarizeContact(deps, contactId, { finalAttempt: job.retryCount >= job.retryLimit, signal: job.signal })
}
