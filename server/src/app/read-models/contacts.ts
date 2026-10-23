// Read-model khách (Story 4.9, AD-1, AD-18): ghép `ContactDto` / `ContactDetailDto` xuyên module — mỗi DTO đúng một hàm
// ghép, chỉ gọi hàm đọc export từ `index.ts`, không ghi, không nghiệp vụ.
// - `pageIds`: trang của các định danh (`inbox`) ∩ trang chưa gỡ (`pages.resolveScope`).
// - `handledBy`: theo hội thoại mới nhất — `ai` khi đang `ai`, còn lại `human`; `null` khi chưa có hội thoại. Epic 5 thêm
//   `Page.autoReply` (`profiles.resolveEffective`) tại đây.
// - `latest`: hội thoại mới nhất trong tập trang của danh sách (phạm vi) / mọi trang chưa gỡ (chi tiết).
import { ALL_SCOPE, type ContactConversation, type ContactDetailDto, type ContactDto, type ContactHandledBy } from '@ottm/shared'
import { aiSummaryStatusOf, contactActivity, getContact, listMergeSuggestions, type ContactRecord } from '../../modules/inbox/index.ts'
import { resolveScope } from '../../modules/pages/index.ts'
import type { DbExecutor } from '../../platform/db/index.ts'

/** Trang chưa gỡ (nguồn duy nhất: `pages.resolveScope`). */
export const livePageIds = (db: DbExecutor): Promise<string[]> => resolveScope(db, ALL_SCOPE)

const handledByOf = (latest: ContactConversation | null): ContactHandledBy | null => (latest ? (latest.state === 'ai' ? 'ai' : 'human') : null)

function toDto(r: ContactRecord, pageIds: string[], latest: ContactConversation | null, now: Date): ContactDto {
  const summary = aiSummaryStatusOf(r, now)
  return {
    id: r.id,
    name: r.name,
    phone: r.phone,
    note: r.note,
    tags: r.tags,
    stage: r.stage,
    pageIds,
    handledBy: handledByOf(latest),
    latest,
    aiSummary: r.aiSummary !== null && r.aiSummaryAt ? { text: r.aiSummary, generatedAt: r.aiSummaryAt.toISOString() } : null,
    aiSummaryStatus: summary.status,
    aiSummaryError: summary.error,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  }
}

/** Khách của danh sách (đã lọc theo tập trang `scopePageIds`) → DTO; `latest` trong phạm vi. */
export async function contactDtos(db: DbExecutor, records: readonly ContactRecord[], scopePageIds: readonly string[], now = new Date()): Promise<ContactDto[]> {
  if (records.length === 0) return []
  const live = new Set(await livePageIds(db))
  const activity = await contactActivity(
    db,
    records.map((r) => r.id),
    scopePageIds,
  )
  return records.map((r) => {
    const a = activity.get(r.id)!
    return toDto(
      r,
      a.identityPageIds.filter((id) => live.has(id)),
      a.conversations[0] ?? null,
      now,
    )
  })
}

/** Chi tiết một khách (mọi trang chưa gỡ); `null` khi không có hoặc không còn định danh trên trang chưa gỡ nào. */
export async function contactDetail(db: DbExecutor, id: string, now = new Date()): Promise<ContactDetailDto | null> {
  const record = await getContact(db, id)
  if (!record) return null
  const live = await livePageIds(db)
  const liveSet = new Set(live)
  const activity = (await contactActivity(db, [id], live)).get(id)!
  const pageIds = activity.identityPageIds.filter((p) => liveSet.has(p))
  if (pageIds.length === 0) return null
  return {
    ...toDto(record, pageIds, activity.conversations[0] ?? null, now),
    conversations: activity.conversations,
    mergeSuggestions: await listMergeSuggestions(db, id),
  }
}
