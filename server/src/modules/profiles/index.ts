// Module `profiles` (AD-1, Story 3.1): sở hữu `brand_profiles`. Public API chỉ export từ file này.
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
