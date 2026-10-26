// Story 7.8: phân biệt lời gọi kế hoạch nội dung (structured output `campaign_content_plan`) với lời gọi viết caption trong
// test chiến dịch, và dựng JSON kế hoạch giả cho OpenAI giả.
import { CONTENT_FORMATS, type ContentFormat, type FunnelStage } from '@ottm/shared'
import type { CreateResponseRequest } from '../../src/adapters/openai/index.ts'

export const isPlanRequest = (r: Pick<CreateResponseRequest, 'jsonSchema'>): boolean => r.jsonSchema?.name === 'campaign_content_plan'

/** Lời gọi viết caption (bỏ lời gọi kế hoạch). */
export const captionRequests = (openai: { responseRequests: readonly CreateResponseRequest[] }): CreateResponseRequest[] =>
  openai.responseRequests.filter((r) => !isPlanRequest(r))

/** Lời gọi lên kế hoạch. */
export const planRequests = (openai: { responseRequests: readonly CreateResponseRequest[] }): CreateResponseRequest[] =>
  openai.responseRequests.filter(isPlanRequest)

export interface FakePlanPost {
  slot: number
  format: ContentFormat
  funnelStage: FunnelStage
  title: string
  angle: string
  hook: string
  brief: string
  imageIdea: string
  cta: string
}

/** Brief giả cho bài thứ `slot` (định dạng xoay vòng, mọi chữ khác nhau theo số thứ tự). */
export const fakePlanPost = (slot: number, over: Partial<FakePlanPost> = {}): FakePlanPost => ({
  slot,
  format: CONTENT_FORMATS[(slot - 1) % CONTENT_FORMATS.length]!,
  funnelStage: 'awareness',
  title: `Tiêu đề ${slot}`,
  angle: `Góc nội dung số ${slot}`,
  hook: `Câu mở số ${slot}?`,
  brief: `Ý chính số ${slot}`,
  imageIdea: `Bố cục ảnh số ${slot}`,
  cta: `Kêu gọi số ${slot}`,
  ...over,
})

/** JSON kế hoạch cho đúng các bài được hỏi (đọc số bài từ input "Các bài cần lên kế hoạch"). */
export function planJsonFor(request: Pick<CreateResponseRequest, 'input'>, over: (slot: number) => Partial<FakePlanPost> = () => ({})): string {
  const input = typeof request.input === 'string' ? request.input : ''
  const count = Number(/Hãy lên brief cho (\d+) bài/.exec(input)?.[1] ?? 0)
  return JSON.stringify({ posts: Array.from({ length: count }, (_, i) => fakePlanPost(i + 1, over(i + 1))) })
}
