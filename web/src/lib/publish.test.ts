// Story 6.4 phía web: giờ VN ↔ ISO UTC, ô ngày giờ mặc định / kiểm, chế độ bài, nhãn trạng thái từng trang, câu lỗi khi
// lên lịch, toast, khung xem trước Instagram, làm cũ `['posts']` theo SSE `post_target.*`.
import type { PageDto, PostDto, PostTargetDto } from '@ottm/shared'
import { describe, expect, it } from 'vitest'
import { ApiError } from './api'
import { hintInvalidates } from './realtime'
import {
  defaultScheduleInput,
  formatVnDateTime,
  hasInFlight,
  igPreviewFit,
  isLocked,
  isoToVnInput,
  publishedToast,
  scheduleInputIssue,
  scheduledToast,
  targetRefs,
  targetStatusView,
  transitionErrorMessage,
  vnToIso,
} from './publish'

const id = (n: number) => `0199c0de-0000-7000-8000-${String(n).padStart(12, '0')}`
const page = (n: number, platform: PageDto['platform']): PageDto => ({
  id: id(n),
  platform,
  name: `Trang ${n}`,
  handle: null,
  avatarUrl: null,
  groupId: null,
  connectionStatus: 'active',
  connectedAt: '2026-10-01T00:00:00.000Z',
})
const NOW = Date.parse('2026-10-24T03:00:00.000Z') // 10:00 Thứ Bảy 24/10 giờ VN

const target = (n: number, over: Partial<PostTargetDto> = {}): PostTargetDto => ({
  id: id(50 + n),
  pageId: id(n),
  status: 'draft',
  caption: 'x',
  aiCaption: false,
  media: [],
  version: n,
  scheduledAt: null,
  errorCode: null,
  publishedAt: null,
  permalink: null,
  ...over,
})
const post = (targets: PostTargetDto[]): PostDto => ({
  id: id(99),
  source: 'manual',
  topic: null,
  targets,
  createdAt: '2026-10-24T00:00:00.000Z',
  updatedAt: '2026-10-24T00:00:00.000Z',
})

describe('giờ VN ↔ ISO UTC', () => {
  it('31/10/2026 19:00 giờ VN → 12:00Z, hiển thị lại "19:00 · Thứ Bảy 31/10"; ngược lại về ô ngày giờ', () => {
    expect(vnToIso('2026-10-31', '19:00')).toBe('2026-10-31T12:00:00.000Z')
    expect(formatVnDateTime('2026-10-31T12:00:00.000Z', NOW)).toBe('19:00 · Thứ Bảy 31/10')
    expect(isoToVnInput('2026-10-31T12:00:00.000Z')).toEqual({ date: '2026-10-31', time: '19:00' })
    // Qua nửa đêm giờ VN: 01:30 ngày 1/11 = 18:30Z ngày 31/10.
    expect(vnToIso('2026-11-01', '01:30')).toBe('2026-10-31T18:30:00.000Z')
    expect(formatVnDateTime('2027-01-02T01:00:00.000Z', NOW)).toBe('08:00 · Thứ Bảy 02/01/2027')
  })

  it('ô trống / sai dạng / ngày không có → null', () => {
    expect(vnToIso('', '19:00')).toBeNull()
    expect(vnToIso('2026-10-31', '')).toBeNull()
    expect(vnToIso('2026-02-31', '10:00')).toBeNull()
    expect(vnToIso('2026-10-31', '25:00')).toBeNull()
  })

  it('mặc định 19:00 hôm nay; đã qua (hoặc còn dưới 5 phút) → 19:00 ngày mai', () => {
    expect(defaultScheduleInput(NOW)).toEqual({ date: '2026-10-24', time: '19:00' })
    expect(defaultScheduleInput(Date.parse('2026-10-24T11:57:00.000Z'))).toEqual({ date: '2026-10-25', time: '19:00' })
    expect(defaultScheduleInput(Date.parse('2026-10-24T17:30:00.000Z'))).toEqual({ date: '2026-10-25', time: '19:00' })
  })

  it('kiểm ô ngày giờ trước khi gửi', () => {
    expect(scheduleInputIssue('2026-10-31', '19:00', NOW)).toBeNull()
    expect(scheduleInputIssue('2026-10-24', '09:00', NOW)).toBe('Thời gian đăng đã qua — chọn thời điểm khác')
    expect(scheduleInputIssue('', '', NOW)).toBe('Chọn ngày và giờ đăng')
  })
})

describe('chế độ bài + trạng thái từng trang', () => {
  it('mọi target nháp → sửa được; có target rời nháp → chỉ xem; refs theo trạng thái', () => {
    const p = post([target(1, { status: 'scheduled', scheduledAt: '2026-10-31T12:00:00.000Z' }), target(2, { status: 'failed', errorCode: 'PUBLISH_REJECTED' }), target(3)])
    expect(isLocked(post([target(1), target(2)]))).toBe(false)
    expect(isLocked(undefined)).toBe(false)
    expect(isLocked(p)).toBe(true)
    expect(targetRefs(p, ['scheduled'])).toEqual([{ id: id(51), version: 1 }])
    expect(targetRefs(p, ['failed'])).toEqual([{ id: id(52), version: 2 }])
  })

  it('nhãn: đã lên lịch (giờ VN) / chờ đăng / đang đăng / đã đăng / lỗi + lý do theo mã', () => {
    expect(targetStatusView(target(1, { status: 'scheduled', scheduledAt: '2026-10-31T12:00:00.000Z' }), NOW)).toEqual({ tone: 'info', label: 'Đã lên lịch · 19:00 · Thứ Bảy 31/10' })
    expect(targetStatusView(target(1, { status: 'scheduled', scheduledAt: '2026-10-24T02:59:00.000Z' }), NOW).label).toBe('Đang chờ đăng…')
    expect(targetStatusView(target(1, { status: 'publishing' }), NOW).label).toBe('Đang đăng…')
    expect(targetStatusView(target(1, { status: 'published', publishedAt: '2026-10-24T02:00:00.000Z' }), NOW)).toEqual({ tone: 'success', label: 'Đã đăng · 09:00 · Thứ Bảy 24/10' })
    expect(targetStatusView(target(1, { status: 'failed', errorCode: 'PUBLISH_UNKNOWN' }), NOW)).toEqual({
      tone: 'danger',
      label: 'Đăng lỗi',
      detail: 'Chưa rõ bài đã lên hay chưa. Kiểm tra trang trước khi đăng lại.',
    })
  })

  it('hỏi lại định kỳ khi còn trang đang đăng hoặc tới giờ', () => {
    expect(hasInFlight(post([target(1, { status: 'publishing' })]), NOW)).toBe(true)
    expect(hasInFlight(post([target(1, { status: 'scheduled', scheduledAt: '2026-10-24T03:00:30.000Z' })]), NOW)).toBe(true)
    expect(hasInFlight(post([target(1, { status: 'scheduled', scheduledAt: '2026-10-31T12:00:00.000Z' }), target(2, { status: 'published' })]), NOW)).toBe(false)
  })
})

describe('câu báo', () => {
  const PAGES = [page(1, 'facebook'), page(2, 'instagram'), page(3, 'threads')]

  it('lỗi một trang khi lên lịch → "<Trang>: <câu>"; mã khác → câu theo mã', () => {
    const issue = new ApiError('MEDIA_REQUIRED', 422, 'x', { targetId: id(52), pageId: id(2), issues: [{ code: 'MEDIA_REQUIRED' }] })
    expect(transitionErrorMessage(issue, PAGES)).toBe('Trang 2: Instagram cần ít nhất 1 ảnh')
    const long = new ApiError('CAPTION_TOO_LONG', 422, 'x', { pageId: id(3), issues: [{ code: 'CAPTION_TOO_LONG', limit: 500, actual: 520 }] })
    expect(transitionErrorMessage(long, PAGES)).toBe('Trang 3: Threads tối đa 500 ký tự (đang 520)')
    const limit = new ApiError('PUBLISH_LIMIT_REACHED', 422, 'x', { pageId: id(2), limit: 100 })
    expect(transitionErrorMessage(limit, PAGES)).toBe('Trang 2: Trang đã chạm giới hạn đăng bài hôm nay. Lên lịch sang ngày khác.')
    expect(transitionErrorMessage(new ApiError('SCHEDULE_IN_PAST', 422, 'x', { targetId: id(51) }), PAGES)).toBe('Thời gian đăng đã qua. Chọn thời điểm khác.')
    expect(transitionErrorMessage(new ApiError('VERSION_CONFLICT', 409, 'x'), PAGES)).toBe('Dữ liệu vừa được thay đổi ở nơi khác. Tải lại để xem bản mới nhất.')
  })

  it('toast lên lịch / đăng ngay / đã đăng (gộp nhiều trang)', () => {
    expect(scheduledToast(3, '2026-10-31T12:00:00.000Z')).toMatch(/^Đã lên lịch 3 trang · 19:00 · Thứ Bảy 31\/10$/)
    expect(scheduledToast(2, null)).toBe('Đang đăng lên 2 trang…')
    expect(publishedToast(['Mỹ phẩm Lan Anh'])).toBe('Đã đăng lên Mỹ phẩm Lan Anh')
    expect(publishedToast(['A', 'B', 'C'])).toBe('Đã đăng lên 3 trang')
  })
})

describe('khung xem trước Instagram', () => {
  it('ảnh 3:4 → đệm dọc; 1:1 → giữ; 3:1 → đệm ngang; 4:5 đúng → giữ; chưa có ảnh → giữ', () => {
    expect(igPreviewFit({ width: 3024, height: 4032 })).toBe('pad_tall')
    expect(igPreviewFit({ width: 1024, height: 1024 })).toBe('ok')
    expect(igPreviewFit({ width: 1200, height: 400 })).toBe('pad_wide')
    expect(igPreviewFit({ width: 1080, height: 1350 })).toBe('ok')
    expect(igPreviewFit(undefined)).toBe('ok')
  })
})

describe('realtime', () => {
  it('post_target.published|failed làm cũ bài đang mở ["posts", id]', () => {
    expect(hintInvalidates('posts', 'post_target')).toBe(true)
    expect(hintInvalidates('media_assets', 'post_target')).toBe(false)
  })
})
