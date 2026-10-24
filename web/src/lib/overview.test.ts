// Story 8.5 phía web — helper thuần của Tổng quan: việc cần xử lý theo mức gấp kèm link / hành động đúng chỗ xử lý, câu
// "N tin nhắn cần bạn xử lý" / "AI đã trả lời X%", tên bài một dòng, request "Đăng lại", khoá query dưới gốc `overview`
// (hint realtime làm cũ) và rỗng khi phạm vi chỉ có id kho mẫu.
import { OverviewResponse, TransitionTargetsRequest, type CampaignSummaryDto, type OverviewPostDto, type PageDto } from '@ottm/shared'
import { describe, expect, it } from 'vitest'
import {
  OPENAI_SETTINGS_PATH,
  aiRepliedHint,
  attentionItems,
  emptyOverview,
  emptyOverviewMetrics,
  needsHumanText,
  overviewKey,
  overviewMetricsKey,
  postLabel,
  retryCall,
} from './overview'
import { hintInvalidates } from './realtime'
import { WEBHOOK_SETTINGS_PATH } from './webhooks'

const id = (n: number) => `0199c0de-0000-7000-8000-${String(n).padStart(12, '0')}`
const T = '2026-10-31T12:00:00.000Z' // 19:00 Thứ Bảy 31/10 giờ VN

const page = (n: number, connectionStatus: PageDto['connectionStatus']): PageDto => ({
  id: id(n),
  platform: 'facebook',
  name: `Trang ${n}`,
  handle: null,
  avatarUrl: null,
  groupId: null,
  connectionStatus,
  connectedAt: '2026-01-01T00:00:00.000Z',
})

const failed = (n: number): OverviewPostDto => ({
  postId: id(200 + n),
  status: 'failed',
  scheduledAt: T,
  targets: [
    { id: id(300 + n), pageId: id(1), version: 3, errorCode: 'PUBLISH_FAILED' },
    { id: id(400 + n), pageId: id(2), version: 5, errorCode: 'PUBLISH_REJECTED' },
  ],
  title: `Bài ${n}`,
  topic: null,
  thumbnailUrl: null,
  ai: false,
  source: 'manual',
  campaignId: null,
})

const campaign = (over: Partial<CampaignSummaryDto>): CampaignSummaryDto => ({
  id: id(500),
  name: 'Gia dụng 30 ngày',
  goal: 'engage',
  status: 'running',
  mode: 'review',
  startDate: '2026-10-20',
  durationDays: 30,
  groupId: null,
  defaultFrequency: '1_per_day',
  pages: [],
  topics: [],
  postTimes: ['11:30'],
  imageRatio: 0,
  startedAt: '2026-10-20T03:00:00.000Z',
  pauseReason: null,
  pausedAt: null,
  createdAt: '2026-10-19T03:00:00.000Z',
  updatedAt: '2026-10-20T03:00:00.000Z',
  postsTotal: 30,
  postsDone: 4,
  postsPending: 0,
  nextPost: null,
  trend: [0, 0, 0, 0, 0, 0, 0],
  engagement7d: { current: null, previous: null },
  daysDone: 4,
  ...over,
})

const names = new Map([
  [id(1), 'Gia dụng Minh Phát'],
  [id(2), 'Minh Phát IG'],
])
const pageName = (pid: string) => names.get(pid) ?? 'Trang đã gỡ'

describe('attentionItems', () => {
  it('đủ loại → đúng thứ tự mức gấp, mỗi mục có link / hành động đúng chỗ xử lý', () => {
    const data: OverviewResponse = {
      ...emptyOverview(),
      aiBudget: { percent: 100, state: 'blocked', spentVnd: 1_000_000, limitVnd: 1_000_000 },
      webhookStalled: ['meta', 'threads'],
      pageAlerts: [page(7, 'disconnected'), page(8, 'expiring')],
      campaigns: [
        campaign({ id: id(501), name: 'Tự dừng', status: 'paused', pauseReason: 'PAGE_DISCONNECTED', pausedAt: T }),
        campaign({ id: id(502), name: 'Tôi dừng', status: 'paused', pauseReason: 'MANUAL', pausedAt: T }),
        campaign({ id: id(503) }),
      ],
      failedPosts: { count: 3, items: [failed(1), failed(2)] },
      pendingApproval: 4,
    }
    const items = attentionItems(data, pageName)
    expect(items.map((i) => i.kind)).toEqual([
      'budget_blocked',
      'webhook',
      'page_disconnected',
      'campaign_paused',
      'post_failed',
      'post_failed',
      'posts_failed_more',
      'pending_approval',
      'page_expiring',
    ])
    expect(items[0]).toMatchObject({ tone: 'danger', title: 'Đã dùng hết hạn mức AI tháng này', href: OPENAI_SETTINGS_PATH })
    expect(items[1]).toMatchObject({ title: 'Chưa nhận tin mới 30 phút (Facebook / Instagram, Threads)', href: WEBHOOK_SETTINGS_PATH })
    expect(items[2]).toMatchObject({ title: 'Trang 7 mất kết nối', href: `/trang-nhom/trang/${id(7)}`, page: { id: id(7) } })
    expect(items[3]).toMatchObject({ title: 'Chiến dịch “Tự dừng” tự tạm dừng', detail: 'Trang trong chiến dịch mất kết nối', href: '/chien-dich' })
    expect(items[4]).toMatchObject({
      title: 'Bài 1',
      detail: 'Đăng bài lỗi · Gia dụng Minh Phát, Minh Phát IG',
      href: `/lich?bai=${id(301)}&ngay=2026-10-31`,
      post: { postId: id(201) },
    })
    expect(items[6]).toMatchObject({ title: 'Còn 1 bài đăng lỗi khác', href: '/lich' })
    expect(items[7]).toMatchObject({ title: '4 bài chiến dịch chờ duyệt', href: '/chien-dich' })
    expect(items[8]).toMatchObject({ tone: 'warning', title: 'Token của Trang 8 sắp hết hạn', page: { id: id(8) } })
    expect(new Set(items.map((i) => i.key)).size).toBe(items.length)
  })

  it('hạn mức 80% chỉ nhắc cuối danh sách; không có gì → rỗng', () => {
    expect(attentionItems(emptyOverview(), pageName)).toEqual([])
    const warn = attentionItems({ ...emptyOverview(), aiBudget: { percent: 85, state: 'warn', spentVnd: 850_000, limitVnd: 1_000_000 } }, pageName)
    expect(warn).toEqual([expect.objectContaining({ kind: 'budget_warn', tone: 'warning', title: 'Đã dùng 85% hạn mức AI tháng này', href: OPENAI_SETTINGS_PATH })])
  })
})

describe('câu và request', () => {
  it('"N tin nhắn cần bạn xử lý", "AI đã trả lời X%", tên bài một dòng', () => {
    expect(needsHumanText(4)).toBe('4 tin nhắn cần bạn xử lý')
    expect(needsHumanText(0)).toBeUndefined()
    expect(aiRepliedHint({ aiAnswered: 81, customerMessages: 100 })).toBe('AI đã trả lời 81%')
    expect(aiRepliedHint({ aiAnswered: 0, customerMessages: 0 })).toBe('khách nhắn và bình luận')
    expect(postLabel({ title: 'Ưu đãi', topic: 'Mẹo hay' })).toBe('Ưu đãi')
    expect(postLabel({ title: null, topic: 'Mẹo hay' })).toBe('AI sẽ viết · Mẹo hay')
    expect(postLabel({ title: null, topic: null })).toBe('Bài không có chữ')
  })

  it('"Đăng lại" gửi mọi target lỗi của bài kèm version, đăng ngay — hợp đồng server nhận', () => {
    const call = retryCall(failed(1))
    expect(call.postId).toBe(id(201))
    expect(TransitionTargetsRequest.parse(call.body)).toEqual({
      action: 'retry',
      scheduledAt: null,
      targets: [
        { id: id(301), version: 3 },
        { id: id(401), version: 5 },
      ],
    })
  })
})

describe('khoá query + rỗng', () => {
  it('việc cần xử lý dưới gốc `overview` (hint làm cũ), số liệu chính gốc riêng; rỗng hợp lệ theo hợp đồng', () => {
    expect(overviewKey('group:g1')).toEqual(['overview', 'group:g1'])
    expect(overviewMetricsKey('all', '7d')).toEqual(['overview_metrics', 'all', '7d'])
    expect(hintInvalidates(overviewKey('all')[0], 'post_target')).toBe(true)
    expect(hintInvalidates(overviewMetricsKey('all', '7d')[0], 'post_target')).toBe(false)
    expect(OverviewResponse.parse(emptyOverview())).toEqual(emptyOverview())
    expect(emptyOverviewMetrics('30d')).toMatchObject({ range: '30d', platforms: [], series: [], customerMessages: 0 })
  })
})
