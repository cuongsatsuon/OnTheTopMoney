// Nghiệp vụ trang (Story 2.2). Module nền: không gọi module nào.
// - `upsertFromPlatform`, `setConnectionStatus`: CHỈ `connections` được gọi (AD-5: trạng thái tính ở
//   `connections`, lưu ở đây). Cả hai nhận executor để chạy trong transaction của bên gọi.
// - `listPages`, `getPage`: đọc cho api và module khác.
import type { ConnectionStatus, PageDto, Platform } from '@ottm/shared'
import { and, asc, eq, getTableColumns, isNull, sql } from 'drizzle-orm'
import type { DbExecutor } from '../../platform/db/index.ts'
import { pages } from './schema.ts'

export interface PlatformAccount {
  platform: Platform
  platformAccountId: string
  name: string
  handle: string | null
  avatarUrl: string | null
}

export interface UpsertedPage {
  page: PageDto
  /** true → dòng mới (suy từ chính câu INSERT: `xmax = 0`, đúng cả khi hai lần xác nhận chạy song song). */
  created: boolean
  /** Dòng cũ đang ở trạng thái đã gỡ (`removed_at` khác NULL) trước lần upsert này. */
  wasRemoved: boolean
  /** Trạng thái kết nối của dòng cũ trước lần upsert này (`null` khi dòng mới). */
  previousStatus: ConnectionStatus | null
}

type Row = typeof pages.$inferSelect

export function toPageDto(row: Row): PageDto {
  return {
    id: row.id,
    platform: row.platform as Platform,
    name: row.name,
    handle: row.handle,
    avatarUrl: row.avatarUrl,
    connectionStatus: row.connectionStatus as ConnectionStatus,
    connectedAt: row.connectedAt.toISOString(),
  }
}

/**
 * Tạo trang mới hoặc khôi phục dòng cũ theo `UNIQUE(platform, platform_account_id)`: cập nhật tên/handle/ảnh,
 * xoá `removed_at`. `connected_at` chỉ đặt lại khi trang đã gỡ hoặc mất kết nối (trang chưa từng rời giữ mốc cũ).
 * Giữ id, `group_id` và mọi dữ liệu gắn với trang.
 * Trạng thái kết nối KHÔNG đổi ở đây — bên gọi (`connections`) đặt bằng `setConnectionStatus`.
 */
export async function upsertFromPlatform(tx: DbExecutor, account: PlatformAccount): Promise<UpsertedPage> {
  const [before] = await tx
    .select({ id: pages.id, removedAt: pages.removedAt, connectionStatus: pages.connectionStatus })
    .from(pages)
    .where(and(eq(pages.platform, account.platform), eq(pages.platformAccountId, account.platformAccountId)))
    .for('update')
  const [row] = await tx
    .insert(pages)
    .values({
      platform: account.platform,
      platformAccountId: account.platformAccountId,
      name: account.name,
      handle: account.handle,
      avatarUrl: account.avatarUrl,
    })
    .onConflictDoUpdate({
      target: [pages.platform, pages.platformAccountId],
      set: {
        name: account.name,
        handle: account.handle,
        avatarUrl: account.avatarUrl,
        removedAt: null,
        connectedAt: sql`case when ${pages.removedAt} is not null or ${pages.connectionStatus} = 'disconnected' then now() else ${pages.connectedAt} end`,
        updatedAt: sql`now()`,
      },
    })
    .returning({ ...getTableColumns(pages), inserted: sql<boolean>`(xmax = 0)` })
  const { inserted, ...saved } = row!
  return {
    page: toPageDto(saved),
    created: inserted,
    wasRemoved: before?.removedAt != null,
    previousStatus: inserted ? null : ((before?.connectionStatus as ConnectionStatus | undefined) ?? null),
  }
}

/** Lưu trạng thái kết nối do `connections` tính (`reason` = mã lý do khi không `active`). */
export async function setConnectionStatus(
  tx: DbExecutor,
  pageId: string,
  status: ConnectionStatus,
  reason: string | null = null,
): Promise<PageDto | null> {
  const [row] = await tx
    .update(pages)
    .set({ connectionStatus: status, connectionStatusReason: reason, updatedAt: sql`now()` })
    .where(eq(pages.id, pageId))
    .returning()
  return row ? toPageDto(row) : null
}

/** Trang chưa gỡ, cũ nhất trước (ổn định khi kết nối thêm). */
export async function listPages(db: DbExecutor): Promise<PageDto[]> {
  const rows = await db
    .select()
    .from(pages)
    .where(isNull(pages.removedAt))
    .orderBy(asc(pages.connectedAt), asc(pages.id))
  return rows.map(toPageDto)
}

/** Một trang chưa gỡ theo id; `null` khi không có hoặc đã gỡ. */
export async function getPage(db: DbExecutor, id: string): Promise<PageDto | null> {
  const [row] = await db
    .select()
    .from(pages)
    .where(and(eq(pages.id, id), isNull(pages.removedAt)))
  return row ? toPageDto(row) : null
}
