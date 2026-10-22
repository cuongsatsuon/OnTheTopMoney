// Cài port `RateStore` của adapters/meta bằng bảng `meta_rate_state` (AD-1: bảng thuộc `connections`,
// adapter không biết DB). Api và worker dùng chung bảng nên ngân sách tần suất đúng cho cả hai tiến trình.
import { eq, sql } from 'drizzle-orm'
import type { RateBucketState, RateStore } from '../../adapters/meta/index.ts'
import type { DbExecutor } from '../../platform/db/index.ts'
import { metaRateState } from './schema.ts'

export function createRateStore(db: DbExecutor): RateStore {
  return {
    async get(scope) {
      const rows = await db
        .select({
          bucket: metaRateState.bucket,
          usagePct: metaRateState.usagePct,
          blockedUntil: metaRateState.blockedUntil,
          updatedAt: metaRateState.updatedAt,
        })
        .from(metaRateState)
        .where(eq(metaRateState.scope, scope))
      return rows
    },

    async record(scope, state: RateBucketState) {
      const values = {
        scope,
        bucket: state.bucket,
        usagePct: Math.max(0, state.usagePct),
        blockedUntil: state.blockedUntil,
        updatedAt: state.updatedAt,
      }
      await db
        .insert(metaRateState)
        .values(values)
        .onConflictDoUpdate({
          target: [metaRateState.scope, metaRateState.bucket],
          set: { usagePct: values.usagePct, blockedUntil: values.blockedUntil, updatedAt: values.updatedAt },
          // Phản hồi đến lệch thứ tự (api và worker gọi song song) không ghi đè số mới hơn.
          setWhere: sql`${metaRateState.updatedAt} <= excluded.updated_at`,
        })
    },
  }
}
