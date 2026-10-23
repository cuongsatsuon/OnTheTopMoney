// Story 4.3 — helper thuần của Hộp thư: phạm vi gửi server, tab, nhãn khách, xem trước, lý do hệ thống, thời gian
// (giờ VN), gộp trang tin, URL đính kèm.
import { STATE_CHANGE_REASONS, ATTACHMENT_ERRORS, type ConversationPreview } from '@ottm/shared'
import { describe, expect, it } from 'vitest'
import {
  ATTACHMENT_ERROR_TEXT,
  REASON_TEXT,
  attachmentUrl,
  bubbleKind,
  contactLabel,
  countNeedsAttention,
  durationLabel,
  flattenMessages,
  listTimeLabel,
  matchesTab,
  messageTimeLabel,
  previewText,
  serverScope,
} from './inbox'

const UUID = '019a0000-0000-7000-8000-00000000abcd'

describe('serverScope', () => {
  it('all → all; trang/nhóm thật (uuid) → chuỗi query; id kho mẫu → null (không gọi server)', () => {
    expect(serverScope({ kind: 'all' })).toBe('all')
    expect(serverScope({ kind: 'page', id: UUID })).toBe(`page:${UUID}`)
    expect(serverScope({ kind: 'group', id: UUID })).toBe(`group:${UUID}`)
    expect(serverScope({ kind: 'page', id: 'p1' })).toBeNull()
    expect(serverScope({ kind: 'group', id: 'g-beauty' })).toBeNull()
  })
})

describe('matchesTab / countNeedsAttention', () => {
  const conv = (state: 'triage' | 'ai' | 'handoff' | 'human' | 'done', needsAttention = false) => ({ state, needsAttention })
  it('Tất cả gồm cả triage; Cần xử lý theo needsAttention; AI = ai; Đã xong = done', () => {
    expect(matchesTab(conv('triage'), 'all')).toBe(true)
    expect(matchesTab(conv('triage'), 'needs')).toBe(false)
    expect(matchesTab(conv('human', true), 'needs')).toBe(true)
    expect(matchesTab(conv('human', false), 'needs')).toBe(false)
    expect(matchesTab(conv('ai'), 'ai')).toBe(true)
    expect(matchesTab(conv('done'), 'done')).toBe(true)
    expect(matchesTab(conv('done'), 'ai')).toBe(false)
    expect(countNeedsAttention([conv('human', true), conv('handoff', true), conv('ai')])).toBe(2)
  })
})

describe('contactLabel', () => {
  it('có tên → tên; chưa có → "Khách <kênh> · <4 ký tự cuối id>"', () => {
    expect(contactLabel({ id: UUID, name: 'Nguyễn Thu Hà' }, 'facebook')).toBe('Nguyễn Thu Hà')
    expect(contactLabel({ id: UUID, name: null }, 'facebook')).toBe('Khách Messenger · ABCD')
    expect(contactLabel({ id: UUID, name: null }, 'instagram')).toBe('Khách Instagram · ABCD')
    expect(contactLabel({ id: UUID, name: null }, undefined)).toBe('Khách · ABCD')
  })
})

describe('previewText', () => {
  const p = (over: Partial<ConversationPreview>): ConversationPreview => ({ text: null, origin: 'customer', attachmentCount: 0, at: '2026-10-23T03:00:00.000Z', ...over })
  it('chữ; chỉ đính kèm; không hiển thị được; tiền tố Bạn/AI', () => {
    expect(previewText(null)).toBe('Chưa có tin nhắn')
    expect(previewText(p({ text: ' Còn hàng không shop? ' }))).toBe('Còn hàng không shop?')
    expect(previewText(p({ attachmentCount: 1 }))).toBe('Đã gửi một tệp đính kèm')
    expect(previewText(p({ attachmentCount: 3 }))).toBe('Đã gửi 3 tệp đính kèm')
    expect(previewText(p({}))).toBe('Tin nhắn không hiển thị được trong app')
    expect(previewText(p({ text: 'Dạ', origin: 'app_human' }))).toBe('Bạn: Dạ')
    expect(previewText(p({ text: 'Dạ', origin: 'app_ai' }))).toBe('AI: Dạ')
  })
})

describe('microcopy', () => {
  it('mọi lý do chuyển trạng thái và mọi mã lỗi đính kèm có câu tiếng Việt', () => {
    for (const r of STATE_CHANGE_REASONS) expect(REASON_TEXT[r]).toBeTruthy()
    for (const e of ATTACHMENT_ERRORS) expect(ATTACHMENT_ERROR_TEXT[e]).toBeTruthy()
    expect(REASON_TEXT.AI_OFF).toContain('AI trả lời chưa bật')
  })

  it('bubbleKind: khách trái, hệ thống giữa, AI tím, người teal', () => {
    expect(bubbleKind('customer')).toBe('customer')
    expect(bubbleKind('system')).toBe('system')
    expect(bubbleKind('app_ai')).toBe('ai')
    expect(bubbleKind('app_human')).toBe('human')
    expect(bubbleKind('external_human')).toBe('human')
  })
})

describe('thời gian (giờ VN)', () => {
  const now = new Date('2026-10-23T05:00:00.000Z') // 12:00 VN
  it('durationLabel', () => {
    expect(durationLabel('2026-10-23T04:59:40.000Z', now)).toBe('Vừa xong')
    expect(durationLabel('2026-10-23T04:48:00.000Z', now)).toBe('12 phút')
    expect(durationLabel('2026-10-23T02:00:00.000Z', now)).toBe('3 giờ')
    expect(durationLabel('2026-10-21T05:00:00.000Z', now)).toBe('2 ngày')
  })
  it('listTimeLabel: trong ngày → giờ; hôm qua; cũ hơn → ngày/tháng — theo ngày VN, không UTC', () => {
    expect(listTimeLabel('2026-10-23T02:30:00.000Z', now)).toBe('09:30')
    // 23:30 UTC ngày 22 = 06:30 VN ngày 23 → vẫn "hôm nay".
    expect(listTimeLabel('2026-10-22T23:30:00.000Z', now)).toBe('06:30')
    expect(listTimeLabel('2026-10-22T10:00:00.000Z', now)).toBe('Hôm qua')
    expect(listTimeLabel('2026-10-12T10:00:00.000Z', now)).toBe('12/10')
  })
  it('messageTimeLabel: trong ngày → giờ; ngày khác → ngày giờ', () => {
    expect(messageTimeLabel('2026-10-23T02:30:00.000Z', now)).toBe('09:30')
    expect(messageTimeLabel('2026-10-12T12:30:00.000Z', now)).toBe('12/10 19:30')
  })
})

describe('flattenMessages / attachmentUrl', () => {
  it('trang tin (mới nhất trước, mỗi trang cũ → mới) → một dòng thời gian cũ → mới', () => {
    expect(flattenMessages([{ items: ['t4', 't5'] }, { items: ['t2', 't3'] }, { items: ['t1'] }])).toEqual(['t1', 't2', 't3', 't4', 't5'])
    expect(flattenMessages(undefined)).toEqual([])
  })
  it('URL đính kèm dưới /api/v1', () => {
    expect(attachmentUrl('a1')).toBe('/api/v1/attachments/a1')
  })
})
