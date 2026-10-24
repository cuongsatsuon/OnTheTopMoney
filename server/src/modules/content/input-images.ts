// Ảnh bài gửi cho AI (Story 6.6, AD-7, AD-14): ảnh tham khảo của ô ảnh AI (Images API edits) và ảnh tab cho caption AI đọc.
// Ảnh bài nằm ở kho công khai (Meta cần tải), nhưng URL KHÔNG đưa cho OpenAI: server tải bản thu nhỏ (cạnh dài ≤
// `AI_INPUT_IMAGE_MAX_SIDE`) qua `MediaStore.download`, kiểm magic bytes, rồi gateway gửi bytes. Không log URL / bytes.
import { AI_INPUT_IMAGE_MAX_SIDE } from '@ottm/shared'
import type { MediaErrorKind, MediaStores } from '../../adapters/media/index.ts'
import type { AiInputImage } from '../ai/index.ts'
import { detectImageMime } from '../profiles/index.ts'

export type InputImageFailure = MediaErrorKind | 'NOT_IMAGE'
export type InputImageResult = { ok: true; image: AiInputImage } | { ok: false; kind: InputImageFailure }

/** Lỗi tải ảnh đáng thử lại (kho bận / lỗi tạm) — chưa gọi OpenAI nên thử lại không tốn tiền. */
export const isRetryableInputImageFailure = (kind: InputImageFailure): boolean => kind === 'TRANSIENT' || kind === 'RATE_LIMITED'

/** Tải ảnh `url` (ảnh `ready` của `media_assets`) thành ảnh vào cho gateway. */
export async function loadInputImage(
  media: Pick<MediaStores, 'publicStore'>,
  url: string,
  signal?: AbortSignal,
): Promise<InputImageResult> {
  const res = await media.publicStore.download(url, { maxSide: AI_INPUT_IMAGE_MAX_SIDE, ...(signal ? { signal } : {}) })
  if (!res.ok) return { ok: false, kind: res.kind }
  const mime = detectImageMime(res.data)
  if (!mime) return { ok: false, kind: 'NOT_IMAGE' }
  return { ok: true, image: { data: res.data, mime } }
}
