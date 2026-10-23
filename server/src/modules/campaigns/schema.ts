// Bảng của module `campaigns` (AD-1, AD-15 — Story 7.1): `campaigns`, `campaign_topics`, `campaign_pages`. Chỉ
// `campaigns` ghi; module khác đi qua `campaigns/index.ts`.
// - Story 7.1 lưu cấu hình wizard ở `draft`. `campaign_pages` lúc nháp = đích đã chọn (trang + tần suất đặt riêng);
//   "Bắt đầu chiến dịch" (7.3) chụp lại khi chuyển `running`.
// - `group_id` chỉ là nhãn (AD-15): xoá nhóm thì về `null`, chiến dịch giữ nguyên trang.
// - FK tới `pages` `on delete cascade`: trang chỉ bị xoá cứng khi xoá dữ liệu theo yêu cầu (gỡ trang là soft-delete).
import { CAMPAIGN_DURATIONS, CAMPAIGN_FREQUENCIES, CAMPAIGN_GOALS, CAMPAIGN_MODES, CAMPAIGN_POST_TIMES_MAX, CAMPAIGN_STATUSES } from '@ottm/shared'
import { sql } from 'drizzle-orm'
import { check, date, index, integer, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core'
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
    createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
  },
  (t) => [
    index('campaigns_status_idx').on(t.status),
    check('campaigns_goal_check', sql`${t.goal} in (${inList(CAMPAIGN_GOALS)})`),
    check('campaigns_status_check', sql`${t.status} in (${inList(CAMPAIGN_STATUSES)})`),
    check('campaigns_mode_check', sql`${t.mode} in (${inList(CAMPAIGN_MODES)})`),
    check('campaigns_duration_check', sql`${t.durationDays} in (${inList(CAMPAIGN_DURATIONS)})`),
    check('campaigns_default_frequency_check', sql`${t.defaultFrequency} in (${inList(CAMPAIGN_FREQUENCIES)})`),
    check('campaigns_image_ratio_check', sql`${t.imageRatio} between 0 and 100`),
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
