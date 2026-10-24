// Module nền `settings` (AD-1): sở hữu `settings`, `secrets`, `sessions`. Public API chỉ export từ file này.
export const MODULE = 'settings'

export {
  OWNER_PASSWORD_SECRET,
  SESSION_TTL_DAYS,
  SESSION_RENEW_BELOW_DAYS,
  createSession,
  deleteAllSessions,
  deleteExpiredSessions,
  deleteSession,
  isSessionValid,
  normalizePassword,
  resolveSession,
  setOwnerPassword,
  verifyOwnerPassword,
  type OwnerSession,
} from './auth.ts'

export { NOTIFICATION_PREFS_KEY, getNotificationPrefs, setNotificationPrefs } from './prefs.ts'

// Story 9.3: trạng thái nội bộ của cron (con trỏ dọn file mồ côi).
export { getStateValue, setStateValue } from './state.ts'

export {
  DEFAULT_OPENAI_PREFS,
  OPENAI_API_KEY_SECRET,
  OPENAI_SETTINGS_KEY,
  getOpenAiPrefs,
  getSecretMeta,
  deleteSecret,
  getSecretValue,
  putCheckedSecret,
  setOpenAiPrefs,
  updateSecretStatus,
  type CheckedSecret,
  type OpenAiPrefs,
  type SecretMeta,
} from './openai.ts'

export { SECRET_STATUSES, type SecretStatus } from './schema.ts'
