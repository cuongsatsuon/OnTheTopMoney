// Read-model Tổng quan (Story 8.5, AD-18, AD-1): ghép từ hàm đọc của từng module, mỗi DTO đúng một hàm ghép. Chỉ đọc,
// không gọi Meta / OpenAI, không đọc nội dung tin ngoài xem trước có sẵn của `ConversationDto`.
// - `overview()` → `OverviewResponse`: hội thoại "Cần xử lý" (`inbox`, cùng `tabCondition`), bài lỗi + bài sắp đăng +
//   số bài chờ duyệt (`content`), trang sắp hết hạn / mất kết nối (`pages`), webhook ngừng nhận tin (`webhooks`), hạn mức AI
//   (`ai`), chiến dịch đang chạy / tạm dừng (`campaigns` + read-model chiến dịch). Số câu cố định — không N+1.
// - `overviewMetrics()` → `OverviewMetricsResponse`: cắt số liệu chính từ `analytics.performanceOverview` (cùng kỳ, cùng
//   phạm vi với màn Hiệu suất).
// Phạm vi giải bằng `pages.listPages` / `resolveScope` (nhóm / trang lạ → 404).
import {
  ALL_SCOPE,
  OVERVIEW_LIST_MAX,
  type OverviewMetricsResponse,
  type OverviewResponse,
  type PageDto,
  type PerformanceRange,
  type Scope,
} from '@ottm/shared'
import { getBudgetSummary } from '../../modules/ai/index.ts'
import { performanceOverview } from '../../modules/analytics/index.ts'
import { listCampaigns } from '../../modules/campaigns/index.ts'
import { countPendingSlots, listFailedPosts, listUpcomingPosts } from '../../modules/content/index.ts'
import { countConversations, listConversations } from '../../modules/inbox/index.ts'
import { listPages, resolveScope } from '../../modules/pages/index.ts'
import { getWebhookHealth, platformsForProduct } from '../../modules/webhooks/index.ts'
import type { Db } from '../../platform/db/index.ts'
import { campaignSummaries } from './campaigns.ts'

/** Trang cần kết nối lại: mất kết nối trước, sắp hết hạn sau (giữ thứ tự `listPages` trong mỗi nhóm). */
const ALERT_ORDER: Partial<Record<PageDto['connectionStatus'], number>> = { disconnected: 0, expiring: 1 }

export async function overview(db: Db, scope: Scope, now: Date): Promise<OverviewResponse> {
  const pages = await listPages(db, scope)
  const pageIds = pages.map((p) => p.id)
  // Target cùng bài ở trang khác (chưa gỡ) vẫn trả (AD-18); "Tất cả" thì chính là `pageIds`.
  const visiblePageIds = scope.kind === 'all' ? pageIds : await resolveScope(db, ALL_SCOPE)
  // Như `GET /campaigns`: "Tất cả" → mọi chiến dịch; nhóm / trang → giao `campaign_pages`.
  const active = (await listCampaigns(db, scope.kind === 'all' ? null : pageIds)).filter((c) => c.status === 'running' || c.status === 'paused')
  const posts = { pageIds, visiblePageIds, limit: OVERVIEW_LIST_MAX }
  const [needsCount, needsList, failedPosts, upcoming, pendingApproval, health, budget, campaigns] = await Promise.all([
    countConversations(db, pageIds, 'needs_human'),
    listConversations(db, pageIds, { tab: 'needs_human', limit: OVERVIEW_LIST_MAX }),
    listFailedPosts(db, posts),
    listUpcomingPosts(db, { ...posts, now }),
    countPendingSlots(db, { campaignIds: active.map((c) => c.id), pageIds }),
    getWebhookHealth(db, now),
    getBudgetSummary({ db, now: () => now }),
    campaignSummaries(db, active, now),
  ])
  const platforms = new Set(pages.map((p) => p.platform))
  return {
    needsHuman: { count: needsCount, items: needsList.items },
    failedPosts,
    pendingApproval,
    pageAlerts: pages
      .filter((p) => ALERT_ORDER[p.connectionStatus] !== undefined)
      .sort((a, b) => ALERT_ORDER[a.connectionStatus]! - ALERT_ORDER[b.connectionStatus]!),
    webhookStalled: health.products.filter((h) => h.status === 'stalled' && platformsForProduct(h.product).some((pf) => platforms.has(pf))).map((h) => h.product),
    aiBudget: { percent: budget.percent, state: budget.state, spentVnd: budget.spentVnd, limitVnd: budget.limitVnd },
    upcoming,
    campaigns,
  }
}

export async function overviewMetrics(db: Db, opts: { scope: Scope; range: PerformanceRange; now: Date }): Promise<OverviewMetricsResponse> {
  const p = await performanceOverview(db, opts)
  return {
    range: p.range,
    from: p.from,
    to: p.to,
    insufficientData: p.insufficientData,
    platforms: p.platforms,
    kpis: { reach: p.kpis.reach, engagement: p.kpis.engagement, messages: p.kpis.messages, followersDelta: p.kpis.followersDelta },
    series: p.series,
    customerMessages: p.ai.customerMessages,
    aiAnswered: p.ai.aiAnswered,
  }
}
