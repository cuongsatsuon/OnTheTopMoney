// Phạm vi lọc dữ liệu (AD-18). Dùng chung BE/FE: BE giải phạm vi → tập pageId qua `pages.resolveScope`;
// FE nhớ lựa chọn ở localStorage dạng object `Scope` và gửi lên endpoint danh sách dạng chuỗi query.
import { z } from 'zod'

export const SCOPE_KINDS = ['all', 'group', 'page'] as const

/**
 * Phạm vi: tất cả trang, một nhóm, hoặc một trang. `id` là string để FE dùng được cả id trang/nhóm thật (uuid)
 * lẫn id kho mẫu (p1, g-beauty…) khi khôi phục từ localStorage. Query string của endpoint kiểm uuid riêng (`ScopeParam`).
 */
export const Scope = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('all') }),
  z.object({ kind: z.literal('group'), id: z.string().min(1) }),
  z.object({ kind: z.literal('page'), id: z.string().min(1) }),
])
export type Scope = z.infer<typeof Scope>

/** Phạm vi mặc định: tất cả trang (dùng khi chưa chọn / lựa chọn cũ trỏ tới id đã biến mất). */
export const ALL_SCOPE: Scope = { kind: 'all' }

/** `Scope` → chuỗi query: `all` | `group:<id>` | `page:<id>`. Nghịch đảo của `ScopeParam`. */
export function formatScope(scope: Scope): string {
  return scope.kind === 'all' ? 'all' : `${scope.kind}:${scope.id}`
}

const SCOPE_RE = /^(group|page):(.+)$/

/**
 * Chuỗi query (`all` | `group:<uuid>` | `page:<uuid>`) → `Scope`, dùng chung cho mọi endpoint danh sách nhận
 * phạm vi. Sai cú pháp hoặc id không phải uuid → lỗi zod (VALIDATION_FAILED). Id hợp lệ nhưng không tồn tại
 * do `pages.resolveScope` lo (404) — không kiểm ở đây.
 */
export const ScopeParam = z.string().transform((raw, ctx): Scope => {
  if (raw === 'all') return { kind: 'all' }
  const m = SCOPE_RE.exec(raw)
  if (m && z.uuid().safeParse(m[2]).success) return { kind: m[1] as 'group' | 'page', id: m[2]! }
  ctx.addIssue({ code: 'custom', message: 'Phạm vi không hợp lệ' })
  return z.NEVER
})
