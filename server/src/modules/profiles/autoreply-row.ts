// Ánh xạ dòng `autoreply_configs` ↔ DTO + thao tác registry kế thừa của loại `autoreply` (Story 5.1). Tách khỏi
// `autoreply.ts` để `inheritance.ts` đăng ký ops mà không tạo vòng phụ thuộc (autoreply.ts → inheritance.ts).
import type { AutoreplyConfigDto, ConfigOwnerType, ParsedAutoreplyConfig } from '@ottm/shared'
import { AutoreplyChannel, AutoreplyDayHours, AutoreplySchedule } from '@ottm/shared'
import { and, eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import type { DbExecutor } from '../../platform/db/index.ts'
import { copyKnowledge, removeKnowledgeOf } from './knowledge-row.ts'
import type { ProfileOwner } from './row.ts'
import { autoreplyConfigs } from './schema.ts'

type Row = typeof autoreplyConfigs.$inferSelect

const StoredHours = z.array(AutoreplyDayHours)
const StoredChannels = z.array(AutoreplyChannel)

export function toAutoreplyDto(row: Row): AutoreplyConfigDto {
  return {
    ownerType: row.ownerType as ConfigOwnerType,
    ownerId: row.ownerId,
    enabled: row.enabled,
    schedule: AutoreplySchedule.parse(row.schedule),
    // Parse jsonb/text[] bằng zod: cột hỏng → lỗi server rõ (không rơi dữ liệu sai xuống FE hay pipeline).
    hours: StoredHours.parse(row.hours),
    script: row.script,
    handoffKeywords: row.handoffKeywords,
    handoffOnCustomerAsk: row.handoffOnCustomerAsk,
    handoffOnUncertain: row.handoffOnUncertain,
    handoffMessage: row.handoffMessage,
    channels: StoredChannels.parse(row.channels),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

export const autoreplyOwnerWhere = (owner: ProfileOwner) =>
  and(eq(autoreplyConfigs.ownerType, owner.ownerType), eq(autoreplyConfigs.ownerId, owner.ownerId))

/** Giá trị cột từ cấu hình đã parse (hoặc DTO khi sao chép). */
export function autoreplyValues(owner: ProfileOwner, cfg: ParsedAutoreplyConfig | AutoreplyConfigDto) {
  return {
    ownerType: owner.ownerType,
    ownerId: owner.ownerId,
    enabled: cfg.enabled,
    schedule: cfg.schedule,
    hours: cfg.hours,
    script: cfg.script,
    handoffKeywords: cfg.handoffKeywords,
    handoffOnCustomerAsk: cfg.handoffOnCustomerAsk,
    handoffOnUncertain: cfg.handoffOnUncertain,
    handoffMessage: cfg.handoffMessage,
    channels: cfg.channels,
  }
}

/** Upsert theo chủ trong `values` (idempotent khi sự kiện / thao tác chạy lại). */
export async function upsertAutoreplyRow(tx: DbExecutor, values: ReturnType<typeof autoreplyValues>): Promise<AutoreplyConfigDto> {
  const [row] = await tx
    .insert(autoreplyConfigs)
    .values(values)
    .onConflictDoUpdate({ target: [autoreplyConfigs.ownerType, autoreplyConfigs.ownerId], set: { ...values, updatedAt: sql`now()` } })
    .returning()
  return toAutoreplyDto(row!)
}

/** Cấu hình AI của một chủ, hoặc `null` khi chưa có. */
export async function getAutoreplyRow(db: DbExecutor, owner: ProfileOwner): Promise<AutoreplyConfigDto | null> {
  const [row] = await db.select().from(autoreplyConfigs).where(autoreplyOwnerWhere(owner))
  return row ? toAutoreplyDto(row) : null
}

/**
 * Ops registry kế thừa (AD-8) cho loại `autoreply` — cùng hợp đồng với brand ở `inheritance.ts`. Kho kiến thức
 * (Story 5.2) là một phần của cấu hình AI: sao chép/xoá cấu hình kéo theo kho của cùng chủ.
 */
export const autoreplyOps = {
  async exists(db: DbExecutor, owner: ProfileOwner): Promise<boolean> {
    const [row] = await db.select({ id: autoreplyConfigs.id }).from(autoreplyConfigs).where(autoreplyOwnerWhere(owner))
    return !!row
  },
  get: getAutoreplyRow,
  async copy(tx: DbExecutor, from: ProfileOwner, to: ProfileOwner): Promise<void> {
    const src = await getAutoreplyRow(tx, from)
    if (!src) return
    await upsertAutoreplyRow(tx, autoreplyValues(to, src))
    await copyKnowledge(tx, from, to)
  },
  async remove(tx: DbExecutor, owner: ProfileOwner): Promise<void> {
    await tx.delete(autoreplyConfigs).where(autoreplyOwnerWhere(owner))
    await removeKnowledgeOf(tx, owner)
  },
}
