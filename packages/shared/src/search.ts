// Tìm nhanh ⌘K (Story 4.10, AD-18): `GET /api/v1/search?q=` ghép từ `pages.search` (trang, nhóm) và
// `inbox.searchContacts` (khách). Server so khớp KHÔNG DẤU (`unaccent` + `pg_trgm`): mỗi từ của truy vấn là chuỗi con
// của tên đã chuẩn hoá, thêm khớp gần đúng khi gõ sai; khách khớp cả SĐT theo chữ số. Tìm toàn bộ, không theo phạm vi.
// Lệnh "Tạo bài viết", "Đổi phạm vi" nằm ở FE, không qua API.
import { z } from 'zod'
import { ContactStage } from './enums.ts'
import { PageDto } from './connections.ts'
import { GroupDto } from './groups.ts'

/** Số kết quả tối đa mỗi loại trong bảng lệnh. */
export const SEARCH_LIMITS = { pages: 5, groups: 5, contacts: 8 } as const
export const SEARCH_QUERY_MAX = 100

export const SearchQuery = z.object({
  q: z.string().trim().min(1).max(SEARCH_QUERY_MAX),
})
export type SearchQuery = z.input<typeof SearchQuery>

/** Nhóm khớp, kèm số trang chưa gỡ trong nhóm (như bộ chọn phạm vi). */
export const SearchGroupHit = GroupDto.extend({ pageCount: z.number().int().nonnegative() })
export type SearchGroupHit = z.infer<typeof SearchGroupHit>

/** Khách khớp (rút gọn): `pageIds` = trang chưa gỡ có định danh của khách — để FE gọi tên khách chưa có tên. */
export const SearchContactHit = z.object({
  id: z.uuid(),
  name: z.string().nullable(),
  phone: z.string().nullable(),
  stage: ContactStage,
  pageIds: z.array(z.uuid()),
})
export type SearchContactHit = z.infer<typeof SearchContactHit>

/** Mỗi loại đã xếp hạng (khớp tốt nhất trước). */
export const SearchResponse = z.object({
  pages: z.array(PageDto),
  groups: z.array(SearchGroupHit),
  contacts: z.array(SearchContactHit),
})
export type SearchResponse = z.infer<typeof SearchResponse>
