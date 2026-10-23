// Gợi ý bằng AI khi trả lời (Story 4.8, AD-2 ngoại lệ sinh chữ tương tác + AD-7 + AD-21). Chạy TRONG request api (không
// job): ngữ cảnh = các tin gần nhất của hội thoại + bài được bình luận; giọng = hồ sơ hiệu lực của trang (bên gọi giải qua
// `profiles.resolveEffective` rồi truyền vào — `inbox` không gọi `profiles`, AD-1). Gateway `feature=inbox_suggest`
// (`signal` = nút Dừng), hậu kiểm `ai.checkOutput`: vi phạm → sinh lại MỘT lần; vẫn vi phạm → trả kèm cụm vi phạm để FE
// đánh dấu. Không ghi tin, không đổi trạng thái hội thoại, không tự gửi. Không log prompt / nội dung tin / bản nháp.
import { sendModesFor, sendTextLimit, type AiOutputKind, type MessageDelivery, type MessageDto, type SuggestReplyResponse } from '@ottm/shared'
import {
  buildReplyPrompt,
  checkOutput,
  generateText,
  type AiDeps,
  type CheckBrand,
  type ReplyBrand,
  type ReplyTurn,
} from '../ai/index.ts'
import { getPage } from '../pages/index.ts'
import { AppError } from '../../platform/errors/index.ts'
import { getConversation, listMessages } from './queries.ts'

/** Số tin gần nhất (không phải `system`) đưa vào prompt. */
export const SUGGEST_CONTEXT_MESSAGES = 20
/** Số dòng tin đọc để lọc ra đủ ngữ cảnh (tin `system` / lỗi / đã xoá bị bỏ). */
const SUGGEST_SCAN_MESSAGES = 60
/** Cắt mỗi tin / caption bài để prompt không phình (chi phí, AD-7). */
export const SUGGEST_TEXT_MAX = 1000

export type SuggestDeps = Pick<AiDeps, 'db' | 'events' | 'cipher' | 'openai' | 'log'>

/** Hồ sơ hiệu lực mà gợi ý cần: phần giọng cho prompt + từ cấm / domain cho hậu kiểm. */
export type SuggestBrand = ReplyBrand & CheckBrand

export interface SuggestInput {
  /** Bỏ trống → mặc định của kênh (`sendModesFor`), như gửi tin. */
  mode?: MessageDelivery | undefined
  /** Hồ sơ hiệu lực của trang (bên gọi: `profiles.resolveEffective`; không có → ném `CONFIG_MISSING`). */
  brandOf: (pageId: string) => Promise<SuggestBrand>
  /** Nút "Dừng" / client đóng kết nối → huỷ sang OpenAI. */
  signal: AbortSignal
}

export type SuggestResult = { status: 'missing' } | ({ status: 'ok' } & SuggestReplyResponse)

const cut = (text: string, max = SUGGEST_TEXT_MAX) => {
  // Gộp xuống dòng thành một dòng: chữ khách không giả được lượt "Shop:" / câu lệnh cuối trong bản ghi hội thoại
  // (mỗi lượt đúng một dòng — chống prompt-injection).
  const chars = [...text.replace(/\s*[^\S \t]+\s*/g, ' ').trim()]
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : chars.join('')
}

/**
 * Tin của hội thoại → lượt hội thoại cho prompt (cũ → mới, tối đa `SUGGEST_CONTEXT_MESSAGES`). Bỏ tin `system`, tin
 * outbound `failed` (không tới khách) và tin đã xoá/ẩn; tin không chữ → ghi chú số đính kèm. Người viết khác khách của
 * hội thoại (luồng bình luận) → `other`.
 */
export function replyTurns(items: readonly MessageDto[], contactId: string): ReplyTurn[] {
  const turns: ReplyTurn[] = []
  for (const m of items) {
    if (m.direction === null || m.removal !== null) continue
    if (m.direction === 'outbound' && m.status === 'failed') continue
    const text = m.text?.trim() ? cut(m.text) : m.attachments.length ? `[gửi ${m.attachments.length} đính kèm]` : null
    if (!text) continue
    const author = m.direction === 'outbound' ? 'shop' : m.sender && m.sender.contactId !== contactId ? 'other' : 'customer'
    turns.push({ author, text })
  }
  return turns.slice(-SUGGEST_CONTEXT_MESSAGES)
}

/** Loại hậu kiểm theo cách gửi: trả lời công khai = bình luận (ngắn hơn), còn lại = tin nhắn. */
export const suggestKind = (mode: MessageDelivery): AiOutputKind => (mode === 'public_reply' ? 'comment' : 'reply')

/**
 * Bản nháp trả lời cho hội thoại `conversationId`. Hội thoại không có / trang đã gỡ → `missing`; mode lệch kênh →
 * `VALIDATION_FAILED`; lỗi hồ sơ (`CONFIG_MISSING`) và lỗi gateway (`OPENAI_KEY_*`, `AI_BUDGET_EXCEEDED`, `AbortError`…)
 * ném nguyên cho bên gọi. Tối đa 2 lời gọi AI.
 */
export async function suggestReply(deps: SuggestDeps, conversationId: string, input: SuggestInput): Promise<SuggestResult> {
  const conv = await getConversation(deps.db, conversationId)
  const page = conv ? await getPage(deps.db, conv.pageId) : null
  if (!conv || !page) return { status: 'missing' }
  const modes = sendModesFor(page.platform, conv.channel)
  const mode = input.mode ?? modes[0]!
  if (!modes.includes(mode)) throw new AppError('VALIDATION_FAILED', 400, { message: 'Cách gửi không hợp lệ cho hội thoại này' })

  // Hồ sơ trước khi đọc tin / gọi AI: trang chưa có hồ sơ → CONFIG_MISSING, không tốn lời gọi nào.
  const brand = await input.brandOf(conv.pageId)
  const recent = await listMessages(deps.db, conv.id, { limit: SUGGEST_SCAN_MESSAGES })
  const prompt = buildReplyPrompt(brand, {
    platform: page.platform,
    mode,
    pageName: page.name,
    postText: conv.post?.text ? cut(conv.post.text) : null,
    turns: replyTurns(recent.items, conv.contact.id),
    maxChars: sendTextLimit(page.platform, mode),
  })
  const checkBrand: CheckBrand = { bannedWords: brand.bannedWords, allowedDomains: brand.allowedDomains }
  const kind = suggestKind(mode)
  const generate = async () =>
    (
      await generateText(deps, {
        feature: 'inbox_suggest',
        pageId: conv.pageId,
        ref: conv.id,
        instructions: prompt.instructions,
        input: prompt.input,
        maxOutputTokens: prompt.maxOutputTokens,
        signal: input.signal,
      })
    ).text.trim()

  let draft = await generate()
  let check = checkOutput(draft, { brand: checkBrand, kind })
  if (!check.clean) {
    draft = await generate()
    check = checkOutput(draft, { brand: checkBrand, kind })
  }
  return { status: 'ok', draft, violations: check.violations }
}
