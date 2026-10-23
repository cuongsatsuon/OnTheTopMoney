// Module `ai` (AD-1, AD-7): sở hữu `ai_model_prices` (Story 1.5), `ai_budget_months`, `ai_reservations`,
// `ai_usage` (Story 1.6). Điểm DUY NHẤT gọi `adapters/openai`. Phụ thuộc: chỉ module nền (`settings`).
export const MODULE = 'ai'

export {
  OPENAI_KEY_KIND,
  deleteOpenAiKey,
  encryptionNotConfigured,
  getOpenAiKey,
  getOpenAiKeyStatus,
  getUsableOpenAiKey,
  invalidateOpenAiKey,
  recheckOpenAiKey,
  setOpenAiKey,
  type AiDeps,
  type UsableOpenAiKey,
} from './key.ts'
export { listModels, resolveModel, type AiModels } from './models.ts'
export { getOpenAiSettings, setOpenAiSettings } from './service.ts'
export {
  RESERVATION_TTL_MINUTES,
  SIMULATED_MODEL,
  gcReservations,
  getBudgetSummary,
  recomputeAlerts,
  release,
  reserve,
  resetSimulatedSpend,
  settle,
  type BudgetDeps,
  type Reservation,
  type SettleInput,
} from './budget.ts'
export {
  budgetMonth,
  computeCost,
  estimateImageCost,
  estimateInputTokens,
  estimateTextCost,
  IMAGE_ESTIMATE_DEFAULT_MICROS,
  IMAGE_ESTIMATE_MICROS,
  getModelPrice,
  parseMicros,
  type Cost,
  type ModelPrice,
  type UsageCounts,
} from './cost.ts'
export {
  MAX_IMAGES_PER_CALL,
  MAX_OUTPUT_TOKENS_LIMIT,
  generateImage,
  generateText,
  providerError,
  type AiCallUsage,
  type GenerateImageRequest,
  type GenerateImageResult,
  type GenerateTextRequest,
  type GenerateTextResult,
} from './gateway.ts'
export { handleAiEvent } from './events.ts'
// Hậu kiểm đầu ra AI (AD-21) — hàm DUY NHẤT; mẫu prompt dùng chung (AD-7).
export { checkOutput, type CheckBrand, type CheckOutputResult } from './check-output.ts'
export {
  AUTOREPLY_MAX_OUTPUT_TOKENS,
  AUTOREPLY_MODEL_REASONS,
  CAPTION_MAX_OUTPUT_TOKENS,
  CONTACT_SUMMARY_MAX_OUTPUT_TOKENS,
  REPLY_MAX_OUTPUT_TOKENS,
  buildCaptionPrompt,
  buildContactSummaryPrompt,
  contactSummaryInput,
  contactSummaryInstructions,
  buildReplyPrompt,
  captionInput,
  captionInstructions,
  replyInput,
  replyInstructions,
  autoreplyInput,
  autoreplyInstructions,
  autoreplyOutputSchema,
  buildAutoreplyPrompt,
  type AutoreplyKnowledgeEntry,
  type AutoreplyModelReason,
  type AutoreplyPromptContext,
  type CaptionBrand,
  type ContactSummaryTurn,
  type ReplyBrand,
  type ReplyContext,
  type ReplyTurn,
} from './prompts/index.ts'
