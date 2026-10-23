// Story 7.1 phía web: form wizard → body, nạp lại nháp, trang chọn được (chế độ nhóm tự loại), tóm tắt (tổng bài, lịch
// nhiệt, bài có ảnh — Instagram luôn có ảnh), lỗi validate (web + server) → đúng bước + dưới ô, Phạm vi → đích ban đầu.
import { CampaignDto, SaveCampaignRequest, campaignImageRatio, campaignPostsOnDay, type CampaignPageOption, type PageDto } from '@ottm/shared'
import { describe, expect, it } from 'vitest'
import { ApiError } from './api'
import { hintInvalidates } from './realtime'
import {
  CAMPAIGN_PAGE_OPTIONS_KEY,
  activePages,
  addDaysKey,
  autoName,
  buildCampaignBody,
  dailyPlan,
  dayLabel,
  formFromCampaign,
  hasInstagram,
  initialForm,
  planTotals,
  serverCampaignErrors,
  splitEven,
  stepHasErrors,
  targetPages,
  topicSum,
  validateCampaign,
  type CampaignForm,
  type PageOptions,
} from './campaigns'

const G1 = '0190a000-0000-7000-8000-0000000000a1'
const G2 = '0190a000-0000-7000-8000-0000000000a2'
const id = (n: number) => `0190a000-0000-7000-8000-${String(n).padStart(12, '0')}`
/** 10:00 24/10/2026 giờ VN. */
const NOW = Date.parse('2026-10-24T03:00:00.000Z')

const page = (n: number, platform: PageDto['platform'], groupId: string | null, connectionStatus: PageDto['connectionStatus'] = 'active'): PageDto => ({
  id: id(n),
  platform,
  name: `Trang ${n}`,
  handle: null,
  avatarUrl: null,
  groupId,
  connectionStatus,
  connectedAt: '2026-10-01T00:00:00.000Z',
})

const FB = page(1, 'facebook', G1)
const IG = page(2, 'instagram', G1)
const OFF = page(3, 'threads', G1, 'disconnected')
const NOBRAND = page(4, 'facebook', G1)
const SOLO = page(5, 'threads', null)
const PAGES = [FB, IG, OFF, NOBRAND, SOLO]
const GROUPS = [
  { id: G1, name: 'Nhóm Mỹ phẩm' },
  { id: G2, name: 'Nhóm Gia dụng' },
]
const option = (p: PageDto, reason: CampaignPageOption['reason']): [string, CampaignPageOption] => [p.id, { pageId: p.id, selectable: reason === null, reason }]
const OPTIONS: PageOptions = new Map([option(FB, null), option(IG, null), option(OFF, 'PAGE_DISCONNECTED'), option(NOBRAND, 'CONFIG_MISSING'), option(SOLO, null)])

const form = (over: Partial<CampaignForm> = {}): CampaignForm => ({ ...initialForm({ kind: 'all' }, GROUPS, NOW), ...over })

describe('đích ban đầu theo Phạm vi', () => {
  it('tất cả → nhóm đầu; nhóm → nhóm đó; trang → chọn từng trang; không có nhóm → chọn từng trang; bắt đầu ngày mai giờ VN', () => {
    expect(initialForm({ kind: 'all' }, GROUPS, NOW)).toMatchObject({ targetMode: 'group', groupId: G1, startDate: '2026-10-25', mode: 'review', durationDays: 30 })
    expect(initialForm({ kind: 'group', id: G2 }, GROUPS, NOW)).toMatchObject({ targetMode: 'group', groupId: G2 })
    expect(initialForm({ kind: 'page', id: SOLO.id }, GROUPS, NOW)).toMatchObject({ targetMode: 'pages', picked: [SOLO.id] })
    expect(initialForm({ kind: 'all' }, [], NOW)).toMatchObject({ targetMode: 'pages', groupId: null })
    // 23:30 23/10 UTC = 06:30 24/10 VN → ngày mai là 25/10.
    expect(initialForm({ kind: 'all' }, GROUPS, Date.parse('2026-10-23T23:30:00.000Z')).startDate).toBe('2026-10-25')
  })
})

describe('trang chọn được', () => {
  it('chế độ nhóm: hiện mọi trang của nhóm, nhưng trang mất kết nối / thiếu hồ sơ bị loại khỏi đích và tổng bài', () => {
    const f = form()
    expect(targetPages(f, PAGES).map((p) => p.id)).toEqual([FB.id, IG.id, OFF.id, NOBRAND.id])
    const active = activePages(f, PAGES, OPTIONS)
    expect(active.map((p) => p.id)).toEqual([FB.id, IG.id])
    expect(planTotals(f, active).posts).toBe(2 * 30 * 1)
  })

  it('sự kiện trang (mất kết nối / kết nối lại / gỡ) làm cũ danh sách trang chọn được', () => {
    expect(hintInvalidates(CAMPAIGN_PAGE_OPTIONS_KEY[0], 'page', 'page.disconnected')).toBe(true)
    expect(hintInvalidates(CAMPAIGN_PAGE_OPTIONS_KEY[0], 'message', 'message.received')).toBe(false)
  })

  it('chọn từng trang: theo thứ tự danh sách; trang không chọn được (nếu lỡ chọn) cũng bị loại', () => {
    const f = form({ targetMode: 'pages', picked: [SOLO.id, OFF.id, FB.id] })
    expect(activePages(f, PAGES, OPTIONS).map((p) => p.id)).toEqual([FB.id, SOLO.id])
  })
})

describe('body và nạp lại nháp', () => {
  it('nhóm + tần suất đặt riêng + giờ sắp tăng dần → body hợp lệ theo schema shared; nạp lại từ DTO ra cùng body', () => {
    const f = form({ overrides: { [IG.id]: '2_per_day' }, postTimes: ['19:30', '11:30'] })
    const active = activePages(f, PAGES, OPTIONS)
    const name = autoName(f, active, GROUPS)
    expect(name).toBe('Mỹ phẩm – tăng tương tác 30 ngày')
    const body = buildCampaignBody(f, active, name)
    expect(body).toMatchObject({
      groupId: G1,
      pages: [
        { pageId: FB.id, frequency: null },
        { pageId: IG.id, frequency: '2_per_day' },
      ],
      postTimes: ['11:30', '19:30'],
      mode: 'review',
    })
    expect(SaveCampaignRequest.safeParse(body).success).toBe(true)
    const dto = CampaignDto.parse({ ...body, id: id(99), status: 'draft', createdAt: '2026-10-24T03:00:00.000Z', updatedAt: '2026-10-24T03:00:00.000Z' })
    const again = formFromCampaign(dto)
    expect(buildCampaignBody(again, activePages(again, PAGES, OPTIONS), again.name)).toEqual(body)
  })

  it('chọn từng trang → groupId null; nạp lại về "Chọn từng trang"', () => {
    const f = form({ targetMode: 'pages', picked: [SOLO.id] })
    const body = buildCampaignBody(f, activePages(f, PAGES, OPTIONS), 'Tên')
    expect(body.groupId).toBeNull()
    const dto = CampaignDto.parse({ ...body, mode: 'review', id: id(98), status: 'draft', createdAt: '2026-10-24T03:00:00.000Z', updatedAt: '2026-10-24T03:00:00.000Z' })
    expect(formFromCampaign(dto)).toMatchObject({ targetMode: 'pages', picked: [SOLO.id], groupId: null })
  })
})

describe('tóm tắt', () => {
  it('30 ngày: 3 bài/tuần + 2 bài/ngày với 1 khung giờ → ngày 0: 2 bài, ngày 1: 1 bài; tổng 13 + 30; ô ngoài thời lượng = −1', () => {
    const f = form({ targetMode: 'pages', picked: [FB.id, SOLO.id], overrides: { [FB.id]: '3_per_week', [SOLO.id]: '2_per_day' }, postTimes: ['19:30'] })
    const active = activePages(f, PAGES, OPTIONS)
    const plan = dailyPlan(f, active)
    expect(plan.slice(0, 3)).toEqual([2, 1, 2])
    expect(planTotals(f, active).posts).toBe(13 + 30)
    expect(dailyPlan({ ...f, durationDays: 7 }, active).slice(6, 8)).toEqual([1, -1])
    expect(campaignPostsOnDay('3_per_day', 0, 2)).toBe(2)
    expect(campaignPostsOnDay('3_per_week', 7, 3)).toBe(1)
  })

  it('đích có Instagram → ghi chú; Instagram luôn có ảnh dù tỉ lệ 30%', () => {
    expect(hasInstagram([FB, IG])).toBe(true)
    expect(hasInstagram([FB, SOLO])).toBe(false)
    expect(campaignImageRatio('instagram', 30)).toBe(100)
    expect(campaignImageRatio('facebook', 30)).toBe(30)
    const f = form({ imageRatio: 30, durationDays: 7 })
    // FB 7 bài × 30% ≈ 2; IG 7 bài × 100% = 7.
    expect(planTotals(f, [FB, IG])).toEqual({ posts: 14, imagePosts: 9 })
  })

  it('chia đều và tổng tỉ lệ', () => {
    const even = splitEven([
      { name: 'A', share: 0 },
      { name: 'B', share: 0 },
      { name: 'C', share: 0 },
    ])
    expect(even.map((t) => t.share)).toEqual([34, 33, 33])
    expect(topicSum(even)).toBe(100)
  })

  it('nhãn ngày lịch không phụ thuộc múi giờ', () => {
    expect(addDaysKey('2026-10-26', 29)).toBe('2026-11-24')
    expect(dayLabel('2026-10-31', true)).toBe('T7, 31/10/2026')
  })
})

describe('lỗi → bước + dưới ô', () => {
  const bodyOf = (over: Partial<CampaignForm> = {}) => {
    const f = form(over)
    return buildCampaignBody(f, activePages(f, PAGES, OPTIONS), 'Tên')
  }

  it('tổng tỉ lệ 90% → bước 3, dưới ô chủ đề', () => {
    const errors = validateCampaign(
      bodyOf({
        topics: [
          { name: 'Mẹo hay', share: 40 },
          { name: 'Review', share: 30 },
          { name: 'Hỏi đáp', share: 20 },
        ],
      }),
      NOW,
    )
    expect(errors).toEqual({ fields: { topics: 'Tổng tỉ lệ chủ đề phải đúng 100% (hiện 90%)' }, pages: {}, step: 3 })
  })

  it('ngày bắt đầu hôm qua (giờ VN) → bước 1; không giờ đăng → bước 3; bước nhỏ nhất thắng', () => {
    const errors = validateCampaign(bodyOf({ startDate: '2026-10-23', postTimes: [] }), NOW)
    expect(errors.fields).toEqual({ startDate: 'Ngày bắt đầu đã qua', postTimes: 'Thêm ít nhất 1 khung giờ' })
    expect(errors.step).toBe(1)
    expect(stepHasErrors(errors, 1)).toBe(true)
    expect(stepHasErrors(errors, 2)).toBe(false)
    expect(stepHasErrors(errors, 3)).toBe(true)
    expect(validateCampaign(bodyOf(), NOW).step).toBeNull()
  })

  it('không còn trang chọn được (nhóm toàn trang lỗi) → bước 2', () => {
    const errors = validateCampaign(bodyOf({ targetMode: 'pages', picked: [OFF.id] }), NOW)
    expect(errors).toMatchObject({ fields: { pages: 'Chọn ít nhất 1 trang' }, step: 2 })
  })

  it('lỗi server: tổng tỉ lệ → bước 3; trang mất kết nối → câu theo trang ở bước 2; lỗi khác → null', () => {
    const body = bodyOf()
    const topics = new ApiError('VALIDATION_FAILED', 400, 'x', [{ path: ['topics'], message: 'Tổng tỉ lệ chủ đề phải đúng 100% (hiện 90%)' }])
    expect(serverCampaignErrors(topics, body)).toEqual({ fields: { topics: 'Tổng tỉ lệ chủ đề phải đúng 100% (hiện 90%)' }, pages: {}, step: 3 })
    const pageErr = new ApiError('VALIDATION_FAILED', 400, 'x', [{ path: ['pages', 1, 'pageId'], message: 'Trang đã mất kết nối — kết nối lại để chọn', code: 'PAGE_DISCONNECTED' }])
    expect(serverCampaignErrors(pageErr, body)).toEqual({ fields: {}, pages: { [IG.id]: 'Trang đã mất kết nối — kết nối lại để chọn' }, step: 2 })
    expect(serverCampaignErrors(new ApiError('VERSION_CONFLICT', 409, 'x'), body)).toBeNull()
    expect(serverCampaignErrors(new ApiError('VALIDATION_FAILED', 400, 'x', [{ path: ['khac'], message: 'x' }]), body)).toBeNull()
  })
})
