// Bảng của module `webhooks` (AD-1, AD-4). Story 4.1: `webhook_events` — mỗi mục webhook một dòng.
// Mỗi mục đã tách khỏi body (Graph `entry[].messaging[]`/`changes[]`, Threads parser riêng), chống trùng bằng
// UNIQUE(product, dedupe_key): Meta gửi lại gom khác vẫn một dòng. Payload thô chỉ là MỤC (không phải cả body),
// không chứa chữ ký (AD-12). `status` do job `webhook.route` đặt; `error_code` chẩn đoán khi lỗi.
import { WEBHOOK_EVENT_STATUSES, WEBHOOK_PRODUCTS } from '@ottm/shared'
import { sql } from 'drizzle-orm'
import { boolean, check, jsonb, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core'
import { pagesTable } from '../pages/index.ts'

const PRODUCT_LIST = sql.raw(WEBHOOK_PRODUCTS.map((p) => `'${p}'`).join(', '))
const STATUS_LIST = sql.raw(WEBHOOK_EVENT_STATUSES.map((s) => `'${s}'`).join(', '))

export const webhookEvents = pgTable(
  'webhook_events',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    /** `meta` (Facebook/Instagram) hoặc `threads` — app nào ký chữ ký. */
    product: text('product').notNull(),
    /** Id trang theo nền tảng lấy từ `entry.id`; `null` khi payload không có (vd sự kiện thử). */
    platformPageId: text('platform_page_id'),
    /** Trang nội bộ job `webhook.route` khớp được (giữ lịch sử kể cả khi trang bị gỡ sau đó). */
    pageId: uuid('page_id').references(() => pagesTable.id, { onDelete: 'set null' }),
    /** Loại mục để hiển thị/định tuyến: `messages`, `comments`, `feed`, `replies`, `test`… */
    field: text('field').notNull(),
    /** Khoá chống trùng của mục (`mid`/`comment_id`/id media, hoặc `sha256:<hash>` của mục). */
    dedupeKey: text('dedupe_key').notNull(),
    /** Mục đã tách (JSON), KHÔNG phải cả body. Payload thô cả body giữ ở đâu không cần cho 4.1. */
    payload: jsonb('payload').notNull(),
    status: text('status').notNull().default('received'),
    /** Mã lỗi chẩn đoán khi `status=failed` (chuỗi tự do, không thuộc `ErrorCode` của API). */
    errorCode: text('error_code'),
    /** Sự kiện do nút "Gửi sự kiện thử" tạo: chỉ ghi nhật ký, job route đặt `ignored`. */
    test: boolean('test').notNull().default(false),
    receivedAt: timestamp('received_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
    /** Lúc job `webhook.route` xử lý xong (đặt `status`); `null` khi chưa chạy. */
    routedAt: timestamp('routed_at', { withTimezone: true, precision: 3 }),
  },
  (t) => [
    unique('webhook_events_product_dedupe_unique').on(t.product, t.dedupeKey),
    check('webhook_events_product_check', sql`${t.product} in (${PRODUCT_LIST})`),
    check('webhook_events_status_check', sql`${t.status} in (${STATUS_LIST})`),
    // Nhật ký Cài đặt › Webhook sắp xếp và phân trang theo `id desc` (UUIDv7 = thứ tự thời gian). Không thêm
    // index riêng: khoá chính `id` phục vụ quét ngược cho `order by id desc` / `id < cursor`.
  ],
)
