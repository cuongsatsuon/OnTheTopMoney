// adapters/crypto — AES-256-GCM, envelope `v1:<keyId>:<iv>:<ciphertext>:<tag>`, nhiều khoá (AD-12).
import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  DecryptionFailedError,
  EncryptionKeyNotFoundError,
  EnvelopeFormatError,
  createSecretCipher,
} from '../src/adapters/crypto/index.ts'

const k1 = randomBytes(32)
const k2 = randomBytes(32)
const SECRET = 'sk-proj-THU_NGHIEM_khong-that-1234'

describe('adapters/crypto', () => {
  it('mã hoá rồi giải mã ra đúng bản rõ; envelope đúng dạng, không chứa bản rõ', () => {
    const cipher = createSecretCipher({ keys: new Map([['k1', k1]]), activeKeyId: 'k1' })
    const envelope = cipher.encrypt(SECRET)
    expect(envelope).toMatch(/^v1:k1:[A-Za-z0-9_-]{16}:[A-Za-z0-9_-]+:[A-Za-z0-9_-]{22}$/)
    expect(envelope).not.toContain(SECRET)
    expect(envelope).not.toContain('1234')
    expect(cipher.decrypt(envelope)).toBe(SECRET)
    expect(cipher.keyIdOf(envelope)).toBe('k1')
    expect(cipher.decrypt(cipher.encrypt(''))).toBe('')
    expect(cipher.decrypt(cipher.encrypt('Tiếng Việt có dấu ✓'))).toBe('Tiếng Việt có dấu ✓')
  })

  it('iv 12 byte ngẫu nhiên: hai lần mã hoá cùng bản rõ ra hai envelope khác nhau', () => {
    const cipher = createSecretCipher({ keys: new Map([['k1', k1]]), activeKeyId: 'k1' })
    const a = cipher.encrypt(SECRET)
    const b = cipher.encrypt(SECRET)
    expect(a).not.toBe(b)
    expect(Buffer.from(a.split(':')[2]!, 'base64url')).toHaveLength(12)
  })

  it('nhiều khoá: mã hoá bằng khoá active, giải mã chọn khoá theo keyId', () => {
    const old = createSecretCipher({ keys: new Map([['k1', k1]]), activeKeyId: 'k1' })
    const oldEnvelope = old.encrypt(SECRET)
    const rotated = createSecretCipher({ keys: new Map([['k1', k1], ['k2', k2]]), activeKeyId: 'k2' })
    expect(rotated.decrypt(oldEnvelope)).toBe(SECRET)
    const fresh = rotated.encrypt(SECRET)
    expect(rotated.keyIdOf(fresh)).toBe('k2')
    expect(rotated.decrypt(fresh)).toBe(SECRET)
  })

  it('keyId không còn trong danh sách → lỗi nêu rõ keyId', () => {
    const old = createSecretCipher({ keys: new Map([['k1', k1]]), activeKeyId: 'k1' })
    const envelope = old.encrypt(SECRET)
    const only2 = createSecretCipher({ keys: new Map([['k2', k2]]), activeKeyId: 'k2' })
    expect(() => only2.decrypt(envelope)).toThrow(EncryptionKeyNotFoundError)
    expect(() => only2.decrypt(envelope)).toThrow(/"k1"/)
  })

  it('dữ liệu bị sửa hoặc khoá cùng tên khác giá trị → DecryptionFailedError (không lộ bản rõ)', () => {
    const cipher = createSecretCipher({ keys: new Map([['k1', k1]]), activeKeyId: 'k1' })
    const envelope = cipher.encrypt(SECRET)
    const [v, id, iv, ct, tag] = envelope.split(':') as [string, string, string, string, string]
    const flipped = Buffer.from(ct, 'base64url')
    flipped[0] = flipped[0]! ^ 1
    expect(() => cipher.decrypt([v, id, iv, flipped.toString('base64url'), tag].join(':'))).toThrow(DecryptionFailedError)
    const impostor = createSecretCipher({ keys: new Map([['k1', k2]]), activeKeyId: 'k1' })
    expect(() => impostor.decrypt(envelope)).toThrow(DecryptionFailedError)
  })

  it('envelope sai dạng → EnvelopeFormatError', () => {
    const cipher = createSecretCipher({ keys: new Map([['k1', k1]]), activeKeyId: 'k1' })
    for (const bad of ['', 'abc', 'v2:k1:a:b:c', 'v1:k1:a:b', 'v1:k:1:AAAA:BBBB:CCCC', 'v1:k1:AAAA:BBBB:CCCC', 'v1:k1:!!!:BBBB:CCCC']) {
      expect(() => cipher.decrypt(bad), bad).toThrow(EnvelopeFormatError)
    }
  })

  it('khoá active không có trong danh sách / khoá không đủ 32 byte → không tạo được', () => {
    expect(() => createSecretCipher({ keys: new Map([['k1', k1]]), activeKeyId: 'k9' })).toThrow(/"k9"/)
    expect(() => createSecretCipher({ keys: new Map([['k1', randomBytes(16)]]), activeKeyId: 'k1' })).toThrow(/32 byte/)
  })
})
