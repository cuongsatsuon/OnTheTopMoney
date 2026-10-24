// Tính chi phí AI (Story 1.6, AD-7): chi phí = usage × `ai_model_prices` × tỉ giá trong Cài đặt.
// Tính bằng số nguyên lớn (đơn vị 10⁻¹² USD) để không lệch do số thực; VND làm tròn LÊN tới đồng
// [ASSUMPTION], USD gốc lưu `usd_micros` (làm tròn lên).
import { eq } from 'drizzle-orm'
import type { DbExecutor } from '../../platform/db/index.ts'
import { AppError } from '../../platform/errors/index.ts'
import { aiModelPrices } from './schema.ts'

/** Tháng lịch giờ Việt Nam (`YYYY-MM`) của một thời điểm. */
const VN_MONTH = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit' })
export function budgetMonth(at: Date): string {
  const parts = VN_MONTH.formatToParts(at)
  const year = parts.find((p) => p.type === 'year')?.value
  const month = parts.find((p) => p.type === 'month')?.value
  return `${year}-${month}`
}

/** Giá một model, đơn vị micro-USD (× 10⁶) — USD / 1 triệu token, hoặc USD / ảnh. `null` = chưa có giá. */
export interface ModelPrice {
  model: string
  kind: 'text' | 'image'
  /** Đang bật (được chọn ở Cài đặt / gọi tường minh). */
  active: boolean
  input: bigint | null
  cachedInput: bigint | null
  output: bigint | null
  imageEach: bigint | null
  /** Story 6.6: giá token ảnh vào (model ảnh, edits); `null` → giá `input`. */
  imageInput: bigint | null
}

/** Chuỗi `numeric` của Postgres ("0.100000") → số nguyên × 10⁶, chính xác (không qua số thực). */
export function parseMicros(value: string | null): bigint | null {
  if (value === null) return null
  const m = /^(\d+)(?:\.(\d{0,6})\d*)?$/.exec(value.trim())
  if (!m) return null
  return BigInt(m[1]!) * 1_000_000n + BigInt((m[2] ?? '').padEnd(6, '0'))
}

/** Giá model đang có trong `ai_model_prices` (kể cả đã tắt); không có dòng → `null`. */
export async function getModelPrice(db: DbExecutor, model: string): Promise<ModelPrice | null> {
  const [row] = await db.select().from(aiModelPrices).where(eq(aiModelPrices.model, model))
  if (!row || (row.kind !== 'text' && row.kind !== 'image')) return null
  return {
    model: row.model,
    kind: row.kind,
    active: row.active,
    input: parseMicros(row.inputUsdPer1m),
    cachedInput: parseMicros(row.cachedInputUsdPer1m),
    output: parseMicros(row.outputUsdPer1m),
    imageEach: parseMicros(row.imageUsdEach),
    imageInput: parseMicros(row.imageInputUsdPer1m),
  }
}

/** Giá đủ để ước tính / tính tiền? Thiếu → `CONFIG_MISSING` (không gọi OpenAI khi không tính được tiền). */
export function assertPriced(price: ModelPrice | null, model: string): ModelPrice {
  const ok =
    price !== null &&
    price.input !== null &&
    price.output !== null &&
    (price.kind === 'text' || price.imageEach !== null)
  if (!ok) throw new AppError('CONFIG_MISSING', 400, { message: `model "${model}" chưa có giá trong ai_model_prices`, details: { model } })
  return price!
}

export interface UsageCounts {
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
  images: number
  /** Phần token ảnh trong `inputTokens` (model ảnh: ảnh tham khảo, tính theo `imageInput`). Không có = 0. */
  imageInputTokens?: number
}

export interface Cost {
  usdMicros: number
  costVnd: number
}

const E6 = 1_000_000n
const E12 = 1_000_000_000_000n
const ceilDiv = (a: bigint, b: bigint): bigint => (a <= 0n ? 0n : (a + b - 1n) / b)
const big = (n: number): bigint => BigInt(Math.max(0, Math.floor(n)))

/** Tổng 10⁻¹² USD → `{usdMicros, costVnd}` (cả hai làm tròn lên). */
function toCost(usdE12: bigint, exchangeRateVnd: number): Cost {
  return {
    usdMicros: Number(ceilDiv(usdE12, E6)),
    costVnd: Number(ceilDiv(usdE12 * big(exchangeRateVnd), E12)),
  }
}

/**
 * Chi phí thật từ usage. Chữ / ảnh có `usage`: (input − cached − ảnh vào) × giá input + cached × giá cached (thiếu →
 * giá input) + ảnh vào × giá ảnh vào (thiếu → giá input; Story 6.6) + output × giá output. Ảnh không có token nào
 * (Images API không trả `usage`): số ảnh × giá mỗi ảnh.
 */
export function computeCost(price: ModelPrice, usage: UsageCounts, exchangeRateVnd: number): Cost {
  const input = price.input ?? 0n
  const tokens = usage.inputTokens + usage.outputTokens
  if (price.kind === 'image' && tokens === 0) {
    return toCost(big(usage.images) * (price.imageEach ?? 0n) * E6, exchangeRateVnd)
  }
  const cached = Math.min(usage.cachedInputTokens, usage.inputTokens)
  const imageIn = Math.min(usage.imageInputTokens ?? 0, usage.inputTokens - cached)
  const usdE12 =
    big(usage.inputTokens - cached - imageIn) * input +
    big(cached) * (price.cachedInput ?? input) +
    big(imageIn) * (price.imageInput ?? input) +
    big(usage.outputTokens) * (price.output ?? 0n)
  return toCost(usdE12, exchangeRateVnd)
}

/**
 * Token ước tính cho mỗi ảnh vào khi giữ chỗ (Story 6.6) [ASSUMPTION, bảo thủ]:
 * - ảnh tham khảo của edits: `gpt-image-2` luôn xử lý ảnh vào ở độ chi tiết cao, ảnh ≤ 1024 px → 6.000 token;
 * - ảnh cho model chữ đọc (`detail: low`, ~300 token theo cách tính patch) → 1.600 token (đủ cả khi model bỏ qua `low`).
 */
export const REFERENCE_IMAGE_ESTIMATE_TOKENS = 6_000
export const VISION_IMAGE_ESTIMATE_TOKENS = 1_600

/** Phần ước tính thêm cho ảnh vào: số ảnh × token ước tính × giá (ảnh vào của model ảnh / input của model chữ). */
export function estimateInputImagesCost(price: ModelPrice, count: number, exchangeRateVnd: number): Cost {
  const perImage = price.kind === 'image' ? REFERENCE_IMAGE_ESTIMATE_TOKENS : VISION_IMAGE_ESTIMATE_TOKENS
  const rate = (price.kind === 'image' ? price.imageInput : null) ?? price.input ?? 0n
  return toCost(big(count) * big(perImage) * rate, exchangeRateVnd)
}

/** Cộng hai chi phí ước tính. */
export const addCost = (a: Cost, b: Cost): Cost => ({ usdMicros: a.usdMicros + b.usdMicros, costVnd: a.costVnd + b.costVnd })

/**
 * Ước tính token đầu vào: số ký tự ÷ 2 (làm tròn lên) — tiếng Việt có dấu tách token dày hơn tiếng Anh
 * (~4 ký tự/token), nên lấy mức bảo thủ.
 */
export function estimateInputTokens(chars: number): number {
  return Math.ceil(Math.max(0, chars) / 2)
}

/**
 * Giá ước tính mỗi ảnh theo kích thước (micro-USD) khi giữ chỗ — bảo thủ vì ảnh tính theo token output
 * (vd 1024×1024 chất lượng cao ~4.160 token × 30 USD/1M ≈ 0,125 USD) [ASSUMPTION]. Kích thước khác → 0,15 USD.
 */
export const IMAGE_ESTIMATE_MICROS: Readonly<Record<string, bigint>> = { '1024x1024': 100_000n }
export const IMAGE_ESTIMATE_DEFAULT_MICROS = 150_000n

/** Ước tính lúc giữ chỗ — chữ: ký tự ÷ 2 × giá input + `maxOutputTokens` × giá output. */
export function estimateTextCost(price: ModelPrice, inputChars: number, maxOutputTokens: number, exchangeRateVnd: number): Cost {
  return computeCost(price, { inputTokens: estimateInputTokens(inputChars), cachedInputTokens: 0, outputTokens: maxOutputTokens, images: 0 }, exchangeRateVnd)
}

/** Ước tính lúc giữ chỗ — ảnh: số ảnh × giá ước tính theo kích thước (không thấp hơn `image_usd_each`). */
export function estimateImageCost(price: ModelPrice, n: number, size: string, exchangeRateVnd: number): Cost {
  const bySize = IMAGE_ESTIMATE_MICROS[size] ?? IMAGE_ESTIMATE_DEFAULT_MICROS
  const each = price.imageEach !== null && price.imageEach > bySize ? price.imageEach : bySize
  return toCost(big(n) * each * E6, exchangeRateVnd)
}
