import type { SearchResponse } from '@ottm/shared'
import { describe, expect, it } from 'vitest'
import { hintInvalidates } from './realtime'
import { isPaletteShortcut, itemHref, moveActive, paletteItems, shortcutLabel, type PaletteItem } from './search'

const PAGE = '01900000-0000-7000-8000-000000000001'
const GROUP = '01900000-0000-7000-8000-000000000002'
const CONTACT = '01900000-0000-7000-8000-000000000003'

const data: SearchResponse = {
  pages: [{ id: PAGE, platform: 'facebook', name: 'Nguyễn Thu Hà Shop', handle: null, avatarUrl: null, groupId: null, connectionStatus: 'active', connectedAt: '2026-10-01T00:00:00.000Z' }],
  groups: [{ id: GROUP, name: 'Đồ gia dụng', color: 'group-1', createdAt: '2026-10-01T00:00:00.000Z', pageCount: 2 }],
  contacts: [{ id: CONTACT, name: 'Nguyễn Thu Hà', phone: null, stage: 'new', pageIds: [PAGE] }],
}

const key = (k: string, mods: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; isComposing: boolean }> = {}) => ({
  key: k,
  metaKey: false,
  ctrlKey: false,
  ...mods,
})

describe('isPaletteShortcut / shortcutLabel', () => {
  it('⌘K hoặc Ctrl+K (cả K hoa); không kèm Shift/Alt, không khi đang gõ IME', () => {
    expect(isPaletteShortcut(key('k', { metaKey: true }))).toBe(true)
    expect(isPaletteShortcut(key('K', { ctrlKey: true }))).toBe(true)
    expect(isPaletteShortcut(key('k'))).toBe(false)
    expect(isPaletteShortcut(key('j', { metaKey: true }))).toBe(false)
    expect(isPaletteShortcut(key('k', { metaKey: true, shiftKey: true }))).toBe(false)
    expect(isPaletteShortcut(key('k', { ctrlKey: true, altKey: true }))).toBe(false)
    expect(isPaletteShortcut(key('k', { metaKey: true, isComposing: true }))).toBe(false)
  })

  it('nhãn theo hệ điều hành', () => {
    expect(shortcutLabel('MacIntel Mozilla/5.0 (Macintosh)')).toBe('⌘K')
    expect(shortcutLabel('iPad')).toBe('⌘K')
    expect(shortcutLabel('Win32 Mozilla/5.0 (Windows NT 10.0)')).toBe('Ctrl K')
    expect(shortcutLabel('')).toBe('Ctrl K')
  })
})

describe('paletteItems', () => {
  it('truy vấn trống: chỉ hai lệnh FE, không dùng kết quả API', () => {
    expect(paletteItems('', data).map((i) => `${i.kind}:${i.id}`)).toEqual(['command:create-post', 'command:change-scope'])
    expect(paletteItems('  ', undefined)).toHaveLength(2)
  })

  it('lệnh lọc không dấu; kết quả theo thứ tự trang → nhóm → khách', () => {
    expect(paletteItems('doi pham', undefined).map((i) => i.id)).toEqual(['change-scope'])
    expect(paletteItems('TẠO BÀI', undefined).map((i) => i.id)).toEqual(['create-post'])
    expect(paletteItems('nguyen', data).map((i) => i.kind)).toEqual(['page', 'group', 'contact'])
  })

  it('API chưa trả / lỗi: vẫn còn lệnh khớp', () => {
    expect(paletteItems('pham vi', undefined).map((i) => i.id)).toEqual(['change-scope'])
    expect(paletteItems('xyz', undefined)).toEqual([])
  })
})

describe('itemHref', () => {
  it('trang / nhóm → chi tiết, khách → ngăn kéo ở Khách hàng, lệnh "Tạo bài viết" → Soạn bài, "Đổi phạm vi" → không điều hướng', () => {
    const [page, group, contact] = paletteItems('nguyen', data) as [PaletteItem, PaletteItem, PaletteItem]
    expect(itemHref(page)).toBe(`/trang-nhom/trang/${PAGE}`)
    expect(itemHref(group)).toBe(`/trang-nhom/nhom/${GROUP}`)
    expect(itemHref(contact)).toBe(`/khach-hang?id=${CONTACT}`)
    expect(itemHref({ kind: 'command', id: 'create-post', label: 'Tạo bài viết' })).toBe('/soan-bai')
    expect(itemHref({ kind: 'command', id: 'change-scope', label: 'Đổi phạm vi' })).toBeNull()
  })
})

describe('moveActive', () => {
  it('↑/↓ vòng quanh hai đầu; danh sách rỗng → -1', () => {
    expect(moveActive(0, 1, 3)).toBe(1)
    expect(moveActive(2, 1, 3)).toBe(0)
    expect(moveActive(0, -1, 3)).toBe(2)
    expect(moveActive(-1, 1, 3)).toBe(0)
    expect(moveActive(-1, -1, 3)).toBe(2)
    expect(moveActive(0, 1, 0)).toBe(-1)
  })
})

describe('realtime làm cũ kết quả ⌘K', () => {
  it('page / group / contact → ["search", …]; thực thể khác thì không', () => {
    expect(hintInvalidates('search', 'page')).toBe(true)
    expect(hintInvalidates('search', 'group')).toBe(true)
    expect(hintInvalidates('search', 'contact')).toBe(true)
    expect(hintInvalidates('search', 'message')).toBe(false)
  })
})
