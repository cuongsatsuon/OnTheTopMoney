// Trạng thái nội bộ dạng khoá → JSON trong `settings` (Story 9.3): cron lưu chỗ đang dở giữa hai lượt (vd con trỏ trang
// của lượt dọn file mồ côi `media_orphan_cursors`). Không phải cài đặt của chủ shop — không phát `settings.updated`.
import { eq, sql } from 'drizzle-orm'
import type { DbExecutor } from '../../platform/db/index.ts'
import { settings } from './schema.ts'

/** Giá trị đã lưu (chưa kiểm dạng — caller tự parse); chưa có → `undefined`. */
export async function getStateValue(db: DbExecutor, key: string): Promise<unknown> {
  const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, key))
  return row?.value
}

export async function setStateValue(db: DbExecutor, key: string, value: unknown): Promise<void> {
  await db
    .insert(settings)
    .values({ key, value })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: sql`now()` } })
}
