// AI gateway (Story 1.6, AD-7): điểm DUY NHẤT gọi OpenAI để sinh nội dung. Mỗi lời gọi:
//   1. lấy khoá (chưa có / invalid → lỗi, không giữ chỗ, không gọi ra ngoài);
//   2. giữ chỗ chi phí ước tính trong sổ hạn mức tháng (hết hạn mức → `AI_BUDGET_EXCEEDED`, không gọi);
//   3. gọi OpenAI (`store: false`) — Responses API cho chữ, Images API cho ảnh;
//   4. một transaction ghi `ai_usage` + đổi chỗ giữ thành chi phí thật;
//   5. phát cảnh báo 80% / 100% đúng một lần (trong `settle`).
// Lỗi có mã HTTP / huỷ trước khi gửi → trả chỗ giữ; hết giờ / đứt kết nối / huỷ sau khi gửi → ghi chi phí
// ước tính (`ai_usage.estimated`), vì OpenAI có thể đã tính tiền. 401 lúc chạy → khoá thành `invalid` + `openai_key.invalidated`.
// Không tự retry (caller quyết theo loại lỗi). Log chỉ id, feature, model, số token, chi phí (AD-12).
import { AiFeature, IMAGE_SIZES, ImageSize } from '@ottm/shared'
import type {
  CreateResponseResult,
  GenerateImageResult as AdapterImageResult,
  OpenAiAborted,
  OpenAiErrorKind,
  OpenAiFailure,
  ResponseInputMessage,
} from '../../adapters/openai/index.ts'
import { AppError } from '../../platform/errors/index.ts'
import { getOpenAiPrefs, type OpenAiPrefs } from '../settings/index.ts'
import { release, reserve, settle, type SettleInput } from './budget.ts'
import {
  assertPriced,
  computeCost,
  estimateImageCost,
  estimateTextCost,
  getModelPrice,
  type Cost,
  type ModelPrice,
  type UsageCounts,
} from './cost.ts'
import { adapterOf, getUsableOpenAiKey, invalidateOpenAiKey, type AiDeps } from './key.ts'
import { listModels, resolveModel } from './models.ts'

/** Giới hạn đầu vào của gateway (bảo vệ chi phí; caller tự đặt mức nhỏ hơn). */
export const MAX_OUTPUT_TOKENS_LIMIT = 32_000
export const MAX_IMAGES_PER_CALL = 4

/** Chi tiết chi phí của một lời gọi đã tính tiền. */
export interface AiCallUsage extends UsageCounts, Cost {
  usageId: string
  model: string
}

interface CallContext {
  feature: AiFeature
  /** Trang liên quan (nếu có) — ghi vào `ai_usage.page_id`. */
  pageId?: string | null
  /** Tham chiếu của caller (id hội thoại, bài viết…) — ghi vào `ai_usage.ref`. Không phải nội dung. */
  ref?: string | null
  /** Model cụ thể; mặc định model đã chọn ở Cài đặt (hoặc model mặc định của bảng giá). */
  model?: string
  /** Huỷ (nút "Dừng", request đóng): gửi abort sang OpenAI, trả chỗ giữ, ném `signal.reason`. */
  signal?: AbortSignal
}

export interface GenerateTextRequest extends CallContext {
  instructions?: string
  input: string | readonly ResponseInputMessage[]
  maxOutputTokens: number
}

export interface GenerateTextResult {
  text: string
  /** `max_output_tokens` = chữ bị cắt vì chạm giới hạn token. */
  incomplete: 'max_output_tokens' | null
  usage: AiCallUsage
}

export interface GenerateImageRequest extends CallContext {
  prompt: string
  /** Số ảnh (1–4), mặc định 1. */
  n?: number
  /** Mặc định kích thước ở Cài đặt. */
  size?: ImageSize
}

export interface GenerateImageResult {
  /** Ảnh JPEG. */
  images: Buffer[]
  mimeType: 'image/jpeg'
  /** Số ảnh đã yêu cầu / OpenAI thật sự trả (có thể ít hơn — chỉ tính tiền ảnh nhận được khi không có usage). */
  requested: number
  received: number
  usage: AiCallUsage
}

type GatewayDeps = AiDeps

/** Lỗi đã phân loại của adapter → lỗi API (ma trận Story 1.6). */
export function providerError(kind: OpenAiErrorKind, status?: number): AppError {
  const withStatus = status !== undefined ? { status } : {}
  switch (kind) {
    case 'KEY_INVALID':
      return new AppError('OPENAI_KEY_INVALID', 400, { details: { kind } })
    case 'KEY_RESTRICTED':
      return new AppError('OPENAI_KEY_RESTRICTED', 400, { details: { kind } })
    case 'RATE_LIMITED':
      return new AppError('RATE_LIMITED', 429, { details: { kind } })
    case 'CONTENT_REJECTED':
      return new AppError('AI_POLICY_BLOCKED', 422, { details: { kind } })
    case 'INVALID_REQUEST':
      // Lỗi cố định của request (tham số, độ dài, model) — caller không retry.
      return new AppError('AI_PROVIDER_ERROR', 400, { details: { kind, ...withStatus } })
    case 'PROVIDER_QUOTA':
    case 'TRANSIENT':
      return new AppError('AI_PROVIDER_ERROR', 502, { details: { kind, ...withStatus } })
  }
}

function abortError(signal: AbortSignal | undefined): unknown {
  return signal?.aborted ? signal.reason : new DOMException('Lời gọi AI đã bị huỷ', 'AbortError')
}

function invalid(path: string, message: string): AppError {
  return new AppError('VALIDATION_FAILED', 400, { details: [{ path: [path], message }] })
}

/** Model của lời gọi: model truyền vào, hoặc model đã chọn / mặc định của loại đó; phải có giá đúng loại. */
async function pickModel(deps: GatewayDeps, kind: 'text' | 'image', prefs: OpenAiPrefs, requested?: string): Promise<ModelPrice> {
  let model = requested
  if (!model) {
    const models = await listModels(deps.db)
    model = resolveModel(kind === 'text' ? prefs.textModel : prefs.imageModel, models[kind]) ?? undefined
  }
  if (!model) throw new AppError('CONFIG_MISSING', 400, { message: `chưa có model ${kind} nào đang bật`, details: { kind } })
  const price = assertPriced(await getModelPrice(deps.db, model), model)
  if (price.kind !== kind) throw invalid('model', `"${model}" không phải model ${kind === 'text' ? 'chữ' : 'ảnh'}`)
  if (!price.active) throw invalid('model', `"${model}" đang tắt`)
  return price
}

type Success<R> = Extract<R, { ok: true }>

interface CallPlan<R extends { ok: boolean }> {
  kind: 'text' | 'image'
  estimate(price: ModelPrice, prefs: OpenAiPrefs): Cost
  call(apiKey: string, model: string, prefs: OpenAiPrefs): Promise<R>
  usageOf(result: Success<R>): UsageCounts
}

/** Trình tự chung: khoá → giá → giữ chỗ → gọi → ghi chi phí (hoặc trả chỗ giữ). */
async function runCall<R extends { ok: true } | OpenAiFailure | OpenAiAborted>(
  deps: GatewayDeps,
  ctx: CallContext,
  plan: CallPlan<R>,
): Promise<{ result: Success<R>; usage: AiCallUsage }> {
  if (ctx.signal?.aborted) throw abortError(ctx.signal)
  const feature = AiFeature.safeParse(ctx.feature)
  if (!feature.success) throw invalid('feature', 'không phải AiFeature')

  const key = await getUsableOpenAiKey(deps)
  const prefs = await getOpenAiPrefs(deps.db)
  const price = await pickModel(deps, plan.kind, prefs, ctx.model)
  const estimate = plan.estimate(price, prefs)
  const reservation = await reserve(deps, estimate.costVnd)
  const logBase = { feature: feature.data, model: price.model, ...(ctx.pageId ? { pageId: ctx.pageId } : {}) }

  let result: R
  try {
    result = await plan.call(key.apiKey, price.model, prefs)
  } catch (err) {
    await release(deps.db, reservation.id)
    throw err
  }

  const record = (input: { usage: UsageCounts; cost: Cost; estimated: boolean }) =>
    settleOrRelease(deps, logBase, {
      reservationId: reservation.id,
      month: reservation.month,
      feature: feature.data,
      model: price.model,
      pageId: ctx.pageId ?? null,
      ref: ctx.ref ?? null,
      ...input,
    })

  if (!result.ok) {
    // Hết giờ / đứt kết nối / huỷ SAU khi đã gửi: OpenAI có thể đã tính tiền mà không trả usage →
    // ghi chi phí ước tính lúc giữ chỗ (`estimated = true`). Còn lại (mã lỗi HTTP, chưa gửi) → trả chỗ giữ.
    const maybeBilled = (result.kind === 'TRANSIENT' || result.kind === 'ABORTED') && result.maybeBilled === true
    if (maybeBilled) {
      const none = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, images: 0 }
      const { usageId } = await record({ usage: none, cost: estimate, estimated: true })
      deps.log?.warn({ ...logBase, usageId, kind: result.kind, costVnd: estimate.costVnd, estimated: true }, 'ai: ghi chi phí ước tính')
    } else {
      await release(deps.db, reservation.id)
    }
    if (result.kind === 'ABORTED') {
      deps.log?.info({ ...logBase, reservationId: reservation.id }, 'ai: lời gọi bị huỷ')
      throw abortError(ctx.signal)
    }
    if (result.kind === 'KEY_INVALID') await invalidateOpenAiKey(deps, key.envelope)
    deps.log?.warn({ ...logBase, kind: result.kind, status: result.status }, 'ai: OpenAI trả lỗi')
    throw providerError(result.kind, result.status)
  }

  const success = result as Success<R>
  const counts = plan.usageOf(success)
  const cost = computeCost(price, counts, prefs.exchangeRateVnd)
  const { usageId } = await record({ usage: counts, cost, estimated: false })
  const usage: AiCallUsage = { usageId, model: price.model, ...counts, ...cost }
  deps.log?.info({ ...logBase, ...usage, estVnd: reservation.estVnd }, 'ai: lời gọi xong')
  return { result: success, usage }
}

/**
 * `settle`; lỗi (DB…) → trả chỗ giữ (không giữ hạn mức 15 phút) và log feature/model/chi phí — không nội dung —
 * để đối soát tay, rồi ném lại.
 */
async function settleOrRelease(deps: GatewayDeps, logBase: Record<string, unknown>, input: SettleInput): Promise<{ usageId: string }> {
  try {
    return await settle(deps, input)
  } catch (err) {
    await release(deps.db, input.reservationId!).catch(() => {})
    deps.log?.error(
      { ...logBase, err, costVnd: input.cost.costVnd, usdMicros: input.cost.usdMicros, estimated: input.estimated ?? false },
      'ai: không ghi được chi phí lời gọi đã tính tiền',
    )
    throw err
  }
}

function inputChars(req: Pick<GenerateTextRequest, 'instructions' | 'input'>): number {
  const input = typeof req.input === 'string' ? req.input.length : req.input.reduce((n, m) => n + m.content.length, 0)
  return (req.instructions?.length ?? 0) + input
}

/** Sinh chữ qua Responses API. Trả `{text, usage}`; nội dung bị chặn / model từ chối → `AI_POLICY_BLOCKED` (vẫn tính tiền). */
export async function generateText(deps: GatewayDeps, req: GenerateTextRequest): Promise<GenerateTextResult> {
  if (!Number.isInteger(req.maxOutputTokens) || req.maxOutputTokens < 1 || req.maxOutputTokens > MAX_OUTPUT_TOKENS_LIMIT) {
    throw invalid('maxOutputTokens', `số nguyên 1–${MAX_OUTPUT_TOKENS_LIMIT}`)
  }
  const chars = inputChars(req)
  const { result, usage } = await runCall<CreateResponseResult>(deps, req, {
    kind: 'text',
    estimate: (price, prefs) => estimateTextCost(price, chars, req.maxOutputTokens, prefs.exchangeRateVnd),
    call: (apiKey, model) =>
      adapterOf(deps).createResponse({
        apiKey,
        model,
        input: req.input,
        maxOutputTokens: req.maxOutputTokens,
        ...(req.instructions ? { instructions: req.instructions } : {}),
        ...(req.signal ? { signal: req.signal } : {}),
      }),
    usageOf: (r) => ({ ...r.usage, images: 0 }),
  })
  if (result.incomplete === 'content_filter' || result.incomplete === 'refusal') {
    throw new AppError('AI_POLICY_BLOCKED', 422, { details: { kind: 'CONTENT_REJECTED', usageId: usage.usageId } })
  }
  return { text: result.text, incomplete: result.incomplete, usage }
}

/** Sinh ảnh qua Images API (JPEG). Chi phí theo `usage` nếu API trả, ngược lại số ảnh × `image_usd_each`. */
export async function generateImage(deps: GatewayDeps, req: GenerateImageRequest): Promise<GenerateImageResult> {
  const n = req.n ?? 1
  if (!Number.isInteger(n) || n < 1 || n > MAX_IMAGES_PER_CALL) throw invalid('n', `số nguyên 1–${MAX_IMAGES_PER_CALL}`)
  if (req.size !== undefined && !ImageSize.safeParse(req.size).success) throw invalid('size', IMAGE_SIZES.join(' | '))
  const { result, usage } = await runCall<AdapterImageResult>(deps, req, {
    kind: 'image',
    estimate: (price, prefs) => estimateImageCost(price, n, req.size ?? prefs.imageSize, prefs.exchangeRateVnd),
    call: (apiKey, model, prefs) =>
      adapterOf(deps).generateImage({
        apiKey,
        model,
        prompt: req.prompt,
        n,
        size: req.size ?? prefs.imageSize,
        ...(req.signal ? { signal: req.signal } : {}),
      }),
    usageOf: (r) => ({
      inputTokens: r.usage?.inputTokens ?? 0,
      cachedInputTokens: r.usage?.cachedInputTokens ?? 0,
      outputTokens: r.usage?.outputTokens ?? 0,
      images: r.images.length,
    }),
  })
  return { images: result.images, mimeType: 'image/jpeg', requested: n, received: result.images.length, usage }
}
