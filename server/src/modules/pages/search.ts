// Tìm trang và nhóm cho ⌘K (Story 4.10, AD-18): `pages.search`. Khớp không dấu qua helper `platform/db/search.ts`
// (index GIN trigram trên `search_norm(name|handle)`); trang khớp tên hoặc handle, nhóm khớp tên; có khớp gần đúng.
// Chỉ trang chưa gỡ; số trang của nhóm cũng chỉ đếm trang chưa gỡ. Không log từ khoá.
import type { GroupDto, PageDto } from '@ottm/shared'
import { and, asc, isNull, or, sql } from 'drizzle-orm'
import type { DbExecutor } from '../../platform/db/index.ts'
import { searchTerms, textMatch, textRank } from '../../platform/db/search.ts'
import { toGroupDto } from './groups.ts'
import { groups, pages } from './schema.ts'
import { toPageDto } from './service.ts'

export interface PagesSearchResult {
  pages: PageDto[]
  groups: (GroupDto & { pageCount: number })[]
}

/** Trang chưa gỡ + nhóm khớp `q`, mỗi loại xếp khớp tốt nhất trước, tối đa `limits`. */
export async function search(db: DbExecutor, q: string, limits: { pages: number; groups: number }): Promise<PagesSearchResult> {
  const terms = searchTerms(q)
  if (!terms) return { pages: [], groups: [] }
  const pageRows = await db
    .select()
    .from(pages)
    .where(and(isNull(pages.removedAt), or(textMatch(pages.name, terms, { fuzzy: true }), textMatch(pages.handle, terms, { fuzzy: true }))))
    .orderBy(...textRank(pages.name, terms), asc(pages.name), asc(pages.id))
    .limit(limits.pages)
  // `${groups}.id` viết rõ bảng: cột trong phần `select` Drizzle không kèm tên bảng → `id` sẽ trỏ nhầm `p.id`.
  const pageCount = sql<number>`(select count(*)::int from ${pages} p where p.group_id = ${groups}.id and p.removed_at is null)`
  const groupRows = await db
    .select({ group: groups, pageCount })
    .from(groups)
    .where(textMatch(groups.name, terms, { fuzzy: true }))
    .orderBy(...textRank(groups.name, terms), asc(groups.name), asc(groups.id))
    .limit(limits.groups)
  return {
    pages: pageRows.map(toPageDto),
    groups: groupRows.map((r) => ({ ...toGroupDto(r.group), pageCount: r.pageCount })),
  }
}
