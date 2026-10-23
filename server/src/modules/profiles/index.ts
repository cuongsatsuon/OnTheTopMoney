// Module `profiles` (AD-1, Story 3.1): sở hữu `brand_profiles`, `page_config_state`, `autoreply_configs` (Story 5.1).
// Public API chỉ export từ file này.
// Được gọi `pages` (base) + `adapters/media`; tự nó được `autoreply`, `campaigns`, `content` gọi (bảng mũi tên AD-1).
export const MODULE = 'profiles'

export {
  LOGO_VALIDATION,
  clearLogo,
  detectImageMime,
  getProfile,
  setLogo,
  upsertProfile,
  validateLogoBytes,
  type ProfileOwner,
} from './service.ts'

// Kế thừa Nhóm→Trang (Story 3.2 + 3.3, AD-8): resolveEffective là hàm DUY NHẤT giải kế thừa; registry loại cấu hình.
export {
  REGISTRY,
  REGISTERED_KINDS,
  applyGroupChange,
  getPageConfigState,
  onGroupProfileSaved,
  resolveEffective,
  setUseOwn,
  type ConfigKindOps,
} from './inheritance.ts'

// Consumer sự kiện đổi nhóm (queue `events.profiles`) — Story 3.3.
export { handleProfilesEvent, type ProfilesEventDeps, type ProfilesEventResult } from './events.ts'

// Cấu hình AI trả lời tự động (Story 5.1, AD-8): loại cấu hình `autoreply` của registry kế thừa.
export {
  autoreplyOverview,
  buildAutoreplyScript,
  bulkSetAutoreplyEnabled,
  getAutoreplyConfig,
  getEffectiveAutoreply,
  saveAutoreplyConfig,
  setAutoreplyUseOwn,
} from './autoreply.ts'
export { scriptForIndustry, scriptFromBrand } from './autoreply-template.ts'
