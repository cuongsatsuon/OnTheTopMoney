// Nhóm và gán trang (Story 2.5, AD-8) phía web. Nối Trang & Nhóm vào API thật.
// Giống cách `connections.ts` chép trang thật vào kho mẫu: nhóm thật được chép vào `mock.groups` (giữ nhóm mẫu
// của các màn epic sau) để `GroupChip`, Chi tiết nhóm và bộ chọn phạm vi thấy đúng tên + màu. Mọi thay đổi
// thành viên đi qua API; onSuccess vô hiệu hoá cache `['groups']` + `['pages']` để vẽ lại từ server.
import {
  AssignGroupResponse,
  CreateGroupResponse,
  DeleteGroupResponse,
  GROUP_COLOR_HEX,
  GroupMoveImpact,
  ListGroupsResponse,
  type GroupColor,
  type GroupDto,
} from '@ottm/shared'
import { GROUP_COLORS } from '@ottm/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { groups as mockGroups, type Group } from '../data/mock'
import { apiFetch } from './api'
import { PAGES_KEY } from './connections'

export const GROUPS_KEY = ['groups'] as const

/** Nhóm thật → dạng `Group` của giao diện mẫu. Màu đổi sang hex (DESIGN). AI/chiến dịch của nhóm là Epic 5/7 → mặc định. */
export function toUiGroup(dto: GroupDto): Group {
  return { id: dto.id, name: dto.name, color: GROUP_COLOR_HEX[dto.color], autoReply: false, activeCampaigns: 0 }
}

/** Hex (mock `Group.color`) → mã màu `group-n`; lạ → `group-1`. */
export function colorCodeOf(hex: string): GroupColor {
  return GROUP_COLORS.find((c) => GROUP_COLOR_HEX[c] === hex) ?? GROUP_COLORS[0]
}

/** Mã màu `group-n` chưa bị nhóm nào dùng (so theo hex) — mặc định khi tạo nhóm; hết màu thì `group-1`. */
export function firstFreeColor(groups: readonly Group[]): GroupColor {
  return GROUP_COLORS.find((c) => !groups.some((g) => g.color === GROUP_COLOR_HEX[c])) ?? GROUP_COLORS[0]
}

/**
 * Server là nguồn sự thật cho AC2: có trang phải rời nhóm cũ (`impact.moves` khác rỗng) → cần hiện modal xác
 * nhận; rỗng → gán thẳng. FE luôn gọi `/members/preview` trước, không tự suy từ state cũ.
 */
export function shouldConfirmMove(impact: GroupMoveImpact): boolean {
  return impact.moves.length > 0
}

/** Id các nhóm thật đã chép vào kho mẫu (để gỡ khi server không còn trả về; không đụng nhóm mẫu). */
const mirroredIds = new Set<string>()

/**
 * Chép nhóm thật vào kho mẫu: thêm/cập nhật theo id, bỏ nhóm thật không còn trong danh sách, GIỮ nhóm mẫu
 * (các màn Epic 3–8 chưa chuyển API vẫn dùng). Giữ cờ `autoReply` mẫu nếu nhóm đã có (overlay giao diện).
 */
export function mirrorRealGroups(dtos: readonly GroupDto[], store: Group[] = mockGroups, known: Set<string> = mirroredIds): void {
  const incoming = new Set(dtos.map((d) => d.id))
  for (let i = store.length - 1; i >= 0; i--) {
    const id = store[i]!.id
    if (known.has(id) && !incoming.has(id)) {
      store.splice(i, 1)
      known.delete(id)
    }
  }
  for (const dto of dtos) {
    const fresh = toUiGroup(dto)
    const i = store.findIndex((g) => g.id === dto.id)
    if (i === -1) store.push(fresh)
    else store[i] = { ...fresh, autoReply: store[i]!.autoReply, activeCampaigns: store[i]!.activeCampaigns }
    known.add(dto.id)
  }
}

/** Danh sách nhóm thật; mỗi lần tải xong chép vào kho mẫu để các màn khác thấy. */
export function useGroups() {
  return useQuery({
    queryKey: GROUPS_KEY,
    queryFn: async ({ signal }) => {
      const data = await apiFetch('/groups', { schema: ListGroupsResponse, signal })
      mirrorRealGroups(data.items)
      return data
    },
    select: (data) => data.items,
  })
}

function useGroupMutation<TVars, TData>(fn: (vars: TVars) => Promise<TData>) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: GROUPS_KEY })
      void queryClient.invalidateQueries({ queryKey: PAGES_KEY })
    },
  })
}

export interface CreateGroupVars {
  name: string
  color: GroupColor
  pageIds: string[]
}
export function useCreateGroup() {
  return useGroupMutation((vars: CreateGroupVars) =>
    apiFetch('/groups', { method: 'POST', body: vars, schema: CreateGroupResponse }),
  )
}

export interface UpdateGroupVars {
  id: string
  name?: string
  color?: GroupColor
}
export function useUpdateGroup() {
  return useGroupMutation(({ id, ...patch }: UpdateGroupVars) => apiFetch(`/groups/${id}`, { method: 'PATCH', body: patch }))
}

export function useDeleteGroup() {
  return useGroupMutation((id: string) => apiFetch(`/groups/${id}`, { method: 'DELETE', schema: DeleteGroupResponse }))
}

export interface AssignVars {
  groupId: string
  pageIds: string[]
}
export function useAssignGroup() {
  return useGroupMutation(({ groupId, pageIds }: AssignVars) =>
    apiFetch(`/groups/${groupId}/members`, { method: 'POST', body: { pageIds }, schema: AssignGroupResponse }),
  )
}

export function useUnassignGroup() {
  return useGroupMutation((pageId: string) => apiFetch(`/pages/${pageId}/group`, { method: 'DELETE' }))
}

/**
 * Lấy danh sách ảnh hưởng TRƯỚC khi chuyển trang sang một nhóm đã tồn tại (AC2). Không đổi gì; FE dùng kết quả
 * để hiện modal "Trang này sẽ chuyển khỏi …" rồi mới gọi `useAssignGroup`.
 */
export function useGroupMoveImpact() {
  return useMutation({
    mutationFn: ({ groupId, pageIds }: AssignVars) =>
      apiFetch(`/groups/${groupId}/members/preview`, { method: 'POST', body: { pageIds }, schema: GroupMoveImpact }),
  })
}
