// Module `profiles` (AD-1, Story 3.1): sở hữu `brand_profiles`, `page_config_state`, `autoreply_configs` (Story 5.1),
// `knowledge_items` (Story 5.2).
// Public API chỉ export từ file này.
// Gọi `pages` (base), `ai` (ước tính token kho kiến thức) + `adapters/media`; tự nó được `autoreply`, `campaigns`, `content` gọi (bảng mũi tên AD-1).
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
  autoreplyRunSources,
  autoreplyTestSources,
  type AutoreplyRunSources,
  type AutoreplyTestSources,
} from './autoreply.ts'
export { listReadyKnowledge, type ReadyKnowledgeEntry } from './knowledge-row.ts'
export { scriptForIndustry, scriptFromBrand } from './autoreply-template.ts'

// Kho kiến thức (Story 5.2, AD-14, AD-16): FAQ + file (trích văn bản bằng job `profiles.knowledge.extract`).
export {
  KNOWLEDGE_FILE_VALIDATION,
  KnowledgeRetryableError,
  addKnowledgeFaq,
  assertCanAddKnowledge,
  deleteKnowledgeItem,
  handleKnowledgeExtractJob,
  listKnowledge,
  processKnowledgeFile,
  recordKnowledgeFile,
  validateKnowledgeFile,
  type KnowledgeExtractDeps,
  type KnowledgeExtractOutcome,
} from './knowledge.ts'
export { EXTRACT_TIMEOUT_MS, runExtraction } from './knowledge-extract-thread.ts'
export { detectKnowledgeMime, extractKnowledgeText, type ExtractResult } from './knowledge-files.ts'
