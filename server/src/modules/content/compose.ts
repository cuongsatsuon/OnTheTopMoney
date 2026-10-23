// Viết caption bằng AI theo hồ sơ từng trang (Story 6.2, AD-2 ngoại lệ sinh chữ tương tác + AD-7 + AD-8 + AD-21).
// Chạy TRONG request api (không job, không lưu bài): mỗi trang đích → hồ sơ hiệu lực (`profiles.resolveEffectiveOrNull`,
// không có → `CONFIG_MISSING` cho riêng trang đó) → mẫu prompt chung `ai/prompts/compose.ts` → gateway
// `feature=compose_caption` (`signal` = nút Dừng) → `ai.checkOutput` theo nền tảng (Threads đếm emoji theo byte); vi phạm
// → sinh lại MỘT lần kèm ghi chú vi phạm; vẫn vi phạm → trả kèm cụm vi phạm để FE đánh dấu trên tab của trang.
// Một trang lỗi không chặn trang khác; lỗi khoá OpenAI / hạn mức dừng các trang chưa bắt đầu. Không log prompt / nội dung.
import {
  AI_OUTPUT_MAX_CHARS,
  PLATFORM_RULES,
  type AiFeature,
  type BrandProfileDto,
  type ComposeCaptionResult,
  type ComposeCaptionsResponse,
  type ErrorCode,
  type PageDto,
  type ParsedComposeCaptionsRequest,
} from '@ottm/shared'
import { buildComposePrompt, checkOutput, generateText, retryNote, type AiDeps, type CheckBrand } from '../ai/index.ts'
import { getPage } from '../pages/index.ts'
import { resolveEffectiveOrNull } from '../profiles/index.ts'
import { AppError } from '../../platform/errors/index.ts'

/** Số trang viết song song [ASSUMPTION]: đủ nhanh cho một nhóm 3–5 trang, không dồn quá nhiều lời gọi OpenAI một lúc. */
export const COMPOSE_CONCURRENCY = 3

/**
 * Mã lỗi khiến các trang CHƯA bắt đầu dừng luôn (cùng mã, không gọi AI): thiếu / hỏng khoá OpenAI, hết hạn mức, chưa
 * cấu hình mã hoá — lỗi toàn cục, gọi tiếp chỉ lặp lại cùng lỗi.
 */
export const AI_STOP_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  'OPENAI_KEY_MISSING',
  'OPENAI_KEY_INVALID',
  'OPENAI_KEY_RESTRICTED',
  'AI_BUDGET_EXCEEDED',
  'ENCRYPTION_NOT_CONFIGURED',
])

export type ComposeDeps = Pick<AiDeps, 'db' | 'events' | 'cipher' | 'openai' | 'log'>

const isAbortError = (err: unknown): boolean => err instanceof Error && err.name === 'AbortError'

/**
 * Caption AI cho từng trang của `input.pageIds` (kết quả đúng thứ tự). Trang không có / đã gỡ → `VALIDATION_FAILED`
 * (không gọi AI). `signal` huỷ → ném AbortError (bên gọi: `runAbortable`). Tối đa 2 lời gọi AI mỗi trang.
 * `concurrency` chỉ để test thứ tự (mặc định `COMPOSE_CONCURRENCY`).
 */
export async function composeCaptions(
  deps: ComposeDeps,
  input: ParsedComposeCaptionsRequest,
  signal: AbortSignal,
  options: { concurrency?: number } = {},
): Promise<ComposeCaptionsResponse> {
  const pages: PageDto[] = []
  const missing: { path: (string | number)[]; message: string }[] = []
  for (const [i, id] of input.pageIds.entries()) {
    const page = await getPage(deps.db, id)
    if (page) pages.push(page)
    else missing.push({ path: ['pageIds', i], message: 'Trang không tồn tại hoặc đã gỡ' })
  }
  if (missing.length) throw new AppError('VALIDATION_FAILED', 400, { message: 'Trang đích không hợp lệ', details: missing })

  // Hồ sơ trước mọi lời gọi AI: trang chưa có hồ sơ hiệu lực giữ `CONFIG_MISSING` (báo riêng tab đó, không tốn lời
  // gọi); trang có hồ sơ được ghi đè bằng kết quả viết.
  const results = pages.map((page): ComposeCaptionResult => ({ pageId: page.id, status: 'error', errorCode: 'CONFIG_MISSING' }))
  const jobs: { index: number; page: PageDto; brand: BrandProfileDto }[] = []
  for (const [index, page] of pages.entries()) {
    const effective = await resolveEffectiveOrNull<BrandProfileDto>(deps.db, page.id, 'brand')
    if (effective) jobs.push({ index, page, brand: effective.config })
  }

  let stopCode: ErrorCode | null = null
  let next = 0
  const worker = async () => {
    while (next < jobs.length) {
      const job = jobs[next++]!
      signal.throwIfAborted()
      if (stopCode) {
        results[job.index] = { pageId: job.page.id, status: 'error', errorCode: stopCode }
        continue
      }
      try {
        results[job.index] = await composeCaptionForPage(deps, job.page, job.brand, input, signal)
      } catch (err) {
        // Dừng (client đóng kết nối) → ném lên cho `runAbortable`; lỗi khác chỉ là lỗi của trang này.
        if (signal.aborted) throw err
        const code: ErrorCode | null = err instanceof AppError ? err.code : isAbortError(err) ? 'AI_PROVIDER_ERROR' : null
        if (!code) throw err
        if (AI_STOP_CODES.has(code)) stopCode ??= code
        results[job.index] = { pageId: job.page.id, status: 'error', errorCode: code }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(options.concurrency ?? COMPOSE_CONCURRENCY, jobs.length) }, worker))
  return { results }
}

/** Nội dung cần viết cho một trang: ý tưởng, mục tiêu, độ dài, yêu cầu sửa (nếu có). */
export type ComposeBrief = Pick<ParsedComposeCaptionsRequest, 'topic' | 'goal' | 'length'> & { revise?: ParsedComposeCaptionsRequest['revise'] }

/**
 * Một trang: prompt theo hồ sơ + nền tảng → gateway → hậu kiểm, sinh lại một lần nếu vi phạm. Dùng chung cho Soạn bài
 * (`compose_caption`) và slot chiến dịch (Story 7.2, `campaign_generate`, `ref` = target). Lỗi gateway ném lên.
 */
export async function composeCaptionForPage(
  deps: ComposeDeps,
  page: PageDto,
  brand: BrandProfileDto,
  brief: ComposeBrief,
  signal: AbortSignal | undefined,
  call: { feature: AiFeature; ref?: string } = { feature: 'compose_caption' },
): Promise<ComposeCaptionResult> {
  const rule = PLATFORM_RULES[page.platform]
  // Giới hạn chữ của AI: luật nền tảng nhưng không quá trần caption của AI (Facebook cho 63.206 — caption AI vẫn ≤ 2.200).
  const maxChars = Math.min(rule.captionMax, AI_OUTPUT_MAX_CHARS.caption)
  const prompt = buildComposePrompt(brand, {
    platform: page.platform,
    pageName: page.name,
    topic: brief.topic,
    goal: brief.goal,
    length: brief.length,
    maxChars,
    revise: brief.revise ?? null,
  })
  const checkBrand: CheckBrand = { bannedWords: brand.bannedWords, allowedDomains: brand.allowedDomains }
  const generate = async (note = '') =>
    (
      await generateText(deps, {
        feature: call.feature,
        pageId: page.id,
        ...(call.ref ? { ref: call.ref } : {}),
        instructions: prompt.instructions,
        input: note ? `${prompt.input}\n\n${note}` : prompt.input,
        maxOutputTokens: prompt.maxOutputTokens,
        ...(signal ? { signal } : {}),
      })
    ).text.trim()
  const check = (text: string) => checkOutput(text, { brand: checkBrand, kind: 'caption', maxChars, platform: page.platform })

  let caption = await generate()
  let result = check(caption)
  if (!result.clean) {
    caption = await generate(retryNote(result.violations, 'Bản caption'))
    result = check(caption)
  }
  // Model trả rỗng (vd hết token đầu ra) → lỗi của riêng trang này; không trả `ok` rỗng để FE đè mất caption đang có.
  if (!caption) return { pageId: page.id, status: 'error', errorCode: 'AI_PROVIDER_ERROR' }
  return { pageId: page.id, status: 'ok', caption, violations: result.violations }
}
