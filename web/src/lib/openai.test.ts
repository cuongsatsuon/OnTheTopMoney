import { EXCHANGE_RATE_VND_MAX, OpenAiApiKey, OpenAiKeyInfo, SaveOpenAiKeyRequest, UpdateOpenAiSettingsRequest } from '@ottm/shared'
import { describe, expect, it } from 'vitest'
import { ApiError } from './api'
import {
  AI_LOCK_HINTS,
  KEY_FORMAT_ERROR,
  KEY_REJECTED_ERROR,
  aiLock,
  formatMoney,
  keyErrorMessage,
  keyFormatError,
  keyStatusLabel,
  moneyFieldError,
  openAiKeyStatusOf,
  parseMoney,
  toUpdateRequest,
  type OpenAiForm,
} from './openai'

const key = (status: OpenAiKeyInfo['status']): { key: OpenAiKeyInfo } => ({
  key: { configured: status !== 'missing', last4: null, status, checkedAt: null, reason: null },
})

describe('openAiKeyStatusOf', () => {
  it('lấy status từ server; lỗi chưa có dữ liệu → error; chưa có phản hồi → loading', () => {
    expect(openAiKeyStatusOf({ data: key('valid'), isError: false })).toBe('valid')
    expect(openAiKeyStatusOf({ data: key('invalid'), isError: false })).toBe('invalid')
    expect(openAiKeyStatusOf({ data: key('valid'), isError: true })).toBe('valid')
    expect(openAiKeyStatusOf({ isError: true })).toBe('error')
    expect(openAiKeyStatusOf({ isError: false })).toBe('loading')
  })
})

describe('aiLock (nút AI khoá theo trạng thái server)', () => {
  it('chỉ valid mở khoá', () => {
    expect(aiLock('valid')).toEqual({ locked: false, hint: null })
  })
  it('loading: khoá nhưng không hiện gợi ý (không nháy chữ sai khi đã có khoá)', () => {
    expect(aiLock('loading')).toEqual({ locked: true, hint: null })
  })
  it('missing / invalid / error: câu gợi ý riêng', () => {
    expect(aiLock('missing')).toEqual({ locked: true, hint: 'Thêm khoá OpenAI ở Cài đặt' })
    expect(aiLock('invalid')).toEqual({ locked: true, hint: 'Khoá OpenAI không hợp lệ — cập nhật ở Cài đặt' })
    expect(aiLock('error')).toEqual({ locked: true, hint: 'Chưa kiểm tra được khoá OpenAI' })
    expect(AI_LOCK_HINTS.missing).toBe('Thêm khoá OpenAI ở Cài đặt')
  })
})

describe('lỗi khoá ở modal Cài đặt / màn Bắt đầu', () => {
  it('sai dạng → câu riêng (không gửi server); đúng dạng → null', () => {
    expect(keyFormatError('pk-abc')).toBe(KEY_FORMAT_ERROR)
    expect(keyFormatError('sk-a b')).toBe('Khoá phải bắt đầu bằng sk- và không có khoảng trắng')
    expect(keyFormatError(' sk-proj-abc ')).toBeNull()
  })
  it('OPENAI_KEY_INVALID → "Khoá không hợp lệ"; VALIDATION_FAILED → câu sai dạng; mã khác → bản đồ chung', () => {
    expect(keyErrorMessage(new ApiError('OPENAI_KEY_INVALID', 400, 'x'))).toBe(KEY_REJECTED_ERROR)
    expect(keyErrorMessage(new ApiError('VALIDATION_FAILED', 400, 'x'))).toBe(KEY_FORMAT_ERROR)
    expect(keyErrorMessage(new ApiError('OPENAI_KEY_RESTRICTED', 400, 'x'))).toContain('quyền hạn hoặc khu vực')
    expect(keyErrorMessage(new ApiError('ENCRYPTION_NOT_CONFIGURED', 500, 'x'))).toContain('APP_ENCRYPTION_KEYS')
  })
  it('nhãn chip: cần nhập lại khi reentry_required', () => {
    expect(keyStatusLabel({ status: 'invalid', reason: 'reentry_required' })).toBe('Cần nhập lại khoá')
    expect(keyStatusLabel({ status: 'invalid', reason: null })).toBe('Khoá không hợp lệ')
    expect(keyStatusLabel({ status: 'valid', reason: null })).toBe('Đã kết nối')
  })
})

describe('form Cài đặt › OpenAI', () => {
  const form: OpenAiForm = { textModel: 'm', imageModel: '', imageSize: '1024x1024', exchangeRateVnd: 26_000, monthlyLimitVnd: 1, warn80: false }
  it('toUpdateRequest bỏ model rỗng (loại không có model đang bật), giữ warn80', () => {
    expect(toUpdateRequest(form)).toEqual({ textModel: 'm', imageSize: '1024x1024', exchangeRateVnd: 26_000, monthlyLimitVnd: 1, warn80: false })
    expect(UpdateOpenAiSettingsRequest.safeParse(toUpdateRequest(form)).success).toBe(true)
  })
  it('moneyFieldError: >0, ≤ max của hợp đồng chung', () => {
    expect(moneyFieldError(0, EXCHANGE_RATE_VND_MAX)).toBe('Nhập số lớn hơn 0.')
    expect(moneyFieldError(EXCHANGE_RATE_VND_MAX + 1, EXCHANGE_RATE_VND_MAX)).toBe('Tối đa 1.000.000.')
    expect(moneyFieldError(26_000, EXCHANGE_RATE_VND_MAX)).toBeNull()
  })
})

describe('parseMoney / formatMoney', () => {
  it('bỏ mọi ký tự không phải số; định dạng vi-VN; 0 → ô trống', () => {
    expect(parseMoney('1.000.000 đ')).toBe(1_000_000)
    expect(parseMoney('')).toBe(0)
    expect(formatMoney(26_000)).toBe('26.000')
    expect(formatMoney(0)).toBe('')
  })
})

describe('hợp đồng chung (packages/shared/openai.ts)', () => {
  it('khoá: bắt đầu sk-, không khoảng trắng, ≤512, bỏ khoảng trắng hai đầu', () => {
    expect(OpenAiApiKey.parse('  sk-proj-abc_DEF-123 ')).toBe('sk-proj-abc_DEF-123')
    for (const bad of ['', 'sk-', 'pk-abc', 'sk-a b', `sk-${'x'.repeat(510)}`]) expect(OpenAiApiKey.safeParse(bad).success, bad).toBe(false)
    expect(OpenAiApiKey.safeParse(`sk-${'x'.repeat(509)}`).success).toBe(true)
    expect(SaveOpenAiKeyRequest.safeParse({ apiKey: 'sk-a', extra: 1 }).success).toBe(false)
  })

  it('lựa chọn: gửi một phần được, số nguyên dương, khoá lạ bị từ chối', () => {
    expect(UpdateOpenAiSettingsRequest.safeParse({ warn80: true }).success).toBe(true)
    expect(UpdateOpenAiSettingsRequest.safeParse({ monthlyLimitVnd: 0 }).success).toBe(false)
    expect(UpdateOpenAiSettingsRequest.safeParse({ exchangeRateVnd: 1.5 }).success).toBe(false)
    expect(UpdateOpenAiSettingsRequest.safeParse({ imageSize: '512x512' }).success).toBe(false)
    expect(UpdateOpenAiSettingsRequest.safeParse({ warn90: true }).success).toBe(false)
  })
})
