// Module `autoreply` (AD-1, AD-16): AI trả lời tự động. Public API chỉ export từ file này.
// Gọi: `inbox` (áp quyết định), `profiles`, `ai` (Epic 5). Chỉ entrypoint (worker; api cho "Thử AI") gọi module này.
// Story 4.3: bước triage (luôn `AI_OFF` → `human` tới khi Story 5.4 nối chuỗi cổng đầy đủ).
// Story 5.3: hàm quyết định dùng chung (cổng sẵn sàng AI, luật chuyển người, LLM + hậu kiểm) và lượt "Thử AI".
export const MODULE = 'autoreply'

export { decideTriage, handleTriageEvent, type TriageDeps, type TriageOutcome } from './triage.ts'
export {
  AUTOREPLY_CONFIDENCE_MIN,
  aiAvailabilityGate,
  decideReply,
  handoffDecision,
  parseModelOutput,
  reasonForAiError,
  type AutoreplyDecision,
  type DecideBrand,
  type DecideConfig,
  type DecideDeps,
  type DecideInput,
} from './decide.ts'
export { ASK_HUMAN_PHRASES, foldForMatch, matchHandoffRule, type HandoffRuleConfig, type HandoffRuleMatch } from './rules.ts'
export { runAutoreplyTest } from './test-run.ts'
