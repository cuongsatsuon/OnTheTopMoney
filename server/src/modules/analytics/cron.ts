// Cron thu số liệu (Story 8.1, AD-17, AD-24): `analytics.post_metrics` (mỗi 6 giờ) và `analytics.page_metrics` (hằng ngày)
// không gọi Meta — chỉ rải một job thu cho mỗi trang chưa gỡ và không mất kết nối. Mỗi trang hoãn `RATE_LIMITED` / retry
// riêng, một trang lỗi không chặn trang khác. Job thu chạy lại trùng (cron + job hoãn) vẫn an toàn: ghi bằng upsert.
import type { DbExecutor } from '../../platform/db/index.ts'
import type { JobSender } from '../../platform/jobs/index.ts'
import { listPages } from '../pages/index.ts'

export interface MetricsCronDeps {
  db: DbExecutor
  jobs: JobSender
}

async function fanOut(deps: MetricsCronDeps, queue: 'analytics.collect_posts' | 'analytics.collect_page'): Promise<number> {
  const pages = (await listPages(deps.db)).filter((p) => p.connectionStatus !== 'disconnected')
  for (const page of pages) await deps.jobs.send(queue, { pageId: page.id })
  return pages.length
}

/** Cron `analytics.post_metrics`: số job `analytics.collect_posts` đã rải. */
export const runPostMetricsCron = (deps: MetricsCronDeps) => fanOut(deps, 'analytics.collect_posts')

/** Cron `analytics.page_metrics`: số job `analytics.collect_page` đã rải. */
export const runPageMetricsCron = (deps: MetricsCronDeps) => fanOut(deps, 'analytics.collect_page')
