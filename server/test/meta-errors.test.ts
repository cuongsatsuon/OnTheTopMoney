// adapters/meta/errors — bảng mã/subcode → loại (AD-6, review-verify-current mục D). Subcode xét trước mã chính.
import { describe, expect, it } from 'vitest'
import { APP_LEVEL_RATE_LIMIT_CODES, classifyMetaError, isRetryable, type MetaErrorKind } from '../src/adapters/meta/errors.ts'

const body = (code?: number, subcode?: number, fbtrace = 'TRACE1') => ({
  error: {
    message: 'Nội dung lỗi có thể chứa id người dùng',
    type: 'OAuthException',
    ...(code !== undefined ? { code } : {}),
    ...(subcode !== undefined ? { error_subcode: subcode } : {}),
    fbtrace_id: fbtrace,
  },
})

describe('classifyMetaError', () => {
  it.each<[string, number, number | undefined, MetaErrorKind]>([
    // 190
    ['190 token hỏng', 190, undefined, 'TOKEN_INVALID'],
    ['190/463 token hết hạn', 190, 463, 'TOKEN_INVALID'],
    ['102 phiên API hỏng', 102, undefined, 'TOKEN_INVALID'],
    ['2500 cần access token', 2500, undefined, 'TOKEN_INVALID'],
    // 4, 17, 32, 613 (trừ 613/2018338), 80001, 80002, 80006, 341
    ['4 app', 4, undefined, 'RATE_LIMITED'],
    ['17 user', 17, undefined, 'RATE_LIMITED'],
    ['32 page (user token)', 32, undefined, 'RATE_LIMITED'],
    ['613 custom', 613, undefined, 'RATE_LIMITED'],
    ['613 với subcode khác', 613, 1996, 'RATE_LIMITED'],
    ['80001 page', 80001, undefined, 'RATE_LIMITED'],
    ['80002 instagram', 80002, undefined, 'RATE_LIMITED'],
    ['80006 messenger', 80006, undefined, 'RATE_LIMITED'],
    ['341 application limit', 341, undefined, 'RATE_LIMITED'],
    // 10/2018278, 10/2534022, 10/2018065
    ['10/2018278 ngoài cửa sổ', 10, 2018278, 'OUTSIDE_WINDOW'],
    ['10/2534022 ngoài cửa sổ chuẩn', 10, 2534022, 'OUTSIDE_WINDOW'],
    ['10/2018065', 10, 2018065, 'OUTSIDE_WINDOW'],
    // 551/1545041, 200/1545041, 10/2018108, 100/2018001
    ['551/1545041', 551, 1545041, 'RECIPIENT_UNAVAILABLE'],
    ['200/1545041 (trước nhánh 200–299)', 200, 1545041, 'RECIPIENT_UNAVAILABLE'],
    ['10/2018108', 10, 2018108, 'RECIPIENT_UNAVAILABLE'],
    ['100/2018001', 100, 2018001, 'RECIPIENT_UNAVAILABLE'],
    // 10 (subcode khác), 200–299
    ['10 không subcode', 10, undefined, 'PERMISSION_DENIED'],
    ['10 subcode khác', 10, 12345, 'PERMISSION_DENIED'],
    ['200', 200, undefined, 'PERMISSION_DENIED'],
    ['230', 230, undefined, 'PERMISSION_DENIED'],
    ['299', 299, 1, 'PERMISSION_DENIED'],
    // 1, 2
    ['1 unknown API', 1, undefined, 'TRANSIENT'],
    ['2 service', 2, undefined, 'TRANSIENT'],
    // 613/2018338, 368, 100/2534025, còn lại
    ['613/2018338 quấy rầy', 613, 2018338, 'REJECTED'],
    ['368 tạm khoá', 368, undefined, 'REJECTED'],
    ['100/2534025 private reply', 100, 2534025, 'REJECTED'],
    ['100 tham số sai', 100, undefined, 'REJECTED'],
    ['mã lạ', 987654, undefined, 'REJECTED'],
    ['300 (ngoài 200–299)', 300, undefined, 'REJECTED'],
    ['551 không subcode', 551, undefined, 'REJECTED'],
  ])('%s → %s', (_name, code, subcode, kind) => {
    const failure = classifyMetaError(400, body(code, subcode))
    expect(failure).toEqual({
      ok: false,
      kind,
      status: 400,
      code,
      ...(subcode !== undefined ? { subcode } : {}),
      fbtraceId: 'TRACE1',
    })
    // Không chép message của Meta.
    expect(JSON.stringify(failure)).not.toContain('Nội dung')
  })

  it.each([500, 502, 503, 504])('HTTP %i không có body lỗi → TRANSIENT', (status) => {
    expect(classifyMetaError(status, undefined)).toEqual({ ok: false, kind: 'TRANSIENT', status })
    expect(classifyMetaError(status, 'not json')).toEqual({ ok: false, kind: 'TRANSIENT', status })
  })

  it('HTTP 5xx kèm mã lạ → TRANSIENT; kèm mã đã biết → theo mã', () => {
    expect(classifyMetaError(500, body(987654)).kind).toBe('TRANSIENT')
    expect(classifyMetaError(500, body(190)).kind).toBe('TOKEN_INVALID')
  })

  it('HTTP 429 không có mã Meta / body HTML / mã lạ → RATE_LIMITED', () => {
    expect(classifyMetaError(429, undefined)).toEqual({ ok: false, kind: 'RATE_LIMITED', status: 429 })
    expect(classifyMetaError(429, '<html>Too Many Requests</html>')).toEqual({ ok: false, kind: 'RATE_LIMITED', status: 429 })
    expect(classifyMetaError(429, body(987654)).kind).toBe('RATE_LIMITED')
    expect(classifyMetaError(429, body(190)).kind).toBe('TOKEN_INVALID')
  })

  it('mã lạ kèm is_transient: true → TRANSIENT; mã đã biết thì theo bảng', () => {
    expect(classifyMetaError(400, { error: { code: 987654, is_transient: true } })).toEqual({
      ok: false,
      kind: 'TRANSIENT',
      status: 400,
      code: 987654,
    })
    expect(classifyMetaError(400, { error: { is_transient: true } }).kind).toBe('TRANSIENT')
    expect(classifyMetaError(400, { error: { code: 190, is_transient: true } }).kind).toBe('TOKEN_INVALID')
    expect(classifyMetaError(400, { error: { code: 987654, is_transient: 'true' } }).kind).toBe('REJECTED')
  })

  it('341 và 4 là giới hạn mức app', () => {
    expect([...APP_LEVEL_RATE_LIMIT_CODES].sort()).toEqual([341, 4].sort())
  })

  it('4xx không có body lỗi → REJECTED', () => {
    expect(classifyMetaError(400, {})).toEqual({ ok: false, kind: 'REJECTED', status: 400 })
    expect(classifyMetaError(404, null)).toEqual({ ok: false, kind: 'REJECTED', status: 404 })
  })

  it('mã dạng chuỗi số vẫn đọc được; fbtrace rỗng bị bỏ', () => {
    expect(classifyMetaError(400, { error: { code: '10', error_subcode: '2018278', fbtrace_id: '' } })).toEqual({
      ok: false,
      kind: 'OUTSIDE_WINDOW',
      status: 400,
      code: 10,
      subcode: 2018278,
    })
  })

  it('isRetryable: chỉ RATE_LIMITED và TRANSIENT', () => {
    expect(isRetryable('RATE_LIMITED')).toBe(true)
    expect(isRetryable('TRANSIENT')).toBe(true)
    for (const k of ['TOKEN_INVALID', 'OUTSIDE_WINDOW', 'RECIPIENT_UNAVAILABLE', 'PERMISSION_DENIED', 'REJECTED', 'ABORTED'] as const) {
      expect(isRetryable(k)).toBe(false)
    }
  })
})
