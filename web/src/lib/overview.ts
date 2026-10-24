// Tổng quan `/` phía web (Story 8.5): `GET /overview` (việc cần xử lý + bài sắp đăng + chiến dịch — khoá `['overview', …]`,
// hint realtime làm cũ là refetch ngay, xem `ENTITY_ALSO_INVALIDATES`) và `GET /overview/metrics` (số liệu chính — khoá
// `['overview_metrics', …]`, không theo realtime). Phạm vi chỉ có id kho mẫu (`serverScope` → `null`) → rỗng, không hỏi
// server. Phần thuần (danh sách việc cần xử lý theo mức gấp, câu, link) tách khỏi hook để test được (overview.test.ts).
import {
  OverviewMetricsResponse,
  OverviewResponse,
  type OverviewPostDto,
  type PageDto,
  type PauseReason,
  type PerformanceRange,
  type Scope,
  type TransitionTargetsRequest,
} from '@ottm/shared'
import { useQuery } from '@tanstack/react-query'
import { BUDGET_BANNER_TEXT } from './ai-budget'
import { apiFetch } from './api'
import { calendarHref } from './calendar'
import { serverScope } from './inbox'
import { percentOf } from './performance'
import { WEBHOOK_PRODUCT_LABEL, WEBHOOK_SETTINGS_PATH } from './webhooks'

export const OVERVIEW_ROOT_KEY = ['overview'] as const
export const overviewKey = (scope: string | null) => [...OVERVIEW_ROOT_KEY, scope] as const
export const overviewMetricsKey = (scope: string | null, range: PerformanceRange) => ['overview_metrics', scope, range] as const

/** Cài đặt › OpenAI (hạn mức chi phí AI). */
export const OPENAI_SETTINGS_PATH = '/cai-dat?section=openai'
export const CAMPAIGNS_PATH = '/chien-dich'

const NO_KPI = { current: null, previous: null }

/** Phạm vi không có trang thật: rỗng như server trả cho nhóm không có trang (hạn mức coi như chưa dùng). */
export function emptyOverview(): OverviewResponse {
  return {
    needsHuman: { count: 0, items: [] },
    failedPosts: { count: 0, items: [] },
    pendingApproval: 0,
    pageAlerts: [],
    webhookStalled: [],
    aiBudget: { percent: 0, state: 'ok', spentVnd: 0, limitVnd: 0 },
    upcoming: [],
    campaigns: [],
  }
}

export function emptyOverviewMetrics(range: PerformanceRange): OverviewMetricsResponse {
  return {
    range,
    from: '',
    to: '',
    insufficientData: false,
    platforms: [],
    kpis: { reach: NO_KPI, engagement: NO_KPI, messages: NO_KPI, followersDelta: NO_KPI },
    series: [],
    customerMessages: 0,
    aiAnswered: 0,
  }
}

export function useOverview(scope: Scope) {
  const param = serverScope(scope)
  return useQuery({
    queryKey: overviewKey(param),
    queryFn: ({ signal }) => {
      if (param === null) return Promise.resolve(emptyOverview())
      return apiFetch(`/overview?${new URLSearchParams({ scope: param })}`, { schema: OverviewResponse, signal })
    },
  })
}

export function useOverviewMetrics(scope: Scope, range: PerformanceRange) {
  const param = serverScope(scope)
  return useQuery({
    queryKey: overviewMetricsKey(param, range),
    queryFn: ({ signal }) => {
      if (param === null) return Promise.resolve(emptyOverviewMetrics(range))
      return apiFetch(`/overview/metrics?${new URLSearchParams({ scope: param, range })}`, { schema: OverviewMetricsResponse, signal })
    },
  })
}

/* ---------- Phần thuần ---------- */

/** Dòng phụ của KPI "Tin nhắn mới": "AI đã trả lời 81%" (Voice and Tone); chưa có tin khách → câu mô tả. */
export function aiRepliedHint(m: Pick<OverviewMetricsResponse, 'aiAnswered' | 'customerMessages'>): string {
  const pct = percentOf(m.aiAnswered, m.customerMessages)
  return pct === null ? 'khách nhắn và bình luận' : `AI đã trả lời ${pct}%`
}

/** Tiêu đề phụ của thẻ "Cần bạn xử lý". */
export const needsHumanText = (count: number): string | undefined => (count > 0 ? `${count} tin nhắn cần bạn xử lý` : undefined)

/** Lý do tự tạm dừng, ngắn cho một dòng việc cần xử lý (câu đầy đủ ở thẻ chiến dịch — `PAUSE_REASON_TEXT`). */
const PAUSE_SHORT: Record<Exclude<PauseReason, 'MANUAL'>, string> = {
  PAGE_DISCONNECTED: 'Trang trong chiến dịch mất kết nối',
  AI_BUDGET_EXCEEDED: 'Đã dùng hết hạn mức AI tháng này',
  PUBLISH_FAILURES: 'Nhiều bài đăng lỗi liên tiếp',
  CONFIG_MISSING: 'Trang chưa có hồ sơ thương hiệu',
  OPENAI_KEY_UNAVAILABLE: 'Khoá OpenAI chưa dùng được',
}

export type AttentionKind =
  | 'budget_blocked'
  | 'webhook'
  | 'page_disconnected'
  | 'campaign_paused'
  | 'post_failed'
  | 'posts_failed_more'
  | 'pending_approval'
  | 'page_expiring'
  | 'budget_warn'

/** Một việc cần xử lý: chữ + link tới đúng chỗ xử lý; trang cần kết nối lại / bài lỗi kèm dữ liệu cho nút ngay tại chỗ. */
export interface AttentionItem {
  key: string
  kind: AttentionKind
  tone: 'danger' | 'warning'
  title: string
  detail: string
  /** Chỗ xử lý (link nội bộ). */
  href: string
  /** "Kết nối lại" mở OAuth đúng trang. */
  page?: Pick<PageDto, 'id' | 'name' | 'platform'>
  /** "Đăng lại" các target lỗi của bài. */
  post?: OverviewPostDto
}

/** Tên bài trên một dòng: đầu caption; slot chưa viết → "AI sẽ viết · <chủ đề>"; không có gì → "Bài không có chữ". */
export function postLabel(p: Pick<OverviewPostDto, 'title' | 'topic'>): string {
  if (p.title) return p.title
  return p.topic ? `AI sẽ viết · ${p.topic}` : 'Bài không có chữ'
}

/**
 * Việc cần xử lý theo mức gấp (AI / nhận tin ngừng hẳn trước, nhắc nhở sau): hết hạn mức AI → webhook ngừng nhận tin →
 * trang mất kết nối → chiến dịch tự tạm dừng → bài đăng lỗi (tối đa số server trả + dòng "còn n bài") → bài chờ duyệt →
 * token sắp hết hạn → đã dùng ≥80% hạn mức. Hội thoại "Cần xử lý" hiện riêng bên dưới.
 */
export function attentionItems(data: OverviewResponse, pageName: (pageId: string) => string): AttentionItem[] {
  const out: AttentionItem[] = []
  const budgetHref = OPENAI_SETTINGS_PATH
  if (data.aiBudget.state === 'blocked') {
    out.push({
      key: 'budget',
      kind: 'budget_blocked',
      tone: 'danger',
      title: BUDGET_BANNER_TEXT,
      detail: 'AI ngừng trả lời và viết bài — tăng hạn mức để chạy lại',
      href: budgetHref,
    })
  }
  if (data.webhookStalled.length) {
    out.push({
      key: 'webhook',
      kind: 'webhook',
      tone: 'warning',
      title: `Chưa nhận tin mới 30 phút (${data.webhookStalled.map((p) => WEBHOOK_PRODUCT_LABEL[p]).join(', ')})`,
      detail: 'Kiểm tra webhook',
      href: WEBHOOK_SETTINGS_PATH,
    })
  }
  for (const p of data.pageAlerts.filter((x) => x.connectionStatus === 'disconnected')) {
    out.push({
      key: `page:${p.id}`,
      kind: 'page_disconnected',
      tone: 'danger',
      title: `${p.name} mất kết nối`,
      detail: 'Không nhận tin, không đăng bài được — kết nối lại trang',
      href: `/trang-nhom/trang/${p.id}`,
      page: p,
    })
  }
  for (const c of data.campaigns) {
    if (c.status !== 'paused' || !c.pauseReason || c.pauseReason === 'MANUAL') continue
    out.push({
      key: `campaign:${c.id}`,
      kind: 'campaign_paused',
      tone: 'warning',
      title: `Chiến dịch “${c.name}” tự tạm dừng`,
      detail: PAUSE_SHORT[c.pauseReason],
      href: CAMPAIGNS_PATH,
    })
  }
  for (const p of data.failedPosts.items) {
    const first = p.targets[0]!
    const pages = p.targets.map((t) => pageName(t.pageId)).join(', ')
    out.push({
      key: `post:${p.postId}`,
      kind: 'post_failed',
      tone: 'danger',
      title: postLabel(p),
      detail: `Đăng bài lỗi · ${pages}`,
      href: calendarHref(first.id, p.scheduledAt),
      post: p,
    })
  }
  const more = data.failedPosts.count - data.failedPosts.items.length
  if (more > 0) {
    out.push({ key: 'posts:more', kind: 'posts_failed_more', tone: 'danger', title: `Còn ${more} bài đăng lỗi khác`, detail: 'Xem trên Lịch nội dung', href: '/lich' })
  }
  if (data.pendingApproval > 0) {
    out.push({
      key: 'pending',
      kind: 'pending_approval',
      tone: 'warning',
      title: `${data.pendingApproval} bài chiến dịch chờ duyệt`,
      detail: 'Duyệt để bài được đăng đúng giờ',
      href: CAMPAIGNS_PATH,
    })
  }
  for (const p of data.pageAlerts.filter((x) => x.connectionStatus === 'expiring')) {
    out.push({
      key: `page:${p.id}`,
      kind: 'page_expiring',
      tone: 'warning',
      title: `Token của ${p.name} sắp hết hạn`,
      detail: 'Kết nối lại trước khi trang ngừng nhận tin',
      href: `/trang-nhom/trang/${p.id}`,
      page: p,
    })
  }
  if (data.aiBudget.state === 'warn') {
    out.push({
      key: 'budget',
      kind: 'budget_warn',
      tone: 'warning',
      title: `Đã dùng ${data.aiBudget.percent}% hạn mức AI tháng này`,
      detail: 'Tăng hạn mức nếu cần — hết hạn mức AI sẽ ngừng trả lời',
      href: budgetHref,
    })
  }
  return out
}

/** "Đăng lại ngay" mọi target lỗi của bài (một request cho cả bài — `POST /posts/:id/targets/transition`). */
export function retryCall(p: Pick<OverviewPostDto, 'postId' | 'targets'>): { postId: string; body: TransitionTargetsRequest } {
  return { postId: p.postId, body: { action: 'retry', scheduledAt: null, targets: p.targets.map((t) => ({ id: t.id, version: t.version })) } }
}
