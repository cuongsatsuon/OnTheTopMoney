// Nhóm và gán trang (Story 2.5, AD-8). Mọi route dưới /api/v1 → guard auth yêu cầu phiên; ghi kiểm Origin.
// Thành viên nhóm chỉ đổi qua các hàm của `pages` (phát `page.group_changed` / `group.deleted` trong transaction).
// Chuyển trang khỏi nhóm cũ: FE gọi `…/members/preview` để lấy danh sách ảnh hưởng, hiện modal, rồi mới gọi gán.
import {
  AssignGroupRequest,
  CreateGroupRequest,
  UpdateGroupRequest,
  type AssignGroupResponse,
  type CreateGroupResponse,
  type DeleteGroupResponse,
  type GroupDto,
  type GroupMoveImpact,
  type ListGroupsResponse,
} from '@ottm/shared'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import {
  affectedByMove,
  assignGroup,
  createGroup,
  deleteGroup,
  getGroup,
  listGroups,
  unassignGroup,
  updateGroup,
} from '../modules/pages/index.ts'
import type { Db } from '../platform/db/index.ts'
import { AppError } from '../platform/errors/index.ts'
import type { EventPublisher } from '../platform/events/index.ts'

const IdParams = z.object({ id: z.uuid() })
const PageIdParams = z.object({ pageId: z.uuid() })
/** Body dùng chung cho preview và gán hàng loạt. */
const PageIdsBody = AssignGroupRequest

export interface GroupsDeps {
  db: Db
  events: EventPublisher
}

export function registerGroups(app: FastifyInstance, deps: GroupsDeps): void {
  const { db, events } = deps

  app.get('/api/v1/groups', async (): Promise<ListGroupsResponse> => ({ items: await listGroups(db) }))

  // Tạo nhóm; gán ngay các trang (nếu có) trong CÙNG transaction → mỗi lần gán phát một `page.group_changed`.
  app.post('/api/v1/groups', async (req): Promise<CreateGroupResponse> => {
    const { name, color, pageIds } = CreateGroupRequest.parse(req.body ?? {})
    return db.transaction(async (tx) => {
      const group = await createGroup(tx, { name, color })
      const changedPageIds: string[] = []
      for (const pageId of pageIds) {
        const { changed } = await assignGroup(tx, events, pageId, group.id)
        if (changed) changedPageIds.push(pageId)
      }
      return { group, changedPageIds }
    })
  })

  // Sửa tên/màu; không đổi thành viên.
  app.patch('/api/v1/groups/:id', async (req): Promise<GroupDto> => {
    const { id } = IdParams.parse(req.params)
    const patch = UpdateGroupRequest.parse(req.body ?? {})
    const group = await db.transaction((tx) => updateGroup(tx, id, patch))
    if (!group) throw new AppError('NOT_FOUND', 404, { message: 'Nhóm không tồn tại' })
    return group
  })

  // Xoá nhóm: gỡ nhóm khỏi mọi trang + phát `group.deleted {groupId, memberPageIds}`.
  app.delete('/api/v1/groups/:id', async (req): Promise<DeleteGroupResponse> => {
    const { id } = IdParams.parse(req.params)
    const result = await db.transaction((tx) => deleteGroup(tx, events, id))
    if (!result) throw new AppError('NOT_FOUND', 404, { message: 'Nhóm không tồn tại' })
    return { groupId: id, memberPageIds: result.memberPageIds }
  })

  // Danh sách ảnh hưởng TRƯỚC khi chuyển (AC2): nhóm cũ + chiến dịch đang chạy (rỗng). Không đổi gì.
  app.post('/api/v1/groups/:id/members/preview', async (req): Promise<GroupMoveImpact> => {
    const { id } = IdParams.parse(req.params)
    const { pageIds } = PageIdsBody.parse(req.body ?? {})
    if (!(await getGroup(db, id))) throw new AppError('NOT_FOUND', 404, { message: 'Nhóm không tồn tại' })
    return affectedByMove(db, pageIds, id)
  })

  // Gán/chuyển các trang vào nhóm (sau khi người dùng xác nhận). Mỗi trang đổi phát một `page.group_changed`.
  app.post('/api/v1/groups/:id/members', async (req): Promise<AssignGroupResponse> => {
    const { id } = IdParams.parse(req.params)
    const { pageIds } = PageIdsBody.parse(req.body ?? {})
    return db.transaction(async (tx) => {
      const group = await getGroup(tx, id)
      if (!group) throw new AppError('NOT_FOUND', 404, { message: 'Nhóm không tồn tại' })
      const changedPageIds: string[] = []
      for (const pageId of pageIds) {
        const { changed } = await assignGroup(tx, events, pageId, id)
        if (changed) changedPageIds.push(pageId)
      }
      return { group, changedPageIds }
    })
  })

  // Gỡ một trang khỏi nhóm (`group_id = null`). No-op khi trang vốn không có nhóm.
  app.delete('/api/v1/pages/:pageId/group', async (req, reply): Promise<void> => {
    const { pageId } = PageIdParams.parse(req.params)
    await db.transaction((tx) => unassignGroup(tx, events, pageId))
    reply.code(204)
  })
}
