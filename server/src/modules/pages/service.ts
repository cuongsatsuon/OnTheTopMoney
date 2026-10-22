// Nghiệp vụ trang (Story 2.2). Module nền: không gọi module nào.
// - `upsertFromPlatform`, `setConnectionStatus`: CHỈ `connections` được gọi (AD-5: trạng thái tính ở
//   `connections`, lưu ở đây). Cả hai nhận executor để chạy trong transaction của bên gọi.
// - `listPages`, `getPage`: đọc cho api và module khác.
import { ALL_SCOPE, type ConnectionStatus, type PageDto, type Platform, type Scope } from '@ottm/shared'
import { and, asc, eq, getTableColumns, inArray, isNull, sql, type SQL } from 'drizzle-orm'
import type { DbExecutor } from '../../platform/db/index.ts'
import { AppError } from '../../platform/errors/index.ts'
import { groups, pages } from './schema.ts'

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
    groupId: row.groupId,
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

/**
 * Helper DUY NHẤT dịch phạm vi → tập `pageId` của các trang CHƯA gỡ (AD-18). Mọi màn/endpoint lọc theo phạm vi
 * phải đi qua đây, không nhân bản logic dịch:
 * - `all` → mọi trang chưa gỡ;
 * - `group:<id>` → trang thuộc nhóm (nhóm rỗng → `[]`); nhóm không tồn tại → 404;
 * - `page:<id>` → `[pageId]`; trang không tồn tại hoặc đã gỡ → 404.
 * Trả theo thứ tự `connected_at` rồi `id` (ổn định). Thực thể nhiều trang (epic sau) thuộc phạm vi khi tập trang
 * của nó giao tập này khác rỗng.
 */
export async function resolveScope(db: DbExecutor, scope: Scope): Promise<string[]> {
  if (scope.kind === 'all') return scopedPageIds(db, isNull(pages.removedAt))
  if (scope.kind === 'group') {
    const [group] = await db.select({ id: groups.id }).from(groups).where(eq(groups.id, scope.id))
    if (!group) throw new AppError('NOT_FOUND', 404, { message: 'Nhóm không tồn tại', details: { groupId: scope.id } })
    return scopedPageIds(db, and(eq(pages.groupId, scope.id), isNull(pages.removedAt)))
  }
  const [row] = await db
    .select({ id: pages.id })
    .from(pages)
    .where(and(eq(pages.id, scope.id), isNull(pages.removedAt)))
  if (!row) throw new AppError('NOT_FOUND', 404, { message: 'Trang không tồn tại', details: { pageId: scope.id } })
  return [row.id]
}

async function scopedPageIds(db: DbExecutor, where: SQL | undefined): Promise<string[]> {
  const rows = await db.select({ id: pages.id }).from(pages).where(where).orderBy(asc(pages.connectedAt), asc(pages.id))
  return rows.map((r) => r.id)
}

/** Trang chưa gỡ theo phạm vi (mặc định: mọi trang), cũ nhất trước (ổn định khi kết nối thêm). */
export async function listPages(db: DbExecutor, scope: Scope = ALL_SCOPE): Promise<PageDto[]> {
  // `resolveScope` là nguồn DUY NHẤT dịch phạm vi — đã lọc "trang chưa gỡ" và ném 404 khi nhóm/trang không tồn tại.
  const ids = await resolveScope(db, scope)
  if (ids.length === 0) return []
  const rows = await db.select().from(pages).where(inArray(pages.id, ids)).orderBy(asc(pages.connectedAt), asc(pages.id))
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
