// Heartbeat của worker cho /healthz: upsert theo id phiên chạy, dọn dòng cũ > 1 ngày.
import os from 'node:os'
import { sql as dsql } from 'drizzle-orm'
import { schema, type Db } from '../platform/db/index.ts'

/** Nhịp heartbeat trong tiến trình; cron `platform.heartbeat` (1 phút) chạy song song để chứng minh pg-boss còn xử lý job. */
export const HEARTBEAT_INTERVAL_MS = 30_000

export async function writeHeartbeat(db: Db, instanceId: string): Promise<void> {
  const { workerHeartbeats } = schema
  await db
    .insert(workerHeartbeats)
    .values({ id: instanceId, hostname: os.hostname(), pid: process.pid })
    .onConflictDoUpdate({ target: workerHeartbeats.id, set: { beatAt: dsql`now()` } })
  await db.delete(workerHeartbeats).where(dsql`${workerHeartbeats.beatAt} < now() - interval '1 day'`)
}
