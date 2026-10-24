// AI viết mô tả ảnh ở Soạn bài (Story 6.7, AD-2 ngoại lệ sinh chữ tương tác + AD-7 + AD-8), theo "Gợi ý prompt nhanh"
// của FlowMate. Chạy TRONG request api (không job, không lưu): mô tả đang có (trống thì ý tưởng bài) + hướng của chip →
// mẫu prompt chung `ai/prompts/image.ts` → gateway `feature=image_prompt` (`signal` = Dừng) → làm sạch → trả một đoạn
// mô tả để chủ shop xem / sửa trước khi bấm "Tạo ảnh AI". Không hậu kiểm từ cấm (mô tả không được đăng).
// `commonBrandProfile`: hồ sơ thương hiệu chung của các trang đích (cùng một nguồn kế thừa) — tông màu / ngành hàng cho
// prompt ảnh (`images.ts`) và cho mô tả. Không log prompt / mô tả.
import type { BrandProfileDto, ImagePromptResponse, ParsedImagePromptRequest } from '@ottm/shared'
import { budgetMonth, buildImageDescriptionPrompt, cleanImageDescription, generateText, type AiDeps } from '../ai/index.ts'
import { getPage } from '../pages/index.ts'
import { resolveEffectiveOrNull } from '../profiles/index.ts'
import type { DbExecutor } from '../../platform/db/index.ts'
import { AppError } from '../../platform/errors/index.ts'

export type ImagePromptDeps = Pick<AiDeps, 'db' | 'events' | 'cipher' | 'openai' | 'log'> & { now?: () => Date }

/**
 * Hồ sơ thương hiệu hiệu lực mà MỌI trang (còn tồn tại) trong `pageIds` cùng dùng — cùng `ownerType` + `ownerId`. Trang
 * không còn → bỏ qua; có trang chưa có hồ sơ, các trang khác nguồn, hoặc không còn trang nào → `null` (bỏ tông màu).
 */
export async function commonBrandProfile(db: DbExecutor, pageIds: readonly string[] | undefined): Promise<BrandProfileDto | null> {
  let common: { key: string; config: BrandProfileDto } | null = null
  for (const id of new Set(pageIds ?? [])) {
    if (!(await getPage(db, id))) continue
    const effective = await resolveEffectiveOrNull<BrandProfileDto>(db, id, 'brand')
    if (!effective) return null
    const key = `${effective.source.ownerType}:${effective.source.ownerId}`
    if (common && common.key !== key) return null
    common ??= { key, config: effective.config }
  }
  return common?.config ?? null
}

/** `2026-10` → `10/2026` (tháng giờ VN, như tháng hạn mức). */
const monthLabel = (now: Date) => {
  const [y, m] = budgetMonth(now).split('-')
  return `${m}/${y}`
}

/**
 * Một lượt "AI viết mô tả": một lời gọi model chữ. Lỗi gateway (khoá, hạn mức, OpenAI) ném lên giữ nguyên mã; model trả
 * rỗng → `AI_PROVIDER_ERROR` (FE giữ nguyên ô). `signal` huỷ → AbortError (bên gọi: `runAbortable`).
 */
export async function writeImageDescription(deps: ImagePromptDeps, input: ParsedImagePromptRequest, signal: AbortSignal): Promise<ImagePromptResponse> {
  const brand = await commonBrandProfile(deps.db, input.pageIds)
  const prompt = buildImageDescriptionPrompt({
    description: input.description,
    topic: input.topic,
    direction: input.direction,
    goal: input.goal,
    style: input.style,
    withReference: input.withReference,
    brand: brand && (brand.industry || brand.colors.length) ? { industry: brand.industry, colors: brand.colors } : null,
    month: monthLabel(deps.now?.() ?? new Date()),
  })
  const res = await generateText(deps, {
    feature: 'image_prompt',
    instructions: prompt.instructions,
    input: prompt.input,
    maxOutputTokens: prompt.maxOutputTokens,
    signal,
  })
  const description = cleanImageDescription(res.text)
  if (!description) throw new AppError('AI_PROVIDER_ERROR', 502, { message: 'AI chưa viết được mô tả, thử lại.' })
  return { description }
}
