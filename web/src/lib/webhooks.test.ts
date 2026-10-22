// Story 4.1 — helper thuần của Cài đặt › Webhook (nhãn/tone/thời gian).
import { describe, expect, it } from 'vitest'
import { canRetry, webhookErrorLabel, webhookEventTime, webhookFieldLabel, webhookStatusView } from './webhooks'

describe('webhookStatusView', () => {
  it('ánh xạ trạng thái → nhãn + tone', () => {
    expect(webhookStatusView({ status: 'received', errorCode: null })).toEqual({ label: 'Đang xử lý', tone: 'neutral' })
    expect(webhookStatusView({ status: 'routed', errorCode: null })).toEqual({ label: '200 OK', tone: 'success' })
    expect(webhookStatusView({ status: 'ignored', errorCode: null })).toEqual({ label: 'Đã bỏ qua', tone: 'neutral' })
  })

  it('failed kèm mã lỗi đã diễn giải', () => {
    expect(webhookStatusView({ status: 'failed', errorCode: 'WEBHOOK_ROUTE_FAILED' })).toEqual({
      label: 'Lỗi: xử lý thất bại',
      tone: 'danger',
    })
    expect(webhookStatusView({ status: 'failed', errorCode: null })).toEqual({ label: 'Lỗi', tone: 'danger' })
  })
})

describe('canRetry', () => {
  it('chỉ mục failed mới cho Xử lý lại', () => {
    expect(canRetry('failed')).toBe(true)
    for (const s of ['received', 'routed', 'ignored'] as const) expect(canRetry(s)).toBe(false)
  })
})

describe('webhookFieldLabel', () => {
  it('đánh dấu sự kiện thử', () => {
    expect(webhookFieldLabel({ field: 'test', test: true })).toBe('test (thử)')
    expect(webhookFieldLabel({ field: 'messages', test: true })).toBe('messages (thử)')
  })
  it('loại thường giữ nguyên tên field', () => {
    expect(webhookFieldLabel({ field: 'messages', test: false })).toBe('messages')
    expect(webhookFieldLabel({ field: 'replies', test: false })).toBe('replies')
  })
})

describe('webhookErrorLabel', () => {
  it('mã lạ giữ nguyên', () => {
    expect(webhookErrorLabel('WEBHOOK_ROUTE_FAILED')).toBe('xử lý thất bại')
    expect(webhookErrorLabel('SOMETHING_ELSE')).toBe('SOMETHING_ELSE')
  })
})

describe('webhookEventTime', () => {
  it('cùng ngày → "Hôm nay HH:MM:SS"', () => {
    const now = new Date('2026-10-23T20:43:12')
    expect(webhookEventTime('2026-10-23T20:43:12', now)).toMatch(/^Hôm nay /)
  })
  it('khác ngày → DD/MM HH:MM', () => {
    const now = new Date('2026-10-23T20:43:12')
    expect(webhookEventTime('2026-10-20T08:00:00', now)).not.toMatch(/^Hôm nay /)
  })
})
