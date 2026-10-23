// Màn chào 4 bước (Story 5.7, AD-18): `GET /api/v1/onboarding` — read-model chỉ đọc, ghép từ module sở hữu dữ liệu
// (`pages`, `ai`, `profiles`, `inbox`). Không lưu tiến độ: mọi cờ dẫn xuất từ dữ liệu thật, FE chỉ đánh dấu "Xong".
import { z } from 'zod'

const IsoDateTime = z.iso.datetime({ offset: false })

/** Bốn bước theo thứ tự của Màn chào (UX Flow 7). */
export const OnboardingSteps = z.object({
  /** Có ít nhất một trang chưa gỡ (mọi trạng thái kết nối). */
  pageConnected: z.boolean(),
  /** Khoá OpenAI đã lưu và đang `valid`. */
  openAiKeyValid: z.boolean(),
  /** Có ít nhất một trang có hồ sơ thương hiệu hiệu lực (riêng hoặc theo nhóm). */
  brandProfile: z.boolean(),
  /** Có ít nhất một trang có cấu hình AI trả lời hiệu lực đang bật. */
  autoreplyEnabled: z.boolean(),
})
export type OnboardingSteps = z.infer<typeof OnboardingSteps>

/** Tin AI đã gửi tới khách gần nhất (trang chưa gỡ) — cao trào Màn chào dẫn vào đúng hội thoại ở Hộp thư. */
export const OnboardingAiReply = z.object({
  conversationId: z.uuid(),
  pageId: z.uuid(),
  sentAt: IsoDateTime,
})
export type OnboardingAiReply = z.infer<typeof OnboardingAiReply>

export const OnboardingStatusResponse = z.object({
  steps: OnboardingSteps,
  /** `null` khi AI chưa gửi được tin nào. */
  lastAiReply: OnboardingAiReply.nullable(),
})
export type OnboardingStatusResponse = z.infer<typeof OnboardingStatusResponse>
