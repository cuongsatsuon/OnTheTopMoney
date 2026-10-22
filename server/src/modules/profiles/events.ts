// Consumer sự kiện của `profiles` (queue `events.profiles`): nghe `page.group_changed` & `group.deleted`,
// áp luật giữ cấu hình khi đổi thành viên nhóm (Story 3.3, AD-8) cho MỌI loại cấu hình đã đăng ký (registry).
// Idempotent: sự kiện tới hai lần không nhân đôi/không hỏng (xem `applyGroupChange`). Mọi thay đổi trạng thái
// nằm trong MỘT transaction (AD-3). Dữ liệu job coi như không tin cậy: sai dạng → bỏ qua (không đốt lượt retry).
import type { EventPayload } from '@ottm/shared'
import { isEventEnvelope, type EventEnvelope } from '../../platform/events/index.ts'
import type { Db } from '../../platform/db/index.ts'
import { getPage } from '../pages/index.ts'
import { REGISTRY, REGISTERED_KINDS, applyGroupChange } from './inheritance.ts'

export interface ProfilesEventDeps {
  db: Db
}

export type ProfilesEventResult = 'applied' | 'ignored'

export async function handleProfilesEvent(deps: ProfilesEventDeps, data: unknown): Promise<ProfilesEventResult> {
  if (!isEventEnvelope(data)) return 'ignored'
  if (data.event === 'page.group_changed') return handleGroupChanged(deps, data)
  if (data.event === 'group.deleted') return handleGroupDeleted(deps, data)
  return 'ignored'
}

async function handleGroupChanged(deps: ProfilesEventDeps, envelope: EventEnvelope): Promise<ProfilesEventResult> {
  const payload = envelope.payload as Partial<EventPayload<'page.group_changed'>>
  const pageId = payload.pageId ?? payload.id
  if (typeof pageId !== 'string') return 'ignored'
  // Chuẩn hoá: thiếu/khác chuỗi coi như null. `toGroupId` null = rời nhóm (KHÔNG rơi nhánh join với id undefined).
  const fromGroupId = typeof payload.fromGroupId === 'string' ? payload.fromGroupId : null
  const toGroupId = typeof payload.toGroupId === 'string' ? payload.toGroupId : null
  await deps.db.transaction(async (tx) => {
    // Trang đã gỡ/không tồn tại → bỏ qua (không giữ cấu hình cho trang không còn).
    if (!(await getPage(tx, pageId))) return
    for (const kind of REGISTERED_KINDS) await applyGroupChange(tx, pageId, kind, fromGroupId, toGroupId)
  })
  return 'applied'
}

async function handleGroupDeleted(deps: ProfilesEventDeps, envelope: EventEnvelope): Promise<ProfilesEventResult> {
  const { groupId, memberPageIds } = envelope.payload as Partial<EventPayload<'group.deleted'>>
  // Dữ liệu job hỏng (thiếu groupId / memberPageIds không phải mảng) → bỏ qua, không for-of trên undefined.
  if (typeof groupId !== 'string' || !Array.isArray(memberPageIds)) return 'ignored'
  await deps.db.transaction(async (tx) => {
    // Mỗi trang thành viên rời nhóm đã xoá → sao chép cấu hình nhóm cũ thành riêng (nhóm còn cấu hình lúc này).
    for (const pageId of memberPageIds) {
      if (!(await getPage(tx, pageId))) continue
      for (const kind of REGISTERED_KINDS) await applyGroupChange(tx, pageId, kind, groupId, null)
    }
    // SAU KHI các trang đã giữ cấu hình → xoá cấu hình của nhóm đã xoá (idempotent: lần hai no-op).
    for (const kind of REGISTERED_KINDS) await REGISTRY[kind].remove(tx, { ownerType: 'group', ownerId: groupId })
  })
  return 'applied'
}
