// Nghiệp vụ webhook (Story 4.1, AD-4). Chỉ entrypoint gọi qua index.ts.
// - `ingestWebhook`: kiểm HMAC raw body (constant-time) → tách mục → ghi `webhook_events` (chống trùng) →
//   enqueue `webhook.route` mỗi mục trong CÙNG transaction (AD-2). Sai/thiếu chữ ký → KHÔNG ghi gì.
// - `listWebhookEvents`, `createTestEvent`, `retryEvent`, `markEventFailed`: cho REST api + worker.
import type { Platform, WebhookEventDto, WebhookLogResponse, WebhookProduct } from '@ottm/shared'
import { and, desc, eq, isNotNull, isNull, lt, sql } from 'drizzle-orm'
import { verifyWebhookSignature } from '../../adapters/meta/index.ts'
import { bossDbFor, newId, type Db, type DbExecutor } from '../../platform/db/index.ts'
import type { JobSender } from '../../platform/jobs/index.ts'
import { pagesTable } from '../pages/index.ts'
import { parseMetaBody, parseThreadsBody, type WebhookItem } from './parse.ts'
import { webhookEvents } from './schema.ts'

export interface IngestWebhookInput {
  product: WebhookProduct
  /** Raw body đúng byte Meta gửi (để verify rồi mới JSON.parse). */
  rawBody: Buffer
  /** Header `X-Hub-Signature-256`. */
  signature: string | undefined
  /** App secret của đúng app (`META_APP_SECRET` cho meta, `THREADS_APP_SECRET` cho threads). */
  appSecret: string | undefined
}

export type IngestOutcome =
  | { ok: true; accepted: number; duplicates: number }
  /** `unsigned`/`bad_signature` → 401; `not_configured` → server chưa có app secret (không verify được). */
  | { ok: false; reason: 'unsigned' | 'bad_signature' | 'not_configured' }

export interface IngestDeps {
  db: Db
  jobs: JobSender
}

/** Tách body theo sản phẩm (Graph vs Threads). */
export function parseWebhookBody(product: WebhookProduct, body: unknown): WebhookItem[] {
  return product === 'threads' ? parseThreadsBody(body) : parseMetaBody(body)
}

export async function ingestWebhook(deps: IngestDeps, input: IngestWebhookInput): Promise<IngestOutcome> {
  if (!input.appSecret) return { ok: false, reason: 'not_configured' }
  if (!verifyWebhookSignature(input.rawBody, input.signature, input.appSecret)) {
    return { ok: false, reason: input.signature ? 'bad_signature' : 'unsigned' }
  }
  // Chữ ký đã đúng trên raw body → body là JSON hợp lệ của Meta. Lỗi parse (hiếm) → không có mục.
  let body: unknown
  try {
    body = JSON.parse(input.rawBody.toString('utf8'))
  } catch {
    body = null
  }
  const items = parseWebhookBody(input.product, body)
  if (items.length === 0) return { ok: true, accepted: 0, duplicates: 0 }

  return deps.db.transaction(async (tx) => {
    let accepted = 0
    let duplicates = 0
    for (const item of items) {
      const [row] = await tx
        .insert(webhookEvents)
        .values({
          product: input.product,
          platformPageId: item.platformPageId,
          field: item.field,
          dedupeKey: item.dedupeKey,
          payload: item.payload,
        })
        .onConflictDoNothing({ target: [webhookEvents.product, webhookEvents.dedupeKey] })
        .returning({ id: webhookEvents.id })
      if (!row) {
        // UNIQUE(product, dedupe_key) chặn bản thứ hai (Meta gửi lại gom khác) — không enqueue lại.
        duplicates++
        continue
      }
      accepted++
      // Enqueue trong transaction: job chỉ tồn tại khi commit (AD-2).
      await deps.jobs.send('webhook.route', { eventId: row.id }, { db: bossDbFor(tx) })
    }
    return { ok: true, accepted, duplicates }
  })
}

/**
 * Sự kiện thử (nút "Gửi sự kiện thử"): tạo một dòng cờ `test` rồi enqueue route (route sẽ đặt `ignored`).
 * `dedupe_key` ngẫu nhiên để mỗi lần bấm là một dòng. Trả về dto (`status=received`) để FE hiện ngay.
 */
export async function createTestEvent(deps: IngestDeps, product: WebhookProduct): Promise<WebhookEventDto> {
  return deps.db.transaction(async (tx) => {
    const [row] = await tx
      .insert(webhookEvents)
      .values({
        product,
        platformPageId: null,
        field: 'test',
        dedupeKey: `test:${newId()}`,
        payload: { test: true, product },
        test: true,
      })
      .returning()
    await deps.jobs.send('webhook.route', { eventId: row!.id }, { db: bossDbFor(tx) })
    return toDto(row!, null)
  })
}

export type RetryOutcome =
  | { status: 'retried'; event: WebhookEventDto }
  /** Không có id (api → 404). */
  | { status: 'not_found' }
  /** Mục không ở `failed` (api → 409): chỉ mục `failed` mới được xử lý lại (AD-4), không reset received/routed/ignored. */
  | { status: 'not_failed' }
  /** Story 9.3: mục `failed` nhưng payload thô đã dọn theo hạn (api → 409) — không còn gì để route. */
  | { status: 'purged' }

/**
 * "Xử lý lại" một mục (AD-4): CHỈ mục `status='failed'` còn payload thô (Story 9.3) — đưa về `received`, xoá `error_code`/`routed_at`,
 * enqueue route lại. Idempotent theo khoá mục (route tính lại trạng thái xác định). Mục received/routed/ignored
 * KHÔNG bị reset/re-route (trả `not_failed`).
 */
export async function retryEvent(deps: IngestDeps, id: string): Promise<RetryOutcome> {
  return deps.db.transaction(async (tx) => {
    const [row] = await tx
      .update(webhookEvents)
      .set({ status: 'received', errorCode: null, routedAt: null })
      .where(and(eq(webhookEvents.id, id), eq(webhookEvents.status, 'failed'), isNotNull(webhookEvents.payload)))
      .returning()
    if (row) {
      await deps.jobs.send('webhook.route', { eventId: row.id }, { db: bossDbFor(tx) })
      return { status: 'retried', event: toDto(row, null) }
    }
    // Không cập nhật được: phân biệt không tồn tại với không-phải-failed.
    const [existing] = await tx
      .select({ status: webhookEvents.status, purged: isNull(webhookEvents.payload) })
      .from(webhookEvents)
      .where(eq(webhookEvents.id, id))
    if (!existing) return { status: 'not_found' }
    return existing.status === 'failed' && existing.purged ? { status: 'purged' } : { status: 'not_failed' }
  })
}

/** Worker gọi khi job `webhook.route` hết lượt retry: ghi `failed` + mã lỗi chẩn đoán (AD-4). */
export async function markEventFailed(db: DbExecutor, id: string, errorCode: string): Promise<void> {
  await db
    .update(webhookEvents)
    .set({ status: 'failed', errorCode, routedAt: sql`now()` })
    .where(eq(webhookEvents.id, id))
}

type Row = typeof webhookEvents.$inferSelect
/** Trang từ LEFT JOIN: mỗi cột có thể null (không khớp), nên tự kiểm `id` để quyết object. */
type PageJoin = { id: string | null; name: string | null; platform: string | null } | null

export function toDto(row: Row, page: PageJoin): WebhookEventDto {
  return {
    id: row.id,
    product: row.product as WebhookProduct,
    platformPageId: row.platformPageId,
    page: page && page.id !== null ? { id: page.id, name: page.name ?? '', platform: (page.platform ?? 'facebook') as Platform } : null,
    field: row.field,
    status: row.status as WebhookEventDto['status'],
    errorCode: row.errorCode,
    test: row.test,
    payloadPurged: row.payload === null,
    receivedAt: row.receivedAt.toISOString(),
    routedAt: row.routedAt ? row.routedAt.toISOString() : null,
  }
}

/** Nhật ký webhook (Cài đặt › Webhook): mới nhất trước, phân trang theo id. Join trang để hiện tên (kể cả đã gỡ). */
export async function listWebhookEvents(
  db: Db,
  query: { cursor?: string | undefined; limit: number },
): Promise<WebhookLogResponse> {
  // Id UUIDv7 tăng theo thời gian nên `id desc` = mới nhất trước; cursor lấy dòng có id nhỏ hơn (như notifications).
  const rows = await db
    .select({ event: webhookEvents, page: { id: pagesTable.id, name: pagesTable.name, platform: pagesTable.platform } })
    .from(webhookEvents)
    .leftJoin(pagesTable, eq(pagesTable.id, webhookEvents.pageId))
    .where(query.cursor ? lt(webhookEvents.id, query.cursor) : undefined)
    .orderBy(desc(webhookEvents.id))
    .limit(query.limit + 1)
  const page = rows.slice(0, query.limit)
  return {
    items: page.map((r) => toDto(r.event, r.page)),
    nextCursor: rows.length > query.limit ? page[page.length - 1]!.event.id : null,
  }
}
