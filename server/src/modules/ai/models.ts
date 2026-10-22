// Danh sách model cho FE và cho gateway, lấy từ `ai_model_prices` (AD-7) — không viết cứng tên model.
import type { AiModelKind, AiModelOption } from '@ottm/shared'
import { asc, eq } from 'drizzle-orm'
import type { DbExecutor } from '../../platform/db/index.ts'
import { aiModelPrices } from './schema.ts'

export type AiModels = Record<AiModelKind, AiModelOption[]>

/** Model đang bật theo loại, `sort` tăng dần (mục đầu = mặc định). */
export async function listModels(db: DbExecutor): Promise<AiModels> {
  const rows = await db
    .select({ model: aiModelPrices.model, kind: aiModelPrices.kind, label: aiModelPrices.label })
    .from(aiModelPrices)
    .where(eq(aiModelPrices.active, true))
    .orderBy(asc(aiModelPrices.sort), asc(aiModelPrices.model))
  const models: AiModels = { text: [], image: [] }
  for (const row of rows) {
    if (row.kind === 'text' || row.kind === 'image') models[row.kind].push({ model: row.model, label: row.label })
  }
  return models
}

/** Model đã chọn nếu còn bật, ngược lại model mặc định (đầu danh sách); `null` khi danh sách rỗng. */
export function resolveModel(stored: string | null, options: readonly AiModelOption[]): string | null {
  if (stored && options.some((o) => o.model === stored)) return stored
  return options[0]?.model ?? null
}
