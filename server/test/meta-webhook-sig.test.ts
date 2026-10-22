// Story 4.1 — kiểm chữ ký webhook (AD-4): HMAC-SHA256 trên raw body, constant-time.
import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { WEBHOOK_SIGNATURE_PREFIX, verifyWebhookSignature } from '../src/adapters/meta/index.ts'

const SECRET = 'app-secret-xyz'
const sign = (raw: Buffer, secret = SECRET) => WEBHOOK_SIGNATURE_PREFIX + createHmac('sha256', secret).update(raw).digest('hex')

describe('verifyWebhookSignature', () => {
  const raw = Buffer.from(JSON.stringify({ object: 'page', entry: [] }), 'utf8')

  it('chữ ký đúng trên raw body → true', () => {
    expect(verifyWebhookSignature(raw, sign(raw), SECRET)).toBe(true)
  })

  it('đúng raw body mới khớp — body khác một byte → false', () => {
    const other = Buffer.from(JSON.stringify({ object: 'page', entry: [{}] }), 'utf8')
    expect(verifyWebhookSignature(other, sign(raw), SECRET)).toBe(false)
  })

  it('sai app secret → false', () => {
    expect(verifyWebhookSignature(raw, sign(raw, 'khac'), SECRET)).toBe(false)
  })

  it('thiếu header / sai tiền tố / hex hỏng / lẻ byte → false', () => {
    expect(verifyWebhookSignature(raw, undefined, SECRET)).toBe(false)
    expect(verifyWebhookSignature(raw, 'sha1=abcd', SECRET)).toBe(false)
    expect(verifyWebhookSignature(raw, 'sha256=zzzz', SECRET)).toBe(false)
    expect(verifyWebhookSignature(raw, 'sha256=abc', SECRET)).toBe(false)
    expect(verifyWebhookSignature(raw, WEBHOOK_SIGNATURE_PREFIX, SECRET)).toBe(false)
  })

  it('app secret rỗng → false (không verify được)', () => {
    expect(verifyWebhookSignature(raw, sign(raw), '')).toBe(false)
  })

  it('đúng độ dài nhưng sai giá trị → false (so sánh constant-time không throw)', () => {
    const wrong = WEBHOOK_SIGNATURE_PREFIX + '0'.repeat(64)
    expect(verifyWebhookSignature(raw, wrong, SECRET)).toBe(false)
  })
})
