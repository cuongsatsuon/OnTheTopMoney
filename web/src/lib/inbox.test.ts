// Story 4.3 — helper thuần của Hộp thư: phạm vi gửi server, tab, nhãn khách, xem trước, lý do hệ thống, thời gian
// (giờ VN), gộp trang tin, URL đính kèm. Story 4.4: nhãn kênh bình luận/Threads, dòng bài, nhãn xoá/ẩn, người viết tin,
// ghi chú ô soạn theo kênh. Story 4.6: thao tác theo trạng thái, công tắc AI, ghi chú handoff (UX-DR5), khoá query tab/
// badge nằm dưới gốc `conversations` để hint realtime làm cũ.
import { CONVERSATION_STATES, INBOX_TABS, STATE_CHANGE_REASONS, ATTACHMENT_ERRORS, MESSAGE_REMOVALS, type ConversationPreview } from '@ottm/shared'
import { describe, expect, it } from 'vitest'
import {
  ATTACHMENT_ERROR_TEXT,
  REASON_TEXT,
  REMOVAL_TEXT,
  attachmentUrl,
  bubbleKind,
  channelLabel,
  composerNote,
  INBOX_TAB_LABEL,
  aiSwitchAction,
  contactLabel,
  conversationControls,
  conversationsCountKey,
  conversationsListKey,
  durationLabel,
  flattenMessages,
  handoffNote,
  listTimeLabel,
  messageTimeLabel,
  postLine,
  previewText,
  senderLabel,
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

describe('thao tác theo trạng thái (Story 4.6)', () => {
  it('Tiếp quản ở triage/ai/handoff; công tắc AI bật = ai, khoá ở triage/done; Đánh dấu xong khi chưa done', () => {
    const table = Object.fromEntries(CONVERSATION_STATES.map((s) => [s, conversationControls(s)]))
    expect(table).toEqual({
      triage: { takeover: true, aiSwitch: { checked: false, disabled: true }, markDone: true },
      ai: { takeover: true, aiSwitch: { checked: true, disabled: false }, markDone: true },
      handoff: { takeover: true, aiSwitch: { checked: false, disabled: false }, markDone: true },
      human: { takeover: false, aiSwitch: { checked: false, disabled: false }, markDone: true },
      done: { takeover: false, aiSwitch: { checked: false, disabled: true }, markDone: false },
    })
  })

  it('gạt công tắc: bật → enable-ai; tắt → Tiếp quản', () => {
    expect(aiSwitchAction(true)).toBe('enable-ai')
    expect(aiSwitchAction(false)).toBe('takeover')
  })

  it('tab: đủ 4 nhãn; khoá danh sách/số đếm theo phạm vi + tab, dưới gốc conversations', () => {
    expect(INBOX_TABS.map((t) => INBOX_TAB_LABEL[t])).toEqual(['Tất cả', 'Cần xử lý', 'AI đang trả lời', 'Đã xong'])
    expect(conversationsListKey('all', 'needs_human')).toEqual(['conversations', 'list', 'all', 'needs_human'])
    expect(conversationsCountKey(`page:${UUID}`, 'needs_human')).toEqual(['conversations', 'count', `page:${UUID}`, 'needs_human'])
  })
})

describe('handoffNote (UX-DR5)', () => {
  const now = new Date('2026-10-23T03:30:00.000Z')
  it('handoff: lý do theo HandoffReason + thời gian chờ từ waitingSince', () => {
    expect(handoffNote({ state: 'handoff', stateReason: 'CUSTOMER_ASKED_HUMAN', waitingSince: '2026-10-23T03:18:00.000Z' }, now)).toBe(
      'Khách muốn nói chuyện với người thật · khách chờ 12 phút',
    )
    expect(handoffNote({ state: 'handoff', stateReason: 'AI_BUDGET_EXCEEDED', waitingSince: null }, now)).toBe('Đã hết hạn mức AI tháng này — chuyển cho bạn')
  })
  it('không phải handoff hoặc chưa có lý do → không ghi chú', () => {
    expect(handoffNote({ state: 'human', stateReason: 'AI_OFF', waitingSince: '2026-10-23T03:18:00.000Z' }, now)).toBeNull()
    expect(handoffNote({ state: 'handoff', stateReason: null, waitingSince: null }, now)).toBeNull()
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

describe('Story 4.4: bình luận và trả lời Threads', () => {
  it('channelLabel: DM theo nền tảng; bình luận FB/IG; Threads', () => {
    expect(channelLabel('facebook', 'dm')).toBe('Messenger')
    expect(channelLabel('instagram', 'dm')).toBe('Instagram')
    expect(channelLabel('facebook', 'comment')).toBe('Bình luận Facebook')
    expect(channelLabel('instagram', 'comment')).toBe('Bình luận Instagram')
    expect(channelLabel('threads', 'comment')).toBe('Trả lời Threads')
  })

  it('postLine: trích caption (gộp khoảng trắng, cắt dài), chưa có caption → câu chung', () => {
    expect(postLine({ platformPostId: 'P_1', text: 'Áo  thun\ncotton' }, 'facebook')).toBe('Bình luận trên bài: “Áo thun cotton”')
    expect(postLine({ platformPostId: 'T', text: null }, 'threads')).toBe('Trả lời bài Threads (chưa lấy được nội dung bài)')
    const long = postLine({ platformPostId: 'P', text: 'a'.repeat(300) }, 'instagram')
    expect(long.length).toBeLessThan(150)
    expect(long.endsWith('…”')).toBe(true)
  })

  it('REMOVAL_TEXT phủ mọi MessageRemoval', () => {
    for (const r of MESSAGE_REMOVALS) expect(REMOVAL_TEXT[r]).toBeTruthy()
  })

  it('senderLabel: người khác trong luồng → tên người đó; khách của hội thoại / không có sender → tên khách', () => {
    const conv = { contact: { id: 'c1', name: 'Nguyễn Thu Hà' } }
    expect(senderLabel({ sender: { contactId: 'c2', name: 'Trần Văn B' } }, conv, 'facebook')).toBe('Trần Văn B')
    expect(senderLabel({ sender: { contactId: 'c1', name: 'Nguyễn Thu Hà' } }, conv, 'facebook')).toBe('Nguyễn Thu Hà')
    expect(senderLabel({ sender: null }, conv, 'facebook')).toBe('Nguyễn Thu Hà')
    expect(senderLabel({ sender: { contactId: '019a-ffff-abcd', name: null } }, conv, 'threads')).toBe('Khách Threads · ABCD')
  })

  it('composerNote: bình luận FB/IG có Nhắn riêng; Threads chỉ trả lời công khai; DM như cũ', () => {
    expect(composerNote('facebook', 'comment')).toContain('Nhắn riêng')
    expect(composerNote('instagram', 'comment')).toContain('Instagram')
    expect(composerNote('threads', 'comment')).not.toContain('Nhắn riêng')
    expect(composerNote('facebook', 'dm')).toContain('Messenger/Instagram')
  })
})
