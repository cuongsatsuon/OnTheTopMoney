// Consumer sự kiện của module `ai` (queue `events.ai`): đổi lựa chọn OpenAI (hạn mức, tỉ giá) → tính lại cờ cảnh
// báo của tháng hiện tại (`ai_budget.restored` khi xuống dưới ngưỡng). Idempotent: chạy lại chỉ đối chiếu cờ với
// số đã tiêu, không phát trùng. Dữ liệu job coi như không tin cậy: tự kiểm bằng schema chung; sai dạng → bỏ qua
// (không ném, để không đốt lượt retry vào một job không bao giờ đúng).
import { EVENTS } from '@ottm/shared'
import { isEventEnvelope } from '../../platform/events/index.ts'
import { OPENAI_SETTINGS_KEY } from '../settings/index.ts'
import { recomputeAlerts, type BudgetDeps } from './budget.ts'

/** Payload `settings.updated`, thiếu `keys` → `[]`. */
const SettingsUpdated = EVENTS['settings.updated'].payload.extend({
  keys: EVENTS['settings.updated'].payload.shape.keys.default([]),
})

export async function handleAiEvent(deps: Pick<BudgetDeps, 'db' | 'events' | 'now'>, data: unknown): Promise<'recomputed' | 'ignored'> {
  if (!isEventEnvelope(data) || data.event !== 'settings.updated') return 'ignored'
  const payload = SettingsUpdated.safeParse(data.payload)
  if (!payload.success || !payload.data.keys.includes(OPENAI_SETTINGS_KEY)) return 'ignored'
  await recomputeAlerts(deps)
  return 'recomputed'
}
