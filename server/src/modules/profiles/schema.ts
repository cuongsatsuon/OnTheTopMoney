// Bảng của module `profiles` (AD-1, Story 3.1): `brand_profiles`.
// Một hồ sơ cho mỗi chủ `(owner_type, owner_id)` — group hoặc page (UNIQUE). Không FK đa hình: owner tồn tại
// được kiểm ở service (gọi `pages.getGroup` / `pages.getPage`). Logo công khai nằm trên Cloudinary → `logo_path`
// là URL (KHÔNG vào `media_assets` — đó là ảnh bài).
import { BRAND_EMOJI_LEVELS, CONFIG_OWNER_TYPES } from '@ottm/shared'
import { sql } from 'drizzle-orm'
import { check, integer, jsonb, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core'

const OWNER_TYPE_LIST = sql.raw(CONFIG_OWNER_TYPES.map((s) => `'${s}'`).join(', '))
const EMOJI_LIST = sql.raw(BRAND_EMOJI_LEVELS.map((s) => `'${s}'`).join(', '))

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
