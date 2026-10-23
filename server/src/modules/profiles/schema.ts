// Bảng của module `profiles` (AD-1): `brand_profiles` (Story 3.1) + `page_config_state` (Story 3.2/3.3)
// + `autoreply_configs` (Story 5.1) + `knowledge_items` (Story 5.2).
// Một hồ sơ cho mỗi chủ `(owner_type, owner_id)` — group hoặc page (UNIQUE). Không FK đa hình: owner tồn tại
// được kiểm ở service (gọi `pages.getGroup` / `pages.getPage`). Logo công khai nằm trên Cloudinary → `logo_path`
// là URL (KHÔNG vào `media_assets` — đó là ảnh bài).
import {
  AUTOREPLY_CHANNELS,
  AUTOREPLY_SCHEDULES,
  BRAND_EMOJI_LEVELS,
  CONFIG_KINDS,
  CONFIG_OWNER_TYPES,
  KNOWLEDGE_ERRORS,
  KNOWLEDGE_FILE_MIMES,
  KNOWLEDGE_KINDS,
  KNOWLEDGE_STATUSES,
} from '@ottm/shared'
import { sql } from 'drizzle-orm'
import { boolean, check, index, integer, jsonb, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core'
import { pagesTable } from '../pages/index.ts'

const OWNER_TYPE_LIST = sql.raw(CONFIG_OWNER_TYPES.map((s) => `'${s}'`).join(', '))
const EMOJI_LIST = sql.raw(BRAND_EMOJI_LEVELS.map((s) => `'${s}'`).join(', '))
const KIND_LIST = sql.raw(CONFIG_KINDS.map((s) => `'${s}'`).join(', '))
const SCHEDULE_LIST = sql.raw(AUTOREPLY_SCHEDULES.map((s) => `'${s}'`).join(', '))
const CHANNEL_ARRAY = sql.raw(`array[${AUTOREPLY_CHANNELS.map((s) => `'${s}'`).join(', ')}]::text[]`)
const inList = (xs: readonly string[]) => sql.raw(xs.map((s) => `'${s}'`).join(', '))

export const brandProfiles = pgTable(
  'brand_profiles',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    /** `group` | `page` (CONFIG_OWNER_TYPES). */
    ownerType: text('owner_type').notNull(),
    /** id của nhóm (`groups.id`) hoặc trang (`pages.id`) — không FK (đa hình), service kiểm tồn tại. */
    ownerId: uuid('owner_id').notNull(),
    name: text('name').notNull(),
    slogan: text('slogan').notNull().default(''),
    industry: text('industry').notNull().default(''),
    tones: text('tones').array().notNull().default(sql`'{}'::text[]`),
    formality: integer('formality').notNull().default(60),
    pronoun: text('pronoun').notNull().default(''),
    emoji: text('emoji').notNull().default('some'),
    /** `[{name, price}]` — AI chỉ báo giá theo danh sách này. */
    products: jsonb('products').notNull().default(sql`'[]'::jsonb`),
    audience: text('audience').notNull().default(''),
    colors: text('colors').array().notNull().default(sql`'{}'::text[]`),
    hashtags: text('hashtags').array().notNull().default(sql`'{}'::text[]`),
    bannedWords: text('banned_words').array().notNull().default(sql`'{}'::text[]`),
    /** URL ảnh logo công khai trên Cloudinary; `null` khi chưa có. */
    logoPath: text('logo_path'),
    allowedDomains: text('allowed_domains').array().notNull().default(sql`'{}'::text[]`),
    createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
  },
  (t) => [
    unique('brand_profiles_owner_unique').on(t.ownerType, t.ownerId),
    check('brand_profiles_owner_type_check', sql`${t.ownerType} in (${OWNER_TYPE_LIST})`),
    check('brand_profiles_emoji_check', sql`${t.emoji} in (${EMOJI_LIST})`),
    check('brand_profiles_formality_check', sql`${t.formality} between 0 and 100`),
  ],
)

/**
 * Trạng thái kế thừa của một trang theo từng loại cấu hình (AD-8, Story 3.2/3.3). Bảng generic `(page_id, kind)`
 * thay vì cột `use_own_<kind>` trên `pages`: thêm loại cấu hình AI (Epic 5) chỉ cần migration ALTER CHECK
 * (thêm `'autoreply'` vào `CONFIG_KINDS`) — KHÔNG thêm cột/bảng mỗi loại — và giữ ranh giới AD-1 (state kế thừa
 * thuộc `profiles`, không nhét vào module nền `pages`). Không có dòng = mặc định `use_own=false`,
 * `awaiting_group_default=false` (trang theo nhóm). `use_own` ↔ cờ `use_own_brand` của AD-8.
 */
export const pageConfigState = pgTable(
  'page_config_state',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    /** Trang (FK `pages.id`, `on delete cascade` để xoá trang dọn luôn trạng thái). */
    pageId: uuid('page_id')
      .notNull()
      .references(() => pagesTable.id, { onDelete: 'cascade' }),
    /** Loại cấu hình (`CONFIG_KINDS`: `brand`, `autoreply`). */
    kind: text('kind').notNull(),
    /** Trang dùng hồ sơ riêng loại này (`true`) hay theo nhóm (`false`). */
    useOwn: boolean('use_own').notNull().default(false),
    /** Đang chờ nhóm (chưa có cấu hình loại này) lưu lần đầu → sẽ chuyển về "Theo nhóm". */
    awaitingGroupDefault: boolean('awaiting_group_default').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
  },
  (t) => [
    unique('page_config_state_page_kind_unique').on(t.pageId, t.kind),
    check('page_config_state_kind_check', sql`${t.kind} in (${KIND_LIST})`),
  ],
)

/**
 * Cấu hình AI trả lời tự động (Story 5.1, AD-8, AD-16): một dòng cho mỗi chủ `(owner_type, owner_id)` như
 * `brand_profiles`, kế thừa Nhóm→Trang qua registry của `inheritance.ts` (kind `autoreply`). Luật hợp lệ (bật cần
 * kịch bản + kênh…) nằm ở schema zod `SaveAutoreplyConfigRequest` của shared; DB chỉ chặn giá trị enum.
 */
export const autoreplyConfigs = pgTable(
  'autoreply_configs',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    /** `group` | `page` (CONFIG_OWNER_TYPES). */
    ownerType: text('owner_type').notNull(),
    /** id nhóm hoặc trang — không FK (đa hình), service kiểm tồn tại. */
    ownerId: uuid('owner_id').notNull(),
    enabled: boolean('enabled').notNull().default(false),
    /** `always` | `offhours` | `custom` (AUTOREPLY_SCHEDULES). */
    schedule: text('schedule').notNull().default('always'),
    /** 7 phần tử `{on, from, to}` (T2→CN, giờ `HH:MM` theo Asia/Ho_Chi_Minh) — parse bằng zod khi đọc. */
    hours: jsonb('hours').notNull(),
    /** Kịch bản (system prompt) — không log. */
    script: text('script').notNull().default(''),
    handoffKeywords: text('handoff_keywords').array().notNull().default(sql`'{}'::text[]`),
    handoffOnCustomerAsk: boolean('handoff_on_customer_ask').notNull().default(true),
    handoffOnUncertain: boolean('handoff_on_uncertain').notNull().default(true),
    handoffMessage: text('handoff_message').notNull(),
    /** Kênh áp dụng (`AutoreplyChannel[]`). */
    channels: text('channels').array().notNull().default(sql`'{}'::text[]`),
    createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
  },
  (t) => [
    unique('autoreply_configs_owner_unique').on(t.ownerType, t.ownerId),
    check('autoreply_configs_owner_type_check', sql`${t.ownerType} in (${OWNER_TYPE_LIST})`),
    check('autoreply_configs_schedule_check', sql`${t.schedule} in (${SCHEDULE_LIST})`),
    check('autoreply_configs_channels_check', sql`${t.channels} <@ ${CHANNEL_ARRAY}`),
  ],
)

/**
 * Kho kiến thức (Story 5.2, AD-14, AD-16): mục FAQ hoặc file của một chủ `(owner_type, owner_id)` — cùng chủ với
 * `autoreply_configs` và đi cùng nó trong registry kế thừa (sao chép/xoá cùng cấu hình). Không FK tới
 * `autoreply_configs`: kho thêm được trước lần "Lưu cấu hình" đầu tiên (F6 bước 3).
 * File: lưu `PrivateFileStore` (Cloudinary `authenticated`) tới khi job trích xong rồi bị xoá — văn bản đã trích ở
 * `text`. Nhiều mục có thể trỏ cùng một file (bản sao kế thừa khi file đang `processing`); job xử lý theo file.
 */
export const knowledgeItems = pgTable(
  'knowledge_items',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    /** `group` | `page` (CONFIG_OWNER_TYPES). */
    ownerType: text('owner_type').notNull(),
    /** id nhóm hoặc trang — không FK (đa hình), service kiểm tồn tại. */
    ownerId: uuid('owner_id').notNull(),
    /** `faq` | `file`. */
    kind: text('kind').notNull(),
    /** Câu hỏi (FAQ) hoặc tên file — không log. */
    title: text('title').notNull(),
    /** Câu trả lời (FAQ) hoặc văn bản đã trích (file `ready`); `null` khi chưa/không dùng được. Không log. */
    text: text('text'),
    /** `processing` | `ready` | `failed` | `too_large` (KNOWLEDGE_STATUSES). FAQ luôn `ready`. */
    status: text('status').notNull(),
    /** Token ước tính (ký tự ÷ 2 như AI gateway); có ở `ready` và `too_large`. */
    tokenCount: integer('token_count'),
    /** Lý do `failed`/`too_large` (KNOWLEDGE_ERRORS). */
    errorCode: text('error_code'),
    /** Ref `PrivateFileStore` khi file còn trên kho (tới lúc trích xong). */
    filePublicId: text('file_public_id'),
    fileResourceType: text('file_resource_type'),
    fileFormat: text('file_format'),
    /** MIME đã xác nhận bằng magic bytes + kích thước gốc (giữ sau khi xoá file để hiển thị). */
    fileMime: text('file_mime'),
    fileBytes: integer('file_bytes'),
    processedAt: timestamp('processed_at', { withTimezone: true, precision: 3 }),
    createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
  },
  (t) => [
    index('knowledge_items_owner_idx').on(t.ownerType, t.ownerId),
    index('knowledge_items_file_idx').on(t.filePublicId),
    check('knowledge_items_owner_type_check', sql`${t.ownerType} in (${OWNER_TYPE_LIST})`),
    check('knowledge_items_kind_check', sql`${t.kind} in (${inList(KNOWLEDGE_KINDS)})`),
    check('knowledge_items_status_check', sql`${t.status} in (${inList(KNOWLEDGE_STATUSES)})`),
    check('knowledge_items_error_code_check', sql`${t.errorCode} is null or ${t.errorCode} in (${inList(KNOWLEDGE_ERRORS)})`),
    check('knowledge_items_file_mime_check', sql`${t.fileMime} is null or ${t.fileMime} in (${inList(KNOWLEDGE_FILE_MIMES)})`),
  ],
)
