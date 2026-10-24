// AD-24: mọi queue pg-boss khai báo DUY NHẤT ở file này (policy, retry, concurrency, cron).
// - `singletonKey` chỉ dùng với policy `stately`; queue `standard` chống trùng bằng điều kiện trạng thái.
// - Cron luôn `tz: 'Asia/Ho_Chi_Minh'`.
// - `send()` từ chối tên không có trong registry (`UNKNOWN_QUEUE`).
// - Consumer sự kiện (AD-3): queue khai báo `subscribes` — `ensureQueues` đồng bộ subscription pg-boss.
// - Job hết retry phát `job.failed`; `critical: true` → thông báo `system_error` cho chủ shop.
import { isEventName, type EventName } from '@ottm/shared'
import type { Db as BossDb, PgBoss, SendOptions } from 'pg-boss'
import type { EventEnvelope } from '../events/index.ts'

export const CRON_TZ = 'Asia/Ho_Chi_Minh'

interface QueueDefBase {
  retryLimit: number
  /** Giây giữa hai lần retry; với `retryBackoff` là giá trị khởi điểm. */
  retryDelay?: number
  retryBackoff?: boolean
  /** Số worker song song mỗi tiến trình (`localConcurrency` của pg-boss). */
  concurrency: number
  expireInSeconds?: number
  /** Cron 5 trường. pg-boss 12 gửi tối đa một job mỗi phút cho một lịch. */
  cron?: { expression: string; tz: typeof CRON_TZ }
  /** Giây giữa hai lần hỏi job mới (pg-boss mặc định 2, tối thiểu 0.5). */
  pollingIntervalSeconds?: number
  /** Sự kiện miền mà queue nhận (pg-boss subscribe); job mang `EventEnvelope`. */
  subscribes?: readonly EventName[]
  /** Hết retry ở queue này → thông báo `system_error` (qua `job.failed`). */
  critical?: boolean
}

export interface StandardQueueDef extends QueueDefBase {
  policy: 'standard'
  singletonKey?: never
}

export interface StatelyQueueDef<D = never> extends QueueDefBase {
  policy: 'stately'
  /** Khoá singleton suy từ payload, vd `conversationId`. */
  singletonKey: (data: D) => string
  cron?: never
}

export type QueueDef = StandardQueueDef | StatelyQueueDef<never>

/** Payload của từng queue — thêm khoá mới cùng lúc với khai báo trong `QUEUES`. */
export interface QueuePayloads {
  'platform.heartbeat': Record<string, never>
  'events.notifications': EventEnvelope
  'events.ai': EventEnvelope
  'events.profiles': EventEnvelope
  'events.content': EventEnvelope
  'events.campaigns': EventEnvelope
  'ai.reservations_gc': Record<string, never>
  'connections.oauth_gc': Record<string, never>
  'connections.token_check': Record<string, never>
  'webhook.route': { eventId: string }
  'connections.subscribe_page': { pageId: string }
  'webhooks.health': Record<string, never>
  'autoreply.triage': EventEnvelope
  /** Story 5.4: một lượt AI trả lời hội thoại (stately theo `conversationId`). */
  'autoreply.run': { conversationId: string }
  'inbox.fetch_attachment': { attachmentId: string }
  'inbox.fetch_profile': { identityId: string }
  'inbox.fetch_post_text': { conversationId: string }
  'inbox.send': { messageId: string }
  'inbox.send_sweep': Record<string, never>
  'inbox.contact_summary': { contactId: string }
  /** Story 5.2: trích văn bản một file kho kiến thức — xử lý theo file (mọi mục `processing` trỏ cùng file). */
  'profiles.knowledge.extract': { knowledgeItemId: string; filePublicId: string }
  /** Story 6.3: sinh một ô ảnh AI (`media_assets` đang `pending`). Story 7.4: `autoApprove` = slot "Tự đăng" duyệt luôn khi ảnh xong. */
  'content.image.generate': { mediaAssetId: string; autoApprove?: boolean }
  'content.media_gc': Record<string, never>
  /** Story 6.4: đăng một target đúng phiên bản lịch (lệch → job bỏ qua im lặng). */
  'publish.target': { targetId: string; scheduleVersion: number }
  'content.requeue': Record<string, never>
  /** Story 7.2: sinh bài xem trước của một chiến dịch nháp (stately theo `campaignId`). */
  'campaigns.preview': { campaignId: string }
  /** Story 7.4: một lượt sinh cuốn chiếu của chiến dịch đang chạy (stately theo `campaignId`). */
  'campaigns.generate': { campaignId: string }
  'campaigns.generate_window': Record<string, never>
  /** Story 7.5: hằng giờ chuyển chiến dịch không còn slot mở sang `done`. */
  'campaigns.complete_check': Record<string, never>
  /** Story 8.1: cron rải job thu số liệu theo trang. */
  'analytics.post_metrics': Record<string, never>
  'analytics.page_metrics': Record<string, never>
  /** Story 8.1: thu số liệu bài / trang của một trang; `deferredSince` = lần hoãn `RATE_LIMITED` đầu (ISO). */
  'analytics.collect_posts': { pageId: string; deferredSince?: string }
  'analytics.collect_page': { pageId: string; deferredSince?: string }
  /** Story 9.2: phần xoá dữ liệu của từng module (consumer `privacy.purge_requested` / `purge_final_requested`). */
  'autoreply.purge': EventEnvelope
  'webhooks.purge': EventEnvelope
  'ai.purge': EventEnvelope
  'content.purge': EventEnvelope
  'connections.purge': EventEnvelope
  'inbox.purge': EventEnvelope
  'events.privacy': EventEnvelope
  'privacy.purge_resume': Record<string, never>
  'privacy.removed_pages': Record<string, never>
  /** Story 4.5: tin của chính trang chưa khớp tin nào của app — bản chuẩn hoá (dạng JSON) để thử khớp lại. */
  'inbox.echo_match': {
    pageId: string
    echo: {
      channel: 'dm' | 'comment'
      threadRef: string | null
      platformMessageId: string
      text: string | null
      /** ISO 8601. */
      timestamp: string
      attachments: { kind: string; url: string }[]
      appId: string | null
      metadata: string | null
    }
  }
}

/** Queue xoá dữ liệu của một module (Story 9.2) — cùng policy, chỉ khác sự kiện nghe. */
const PURGE_DEF = <const E extends readonly EventName[]>(subscribes: E) =>
  ({
    policy: 'standard',
    retryLimit: 5,
    retryDelay: 10,
    retryBackoff: true,
    concurrency: 1,
    expireInSeconds: 900,
    pollingIntervalSeconds: 0.5,
    subscribes,
    critical: true,
  }) as const

export const QUEUES = {
  // Ghi `worker_heartbeats` cho `/healthz` (AD-24 dòng Cron: retry 1, concurrency 1).
  'platform.heartbeat': {
    policy: 'standard',
    retryLimit: 1,
    concurrency: 1,
    expireInSeconds: 60,
    cron: { expression: '* * * * *', tz: CRON_TZ },
  },
  // Module `notifications` (Story 1.4): sự kiện → thông báo trong app. Idempotent theo `dedupe_key`,
  // nên retry an toàn. Hỏi job mỗi 0,5 giây để toast tới trong ≤3 giây. Không `critical`: lỗi ở đây
  // không được sinh thêm thông báo (tránh vòng lặp job.failed → thông báo → lỗi).
  'events.notifications': {
    policy: 'standard',
    retryLimit: 3,
    retryDelay: 2,
    retryBackoff: true,
    concurrency: 2,
    expireInSeconds: 60,
    pollingIntervalSeconds: 0.5,
    subscribes: ['conversation.state_changed', 'page.expiring', 'page.disconnected', 'post_target.failed', 'campaign.paused', 'job.failed'],
  },
  // Module `ai` (Story 1.6): đổi hạn mức / tỉ giá / cảnh báo 80% → tính lại cờ cảnh báo, phát
  // `ai_budget.restored` khi xuống dưới ngưỡng. Idempotent (đối chiếu cờ với số đã tiêu) nên retry an toàn.
  'events.ai': {
    policy: 'standard',
    retryLimit: 3,
    retryDelay: 2,
    retryBackoff: true,
    concurrency: 1,
    expireInSeconds: 60,
    pollingIntervalSeconds: 0.5,
    subscribes: ['settings.updated'],
  },
  // Module `profiles` (Story 3.3, AD-8): nghe đổi thành viên nhóm → giữ cấu hình kế thừa (brand nay; AI ở Epic 5).
  // Idempotent (dựa trên "trang đã có cấu hình riêng chưa") nên retry an toàn. Hỏi job 0,5 giây để UI cập nhật nhanh.
  'events.profiles': {
    policy: 'standard',
    retryLimit: 3,
    retryDelay: 2,
    retryBackoff: true,
    concurrency: 1,
    expireInSeconds: 60,
    pollingIntervalSeconds: 0.5,
    subscribes: ['page.group_changed', 'group.deleted'],
  },
  // Module `content` (Story 7.6, AD-23): gỡ trang → huỷ bài chưa đăng của trang đó (`PAGE_REMOVED`). Idempotent (bài đã
  // huỷ không khớp lần sau) nên retry an toàn; retry 5 backoff (AD-24 dòng `events.<module>`).
  'events.content': {
    policy: 'standard',
    retryLimit: 5,
    retryDelay: 2,
    retryBackoff: true,
    concurrency: 1,
    expireInSeconds: 60,
    pollingIntervalSeconds: 0.5,
    subscribes: ['page.removed'],
  },
  // Module `campaigns` (Story 7.6, AD-15): tự tạm dừng khi trang mất kết nối / hạn mức AI 100% / bài đăng lỗi liên tiếp,
  // bỏ trang bị gỡ / rời nhóm nhãn. Idempotent (`pauseCampaign` đã dừng thì không đổi; chuỗi lỗi đếm theo `targetId`) nên
  // retry an toàn; retry 5 backoff (AD-24). Concurrency 2: mỗi chiến dịch đổi dưới khoá dòng. Hỏi job 0,5 giây để thẻ
  // chiến dịch đổi ngay.
  'events.campaigns': {
    policy: 'standard',
    retryLimit: 5,
    retryDelay: 2,
    retryBackoff: true,
    concurrency: 2,
    expireInSeconds: 120,
    pollingIntervalSeconds: 0.5,
    subscribes: ['page.disconnected', 'page.removed', 'page.group_changed', 'ai_budget.threshold_reached', 'post_target.failed', 'post_target.published'],
  },
  // Dọn chỗ giữ chi phí AI bị bỏ rơi (tiến trình chết giữa lời gọi) cũ hơn 15 phút, mỗi 5 phút.
  'ai.reservations_gc': {
    policy: 'standard',
    retryLimit: 1,
    concurrency: 1,
    expireInSeconds: 60,
    cron: { expression: '*/5 * * * *', tz: CRON_TZ },
  },
  // Module `connections` (Story 2.2): xoá `oauth_states` / `oauth_results` hết hạn (kết quả giữ envelope token
  // Page) mỗi giờ — kể cả khi không ai dùng OAuth nữa. Idempotent.
  'connections.oauth_gc': {
    policy: 'standard',
    retryLimit: 1,
    concurrency: 1,
    expireInSeconds: 60,
    cron: { expression: '0 * * * *', tz: CRON_TZ },
  },
  // Module `connections` (Story 2.4): mỗi ngày lúc 3h sáng (giờ VN) làm mới token Threads sắp hết hạn, tính lại
  // trạng thái mọi trang (`expiring`) và phát `page.expiring` một lần/chu kỳ. Handler bắt lỗi không retry được,
  // ghi trạng thái rồi kết thúc bình thường → retry 1 là đủ (cron chạy lại ngày sau).
  'connections.token_check': {
    policy: 'standard',
    retryLimit: 1,
    concurrency: 1,
    expireInSeconds: 300,
    cron: { expression: '0 3 * * *', tz: CRON_TZ },
  },
  // Module `webhooks` (Story 4.1, AD-4): mỗi mục webhook một job — chuẩn hoá + đặt `status`. Chống trùng bằng
  // UNIQUE(product, dedupe_key) ở lúc ghi (mỗi mục một job duy nhất) + handler idempotent (tính lại trạng thái
  // xác định), nên retry an toàn. Retry 5 backoff, concurrency 10 (AD-24). Chưa `critical` ở 4.1 → job hết retry
  // vẫn phát `job.failed` nhưng KHÔNG sinh thông báo (consumer `events.notifications` chỉ báo queue critical).
  // Việc ghi mục `failed` do handler webhook.route tự làm ở lần thử cuối (không qua `job.failed`); chủ shop thấy
  // mục lỗi ở nhật ký Cài đặt › Webhook và bấm "Xử lý lại". Story 4.2 giữ không critical (chỉ có banner sức khoẻ);
  // dead-letter + thông báo cho `webhook.route` hoãn (deferred-work.md).
  // Story 4.3/4.4: tin/bình luận gọi `inbox.ingest` → hỏi job mỗi 0,5 giây để tin hiện trên Hộp thư trong ≤3 giây.
  'webhook.route': {
    policy: 'standard',
    retryLimit: 5,
    retryDelay: 2,
    retryBackoff: true,
    concurrency: 10,
    expireInSeconds: 120,
    pollingIntervalSeconds: 0.5,
  },
  // Module `connections` (Story 4.2, AD-4/AD-24 `connections.*`): đăng ký webhook cho một trang
  // (`POST /{page}/subscribed_apps`). Enqueue trong transaction xác nhận/kết nối lại + chạy bù khi worker khởi động.
  // Idempotent (đăng ký lại cùng field không đổi gì) nên retry an toàn. Chỉ `RATE_LIMITED`/`TRANSIENT` ném để retry;
  // lỗi khác ghi `webhook_subscribe_error` rồi kết thúc; hết retry → `FAILED`.
  'connections.subscribe_page': {
    policy: 'standard',
    retryLimit: 3,
    // Chặn tần suất của Meta thường kéo dài vài phút → bắt đầu từ 60 giây (60/120/240) thay vì hết retry trong
    // chưa tới một phút rồi thành `FAILED` vĩnh viễn (nhất là lúc chạy bù nhiều trang).
    retryDelay: 60,
    retryBackoff: true,
    concurrency: 2,
    expireInSeconds: 120,
  },
  // Module `webhooks` (Story 4.2, AD-4): mỗi 5 phút (giờ VN) tính sức khoẻ `meta`/`threads`, phát
  // `webhook.stalled|recovered` khi đổi trạng thái (cùng transaction với lần ghi). Cron chạy lại sau 5 phút → retry 1.
  'webhooks.health': {
    policy: 'standard',
    retryLimit: 1,
    concurrency: 1,
    expireInSeconds: 60,
    cron: { expression: '*/5 * * * *', tz: CRON_TZ },
  },
  // Module `autoreply` (Story 4.3, AD-16, AD-24): tin khách (`message.received`) → đưa hội thoại `triage` về đích
  // NGAY theo cổng AD-16 (Story 5.4); hội thoại `ai` → enqueue `autoreply.run`. Story 5.4: nghe thêm
  // `conversation.state_changed` (bật lại AI → lượt chạy ngay). Idempotent (chỉ áp khi còn `triage` + đúng
  // `state_version`; enqueue trùng bị queue stately bỏ) nên retry an toàn. Hỏi job 0,5 giây để chip trạng thái đổi
  // trong ≤3 giây.
  'autoreply.triage': {
    policy: 'standard',
    retryLimit: 3,
    retryDelay: 2,
    retryBackoff: true,
    concurrency: 10,
    expireInSeconds: 60,
    pollingIntervalSeconds: 0.5,
    subscribes: ['message.received', 'conversation.state_changed'],
  },
  // Module `autoreply` (Story 5.4, AD-16, AD-24): một lượt AI trả lời hội thoại. `stately` theo `conversationId`: tối đa
  // một job chờ + một job chạy mỗi hội thoại — tin tới trong 4 giây trễ (hoặc giữa lúc lượt đang chạy) gộp vào đúng MỘT
  // lượt kế tiếp; không hai lượt song song. Khoá lạc quan ở `inbox.applyAutoreplyDecision` nên retry an toàn (lượt đã
  // trả lời → `skipped`). Retry 2 backoff, concurrency 5. Hạn 300 giây > 2 lời gọi OpenAI (mỗi lời ≤120 giây). Hỏi
  // job 0,5 giây (NFR1: p95 webhook → tin AI đã gửi ≤15 giây).
  'autoreply.run': {
    policy: 'stately',
    singletonKey: (data: { conversationId: string }) => data.conversationId,
    retryLimit: 2,
    retryDelay: 5,
    retryBackoff: true,
    concurrency: 5,
    expireInSeconds: 300,
    pollingIntervalSeconds: 0.5,
  },
  // Module `inbox` (Story 4.3, AD-11, AD-14): tải đính kèm của khách từ CDN Meta về kho riêng tư. Chống trùng bằng
  // `UPDATE … WHERE status='pending'`. Chỉ lỗi tạm (CDN/kho 5xx, chặn tần suất) ném để retry; lần thử cuối ghi
  // `failed` (tin vẫn còn, chỉ đính kèm lỗi). Link CDN hết hạn sau vài giờ → retry trong vài phút là đủ.
  'inbox.fetch_attachment': {
    policy: 'standard',
    retryLimit: 3,
    retryDelay: 10,
    retryBackoff: true,
    concurrency: 3,
    expireInSeconds: 120,
    pollingIntervalSeconds: 0.5,
  },
  // Module `inbox` (Story 4.3): lấy tên khách từ Meta cho định danh mới (`GET /{PSID|IGSID}`). Không ghi đè tên đã
  // có. Theo policy `connections.*` của AD-24 (gọi Meta nền): retry 3, concurrency 2.
  'inbox.fetch_profile': {
    policy: 'standard',
    retryLimit: 3,
    retryDelay: 30,
    retryBackoff: true,
    concurrency: 2,
    expireInSeconds: 60,
  },
  // Module `inbox` (Story 4.4, AD-16): caption bài được bình luận, lấy một lần khi tạo hội thoại `comment`
  // (`post_text_snapshot` cho autoreply Epic 5). Gọi Meta nền như `inbox.fetch_profile`: retry 3, concurrency 2.
  'inbox.fetch_post_text': {
    policy: 'standard',
    retryLimit: 3,
    retryDelay: 30,
    retryBackoff: true,
    concurrency: 2,
    expireInSeconds: 60,
  },
  // Module `inbox` (Story 4.7, AD-10, AD-24): gửi một tin outbound qua Meta. Chống trùng bằng
  // `UPDATE … SET status='sending' WHERE status='pending'` (không singletonKey). Chỉ `TRANSIENT` ném để retry (tin trả
  // về `pending` trước); `RATE_LIMITED` hoãn bằng job mới `startAfter` (không tính lượt); lần thử cuối / lỗi khác ghi
  // `failed` + mã rồi kết thúc êm. Retry 5 backoff (5/10/20/40/80 giây), concurrency 5. `critical`: handler chỉ ném ở
  // lần cuối khi lỗi bất ngờ (DB…) → thông báo `system_error`. Hỏi job 0,5 giây để tin đi ngay.
  'inbox.send': {
    policy: 'standard',
    retryLimit: 5,
    retryDelay: 5,
    retryBackoff: true,
    concurrency: 5,
    // Threads gửi 2 lời gọi (mỗi lời ≤30 giây).
    expireInSeconds: 120,
    pollingIntervalSeconds: 0.5,
    critical: true,
  },
  // Module `inbox` (Story 4.7): mỗi 5 phút đưa tin kẹt `sending` quá 15 phút về `failed` `SEND_UNKNOWN` (worker chết giữa
  // lời gọi Meta — có thể đã tới khách nên không tự gửi lại). Idempotent; cron chạy lại sau 5 phút → retry 1.
  'inbox.send_sweep': {
    policy: 'standard',
    retryLimit: 1,
    concurrency: 1,
    expireInSeconds: 60,
    cron: { expression: '*/5 * * * *', tz: CRON_TZ },
  },
  // Module `inbox` (Story 4.5, AD-20, AD-24): tin của chính trang (echo) chưa khớp tin nào app gửi → thử khớp lại.
  // `webhook.route` thử lần đầu ngay rồi enqueue job `startAfter` 5 giây; chưa khớp thì handler ném để retry sau 5 giây
  // (không backoff). Lần chạy thứ 3 chèn `app_unmatched` / `external_human`; lượt retry thứ 4 chỉ dự phòng lỗi bất ngờ
  // (DB…). Idempotent: tin đã gắn id → `duplicate`. Hỏi job 0,5 giây như `webhook.route`.
  'inbox.echo_match': {
    policy: 'standard',
    retryLimit: 3,
    retryDelay: 5,
    concurrency: 5,
    expireInSeconds: 60,
    pollingIntervalSeconds: 0.5,
  },
  // Module `inbox` (Story 4.9, AD-2, AD-7): tóm tắt khách bằng AI (`feature=contact_summary`) khi chủ shop bấm. Route
  // đánh dấu chờ + enqueue cùng transaction, không enqueue lại khi đang chờ — chống trùng bằng điều kiện trạng thái.
  // Chỉ lỗi tạm (`RATE_LIMITED`, OpenAI 5xx) ném để retry; lỗi khác / lần cuối ghi mã lỗi lên khách rồi kết thúc êm.
  // Retry 2 backoff, concurrency 2. Hỏi job 0,5 giây để bản tóm tắt hiện sớm. Hạn 180 giây > hết giờ OpenAI (120 giây)
  // để lời gọi tự hết giờ trước khi pg-boss huỷ `job.signal`.
  'inbox.contact_summary': {
    policy: 'standard',
    retryLimit: 2,
    retryDelay: 10,
    retryBackoff: true,
    concurrency: 2,
    expireInSeconds: 180,
    pollingIntervalSeconds: 0.5,
  },
  // Module `profiles` (Story 5.2, AD-16, AD-24): trích văn bản file kho kiến thức. Chống trùng bằng
  // `UPDATE … WHERE status='processing'` (không singletonKey). Trích chạy trong thread có timeout 60 giây (huỷ cứng);
  // lỗi trích không retry. Chỉ lỗi tạm khi tải file từ kho (5xx, chặn tần suất) ném để retry; lần cuối ghi `failed`.
  // Retry 2 backoff, concurrency 1 (pdf.js tốn CPU/bộ nhớ). Hạn 180 giây > tải file (30 giây) + trích (60 giây).
  // Hỏi job 0,5 giây để dòng trên FE đổi trạng thái sớm.
  'profiles.knowledge.extract': {
    policy: 'standard',
    retryLimit: 2,
    retryDelay: 10,
    retryBackoff: true,
    concurrency: 1,
    expireInSeconds: 180,
    pollingIntervalSeconds: 0.5,
  },
  // Module `content` (Story 6.3, AD-14, AD-24): sinh một ô ảnh AI (gateway `image_generate` → kho công khai). Route ghi ô
  // `pending` + enqueue cùng transaction; chống trùng bằng `UPDATE … WHERE status='pending'` (không singletonKey). Chỉ
  // lỗi tạm của OpenAI (`RATE_LIMITED`, 5xx) ném để retry; lỗi khác / lần cuối ghi `failed` rồi kết thúc êm. Retry 2
  // backoff, concurrency 2 (AD-24). Hạn 240 giây > hết giờ Images API (180 giây) + tải lên kho, để lời gọi tự hết giờ
  // trước khi pg-boss huỷ `job.signal`. Hỏi job 0,5 giây để ô ảnh bắt đầu sớm.
  'content.image.generate': {
    policy: 'standard',
    retryLimit: 2,
    retryDelay: 10,
    retryBackoff: true,
    concurrency: 2,
    expireInSeconds: 240,
    pollingIntervalSeconds: 0.5,
  },
  // Module `content` (Story 6.3, AD-14): mỗi ngày 4h sáng (giờ VN) xoá ảnh bài không gắn vào bài nào quá 7 ngày (dòng +
  // file Cloudinary). Idempotent; cron chạy lại ngày sau → retry 1.
  'content.media_gc': {
    policy: 'standard',
    retryLimit: 1,
    concurrency: 1,
    expireInSeconds: 600,
    cron: { expression: '0 4 * * *', tz: CRON_TZ },
  },
  // Module `content` (Story 6.4, AD-13, AD-24): đăng một target lên trang. Không singletonKey — chống trùng bằng
  // `schedule_version` + `UPDATE … SET status='publishing' WHERE status='scheduled' AND schedule_version=?` (đổi giờ = job
  // mới, job cũ thấy lệch phiên bản rồi bỏ qua). Chỉ lỗi tạm CHẮC CHẮN chưa tạo bài ném để retry (target về `scheduled`
  // trước); `RATE_LIMITED` hoãn bằng job mới `startAfter` (không tính lượt); không rõ Meta đã nhận → `PUBLISH_UNKNOWN`,
  // không retry. Retry 5 backoff (30/60/120/240/480 giây), concurrency 3. Hạn 300 giây > tạo container (30 giây) + hỏi
  // trạng thái (≤60 giây) + publish (30 giây) + permalink (30 giây); job hết hạn mà vẫn chạy thì lần retry thấy
  // `publishing` và bỏ qua. `critical`: handler chỉ ném ở lần cuối khi lỗi bất ngờ (DB…) → thông báo `system_error`.
  // Hỏi job 0,5 giây để "Đăng ngay" đi ngay.
  'publish.target': {
    policy: 'standard',
    retryLimit: 5,
    retryDelay: 30,
    retryBackoff: true,
    concurrency: 3,
    expireInSeconds: 300,
    pollingIntervalSeconds: 0.5,
    critical: true,
  },
  // Module `content` (Story 6.4, AD-13): mỗi 15 phút (giờ VN) enqueue lại target `scheduled` quá giờ 10 phút mà không còn
  // job sống, và đưa target kẹt `publishing` quá 15 phút về `failed` `PUBLISH_UNKNOWN` (có thể đã lên — không tự đăng
  // lại). Idempotent; cron chạy lại sau 15 phút → retry 1.
  'content.requeue': {
    policy: 'standard',
    retryLimit: 1,
    concurrency: 1,
    expireInSeconds: 120,
    cron: { expression: '*/15 * * * *', tz: CRON_TZ },
  },
  // Module `campaigns` (Story 7.2, AD-15, AD-24): sinh 7 bài xem trước của chiến dịch nháp (caption theo hồ sơ từng trang;
  // ảnh đi job `content.image.generate`). `stately` theo `campaignId`: tối đa một lượt chờ + một lượt chạy mỗi chiến dịch —
  // lưu lại / "Tạo lại" trong lúc đang chạy gộp vào đúng MỘT lượt kế tiếp. Idempotent (slot đã sinh bỏ qua; mọi lần ghi
  // `UPDATE … WHERE status='planned'`) nên retry an toàn. Chỉ lỗi tạm của OpenAI ném để retry; lần cuối ghi mã lên slot.
  // Retry 2 backoff, concurrency 2 (AD-24). Hạn 900 giây > 7 slot / 3 song song × 2 lời gọi (mỗi lời ≤120 giây). Hỏi job
  // 0,5 giây để bước 4 bắt đầu ngay.
  'campaigns.preview': {
    policy: 'stately',
    singletonKey: (data: { campaignId: string }) => data.campaignId,
    retryLimit: 2,
    retryDelay: 10,
    retryBackoff: true,
    concurrency: 2,
    expireInSeconds: 900,
    pollingIntervalSeconds: 0.5,
  },
  // Module `campaigns` (Story 7.4, AD-15, AD-24): một lượt sinh cuốn chiếu của chiến dịch `running` — slot `planned` trong 3
  // ngày tới, theo lô 9 slot (còn thì lượt tự enqueue lượt sau), 3 slot song song; "Tự đăng" duyệt luôn bài xong. `stately`
  // theo `campaignId`: cron / "Tạo lại" / "Bắt đầu" trong lúc đang chạy gộp vào đúng MỘT lượt kế tiếp. Idempotent: slot đã
  // sinh bỏ qua, lease chặn hai lượt cùng viết một slot. Chỉ lỗi tạm của OpenAI ném để retry; lần cuối ghi mã lên slot.
  // Retry 2 backoff, concurrency 2 (AD-24). Hạn 900 giây > 9 slot / 3 song song × 2 lời gọi (mỗi lời ≤120 giây).
  'campaigns.generate': {
    policy: 'stately',
    singletonKey: (data: { campaignId: string }) => data.campaignId,
    retryLimit: 2,
    retryDelay: 10,
    retryBackoff: true,
    concurrency: 2,
    expireInSeconds: 900,
    pollingIntervalSeconds: 0.5,
  },
  // Module `campaigns` (Story 7.4, AD-15): hằng giờ (giờ VN) chốt ô ảnh slot kẹt, enqueue `campaigns.generate` cho mọi
  // chiến dịch đang chạy và `campaigns.preview` cho nháp có bài xem trước kẹt. Idempotent; cron chạy lại giờ sau → retry 1.
  'campaigns.generate_window': {
    policy: 'standard',
    retryLimit: 1,
    concurrency: 1,
    expireInSeconds: 120,
    cron: { expression: '0 * * * *', tz: CRON_TZ },
  },
  // Module `campaigns` (Story 7.5, AD-15): hằng giờ (phút 5, lệch lượt sinh cuốn chiếu) chuyển chiến dịch `running|paused`
  // không còn slot `planned|pending_approval|scheduled|publishing` sang `done` + `campaign.completed`. Idempotent (kiểm lại
  // dưới khoá dòng); cron chạy lại giờ sau → retry 1.
  'campaigns.complete_check': {
    policy: 'standard',
    retryLimit: 1,
    concurrency: 1,
    expireInSeconds: 120,
    cron: { expression: '5 * * * *', tz: CRON_TZ },
  },
  // Module `analytics` (Story 8.1, AD-17): cron chỉ rải `analytics.collect_posts` (mỗi 6 giờ, phút 15) / `analytics.collect_page`
  // (4h30 sáng giờ VN, sau `connections.token_check`) cho mỗi trang chưa gỡ, không mất kết nối — không gọi Meta. Cron chạy
  // lại kỳ sau → retry 1.
  'analytics.post_metrics': {
    policy: 'standard',
    retryLimit: 1,
    concurrency: 1,
    expireInSeconds: 120,
    cron: { expression: '15 */6 * * *', tz: CRON_TZ },
  },
  'analytics.page_metrics': {
    policy: 'standard',
    retryLimit: 1,
    concurrency: 1,
    expireInSeconds: 120,
    cron: { expression: '30 4 * * *', tz: CRON_TZ },
  },
  // Module `analytics` (Story 8.1, AD-17, AD-6, AD-24 `analytics.*`): kéo insight của một trang, hạng `background`. Ghi bằng
  // upsert theo khoá ngày → chạy trùng / retry không nhân đôi số. `RATE_LIMITED` không ném: handler tự enqueue lại `startAfter`
  // (không tính lượt retry). Chỉ lỗi tạm mức trang ném để retry (3, backoff từ 60 giây); lần cuối ghi `failed`. Concurrency 2
  // giữ nhịp gọi thấp. Hạn 900 giây > 300 bài × một lời gọi nhanh (lỗi tạm liên tiếp dừng sớm).
  'analytics.collect_posts': {
    policy: 'standard',
    retryLimit: 3,
    retryDelay: 60,
    retryBackoff: true,
    concurrency: 2,
    expireInSeconds: 900,
  },
  'analytics.collect_page': {
    policy: 'standard',
    retryLimit: 3,
    retryDelay: 60,
    retryBackoff: true,
    concurrency: 2,
    expireInSeconds: 300,
  },
  // Story 9.2 (AD-22, AD-24, AD-1): luồng xoá dữ liệu hai giai đoạn. Mỗi module xoá bảng của mình trong queue `<module>.purge`
  // (giai đoạn 1 nghe `privacy.purge_requested`; `inbox` — phần cuối — nghe `privacy.purge_final_requested`), theo lô, rồi
  // phát `privacy.purge_part_completed`. Handler idempotent (xoá phần còn lại, phát lại phần đã xong — `privacy` bỏ trùng) nên
  // retry / worker chết giữa chừng đều chạy tiếp được. Retry 5 backoff (AD-24 `events.<module>`), concurrency 1 (một lượt
  // xoá mỗi module mỗi lúc). Hạn 900 giây > lô lớn của trang nhiều tin (job hết hạn thì lần retry chạy tiếp). `critical`:
  // hết retry → thông báo `system_error`; cron `privacy.purge_resume` phát lại sau 1 giờ. Hỏi job 0,5 giây để khách bị xoá
  // biến mất khỏi Hộp thư sớm.
  'autoreply.purge': PURGE_DEF(['privacy.purge_requested']),
  'webhooks.purge': PURGE_DEF(['privacy.purge_requested']),
  'ai.purge': PURGE_DEF(['privacy.purge_requested']),
  'content.purge': PURGE_DEF(['privacy.purge_requested']),
  'connections.purge': PURGE_DEF(['privacy.purge_requested']),
  'inbox.purge': PURGE_DEF(['privacy.purge_final_requested']),
  // Module `privacy` (Story 9.2): ghi phần đã xong, phát giai đoạn cuối / đóng yêu cầu. Khoá dòng yêu cầu nên idempotent.
  'events.privacy': {
    policy: 'standard',
    retryLimit: 5,
    retryDelay: 2,
    retryBackoff: true,
    concurrency: 1,
    expireInSeconds: 60,
    pollingIntervalSeconds: 0.5,
    subscribes: ['privacy.purge_part_completed'],
    critical: true,
  },
  // Module `privacy` (Story 9.2): mỗi giờ (phút 20) phát lại giai đoạn đang dở của yêu cầu mở quá 1 giờ không tiến triển.
  // Idempotent; cron chạy lại giờ sau → retry 1.
  'privacy.purge_resume': {
    policy: 'standard',
    retryLimit: 1,
    concurrency: 1,
    expireInSeconds: 120,
    cron: { expression: '20 * * * *', tz: CRON_TZ },
  },
  // Module `privacy` (Story 9.2, AD-22 retention): 2h30 sáng (giờ VN) tạo yêu cầu `scope=page` cho trang gỡ quá 30 ngày.
  // Idempotent (mỗi lần gỡ tối đa một yêu cầu); cron chạy lại ngày sau → retry 1.
  'privacy.removed_pages': {
    policy: 'standard',
    retryLimit: 1,
    concurrency: 1,
    expireInSeconds: 300,
    cron: { expression: '30 2 * * *', tz: CRON_TZ },
  },
} as const satisfies { [N in keyof QueuePayloads]: QueueDef }

export type QueueName = keyof typeof QUEUES
export type QueueRegistry = Readonly<Record<string, QueueDef>>

export class UnknownQueueError extends Error {
  readonly code = 'UNKNOWN_QUEUE'
  readonly queue: string
  constructor(queue: string) {
    super(`UNKNOWN_QUEUE: queue "${queue}" không khai báo trong platform/jobs/queues.ts`)
    this.name = 'UnknownQueueError'
    this.queue = queue
  }
}

export class InvalidQueueRegistryError extends Error {
  readonly code = 'INVALID_QUEUE_REGISTRY'
}

const QUEUE_NAME = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/

/** Kiểm luật AD-24 trên registry; ném lỗi ở lúc khởi động thay vì để pg-boss âm thầm bỏ qua. */
export function validateRegistry(registry: QueueRegistry): void {
  for (const [name, def] of Object.entries(registry)) {
    const fail = (why: string) => {
      throw new InvalidQueueRegistryError(`queue "${name}": ${why}`)
    }
    if (!QUEUE_NAME.test(name)) fail('tên phải dạng <module>.<action>')
    if (def.policy !== 'standard' && def.policy !== 'stately') fail(`policy "${String((def as { policy: unknown }).policy)}" không được dùng`)
    if (def.singletonKey !== undefined && def.policy !== 'stately') fail('singletonKey chỉ dùng với policy stately')
    if (def.policy === 'stately' && typeof def.singletonKey !== 'function') fail('queue stately cần hàm singletonKey')
    if (!Number.isInteger(def.concurrency) || def.concurrency < 1) fail('concurrency phải là số nguyên ≥ 1')
    if (!Number.isInteger(def.retryLimit) || def.retryLimit < 0) fail('retryLimit phải là số nguyên ≥ 0')
    if (def.cron) {
      if (def.policy !== 'standard') fail('cron chỉ khai báo trên queue standard')
      if (def.cron.tz !== CRON_TZ) fail(`cron phải dùng tz "${CRON_TZ}"`)
    }
    if (def.pollingIntervalSeconds !== undefined && !(def.pollingIntervalSeconds >= 0.5)) {
      fail('pollingIntervalSeconds phải ≥ 0.5')
    }
    for (const event of def.subscribes ?? []) {
      if (!isEventName(event)) fail(`subscribes "${String(event)}" không có trong packages/shared/events.ts`)
    }
  }
}

/** Queue có `critical: true` (job hết retry ở đây → thông báo `system_error`). */
export function isCriticalQueue(name: string, registry: QueueRegistry = QUEUES): boolean {
  return isQueueName(name, registry) && registry[name]!.critical === true
}

export function isQueueName(name: string, registry: QueueRegistry = QUEUES): boolean {
  return Object.hasOwn(registry, name)
}

export function getQueueDef(name: string, registry: QueueRegistry = QUEUES): QueueDef {
  if (!isQueueName(name, registry)) throw new UnknownQueueError(name)
  return registry[name]!
}

export interface SendJobOptions {
  startAfter?: Date | number | string
  /** Executor của transaction đang mở (pg-boss `db`), để enqueue cùng transaction (AD-2). */
  db?: BossDb
}

export interface JobSender {
  send<N extends QueueName>(name: N, data: QueuePayloads[N], options?: SendJobOptions): Promise<string | null>
}

/** Wrapper duy nhất để enqueue: chỉ tên trong registry, singletonKey tự suy cho queue stately. */
export function createJobSender(
  boss: Pick<PgBoss, 'send'>,
  registry: QueueRegistry = QUEUES,
): JobSender {
  validateRegistry(registry)
  return {
    async send(name, data, options = {}) {
      const def = getQueueDef(name, registry)
      const sendOptions: SendOptions = {}
      if (options.startAfter !== undefined) sendOptions.startAfter = options.startAfter
      if (options.db) sendOptions.db = options.db
      if (def.policy === 'stately') {
        const key = (def.singletonKey as (d: unknown) => string)(data)
        if (typeof key !== 'string' || key === '') {
          throw new InvalidQueueRegistryError(`queue "${name}": singletonKey suy từ payload rỗng`)
        }
        sendOptions.singletonKey = key
      }
      return boss.send(name, data as object, sendOptions)
    },
  }
}
