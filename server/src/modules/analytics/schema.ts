// Bảng của module `analytics` (AD-1, AD-17 — Story 8.1). Chỉ `analytics` ghi; module khác đọc qua `analytics/index.ts`.
// - `post_metrics`: snapshot số liệu bài, khoá `(post_target_id, metric_date)` — giá trị là tổng TRỌN ĐỜI của bài tại lúc
//   thu; chạy lại trong cùng ngày VN ghi đè (không nhân đôi), sang ngày mới thêm dòng.
// - `page_daily_metrics`: số liệu trang THEO NGÀY, khoá `(page_id, date)`; lượt sau ghi đè ngày Meta chốt muộn.
// - `metric_sync_states`: kết quả lượt thu gần nhất theo (trang, loại) — "ghi rõ" thiếu quyền / bị từ chối cho Story 8.2.
// Chỉ số chuẩn (`packages/shared/metrics.ts`): `null` = nền tảng không cung cấp, khác 0. `raw` giữ metric gốc (chỉ số,
// không nội dung) để đổi ánh xạ không phải kéo lại.
// FK `on delete cascade`: trang / target chỉ bị xoá cứng khi xoá dữ liệu theo yêu cầu.
import { METRIC_SYNC_KINDS, METRIC_SYNC_STATUSES } from '@ottm/shared'
import { sql } from 'drizzle-orm'
import { bigint, check, date, index, jsonb, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { postTargetsTable } from '../content/index.ts'
import { pagesTable } from '../pages/index.ts'

const inList = (xs: readonly string[]) => sql.raw(xs.map((s) => `'${s}'`).join(', '))
const count = (name: string) => bigint(name, { mode: 'number' })
const ts = (name: string) => timestamp(name, { withTimezone: true, precision: 3 })

export const postMetrics = pgTable(
  'post_metrics',
  {
    postTargetId: uuid('post_target_id')
      .notNull()
      .references(() => postTargetsTable.id, { onDelete: 'cascade' }),
    pageId: uuid('page_id')
      .notNull()
      .references(() => pagesTable.id, { onDelete: 'cascade' }),
    /** Ngày VN lúc thu (`YYYY-MM-DD`). */
    metricDate: date('metric_date', { mode: 'string' }).notNull(),
    views: count('views'),
    reach: count('reach'),
    engagement: count('engagement'),
    raw: jsonb('raw').notNull().default(sql`'{}'::jsonb`),
    fetchedAt: ts('fetched_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.postTargetId, t.metricDate] }),
    index('post_metrics_page_date_idx').on(t.pageId, t.metricDate),
    check('post_metrics_non_negative_check', sql`${t.views} >= 0 and ${t.reach} >= 0 and ${t.engagement} >= 0`),
  ],
)

export const pageDailyMetrics = pgTable(
  'page_daily_metrics',
  {
    pageId: uuid('page_id')
      .notNull()
      .references(() => pagesTable.id, { onDelete: 'cascade' }),
    /** Ngày của số liệu (FB: ngày Meta báo; IG / Threads: ngày VN). */
    date: date('date', { mode: 'string' }).notNull(),
    views: count('views'),
    reach: count('reach'),
    engagement: count('engagement'),
    /** Theo dõi mới − bỏ theo dõi trong ngày; âm được. */
    followersDelta: count('followers_delta'),
    raw: jsonb('raw').notNull().default(sql`'{}'::jsonb`),
    fetchedAt: ts('fetched_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.pageId, t.date] }),
    check('page_daily_metrics_non_negative_check', sql`${t.views} >= 0 and ${t.reach} >= 0 and ${t.engagement} >= 0`),
  ],
)

export const metricSyncStates = pgTable(
  'metric_sync_states',
  {
    pageId: uuid('page_id')
      .notNull()
      .references(() => pagesTable.id, { onDelete: 'cascade' }),
    /** `MetricSyncKind`: `posts` | `page`. */
    kind: text('kind').notNull(),
    /** `MetricSyncStatus`. */
    status: text('status').notNull(),
    /** Quyền insight còn thiếu — có đúng khi `permissions_missing`. */
    missingScopes: text('missing_scopes').array().notNull().default(sql`'{}'::text[]`),
    attemptedAt: ts('attempted_at').notNull(),
    /** Lần chạy hết gần nhất (`ok`); giữ nguyên khi lượt sau lỗi. */
    succeededAt: ts('succeeded_at'),
  },
  (t) => [
    primaryKey({ columns: [t.pageId, t.kind] }),
    check('metric_sync_states_kind_check', sql`${t.kind} in (${inList(METRIC_SYNC_KINDS)})`),
    check('metric_sync_states_status_check', sql`${t.status} in (${inList(METRIC_SYNC_STATUSES)})`),
    check('metric_sync_states_missing_check', sql`(${t.status} = 'permissions_missing') = (cardinality(${t.missingScopes}) > 0)`),
  ],
)
