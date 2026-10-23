// Hàm quyết định của AI trả lời tự động (AD-16, AD-21, AD-9) — DÙNG CHUNG cho "Thử AI" (Story 5.3) và lượt chạy thật
// (Story 5.4 `autoreply.run`). Hai phần, bên gọi ghép theo đúng thứ tự cổng của AD-16:
// - `aiAvailabilityGate`: cổng khoá OpenAI → hạn mức (tạm đóng). Lượt chạy thật chèn `canSend` + "tin có chữ" ngay sau.
// - `decideReply`: luật chuyển người xác định (không gọi AI) → LLM structured output `{action, reply, mode, reasonCode,
//   confidence}` qua gateway → ngưỡng tin cậy → `checkOutput` (vi phạm → sinh lại MỘT lần → vẫn vi phạm thì
//   `AI_POLICY_BLOCKED`). Lỗi gateway thành quyết định chuyển người (bảng ánh xạ AD-9); huỷ (`AbortError`) ném tiếp.
// Không ghi DB ngoài `ai_usage` của gateway, không gửi gì. Không log prompt / nội dung tin / câu trả lời.
import {
  AI_OUTPUT_MAX_CHARS,
  HANDOFF_REASON_KIND,
  sendTextLimit,
  type AiOutputKind,
  type AiViolation,
  type AutoreplyOutMessage,
  type HandoffReason,
  type MessageDelivery,
  type Platform,
} from '@ottm/shared'
import { z } from 'zod'
import {
  AUTOREPLY_MODEL_REASONS,
  buildAutoreplyPrompt,
  checkOutput,
  generateText,
  getBudgetSummary,
  getOpenAiKeyStatus,
  type AiDeps,
  type AutoreplyKnowledgeEntry,
  type CheckBrand,
  type ReplyBrand,
  type ReplyTurn,
} from '../ai/index.ts'
import { AppError } from '../../platform/errors/index.ts'
import { matchHandoffRule } from './rules.ts'

/** Ngưỡng tin cậy hệ thống [ASSUMPTION AD-16]: dưới mức này mà "AI không chắc chắn" bật → `AI_UNCERTAIN`. */
export const AUTOREPLY_CONFIDENCE_MIN = 0.6

export type DecideDeps = Pick<AiDeps, 'db' | 'events' | 'cipher' | 'openai' | 'log' | 'now'>

/** Phần cấu hình (hiệu lực hoặc nháp) mà quyết định cần. */
export interface DecideConfig {
  script: string
  handoffKeywords: readonly string[]
  handoffOnCustomerAsk: boolean
  handoffOnUncertain: boolean
  handoffMessage: string
}

/** Hồ sơ cho prompt (giọng, sản phẩm) + hậu kiểm (từ cấm, domain). */
export type DecideBrand = ReplyBrand & CheckBrand

export interface DecideInput {
  feature: 'autoreply' | 'autoreply_test'
  /** `ai_usage.page_id` / `ref` — id, không phải nội dung. */
  pageId: string | null
  ref: string | null
  config: DecideConfig
  brand: DecideBrand
  knowledge: readonly AutoreplyKnowledgeEntry[]
  platform: Platform
  /** Cách gửi được phép; phần tử đầu là mặc định. */
  modes: readonly MessageDelivery[]
  pageName: string
  postText: string | null
  /** Hội thoại cũ → mới, tới tin mới nhất của khách (bên gọi đã gộp xuống dòng, cắt độ dài). */
  turns: readonly ReplyTurn[]
  /** Chữ các tin MỚI của khách trong lượt này — luật từ khoá xét trên đây. */
  latestText: string
  signal?: AbortSignal
}

export type AutoreplyDecision =
  | { action: 'reply'; messages: AutoreplyOutMessage[]; confidence: number }
  | {
      action: 'handoff'
      reasonCode: HandoffReason
      /** Chuyển chủ ý → câu chuyển tiếp `handoffMessage` (gửi trước tin `system`); tạm đóng → rỗng. */
      messages: AutoreplyOutMessage[]
      keyword: string | null
      violations: AiViolation[]
    }

/**
 * Quyết định chuyển người. Lý do chủ ý (`sticky`) kèm câu chuyển tiếp của cấu hình; tạm đóng / không áp dụng không gửi gì
 * (AD-16).
 */
export function handoffDecision(
  reasonCode: HandoffReason,
  opts: { config?: Pick<DecideConfig, 'handoffMessage'>; mode?: MessageDelivery; keyword?: string | null; violations?: AiViolation[] } = {},
): Extract<AutoreplyDecision, { action: 'handoff' }> {
  const text = opts.config?.handoffMessage.trim()
  const withMessage = HANDOFF_REASON_KIND[reasonCode] === 'sticky' && !!text && !!opts.mode
  return {
    action: 'handoff',
    reasonCode,
    messages: withMessage ? [{ mode: opts.mode!, text: text! }] : [],
    keyword: opts.keyword ?? null,
    violations: opts.violations ?? [],
  }
}

/** Cổng khoá OpenAI → hạn mức (AD-16, tạm đóng). `null` = mở. Không gọi OpenAI. */
export async function aiAvailabilityGate(deps: Pick<DecideDeps, 'db' | 'cipher' | 'now'>): Promise<HandoffReason | null> {
  const key = await getOpenAiKeyStatus(deps)
  if (key.status !== 'valid') return 'OPENAI_KEY_UNAVAILABLE'
  const budget = await getBudgetSummary({ db: deps.db, ...(deps.now ? { now: deps.now } : {}) })
  if (budget.state === 'blocked') return 'AI_BUDGET_EXCEEDED'
  return null
}

/**
 * Lỗi gateway → lý do AD-9 (bảng ánh xạ dùng chung với 5.4/5.6). `null` = không phải lỗi AI đã phân loại → bên gọi ném
 * tiếp (lỗi DB, lập trình). `CONFIG_MISSING` của gateway = chưa có model chữ nào bật — coi như sự cố phía AI.
 */
export function reasonForAiError(err: unknown): HandoffReason | null {
  if (!(err instanceof AppError)) return null
  switch (err.code) {
    case 'OPENAI_KEY_MISSING':
    case 'OPENAI_KEY_INVALID':
    case 'OPENAI_KEY_RESTRICTED':
    case 'ENCRYPTION_NOT_CONFIGURED':
      return 'OPENAI_KEY_UNAVAILABLE'
    case 'AI_BUDGET_EXCEEDED':
      return 'AI_BUDGET_EXCEEDED'
    case 'AI_PROVIDER_ERROR':
    case 'RATE_LIMITED':
    case 'CONFIG_MISSING':
      return 'AI_PROVIDER_ERROR'
    case 'AI_POLICY_BLOCKED':
      return 'AI_POLICY_BLOCKED'
    default:
      return null
  }
}

const ModelOutput = z.object({
  action: z.enum(['reply', 'handoff']),
  reply: z.string(),
  mode: z.string(),
  reasonCode: z.enum(AUTOREPLY_MODEL_REASONS).nullable(),
  confidence: z.number(),
})
type ModelOutput = z.infer<typeof ModelOutput>

/** JSON của model → kết quả; hỏng (kể cả bị cắt vì chạm giới hạn token) → `null`. */
export function parseModelOutput(text: string): ModelOutput | null {
  try {
    const parsed = ModelOutput.safeParse(JSON.parse(text))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

/** Loại hậu kiểm theo cách gửi: trả lời công khai = bình luận, còn lại = tin nhắn. */
const outputKind = (mode: MessageDelivery): AiOutputKind => (mode === 'public_reply' ? 'comment' : 'reply')

/**
 * Độ dài tối đa của tin theo cách gửi — đúng ngưỡng `checkOutput` sẽ áp (min của loại hậu kiểm và nền tảng), để prompt
 * không hứa model 2000 ký tự cho bình luận Facebook mà hậu kiểm chặn ở 1000 (sinh lại vô ích → `AI_POLICY_BLOCKED`).
 */
const replyLimit = (platform: Platform, mode: MessageDelivery): number =>
  Math.min(AI_OUTPUT_MAX_CHARS[outputKind(mode)], sendTextLimit(platform, mode))

/**
 * Quyết định cho lượt này (sau khi các cổng đã mở): luật → LLM → hậu kiểm. Tối đa 2 lời gọi LLM. Xem đầu file.
 */
export async function decideReply(deps: DecideDeps, input: DecideInput): Promise<AutoreplyDecision> {
  const { config } = input
  const defaultMode = input.modes[0]!
  const handoff = (reason: HandoffReason, extra: { mode?: MessageDelivery; keyword?: string | null; violations?: AiViolation[] } = {}) =>
    handoffDecision(reason, { config, mode: extra.mode ?? defaultMode, keyword: extra.keyword ?? null, violations: extra.violations ?? [] })

  const rule = matchHandoffRule(input.latestText, config)
  if (rule) return handoff(rule.reasonCode, { keyword: rule.keyword })

  const prompt = buildAutoreplyPrompt(input.brand, {
    platform: input.platform,
    mode: defaultMode,
    modes: input.modes,
    pageName: input.pageName,
    postText: input.postText,
    turns: input.turns,
    // Model được chọn `mode` trong `modes` → hứa ngưỡng chặt nhất trong các cách gửi đó.
    maxChars: Math.min(...input.modes.map((m) => replyLimit(input.platform, m))),
    script: config.script,
    knowledge: input.knowledge,
    handoff: { onCustomerAsk: config.handoffOnCustomerAsk, onUncertain: config.handoffOnUncertain },
  })
  const checkBrand: CheckBrand = { bannedWords: input.brand.bannedWords, allowedDomains: input.brand.allowedDomains }

  let violations: AiViolation[] = []
  for (let attempt = 0; attempt < 2; attempt++) {
    let text: string
    try {
      const res = await generateText(deps, {
        feature: input.feature,
        pageId: input.pageId,
        ref: input.ref,
        instructions: prompt.instructions,
        input: prompt.input,
        maxOutputTokens: prompt.maxOutputTokens,
        jsonSchema: prompt.jsonSchema,
        ...(input.signal ? { signal: input.signal } : {}),
      })
      text = res.text
    } catch (err) {
      const reason = reasonForAiError(err)
      if (!reason) throw err
      return handoff(reason)
    }
    const out = parseModelOutput(text)
    if (!out) return handoff('AI_PROVIDER_ERROR')
    const mode = input.modes.find((m) => m === out.mode) ?? defaultMode
    const reply = out.reply.trim()
    if (out.action === 'handoff') {
      if (out.reasonCode === 'CUSTOMER_ASKED_HUMAN' && config.handoffOnCustomerAsk) return handoff('CUSTOMER_ASKED_HUMAN', { mode })
      if (out.reasonCode !== 'CUSTOMER_ASKED_HUMAN' && config.handoffOnUncertain) return handoff('AI_UNCERTAIN', { mode })
      // Lý do model chọn đang bị tắt: dùng câu trả lời nếu có (dưới đây); không có gì để gửi thì vẫn chuyển.
    }
    if (!reply) return handoff('AI_UNCERTAIN', { mode })
    const confidence = Number.isFinite(out.confidence) ? Math.min(1, Math.max(0, out.confidence)) : 0
    if (config.handoffOnUncertain && confidence < AUTOREPLY_CONFIDENCE_MIN) return handoff('AI_UNCERTAIN', { mode })
    const check = checkOutput(reply, { brand: checkBrand, kind: outputKind(mode), maxChars: replyLimit(input.platform, mode) })
    if (check.clean) return { action: 'reply', messages: [{ mode, text: reply }], confidence }
    violations = check.violations
  }
  return handoff('AI_POLICY_BLOCKED', { violations })
}
