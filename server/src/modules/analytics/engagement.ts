// Tương tác tăng theo ngày của một tập bài (Story 8.5 — thẻ chiến dịch "Tương tác 7 ngày ±x%", việc hoãn từ 7.3). Chỉ đọc
// `post_metrics`; bên gọi (read-model chiến dịch) lấy id bài qua `content` rồi tự gom theo chiến dịch.
// - Snapshot là tổng TRỌN ĐỜI của bài tại ngày thu → mức của ngày D = snapshot mới nhất có `engagement` khác `null` với
//   `metric_date ≤ D`. Tăng của ngày D = mức D − mức D−1; chưa có mức trước (bài mới đăng) → cả mức; giảm (Meta chốt lại
//   số) → 0. Ngày không có snapshot → 0 (phần tăng dồn vào ngày có snapshot kế tiếp).
// - Hai câu cố định: mức nền ngay trước cửa sổ (`distinct on` theo PK `(post_target_id, metric_date)`) + snapshot trong cửa sổ.
import { and, desc, gte, inArray, isNotNull, lt, lte } from 'drizzle-orm'
import type { DbExecutor } from '../../platform/db/index.ts'
import { postMetrics } from './schema.ts'

const DAY_MS = 24 * 3_600_000
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00.000Z`) + n * DAY_MS).toISOString().slice(0, 10)

export interface EngagementGains {
  /** Tăng mỗi ngày của cửa sổ (cũ → mới), độ dài = `days`. */
  gains: number[]
  /** Chỉ số ngày đầu tiên bài đã có mức (0 = có từ trước cửa sổ); `null` = không có snapshot nào tới hết cửa sổ. */
  knownFrom: number | null
}

/** Tương tác tăng mỗi ngày VN `[from, from + days)` của từng target; target không có trong map = không có snapshot. */
export async function engagementGains(
  db: DbExecutor,
  targetIds: readonly string[],
  window: { from: string; days: number },
): Promise<Map<string, EngagementGains>> {
  const out = new Map<string, EngagementGains>()
  if (!targetIds.length || window.days <= 0) return out
  const to = addDays(window.from, window.days - 1)
  const ids = [...targetIds]
  const [base, rows] = await Promise.all([
    db
      .selectDistinctOn([postMetrics.postTargetId], { targetId: postMetrics.postTargetId, engagement: postMetrics.engagement })
      .from(postMetrics)
      .where(and(inArray(postMetrics.postTargetId, ids), lt(postMetrics.metricDate, window.from), isNotNull(postMetrics.engagement)))
      .orderBy(postMetrics.postTargetId, desc(postMetrics.metricDate)),
    db
      .select({ targetId: postMetrics.postTargetId, date: postMetrics.metricDate, engagement: postMetrics.engagement })
      .from(postMetrics)
      .where(
        and(
          inArray(postMetrics.postTargetId, ids),
          gte(postMetrics.metricDate, window.from),
          lte(postMetrics.metricDate, to),
          isNotNull(postMetrics.engagement),
        ),
      ),
  ])
  const levels = new Map<string, Map<number, number>>()
  const fromNo = Math.round(Date.parse(`${window.from}T00:00:00.000Z`) / DAY_MS)
  for (const r of rows) {
    const byDay = levels.get(r.targetId) ?? new Map<number, number>()
    byDay.set(Math.round(Date.parse(`${r.date}T00:00:00.000Z`) / DAY_MS) - fromNo, r.engagement!)
    levels.set(r.targetId, byDay)
  }
  const baseOf = new Map(base.map((b) => [b.targetId, b.engagement!]))
  for (const id of new Set([...baseOf.keys(), ...levels.keys()])) {
    let level = baseOf.get(id)
    let knownFrom: number | null = level === undefined ? null : 0
    const byDay = levels.get(id)
    const gains = Array.from({ length: window.days }, (_, i) => {
      const next = byDay?.get(i)
      if (next === undefined) return 0
      const gain = level === undefined ? next : Math.max(0, next - level)
      knownFrom ??= i
      level = next
      return gain
    })
    out.set(id, { gains, knownFrom })
  }
  return out
}
