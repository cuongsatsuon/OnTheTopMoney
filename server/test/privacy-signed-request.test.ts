// Story 9.1 — `signed_request` của Meta: chữ ký HMAC-SHA256 trên chuỗi payload base64url, so sánh constant-time,
// kiểm `algorithm` + `user_id`; mọi sai đều trả lý do (không ném). Cùng mã xác nhận / khoá idempotent.
import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  CONFIRMATION_CODE_RE,
  metaSubjectHash,
  newConfirmationCode,
  signRequestForTest,
  verifySignedRequest,
} from '../src/modules/privacy/index.ts'

const SECRET = 'meta-app-secret-123'
const payload = { algorithm: 'HMAC-SHA256', issued_at: 1_790_000_000, user_id: '1234567890' }

describe('verifySignedRequest', () => {
  it('chữ ký đúng → user_id + issued_at', () => {
    expect(verifySignedRequest(signRequestForTest(payload, SECRET), SECRET)).toEqual({ ok: true, userId: '1234567890', issuedAt: 1_790_000_000 })
  })

  it('đúng dạng Meta tự ký (base64url có `=` đệm, algorithm chữ thường, user_id dạng số)', () => {
    const p = Buffer.from(JSON.stringify({ algorithm: 'hmac-sha256', user_id: 42 })).toString('base64')
      .replace(/\+/g, '-').replace(/\//g, '_')
    const sig = createHmac('sha256', SECRET).update(p).digest('base64url')
    expect(verifySignedRequest(`${sig}.${p}`, SECRET)).toEqual({ ok: true, userId: '42', issuedAt: null })
  })

  it('secret khác / payload bị sửa / chữ ký cắt ngắn → bad_signature', () => {
    expect(verifySignedRequest(signRequestForTest(payload, 'secret-khac'), SECRET)).toEqual({ ok: false, reason: 'bad_signature' })
    const [sig] = signRequestForTest(payload, SECRET).split('.')
    const forged = Buffer.from(JSON.stringify({ ...payload, user_id: '999' })).toString('base64url')
    expect(verifySignedRequest(`${sig}.${forged}`, SECRET)).toEqual({ ok: false, reason: 'bad_signature' })
    const good = signRequestForTest(payload, SECRET)
    expect(verifySignedRequest(good.slice(4), SECRET)).toEqual({ ok: false, reason: 'bad_signature' })
  })

  it('thiếu secret → not_configured; thiếu / rỗng / không phải chuỗi → missing', () => {
    expect(verifySignedRequest(signRequestForTest(payload, SECRET), undefined)).toEqual({ ok: false, reason: 'not_configured' })
    expect(verifySignedRequest(signRequestForTest(payload, SECRET), '')).toEqual({ ok: false, reason: 'not_configured' })
    expect(verifySignedRequest(undefined, SECRET)).toEqual({ ok: false, reason: 'missing' })
    expect(verifySignedRequest('', SECRET)).toEqual({ ok: false, reason: 'missing' })
    expect(verifySignedRequest(['a.b'], SECRET)).toEqual({ ok: false, reason: 'missing' })
  })

  it('không có dấu chấm / nhiều dấu chấm / ký tự lạ → malformed', () => {
    expect(verifySignedRequest('abc', SECRET)).toEqual({ ok: false, reason: 'malformed' })
    expect(verifySignedRequest('a.b.c', SECRET)).toEqual({ ok: false, reason: 'malformed' })
    expect(verifySignedRequest('a+b/.c', SECRET)).toEqual({ ok: false, reason: 'malformed' })
    expect(verifySignedRequest('.abc', SECRET)).toEqual({ ok: false, reason: 'malformed' })
  })

  it('chữ ký đúng nhưng payload không phải JSON object → malformed', () => {
    const p = Buffer.from('not json').toString('base64url')
    const sig = createHmac('sha256', SECRET).update(p).digest('base64url')
    expect(verifySignedRequest(`${sig}.${p}`, SECRET)).toEqual({ ok: false, reason: 'malformed' })
    const n = Buffer.from('123').toString('base64url')
    expect(verifySignedRequest(`${createHmac('sha256', SECRET).update(n).digest('base64url')}.${n}`, SECRET)).toEqual({ ok: false, reason: 'malformed' })
  })

  it('algorithm khác / thiếu → bad_algorithm', () => {
    expect(verifySignedRequest(signRequestForTest({ ...payload, algorithm: 'HMAC-SHA1' }, SECRET), SECRET)).toEqual({ ok: false, reason: 'bad_algorithm' })
    expect(verifySignedRequest(signRequestForTest({ user_id: '1' }, SECRET), SECRET)).toEqual({ ok: false, reason: 'bad_algorithm' })
  })

  it('không có user_id / user_id không phải số → no_user', () => {
    expect(verifySignedRequest(signRequestForTest({ algorithm: 'HMAC-SHA256' }, SECRET), SECRET)).toEqual({ ok: false, reason: 'no_user' })
    expect(verifySignedRequest(signRequestForTest({ ...payload, user_id: 'abc' }, SECRET), SECRET)).toEqual({ ok: false, reason: 'no_user' })
    expect(verifySignedRequest(signRequestForTest({ ...payload, user_id: 1.5 }, SECRET), SECRET)).toEqual({ ok: false, reason: 'no_user' })
  })
})

describe('mã xác nhận + khoá idempotent', () => {
  it('mã 32 hex, mỗi lần khác nhau', () => {
    const a = newConfirmationCode()
    expect(a).toMatch(CONFIRMATION_CODE_RE)
    expect(newConfirmationCode()).not.toBe(a)
  })

  it('subject hash ổn định theo (secret, user), không chứa id thô', () => {
    const h = metaSubjectHash(SECRET, '1234567890')
    expect(h).toBe(metaSubjectHash(SECRET, '1234567890'))
    expect(h).not.toBe(metaSubjectHash(SECRET, '1234567891'))
    expect(h).not.toBe(metaSubjectHash('secret-khac', '1234567890'))
    expect(h).not.toContain('1234567890')
  })
})
