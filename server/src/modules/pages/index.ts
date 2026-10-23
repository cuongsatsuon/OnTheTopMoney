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

/** Chỉ để `connections` khai khoá ngoại tới `pages.id` (Drizzle cần đối tượng bảng); không truy vấn trực tiếp. */
export { pages as pagesTable } from './schema.ts'
