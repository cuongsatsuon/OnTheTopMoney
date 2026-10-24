// Story 4.9 — helper thuần của Khách hàng: nhãn giai đoạn tiếng Việt, thêm thẻ (bỏ trùng không phân biệt hoa thường,
// giới hạn), kiểm SĐT cùng luật server, chuỗi query danh sách, nhóm lịch sử theo hội thoại (ghi rõ trang), người viết /
// chữ của tin lịch sử, trạng thái tóm tắt AI, câu xác nhận gộp, màu avatar ổn định.
import { CONTACT_STAGES, CONTACT_TAGS_MAX, type ContactHistoryItem } from '@ottm/shared'
import { describe, expect, it } from 'vitest'
import {
  CONTACT_STAGE_LABEL,
  STAGE_OPTIONS,
  addTag,
  avatarColorOf,
  contactsListKey,
  contactsQueryString,
  deleteContactConfirmText,
  historyAuthor,
  historySegments,
  historyText,
  mergeConfirmText,
  phoneError,
  summaryNote,
} from './contacts'

const msg = (id: string, conversationId: string, pageId: string, over: Partial<ContactHistoryItem> = {}): ContactHistoryItem => ({
  id,
  conversationId,
  pageId,
  channel: 'dm',
  direction: 'inbound',
  origin: 'customer',
  text: `tin ${id}`,
  reasonCode: null,
  status: null,
  delivery: null,
  errorCode: null,
  platformTimestamp: '2026-10-24T03:00:00.000Z',
  attachments: [],
  editedAt: null,
  removal: null,
  sender: null,
  ...over,
})

describe('giai đoạn', () => {
  it('đủ nhãn tiếng Việt theo đúng thứ tự UX', () => {
    expect(CONTACT_STAGES.map((s) => CONTACT_STAGE_LABEL[s])).toEqual(['Mới', 'Đang tư vấn', 'Chốt đơn', 'Khách quen', 'Khiếu nại'])
    expect(STAGE_OPTIONS.find((o) => o.value === 'loyal')?.label).toBe('Khách quen')
  })
})

describe('addTag', () => {
  it('cắt khoảng trắng, thêm cuối; trùng không phân biệt hoa thường / rỗng / quá dài / quá số thẻ → lỗi', () => {
    expect(addTag(['VIP'], '  Đổi trả ')).toEqual({ tags: ['VIP', 'Đổi trả'] })
    expect(addTag(['Đổi trả'], 'đổi trả')).toEqual({ error: 'Khách đã có thẻ này' })
    expect(addTag([], '   ')).toEqual({ error: null })
    expect(addTag([], 'x'.repeat(41))).toEqual({ error: 'Thẻ tối đa 40 ký tự' })
    const full = Array.from({ length: CONTACT_TAGS_MAX }, (_, i) => `t${i}`)
    expect(addTag(full, 'mới')).toEqual({ error: `Tối đa ${CONTACT_TAGS_MAX} thẻ` })
  })
})

describe('phoneError', () => {
  it('cùng luật server: số, khoảng trắng, + - . ( ); rỗng hợp lệ (xoá); quá 20 ký tự / có chữ → lỗi', () => {
    expect(phoneError('0912 345 678')).toBeNull()
    expect(phoneError('+84 (912) 345-678')).toBeNull()
    expect(phoneError('')).toBeNull()
    expect(phoneError('09abc')).toMatch(/chỉ gồm chữ số/)
    expect(phoneError('1'.repeat(21))).not.toBeNull()
  })
})

describe('query danh sách', () => {
  it('bỏ bộ lọc trống, cắt chữ tìm; khoá query nằm dưới gốc `contacts` (hint realtime làm cũ)', () => {
    expect(contactsQueryString('all', { stage: null, tag: null, q: '  ' }, null)).toBe('scope=all')
    expect(new URLSearchParams(contactsQueryString('page:abc', { stage: 'complaint', tag: 'Đổi trả', q: ' Hà ' }, 'CUR'))).toEqual(
      new URLSearchParams({ scope: 'page:abc', stage: 'complaint', tag: 'Đổi trả', q: 'Hà', cursor: 'CUR' }),
    )
    expect(contactsListKey('all', { stage: null, tag: null, q: ' a ' })).toEqual(['contacts', 'list', 'all', null, null, 'a'])
  })
})

describe('lịch sử', () => {
  it('nhóm tin liền nhau theo hội thoại, giữ thứ tự và trang của từng đoạn', () => {
    const segs = historySegments([msg('1', 'c1', 'pA'), msg('2', 'c1', 'pA'), msg('3', 'c2', 'pB', { channel: 'comment' }), msg('4', 'c1', 'pA')])
    expect(segs.map((s) => [s.conversationId, s.pageId, s.channel, s.items.map((m) => m.id)])).toEqual([
      ['c1', 'pA', 'dm', ['1', '2']],
      ['c2', 'pB', 'comment', ['3']],
      ['c1', 'pA', 'dm', ['4']],
    ])
    expect(historySegments([])).toEqual([])
  })

  it('người viết: khách / người khác trong luồng bình luận / AI / chủ shop (ngoài app); chữ thay cho đính kèm', () => {
    expect(historyAuthor(msg('1', 'c', 'p'), 'K')).toEqual({ kind: 'customer', label: 'Khách' })
    expect(historyAuthor(msg('1', 'c', 'p', { sender: { contactId: 'K', name: 'Hà' } }), 'K')).toEqual({ kind: 'customer', label: 'Khách' })
    expect(historyAuthor(msg('1', 'c', 'p', { sender: { contactId: 'O', name: 'Long' } }), 'K')).toEqual({ kind: 'other', label: 'Long' })
    expect(historyAuthor(msg('1', 'c', 'p', { direction: 'outbound', origin: 'app_ai' }), 'K').kind).toBe('ai')
    expect(historyAuthor(msg('1', 'c', 'p', { direction: 'outbound', origin: 'external_human' }), 'K')).toEqual({ kind: 'human', label: 'Bạn · ngoài app' })
    expect(historyText(msg('1', 'c', 'p', { text: '  chào  ' }))).toBe('chào')
    const att = { id: 'a', kind: 'image' as const, status: 'stored' as const, mime: 'image/jpeg', bytes: 1, errorCode: null }
    expect(historyText(msg('1', 'c', 'p', { text: null, attachments: [att, { ...att, id: 'b' }] }))).toBe('Đã gửi 2 tệp đính kèm')
    expect(historyText(msg('1', 'c', 'p', { text: null }))).toBe('Tin nhắn không hiển thị được trong app')
  })
})

describe('tóm tắt AI', () => {
  it('đang chờ / lỗi theo mã / lỗi không mã / không có gì', () => {
    expect(summaryNote({ aiSummaryStatus: 'pending', aiSummaryError: null })).toEqual({ tone: 'pending', text: 'AI đang tóm tắt…' })
    const keyMissing = summaryNote({ aiSummaryStatus: 'failed', aiSummaryError: 'OPENAI_KEY_MISSING' })
    expect(keyMissing?.tone).toBe('error')
    expect(keyMissing?.text.startsWith('Không tóm tắt được: ')).toBe(true)
    expect(keyMissing?.text).not.toContain('OPENAI_KEY_MISSING')
    expect(summaryNote({ aiSummaryStatus: 'failed', aiSummaryError: null })).toEqual({ tone: 'error', text: 'Không tóm tắt được, thử lại sau' })
    expect(summaryNote({ aiSummaryStatus: 'idle', aiSummaryError: null })).toBeNull()
  })
})

describe('khác', () => {
  it('câu xác nhận gộp / xoá nêu rõ phạm vi và không hoàn tác; màu avatar ổn định theo id', () => {
    const text = mergeConfirmText('Hà', 'Thu Hà')
    expect(text).toContain('"Thu Hà" sẽ chuyển sang "Hà"')
    expect(text).toContain('Không hoàn tác được')
    expect(avatarColorOf('abc')).toBe(avatarColorOf('abc'))
    // Story 9.2: xoá khách — nêu rõ phạm vi, vĩnh viễn, tin còn trên nền tảng.
    const del = deleteContactConfirmText('Thu Hà')
    expect(del).toContain('"Thu Hà"')
    expect(del).toContain('xoá vĩnh viễn')
    expect(del).toContain('Không hoàn tác được')
    expect(del).toContain('vẫn còn trên Facebook')
    expect(avatarColorOf('abc')).toMatch(/^#[0-9A-F]{6}$/)
  })
})
