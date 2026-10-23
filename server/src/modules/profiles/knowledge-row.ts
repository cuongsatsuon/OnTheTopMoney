// Ánh xạ dòng `knowledge_items` ↔ DTO + thao tác theo chủ mà registry kế thừa cần (Story 5.2). Tách khỏi
// `knowledge.ts` để `autoreply-row.ts` (ops registry) gọi mà không tạo vòng với `inheritance.ts`.
import type { ConfigOwnerType, KnowledgeError, KnowledgeFileMime, KnowledgeItemDto, KnowledgeKind, KnowledgeStatus } from '@ottm/shared'
import { and, eq, sql } from 'drizzle-orm'
import type { DbExecutor } from '../../platform/db/index.ts'
import type { ProfileOwner } from './row.ts'
import { knowledgeItems } from './schema.ts'

type Row = typeof knowledgeItems.$inferSelect

export function toKnowledgeDto(row: Row): KnowledgeItemDto {
  return {
    id: row.id,
    ownerType: row.ownerType as ConfigOwnerType,
    ownerId: row.ownerId,
    kind: row.kind as KnowledgeKind,
    title: row.title,
    answer: row.kind === 'faq' ? row.text : null,
    status: row.status as KnowledgeStatus,
    tokenCount: row.tokenCount,
    errorCode: row.errorCode as KnowledgeError | null,
    fileMime: row.fileMime as KnowledgeFileMime | null,
    fileBytes: row.fileBytes,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

export const knowledgeOwnerWhere = (owner: ProfileOwner) =>
  and(eq(knowledgeItems.ownerType, owner.ownerType), eq(knowledgeItems.ownerId, owner.ownerId))

/** Tổng token các mục `ready` (file + FAQ) của chủ — đúng phần prompt sẽ nhét (AD-16). */
export async function readyKnowledgeTokens(db: DbExecutor, owner: ProfileOwner): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`coalesce(sum(${knowledgeItems.tokenCount}), 0)::int` })
    .from(knowledgeItems)
    .where(and(knowledgeOwnerWhere(owner), eq(knowledgeItems.status, 'ready')))
  return row?.total ?? 0
}

/** Một mục kho đã sẵn sàng đưa vào prompt (AD-16: nhét toàn văn). Không log. */
export interface ReadyKnowledgeEntry {
  kind: 'faq' | 'file'
  title: string
  text: string
}

/** Các mục `ready` (FAQ + file đã trích) của chủ theo thứ tự hiển thị — đúng phần prompt AI trả lời nhét vào. */
export async function listReadyKnowledge(db: DbExecutor, owner: ProfileOwner): Promise<ReadyKnowledgeEntry[]> {
  const rows = await db
    .select({ kind: knowledgeItems.kind, title: knowledgeItems.title, text: knowledgeItems.text })
    .from(knowledgeItems)
    .where(and(knowledgeOwnerWhere(owner), eq(knowledgeItems.status, 'ready')))
    .orderBy(knowledgeItems.createdAt, knowledgeItems.id)
  return rows.filter((r) => r.text?.trim()).map((r) => ({ kind: r.kind as 'faq' | 'file', title: r.title, text: r.text! }))
}

/** Xoá kho của chủ (đi cùng `remove` của cấu hình AI). File còn trên kho do job/lần xoá sau dọn (best-effort). */
export async function removeKnowledgeOf(tx: DbExecutor, owner: ProfileOwner): Promise<void> {
  await tx.delete(knowledgeItems).where(knowledgeOwnerWhere(owner))
}

/**
 * Sao chép kho `from` → `to` (đi cùng `copy` của cấu hình AI): THAY kho đích để chạy lại (sự kiện tới hai lần) không
 * nhân đôi. Mục `processing` được chép kèm ref file — job trích xử lý theo file nên kết thúc cả bản sao.
 */
export async function copyKnowledge(tx: DbExecutor, from: ProfileOwner, to: ProfileOwner): Promise<void> {
  await removeKnowledgeOf(tx, to)
  const src = await tx.select().from(knowledgeItems).where(knowledgeOwnerWhere(from)).orderBy(knowledgeItems.createdAt, knowledgeItems.id)
  if (src.length === 0) return
  await tx.insert(knowledgeItems).values(
    src.map((r) => ({
      ownerType: to.ownerType,
      ownerId: to.ownerId,
      kind: r.kind,
      title: r.title,
      text: r.text,
      status: r.status,
      tokenCount: r.tokenCount,
      errorCode: r.errorCode,
      filePublicId: r.filePublicId,
      fileResourceType: r.fileResourceType,
      fileFormat: r.fileFormat,
      fileMime: r.fileMime,
      fileBytes: r.fileBytes,
      processedAt: r.processedAt,
      // Giữ thứ tự hiển thị của kho gốc.
      createdAt: r.createdAt,
    })),
  )
}
