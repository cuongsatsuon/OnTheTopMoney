// Màn Hiệu suất (Story 8.2, AD-17, AD-18). Route dưới /api/v1 → guard auth đã yêu cầu phiên; chỉ đọc.
// - `GET /performance?scope=&range=`: KPI (+ kỳ trước), chuỗi tương tác theo nền tảng, bảng từng trang, bài tốt nhất —
//   tổng hợp ở `analytics` từ bảng nội bộ (không gọi Meta). Phạm vi giải bằng `pages.resolveScope` (qua `listPages`): sai
//   cú pháp → VALIDATION_FAILED, nhóm / trang không tồn tại → 404.
import { ALL_SCOPE, PerformanceQuery, type PerformanceResponse } from '@ottm/shared'
import type { FastifyInstance } from 'fastify'
import { performanceOverview } from '../modules/analytics/index.ts'
import type { Db } from '../platform/db/index.ts'

export function registerPerformance(app: FastifyInstance, deps: { db: Db; now?: () => Date }): void {
  app.get('/api/v1/performance', async (req): Promise<PerformanceResponse> => {
    const { scope, range } = PerformanceQuery.parse(req.query ?? {})
    return performanceOverview(deps.db, { scope: scope ?? ALL_SCOPE, range, now: deps.now?.() ?? new Date() })
  })
}
