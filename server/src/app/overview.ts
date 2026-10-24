// Tổng quan `/` (Story 8.5, AD-18, AD-3). Route dưới /api/v1 → guard auth đã yêu cầu phiên; chỉ đọc.
// - `GET /overview?scope=`: việc cần xử lý + bài sắp đăng + chiến dịch đang chạy (web làm cũ theo hint realtime).
// - `GET /overview/metrics?scope=&range=`: số liệu chính (số cron của `analytics`, không refetch theo realtime).
// Ghép ở `read-models/overview.ts`; route chỉ parse + kiểm hợp đồng shared. Phạm vi sai cú pháp → VALIDATION_FAILED,
// nhóm / trang lạ → 404.
import { ALL_SCOPE, OverviewMetricsQuery, OverviewMetricsResponse, OverviewQuery, OverviewResponse } from '@ottm/shared'
import type { FastifyInstance } from 'fastify'
import type { Db } from '../platform/db/index.ts'
import { overview, overviewMetrics } from './read-models/overview.ts'

export function registerOverview(app: FastifyInstance, deps: { db: Db; now?: () => Date }): void {
  const now = () => deps.now?.() ?? new Date()

  app.get('/api/v1/overview', async (req): Promise<OverviewResponse> => {
    const { scope } = OverviewQuery.parse(req.query ?? {})
    return OverviewResponse.parse(await overview(deps.db, scope ?? ALL_SCOPE, now()))
  })

  app.get('/api/v1/overview/metrics', async (req): Promise<OverviewMetricsResponse> => {
    const { scope, range } = OverviewMetricsQuery.parse(req.query ?? {})
    return OverviewMetricsResponse.parse(await overviewMetrics(deps.db, { scope: scope ?? ALL_SCOPE, range, now: now() }))
  })
}
