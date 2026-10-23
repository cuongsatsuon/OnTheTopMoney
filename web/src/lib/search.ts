// Bảng lệnh ⌘K phía web (Story 4.10, AD-18): tìm trang, nhóm, khách qua `GET /api/v1/search?q=` (server so khớp không
// dấu), cộng hai lệnh FE "Tạo bài viết", "Đổi phạm vi" (lọc không dấu tại chỗ). Realtime `page.*`, `group.*`,
// `contact.*` làm cũ `['search', …]` (xem `lib/realtime.ts`). Helper thuần (phím tắt, danh sách mục, đích mở, di chuyển
// ↑/↓) tách để test không cần render.
import { SearchResponse, type PageDto, type SearchContactHit, type SearchGroupHit } from '@ottm/shared'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { apiFetch } from './api'
import { matchesQuery } from './scope'

export const SEARCH_KEY = ['search'] as const
export const searchKey = (q: string) => ['search', q] as const

/** Kết quả tìm cho truy vấn (đã debounce ở bên gọi); truy vấn trống thì không gọi API. */
export function useSearch(q: string) {
  const query = q.trim()
  return useQuery({
    queryKey: searchKey(query),
    queryFn: ({ signal }) => apiFetch(`/search?${new URLSearchParams({ q: query })}`, { schema: SearchResponse, signal }),
    enabled: query !== '',
    // Gõ thêm chữ: giữ kết quả cũ tới khi có kết quả mới (không nháy trống).
    placeholderData: keepPreviousData,
  })
}

/** ⌘K (Mac) / Ctrl+K: mở hoặc đóng bảng lệnh. Bỏ qua khi đang gõ bộ gõ (IME) hoặc kèm Shift/Alt. */
export function isPaletteShortcut(e: { key: string; metaKey: boolean; ctrlKey: boolean; altKey?: boolean; shiftKey?: boolean; isComposing?: boolean }): boolean {
  return e.key.toLowerCase() === 'k' && (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && !e.isComposing
}

/** Nhãn phím tắt theo hệ điều hành của trình duyệt (`navigator.platform` / userAgent). */
export function shortcutLabel(platform: string): string {
  return /mac|iphone|ipad|ipod/i.test(platform) ? '⌘K' : 'Ctrl K'
}

/** Lệnh phía FE (không qua API). */
export type PaletteCommandId = 'create-post' | 'change-scope'
export const PALETTE_COMMANDS: readonly { id: PaletteCommandId; label: string }[] = [
  { id: 'create-post', label: 'Tạo bài viết' },
  { id: 'change-scope', label: 'Đổi phạm vi' },
]

export type PaletteItem =
  | { kind: 'command'; id: PaletteCommandId; label: string }
  | { kind: 'page'; id: string; page: PageDto }
  | { kind: 'group'; id: string; group: SearchGroupHit }
  | { kind: 'contact'; id: string; contact: SearchContactHit }

export type PaletteSection = PaletteItem['kind']
export const SECTION_LABEL: Record<PaletteSection, string> = { command: 'Lệnh', page: 'Trang', group: 'Nhóm', contact: 'Khách hàng' }

/**
 * Danh sách mục theo thứ tự hiển thị (lệnh → trang → nhóm → khách), phẳng để ↑/↓ đi qua mọi nhóm. Lệnh lọc không dấu
 * theo truy vấn (trống → mọi lệnh); kết quả API chỉ lấy khi có (`undefined` khi chưa tìm / truy vấn trống).
 */
export function paletteItems(q: string, data: SearchResponse | undefined): PaletteItem[] {
  const items: PaletteItem[] = PALETTE_COMMANDS.filter((c) => matchesQuery(c.label, q)).map((c) => ({ kind: 'command', ...c }))
  if (!data || q.trim() === '') return items
  for (const page of data.pages) items.push({ kind: 'page', id: page.id, page })
  for (const group of data.groups) items.push({ kind: 'group', id: group.id, group })
  for (const contact of data.contacts) items.push({ kind: 'contact', id: contact.id, contact })
  return items
}

/** Đích mở của một mục: trang / nhóm → màn chi tiết, khách → ngăn kéo hồ sơ ở Khách hàng; "Đổi phạm vi" → `null` (mở bộ chọn). */
export function itemHref(item: PaletteItem): string | null {
  switch (item.kind) {
    case 'page':
      return `/trang-nhom/trang/${item.id}`
    case 'group':
      return `/trang-nhom/nhom/${item.id}`
    case 'contact':
      return `/khach-hang?${new URLSearchParams({ id: item.id })}`
    case 'command':
      return item.id === 'create-post' ? '/soan-bai' : null
  }
}

/** Mục đang chọn sau ↑ (`-1`) / ↓ (`+1`), vòng quanh hai đầu; danh sách rỗng → `-1`. */
export function moveActive(index: number, delta: 1 | -1, length: number): number {
  if (length === 0) return -1
  if (index < 0) return delta === 1 ? 0 : length - 1
  return (index + delta + length) % length
}
