// Bảng của module `connections` (AD-1). Story 2.1: `meta_rate_state` — trạng thái ngân sách tần suất Meta (AD-6).
// Story 2.2: `oauth_states`, `oauth_results`, `meta_accounts`, `page_credentials`.
// Story 4.2: kết quả đăng ký webhook trang (`webhook_subscribed_at`, `webhook_subscribe_error`) trên `page_credentials`.
import { CONNECT_FROM, OAUTH_PROVIDERS, WEBHOOK_SUBSCRIBE_ERRORS } from '@ottm/shared'
import { sql } from 'drizzle-orm'
import { bigint, boolean, check, index, jsonb, pgTable, primaryKey, real, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { pagesTable } from '../pages/index.ts'

const RETURN_TO_LIST = sql.raw(CONNECT_FROM.map((r) => `'${r}'`).join(', '))
const PROVIDER_LIST = sql.raw(OAUTH_PROVIDERS.map((p) => `'${p}'`).join(', '))
const SUBSCRIBE_ERROR_LIST = sql.raw(WEBHOOK_SUBSCRIBE_ERRORS.map((e) => `'${e}'`).join(', '))

/**
 * Một dòng cho mỗi (phạm vi, bucket): `scope` = `app` hoặc phạm vi của lời gọi (vd `page:<id>`);
 * `bucket` = `app` (X-App-Usage), `buc:<objectId>` (X-Business-Use-Case-Usage) hoặc `blocked` (lỗi RATE_LIMITED).
 * `usage_pct` = max của call_count / total_cputime / total_time; `blocked_until` khác NULL khi Meta đang chặn.
 */
export const metaRateState = pgTable(
  'meta_rate_state',
  {
    scope: text('scope').notNull(),
    bucket: text('bucket').notNull(),
    usagePct: real('usage_pct').notNull().default(0),
    blockedUntil: timestamp('blocked_until', { withTimezone: true, precision: 3 }),
    updatedAt: timestamp('updated_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.scope, t.bucket] }),
    check('meta_rate_state_usage_pct_check', sql`${t.usagePct} >= 0`),
  ],
)

// ---------------------------------------------------------------------------------------------------------
// Story 2.2 — OAuth Facebook Login for Business, token Page (AD-5, AD-23).
// Mọi token lưu dạng envelope `v1:<keyId>:…` của `adapters/crypto` (AD-12); không cột nào chứa token rõ.
// ---------------------------------------------------------------------------------------------------------

/**
 * `state` OAuth đang chờ callback (TTL 15 phút, dùng một lần). Callback chỉ nhận khi cookie phiên của trình
 * duyệt ứng với `session_id` này. `provider`: `facebook` (Story 2.2) | `threads` (Story 2.3). `intent`: `connect` (Story 2.2) | `reconnect:<pageId>` (Story 2.4).
 * `return_to`: màn đưa chủ shop về (`pages` → `/trang-nhom`, `welcome` → `/bat-dau`).
 */
export const oauthStates = pgTable(
  'oauth_states',
  {
    state: text('state').primaryKey(),
    provider: text('provider').notNull(),
    sessionId: uuid('session_id').notNull(),
    intent: text('intent').notNull(),
    returnTo: text('return_to').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true, precision: 3 }).notNull(),
  },
  (t) => [
    check('oauth_states_provider_check', sql`${t.provider} in (${PROVIDER_LIST})`),
    check('oauth_states_return_to_check', sql`${t.returnTo} in (${RETURN_TO_LIST})`),
    index('oauth_states_expires_at_idx').on(t.expiresAt),
  ],
)

/**
 * Kết quả callback chờ chủ shop chọn trang (TTL 15 phút, xoá khi xác nhận). `candidates` là danh sách ứng
 * viên nội bộ: Fanpage kèm envelope token Page (`tokenEnvelope`) — không bao giờ trả ra API. FE chỉ biết
 * `id` (qua URL) và đọc bản đã lọc token.
 */
export const oauthResults = pgTable(
  'oauth_results',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    provider: text('provider').notNull(),
    sessionId: uuid('session_id').notNull(),
    returnTo: text('return_to').notNull(),
    status: text('status').notNull(),
    errorCode: text('error_code'),
    metaAccountId: uuid('meta_account_id').references(() => metaAccounts.id, { onDelete: 'set null' }),
    candidates: jsonb('candidates').notNull().default(sql`'[]'::jsonb`),
    /** Tài khoản có hơn `OAUTH_MAX_PAGES` Fanpage → chỉ giữ phần đầu. */
    truncated: boolean('truncated').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true, precision: 3 }).notNull(),
  },
  (t) => [
    check('oauth_results_status_check', sql`${t.status} in ('ok', 'error')`),
    check('oauth_results_provider_check', sql`${t.provider} in (${PROVIDER_LIST})`),
    index('oauth_results_expires_at_idx').on(t.expiresAt),
  ],
)

/**
 * Tài khoản Facebook đã cấp quyền (theo FB user id): user token dài hạn (`fb_exchange_token`, ~60 ngày)
 * dạng envelope, mốc hết hạn kiểu Meta (giây epoch; 0 = không hết hạn) và `granular_scopes` của `debug_token`.
 */
export const metaAccounts = pgTable('meta_accounts', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  fbUserId: text('fb_user_id').notNull().unique(),
  name: text('name'),
  userToken: text('user_token').notNull(),
  expiresAt: bigint('expires_at', { mode: 'number' }).notNull().default(0),
  dataAccessExpiresAt: bigint('data_access_expires_at', { mode: 'number' }),
  granularScopes: jsonb('granular_scopes').notNull().default(sql`'[]'::jsonb`),
  createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
})

/**
 * Token của từng trang (AD-5 — chỉ `connections` giữ token). Fanpage: `access_token` = envelope token Page;
 * Threads: envelope token dài hạn (~60 ngày, `expires_at` = lúc đổi + `expires_in`), không có `meta_account_id`.
 * Trang IG không có token riêng: `token_source_page_id` trỏ tới Fanpage nguồn (đúng một trong hai cột có giá trị).
 * `expires_at` kiểu Meta (giây epoch, 0 = không hết hạn — thường gặp với Page token), `data_access_expires_at`
 * (90 ngày) và `granular_scopes` = các quyền đã cấp cho riêng trang này (đọc từ `debug_token`).
 * Story 4.2: job `connections.subscribe_page` ghi `webhook_subscribed_at` khi đăng ký webhook thành công (xoá lỗi
 * cũ) hoặc `webhook_subscribe_error` (mã chẩn đoán `WebhookSubscribeError`) khi lỗi. Cả hai `null` = chưa đăng ký
 * lần nào → worker chạy bù khi khởi động. Story 4.5: `webhook_subscribed_fields` = chuỗi field đã đăng ký; app thêm field
 * (vd "đã nhận / đã xem") → chạy bù đăng ký lại. Ghi các cột này KHÔNG đụng `updated_at` (tuổi token Threads).
 */
export const pageCredentials = pgTable(
  'page_credentials',
  {
    // Xoá cứng trang (chỉ luồng quyền riêng tư) xoá luôn token của nó.
    pageId: uuid('page_id')
      .primaryKey()
      .references(() => pagesTable.id, { onDelete: 'cascade' }),
    metaAccountId: uuid('meta_account_id').references(() => metaAccounts.id, { onDelete: 'set null' }),
    accessToken: text('access_token'),
    // Không xoá cứng Fanpage khi IG còn trỏ token về nó.
    tokenSourcePageId: uuid('token_source_page_id').references(() => pagesTable.id, { onDelete: 'restrict' }),
    expiresAt: bigint('expires_at', { mode: 'number' }).notNull().default(0),
    dataAccessExpiresAt: bigint('data_access_expires_at', { mode: 'number' }),
    granularScopes: jsonb('granular_scopes').notNull().default(sql`'[]'::jsonb`),
    webhookSubscribedAt: timestamp('webhook_subscribed_at', { withTimezone: true, precision: 3 }),
    webhookSubscribeError: text('webhook_subscribe_error'),
    /** Chuỗi field của lần đăng ký thành công gần nhất (Story 4.5) — khác chuỗi hiện tại → worker đăng ký lại. */
    webhookSubscribedFields: text('webhook_subscribed_fields'),
    createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
  },
  (t) => [
    check('page_credentials_webhook_subscribe_error_check', sql`${t.webhookSubscribeError} in (${SUBSCRIBE_ERROR_LIST})`),
    check('page_credentials_token_source_check', sql`(${t.accessToken} is null) <> (${t.tokenSourcePageId} is null)`),
    index('page_credentials_token_source_idx').on(t.tokenSourcePageId),
  ],
)
