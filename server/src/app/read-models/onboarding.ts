// Read-model Màn chào 4 bước (Story 5.7, AD-1, AD-18): ghép trạng thái từ module sở hữu dữ liệu — trang (`pages`),
// khoá OpenAI (`ai`), hồ sơ + cấu hình AI hiệu lực (`profiles`, giải kế thừa ở một chỗ — AD-8), tin AI đã gửi
// (`inbox`). Chỉ đọc, không lưu tiến độ, không log nội dung.
import type { AutoreplyConfigDto, OnboardingStatusResponse } from '@ottm/shared'
import { getOpenAiKeyStatus, type AiDeps } from '../../modules/ai/index.ts'
import { latestAiReply } from '../../modules/inbox/index.ts'
import { listPages } from '../../modules/pages/index.ts'
import { resolveEffectiveOrNull } from '../../modules/profiles/index.ts'
import type { DbExecutor } from '../../platform/db/index.ts'

/** Có ít nhất một trang thoả `test` (dừng ở trang đầu tiên thoả). */
async function someAsync(ids: readonly string[], test: (id: string) => Promise<boolean>): Promise<boolean> {
  for (const id of ids) if (await test(id)) return true
  return false
}

export async function onboardingStatus(deps: Pick<AiDeps, 'db' | 'cipher'>): Promise<OnboardingStatusResponse> {
  const db: DbExecutor = deps.db
  // `listPages` chỉ trả trang chưa gỡ (mọi trạng thái kết nối) — cùng nguồn với bảng Trang & Nhóm.
  const pageIds = (await listPages(db)).map((p) => p.id)
  const [key, brandProfile, autoreplyEnabled, reply] = await Promise.all([
    getOpenAiKeyStatus(deps),
    someAsync(pageIds, async (id) => (await resolveEffectiveOrNull(db, id, 'brand')) !== null),
    someAsync(pageIds, async (id) => (await resolveEffectiveOrNull<AutoreplyConfigDto>(db, id, 'autoreply'))?.config.enabled === true),
    latestAiReply(db, pageIds),
  ])
  return {
    steps: { pageConnected: pageIds.length > 0, openAiKeyValid: key.status === 'valid', brandProfile, autoreplyEnabled },
    lastAiReply: reply ? { conversationId: reply.conversationId, pageId: reply.pageId, sentAt: reply.sentAt.toISOString() } : null,
  }
}
