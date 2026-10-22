// Kết nối OpenAI phía module nền `settings` (Story 1.5): lưu khoá đã mã hoá ở `secrets` và lựa chọn
// (model, kích thước ảnh, tỉ giá, hạn mức) ở `settings` khoá `openai`. Module `ai` kiểm khoá với OpenAI,
// mã hoá, kiểm model theo `ai_model_prices` rồi mới gọi các hàm ghi ở đây (AD-1: `ai` → `settings`).
// Mọi lần ghi phát `settings.updated` trong cùng transaction (AD-3). Không log giá trị bí mật (AD-12).
import {
  DEFAULT_EXCHANGE_RATE_VND,
  DEFAULT_IMAGE_SIZE,
  DEFAULT_MONTHLY_LIMIT_VND,
  DEFAULT_WARN_80,
  OpenAiPreferenceFields,
  type ImageSize,
} from '@ottm/shared'
import { and, eq, sql } from 'drizzle-orm'
import type { Db, DbExecutor, Tx } from '../../platform/db/index.ts'
import type { EventPublisher } from '../../platform/events/index.ts'
import { secrets, settings, type SecretStatus } from './schema.ts'

export const OPENAI_API_KEY_SECRET = 'openai_api_key'
export const OPENAI_SETTINGS_KEY = 'openai'

/** Thông tin bí mật không kèm giá trị — đủ để trả client trạng thái khoá. */
export interface SecretMeta {
  kind: string
  status: SecretStatus | null
  last4: string | null
  checkedAt: Date | null
}

export async function getSecretMeta(db: DbExecutor, name: string): Promise<SecretMeta | null> {
  const [row] = await db
    .select({ kind: secrets.kind, status: secrets.status, last4: secrets.last4, checkedAt: secrets.checkedAt })
    .from(secrets)
    .where(eq(secrets.name, name))
  if (!row) return null
  return { ...row, status: row.status === 'valid' || row.status === 'invalid' ? row.status : null }
}

/** Giá trị đã lưu (envelope) — chỉ module sở hữu nghiệp vụ của bí mật đó giải mã. */
export async function getSecretValue(db: DbExecutor, name: string): Promise<{ kind: string; value: string } | null> {
  const [row] = await db.select({ kind: secrets.kind, value: secrets.value }).from(secrets).where(eq(secrets.name, name))
  return row ?? null
}

export interface CheckedSecret {
  name: string
  kind: string
  /** Giá trị đã mã hoá (envelope). Không bao giờ truyền bản rõ vào đây. */
  value: string
  status: SecretStatus
  last4: string
  checkedAt: Date
}

/** Ghi (thay) một bí mật đã kiểm + phát `settings.updated` trong cùng transaction. */
export async function putCheckedSecret(db: Db, events: EventPublisher, secret: CheckedSecret): Promise<SecretMeta> {
  const { name, kind, value, status, last4, checkedAt } = secret
  const set = { kind, value, status, last4, checkedAt, updatedAt: sql`now()` }
  const row = await db.transaction(async (tx) => {
    const [saved] = await tx
      .insert(secrets)
      .values({ name, kind, value, status, last4, checkedAt })
      .onConflictDoUpdate({ target: secrets.name, set })
      .returning({ kind: secrets.kind, last4: secrets.last4, checkedAt: secrets.checkedAt })
    await events.publishEvent(tx, 'settings.updated', { id: name, keys: [name] })
    return saved!
  })
  return { ...row, status }
}

/**
 * Đổi trạng thái kiểm của bí mật (vd kiểm lại khoá) + phát `settings.updated`. Chỉ đổi khi giá trị vẫn
 * là `expectedValue` (không ghi đè khoá mới được lưu giữa chừng); trả `null` nếu không đổi gì.
 * `onlyIfStatus`: chỉ đổi khi trạng thái hiện tại đúng giá trị này (vd chỉ lật `valid → invalid` một lần).
 * `afterUpdate`: chạy trong cùng transaction khi có thay đổi (vd module `ai` phát `openai_key.invalidated`).
 */
export async function updateSecretStatus(
  db: Db,
  events: EventPublisher,
  input: {
    name: string
    expectedValue: string
    status: SecretStatus
    checkedAt: Date
    onlyIfStatus?: SecretStatus
    afterUpdate?: (tx: Tx) => Promise<void>
  },
): Promise<SecretMeta | null> {
  const { name, expectedValue, status, checkedAt, onlyIfStatus, afterUpdate } = input
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(secrets)
      .set({ status, checkedAt, updatedAt: sql`now()` })
      .where(
        and(
          eq(secrets.name, name),
          eq(secrets.value, expectedValue),
          onlyIfStatus !== undefined ? eq(secrets.status, onlyIfStatus) : undefined,
        ),
      )
      .returning({ kind: secrets.kind, last4: secrets.last4, checkedAt: secrets.checkedAt })
    if (!row) return null
    await events.publishEvent(tx, 'settings.updated', { id: name, keys: [name] })
    if (afterUpdate) await afterUpdate(tx)
    return { ...row, status }
  })
}

/** Xoá bí mật + phát `settings.updated` (chỉ khi có dòng bị xoá). Trả true nếu đã xoá. */
export async function deleteSecret(db: Db, events: EventPublisher, name: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const deleted = await tx.delete(secrets).where(eq(secrets.name, name)).returning({ name: secrets.name })
    if (deleted.length === 0) return false
    await events.publishEvent(tx, 'settings.updated', { id: name, keys: [name] })
    return true
  })
}

/** Lựa chọn OpenAI đã lưu. Model `null` = chưa chọn → module `ai` dùng model mặc định của bảng giá. */
export interface OpenAiPrefs {
  textModel: string | null
  imageModel: string | null
  imageSize: ImageSize
  exchangeRateVnd: number
  monthlyLimitVnd: number
  warn80: boolean
}

export const DEFAULT_OPENAI_PREFS: OpenAiPrefs = {
  textModel: null,
  imageModel: null,
  imageSize: DEFAULT_IMAGE_SIZE,
  exchangeRateVnd: DEFAULT_EXCHANGE_RATE_VND,
  monthlyLimitVnd: DEFAULT_MONTHLY_LIMIT_VND,
  warn80: DEFAULT_WARN_80,
}

const FIELDS = OpenAiPreferenceFields.shape
/** Giá trị lưu: như request đầy đủ, model được phép `null` (= dùng model mặc định). */
const StoredPrefs = OpenAiPreferenceFields.extend({
  textModel: FIELDS.textModel.nullable(),
  imageModel: FIELDS.imageModel.nullable(),
})

/** Đọc lựa chọn; chưa lưu → mặc định; từng khoá thiếu hay hỏng → mặc định của khoá đó. */
export async function getOpenAiPrefs(db: DbExecutor): Promise<OpenAiPrefs> {
  const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, OPENAI_SETTINGS_KEY))
  const stored = row && typeof row.value === 'object' && row.value !== null ? (row.value as Record<string, unknown>) : {}
  const pick = <K extends keyof OpenAiPrefs>(key: K, schema: { safeParse(v: unknown): { success: boolean; data?: unknown } }) => {
    const parsed = schema.safeParse(stored[key])
    return (parsed.success ? parsed.data : DEFAULT_OPENAI_PREFS[key]) as OpenAiPrefs[K]
  }
  return {
    textModel: pick('textModel', FIELDS.textModel),
    imageModel: pick('imageModel', FIELDS.imageModel),
    imageSize: pick('imageSize', FIELDS.imageSize),
    exchangeRateVnd: pick('exchangeRateVnd', FIELDS.exchangeRateVnd),
    monthlyLimitVnd: pick('monthlyLimitVnd', FIELDS.monthlyLimitVnd),
    warn80: pick('warn80', FIELDS.warn80),
  }
}

/**
 * Lưu lựa chọn đầy đủ (caller đã gộp với giá trị đang lưu) + phát `settings.updated`. Caller (module
 * `ai`) đã kiểm model có trong `ai_model_prices` đúng loại.
 */
export async function setOpenAiPrefs(db: Db, events: EventPublisher, prefs: OpenAiPrefs): Promise<OpenAiPrefs> {
  const value: OpenAiPrefs = StoredPrefs.parse(prefs)
  await db.transaction(async (tx) => {
    await tx
      .insert(settings)
      .values({ key: OPENAI_SETTINGS_KEY, value })
      .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: sql`now()` } })
    await events.publishEvent(tx, 'settings.updated', { id: OPENAI_SETTINGS_KEY, keys: [OPENAI_SETTINGS_KEY] })
  })
  return value
}
