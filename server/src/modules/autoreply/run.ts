// Lượt AI trả lời một hội thoại (Story 5.4, AD-16, AD-9, AD-21) — handler queue `autoreply.run` (stately theo
// `conversationId`: một job chờ + một job chạy mỗi hội thoại; tin tới trong 4 giây trễ gộp vào một lượt).
// 1. Ảnh chụp `inbox.readAutoreplyTurn`: chỉ chạy khi `state=ai` và còn tin khách chưa trả lời; ngược lại `skipped`
//    (không ghi run — job trùng / đã có người trả lời / bật lại AI khi khách không chờ).
// 2. Ghi `autoreply_runs` (id, mốc, không nội dung).
// 3. Cổng 1–5 (`gates.ts`) → `canSend` theo cách gửi (`OUTSIDE_24H`) → tin có chữ (`NON_TEXT_MESSAGE`) → `decideReply` (luật → LLM
//    → hậu kiểm). Chấm "đang gõ" bật ngay trước bước quyết định.
// 4. `inbox.applyAutoreplyDecision` với `{stateVersion, lastInboundId}` — lệch (Tiếp quản, khách nhắn thêm) →
//    `superseded`, không gửi gì; lượt sau (job đã chờ sẵn) trả lời gộp.
// Lỗi bất ngờ: ném để retry; lần thử cuối áp `handoff` `AI_PROVIDER_ERROR` để khách không kẹt ở `ai` trong im lặng.
// Story 5.5 (bình luận):
// - caption bài chưa lấy xong (job `inbox.fetch_post_text`) và bình luận còn mới → hoãn lượt (`deferred`, không ghi run);
// - cách gửi = kênh bật ∩ `autoreplySendCheck` (`canSend` + bình luận đã xoá/ẩn): nhắn riêng đã dùng / quá 7 ngày thì
//   bỏ, chỉ trả lời công khai; không còn cách nào mà có bình luận đã gỡ → không gửi gì (`superseded`), còn lại
//   `OUTSIDE_24H`; còn cả hai → quyết định hai tin.
// Story 5.6 (AD-9, AD-16): lượt chạy nhận cả `handoff` tạm đóng (`resumableHandoff`, chủ shop chưa trả lời) — triage hẹn
// lượt khi khách nhắn tiếp mà cổng không còn đóng tạm thời:
// - quyết định vẫn tạm đóng (khoá / hạn mức / nhà cung cấp…) → không áp, giữ `handoff` (run `handoff`, không tin `system`);
// - còn lại áp như thường — `applyAutoreplyDecision` đưa `handoff → ai` trước khi ghi tin AI;
// - bình luận còn tin người khác chưa ai trả lời → `skipped` (AI không kéo hội thoại khỏi "Cần xử lý");
// - lỗi bất ngờ ở lần thử cuối → không fallback (đã ở "Cần xử lý");
// - chỉ khi có tin khách ghi SAU lần chuyển vào `handoff`; `inbound_at` = tin đó (NFR1 không tính thời gian chờ chủ shop).
// `job.signal` (pg-boss huỷ khi job quá hạn) truyền xuống gateway: lần thử cuối hết hạn cũng chuyển người như lỗi bất ngờ.
// Không log prompt / nội dung tin / câu trả lời.
import { HANDOFF_REASON_KIND, type ConfigSource, type HandoffReason, type MessageDelivery } from '@ottm/shared'
import { eq } from 'drizzle-orm'
import {
  COMMENT_REMOVED,
  applyAutoreplyDecision,
  autoreplySendCheck,
  readAutoreplyTurn,
  resumableHandoff,
  setAiTyping,
  type AutoreplyApplyInput,
  type AutoreplyTurn,
} from '../inbox/index.ts'
import { autoreplyRunSources } from '../profiles/index.ts'
import type { JobSender } from '../../platform/jobs/index.ts'
import { brandOrEmpty, decideReply, handoffDecision, type AutoreplyDecision, type DecideDeps } from './decide.ts'
import { preGates } from './gates.ts'
import { autoreplyRuns, type AutoreplyRunOutcome } from './schema.ts'

/** Trễ gộp tin [ASSUMPTION AD-16]: job đầu chạy sau chừng này, tin tới trong lúc chờ đi chung một lượt. */
export const AUTOREPLY_RUN_DELAY_MS = 4_000
/** Chờ caption bài tối đa chừng này tính từ bình luận cần trả lời đầu tiên [ASSUMPTION, Story 5.5]; quá thì chạy không caption. */
export const POST_TEXT_WAIT_MS = 10_000
/** Hoãn lượt bình luận chờ caption chừng này mỗi lần. */
export const POST_TEXT_RETRY_MS = 2_000

export interface RunDeps extends DecideDeps {
  jobs: JobSender
}

/** `skipped`/`deferred` không ghi run; `deferred` = đã hẹn lượt sau (chờ caption bài, Story 5.5). */
export type RunOutcome = AutoreplyRunOutcome | 'skipped' | 'deferred'

/** Bình luận AI định trả lời đã bị xoá/ẩn (Story 5.5) — không gửi gì, không đổi trạng thái. */
const REMOVED = 'removed' as const

/** Đưa hội thoại vào hàng AI trả lời (stately: đã có job chờ thì bỏ — job đó sẽ đọc cả tin mới). */
export async function enqueueAutoreplyRun(deps: Pick<RunDeps, 'jobs' | 'now'>, conversationId: string, delayMs = AUTOREPLY_RUN_DELAY_MS): Promise<void> {
  const now = deps.now?.() ?? new Date()
  await deps.jobs.send('autoreply.run', { conversationId }, delayMs > 0 ? { startAfter: new Date(now.getTime() + delayMs) } : {})
}

/** Bản ghi kết quả của lượt (cập nhật dần, ghi một lần ở cuối). */
interface RunRecord {
  outcome: AutoreplyRunOutcome
  reasonCode: HandoffReason | null
  source: ConfigSource | null
  llmCalls: number
  confidence: number | null
  messageIds: string[]
}

/** Quyết định → đầu vào `applyAutoreplyDecision` (đích theo loại lý do AD-9). */
function toApply(decision: AutoreplyDecision): AutoreplyApplyInput {
  if (decision.action === 'reply') return { messages: decision.messages, transition: null }
  const kind = HANDOFF_REASON_KIND[decision.reasonCode]
  return { messages: decision.messages, transition: { to: kind === 'not_applicable' ? 'human' : 'handoff', reasonCode: decision.reasonCode } }
}

/** Cổng 1–7 rồi `decideReply`. `onTyping` gọi ngay trước bước quyết định (luật / LLM). */
async function decide(
  deps: RunDeps,
  turn: AutoreplyTurn,
  record: RunRecord,
  onTyping: () => Promise<void>,
  signal: AbortSignal | undefined,
): Promise<AutoreplyDecision | typeof REMOVED> {
  const gate = await preGates(deps, { pageId: turn.pageId, platform: turn.platform, channel: turn.channel, aiEnabled: turn.aiEnabled })
  record.source = gate.source
  if (!gate.open) return handoffDecision(gate.reason)

  const now = deps.now?.() ?? new Date()
  // Cách gửi còn dùng được (DM: `dm`; bình luận: công khai và/hoặc nhắn riêng — Story 5.5).
  const modes: MessageDelivery[] = []
  let removed = false
  for (const m of gate.modes) {
    const check = await autoreplySendCheck(deps.db, turn.conversationId, m, { now })
    if (check.ok) modes.push(m)
    else if (check.code === COMMENT_REMOVED) removed = true
  }
  if (modes.length === 0) {
    // Bình luận đã bị khách xoá / trang ẩn → không còn gì để trả lời, không chuyển người.
    if (removed) return REMOVED
    // AD-9: `canSend` từ chối khi AI định trả lời → `OUTSIDE_24H` (sticky). Không gửi được gì nên không có câu chuyển tiếp.
    return handoffDecision('OUTSIDE_24H')
  }
  const mode = modes[0]!

  const sources = await autoreplyRunSources(deps.db, turn.pageId)
  record.source = sources.source
  if (sources.knowledgeDropped > 0) {
    deps.log?.warn({ conversationId: turn.conversationId, pageId: turn.pageId, dropped: sources.knowledgeDropped }, 'autoreply: kho kiến thức vượt giới hạn, bỏ bớt mục')
  }
  const latestText = turn.pending
    .map((m) => m.text?.trim() ?? '')
    .filter(Boolean)
    .join('\n')
  // Khách chỉ gửi ảnh / sticker / voice: AI chưa đọc được → chuyển người, kèm câu chuyển tiếp (chủ ý).
  if (!latestText) return handoffDecision('NON_TEXT_MESSAGE', { config: sources.config, mode })

  await onTyping()
  return decideReply(deps, {
    feature: 'autoreply',
    pageId: turn.pageId,
    ref: turn.conversationId,
    config: sources.config,
    brand: brandOrEmpty(sources.brand),
    knowledge: sources.knowledge,
    platform: turn.platform,
    modes,
    pageName: sources.pageName,
    postText: turn.postText,
    turns: turn.turns,
    latestText,
    ...(signal ? { signal } : {}),
  })
}

/** Quyết định chỉ là "vẫn tạm đóng" (không tin) — với `handoff` tạm đóng thì không có gì để áp (Story 5.6). */
const stillClosed = (d: AutoreplyDecision): boolean =>
  d.action === 'handoff' && d.messages.length === 0 && HANDOFF_REASON_KIND[d.reasonCode] === 'transient'

/**
 * Một lượt cho hội thoại. `finalAttempt`: lần thử cuối của job → lỗi bất ngờ thì chuyển người trước khi ném. `signal`:
 * huỷ lời gọi AI (job quá hạn).
 */
export async function runAutoreply(
  deps: RunDeps,
  conversationId: string,
  opts: { finalAttempt: boolean; signal?: AbortSignal | undefined } = { finalAttempt: true },
): Promise<RunOutcome> {
  const turn = await readAutoreplyTurn(deps.db, conversationId)
  if (!turn || !turn.lastInboundId || turn.pending.length === 0) return 'skipped'
  const resuming = resumableHandoff(turn.state, turn.stateReason)
  if (turn.state !== 'ai' && !resuming) return 'skipped'
  // Khôi phục chỉ khi khách nhắn tiếp SAU lúc vào `handoff` (AD-9) — job sót lại không kéo hội thoại khỏi "Cần xử lý".
  // Tin chờ từ trước vẫn được trả lời cùng lượt; mốc NFR1 lấy từ tin mới đầu tiên.
  const changeId = turn.stateChangeId
  const firstNew = resuming ? turn.pending.find((m) => changeId === null || m.id > changeId) : turn.pending[0]
  if (!firstNew || (resuming && turn.othersPending)) return 'skipped'
  const startedAt = deps.now?.() ?? new Date()
  // Bình luận vừa tới mà caption bài chưa lấy xong: chờ thêm (prompt cần caption để trả lời "giá bao nhiêu?").
  if (turn.postTextPending && startedAt.getTime() - firstNew.createdAt.getTime() < POST_TEXT_WAIT_MS) {
    await enqueueAutoreplyRun(deps, conversationId, POST_TEXT_RETRY_MS)
    return 'deferred'
  }
  const expected = { stateVersion: turn.stateVersion, lastInboundId: turn.lastInboundId, pendingIds: turn.pending.map((m) => m.id) }
  const [run] = await deps.db
    .insert(autoreplyRuns)
    .values({
      conversationId,
      pageId: turn.pageId,
      lastInboundId: turn.lastInboundId,
      stateVersion: turn.stateVersion,
      inboundAt: firstNew.createdAt,
      startedAt,
    })
    .returning({ id: autoreplyRuns.id })

  const record: RunRecord = { outcome: 'failed', reasonCode: null, source: null, llmCalls: 0, confidence: null, messageIds: [] }
  let typing = false
  try {
    const decision = await decide(
      deps,
      turn,
      record,
      async () => {
        typing = true
        await setAiTyping(deps, conversationId, true)
      },
      opts.signal,
    )
    if (decision === REMOVED) {
      record.outcome = 'superseded'
      return record.outcome
    }
    record.llmCalls = decision.llmCalls
    if (decision.action === 'reply') record.confidence = decision.confidence
    if (resuming && decision.action === 'handoff' && stillClosed(decision)) {
      // Vẫn tạm đóng: hội thoại đã ở "Cần xử lý" — không ghi tin `system` / thông báo mới.
      record.outcome = 'handoff'
      record.reasonCode = decision.reasonCode
      return record.outcome
    }
    const applied = await applyAutoreplyDecision(deps, conversationId, expected, toApply(decision))
    if (!applied.applied) {
      record.outcome = 'superseded'
      record.reasonCode = decision.action === 'handoff' ? decision.reasonCode : null
    } else {
      record.messageIds = applied.messageIds
      record.outcome = applied.state === 'ai' ? 'replied' : applied.state === 'handoff' ? 'handoff' : 'not_applicable'
      record.reasonCode = (applied.reasonCode as HandoffReason | null) ?? null
      typing = false // đã tắt trong transaction áp
    }
    return record.outcome
  } catch (err) {
    record.outcome = 'failed'
    // `handoff` tạm đóng đang khôi phục: đã ở "Cần xử lý", không cần fallback.
    if (opts.finalAttempt && !resuming) {
      // Hết lượt retry: đưa khách vào "Cần xử lý" (tạm đóng) thay vì để hội thoại `ai` không ai trả lời.
      const fallback = await applyAutoreplyDecision(deps, conversationId, expected, {
        messages: [],
        transition: { to: 'handoff', reasonCode: 'AI_PROVIDER_ERROR' },
      }).catch(() => null)
      if (fallback?.applied) {
        record.reasonCode = 'AI_PROVIDER_ERROR'
        typing = false
      }
    }
    throw err
  } finally {
    if (typing) await setAiTyping(deps, conversationId, false).catch(() => {})
    const finishedAt = deps.now?.() ?? new Date()
    await deps.db
      .update(autoreplyRuns)
      .set({
        finishedAt,
        outcome: record.outcome,
        reasonCode: record.reasonCode,
        configSourceType: record.source?.ownerType ?? null,
        configSourceId: record.source?.ownerId ?? null,
        llmCalls: record.llmCalls,
        confidence: record.confidence,
        messageIds: record.messageIds,
      })
      .where(eq(autoreplyRuns.id, run!.id))
      .catch((err: unknown) => deps.log?.error({ err, runId: run!.id }, 'autoreply: không ghi được kết quả lượt chạy'))
    deps.log?.info(
      {
        runId: run!.id,
        conversationId,
        pageId: turn.pageId,
        outcome: record.outcome,
        reasonCode: record.reasonCode,
        llmCalls: record.llmCalls,
        // Độ trễ tới lúc quyết định (gồm 4 giây gộp tin); tới lúc gửi xong đo bằng `messages.sent_at`.
        decideMs: finishedAt.getTime() - firstNew.createdAt.getTime(),
        resumed: resuming,
      },
      'autoreply: lượt chạy',
    )
  }
}

export function parseRunJobData(data: unknown): { conversationId: string } {
  const id = (data as { conversationId?: unknown } | null)?.conversationId
  if (typeof id !== 'string' || id === '') throw new Error('autoreply.run: thiếu conversationId')
  return { conversationId: id }
}

/** Handler job `autoreply.run` cho worker. */
export async function handleRunJob(
  deps: RunDeps,
  job: { data: unknown; retryCount: number; retryLimit: number; signal?: AbortSignal | undefined },
): Promise<RunOutcome> {
  const { conversationId } = parseRunJobData(job.data)
  return runAutoreply(deps, conversationId, { finalAttempt: job.retryCount >= job.retryLimit, signal: job.signal })
}
