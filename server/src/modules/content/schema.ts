// Bảng của module `content` (AD-1, AD-13, AD-14 — Story 6.1): `posts`, `post_targets`, `media_assets`,
// `post_target_media`. Chỉ `content` ghi; module khác đi qua `content/index.ts`.
// - Một bài thủ công = 1 `posts` + n `post_targets` (mỗi trang một đích). Caption nằm ở target (giá trị hiệu lực của
//   trang đó). Cột lịch/lỗi (`scheduled_at`, `schedule_version`, `error_code`, `cancel_reason`) do Story 6.4/6.5 dùng.
// - `media_assets` chỉ chứa ảnh bài (không logo, không đính kèm của khách); ảnh gắn vào target qua `post_target_media`.
// - FK tới `pages`/`posts` `on delete cascade`: trang chỉ bị xoá cứng khi xoá dữ liệu theo yêu cầu (gỡ trang là soft-delete).
import { CANCEL_REASONS, MEDIA_ASSET_SOURCES, POST_SOURCES, POST_TARGET_STATUSES } from '@ottm/shared'
import { sql } from 'drizzle-orm'
import { check, index, integer, pgTable, primaryKey, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core'
import { pagesTable } from '../pages/index.ts'

const inList = (xs: readonly string[]) => sql.raw(xs.map((s) => `'${s}'`).join(', '))

export const posts = pgTable(
  'posts',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    /** `manual` (Soạn bài) | `campaign` (Epic 7). */
    source: text('source').notNull(),
    /** Ý tưởng bài ("Ý tưởng bài viết"); `null` khi để trống. Không log. */
    topic: text('topic'),
    createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
  },
  (t) => [check('posts_source_check', sql`${t.source} in (${inList(POST_SOURCES)})`)],
)

export const postTargets = pgTable(
  'post_targets',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    postId: uuid('post_id')
      .notNull()
      .references(() => posts.id, { onDelete: 'cascade' }),
    pageId: uuid('page_id')
      .notNull()
      .references(() => pagesTable.id, { onDelete: 'cascade' }),
    /** Thứ tự tab trong bài (0-based). */
    position: integer('position').notNull(),
    /** `PostTargetStatus`; chỉ đổi qua `content` (AD-13). */
    status: text('status').notNull(),
    /** Caption của trang này. Không log. */
    caption: text('caption').notNull().default(''),
    /** Khoá lạc quan (AD-13): tăng mỗi lần target đổi. */
    version: integer('version').notNull().default(0),
    /** Tăng mỗi lần đổi `scheduled_at` hoặc vào/rời `scheduled` (Story 6.4). */
    scheduleVersion: integer('schedule_version').notNull().default(0),
    scheduledAt: timestamp('scheduled_at', { withTimezone: true, precision: 3 }),
    /** `ErrorCode` khi `failed` (Story 6.4). */
    errorCode: text('error_code'),
    cancelReason: text('cancel_reason'),
    createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
  },
  (t) => [
    unique('post_targets_post_page_unique').on(t.postId, t.pageId),
    index('post_targets_page_idx').on(t.pageId),
    check('post_targets_status_check', sql`${t.status} in (${inList(POST_TARGET_STATUSES)})`),
    check('post_targets_cancel_reason_check', sql`${t.cancelReason} is null or ${t.cancelReason} in (${inList(CANCEL_REASONS)})`),
  ],
)

export const mediaAssets = pgTable(
  'media_assets',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    /** `upload` | `ai`. */
    source: text('source').notNull(),
    /** public_id trên Cloudinary (`<folder>/public/<uuid>`) — để xoá khi dọn ảnh mồ côi (Story 6.3). */
    publicId: text('public_id').notNull(),
    /** URL công khai `https://res.cloudinary.com/...` — Meta và trình duyệt tải trực tiếp. */
    url: text('url').notNull(),
    width: integer('width').notNull(),
    height: integer('height').notNull(),
    bytes: integer('bytes').notNull(),
    /** Định dạng Cloudinary lưu (`jpg`). */
    format: text('format').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
  },
  (t) => [
    unique('media_assets_public_id_unique').on(t.publicId),
    check('media_assets_source_check', sql`${t.source} in (${inList(MEDIA_ASSET_SOURCES)})`),
  ],
)

/** Ảnh của một target theo thứ tự đăng. Xoá target kéo theo dòng nối; ảnh còn được dùng thì không xoá được. */
export const postTargetMedia = pgTable(
  'post_target_media',
  {
    postTargetId: uuid('post_target_id')
      .notNull()
      .references(() => postTargets.id, { onDelete: 'cascade' }),
    mediaAssetId: uuid('media_asset_id')
      .notNull()
      .references(() => mediaAssets.id),
    position: integer('position').notNull(),
  },
  (t) => [primaryKey({ columns: [t.postTargetId, t.mediaAssetId] }), index('post_target_media_asset_idx').on(t.mediaAssetId)],
)
