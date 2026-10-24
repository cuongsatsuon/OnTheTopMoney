// Bảng của module `campaigns` (AD-1, AD-15 — Story 7.1): `campaigns`, `campaign_topics`, `campaign_pages`. Chỉ
// `campaigns` ghi; module khác đi qua `campaigns/index.ts`.
// - Story 7.1 lưu cấu hình wizard ở `draft`. `campaign_pages` lúc nháp = đích đã chọn (trang + tần suất đặt riêng);
//   "Bắt đầu chiến dịch" (7.3) chụp lại khi chuyển `running` (chốt tần suất hiệu lực vào `frequency`).
// - `group_id` chỉ là nhãn (AD-15): xoá nhóm thì về `null`, chiến dịch giữ nguyên trang.
// - FK tới `pages` `on delete cascade`: trang chỉ bị xoá cứng khi xoá dữ liệu theo yêu cầu (gỡ trang là soft-delete).
// - Story 7.5: `pause_reason` + `paused_at` có đúng khi `paused`; `consecutive_failures` (bài đăng lỗi liên tiếp — 7.6 tăng,
//   "Tiếp tục" đặt về 0); Story 7.6: `failure_target_ids` (target đã đếm — chống đếm trùng). Xoá chiến dịch xoá cứng
//   dòng (slot không có FK tới đây — bài đã đăng giữ nguyên ở `content`).
// - Story 7.7: `product_image_id` = ảnh sản phẩm (ảnh tải lên của `content`), FK KHÔNG cascade: ảnh không bị dọn khi chiến
//   dịch còn trỏ tới; xoá chiến dịch thì ảnh thành ảnh không gắn bài, `content.media_gc` dọn theo hạn.
import { CAMPAIGN_DURATIONS, CAMPAIGN_FREQUENCIES, CAMPAIGN_GOALS, CAMPAIGN_MODES, CAMPAIGN_POST_TIMES_MAX, CAMPAIGN_STATUSES, PAUSE_REASONS } from '@ottm/shared'
import { sql } from 'drizzle-orm'
import { check, date, index, integer, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { mediaAssetsTable } from '../content/index.ts'
import { groupsTable, pagesTable } from '../pages/index.ts'

const inList = (xs: readonly (string | number)[]) => sql.raw(xs.map((s) => (typeof s === 'number' ? String(s) : `'${s}'`)).join(', '))

export const campaigns = pgTable(
  'campaigns',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    name: text('name').notNull(),
    /** `CampaignGoal` (bước 1 wizard). */
    goal: text('goal').notNull(),
    /** `CampaignStatus`; Story 7.1 chỉ tạo `draft`. */
    status: text('status').notNull().default('draft'),
    /** `CampaignMode`: `review` = "Duyệt trước khi đăng" (mặc định), `auto` = "Tự đăng". */
    mode: text('mode').notNull().default('review'),
    /** Ngày bắt đầu theo lịch VN (`YYYY-MM-DD`). */
    startDate: date('start_date', { mode: 'string' }).notNull(),
    durationDays: integer('duration_days').notNull(),
    /** Nhóm đã chọn ở bước 2 ("Theo nhóm") — chỉ là nhãn. */
    groupId: uuid('group_id').references(() => groupsTable.id, { onDelete: 'set null' }),
    /** `CampaignFrequency` mặc định cho trang không đặt riêng. */
    defaultFrequency: text('default_frequency').notNull(),
    /** % bài có ảnh AI cho Facebook/Threads (Instagram luôn có ảnh — `campaignImageRatio`). */
    imageRatio: integer('image_ratio').notNull(),
    /** Khung giờ đăng `HH:MM` theo giờ VN, tăng dần. */
    postTimes: text('post_times').array().notNull(),
    /** Story 7.7: ảnh sản phẩm (ảnh tải lên `ready`) — ô ảnh của mọi slot có ảnh sinh từ ảnh này. Chỉ đổi khi còn `draft`. */
    productImageId: uuid('product_image_id').references(() => mediaAssetsTable.id),
    /** Story 7.3: lúc bấm "Bắt đầu chiến dịch" — có đúng khi đã rời `draft`. */
    startedAt: timestamp('started_at', { withTimezone: true, precision: 3 }),
    /** Story 7.5: `PauseReason` — có đúng khi `paused` (`MANUAL` = chủ shop; còn lại do hệ thống — 7.6). */
    pauseReason: text('pause_reason'),
    /** Story 7.5: lúc tạm dừng (đi cùng `pause_reason`). */
    pausedAt: timestamp('paused_at', { withTimezone: true, precision: 3 }),
    /** Số bài đăng lỗi liên tiếp (Story 7.6 tăng / về 0 khi đăng được; chạm 3 → tự dừng). "Tiếp tục" đặt về 0. */
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
    /**
     * Story 7.6: target đã đếm vào chuỗi lỗi hiện tại (idempotent theo `targetId` — giao lại sự kiện / "Đăng lại" bài cũ lỗi
     * tiếp không đếm thêm). Luôn có đúng `consecutive_failures` phần tử; đăng được / "Tiếp tục" → rỗng.
     */
    failureTargetIds: text('failure_target_ids').array().notNull().default(sql`'{}'::text[]`),
    createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
  },
  (t) => [
    index('campaigns_status_idx').on(t.status),
    // Khoá ngoại tới `media_assets`: Postgres dò cột này mỗi lần xoá một ảnh (cron dọn, xoá theo yêu cầu).
    index('campaigns_product_image_idx').on(t.productImageId),
    check('campaigns_goal_check', sql`${t.goal} in (${inList(CAMPAIGN_GOALS)})`),
    check('campaigns_status_check', sql`${t.status} in (${inList(CAMPAIGN_STATUSES)})`),
    check('campaigns_mode_check', sql`${t.mode} in (${inList(CAMPAIGN_MODES)})`),
    check('campaigns_duration_check', sql`${t.durationDays} in (${inList(CAMPAIGN_DURATIONS)})`),
    check('campaigns_default_frequency_check', sql`${t.defaultFrequency} in (${inList(CAMPAIGN_FREQUENCIES)})`),
    check('campaigns_image_ratio_check', sql`${t.imageRatio} between 0 and 100`),
    check('campaigns_started_at_check', sql`(${t.status} = 'draft') = (${t.startedAt} is null)`),
    check('campaigns_pause_reason_check', sql`(${t.status} = 'paused') = (${t.pauseReason} is not null)`),
    check('campaigns_pause_reason_value_check', sql`${t.pauseReason} is null or ${t.pauseReason} in (${inList(PAUSE_REASONS)})`),
    check('campaigns_paused_at_check', sql`(${t.pauseReason} is null) = (${t.pausedAt} is null)`),
    check('campaigns_failures_check', sql`${t.consecutiveFailures} = cardinality(${t.failureTargetIds})`),
    check('campaigns_post_times_check', sql`cardinality(${t.postTimes}) between 1 and ${sql.raw(String(CAMPAIGN_POST_TIMES_MAX))}`),
  ],
)

/** Chủ đề + tỉ lệ (%) theo thứ tự hiển thị; tổng = 100 kiểm ở `SaveCampaignRequest`. */
export const campaignTopics = pgTable(
  'campaign_topics',
  {
    campaignId: uuid('campaign_id')
      .notNull()
      .references(() => campaigns.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    name: text('name').notNull(),
    share: integer('share').notNull(),
  },
  (t) => [primaryKey({ columns: [t.campaignId, t.position] }), check('campaign_topics_share_check', sql`${t.share} between 1 and 100`)],
)

/** Trang đích + tần suất đặt riêng (`null` = theo `campaigns.default_frequency`). */
export const campaignPages = pgTable(
  'campaign_pages',
  {
    campaignId: uuid('campaign_id')
      .notNull()
      .references(() => campaigns.id, { onDelete: 'cascade' }),
    pageId: uuid('page_id')
      .notNull()
      .references(() => pagesTable.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    frequency: text('frequency'),
  },
  (t) => [
    primaryKey({ columns: [t.campaignId, t.pageId] }),
    // Tìm chiến dịch theo trang (phạm vi, sự kiện `page.*` — 7.3/7.6).
    index('campaign_pages_page_idx').on(t.pageId),
    check('campaign_pages_frequency_check', sql`${t.frequency} is null or ${t.frequency} in (${inList(CAMPAIGN_FREQUENCIES)})`),
  ],
)
