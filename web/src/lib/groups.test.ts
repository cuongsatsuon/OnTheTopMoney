// Story 2.5 (web) — logic nền cho Trang & Nhóm: chép nhóm thật vào kho mẫu (trạng thái rỗng, tạo nhóm) và
// quyết định có cần modal xác nhận chuyển nhóm hay không (AC2). Không có harness render → kiểm hàm thuần.
import { GROUP_COLOR_HEX, type GroupDto, type GroupMoveImpact } from '@ottm/shared'
import { describe, expect, it } from 'vitest'
import type { Group } from '../data/mock'
import { colorCodeOf, firstFreeColor, mirrorRealGroups, shouldConfirmMove, toUiGroup } from './groups'

const dto = (id: string, name: string, color: GroupDto['color'] = 'group-1'): GroupDto => ({
  id,
  name,
  color,
  createdAt: '2026-10-22T03:00:00.000Z',
})

describe('toUiGroup', () => {
  it('đổi mã màu group-n sang hex DESIGN; AI/chiến dịch mặc định', () => {
    expect(toUiGroup(dto('g1', 'Nhóm Mỹ phẩm', 'group-2'))).toEqual({
      id: 'g1',
      name: 'Nhóm Mỹ phẩm',
      color: GROUP_COLOR_HEX['group-2'],
      autoReply: false,
      activeCampaigns: 0,
    })
  })
})

describe('mirrorRealGroups (kho mẫu cho màn chưa chuyển API)', () => {
  it('thêm/cập nhật nhóm thật, giữ nhóm mẫu, bỏ nhóm thật không còn — trạng thái rỗng khi server trả []', () => {
    const sample: Group = { id: 'g-beauty', name: 'Mẫu', color: '#DB2777', autoReply: true, activeCampaigns: 2 }
    const store: Group[] = [sample]
    const known = new Set<string>()

    mirrorRealGroups([dto('r1', 'A'), dto('r2', 'B')], store, known)
    expect(store.map((g) => g.id)).toEqual(['g-beauty', 'r1', 'r2'])

    mirrorRealGroups([dto('r1', 'A mới', 'group-3')], store, known)
    expect(store.map((g) => g.id)).toEqual(['g-beauty', 'r1']) // r2 (nhóm thật) bị gỡ
    expect(store.find((g) => g.id === 'r1')).toMatchObject({ name: 'A mới', color: GROUP_COLOR_HEX['group-3'] })
    expect(store.find((g) => g.id === 'g-beauty')).toBe(sample) // nhóm mẫu không bị đụng

    // Server trả [] → không còn nhóm thật nào (FE hiện trạng thái rỗng), nhóm mẫu vẫn đó.
    mirrorRealGroups([], store, known)
    expect(store.map((g) => g.id)).toEqual(['g-beauty'])
  })
})

describe('chọn màu khi tạo/sửa nhóm', () => {
  it('firstFreeColor trả màu chưa dùng; colorCodeOf là nghịch đảo hex→mã', () => {
    const used: Group[] = [
      { id: 'a', name: 'A', color: GROUP_COLOR_HEX['group-1'], autoReply: false, activeCampaigns: 0 },
      { id: 'b', name: 'B', color: GROUP_COLOR_HEX['group-2'], autoReply: false, activeCampaigns: 0 },
    ]
    expect(firstFreeColor(used)).toBe('group-3')
    expect(firstFreeColor([])).toBe('group-1')
    expect(colorCodeOf(GROUP_COLOR_HEX['group-5'])).toBe('group-5')
    expect(colorCodeOf('#000000')).toBe('group-1') // lạ → mặc định
  })
})

describe('shouldConfirmMove (quyết định modal xác nhận chuyển — AC2, server là nguồn sự thật)', () => {
  const impact = (moves: GroupMoveImpact['moves']): GroupMoveImpact => ({ moves, campaigns: [] })

  it('moves khác rỗng → cần hiện modal; rỗng → gán thẳng', () => {
    expect(shouldConfirmMove(impact([{ pageId: 'p1', fromGroupId: 'A' }]))).toBe(true)
    expect(shouldConfirmMove(impact([]))).toBe(false)
  })
})
