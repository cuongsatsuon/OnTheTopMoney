// Bảng của module `content` (AD-1, AD-13, AD-14 — Story 6.1): `posts`, `post_targets`, `media_assets`,
// `post_target_media`. Chỉ `content` ghi; module khác đi qua `content/index.ts`.
// - Một bài thủ công = 1 `posts` + n `post_targets` (mỗi trang một đích). Caption nằm ở target (giá trị hiệu lực của
//   trang đó). Cột lịch/lỗi (`scheduled_at`, `schedule_version`, `error_code`, `cancel_reason`) do Story 6.4/6.5 dùng;
//   Story 6.4 thêm cột đăng (`publishing_at`, `published_at`, `PublishedRef`); Story 6.5 thêm `ai_caption`.
// - Story 7.2: slot chiến dịch (1 post : 1 target) có `campaign_id` + `slot_at` (giờ dự kiến ban đầu, bất biến) và khoá
//   duy nhất `(campaign_id, page_id, slot_at)`; `held` do `campaigns` bật/tắt qua `content` (AD-15) — job đăng bỏ qua
//   target `held`. `campaign_id` KHÔNG có FK: `content` không biết bảng `campaigns` (AD-1).
// - `media_assets` chỉ chứa ảnh bài (không logo, không đính kèm của khách); ảnh gắn vào target qua `post_target_media`.
// - FK tới `pages`/`posts` `on delete cascade`: trang chỉ bị xoá cứng khi xoá dữ liệu theo yêu cầu (gỡ trang là soft-delete).
import { CANCEL_REASONS, IMAGE_ERROR_CODES, MEDIA_ASSET_SOURCES, MEDIA_ASSET_STATUSES, POST_SOURCES, POST_TARGET_STATUSES } from '@ottm/shared'
import { sql } from 'drizzle-orm'
import { boolean, check, index, integer, pgTable, primaryKey, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core'
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
    /** Caption do AI viết (Story 6.5, nhãn "AI tạo" — UX-DR10); web gửi theo nhãn của tab Soạn bài. */
    aiCaption: boolean('ai_caption').notNull().default(false),
    /** Chiến dịch của slot (Story 7.2); `null` với bài tay. Không FK (AD-1). */
    campaignId: uuid('campaign_id'),
    /** Giờ dự kiến ban đầu của slot — bất biến; kéo thả chỉ đổi `scheduled_at` (AD-13). Có ⇔ có `campaign_id`. */
    slotAt: timestamp('slot_at', { withTimezone: true, precision: 3 }),
    /** Giữ không đăng (AD-15): bài xem trước của chiến dịch nháp, chiến dịch tạm dừng. Job `publish.target` bỏ qua. */
    held: boolean('held').notNull().default(false),
    /** Khoá lạc quan (AD-13): tăng mỗi lần target đổi. */
    version: integer('version').notNull().default(0),
    /** Tăng mỗi lần đổi `scheduled_at` hoặc vào/rời `scheduled` (Story 6.4). */
    scheduleVersion: integer('schedule_version').notNull().default(0),
    scheduledAt: timestamp('scheduled_at', { withTimezone: true, precision: 3 }),
    /** `ErrorCode` khi `failed` (Story 6.4) — có đúng khi `failed`. */
    errorCode: text('error_code'),
    cancelReason: text('cancel_reason'),
    /** Lúc job chiếm target (`scheduled → publishing`); cron `content.requeue` dùng để phát hiện target kẹt. */
    publishingAt: timestamp('publishing_at', { withTimezone: true, precision: 3 }),
    /** Lúc bài lên trang (`published`). */
    publishedAt: timestamp('published_at', { withTimezone: true, precision: 3 }),
    /** `PublishedRef.platformPostId` đã chuẩn hoá (AD-6): FB `{pageId}_{postId}`, IG/Threads media id. Null khi Meta không trả id. */
    platformPostId: text('platform_post_id'),
    /** `PublishedRef.permalink` (lấy sau khi đăng, có thể thiếu). */
    permalink: text('permalink'),
    createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
  },
  (t) => [
    unique('post_targets_post_page_unique').on(t.postId, t.pageId),
    index('post_targets_page_idx').on(t.pageId),
    // Cron `content.requeue` quét `scheduled`/`publishing` theo giờ.
    index('post_targets_status_scheduled_idx').on(t.status, t.scheduledAt),
    check('post_targets_status_check', sql`${t.status} in (${inList(POST_TARGET_STATUSES)})`),
    // `failed` luôn kèm mã; Story 7.2: slot `pending_approval` được kèm mã (AI lỗi, ảnh lỗi, hậu kiểm chặn — AD-15).
    check(
      'post_targets_error_code_check',
      sql`(${t.status} <> 'failed' or ${t.errorCode} is not null) and (${t.errorCode} is null or ${t.status} in ('failed', 'pending_approval'))`,
    ),
    unique('post_targets_slot_unique').on(t.campaignId, t.pageId, t.slotAt),
    check('post_targets_slot_check', sql`(${t.campaignId} is null) = (${t.slotAt} is null)`),
    check('post_targets_scheduled_at_check', sql`${t.status} <> 'scheduled' or ${t.scheduledAt} is not null`),
    check('post_targets_cancel_reason_check', sql`${t.cancelReason} is null or ${t.cancelReason} in (${inList(CANCEL_REASONS)})`),
    // Story 6.5: huỷ luôn kèm lý do, và chỉ target `cancelled` có lý do.
    check('post_targets_cancelled_reason_check', sql`(${t.status} = 'cancelled') = (${t.cancelReason} is not null)`),
  ],
)

export const mediaAssets = pgTable(
  'media_assets',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    /** `upload` | `ai`. */
    source: text('source').notNull(),
    /**
     * `MediaAssetStatus` (Story 6.3): ảnh tải lên ghi thẳng `ready`; ô ảnh AI tạo `pending` rồi job đổi sang `ready`
     * (có file) hoặc `failed`. Chỉ ảnh `ready` gắn được vào target.
     */
    status: text('status').notNull().default('ready'),
    /** `IMAGE_REJECTED` | `IMAGE_FAILED` — có đúng khi `failed`. */
    errorCode: text('error_code'),
    /** Prompt ảnh AI đã dựng (`ai/prompts/image.ts`) — job đọc lại ở mỗi lượt thử. Không log. */
    prompt: text('prompt'),
    /** public_id trên Cloudinary (`<folder>/public/<uuid>`) — để cron `content.media_gc` xoá file. Null khi chưa `ready`. */
    publicId: text('public_id'),
    /** URL công khai `https://res.cloudinary.com/...` — Meta và trình duyệt tải trực tiếp. */
    url: text('url'),
    width: integer('width'),
    height: integer('height'),
    bytes: integer('bytes'),
    /** Định dạng Cloudinary lưu (`jpg`). */
    format: text('format'),
    createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
  },
  (t) => [
    unique('media_assets_public_id_unique').on(t.publicId),
    index('media_assets_created_at_idx').on(t.createdAt),
    check('media_assets_source_check', sql`${t.source} in (${inList(MEDIA_ASSET_SOURCES)})`),
    check('media_assets_status_check', sql`${t.status} in (${inList(MEDIA_ASSET_STATUSES)})`),
    check(
      'media_assets_error_code_check',
      sql`(${t.status} = 'failed') = (${t.errorCode} is not null) and (${t.errorCode} is null or ${t.errorCode} in (${inList(IMAGE_ERROR_CODES)}))`,
    ),
    check(
      'media_assets_ready_file_check',
      sql`${t.status} <> 'ready' or (${t.publicId} is not null and ${t.url} is not null and ${t.width} is not null and ${t.height} is not null and ${t.bytes} is not null and ${t.format} is not null)`,
    ),
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
