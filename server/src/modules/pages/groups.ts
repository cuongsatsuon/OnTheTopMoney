// Nghiệp vụ nhóm trang (Story 2.5, AD-8). Module nền `pages`: không gọi module nào, chỉ dùng platform.
// Thành viên nhóm CHỈ đổi qua `assignGroup / unassignGroup / deleteGroup`; mỗi hàm phát sự kiện
// (`page.group_changed` / `group.deleted`) trong CÙNG transaction với thay đổi (truyền `tx` của bên gọi).
// Gán trang đã ở đúng nhóm đó là no-op: không phát sự kiện thừa.
import type { GroupColor, GroupDto, GroupMoveImpact } from '@ottm/shared'
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm'
import type { DbExecutor } from '../../platform/db/index.ts'
import type { EventPublisher } from '../../platform/events/index.ts'
import { AppError } from '../../platform/errors/index.ts'
import { groups, pages } from './schema.ts'

type GroupRow = typeof groups.$inferSelect

export function toGroupDto(row: GroupRow): GroupDto {
  return { id: row.id, name: row.name, color: row.color as GroupColor, createdAt: row.createdAt.toISOString() }
}

/** Kết quả một lần đổi nhóm của trang: `changed` = có thực sự đổi (no-op thì false, không phát sự kiện). */
export interface GroupChange {
  changed: boolean
  fromGroupId: string | null
}

/** Mọi nhóm, cũ nhất trước (ổn định khi tạo thêm). */
export async function listGroups(db: DbExecutor): Promise<GroupDto[]> {
  const rows = await db.select().from(groups).orderBy(asc(groups.createdAt), asc(groups.id))
  return rows.map(toGroupDto)
}

/** Một nhóm theo id; `null` khi không có. */
export async function getGroup(db: DbExecutor, id: string): Promise<GroupDto | null> {
  const [row] = await db.select().from(groups).where(eq(groups.id, id))
  return row ? toGroupDto(row) : null
}

/** Tạo nhóm (tên đã cắt khoảng trắng + màu đã kiểm ở route). Không đụng thành viên. */
export async function createGroup(tx: DbExecutor, input: { name: string; color: GroupColor }): Promise<GroupDto> {
  const [row] = await tx.insert(groups).values({ name: input.name, color: input.color }).returning()
  return toGroupDto(row!)
}

/** Sửa tên/màu nhóm; không đổi thành viên. `null` khi nhóm không tồn tại. */
export async function updateGroup(
  tx: DbExecutor,
  groupId: string,
  input: { name?: string; color?: GroupColor },
): Promise<GroupDto | null> {
  const set: Partial<Pick<GroupRow, 'name' | 'color'>> = {}
  if (input.name !== undefined) set.name = input.name
  if (input.color !== undefined) set.color = input.color
  const [row] = await tx
    .update(groups)
    .set({ ...set, updatedAt: sql`now()` })
    .where(eq(groups.id, groupId))
    .returning()
  return row ? toGroupDto(row) : null
}

/** Khoá dòng trang chưa gỡ và đọc nhóm hiện tại; ném 404 khi không có hoặc đã gỡ. */
async function lockPageGroup(tx: DbExecutor, pageId: string): Promise<string | null> {
  const [row] = await tx
    .select({ groupId: pages.groupId })
    .from(pages)
    .where(and(eq(pages.id, pageId), isNull(pages.removedAt)))
    .for('update')
  if (!row) throw new AppError('NOT_FOUND', 404, { message: 'Trang không tồn tại', details: { pageId } })
  return row.groupId
}

/**
 * Gán một trang vào nhóm (mỗi trang tối đa một nhóm). Trang đang ở nhóm khác thì bị chuyển (bên gọi lo
 * cảnh báo trước). No-op khi đã ở đúng nhóm. Phát `page.group_changed {fromGroupId, toGroupId}` khi có đổi.
 */
export async function assignGroup(tx: DbExecutor, events: EventPublisher, pageId: string, groupId: string): Promise<GroupChange> {
  const [group] = await tx.select({ id: groups.id }).from(groups).where(eq(groups.id, groupId))
  if (!group) throw new AppError('NOT_FOUND', 404, { message: 'Nhóm không tồn tại', details: { groupId } })
  const fromGroupId = await lockPageGroup(tx, pageId)
  if (fromGroupId === groupId) return { changed: false, fromGroupId }
  await tx.update(pages).set({ groupId, updatedAt: sql`now()` }).where(eq(pages.id, pageId))
  await events.publishEvent(tx, 'page.group_changed', { id: pageId, pageId, fromGroupId, toGroupId: groupId })
  return { changed: true, fromGroupId }
}

/** Gỡ một trang khỏi nhóm (`group_id = null`). No-op khi trang vốn không có nhóm. */
export async function unassignGroup(tx: DbExecutor, events: EventPublisher, pageId: string): Promise<GroupChange> {
  const fromGroupId = await lockPageGroup(tx, pageId)
  if (fromGroupId === null) return { changed: false, fromGroupId: null }
  await tx.update(pages).set({ groupId: null, updatedAt: sql`now()` }).where(eq(pages.id, pageId))
  await events.publishEvent(tx, 'page.group_changed', { id: pageId, pageId, fromGroupId, toGroupId: null })
  return { changed: true, fromGroupId }
}

/**
 * Xoá nhóm: gỡ nhóm khỏi MỌI trang (kể cả trang đã gỡ, để FK sạch) rồi xoá dòng nhóm, phát
 * `group.deleted {groupId, memberPageIds}` trong cùng transaction. `null` khi nhóm không tồn tại.
 */
export async function deleteGroup(tx: DbExecutor, events: EventPublisher, groupId: string): Promise<{ memberPageIds: string[] } | null> {
  const [group] = await tx.select({ id: groups.id }).from(groups).where(eq(groups.id, groupId)).for('update')
  if (!group) return null
  const cleared = await tx
    .update(pages)
    .set({ groupId: null, updatedAt: sql`now()` })
    .where(eq(pages.groupId, groupId))
    .returning({ id: pages.id })
  await tx.delete(groups).where(eq(groups.id, groupId))
  const memberPageIds = cleared.map((r) => r.id)
  await events.publishEvent(tx, 'group.deleted', { id: groupId, groupId, memberPageIds })
  return { memberPageIds }
}

/**
 * Read-model "danh sách ảnh hưởng" khi chuyển các trang sang `toGroupId` (AC2). Trả các trang đang ở nhóm
 * KHÁC (sẽ bị chuyển khỏi nhóm cũ) và chiến dịch đang chạy (rỗng tới Epic 7). Ném 404 nếu có `pageId` không
 * tồn tại hoặc đã gỡ — để preview và assign nhất quán (assign cũng 404 cả batch khi có trang lạ).
 */
export async function affectedByMove(db: DbExecutor, pageIds: readonly string[], toGroupId: string): Promise<GroupMoveImpact> {
  if (pageIds.length === 0) return { moves: [], campaigns: [] }
  const rows = await db
    .select({ id: pages.id, groupId: pages.groupId })
    .from(pages)
    .where(and(inArray(pages.id, [...pageIds]), isNull(pages.removedAt)))
  const found = new Set(rows.map((r) => r.id))
  for (const pageId of pageIds) {
    if (!found.has(pageId)) throw new AppError('NOT_FOUND', 404, { message: 'Trang không tồn tại', details: { pageId } })
  }
  const moves = rows
    .filter((r) => r.groupId !== null && r.groupId !== toGroupId)
    .map((r) => ({ pageId: r.id, fromGroupId: r.groupId }))
  // Chiến dịch đang chạy dùng trang: read-model Epic 7 chưa có → luôn rỗng.
  return { moves, campaigns: [] }
}
