// Story 4.1 — helper thuần của Cài đặt › Webhook (nhãn/tone/thời gian).
import { describe, expect, it } from 'vitest'
import { RETENTION, WEBHOOK_SUBSCRIBE_ERRORS } from '@ottm/shared'
import {
  WEBHOOK_HEALTH_KEY,
  WEBHOOK_LOG_SUBTITLE,
  WEBHOOK_SETTINGS_PATH,
  canRetry,
  lastEventLabel,
  pageSubscriptionErrorOf,
  stalledProducts,
  subscribeErrorLabel,
  webhookErrorLabel,
  webhookEventTime,
  webhookFieldLabel,
  webhookStatusView,
} from './webhooks'
import { hintInvalidates } from './realtime'

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
    expect(canRetry({ status: 'failed', payloadPurged: false })).toBe(true)
    for (const s of ['received', 'routed', 'ignored'] as const) expect(canRetry({ status: s, payloadPurged: false })).toBe(false)
  })
  it('Story 9.3: mục failed đã dọn nội dung thô thì không Xử lý lại', () => {
    expect(canRetry({ status: 'failed', payloadPurged: true })).toBe(false)
  })
  it('dòng phụ nhật ký nêu đúng hạn giữ nội dung thô', () => {
    expect(WEBHOOK_LOG_SUBTITLE).toContain(`${RETENTION.webhookPayloadDays} ngày`)
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

// Story 4.2 — sức khoẻ webhook.
describe('lastEventLabel', () => {
  const now = new Date('2026-10-23T10:00:00Z')
  it('chưa có sự kiện → "Đang chờ tin đầu tiên"', () => {
    expect(lastEventLabel(null, now)).toBe('Đang chờ tin đầu tiên')
  })
  it('dưới 1 phút → vừa xong; phút / giờ / ngày trước', () => {
    expect(lastEventLabel('2026-10-23T09:59:30Z', now)).toBe('Nhận tin gần nhất: vừa xong')
    expect(lastEventLabel('2026-10-23T10:00:05Z', now)).toBe('Nhận tin gần nhất: vừa xong')
    expect(lastEventLabel('2026-10-23T09:59:00Z', now)).toBe('Nhận tin gần nhất: 1 phút trước')
    expect(lastEventLabel('2026-10-23T09:29:00Z', now)).toBe('Nhận tin gần nhất: 31 phút trước')
    expect(lastEventLabel('2026-10-23T07:00:00Z', now)).toBe('Nhận tin gần nhất: 3 giờ trước')
    expect(lastEventLabel('2026-10-21T09:00:00Z', now)).toBe('Nhận tin gần nhất: 2 ngày trước')
  })
})

describe('subscribeErrorLabel', () => {
  it('mọi mã lỗi đăng ký đều có câu tiếng Việt riêng', () => {
    const labels = WEBHOOK_SUBSCRIBE_ERRORS.map(subscribeErrorLabel)
    for (const l of labels) expect(l).toMatch(/\S/)
    expect(new Set(labels).size).toBe(WEBHOOK_SUBSCRIBE_ERRORS.length)
    expect(subscribeErrorLabel('PERMISSION_DENIED')).toMatch(/quyền/)
    expect(subscribeErrorLabel('TOKEN_INVALID')).toMatch(/Kết nối lại/)
  })
})

describe('stalledProducts / pageSubscriptionErrorOf', () => {
  const health = {
    products: [
      { product: 'meta' as const, status: 'stalled' as const, lastEventAt: '2026-10-23T09:00:00.000Z' },
      { product: 'threads' as const, status: 'waiting_first' as const, lastEventAt: null },
    ],
    pageSubscriptionErrors: [{ pageId: 'p1', name: 'Trang 1', platform: 'facebook' as const, errorCode: 'REJECTED' as const }],
  }
  it('banner chỉ khi có sản phẩm stalled', () => {
    expect(stalledProducts(health)).toEqual(['meta'])
    expect(stalledProducts({ products: health.products.map((p) => ({ ...p, status: 'ok' as const })) })).toEqual([])
    expect(stalledProducts(undefined)).toEqual([])
  })
  it('lỗi đăng ký của đúng trang', () => {
    expect(pageSubscriptionErrorOf(health, 'p1')?.errorCode).toBe('REJECTED')
    expect(pageSubscriptionErrorOf(health, 'p2')).toBeNull()
    expect(pageSubscriptionErrorOf(undefined, 'p1')).toBeNull()
  })
  it('link banner mở Cài đặt › Webhook', () => {
    expect(WEBHOOK_SETTINGS_PATH).toBe('/cai-dat?section=webhook')
  })
})

describe('hint realtime webhook.* làm cũ khoá sức khoẻ', () => {
  it('entity `webhook` (webhook.stalled|recovered) khớp khoá gốc `webhooks`', () => {
    expect(hintInvalidates(WEBHOOK_HEALTH_KEY[0], 'webhook')).toBe(true)
  })
})
