// Read-model tìm nhanh ⌘K (Story 4.10, AD-1, AD-18): ghép `SearchResponse` từ `pages.search` (trang, nhóm) và
// `inbox.searchContacts` (khách) — chỉ gọi hàm đọc export từ `index.ts`, không ghi, không nghiệp vụ. Tìm toàn bộ, không
// theo phạm vi: khách chỉ tính định danh trên trang chưa gỡ (`livePageIds`). Không log từ khoá (có thể là SĐT).
import { SEARCH_LIMITS, type SearchResponse } from '@ottm/shared'
import { searchContacts } from '../../modules/inbox/index.ts'
import { search as searchPages } from '../../modules/pages/index.ts'
import type { DbExecutor } from '../../platform/db/index.ts'
import { livePageIds } from './contacts.ts'

export async function searchAll(db: DbExecutor, q: string): Promise<SearchResponse> {
  const [found, live] = await Promise.all([searchPages(db, q, SEARCH_LIMITS), livePageIds(db)])
  return { pages: found.pages, groups: found.groups, contacts: await searchContacts(db, q, live, SEARCH_LIMITS.contacts) }
}
