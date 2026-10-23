// Bảng của module `inbox` (AD-1, AD-9, AD-11). Story 4.3: `contacts`, `contact_identities`, `conversations`,
// `messages`, `message_attachments`. Chỉ `inbox` ghi; module khác đọc qua `index.ts`.
// - Định danh theo trang: `contact_identities(page_id, platform_user_id)` thuộc đúng MỘT contact; định danh mới tạo
//   contact mới, không tự gộp (gộp bằng tay ở Story 4.9).
// - Hội thoại duy nhất theo `(page_id, channel, thread_key)`; DM: `thread_key` = PSID/IGSID.
// - Tin: UNIQUE(page_id, platform_message_id) khi id khác null; hiển thị theo `platform_timestamp` rồi `id`.
// Khoá ngoại tới `pages` `on delete cascade`: trang chỉ bị soft-delete (`removed_at`), xoá cứng chỉ xảy ra ở test/xoá
// dữ liệu (Epic 9).
import {
  ATTACHMENT_ERRORS,
  ATTACHMENT_KINDS,
  ATTACHMENT_STATUSES,
  CONTACT_STAGES,
  CONVERSATION_CHANNELS,
  CONVERSATION_STATES,
  MESSAGE_DIRECTIONS,
  MESSAGE_ORIGINS,
  MESSAGE_STATUSES,
  STATE_CHANGE_REASONS,
} from '@ottm/shared'
import { sql } from 'drizzle-orm'
import { bigint, boolean, check, index, integer, pgTable, text, timestamp, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { pagesTable } from '../pages/index.ts'

const list = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(', '))
const ts = (name: string) => timestamp(name, { withTimezone: true, precision: 3 })

/** Một khách. `name` trống khi chưa lấy được tên từ Meta (job `inbox.fetch_profile`) — FE hiện nhãn dự phòng. */
export const contacts = pgTable(
  'contacts',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    name: text('name'),
    stage: text('stage').notNull().default('new'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [check('contacts_stage_check', sql`${t.stage} in (${list(CONTACT_STAGES)})`)],
)

/** Id khách theo một trang (PSID Messenger, IGSID Instagram). */
export const contactIdentities = pgTable(
  'contact_identities',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => contacts.id, { onDelete: 'cascade' }),
    pageId: uuid('page_id')
      .notNull()
      .references(() => pagesTable.id, { onDelete: 'cascade' }),
    platformUserId: text('platform_user_id').notNull(),
    /** Tên/username nền tảng trả về cho định danh này (lấy một lần, có thể trống). */
    displayName: text('display_name'),
    username: text('username'),
    /** Lần cuối job hồ sơ chạy xong (thành công hay bỏ qua) — `null` khi chưa thử. */
    profileFetchedAt: ts('profile_fetched_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    unique('contact_identities_page_user_unique').on(t.pageId, t.platformUserId),
    index('contact_identities_contact_idx').on(t.contactId),
  ],
)

export const conversations = pgTable(
  'conversations',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    pageId: uuid('page_id')
      .notNull()
      .references(() => pagesTable.id, { onDelete: 'cascade' }),
    channel: text('channel').notNull(),
    /** DM: PSID/IGSID; comment: id bình luận gốc (Story 4.4). */
    threadKey: text('thread_key').notNull(),
    contactIdentityId: uuid('contact_identity_id')
      .notNull()
      .references(() => contactIdentities.id, { onDelete: 'cascade' }),
    state: text('state').notNull().default('triage'),
    /** Tăng mỗi lần chuyển trạng thái — khoá lạc quan cho quyết định của autoreply (AD-9). */
    stateVersion: integer('state_version').notNull().default(0),
    /** Lý do của lần chuyển trạng thái gần nhất. */
    stateReason: text('state_reason'),
    aiEnabled: boolean('ai_enabled').notNull().default(true),
    waitingSince: ts('waiting_since'),
    /** Chỉ tăng (`GREATEST`) — cửa sổ 24 giờ của `canSend` (Story 4.7). */
    lastCustomerMessageAt: ts('last_customer_message_at'),
    /** Thời điểm tin mới nhất (không tính tin `system`) — sắp xếp danh sách. Chỉ tăng. */
    lastMessageAt: ts('last_message_at').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    unique('conversations_thread_unique').on(t.pageId, t.channel, t.threadKey),
    check('conversations_channel_check', sql`${t.channel} in (${list(CONVERSATION_CHANNELS)})`),
    check('conversations_state_check', sql`${t.state} in (${list(CONVERSATION_STATES)})`),
    check('conversations_state_reason_check', sql`${t.stateReason} in (${list(STATE_CHANGE_REASONS)})`),
    // Danh sách Hộp thư: mới nhất trước, phân trang theo (last_message_at, id).
    index('conversations_last_message_idx').on(t.lastMessageAt, t.id),
    index('conversations_identity_idx').on(t.contactIdentityId),
  ],
)

export const messages = pgTable(
  'messages',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    /** Lặp lại `conversations.page_id` để UNIQUE id tin theo trang (AD-11). */
    pageId: uuid('page_id')
      .notNull()
      .references(() => pagesTable.id, { onDelete: 'cascade' }),
    /** `mid` của Meta; `null` với tin `system` và tin outbound chưa gửi. */
    platformMessageId: text('platform_message_id'),
    /** `null` chỉ với tin `system` (ghi chú chuyển trạng thái, không đi đâu cả). */
    direction: text('direction'),
    origin: text('origin').notNull(),
    /** Chỉ tin outbound (Story 4.7). */
    status: text('status'),
    text: text('text'),
    /** Tin `system`: lý do chuyển trạng thái. */
    reasonCode: text('reason_code'),
    platformTimestamp: ts('platform_timestamp').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('messages_page_platform_id_unique')
      .on(t.pageId, t.platformMessageId)
      .where(sql`${t.platformMessageId} is not null`),
    check('messages_direction_check', sql`${t.direction} in (${list(MESSAGE_DIRECTIONS)})`),
    check('messages_system_direction_check', sql`(${t.origin} = 'system') = (${t.direction} is null)`),
    check('messages_origin_check', sql`${t.origin} in (${list(MESSAGE_ORIGINS)})`),
    check('messages_status_check', sql`${t.status} in (${list(MESSAGE_STATUSES)})`),
    check('messages_reason_code_check', sql`${t.reasonCode} in (${list(STATE_CHANGE_REASONS)})`),
    // Khung chat: trang mới nhất trước theo (platform_timestamp, id); xem trước danh sách cũng dùng index này.
    index('messages_conversation_ts_idx').on(t.conversationId, t.platformTimestamp, t.id),
  ],
)

/**
 * Đính kèm của khách (AD-11, AD-14): tải từ CDN Meta về `PrivateFileStore` (Cloudinary `authenticated`) bằng job
 * `inbox.fetch_attachment`. `source_url` (link CDN có chữ ký, hết hạn) chỉ giữ tới khi tải xong rồi xoá.
 */
export const messageAttachments = pgTable(
  'message_attachments',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    messageId: uuid('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    /** Thứ tự trong tin. */
    position: integer('position').notNull(),
    kind: text('kind').notNull(),
    status: text('status').notNull().default('pending'),
    sourceUrl: text('source_url'),
    /** Bộ tham chiếu `PrivateFileRef` khi `stored`. */
    filePublicId: text('file_public_id'),
    fileResourceType: text('file_resource_type'),
    fileFormat: text('file_format'),
    mime: text('mime'),
    bytes: bigint('bytes', { mode: 'number' }),
    errorCode: text('error_code'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    unique('message_attachments_position_unique').on(t.messageId, t.position),
    check('message_attachments_kind_check', sql`${t.kind} in (${list(ATTACHMENT_KINDS)})`),
    check('message_attachments_status_check', sql`${t.status} in (${list(ATTACHMENT_STATUSES)})`),
    check('message_attachments_error_check', sql`${t.errorCode} in (${list(ATTACHMENT_ERRORS)})`),
    check('message_attachments_resource_type_check', sql`${t.fileResourceType} in ('image', 'raw')`),
  ],
)
