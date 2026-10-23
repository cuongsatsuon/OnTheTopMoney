// Module nền `pages` (AD-1): sở hữu `pages` (Story 2.2) và `groups` (Story 2.5). Public API chỉ export từ file này.
// Module nền: không gọi module nào. `upsertFromPlatform` / `setConnectionStatus` chỉ `connections` được gọi (AD-5).
export const MODULE = 'pages'

export {
  findPageByPlatformAccountId,
  getPage,
  getPlatformAccountId,
  listPages,
  resolveScope,
  setConnectionStatus,
  setRemoved,
  toPageDto,
  upsertFromPlatform,
  type PlatformAccount,
  type UpsertedPage,
} from './service.ts'

// Nhóm trang (Story 2.5, AD-8). Thành viên nhóm chỉ đổi qua assign/unassign/deleteGroup (phát sự kiện trong transaction).
export {
  affectedByMove,
  assignGroup,
  createGroup,
  deleteGroup,
  getGroup,
  listGroups,
  toGroupDto,
  unassignGroup,
  updateGroup,
  type GroupChange,
} from './groups.ts'

// Tìm trang/nhóm không dấu cho ⌘K (Story 4.10, AD-18); `/api/v1/search` ghép ở `app/read-models/search.ts`.
export { search, type PagesSearchResult } from './search.ts'

/** Chỉ để module khác khai khoá ngoại tới `pages.id` / `groups.id` (Drizzle cần đối tượng bảng); không truy vấn trực tiếp. */
export { groups as groupsTable, pages as pagesTable } from './schema.ts'
