// Story 7.1 phía web: form wizard → body, nạp lại nháp, trang chọn được (chế độ nhóm tự loại), tóm tắt (tổng bài, lịch
// nhiệt, bài có ảnh — Instagram luôn có ảnh), lỗi validate (web + server) → đúng bước + dưới ô, Phạm vi → đích ban đầu.
// Story 7.2: bước 4 xem trước (bài đang viết / đang tạo ảnh / sẵn sàng / đã bỏ, giờ VN, ghi chú theo mã lỗi, hành động
// được phép), `baseUpdatedAt`, SSE `post_target.*` làm cũ xem trước.
// Story 7.3: toast bắt đầu, lỗi bắt đầu (trang / ngày) → đúng bước, thẻ chiến dịch (tiến độ, "Bài tiếp theo", đếm tab,
// thẻ Tổng quan), SSE `campaign.*` làm cũ danh sách.
// Story 7.4: hàng đợi "Bài chờ duyệt" (quá giờ, chặn duyệt, "Duyệt tất cả", ô giờ mới, body duyệt, `SCHEDULE_IN_PAST`),
// vá cache xem trước từ `{slot}`, SSE `post_target.*` làm cũ hàng đợi.
import {
  CampaignDto,
  CampaignSummaryDto,
  SaveCampaignRequest,
  campaignImageRatio,
  campaignPostsOnDay,
  type CampaignPageOption,
  type CampaignSlotDto,
  type PageDto,
} from '@ottm/shared'
import { describe, expect, it } from 'vitest'
import { ApiError } from './api'
import { hintInvalidates } from './realtime'
import {
  CAMPAIGN_PAGE_OPTIONS_KEY,
  OVERDUE_TEXT,
  activePages,
  approveBlock,
  approveBody,
  approveInput,
  approvedToast,
  bulkApprovable,
  isOverdue,
  needsNewTime,
  patchPreview,
  pendingNote,
  pendingSlotsKey,
  slotTime,
  addDaysKey,
  activeCampaigns,
  autoName,
  buildCampaignBody,
  campaignCounts,
  campaignPct,
  campaignPreviewKey,
  campaignsListKey,
  dailyPlan,
  dayLabel,
  formFromCampaign,
  hasInstagram,
  initialForm,
  nextPostLabel,
  planTotals,
  previewView,
  serverCampaignErrors,
  slotCanCancel,
  slotCanEdit,
  slotNote,
  slotPhase,
  slotWhen,
  splitEven,
  deleteConfirmText,
  deletedToast,
  lifecycleToast,
  pausedNote,
  resumeErrorText,
  startCampaignErrors,
  startedToast,
  stepHasErrors,
  targetPages,
  topicSum,
  engagementText,
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
    const dto = CampaignDto.parse({ ...body, productImage: null, id: id(99), status: 'draft', startedAt: null, pauseReason: null, pausedAt: null, createdAt: '2026-10-24T03:00:00.000Z', updatedAt: '2026-10-24T03:00:00.000Z' })
    const again = formFromCampaign(dto)
    expect(buildCampaignBody(again, activePages(again, PAGES, OPTIONS), again.name)).toEqual(body)
  })

  it('chọn từng trang → groupId null; nạp lại về "Chọn từng trang"', () => {
    const f = form({ targetMode: 'pages', picked: [SOLO.id] })
    const body = buildCampaignBody(f, activePages(f, PAGES, OPTIONS), 'Tên')
    expect(body.groupId).toBeNull()
    const dto = CampaignDto.parse({ ...body, productImage: null, mode: 'review', id: id(98), status: 'draft', startedAt: null, pauseReason: null, pausedAt: null, createdAt: '2026-10-24T03:00:00.000Z', updatedAt: '2026-10-24T03:00:00.000Z' })
    expect(formFromCampaign(dto)).toMatchObject({ targetMode: 'pages', picked: [SOLO.id], groupId: null })
  })
})

describe('ảnh sản phẩm (Story 7.7)', () => {
  const IMAGE = { id: id(77), source: 'upload' as const, url: 'https://res.cloudinary.com/demo/image/upload/v1/ottm/public/sp.jpg', width: 800, height: 800, createdAt: '2026-10-24T02:00:00.000Z' }

  it('form mới không có ảnh → body `productImageId: null`; có ảnh → id ảnh; nạp lại nháp giữ ảnh (xem trước ở bước 3 / 4)', () => {
    const f = form()
    const active = activePages(f, PAGES, OPTIONS)
    expect(buildCampaignBody(f, active, 'Tên').productImageId).toBeNull()
    const body = buildCampaignBody({ ...f, productImage: IMAGE }, active, 'Tên')
    expect(body.productImageId).toBe(IMAGE.id)
    expect(SaveCampaignRequest.safeParse(body).success).toBe(true)
    const dto = CampaignDto.parse({ ...body, productImage: IMAGE, id: id(97), status: 'draft', startedAt: null, pauseReason: null, pausedAt: null, createdAt: '2026-10-24T03:00:00.000Z', updatedAt: '2026-10-24T03:00:00.000Z' })
    const again = formFromCampaign(dto)
    expect(again.productImage).toEqual(IMAGE)
    expect(buildCampaignBody(again, activePages(again, PAGES, OPTIONS), again.name).productImageId).toBe(IMAGE.id)
  })

  it('body cũ không có `productImageId` vẫn hợp lệ (= không ảnh); id không phải uuid → lỗi ở bước 3', () => {
    const { productImageId: _drop, ...old } = buildCampaignBody(form(), activePages(form(), PAGES, OPTIONS), 'Tên')
    expect(SaveCampaignRequest.parse(old).productImageId).toBeNull()
    const bad = { ...old, productImageId: 'abc' }
    expect(validateCampaign(bad, NOW)).toMatchObject({ step: 3, fields: { productImageId: 'Ảnh sản phẩm không hợp lệ' } })
  })

  it('server báo ảnh sản phẩm sai → về bước 3, câu dưới ô "Ảnh sản phẩm"', () => {
    const body = buildCampaignBody({ ...form(), productImage: IMAGE }, activePages(form(), PAGES, OPTIONS), 'Tên')
    const err = new ApiError('VALIDATION_FAILED', 400, 'Cấu hình chiến dịch không hợp lệ', [{ path: ['productImageId'], message: 'Ảnh sản phẩm không còn — tải ảnh lên lại' }])
    expect(serverCampaignErrors(err, body)).toMatchObject({ step: 3, fields: { productImageId: 'Ảnh sản phẩm không còn — tải ảnh lên lại' } })
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

/* ---------- Xem trước 7 bài đầu (Story 7.2) ---------- */

const slot = (over: Partial<CampaignSlotDto>): CampaignSlotDto => ({
  id: '0190a000-0000-7000-8000-0000000000c1',
  postId: '0190a000-0000-7000-8000-0000000000d1',
  pageId: '0190a000-0000-7000-8000-0000000000e1',
  slotAt: '2026-10-26T04:30:00.000Z',
  scheduledAt: null,
  topic: 'Mẹo hay',
  status: 'pending_approval',
  caption: 'Bài AI',
  aiCaption: true,
  media: [],
  imagePending: false,
  version: 2,
  errorCode: null,
  ...over,
})

describe('xem trước 7 bài đầu', () => {
  it('danh sách: bỏ bài đã xoá (đếm "Đã bỏ"), còn bài `planned` → đang viết; pha thẻ: viết / ảnh / sẵn sàng', () => {
    const writing = slot({ id: 'a', status: 'planned', caption: '', aiCaption: false })
    const imaging = slot({ id: 'b', status: 'planned', imagePending: true })
    const ready = slot({ id: 'c' })
    const failed = slot({ id: 'd', caption: '', errorCode: 'AI_PROVIDER_ERROR' })
    const removed = slot({ id: 'e', status: 'cancelled' })
    const view = previewView([writing, imaging, ready, failed, removed])
    expect(view.shown.map((s) => s.id)).toEqual(['a', 'b', 'c', 'd'])
    expect(view.removed).toBe(1)
    expect(view.generating).toBe(true)
    expect(previewView([ready, removed]).generating).toBe(false)
    expect([writing, imaging, ready, failed].map(slotPhase)).toEqual(['writing', 'image', 'ready', 'ready'])
  })

  it('giờ VN của slot; ghi chú theo mã (hậu kiểm, ảnh lỗi, thiếu hồ sơ, hết hạn mức); hành động được phép', () => {
    expect(slotWhen('2026-10-26T04:30:00.000Z')).toBe('T2, 26/10 · 11:30')
    expect(slotWhen('2026-10-25T17:30:00.000Z')).toBe('T2, 26/10 · 00:30')
    expect(slotNote(null)).toBeNull()
    expect(slotNote('AI_POLICY_BLOCKED')).toContain('Điều cần tránh')
    expect(slotNote('IMAGE_REJECTED')).toContain('openai từ chối mô tả này.')
    expect(slotNote('CONFIG_MISSING')).toContain('chưa có hồ sơ thương hiệu')
    expect(slotNote('AI_BUDGET_EXCEEDED')).toBeTruthy()
    expect([slotCanEdit(slot({})), slotCanCancel(slot({}))]).toEqual([true, true])
    expect([slotCanEdit(slot({ status: 'planned' })), slotCanCancel(slot({ status: 'planned' }))]).toEqual([false, true])
    expect([slotCanEdit(slot({ status: 'cancelled' })), slotCanCancel(slot({ status: 'cancelled' }))]).toEqual([false, false])
  })

  it('PUT mang `baseUpdatedAt` khi có (POST thì không); SSE `post_target.updated` làm cũ xem trước', () => {
    const form = initialForm({ kind: 'page', id: FB.id }, [], NOW)
    const active = activePages(form, PAGES, OPTIONS)
    expect(buildCampaignBody(form, active, 'Tên', '2026-10-24T01:00:00.000Z').baseUpdatedAt).toBe('2026-10-24T01:00:00.000Z')
    expect('baseUpdatedAt' in buildCampaignBody(form, active, 'Tên')).toBe(false)
    expect(SaveCampaignRequest.safeParse({ ...buildCampaignBody(form, active, 'Tên', 'hôm qua') }).success).toBe(false)
    expect(hintInvalidates(campaignPreviewKey('x')[0], 'post_target', 'post_target.updated')).toBe(true)
  })
})

describe('bắt đầu chiến dịch + danh sách (Story 7.3)', () => {
  const summary = (over: Partial<CampaignSummaryDto> = {}): CampaignSummaryDto =>
    CampaignSummaryDto.parse({
      ...buildCampaignBody(form({ targetMode: 'pages', picked: [FB.id] }), [FB], 'Nuôi page 30 ngày'),
      mode: 'review',
      productImage: null,
      id: id(90),
      status: 'running',
      startedAt: '2026-10-24T03:00:00.000Z',
      pauseReason: null,
      pausedAt: null,
      createdAt: '2026-10-23T03:00:00.000Z',
      updatedAt: '2026-10-24T03:00:00.000Z',
      postsTotal: 30,
      postsDone: 0,
      postsPending: 6,
      nextPost: '2026-10-25T04:30:00.000Z',
      trend: [0, 0, 0, 0, 0, 0, 0],
      engagement7d: { current: null, previous: null },
      daysDone: 0,
      ...over,
    })

  it('Story 7.5: lý do tạm dừng trên thẻ, toast tạm dừng / tiếp tục (bài lỡ giờ), câu lỗi tiếp tục theo mã, xác nhận + toast xoá', () => {
    expect(pausedNote(summary({ status: 'paused', pauseReason: 'MANUAL', pausedAt: '2026-10-24T03:00:00.000Z' }))).toBe(
      'Bạn đã tạm dừng chiến dịch — không bài nào được đăng cho tới khi tiếp tục.',
    )
    expect(pausedNote(summary({ status: 'paused', pauseReason: 'PAGE_DISCONNECTED', pausedAt: '2026-10-24T03:00:00.000Z' }))).toBe(
      'Tự tạm dừng: trang trong chiến dịch mất kết nối. Kết nối lại rồi tiếp tục.',
    )
    expect(pausedNote(summary({ status: 'paused' }))).toBe('Chiến dịch đang tạm dừng.')
    const paused = summary({ status: 'paused', pauseReason: 'MANUAL', pausedAt: '2026-10-24T03:00:00.000Z' })
    expect(lifecycleToast('pause', { campaign: paused, changed: true, missed: 0 })).toBe('Đã tạm dừng “Nuôi page 30 ngày” — không bài nào được đăng cho tới khi tiếp tục')
    expect(lifecycleToast('pause', { campaign: paused, changed: false, missed: 0 })).toBe('“Nuôi page 30 ngày” đã tạm dừng từ trước')
    expect(lifecycleToast('resume', { campaign: summary(), changed: true, missed: 3 })).toBe('Đã tiếp tục “Nuôi page 30 ngày” — bỏ 3 bài lỡ giờ trong lúc dừng')
    expect(lifecycleToast('resume', { campaign: summary(), changed: true, missed: 0 })).toBe('Đã tiếp tục “Nuôi page 30 ngày”')
    expect(lifecycleToast('resume', { campaign: summary(), changed: false, missed: 0 })).toBe('“Nuôi page 30 ngày” đang chạy')
    expect(resumeErrorText(new ApiError('PAGE_DISCONNECTED', 409, 'x'))).toContain('vẫn mất kết nối')
    expect(resumeErrorText(new ApiError('CONFIG_MISSING', 409, 'x'))).toContain('hồ sơ thương hiệu')
    expect(resumeErrorText(new ApiError('AI_BUDGET_EXCEEDED', 409, 'x'))).toContain('Hạn mức AI tháng này vẫn hết')
    expect(resumeErrorText(new ApiError('VERSION_CONFLICT', 409, 'x'))).toBe('Dữ liệu vừa được thay đổi ở nơi khác. Tải lại để xem bản mới nhất.')
    expect(deleteConfirmText(summary())).toContain('Bài đã đăng vẫn giữ nguyên trên trang')
    expect(deleteConfirmText(summary({ status: 'draft', startedAt: null }))).toBe('Nháp “Nuôi page 30 ngày” và các bài xem trước sẽ bị xoá. Không hoàn tác được.')
    expect(deletedToast('Nuôi page', { cancelled: 28, kept: 2 })).toBe('Đã xoá “Nuôi page” — huỷ 28 bài chưa đăng, giữ 2 bài đã đăng')
    expect(deletedToast('Nháp', { cancelled: 7, kept: 0 })).toBe('Đã xoá “Nháp” — huỷ 7 bài chưa đăng')
    // SSE `campaign.deleted` làm cũ danh sách chiến dịch + Lịch như các sự kiện `campaign.*` khác.
    expect(hintInvalidates('campaigns', 'campaign', 'campaign.deleted')).toBe(true)
    expect(hintInvalidates('post_targets', 'campaign', 'campaign.deleted')).toBe(true)
  })

  it('Story 7.6: lý do khoá OpenAI trên thẻ, câu lỗi tiếp tục khi khoá vẫn chưa dùng được', () => {
    expect(pausedNote(summary({ status: 'paused', pauseReason: 'OPENAI_KEY_UNAVAILABLE', pausedAt: '2026-10-24T03:00:00.000Z' }))).toContain('khoá OpenAI chưa dùng được')
    expect(pausedNote(summary({ status: 'paused', pauseReason: 'PUBLISH_FAILURES', pausedAt: '2026-10-24T03:00:00.000Z' }))).toContain('đăng lỗi liên tiếp')
    for (const code of ['OPENAI_KEY_MISSING', 'OPENAI_KEY_INVALID', 'OPENAI_KEY_RESTRICTED'] as const) {
      expect(resumeErrorText(new ApiError(code, 409, 'x'))).toBe('Khoá OpenAI vẫn chưa dùng được — cập nhật khoá ở Cài đặt › OpenAI rồi tiếp tục.')
    }
  })

  it('toast: bắt đầu "0/N bài trên Lịch" / đã bắt đầu từ trước', () => {
    expect(startedToast({ campaign: summary(), alreadyStarted: false })).toBe('Đã bắt đầu “Nuôi page 30 ngày” — 30 bài trên Lịch nội dung')
    expect(startedToast({ campaign: summary(), alreadyStarted: true })).toBe('“Nuôi page 30 ngày” đã bắt đầu từ trước')
  })

  it('lỗi bắt đầu (trang mất kết nối / ngày đã qua) → về bước 2 / 1 như khi lưu', () => {
    const body = buildCampaignBody(form({ targetMode: 'pages', picked: [FB.id, IG.id] }), [FB, IG], 'Tên')
    const pageErr = new ApiError('VALIDATION_FAILED', 400, 'x', [{ path: ['pages', 1, 'pageId'], message: 'Trang đã mất kết nối — kết nối lại để chọn', code: 'PAGE_DISCONNECTED' }])
    expect(serverCampaignErrors(pageErr, body)).toMatchObject({ step: 2, pages: { [IG.id]: 'Trang đã mất kết nối — kết nối lại để chọn' } })
    const dateErr = new ApiError('VALIDATION_FAILED', 400, 'x', [{ path: ['startDate'], message: 'Ngày bắt đầu đã qua' }])
    expect(serverCampaignErrors(dateErr, body)).toMatchObject({ step: 1, fields: { startDate: 'Ngày bắt đầu đã qua' } })
  })

  it('lỗi bắt đầu theo trang đánh chỉ số theo trang ĐÃ LƯU: form đã bỏ trang vừa mất kết nối thì câu lỗi không rơi sang trang khác', () => {
    // Đã lưu [IG, FB]; IG mất kết nối → form chỉ còn FB (`activePages`), server báo `pages[0]` = IG.
    const body = buildCampaignBody(form({ targetMode: 'pages', picked: [IG.id, FB.id] }), [FB], 'Tên')
    const saved = { pages: [IG, FB].map((p) => ({ pageId: p.id, frequency: null })) }
    const err = new ApiError('VALIDATION_FAILED', 400, 'x', [{ path: ['pages', 0, 'pageId'], message: 'Trang đã mất kết nối — kết nối lại để chọn', code: 'PAGE_DISCONNECTED' }])
    expect(startCampaignErrors(err, body, saved)).toEqual({ fields: {}, pages: { [IG.id]: 'Trang đã mất kết nối — kết nối lại để chọn' }, step: 2 })
    expect(startCampaignErrors(err, body, undefined)).toMatchObject({ pages: { [FB.id]: expect.any(String) } })
  })

  it('thẻ: % theo bài, "Bài tiếp theo" theo giờ VN / trạng thái, tổng bài 7 ngày', () => {
    expect(campaignPct(summary())).toBe(0)
    expect(campaignPct(summary({ postsDone: 12, postsTotal: 30 }))).toBe(40)
    expect(campaignPct(summary({ postsTotal: 0 }))).toBe(0)
    expect(nextPostLabel(summary(), NOW)).toBe('Mai 11:30')
    expect(nextPostLabel(summary({ nextPost: '2026-10-24T12:30:00.000Z' }), NOW)).toBe('Hôm nay 19:30')
    expect(nextPostLabel(summary({ nextPost: '2026-10-26T04:30:00.000Z' }), NOW)).toBe('T2, 26/10 · 11:30')
    expect(nextPostLabel(summary({ nextPost: null }), NOW)).toBe('Chưa có bài sắp đăng')
    expect(nextPostLabel(summary({ status: 'draft', startedAt: null }), NOW)).toBe('Chưa bắt đầu')
    expect(nextPostLabel(summary({ status: 'paused' }), NOW)).toBe('Đang tạm dừng')
  })

  it('Story 8.5: dòng tương tác 7 ngày của thẻ — chưa có số liệu / chưa đủ kỳ so / tăng / giảm', () => {
    expect(engagementText(summary({}))).toBe('Chưa có số liệu tương tác')
    expect(engagementText(summary({ engagement7d: { current: 1234, previous: null } }))).toBe('Tương tác 7 ngày: 1.234')
    expect(engagementText(summary({ engagement7d: { current: 112, previous: 100 } }))).toBe('Tương tác 7 ngày: 112 · +12%')
    expect(engagementText(summary({ engagement7d: { current: 75, previous: 100 } }))).toBe('Tương tác 7 ngày: 75 · -25%')
    expect(engagementText(summary({ engagement7d: { current: 0, previous: 0 } }))).toBe('Tương tác 7 ngày: 0')
  })

  it('đếm tab; Tổng quan chỉ lấy đang chạy + tạm dừng; khoá danh sách theo phạm vi; SSE campaign.* làm cũ', () => {
    const items = [summary(), summary({ id: id(91), status: 'draft', startedAt: null }), summary({ id: id(92), status: 'paused' })]
    expect(campaignCounts(items)).toEqual({ all: 3, draft: 1, running: 1, paused: 1, done: 0 })
    expect(activeCampaigns(items).map((c) => c.id)).toEqual([id(90), id(92)])
    const key = campaignsListKey('all')
    expect(key).toEqual(['campaigns', 'list', 'all'])
    expect(hintInvalidates(key[0], 'campaign')).toBe(true)
    expect(hintInvalidates(key[0], 'post_target')).toBe(true)
  })
})

describe('hàng đợi "Bài chờ duyệt" (Story 7.4)', () => {
  // NOW = 10:00 24/10 giờ VN; bài 11:30 ngày 24 còn 90 phút.
  const at = (iso: string) => slot({ scheduledAt: iso })
  it('quá giờ = đã qua hoặc còn dưới 2 phút (theo `scheduledAt`, thiếu thì `slotAt`); ghi chú quá giờ trước mã lỗi', () => {
    expect(isOverdue(at('2026-10-24T04:30:00.000Z'), NOW)).toBe(false)
    expect(isOverdue(at('2026-10-24T03:01:59.000Z'), NOW)).toBe(true)
    expect(isOverdue(at('2026-10-24T02:00:00.000Z'), NOW)).toBe(true)
    expect(isOverdue(slot({ scheduledAt: null, slotAt: '2026-10-23T04:30:00.000Z' }), NOW)).toBe(true)
    expect(slotTime(slot({ scheduledAt: '2026-10-27T12:00:00.000Z' }))).toBe('2026-10-27T12:00:00.000Z')
    expect(pendingNote(at('2026-10-24T02:00:00.000Z'), NOW)).toBe(`${OVERDUE_TEXT}.`)
    expect(pendingNote({ ...at('2026-10-25T04:30:00.000Z'), errorCode: 'AI_POLICY_BLOCKED' }, NOW)).toContain('Điều cần tránh')
    expect(pendingNote(at('2026-10-25T04:30:00.000Z'), NOW)).toBeNull()
  })

  it('chặn duyệt: chưa có nội dung → "Tạo lại"; hậu kiểm chặn → sửa trước; "Duyệt tất cả" chỉ bài không lỗi, chưa quá giờ', () => {
    const ok = slot({ id: 'ok', scheduledAt: '2026-10-25T04:30:00.000Z' })
    const empty = slot({ id: 'empty', caption: '', errorCode: 'AI_BUDGET_EXCEEDED', scheduledAt: '2026-10-25T04:30:00.000Z' })
    const blocked = slot({ id: 'blocked', errorCode: 'AI_POLICY_BLOCKED', scheduledAt: '2026-10-25T04:30:00.000Z' })
    const late = slot({ id: 'late', scheduledAt: '2026-10-24T02:00:00.000Z' })
    expect(approveBlock(ok)).toBeNull()
    expect(approveBlock(empty)).toContain('Tạo lại')
    expect(approveBlock(blocked)).toBe('Sửa bài trước khi duyệt.')
    expect(bulkApprovable([ok, empty, blocked, late], NOW).map((s) => s.id)).toEqual(['ok'])
  })

  it('ô giờ: quá giờ → 19:00 tới gần nhất, còn giờ → giờ của bài; body chỉ mang `scheduledAt` khi đổi giờ; `SCHEDULE_IN_PAST` → hỏi giờ mới', () => {
    expect(approveInput(at('2026-10-24T02:00:00.000Z'), NOW)).toEqual({ date: '2026-10-24', time: '19:00' })
    expect(approveInput(at('2026-10-25T04:30:00.000Z'), NOW)).toEqual({ date: '2026-10-25', time: '11:30' })
    const s = slot({ version: 4, scheduledAt: '2026-10-25T04:30:00.000Z' })
    expect(approveBody(s)).toEqual({ action: 'approve', version: 4 })
    expect(approveBody(s, '2026-10-25T04:30:00.000Z')).toEqual({ action: 'approve', version: 4 })
    expect(approveBody(s, '2026-10-25T12:00:00.000Z')).toEqual({ action: 'approve', version: 4, scheduledAt: '2026-10-25T12:00:00.000Z' })
    expect(needsNewTime(new ApiError('SCHEDULE_IN_PAST', 422, 'x'))).toBe(true)
    expect(needsNewTime(new ApiError('VERSION_CONFLICT', 409, 'x'))).toBe(false)
    expect(approvedToast(at('2026-10-24T12:30:00.000Z'), NOW)).toBe('Đã duyệt — bài sẽ đăng Hôm nay 19:30')
  })

  it('vá cache xem trước bằng slot trả về; khoá hàng đợi theo phạm vi; SSE `post_target.updated` làm cũ hàng đợi', () => {
    const a = slot({ id: 'a', status: 'planned', caption: '' })
    const b = slot({ id: 'b' })
    const patched = patchPreview({ items: [a, b], generating: true }, { ...a, status: 'pending_approval', caption: 'Xong' })
    expect(patched.items.map((s) => [s.id, s.status])).toEqual([
      ['a', 'pending_approval'],
      ['b', 'pending_approval'],
    ])
    expect(patched.generating).toBe(false)
    const key = pendingSlotsKey('page:x')
    expect(key).toEqual(['campaigns', 'pending', 'page:x'])
    expect(hintInvalidates(key[0], 'post_target', 'post_target.updated')).toBe(true)
  })
})
