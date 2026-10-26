// Story 6.5 phía web: lưới tháng / tuần theo giờ VN, khoảng hỏi server, gom target thành "bài trên lịch", lọc, kế hoạch
// kéo thả (đổi giờ / đăng lại / không hợp lệ), request của ngăn chi tiết (bỏ lịch, xoá), làm cũ lịch theo SSE.
// Story 7.4: duyệt bài chiến dịch chờ duyệt trên lịch (quá giờ, request từng slot, kéo bài chưa duyệt → nhắc duyệt).
import { TransitionTargetsRequest, type CalendarItemDto } from '@ottm/shared'
import { describe, expect, it } from 'vitest'
import {
  approveCalls,
  canApproveGroup,
  isGroupOverdue,
  addMonths,
  calendarCounts,
  calendarHref,
  calendarKey,
  calendarTitle,
  canCancel,
  canDrag,
  dayLabel,
  dayParamOf,
  dropAt,
  filterItems,
  groupCalendarItems,
  groupCalls,
  groupKeyOfTarget,
  groupPages,
  groupFormatLabel,
  groupTitle,
  groupStatusText,
  groupsByDay,
  isCampaignGroup,
  isGroupHeld,
  mondayOf,
  monthGrid,
  moveRefusal,
  moveToast,
  partialRunMessage,
  planMove,
  rangeOfDays,
  todayKey,
  weekGrid,
  weekdayIndex,
} from './calendar'
import { hintInvalidates } from './realtime'

const id = (n: number) => `0199c0de-0000-7000-8000-${String(n).padStart(12, '0')}`
const SAT = '2026-10-31T12:00:00.000Z' // 19:00 Thứ Bảy 31/10 giờ VN
const NOW = Date.parse('2026-10-24T03:00:00.000Z') // 10:00 Thứ Bảy 24/10 giờ VN

const item = (n: number, over: Partial<CalendarItemDto> = {}): CalendarItemDto => ({
  id: id(100 + n),
  postId: id(1),
  pageId: id(n),
  status: 'scheduled',
  version: n,
  scheduledAt: SAT,
  publishedAt: null,
  errorCode: null,
  permalink: null,
  ai: false,
  source: 'manual',
  campaignId: null,
  title: 'Ưu đãi cuối tuần',
  topic: null,
  thumbnailUrl: null,
  held: false,
  planTitle: null,
  planFormat: null,
  ...over,
})

describe('ngày theo giờ VN', () => {
  it('hôm nay, thứ, Thứ Hai đầu tuần, cộng tháng', () => {
    expect(todayKey(NOW)).toBe('2026-10-24')
    expect(todayKey(Date.parse('2026-10-24T17:30:00.000Z'))).toBe('2026-10-25') // 00:30 Chủ Nhật giờ VN
    expect(weekdayIndex('2026-10-26')).toBe(0)
    expect(weekdayIndex('2026-11-01')).toBe(6)
    expect(mondayOf('2026-11-01')).toBe('2026-10-26')
    expect(addMonths('2026-12', 1)).toBe('2027-01')
    expect(addMonths('2026-01', -1)).toBe('2025-12')
    expect(dayLabel('2026-11-01')).toBe('Chủ Nhật 01/11')
  })

  it('lưới tháng 10/2026: Thứ Hai 28/09 → Chủ Nhật 01/11 (5 tuần); tuần 7 ngày; khoảng hỏi server theo 00:00 VN', () => {
    const cells = monthGrid('2026-10')
    expect([cells[0], cells.at(-1), cells.length]).toEqual(['2026-09-28', '2026-11-01', 35])
    expect(weekGrid('2026-10-26')).toEqual(['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01'])
    expect(rangeOfDays(weekGrid('2026-10-26'))).toEqual({ from: '2026-10-25T17:00:00.000Z', to: '2026-11-01T17:00:00.000Z' })
    // Lưới 6 tuần (tháng 8/2026) vẫn trong giới hạn 43 ngày của server.
    const aug = rangeOfDays(monthGrid('2026-08'))
    expect(monthGrid('2026-08')).toHaveLength(42)
    expect(Date.parse(aug.to) - Date.parse(aug.from)).toBe(42 * 24 * 60 * 60_000)
    expect(calendarTitle('month', { month: '2026-10', monday: '2026-10-26' })).toBe('Tháng 10, 2026')
    expect(calendarTitle('week', { month: '2026-10', monday: '2026-10-26' })).toBe('26/10 – 01/11/2026')
  })

  it('target 17:30Z nằm ô 01/11 lúc 00:30 (giờ VN, bất kể múi giờ trình duyệt)', () => {
    const [g] = groupCalendarItems([item(1, { scheduledAt: '2026-10-31T17:30:00.000Z' })])
    expect([g!.day, g!.hour, g!.time]).toEqual(['2026-11-01', 0, '00:30'])
  })
})

describe('gom target thành bài trên lịch', () => {
  it('bài thủ công 3 trang cùng giờ (2 scheduled + 1 failed) → 2 ô; slot chiến dịch cùng campaignId cùng giờ → 1 ô; sắp theo giờ', () => {
    const camp = id(77)
    const groups = groupCalendarItems([
      item(1, { ai: true }),
      item(2),
      item(3, { status: 'failed', errorCode: 'PAGE_DISCONNECTED' }),
      item(4, { postId: id(11), campaignId: camp, source: 'campaign', ai: true, scheduledAt: '2026-10-30T12:00:00.000Z' }),
      item(5, { postId: id(12), campaignId: camp, source: 'campaign', ai: true, scheduledAt: '2026-10-30T12:00:30.000Z' }),
      item(6, { postId: id(13), campaignId: camp, source: 'campaign', ai: true, scheduledAt: '2026-10-30T12:00:00.000Z', title: null }),
    ])
    expect(groups.map((g) => [g.status, g.items.length, g.postIds.length, g.ai])).toEqual([
      ['scheduled', 3, 3, true],
      ['failed', 1, 1, false],
      ['scheduled', 2, 1, true],
    ])
    expect(groups[2]!.items.map((i) => i.pageId)).toEqual([id(1), id(2)])
    expect(groupsByDay(groups).get('2026-10-31')).toHaveLength(2)
    expect(calendarCounts(groups)).toEqual({ failed: 1, pending: 0 })
    expect(groupTitle({ title: null, status: 'scheduled', topic: null })).toBe('Bài chỉ có ảnh')
    expect(groupPages(groups[2]!, [{ id: id(2) }, { id: id(9) }, { id: id(1) }])).toEqual([{ id: id(2) }, { id: id(1) }])
  })

  it('lọc theo nền tảng của trang và trạng thái', () => {
    const items = [item(1), item(2, { status: 'published' }), item(3)]
    const platformOf = (pageId: string) => (pageId === id(1) ? 'facebook' : pageId === id(2) ? 'instagram' : undefined)
    expect(filterItems(items, { platform: 'all', status: 'all' }, platformOf)).toHaveLength(3)
    expect(filterItems(items, { platform: 'instagram', status: 'all' }, platformOf).map((i) => i.pageId)).toEqual([id(2)])
    expect(filterItems(items, { platform: 'all', status: 'scheduled' }, platformOf).map((i) => i.pageId)).toEqual([id(1), id(3)])
  })
})

describe('kéo thả', () => {
  const [scheduled] = groupCalendarItems([item(1), item(2)])
  const [failed] = groupCalendarItems([item(3, { status: 'failed', errorCode: 'PUBLISH_FAILED', scheduledAt: '2026-10-23T12:30:00.000Z' })])

  it('ô tháng: đổi ngày giữ giờ phút VN → reschedule mọi target của bài (một request, hợp lệ với schema)', () => {
    const plan = planMove(scheduled!, '2026-11-02', undefined, NOW)
    expect(plan).toEqual({
      kind: 'move',
      action: 'reschedule',
      scheduledAt: '2026-11-02T12:00:00.000Z',
      calls: [{ postId: id(1), body: { action: 'reschedule', scheduledAt: '2026-11-02T12:00:00.000Z', targets: [{ id: id(101), version: 1 }, { id: id(102), version: 2 }] } }],
    })
    if (plan.kind !== 'move') throw new Error('plan')
    expect(TransitionTargetsRequest.safeParse(plan.calls[0]!.body).success).toBe(true)
    expect(moveToast(plan, 2, NOW)).toBe('Đã dời 2 trang sang 19:00 · Thứ Hai 02/11')
  })

  it('ô giờ của tuần: đổi ngày + giờ, giữ phút (bài 19:30 thả 01/11 ô 08:00 → 01:30Z)', () => {
    expect(dropAt({ time: '19:30' }, '2026-11-01', 8)).toBe('2026-11-01T01:30:00.000Z')
  })

  it('bài lỗi kéo sang ngày mai → retry (đăng lại) giờ mới', () => {
    const plan = planMove(failed!, '2026-10-25', undefined, NOW)
    expect(plan).toMatchObject({ kind: 'move', action: 'retry', scheduledAt: '2026-10-25T12:30:00.000Z' })
    if (plan.kind === 'move') expect(moveToast(plan, 1, NOW)).toBe('Sẽ đăng lại 1 trang lúc 19:30 · Chủ Nhật 25/10')
  })

  it('không hợp lệ: đã đăng / đang đăng / huỷ / chờ duyệt → không kéo; thả về quá khứ → báo; đúng chỗ cũ → im lặng', () => {
    for (const status of ['published', 'publishing', 'cancelled', 'pending_approval', 'planned'] as const) {
      const [g] = groupCalendarItems([item(1, { status })])
      expect(canDrag(g!), status).toBe(false)
      // Story 7.4: bài chiến dịch chờ duyệt / AI chưa viết → đổi giờ bằng "Duyệt" trong ngăn.
      expect(planMove(g!, '2026-11-02', undefined, NOW)).toEqual({ kind: status === 'pending_approval' || status === 'planned' ? 'awaiting' : 'locked' })
    }
    expect(moveRefusal({ kind: 'locked' })).toBe('Bài đã đăng hoặc đang đăng nên không đổi lịch được')
    const past = planMove(scheduled!, '2026-10-24', 9, NOW) // 09:00 hôm nay đã qua (bây giờ 10:00)
    expect(past).toEqual({ kind: 'past' })
    expect(moveRefusal(past)).toBe('Không dời bài về thời điểm đã qua')
    expect(planMove(scheduled!, '2026-10-31', undefined, NOW)).toEqual({ kind: 'same' })
    expect(planMove(scheduled!, '2026-10-31', 19, NOW)).toEqual({ kind: 'same' })
    expect(moveRefusal({ kind: 'same' })).toBeNull()
    // "Đăng ngay" có giây lẻ: thả lại đúng ô vẫn là chỗ cũ.
    const [odd] = groupCalendarItems([item(1, { scheduledAt: '2026-10-31T12:00:27.123Z' })])
    expect(planMove(odd!, '2026-10-31', undefined, NOW)).toEqual({ kind: 'same' })
  })
})

describe('ngăn chi tiết', () => {
  it('xoá / bỏ lịch không gửi giờ; slot chiến dịch nhiều bài → mỗi bài một request', () => {
    const groups = groupCalendarItems([item(1, { postId: id(11), campaignId: id(77) }), item(2, { postId: id(12), campaignId: id(77) })])
    const calls = groupCalls(groups[0]!, 'cancel')
    expect(calls).toEqual([
      { postId: id(11), body: { action: 'cancel', targets: [{ id: id(101), version: 1 }] } },
      { postId: id(12), body: { action: 'cancel', targets: [{ id: id(102), version: 2 }] } },
    ])
    for (const c of [...calls, ...groupCalls(groups[0]!, 'unschedule')]) expect(TransitionTargetsRequest.safeParse(c.body).success).toBe(true)
    expect(groupCalls(groups[0]!, 'retry', null)[0]!.body).toMatchObject({ action: 'retry', scheduledAt: null })
  })

  it('xoá được mọi trạng thái trước publishing và bài lỗi', () => {
    expect((['planned', 'draft', 'pending_approval', 'scheduled', 'failed'] as const).every(canCancel)).toBe(true)
    expect((['publishing', 'published', 'cancelled'] as const).some(canCancel)).toBe(false)
  })

  it('SSE post_target.* làm cũ lịch (khoá gốc post_targets)', () => {
    const key = calendarKey('all', SAT, SAT)
    expect(hintInvalidates(key[0], 'post_target')).toBe(true)
    expect(hintInvalidates(key[0], 'message')).toBe(false)
  })

  it('SSE campaign.* (bắt đầu chiến dịch) làm cũ lịch và danh sách chiến dịch', () => {
    const key = calendarKey('all', SAT, SAT)
    expect(hintInvalidates(key[0], 'campaign')).toBe(true)
    expect(hintInvalidates('campaigns', 'campaign')).toBe(true)
  })
})

describe('kế hoạch nội dung trên lịch (Story 7.8)', () => {
  it('ô `planned` có kế hoạch → "AI sẽ viết · <tiêu đề kế hoạch>" + nhãn định dạng; đã viết giữ đầu caption; không kế hoạch → không nhãn', () => {
    const campaign = { ai: true, source: 'campaign' as const, campaignId: id(77) }
    const [planned] = groupCalendarItems([item(1, { status: 'planned', title: null, topic: 'Mẹo hay', planTitle: 'Ba mẹo nồi chiên', planFormat: 'tip', ...campaign })])
    expect(groupTitle(planned!)).toBe('AI sẽ viết · Ba mẹo nồi chiên')
    expect(groupFormatLabel(planned!)).toBe('Mẹo')
    const [written] = groupCalendarItems([item(2, { status: 'pending_approval', title: 'Bài đã viết', planTitle: 'Ba mẹo', planFormat: 'question', ...campaign })])
    expect(groupTitle(written!)).toBe('Bài đã viết')
    expect(groupFormatLabel(written!)).toBe('Hỏi đáp')
    expect(groupFormatLabel(groupCalendarItems([item(3)])[0]!)).toBeNull()
  })
})

describe('slot chiến dịch trên lịch (Story 7.3)', () => {
  it('ô `planned` chưa viết → "AI sẽ viết · <chủ đề>"; đã có caption giữ tiêu đề; slot chiến dịch không bỏ lịch / mở Soạn bài', () => {
    const [planned] = groupCalendarItems([item(1, { status: 'planned', title: null, topic: 'Mẹo hay', ai: true, source: 'campaign', campaignId: id(77) })])
    expect(groupTitle(planned!)).toBe('AI sẽ viết · Mẹo hay')
    expect(groupTitle({ title: null, status: 'planned', topic: null })).toBe('AI sẽ viết')
    expect(groupTitle({ title: 'Bài AI đã viết', status: 'pending_approval', topic: 'Mẹo hay' })).toBe('Bài AI đã viết')
    expect(planned!.ai).toBe(true)
    expect(isCampaignGroup(planned!)).toBe(true)
    expect(isCampaignGroup(groupCalendarItems([item(2)])[0]!)).toBe(false)
    // Lịch chưa kéo được slot `planned` (7.4 có duyệt / đổi giờ).
    expect(canDrag(planned!)).toBe(false)
  })

  it('chạy nhiều request lỗi giữa chừng → "Đã xong k/n bài — <lỗi>"; chưa bài nào xong / chỉ một bài → chỉ câu lỗi', () => {
    expect(partialRunMessage(2, 3, 'Trạng thái bài vừa đổi')).toBe('Đã xong 2/3 bài — Trạng thái bài vừa đổi')
    expect(partialRunMessage(0, 3, 'Lỗi')).toBe('Lỗi')
    expect(partialRunMessage(0, 1, 'Lỗi')).toBe('Lỗi')
  })
})

describe('duyệt bài chiến dịch trên lịch (Story 7.4)', () => {
  it('ô chờ duyệt của chiến dịch duyệt được; quá giờ khi còn dưới 2 phút; mỗi slot một request, `scheduledAt` chỉ khi đổi giờ', () => {
    const items = [
      item(1, { status: 'pending_approval', campaignId: id(77), source: 'campaign', ai: true, version: 3, scheduledAt: '2026-10-24T04:30:00.000Z' }),
      item(2, { status: 'pending_approval', campaignId: id(77), source: 'campaign', ai: true, version: 5, scheduledAt: '2026-10-24T04:30:00.000Z' }),
    ]
    const [g] = groupCalendarItems(items)
    expect(canApproveGroup(g!)).toBe(true)
    expect(canApproveGroup(groupCalendarItems([item(3, { status: 'pending_approval' })])[0]!)).toBe(false)
    expect(isGroupOverdue(g!, NOW)).toBe(false)
    expect(isGroupOverdue(g!, Date.parse('2026-10-24T04:29:00.000Z'))).toBe(true)
    expect(approveCalls(g!)).toEqual([
      { campaignId: id(77), targetId: items[0]!.id, body: { action: 'approve', version: 3 } },
      { campaignId: id(77), targetId: items[1]!.id, body: { action: 'approve', version: 5 } },
    ])
    expect(approveCalls(g!, '2026-10-24T12:00:00.000Z').map((c) => c.body)).toEqual([
      { action: 'approve', version: 3, scheduledAt: '2026-10-24T12:00:00.000Z' },
      { action: 'approve', version: 5, scheduledAt: '2026-10-24T12:00:00.000Z' },
    ])
  })

  it('kéo bài chờ duyệt / AI chưa viết → không gọi API, nhắc duyệt trong ngăn', () => {
    const [g] = groupCalendarItems([item(1, { status: 'pending_approval', campaignId: id(77), source: 'campaign' })])
    const plan = planMove(g!, '2026-10-30', undefined, NOW)
    expect(plan).toEqual({ kind: 'awaiting' })
    expect(moveRefusal(plan)).toBe('Bài chiến dịch chưa duyệt — mở bài để duyệt và chọn giờ đăng')
  })
})

describe('chiến dịch tạm dừng trên lịch (Story 7.5)', () => {
  it('ô gom có bài `held` ghi "Tạm dừng" (thay "Quá giờ"); bài đã đăng không ghi', () => {
    const c = id(77)
    const [held] = groupCalendarItems([item(1, { campaignId: c, source: 'campaign', held: true }), item(2, { campaignId: c, source: 'campaign' })])
    expect(held!.held).toBe(true)
    expect(isGroupHeld(held!)).toBe(true)
    expect(groupStatusText(held!, NOW)).toBe('Đã lên lịch · Tạm dừng')
    const [overdueHeld] = groupCalendarItems([item(3, { campaignId: c, source: 'campaign', status: 'pending_approval', held: true, scheduledAt: '2026-10-24T02:00:00.000Z' })])
    expect(groupStatusText(overdueHeld!, NOW)).toBe('Chờ duyệt · Tạm dừng')
    const [overdue] = groupCalendarItems([item(4, { campaignId: c, source: 'campaign', status: 'pending_approval', scheduledAt: '2026-10-24T02:00:00.000Z' })])
    expect(groupStatusText(overdue!, NOW)).toBe('Chờ duyệt · Quá giờ')
    const [published] = groupCalendarItems([item(5, { campaignId: c, source: 'campaign', status: 'published', held: true })])
    expect(isGroupHeld(published!)).toBe(false)
    expect(groupStatusText(published!, NOW)).toBe('Đã đăng')
  })
})

describe('mở thẳng một bài từ Tổng quan (Story 8.5)', () => {
  it('link theo ngày VN của giờ đăng; tham số ngày sai dạng bị bỏ; tìm ô chứa target', () => {
    expect(calendarHref(id(101), SAT)).toBe(`/lich?bai=${id(101)}&ngay=2026-10-31`)
    // 23:30 UTC 31/10 = 06:30 VN 01/11 → ngày VN, không phải ngày UTC.
    expect(calendarHref(id(101), '2026-10-31T23:30:00.000Z')).toBe(`/lich?bai=${id(101)}&ngay=2026-11-01`)
    expect(dayParamOf('2026-10-31')).toBe('2026-10-31')
    expect(dayParamOf('31/10/2026')).toBeNull()
    expect(dayParamOf('2026-13-45')).toBeNull()
    expect(dayParamOf(null)).toBeNull()
    const groups = groupCalendarItems([item(1), item(2, { postId: id(2), scheduledAt: '2026-10-30T12:00:00.000Z' })])
    expect(groupKeyOfTarget(groups, id(102))).toBe(groups[0]!.key)
    expect(groupKeyOfTarget(groups, id(101))).toBe(groups[1]!.key)
    expect(groupKeyOfTarget(groups, id(999))).toBeNull()
  })
})
