// Khoá OpenAI (Story 1.5, AD-12): kiểm với OpenAI → mã hoá AES-256-GCM → lưu qua module `settings`.
// Khoá sai hay OpenAI lỗi → không thay khoá cũ. Không bao giờ trả, log, hay đưa khoá vào lỗi/sự kiện.
// Trạng thái trả client được đối chiếu với khoá chủ hiện tại: khoá đã lưu không giải mã được nữa
// (keyId bị bỏ khỏi `APP_ENCRYPTION_KEYS`, dữ liệu hỏng, khoá dev sinh lại) → `invalid` + `reentry_required`.
import { OpenAiApiKey, type OpenAiKeyInfo } from '@ottm/shared'
import {
  DecryptionFailedError,
  EncryptionKeyNotFoundError,
  EnvelopeFormatError,
  type SecretCipher,
} from '../../adapters/crypto/index.ts'
import { createOpenAiAdapter, type OpenAiAdapter, type OpenAiErrorKind } from '../../adapters/openai/index.ts'
import type { Db, DbExecutor } from '../../platform/db/index.ts'
import { AppError } from '../../platform/errors/index.ts'
import type { EventPublisher } from '../../platform/events/index.ts'
import type { Logger } from '../../platform/log/index.ts'
import {
  OPENAI_API_KEY_SECRET,
  deleteSecret,
  getSecretMeta,
  getSecretValue,
  putCheckedSecret,
  updateSecretStatus,
  type SecretMeta,
} from '../settings/index.ts'

export const OPENAI_KEY_KIND = 'envelope'

export interface AiDeps {
  db: Db
  events: EventPublisher
  /** `null` khi chưa cấu hình `APP_ENCRYPTION_KEYS` (chỉ có thể xảy ra ngoài production). */
  cipher: SecretCipher | null
  /** Mặc định adapter thật (`api.openai.com`); test truyền fake. */
  openai?: OpenAiAdapter
  /** Log của gateway (AD-12: chỉ id, feature, model, số token, chi phí — không prompt, nội dung, khoá). */
  log?: Logger
  /** Đồng hồ (test giả lập sang tháng mới); mặc định `new Date()`. */
  now?: () => Date
}

let defaultAdapter: OpenAiAdapter | undefined
export function adapterOf(deps: Pick<AiDeps, 'openai'>): OpenAiAdapter {
  if (deps.openai) return deps.openai
  defaultAdapter ??= createOpenAiAdapter()
  return defaultAdapter
}

export function encryptionNotConfigured(): AppError {
  return new AppError('ENCRYPTION_NOT_CONFIGURED', 500, {
    message: 'APP_ENCRYPTION_KEYS / APP_ENCRYPTION_ACTIVE_KEY chưa đặt — đặt hai biến này, hoặc chạy bằng `npm run dev` ở gốc (tự sinh khoá dev)',
  })
}

const MISSING: OpenAiKeyInfo = { configured: false, last4: null, status: 'missing', checkedAt: null, reason: null }

function toKeyInfo(meta: SecretMeta | null): OpenAiKeyInfo {
  if (!meta || meta.kind !== OPENAI_KEY_KIND) return MISSING
  return {
    configured: true,
    last4: meta.last4,
    // Bản ghi không có status (không xảy ra với dữ liệu do story này ghi) → coi như chưa kiểm được.
    status: meta.status ?? 'invalid',
    checkedAt: meta.checkedAt?.toISOString() ?? null,
    reason: null,
  }
}

type Decrypted = { ok: true; apiKey: string } | { ok: false; detail: string }

/** Giải mã envelope; lỗi do khoá chủ / dữ liệu → `{ok:false}` (detail nêu keyId, không có khoá). */
function decryptStored(cipher: SecretCipher | null, envelope: string): Decrypted {
  if (!cipher) return { ok: false, detail: 'APP_ENCRYPTION_KEYS chưa đặt' }
  try {
    const keyId = cipher.keyIdOf(envelope)
    if (!cipher.hasKey(keyId)) return { ok: false, detail: `khoá mã hoá "${keyId}" không có trong APP_ENCRYPTION_KEYS` }
    return { ok: true, apiKey: cipher.decrypt(envelope) }
  } catch (err) {
    if (err instanceof EncryptionKeyNotFoundError || err instanceof DecryptionFailedError || err instanceof EnvelopeFormatError) {
      return { ok: false, detail: err.message }
    }
    throw err
  }
}

interface StoredKey {
  info: OpenAiKeyInfo
  envelope: string
}

async function readStoredKey(db: DbExecutor): Promise<StoredKey | null> {
  const meta = await getSecretMeta(db, OPENAI_API_KEY_SECRET)
  const info = toKeyInfo(meta)
  if (!info.configured) return null
  const row = await getSecretValue(db, OPENAI_API_KEY_SECRET)
  if (!row) return null // bị xoá giữa hai lần đọc
  return { info, envelope: row.value }
}

const reentry = (info: OpenAiKeyInfo): OpenAiKeyInfo => ({ ...info, status: 'invalid', reason: 'reentry_required' })

/** Trạng thái khoá cho client; khoá đã lưu mà không giải mã được bằng khoá chủ hiện tại → cần nhập lại. */
export async function getOpenAiKeyStatus(deps: Pick<AiDeps, 'db' | 'cipher'>): Promise<OpenAiKeyInfo> {
  const stored = await readStoredKey(deps.db)
  if (!stored) return MISSING
  return decryptStored(deps.cipher, stored.envelope).ok ? stored.info : reentry(stored.info)
}

/** Lỗi kiểm khoá → lỗi API. 401 = khoá sai; 403 = khoá bị giới hạn; còn lại là phía OpenAI. */
function checkFailure(kind: OpenAiErrorKind, status: number | undefined): AppError {
  if (kind === 'KEY_INVALID') return new AppError('OPENAI_KEY_INVALID', 400)
  if (kind === 'KEY_RESTRICTED') return new AppError('OPENAI_KEY_RESTRICTED', 400)
  return new AppError('AI_PROVIDER_ERROR', 502, { details: { kind, ...(status !== undefined ? { status } : {}) } })
}

/**
 * Kiểm khoá với OpenAI (`GET /v1/models`, 10 giây), thành công mới mã hoá và lưu (thay khoá cũ),
 * phát `settings.updated`. Sai dạng → `VALIDATION_FAILED` (không gọi OpenAI); 401 → `OPENAI_KEY_INVALID`;
 * 403 → `OPENAI_KEY_RESTRICTED`; mạng / hết giờ / 429 / 5xx → `AI_PROVIDER_ERROR` (502).
 */
export async function setOpenAiKey(deps: AiDeps, input: unknown): Promise<OpenAiKeyInfo> {
  const parsed = OpenAiApiKey.safeParse(input)
  // Không đưa issue của zod vào lỗi: tránh mọi khả năng chép lại giá trị khoá.
  if (!parsed.success) throw new AppError('VALIDATION_FAILED', 400, { details: [{ path: ['apiKey'], message: 'khoá sai dạng' }] })
  const apiKey = parsed.data
  if (!deps.cipher) throw encryptionNotConfigured()

  const result = await adapterOf(deps).checkKey(apiKey)
  if (!result.ok) throw checkFailure(result.kind, result.status)

  const meta = await putCheckedSecret(deps.db, deps.events, {
    name: OPENAI_API_KEY_SECRET,
    kind: OPENAI_KEY_KIND,
    value: deps.cipher.encrypt(apiKey),
    status: 'valid',
    last4: apiKey.slice(-4),
    checkedAt: new Date(),
  })
  return toKeyInfo(meta)
}

/** Gỡ khoá (lộ khoá, muốn dừng chi phí): xoá bản ghi, phát `settings.updated`. Chưa có khoá → vẫn ok. */
export async function deleteOpenAiKey(deps: Pick<AiDeps, 'db' | 'events'>): Promise<OpenAiKeyInfo> {
  await deleteSecret(deps.db, deps.events, OPENAI_API_KEY_SECRET)
  return MISSING
}

/**
 * Kiểm lại khoá đã lưu với OpenAI, cập nhật `status`/`checkedAt` (phát `settings.updated`).
 * 200 → `valid`; 401 → `invalid`. Khoá không giải mã được → trả `reentry_required`, không gọi OpenAI.
 * 403 → `OPENAI_KEY_RESTRICTED`, lỗi phía OpenAI → `AI_PROVIDER_ERROR`; hai trường hợp này không đổi trạng thái.
 */
export async function recheckOpenAiKey(deps: AiDeps): Promise<OpenAiKeyInfo> {
  const stored = await readStoredKey(deps.db)
  if (!stored) throw new AppError('OPENAI_KEY_MISSING', 400)
  if (!deps.cipher) throw encryptionNotConfigured()
  const decrypted = decryptStored(deps.cipher, stored.envelope)
  if (!decrypted.ok) return reentry(stored.info)

  const result = await adapterOf(deps).checkKey(decrypted.apiKey)
  if (!result.ok && result.kind !== 'KEY_INVALID') throw checkFailure(result.kind, result.status)
  await updateSecretStatus(deps.db, deps.events, {
    name: OPENAI_API_KEY_SECRET,
    expectedValue: stored.envelope,
    status: result.ok ? 'valid' : 'invalid',
    checkedAt: new Date(),
  })
  // Khoá bị thay giữa chừng → updateSecretStatus không đổi gì; trả trạng thái hiện tại.
  return getOpenAiKeyStatus(deps)
}

/** Khoá bản rõ + envelope đang lưu (để lật trạng thái đúng khoá đã dùng khi OpenAI trả 401). */
export interface UsableOpenAiKey {
  apiKey: string
  envelope: string
}

/**
 * Khoá OpenAI dùng được cho AI gateway (Story 1.6). Chưa có khoá → `OPENAI_KEY_MISSING`; khoá đã bị
 * OpenAI từ chối → `OPENAI_KEY_INVALID`; chưa có khoá chủ → `ENCRYPTION_NOT_CONFIGURED`. Không giải mã
 * được (keyId không còn trong `APP_ENCRYPTION_KEYS`, dữ liệu hỏng) → `OPENAI_KEY_INVALID` với
 * `details.reason = 'reentry_required'`, message nêu keyId; trạng thái đã lưu không đổi. Story 7.6: nhận cả transaction
 * (tiếp tục chiến dịch kiểm khoá dưới khoá dòng chiến dịch).
 */
export async function getUsableOpenAiKey(deps: { db: DbExecutor; cipher: AiDeps['cipher'] }): Promise<UsableOpenAiKey> {
  const stored = await readStoredKey(deps.db)
  if (!stored) throw new AppError('OPENAI_KEY_MISSING', 400)
  if (stored.info.status !== 'valid') throw new AppError('OPENAI_KEY_INVALID', 400)
  if (!deps.cipher) throw encryptionNotConfigured()
  const decrypted = decryptStored(deps.cipher, stored.envelope)
  if (!decrypted.ok) {
    throw new AppError('OPENAI_KEY_INVALID', 400, { message: decrypted.detail, details: { reason: 'reentry_required' } })
  }
  return { apiKey: decrypted.apiKey, envelope: stored.envelope }
}

/** Khoá OpenAI bản rõ (xem `getUsableOpenAiKey`). */
export async function getOpenAiKey(deps: Pick<AiDeps, 'db' | 'cipher'>): Promise<string> {
  return (await getUsableOpenAiKey(deps)).apiKey
}

/**
 * OpenAI trả 401 lúc chạy (khoá bị thu hồi): `secrets.status = invalid`, phát `settings.updated` +
 * `openai_key.invalidated` trong một transaction. Chỉ lật khi khoá vẫn là khoá đã dùng và đang `valid`
 * (nhiều lời gọi song song cùng gặp 401 → một lần lật, một sự kiện). Trả true nếu đã lật.
 */
export async function invalidateOpenAiKey(deps: Pick<AiDeps, 'db' | 'events'>, envelope: string): Promise<boolean> {
  const updated = await updateSecretStatus(deps.db, deps.events, {
    name: OPENAI_API_KEY_SECRET,
    expectedValue: envelope,
    status: 'invalid',
    checkedAt: new Date(),
    onlyIfStatus: 'valid',
    afterUpdate: (tx) => deps.events.publishEvent(tx, 'openai_key.invalidated', { id: OPENAI_API_KEY_SECRET }),
  })
  return updated !== null
}
