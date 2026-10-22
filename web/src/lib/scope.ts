// Phạm vi lọc phía web (Story 2.6, AD-18). Helper thuần (test không cần render):
// - `normalizeText` / `matchesQuery`: tìm KHÔNG DẤU trong bộ chọn (gõ "my pham" khớp "Mỹ phẩm").
// - `parseStoredScope`: đọc lựa chọn từ localStorage an toàn (JSON hỏng / sai shape → tất cả).
// - `scopeExists` / `effectiveScope`: lựa chọn cũ trỏ tới trang/nhóm đã biến mất → về `all`.
// - `pagesInScope` / `intersectsScope`: tập trang của phạm vi và quy tắc giao tập cho thực thể nhiều trang.
import { ALL_SCOPE, Scope } from '@ottm/shared'
import type { Group, Page } from '../data/mock'

export type { Scope }
export { ALL_SCOPE }

/**
 * Chuẩn hoá để so khớp không dấu: tách tổ hợp (NFD), bỏ dấu thanh/mũ, thường hoá, đổi đ→d, cắt khoảng trắng.
 * "Mỹ phẩm" → "my pham", "Đồ gia dụng" → "do gia dung".
 */
export function normalizeText(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/gu, '') // dải dấu kết hợp U+0300–U+036F (escape rõ, cờ `u`)
    .toLowerCase()
    .replace(/đ/g, 'd')
    .trim()
}

/** Nhãn khớp truy vấn khi (đã chuẩn hoá không dấu) nhãn chứa truy vấn. Truy vấn rỗng → luôn khớp. */
export function matchesQuery(label: string, query: string): boolean {
  const q = normalizeText(query)
  return q === '' || normalizeText(label).includes(q)
}

/** localStorage → `Scope` an toàn: thiếu / JSON hỏng / sai shape đều về `all` (không ném). */
export function parseStoredScope(raw: string | null): Scope {
  if (!raw) return ALL_SCOPE
  try {
    const parsed = Scope.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : ALL_SCOPE
  } catch {
    return ALL_SCOPE
  }
}

/** Phạm vi còn trỏ tới trang/nhóm đang tồn tại? `all` luôn đúng; nhóm/trang đã biến mất → false. */
export function scopeExists(scope: Scope, groups: readonly Pick<Group, 'id'>[], pages: readonly Pick<Page, 'id'>[]): boolean {
  if (scope.kind === 'all') return true
  if (scope.kind === 'group') return groups.some((g) => g.id === scope.id)
  return pages.some((p) => p.id === scope.id)
}

/** Phạm vi dùng thật: giữ nếu còn trỏ tới id tồn tại, ngược lại về `all` (khôi phục an toàn). */
export function effectiveScope(scope: Scope, groups: readonly Pick<Group, 'id'>[], pages: readonly Pick<Page, 'id'>[]): Scope {
  return scopeExists(scope, groups, pages) ? scope : ALL_SCOPE
}

/** Tập trang thuộc phạm vi (bên gọi nên truyền phạm vi đã qua `effectiveScope`). */
export function pagesInScope(scope: Scope, pages: readonly Page[]): Page[] {
  if (scope.kind === 'all') return [...pages]
  if (scope.kind === 'group') return pages.filter((p) => p.groupId === scope.id)
  return pages.filter((p) => p.id === scope.id)
}

/**
 * Thực thể nhiều trang (hội thoại, chiến dịch, bài…) thuộc phạm vi khi tập trang của nó giao tập phạm vi khác
 * rỗng (AD-18). `scopedIds` là tập pageId đã giải từ phạm vi hiện tại.
 */
export function intersectsScope(entityPageIds: readonly string[], scopedIds: ReadonlySet<string>): boolean {
  return entityPageIds.some((id) => scopedIds.has(id))
}

/** Nhãn phạm vi "tất cả trang" trên thanh trên. */
export const ALL_SCOPE_LABEL = 'Tất cả trang'

/**
 * Dẫn xuất giá trị cho provider từ lựa chọn đã lưu + danh sách trang/nhóm hiện có (helper THUẦN, test không cần
 * render). Hạ phạm vi "mồ côi" (trỏ tới id đã xoá) về `all` qua `effectiveScope`, nên `scope`/`scopeLabel`/
 * `scopedPages` luôn khớp nhau. Nhãn lấy từ chính danh sách (không tra kho mẫu), fallback rỗng chỉ là phòng vệ
 * vì `effectiveScope` đã đảm bảo id tồn tại.
 */
export function deriveScopeView(
  scope: Scope,
  pages: readonly Page[],
  groups: readonly Group[],
): { scope: Scope; scopedPages: Page[]; scopeLabel: string } {
  const eff = effectiveScope(scope, groups, pages)
  const scopedPages = pagesInScope(eff, pages)
  const scopeLabel =
    eff.kind === 'all'
      ? ALL_SCOPE_LABEL
      : eff.kind === 'group'
        ? (groups.find((g) => g.id === eff.id)?.name ?? '')
        : (pages.find((p) => p.id === eff.id)?.name ?? '')
  return { scope: eff, scopedPages, scopeLabel }
}
