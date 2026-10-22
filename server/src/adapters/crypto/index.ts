// Mã hoá bí mật khi lưu (AD-12): AES-256-GCM, envelope `v1:<keyId>:<iv>:<ciphertext>:<tag>`
// (iv 12 byte ngẫu nhiên; iv, ciphertext, tag dạng base64url). Nhiều khoá chủ để xoay: mã hoá bằng
// khoá active, giải mã chọn khoá theo `keyId` trong envelope. Không bao giờ đưa bản rõ hay khoá chủ
// vào thông báo lỗi.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

export const ENVELOPE_VERSION = 'v1'
const ALGORITHM = 'aes-256-gcm'
const KEY_BYTES = 32
const IV_BYTES = 12
const TAG_BYTES = 16
/** keyId: chữ, số, `_`, `-` (không có `:` vì `:` ngăn các phần của envelope). */
export const KEY_ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/

export interface EncryptionKeys {
  /** keyId → khoá 32 byte. */
  keys: ReadonlyMap<string, Buffer>
  /** keyId dùng để mã hoá; phải có trong `keys`. */
  activeKeyId: string
}

export interface SecretCipher {
  readonly activeKeyId: string
  encrypt(plain: string): string
  decrypt(envelope: string): string
  /** keyId ghi trong envelope (không giải mã) — để biết bản ghi cần mã hoá lại khi xoay khoá. */
  keyIdOf(envelope: string): string
  /** keyId có trong danh sách khoá chủ không. */
  hasKey(keyId: string): boolean
}

/** Envelope không đúng dạng `v1:<keyId>:<iv>:<ciphertext>:<tag>`. */
export class EnvelopeFormatError extends Error {
  readonly code = 'ENVELOPE_INVALID'
  constructor(reason: string) {
    super(`envelope bí mật không hợp lệ: ${reason}`)
    this.name = 'EnvelopeFormatError'
  }
}

/** keyId trong envelope không còn trong `APP_ENCRYPTION_KEYS`. */
export class EncryptionKeyNotFoundError extends Error {
  readonly code = 'ENCRYPTION_KEY_NOT_FOUND'
  readonly keyId: string
  constructor(keyId: string) {
    super(`khoá mã hoá "${keyId}" không có trong APP_ENCRYPTION_KEYS — thêm lại khoá đó hoặc nhập lại bí mật`)
    this.name = 'EncryptionKeyNotFoundError'
    this.keyId = keyId
  }
}

/** Tag GCM không khớp: dữ liệu bị sửa, hoặc khoá cùng keyId nhưng khác giá trị. */
export class DecryptionFailedError extends Error {
  readonly code = 'DECRYPTION_FAILED'
  readonly keyId: string
  constructor(keyId: string) {
    super(`giải mã bằng khoá "${keyId}" thất bại (dữ liệu bị sửa hoặc khoá sai)`)
    this.name = 'DecryptionFailedError'
    this.keyId = keyId
  }
}

const BASE64URL = /^[A-Za-z0-9_-]+$/

function decodePart(part: string | undefined, name: string, allowEmpty = false): Buffer {
  if (part === undefined || (!allowEmpty && part === '') || (part !== '' && !BASE64URL.test(part))) {
    throw new EnvelopeFormatError(`phần ${name} sai`)
  }
  return Buffer.from(part, 'base64url')
}

interface ParsedEnvelope {
  keyId: string
  iv: Buffer
  ciphertext: Buffer
  tag: Buffer
}

function parseEnvelope(envelope: string): ParsedEnvelope {
  const parts = envelope.split(':')
  if (parts.length !== 5) throw new EnvelopeFormatError('phải có 5 phần')
  const [version, keyId, iv, ciphertext, tag] = parts as [string, string, string, string, string]
  if (version !== ENVELOPE_VERSION) throw new EnvelopeFormatError(`phiên bản "${version.slice(0, 8)}" không hỗ trợ`)
  if (!KEY_ID_PATTERN.test(keyId)) throw new EnvelopeFormatError('keyId sai')
  const parsed = {
    keyId,
    iv: decodePart(iv, 'iv'),
    ciphertext: decodePart(ciphertext, 'ciphertext', true),
    tag: decodePart(tag, 'tag'),
  }
  if (parsed.iv.length !== IV_BYTES) throw new EnvelopeFormatError('iv phải 12 byte')
  if (parsed.tag.length !== TAG_BYTES) throw new EnvelopeFormatError('tag phải 16 byte')
  return parsed
}

export function createSecretCipher({ keys, activeKeyId }: EncryptionKeys): SecretCipher {
  for (const [keyId, key] of keys) {
    if (!KEY_ID_PATTERN.test(keyId)) throw new Error(`keyId "${keyId}" sai dạng`)
    if (key.length !== KEY_BYTES) throw new Error(`khoá "${keyId}" phải đúng ${KEY_BYTES} byte`)
  }
  const activeKey = keys.get(activeKeyId)
  if (!activeKey) throw new EncryptionKeyNotFoundError(activeKeyId)
  // Sao chép để caller sửa Map/Buffer gốc sau này không ảnh hưởng.
  const ring = new Map([...keys].map(([id, key]) => [id, Buffer.from(key)]))

  return {
    activeKeyId,
    encrypt(plain) {
      const iv = randomBytes(IV_BYTES)
      const cipher = createCipheriv(ALGORITHM, ring.get(activeKeyId)!, iv)
      const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
      const tag = cipher.getAuthTag()
      return [ENVELOPE_VERSION, activeKeyId, iv.toString('base64url'), ciphertext.toString('base64url'), tag.toString('base64url')].join(':')
    },
    decrypt(envelope) {
      const { keyId, iv, ciphertext, tag } = parseEnvelope(envelope)
      const key = ring.get(keyId)
      if (!key) throw new EncryptionKeyNotFoundError(keyId)
      const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES })
      decipher.setAuthTag(tag)
      try {
        return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
      } catch {
        throw new DecryptionFailedError(keyId)
      }
    },
    keyIdOf(envelope) {
      return parseEnvelope(envelope).keyId
    },
    hasKey(keyId) {
      return ring.has(keyId)
    },
  }
}
