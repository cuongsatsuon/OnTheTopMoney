// "Thử AI" trước khi bật (Story 5.3, AD-16): chạy ĐÚNG đường quyết định của lượt chạy thật (`decide.ts`) với cấu hình
// NHÁP của chủ (chưa lưu), giả như khách vừa nhắn `message` qua `channel`. Chuỗi rút gọn theo AD-16: kênh (không áp
// dụng) → khoá OpenAI → hạn mức → [bỏ cổng giờ, `canSend`, `ai_enabled`, `AI_OFF` — thử được cả khi AI đang tắt] →
// luật → LLM → hậu kiểm. Gateway `feature=autoreply_test`. Không ghi tin, không đổi trạng thái hội thoại, không gửi Meta.
// Nguồn prompt (hồ sơ hiệu lực, kho kiến thức đang hiển thị) do `profiles.autoreplyTestSources` giải.
import {
  AUTOREPLY_CHANNEL_MODE,
  AUTOREPLY_CHANNEL_PLATFORMS,
  HANDOFF_REASON_KIND,
  type AutoreplyChannel,
  type AutoreplyTestResponse,
  type HandoffReason,
  type ParsedAutoreplyTestRequest,
  type Platform,
} from '@ottm/shared'
import type { ReplyTurn } from '../ai/index.ts'
import { autoreplyTestSources, type AutoreplyTestSources } from '../profiles/index.ts'
import { AppError } from '../../platform/errors/index.ts'
import { aiAvailabilityGate, brandOrEmpty, decideReply, handoffDecision, type AutoreplyDecision, type DecideDeps } from './decide.ts'

/** Cắt mỗi lượt đưa vào prompt (chi phí, AD-7). */
const TURN_TEXT_MAX = 1000

/** Một lượt một dòng (chữ khách không giả được lượt "Shop:" — chống prompt-injection như Gợi ý AI 4.8) + cắt độ dài. */
function oneLine(text: string, max = TURN_TEXT_MAX): string {
  const chars = [...text.replace(/\s+/g, ' ').trim()]
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : chars.join('')
}

/**
 * Nền tảng giả lập: trang → nền tảng của trang (kênh phải có trên nền tảng đó); nhóm → nền tảng đầu tiên của kênh mà
 * nhóm có trang, không có thì nền tảng mặc định của kênh. Kênh không hợp nền tảng của trang → 400 path `channel`.
 */
function platformFor(sources: AutoreplyTestSources, channel: AutoreplyChannel): Platform {
  const supported = AUTOREPLY_CHANNEL_PLATFORMS[channel]
  if (sources.pageId) {
    const platform = sources.platforms[0]!
    if (!supported.includes(platform)) {
      throw new AppError('VALIDATION_FAILED', 400, { details: [{ path: ['channel'], message: 'Kênh này không có trên nền tảng của trang' }] })
    }
    return platform
  }
  return supported.find((p) => sources.platforms.includes(p)) ?? supported[0]!
}

const kindOf = (reason: HandoffReason) => HANDOFF_REASON_KIND[reason]

function toResponse(decision: AutoreplyDecision): AutoreplyTestResponse {
  if (decision.action === 'reply') {
    return { action: 'reply', reasonCode: null, handoffKind: null, messages: decision.messages, keyword: null, violations: [] }
  }
  const kind = kindOf(decision.reasonCode)
  return {
    action: kind === 'not_applicable' ? 'not_applicable' : 'handoff',
    reasonCode: decision.reasonCode,
    handoffKind: kind === 'not_applicable' ? null : kind,
    messages: decision.messages,
    keyword: decision.keyword,
    violations: decision.violations,
  }
}

/** Chạy một lượt thử. Owner lạ → 404; kho vượt giới hạn → 422 `KNOWLEDGE_TOO_LARGE` (không gọi AI). */
export async function runAutoreplyTest(
  deps: DecideDeps,
  req: ParsedAutoreplyTestRequest,
  signal?: AbortSignal,
): Promise<AutoreplyTestResponse> {
  const owner = { ownerType: req.ownerType, ownerId: req.ownerId }
  const sources = await autoreplyTestSources(deps.db, owner)
  const platform = platformFor(sources, req.channel)
  const mode = AUTOREPLY_CHANNEL_MODE[req.channel]
  const cfg = req.config

  let decision: AutoreplyDecision
  if (!cfg.channels.includes(req.channel)) {
    decision = handoffDecision('CHANNEL_OFF')
  } else {
    const gate = await aiAvailabilityGate(deps)
    if (gate) {
      decision = handoffDecision(gate)
    } else {
      const turns: ReplyTurn[] = [
        ...req.history.map((t) => ({ author: t.author, text: oneLine(t.text) })),
        { author: 'customer', text: oneLine(req.message) },
      ]
      decision = await decideReply(deps, {
        feature: 'autoreply_test',
        pageId: sources.pageId,
        ref: req.ownerId,
        config: cfg,
        brand: brandOrEmpty(sources.brand),
        knowledge: sources.knowledge,
        platform,
        modes: [mode],
        pageName: sources.name,
        postText: null,
        turns,
        latestText: req.message,
        ...(signal ? { signal } : {}),
      })
    }
  }
  deps.log?.info(
    { ...owner, channel: req.channel, action: decision.action, reasonCode: decision.action === 'handoff' ? decision.reasonCode : null },
    'autoreply: thử AI',
  )
  return toResponse(decision)
}
