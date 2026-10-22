// Bảng của module nền `pages` (AD-1). Story 2.2: `pages`. Story 2.5: `groups` + khoá ngoại `pages.group_id`.
import { CONNECTION_STATUSES, GROUP_COLORS, PLATFORMS } from '@ottm/shared'
import { sql } from 'drizzle-orm'
import { check, index, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core'

const PLATFORM_LIST = sql.raw(PLATFORMS.map((p) => `'${p}'`).join(', '))
const STATUS_LIST = sql.raw(CONNECTION_STATUSES.map((s) => `'${s}'`).join(', '))
const GROUP_COLOR_LIST = sql.raw(GROUP_COLORS.map((c) => `'${c}'`).join(', '))

/**
 * Nhóm trang (Story 2.5, AD-8): tên + một màu trong bảng 8 màu `group-1…8`. Thành viên gắn ở `pages.group_id`
 * (mỗi trang tối đa một nhóm). Thành viên chỉ đổi qua `pages.assignGroup / unassignGroup / deleteGroup`.
 */
export const groups = pgTable(
  'groups',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    name: text('name').notNull(),
    color: text('color').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
  },
  (t) => [check('groups_color_check', sql`${t.color} in (${GROUP_COLOR_LIST})`)],
)

/**
 * Một trang đã kết nối (Fanpage, tài khoản Instagram Business, Threads). Gỡ trang là soft-delete
 * (`removed_at`); kết nối lại cùng `(platform, platform_account_id)` khôi phục đúng dòng cũ (giữ id, nhóm,
 * cấu hình, lịch sử). `connection_status` do `connections` tính và chỉ `connections` ghi qua
 * `setConnectionStatus`. Token không nằm ở đây (AD-5: `connections.page_credentials`).
 */
export const pages = pgTable(
  'pages',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    platform: text('platform').notNull(),
    platformAccountId: text('platform_account_id').notNull(),
    name: text('name').notNull(),
    handle: text('handle'),
    avatarUrl: text('avatar_url'),
    /** Nhóm của trang (Story 2.5): FK tới `groups.id`, `on delete set null` để xoá nhóm tự gỡ thành viên. */
    groupId: uuid('group_id').references(() => groups.id, { onDelete: 'set null' }),
    connectionStatus: text('connection_status').notNull().default('active'),
    connectionStatusReason: text('connection_status_reason'),
    connectedAt: timestamp('connected_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
    removedAt: timestamp('removed_at', { withTimezone: true, precision: 3 }),
    createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
  },
  (t) => [
    unique('pages_platform_account_unique').on(t.platform, t.platformAccountId),
    check('pages_platform_check', sql`${t.platform} in (${PLATFORM_LIST})`),
    check('pages_connection_status_check', sql`${t.connectionStatus} in (${STATUS_LIST})`),
    index('pages_active_idx').on(t.connectedAt).where(sql`${t.removedAt} is null`),
    index('pages_group_idx').on(t.groupId).where(sql`${t.groupId} is not null`),
  ],
)
