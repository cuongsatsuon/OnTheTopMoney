// Cài đặt thông báo (Story 1.4): bật/tắt từng loại, lưu ở `settings` khoá `notification_prefs`.
// Đổi cài đặt → phát `settings.updated` trong cùng transaction (AD-3).
import { DEFAULT_NOTIFICATION_PREFS, NotificationPrefs } from '@ottm/shared'
import { eq, sql } from 'drizzle-orm'
import type { Db, DbExecutor } from '../../platform/db/index.ts'
import type { EventPublisher } from '../../platform/events/index.ts'
import { settings } from './schema.ts'

export const NOTIFICATION_PREFS_KEY = 'notification_prefs'

/**
 * Cài đặt hiện tại; chưa lưu lần nào → mặc định. Giá trị lưu thiếu khoá (loại mới thêm sau) → lấy
 * mặc định cho khoá đó; giá trị hỏng → mặc định.
 */
export async function getNotificationPrefs(db: DbExecutor): Promise<NotificationPrefs> {
  const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, NOTIFICATION_PREFS_KEY))
  if (!row || typeof row.value !== 'object' || row.value === null) return { ...DEFAULT_NOTIFICATION_PREFS }
  const parsed = NotificationPrefs.safeParse({ ...DEFAULT_NOTIFICATION_PREFS, ...(row.value as object) })
  return parsed.success ? parsed.data : { ...DEFAULT_NOTIFICATION_PREFS }
}

export async function setNotificationPrefs(
  db: Db,
  events: EventPublisher,
  prefs: NotificationPrefs,
): Promise<NotificationPrefs> {
  const value = NotificationPrefs.parse(prefs)
  await db.transaction(async (tx) => {
    await tx
      .insert(settings)
      .values({ key: NOTIFICATION_PREFS_KEY, value })
      .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: sql`now()` } })
    await events.publishEvent(tx, 'settings.updated', { id: NOTIFICATION_PREFS_KEY, keys: [NOTIFICATION_PREFS_KEY] })
  })
  return value
}
