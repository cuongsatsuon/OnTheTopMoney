// Module `autoreply` (AD-1, AD-16): AI trả lời tự động. Public API chỉ export từ file này.
// Gọi: `inbox` (áp quyết định), `profiles`, `ai` (Epic 5). Chỉ entrypoint (worker; api cho "Thử AI") gọi module này.
// Story 4.3: bước triage. Story 5.3: hàm quyết định dùng chung (cổng sẵn sàng AI, luật chuyển người, LLM + hậu kiểm)
// và lượt "Thử AI". Story 5.4: chuỗi cổng AD-16 ở triage, lượt chạy `autoreply.run` (bảng `autoreply_runs`), AI tự trả
// lời tin nhắn và chuyển cho người. Story 5.5: AI trả lời bình luận (công khai / nhắn riêng / cả hai; Threads chỉ công khai).
export const MODULE = 'autoreply'

export { decideTriage, handleTriageEvent, type TriageDeps, type TriageOutcome } from './triage.ts'
export {
  AUTOREPLY_RUN_DELAY_MS,
  POST_TEXT_RETRY_MS,
  POST_TEXT_WAIT_MS,
  enqueueAutoreplyRun,
  handleRunJob,
  parseRunJobData,
  runAutoreply,
  type RunDeps,
  type RunOutcome,
} from './run.ts'
export { preGates, servingChannels, vnClock, withinActiveHours, type GateInput, type GateResult } from './gates.ts'
export { AUTOREPLY_RUN_OUTCOMES, type AutoreplyRunOutcome } from './schema.ts'
export {
  AUTOREPLY_CONFIDENCE_MIN,
  aiAvailabilityGate,
  brandOrEmpty,
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
