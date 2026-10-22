// Nhóm trang (Story 2.5, AD-8). Mỗi trang tối đa một nhóm; màu chọn trong 8 màu cố định của DESIGN.
// Thành viên nhóm chỉ đổi qua `pages.assignGroup / unassignGroup / deleteGroup` (phát sự kiện trong transaction).
import { z } from 'zod'

const IsoDateTime = z.iso.datetime({ offset: false })

/** 8 màu nhóm cố định (DESIGN › colors.group-1…8). Thứ tự = thứ tự hiển thị trong bảng chọn màu. */
export const GROUP_COLORS = ['group-1', 'group-2', 'group-3', 'group-4', 'group-5', 'group-6', 'group-7', 'group-8'] as const
export const GroupColor = z.enum(GROUP_COLORS)
export type GroupColor = z.infer<typeof GroupColor>

/** Mã màu → hex của DESIGN (chip nhóm: nền 12% của hex, chữ + chấm là hex đầy đủ). Phải khớp token FE. */
export const GROUP_COLOR_HEX: Record<GroupColor, string> = {
  'group-1': '#DB2777',
  'group-2': '#2563EB',
  'group-3': '#C2410C',
  'group-4': '#15803D',
  'group-5': '#7C3AED',
  'group-6': '#0E7490',
  'group-7': '#A16207',
  'group-8': '#475569',
}

/** Tên nhóm: cắt khoảng trắng hai đầu, không rỗng, ≤ 60 ký tự. [ASSUMPTION] cho phép trùng tên. */
export const GROUP_NAME_MAX = 60
export const GroupName = z.string().trim().min(1, 'Tên nhóm không được để trống').max(GROUP_NAME_MAX, `Tên nhóm tối đa ${GROUP_NAME_MAX} ký tự`)

/** Số trang chọn tối đa cho một thao tác gán hàng loạt. */
export const GROUP_ASSIGN_MAX = 1000

export const GroupDto = z.object({
  id: z.uuid(),
  name: z.string(),
  color: GroupColor,
  createdAt: IsoDateTime,
})
export type GroupDto = z.infer<typeof GroupDto>

export const ListGroupsResponse = z.object({ items: z.array(GroupDto) })
export type ListGroupsResponse = z.infer<typeof ListGroupsResponse>

export const CreateGroupRequest = z
  .object({
    name: GroupName,
    color: GroupColor,
    /** Gán ngay các trang này vào nhóm mới — mỗi lần gán phát `page.group_changed` trong cùng transaction. */
    pageIds: z.array(z.uuid()).max(GROUP_ASSIGN_MAX).default([]),
  })
  .strict()
export type CreateGroupRequest = z.input<typeof CreateGroupRequest>

export const UpdateGroupRequest = z
  .object({ name: GroupName.optional(), color: GroupColor.optional() })
  .strict()
  .refine((v) => v.name !== undefined || v.color !== undefined, { message: 'Cần đổi tên hoặc màu' })
export type UpdateGroupRequest = z.infer<typeof UpdateGroupRequest>

export const AssignGroupRequest = z.object({ pageIds: z.array(z.uuid()).min(1).max(GROUP_ASSIGN_MAX) }).strict()
export type AssignGroupRequest = z.infer<typeof AssignGroupRequest>

/** Một trang sẽ rời nhóm hiện tại khi chuyển sang nhóm đích. */
export const GroupMove = z.object({ pageId: z.uuid(), fromGroupId: z.uuid().nullable() })
export type GroupMove = z.infer<typeof GroupMove>

/** Chiến dịch đang chạy dùng trang (read-model Epic 7 — hiện luôn rỗng). */
export const AffectedCampaign = z.object({ id: z.uuid(), name: z.string() })
export type AffectedCampaign = z.infer<typeof AffectedCampaign>

/**
 * Ảnh hưởng của việc chuyển các trang sang một nhóm — FE hiện modal xác nhận trước khi đổi (AC2).
 * Chỉ khi người dùng xác nhận mới gọi gán thật. FE suy tên nhóm cũ từ `moves[].fromGroupId` + danh sách nhóm.
 */
export const GroupMoveImpact = z.object({
  /** Các trang đang ở một nhóm KHÁC nhóm đích (sẽ bị chuyển khỏi nhóm cũ). No-op không nằm ở đây. */
  moves: z.array(GroupMove),
  /** Chiến dịch đang chạy dùng các trang này — read-model, rỗng khi chưa có Epic 7. */
  campaigns: z.array(AffectedCampaign),
})
export type GroupMoveImpact = z.infer<typeof GroupMoveImpact>

export const AssignGroupResponse = z.object({
  group: GroupDto,
  /** Trang thực sự đổi nhóm trong lần này (no-op — đã ở đúng nhóm — không nằm trong danh sách). */
  changedPageIds: z.array(z.uuid()),
})
export type AssignGroupResponse = z.infer<typeof AssignGroupResponse>

export const CreateGroupResponse = AssignGroupResponse
export type CreateGroupResponse = z.infer<typeof CreateGroupResponse>

export const DeleteGroupResponse = z.object({
  groupId: z.uuid(),
  /** Trang đã bị gỡ khỏi nhóm khi xoá (khớp payload sự kiện `group.deleted`). */
  memberPageIds: z.array(z.uuid()),
})
export type DeleteGroupResponse = z.infer<typeof DeleteGroupResponse>
