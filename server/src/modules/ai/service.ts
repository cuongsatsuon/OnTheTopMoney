// Cài đặt › Kết nối OpenAI (Story 1.5): ghép trạng thái khoá, lựa chọn đã lưu và danh sách model.
// Model phải có trong `ai_model_prices` đúng loại (AD-7); lựa chọn lưu ở module `settings`.
import { UpdateOpenAiSettingsRequest, type OpenAiSettingsResponse } from '@ottm/shared'
import { AppError } from '../../platform/errors/index.ts'
import { getOpenAiPrefs, setOpenAiPrefs } from '../settings/index.ts'
import { getOpenAiKeyStatus, type AiDeps } from './key.ts'
import { listModels, resolveModel } from './models.ts'

export async function getOpenAiSettings(deps: Pick<AiDeps, 'db' | 'cipher'>): Promise<OpenAiSettingsResponse> {
  const [key, prefs, models] = await Promise.all([getOpenAiKeyStatus(deps), getOpenAiPrefs(deps.db), listModels(deps.db)])
  return {
    key,
    textModel: resolveModel(prefs.textModel, models.text),
    imageModel: resolveModel(prefs.imageModel, models.image),
    imageSize: prefs.imageSize,
    exchangeRateVnd: prefs.exchangeRateVnd,
    monthlyLimitVnd: prefs.monthlyLimitVnd,
    warn80: prefs.warn80,
    models,
  }
}

/**
 * Lưu các khoá được gửi (khoá thiếu giữ giá trị đang lưu). Model không có / sai loại / đã tắt →
 * `VALIDATION_FAILED`, không lưu gì.
 */
export async function setOpenAiSettings(deps: Pick<AiDeps, 'db' | 'events' | 'cipher'>, input: unknown): Promise<OpenAiSettingsResponse> {
  const patch = UpdateOpenAiSettingsRequest.parse(input)
  const models = await listModels(deps.db)
  const issues: { path: string[]; message: string }[] = []
  if (patch.textModel !== undefined && !models.text.some((m) => m.model === patch.textModel)) {
    issues.push({ path: ['textModel'], message: 'không phải model chữ đang bật' })
  }
  if (patch.imageModel !== undefined && !models.image.some((m) => m.model === patch.imageModel)) {
    issues.push({ path: ['imageModel'], message: 'không phải model ảnh đang bật' })
  }
  if (issues.length > 0) throw new AppError('VALIDATION_FAILED', 400, { details: issues })
  const current = await getOpenAiPrefs(deps.db)
  const defined = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined))
  await setOpenAiPrefs(deps.db, deps.events, { ...current, ...defined })
  return getOpenAiSettings(deps)
}
