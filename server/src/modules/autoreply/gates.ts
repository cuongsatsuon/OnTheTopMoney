// Chuỗi cổng của AI trả lời tự động (AD-16, AD-9; Story 5.4). Dùng chung cho bước triage và lượt chạy, theo ĐÚNG thứ
// tự AD-16, dừng ở cổng đóng đầu tiên:
//   1. `conversation.ai_enabled`            → `AI_OFF` (không áp dụng)
//   2. cấu hình hiệu lực (`resolveEffective`) → `CONFIG_MISSING` / `AI_OFF` (không áp dụng)
//   3. kênh áp dụng                          → `CHANNEL_OFF` (không áp dụng)
//   4. giờ hoạt động                         → `OUTSIDE_HOURS` (tạm đóng)
//   5. khoá OpenAI → hạn mức (`aiAvailabilityGate`) → `OPENAI_KEY_UNAVAILABLE` / `AI_BUDGET_EXCEEDED` (tạm đóng)
// Lượt chạy chèn thêm `canSend` (`OUTSIDE_24H`) và "tin có chữ" (`NON_TEXT_MESSAGE`) — xem `run.ts`. Story 5.5 mở kênh
// bình luận (`comment_public` / `comment_private`; Threads chỉ công khai).
// Giờ hoạt động tính theo giờ Việt Nam (UTC+7 cố định, không đổi giờ mùa hè). Thuần trừ `preGates`.
import type {
  AutoreplyChannel,
  AutoreplyConfigDto,
  AutoreplyDayHours,
  AutoreplySchedule,
  ConfigSource,
  ConversationChannel,
  HandoffReason,
  MessageDelivery,
  Platform,
} from '@ottm/shared'
import { AUTOREPLY_CHANNEL_MODE } from '@ottm/shared'
import { resolveEffective } from '../profiles/index.ts'
import { AppError } from '../../platform/errors/index.ts'
import { aiAvailabilityGate, type DecideDeps } from './decide.ts'

/** Giờ Việt Nam lệch UTC (không có giờ mùa hè). */
const VN_OFFSET_MS = 7 * 3_600_000

/** Thứ trong tuần (0 = Thứ Hai … 6 = Chủ nhật, khớp `hours`) và phút trong ngày theo giờ Việt Nam. */
export function vnClock(now: Date): { day: number; minutes: number } {
  const local = new Date(now.getTime() + VN_OFFSET_MS)
  return { day: (local.getUTCDay() + 6) % 7, minutes: local.getUTCHours() * 60 + local.getUTCMinutes() }
}

const minutesOf = (hhmm: string): number => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5))

/** Lúc `(day, minutes)` nằm trong khung giờ của `hours`? Khung `from > to` qua nửa đêm, thuộc ngày bắt đầu. */
function inWindow(hours: readonly AutoreplyDayHours[], day: number, minutes: number): boolean {
  const today = hours[day]
  if (today?.on) {
    const from = minutesOf(today.from)
    const to = minutesOf(today.to)
    if (from < to ? minutes >= from && minutes < to : minutes >= from) return true
  }
  // Phần sau nửa đêm của khung qua đêm hôm trước.
  const prev = hours[(day + 6) % 7]
  if (prev?.on) {
    const from = minutesOf(prev.from)
    const to = minutesOf(prev.to)
    if (from > to && minutes < to) return true
  }
  return false
}

/**
 * Giờ hoạt động mở? `always` → luôn; `custom` → trong khung của ngày (ngày nghỉ: không); `offhours` → NGOÀI giờ làm
 * việc (ngày nghỉ: cả ngày).
 */
export function withinActiveHours(cfg: { schedule: AutoreplySchedule; hours: readonly AutoreplyDayHours[] }, now: Date): boolean {
  if (cfg.schedule === 'always') return true
  const { day, minutes } = vnClock(now)
  const inside = inWindow(cfg.hours, day, minutes)
  return cfg.schedule === 'custom' ? inside : !inside
}

/**
 * Kênh `AutoreplyChannel` có thể phục vụ hội thoại này. DM: Facebook → `messenger`, Instagram → `ig_direct`.
 * Bình luận (Story 5.5): FB/IG → `comment_public` rồi `comment_private` (thứ tự = thứ tự gửi: công khai trước);
 * Threads chỉ `comment_public` (Meta chưa có nhắn riêng — AD-10), `comment_private` trong cấu hình bị bỏ qua.
 */
export function servingChannels(platform: Platform, channel: ConversationChannel): AutoreplyChannel[] {
  if (channel === 'comment') return platform === 'threads' ? ['comment_public'] : ['comment_public', 'comment_private']
  if (platform === 'facebook') return ['messenger']
  if (platform === 'instagram') return ['ig_direct']
  return []
}

export interface GateInput {
  pageId: string
  platform: Platform
  channel: ConversationChannel
  aiEnabled: boolean
}

export type GateResult =
  | { open: true; config: AutoreplyConfigDto; source: ConfigSource; modes: MessageDelivery[] }
  | { open: false; reason: HandoffReason; source: ConfigSource | null }

/** Cổng 1–5 (xem đầu file). Lỗi khác `CONFIG_MISSING` (DB…) ném tiếp. */
export async function preGates(deps: Pick<DecideDeps, 'db' | 'cipher' | 'now'>, input: GateInput): Promise<GateResult> {
  if (!input.aiEnabled) return { open: false, reason: 'AI_OFF', source: null }
  let config: AutoreplyConfigDto
  let source: ConfigSource
  try {
    ;({ config, source } = await resolveEffective<AutoreplyConfigDto>(deps.db, input.pageId, 'autoreply'))
  } catch (err) {
    if (err instanceof AppError && err.code === 'CONFIG_MISSING') return { open: false, reason: 'CONFIG_MISSING', source: null }
    throw err
  }
  if (!config.enabled) return { open: false, reason: 'AI_OFF', source }
  const channels = servingChannels(input.platform, input.channel).filter((c) => config.channels.includes(c))
  if (channels.length === 0) return { open: false, reason: 'CHANNEL_OFF', source }
  if (!withinActiveHours(config, deps.now?.() ?? new Date())) return { open: false, reason: 'OUTSIDE_HOURS', source }
  const gate = await aiAvailabilityGate(deps)
  if (gate) return { open: false, reason: gate, source }
  return { open: true, config, source, modes: [...new Set(channels.map((c) => AUTOREPLY_CHANNEL_MODE[c]))] }
}
