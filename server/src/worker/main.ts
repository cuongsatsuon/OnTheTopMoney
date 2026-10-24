// Entrypoint `worker`: node src/worker/main.ts — pg-boss job, cron, consumer sự kiện.
import type { JobWithMetadata } from 'pg-boss'
import { getConfig } from '../platform/config/index.ts'
import { createLogger } from '../platform/log/index.ts'
import { assertBossDbSupported, createDb, newId } from '../platform/db/index.ts'
import { createEventPublisher, parseEventEnvelope } from '../platform/events/index.ts'
import { QUEUES, createBoss, createJobSender, ensureQueues, isCriticalQueue, startWorkers } from '../platform/jobs/index.ts'
import { createSecretCipher } from '../adapters/crypto/index.ts'
import { createMediaStores } from '../adapters/media/index.ts'
import { gcReservations, handleAiEvent, handleAiPurge } from '../modules/ai/index.ts'
import { handleCollectPageJob, handleCollectPostsJob, runPageMetricsCron, runPostMetricsCron } from '../modules/analytics/index.ts'
import { campaignProductImageIds, handleCampaignsEvent, handleGenerateJob, handlePreviewJob, runCompleteCheck, runGenerateWindow } from '../modules/campaigns/index.ts'
import { handleAutoreplyPurge, handleRunJob, handleTriageEvent } from '../modules/autoreply/index.ts'
import {
  cleanupExpiredOAuth,
  createMetaClients,
  enqueueMissingSubscriptions,
  handleConnectionsPurge,
  handleSubscribeJob,
  recordSubscribeError,
  runTokenCheck,
  subscribePage,
} from '../modules/connections/index.ts'
import { gcOrphanMedia, handleContentEvent, handleContentPurge, handleImageGenerateJob, handlePublishJob, requeueTargets } from '../modules/content/index.ts'
import {
  handleContactSummaryJob,
  handleEchoMatchJob,
  handleFetchAttachmentJob,
  handleFetchPostTextJob,
  handleFetchProfileJob,
  handleInboxPurge,
  handleSendJob,
  sweepStuckSending,
} from '../modules/inbox/index.ts'
import { handleEvent } from '../modules/notifications/index.ts'
import { handlePrivacyEvent, resumeStalledRequests, sweepRemovedPages } from '../modules/privacy/index.ts'
import { handleKnowledgeExtractJob, handleProfilesEvent } from '../modules/profiles/index.ts'
import { handleRouteJob, handleWebhooksPurge, markEventFailed, routeWebhookEvent, runHealthCheck } from '../modules/webhooks/index.ts'
import { HEARTBEAT_INTERVAL_MS, writeHeartbeat } from './heartbeat.ts'
import { resolveSweepMode, runRetention, sweepOrphanFiles } from './retention.ts'

const config = getConfig()
const logger = createLogger({ level: config.LOG_LEVEL, name: 'worker' })
const instanceId = newId()
const dbHandle = createDb(config.DATABASE_URL, { applicationName: 'ottm-worker', max: 5 })
const boss = createBoss(config.DATABASE_URL, 'ottm-worker-boss')
boss.on('error', (err) => logger.error({ err }, 'pg-boss lỗi'))
const events = createEventPublisher(boss)
// Làm mới / mã hoá token Meta trong cron `connections.token_check` (AD-5, AD-12). Dev không đặt khoá → null.
const cipher =
  config.APP_ENCRYPTION_KEYS && config.APP_ENCRYPTION_ACTIVE_KEY
    ? createSecretCipher({ keys: config.APP_ENCRYPTION_KEYS, activeKeyId: config.APP_ENCRYPTION_ACTIVE_KEY })
    : null
// Client Threads (fake khi `META_FAKE=1`; undefined khi chưa cấu hình app Threads) để làm mới token Threads;
// client Graph để đăng ký webhook trang (`connections.subscribe_page`, Story 4.2); cả hai đọc caption bài (Story 4.4)
// và gửi tin từ Hộp thư (`inbox.send`, Story 4.7).
const { graph, threads } = createMetaClients({ config, db: dbHandle.db, log: logger.child({ component: 'meta' }) })
const jobs = createJobSender(boss)
// Kho file riêng tư (AD-14) cho đính kèm của khách (Story 4.3) và file kho kiến thức (Story 5.2); thiếu
// `CLOUDINARY_URL` → đính kèm `failed` `MEDIA_NOT_CONFIGURED`, tin vẫn vào Hộp thư. Kho công khai cho ảnh AI và cron
// dọn ảnh bài (Story 6.3).
const media = createMediaStores({ CLOUDINARY_URL: config.CLOUDINARY_URL, CLOUDINARY_FOLDER: config.CLOUDINARY_FOLDER })
// Story 4.5: id app của chính máy chủ — echo có `app_id` khác là chủ shop trả lời ngoài app (Business Suite…).
const appIds = [config.META_APP_ID, config.THREADS_APP_ID].filter((id): id is string => typeof id === 'string' && id !== '')

// Story 8.1: phụ thuộc của job thu số liệu (token / quyền qua `connections`, Meta hạng `background`).
const analyticsDeps = { db: dbHandle.db, events, jobs, cipher, graph, threads, log: logger.child({ component: 'analytics' }) }

/** Story 9.2: kết quả một phần xoá — chỉ id yêu cầu + số đếm (không PII). */
function logPurge(queue: string, jobId: string, result: object | 'ignored'): void {
  if (result === 'ignored') logger.debug({ jobId }, `${queue}: bỏ qua`)
  else logger.info({ jobId, ...result }, queue)
}

let heartbeatTimer: NodeJS.Timeout | undefined
let closing = false
async function shutdown(signal: string, code = 0): Promise<void> {
  if (closing) return
  closing = true
  logger.info({ signal }, 'worker đang dừng')
  clearInterval(heartbeatTimer)
  await boss.stop({ graceful: true, timeout: 10_000 }).catch((err: unknown) => logger.error({ err }, 'lỗi khi dừng pg-boss'))
  await dbHandle.close().catch(() => {})
  process.exit(code)
}
process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))

try {
  await assertBossDbSupported(dbHandle.db)
  await boss.start()
  const { unknownQueues } = await ensureQueues(boss)
  if (unknownQueues.length > 0) {
    logger.warn({ unknownQueues }, 'pg-boss có queue không khai báo trong platform/jobs/queues.ts')
  }
  await startWorkers(
    boss,
    {
      'platform.heartbeat': () => writeHeartbeat(dbHandle.db, instanceId),
      'events.notifications': async (job) => {
        const result = await handleEvent(
          { db: dbHandle.db, events, isCriticalQueue: (queue) => isCriticalQueue(queue) },
          parseEventEnvelope(job.data),
        )
        logger.debug({ jobId: job.id, result }, 'events.notifications')
      },
      'events.ai': async (job) => {
        const result = await handleAiEvent({ db: dbHandle.db, events }, job.data)
        logger.debug({ jobId: job.id, result }, 'events.ai')
      },
      'events.profiles': async (job) => {
        // Giống `events.ai`/`events.notifications`: `handleProfilesEvent` tự kiểm (isEventEnvelope + guard),
        // dữ liệu hỏng → 'ignored' (không ném ZodError đốt lượt retry). Idempotent nên retry an toàn.
        const result = await handleProfilesEvent({ db: dbHandle.db }, job.data)
        logger.debug({ jobId: job.id, result }, 'events.profiles')
      },
      // Story 7.6: gỡ trang → huỷ bài chưa đăng của trang (`PAGE_REMOVED`). Tự kiểm envelope; idempotent.
      'events.content': async (job) => {
        const result = await handleContentEvent({ db: dbHandle.db }, job.data)
        logger.debug({ jobId: job.id, result }, 'events.content')
      },
      // Story 7.6: chiến dịch tự tạm dừng (trang mất kết nối, hạn mức AI 100%, chuỗi bài đăng lỗi), bỏ trang bị gỡ / rời
      // nhóm nhãn. Tự kiểm envelope (sai dạng → 'ignored'); idempotent nên retry an toàn.
      'events.campaigns': async (job) => {
        const result = await handleCampaignsEvent({ db: dbHandle.db, jobs, events, cipher }, job.data)
        if (result !== 'ignored' && result.changed > 0) logger.info({ jobId: job.id, result }, 'events.campaigns')
        else logger.debug({ jobId: job.id, result }, 'events.campaigns')
      },
      'ai.reservations_gc': async () => {
        const removed = await gcReservations(dbHandle.db)
        if (removed > 0) logger.warn({ removed }, 'ai: đã dọn chỗ giữ chi phí bị bỏ rơi')
      },
      'connections.oauth_gc': async () => {
        const removed = await cleanupExpiredOAuth(dbHandle.db)
        if (removed > 0) logger.info({ removed }, 'connections: đã dọn state/kết quả OAuth hết hạn')
      },
      'connections.token_check': async () => {
        const { refreshed, expiring } = await runTokenCheck({
          db: dbHandle.db,
          events,
          cipher,
          threads,
          log: logger.child({ component: 'token_check' }),
        })
        logger.info({ refreshed, expiring }, 'connections: kiểm hạn token xong')
      },
      // Module `webhooks` (Story 4.1, AD-4): chuẩn hoá + đặt `status` cho một mục; Story 4.3/4.4: tin DM, bình luận → `inbox`. Logic nhánh catch (lần thử
      // cuối → ghi `failed`) nằm trong `handleRouteJob` (đã unit-test). startWorkers chạy includeMetadata nên
      // job có retryCount/retryLimit lúc chạy.
      'webhook.route': (job) =>
        handleRouteJob(
          {
            route: (data) => routeWebhookEvent({ db: dbHandle.db, events, jobs, appIds }, data),
            markFailed: (eventId, errorCode) => markEventFailed(dbHandle.db, eventId, errorCode),
          },
          job as JobWithMetadata<unknown>,
        ),
      // Story 4.2: đăng ký webhook cho một trang. Lỗi retry được ném lại; lần thử cuối ghi `FAILED` (handleSubscribeJob).
      'connections.subscribe_page': (job) =>
        handleSubscribeJob(
          {
            subscribe: async (pageId) => {
              const outcome = await subscribePage(
                { db: dbHandle.db, events, cipher, graph, log: logger.child({ component: 'subscribe_page' }) },
                pageId,
              )
              logger.debug({ jobId: job.id, pageId, outcome: outcome.status }, 'connections.subscribe_page')
            },
            markFailed: (pageId, errorCode) => recordSubscribeError(dbHandle.db, pageId, errorCode),
          },
          job as JobWithMetadata<unknown>,
        ),
      // Story 4.3 / 5.4: tin khách → giải `triage` ngay theo cổng AD-16; hội thoại `ai` / bật lại AI → `autoreply.run`.
      'autoreply.triage': async (job) => {
        const result = await handleTriageEvent({ db: dbHandle.db, events, jobs, cipher }, job.data)
        logger.debug({ jobId: job.id, result }, 'autoreply.triage')
      },
      // Story 5.4: một lượt AI trả lời (stately theo hội thoại). Lỗi bất ngờ ném để retry; lần cuối chuyển người.
      // Story 5.6: `job.signal` (huỷ khi quá hạn) đi theo `job` xuống gateway; lượt cũng khôi phục `handoff` tạm đóng.
      'autoreply.run': async (job) => {
        const result = await handleRunJob(
          { db: dbHandle.db, events, jobs, cipher, log: logger.child({ component: 'autoreply_run' }) },
          job as JobWithMetadata<unknown>,
        )
        logger.debug({ jobId: job.id, result }, 'autoreply.run')
      },
      // Story 4.3: tải đính kèm của khách về kho riêng tư. Lỗi tạm ném lại; lần thử cuối ghi `failed`.
      'inbox.fetch_attachment': async (job) => {
        const result = await handleFetchAttachmentJob({ db: dbHandle.db, events, media }, job as JobWithMetadata<unknown>)
        logger.debug({ jobId: job.id, result }, 'inbox.fetch_attachment')
      },
      // Story 4.3: tên khách cho định danh mới (không ghi đè tên đã có).
      'inbox.fetch_profile': async (job) => {
        const result = await handleFetchProfileJob(
          { db: dbHandle.db, events, cipher, graph, log: logger.child({ component: 'fetch_profile' }) },
          job as JobWithMetadata<unknown>,
        )
        logger.debug({ jobId: job.id, result }, 'inbox.fetch_profile')
      },
      // Story 4.4: caption bài được bình luận, lấy một lần (không ghi đè).
      'inbox.fetch_post_text': async (job) => {
        const result = await handleFetchPostTextJob(
          { db: dbHandle.db, events, cipher, graph, threads, log: logger.child({ component: 'fetch_post_text' }) },
          job as JobWithMetadata<unknown>,
        )
        logger.debug({ jobId: job.id, result }, 'inbox.fetch_post_text')
      },
      // Story 4.7: gửi một tin outbound qua Meta. Lỗi tạm ném lại (tin đã về `pending`); lần thử cuối ghi `failed`.
      'inbox.send': async (job) => {
        const result = await handleSendJob(
          { db: dbHandle.db, events, jobs, cipher, graph, threads, log: logger.child({ component: 'inbox_send' }) },
          job as JobWithMetadata<unknown>,
        )
        logger.debug({ jobId: job.id, result }, 'inbox.send')
      },
      // Story 4.5: thử khớp lại tin của chính trang (5 giây × 3); chưa khớp thì ném để retry, lần cuối chèn tin.
      'inbox.echo_match': async (job) => {
        const result = await handleEchoMatchJob({ db: dbHandle.db, events, jobs, appIds }, job as JobWithMetadata<unknown>)
        logger.debug({ jobId: job.id, result: result.status }, 'inbox.echo_match')
      },
      // Story 4.9: tóm tắt khách bằng AI (gateway `contact_summary`). Lỗi tạm ném lại; lần cuối / lỗi khác ghi mã lỗi.
      'inbox.contact_summary': async (job) => {
        const result = await handleContactSummaryJob(
          { db: dbHandle.db, events, cipher, log: logger.child({ component: 'contact_summary' }) },
          job as JobWithMetadata<unknown>,
        )
        logger.debug({ jobId: job.id, result }, 'inbox.contact_summary')
      },
      // Story 5.2: trích văn bản file kho kiến thức (thread có timeout). Lỗi tải tạm ném lại; lần cuối ghi `failed`.
      'profiles.knowledge.extract': async (job) => {
        const result = await handleKnowledgeExtractJob({ db: dbHandle.db, events, media }, job as JobWithMetadata<unknown>)
        logger.debug({ jobId: job.id, result }, 'profiles.knowledge.extract')
      },
      // Story 6.3: sinh một ô ảnh AI (gateway → kho công khai). Lỗi tạm của OpenAI ném lại; lần cuối / lỗi khác ghi `failed`.
      'content.image.generate': async (job) => {
        const result = await handleImageGenerateJob(
          { db: dbHandle.db, events, jobs, cipher, media, log: logger.child({ component: 'image_generate' }) },
          job as JobWithMetadata<unknown>,
        )
        logger.debug({ jobId: job.id, result }, 'content.image.generate')
      },
      // Story 7.2: sinh bài xem trước của chiến dịch nháp (caption theo hồ sơ; ảnh đi `content.image.generate`). Lỗi tạm của
      // OpenAI ném lại sau khi slot khác đã xong; lần cuối ghi mã lên slot (`pending_approval`).
      'campaigns.preview': async (job) => {
        const result = await handlePreviewJob(
          { db: dbHandle.db, events, jobs, cipher, log: logger.child({ component: 'campaigns_preview' }) },
          job as JobWithMetadata<unknown>,
        )
        logger.debug({ jobId: job.id, result }, 'campaigns.preview')
      },
      // Story 7.4: một lượt sinh cuốn chiếu (slot `planned` trong 3 ngày tới, theo lô; "Tự đăng" duyệt luôn). Khoá / hạn mức
      // AI chặn → dừng không gọi AI; lỗi tạm của OpenAI ném lại sau khi lô xong; lần cuối ghi mã lên slot.
      'campaigns.generate': async (job) => {
        const result = await handleGenerateJob(
          { db: dbHandle.db, events, jobs, cipher, log: logger.child({ component: 'campaigns_generate' }) },
          job as JobWithMetadata<unknown>,
        )
        logger.debug({ jobId: job.id, result }, 'campaigns.generate')
      },
      // Story 7.4: hằng giờ chốt ô ảnh slot kẹt, enqueue `campaigns.generate` cho chiến dịch đang chạy, vá bài xem trước kẹt.
      'campaigns.generate_window': async () => {
        const result = await runGenerateWindow({ db: dbHandle.db, events, jobs, log: logger.child({ component: 'campaigns_window' }) })
        if (result.stuckImages > 0 || result.preview > 0) logger.warn(result, 'campaigns: vá slot kẹt')
        else logger.debug(result, 'campaigns.generate_window')
      },
      // Story 7.5: hằng giờ chuyển chiến dịch không còn slot mở sang `done` (phát `campaign.completed`).
      'campaigns.complete_check': async () => {
        const done = await runCompleteCheck({ db: dbHandle.db, events })
        if (done > 0) logger.info({ done }, 'campaigns: chiến dịch đã xong')
      },
      // Story 8.1: cron rải job thu số liệu bài (6 giờ) / trang (hằng ngày) cho mỗi trang đang kết nối.
      'analytics.post_metrics': async () => {
        const pages = await runPostMetricsCron({ db: dbHandle.db, jobs })
        logger.debug({ pages }, 'analytics.post_metrics')
      },
      'analytics.page_metrics': async () => {
        const pages = await runPageMetricsCron({ db: dbHandle.db, jobs })
        logger.debug({ pages }, 'analytics.page_metrics')
      },
      // Story 8.1: kéo insight một trang (hạng `background`). `RATE_LIMITED` → handler tự hoãn bằng job mới; chỉ lỗi tạm mức
      // trang ném để retry, lần cuối ghi `failed`.
      'analytics.collect_posts': async (job) => {
        const result = await handleCollectPostsJob(analyticsDeps, job as JobWithMetadata<unknown>)
        logger.debug({ jobId: job.id, result }, 'analytics.collect_posts')
      },
      'analytics.collect_page': async (job) => {
        const result = await handleCollectPageJob(analyticsDeps, job as JobWithMetadata<unknown>)
        logger.debug({ jobId: job.id, result }, 'analytics.collect_page')
      },
      // Story 6.3: xoá ảnh bài không gắn vào bài nào quá 7 ngày (dòng + file Cloudinary). Story 7.7: giữ ảnh sản phẩm của
      // chiến dịch còn tồn tại (`content` không biết bảng `campaigns` — ghép ở đây).
      'content.media_gc': async () => {
        const keep = await campaignProductImageIds(dbHandle.db)
        const result = await gcOrphanMedia({ db: dbHandle.db, media, keep, log: logger.child({ component: 'media_gc' }) })
        if (result.deleted > 0 || result.fileErrors > 0) logger.info(result, 'content: đã dọn ảnh bài không gắn bài')
      },
      // Story 6.4: đăng một target (FB feed/photos; IG, Threads container → publish). Chỉ lỗi tạm chắc chắn chưa tạo bài ném
      // lại (target đã về `scheduled`); không rõ Meta đã nhận → `PUBLISH_UNKNOWN`. `job.signal` chỉ huỷ bước chuẩn bị.
      'publish.target': async (job) => {
        const result = await handlePublishJob(
          { db: dbHandle.db, events, jobs, cipher, graph, threads, log: logger.child({ component: 'publish_target' }) },
          job as JobWithMetadata<unknown>,
        )
        logger.debug({ jobId: job.id, result }, 'publish.target')
      },
      // Story 6.4: enqueue lại target quá giờ mất job; target kẹt `publishing` → `PUBLISH_UNKNOWN`.
      'content.requeue': async () => {
        const result = await requeueTargets({ db: dbHandle.db, events, jobs })
        if (result.requeued > 0 || result.stuck > 0) logger.warn(result, 'content: vá lịch đăng')
      },
      // Story 4.7: tin kẹt `sending` quá 15 phút → `failed` `SEND_UNKNOWN`.
      'inbox.send_sweep': async () => {
        const swept = await sweepStuckSending({ db: dbHandle.db, events })
        if (swept > 0) logger.warn({ swept }, 'inbox: tin kẹt đang gửi → SEND_UNKNOWN')
      },
      // Story 9.2 (AD-22): luồng xoá dữ liệu hai giai đoạn. Mỗi module xoá bảng của mình theo lô rồi báo `privacy`; lỗi tạm ném
      // lại (lô rollback, lần sau xoá tiếp). Log chỉ id yêu cầu + số đếm.
      'autoreply.purge': async (job) => logPurge('autoreply.purge', job.id, await handleAutoreplyPurge({ db: dbHandle.db, events }, job.data)),
      'webhooks.purge': async (job) => logPurge('webhooks.purge', job.id, await handleWebhooksPurge({ db: dbHandle.db, events }, job.data)),
      'ai.purge': async (job) => logPurge('ai.purge', job.id, await handleAiPurge({ db: dbHandle.db, events }, job.data)),
      'content.purge': async (job) =>
        logPurge('content.purge', job.id, await handleContentPurge({ db: dbHandle.db, events, media, log: logger.child({ component: 'content_purge' }) }, job.data)),
      'connections.purge': async (job) => logPurge('connections.purge', job.id, await handleConnectionsPurge({ db: dbHandle.db, events }, job.data)),
      'inbox.purge': async (job) =>
        logPurge('inbox.purge', job.id, await handleInboxPurge({ db: dbHandle.db, events, media, log: logger.child({ component: 'inbox_purge' }) }, job.data)),
      'events.privacy': async (job) => {
        const result = await handlePrivacyEvent({ db: dbHandle.db, events }, job.data)
        if (result === 'completed') logger.info({ jobId: job.id }, 'privacy: yêu cầu xoá đã hoàn tất')
        else logger.debug({ jobId: job.id, result }, 'events.privacy')
      },
      'privacy.purge_resume': async () => {
        const result = await resumeStalledRequests({ db: dbHandle.db, events, log: logger.child({ component: 'privacy' }) })
        if (result.republished > 0 || result.skippedLegacy > 0 || result.closedReconnected > 0) logger.warn(result, 'privacy: phát lại yêu cầu xoá đang dở')
      },
      'privacy.removed_pages': async () => {
        const created = await sweepRemovedPages({ db: dbHandle.db, events, log: logger.child({ component: 'privacy' }) })
        if (created > 0) logger.info({ created }, 'privacy: yêu cầu xoá dữ liệu trang gỡ quá 30 ngày')
      },
      // Story 9.3 (AD-22): dọn theo hạn — mỗi module chủ bảng tự dọn; bước lỗi không chặn bước khác, cuối lượt ném (retry 1).
      'privacy.retention': async () => {
        const result = await runRetention({ db: dbHandle.db, log: logger.child({ component: 'retention' }) })
        logger.info(result, 'privacy: đã dọn dữ liệu theo hạn')
      },
      // Story 9.3 (AD-14): file Cloudinary không còn dòng nào tham chiếu (≥ 7 ngày tuổi, trần mỗi lượt, cầu dao).
      'privacy.orphan_files': async () => {
        const result = await sweepOrphanFiles({
          db: dbHandle.db,
          media,
          mode: resolveSweepMode(config),
          log: logger.child({ component: 'orphan_files' }),
        })
        // Log chỉ số đếm + prefix theo loại (`byKind`), không public_id đầy đủ — báo cáo dry_run để đối chiếu kho thật.
        if (result.tripped || result.fileErrors > 0 || result.storeErrors > 0) logger.warn(result, 'privacy: dọn file mồ côi chưa trọn')
        else if (result.mode === 'dry_run') logger.info(result, 'privacy: dọn file mồ côi (dry_run — chỉ đếm, không xoá)')
        else logger.info(result, 'privacy: đã dọn file mồ côi')
      },
      // Story 4.2: sức khoẻ webhook mỗi 5 phút; phát `webhook.stalled|recovered` khi đổi trạng thái.
      'webhooks.health': async () => {
        const results = await runHealthCheck({ db: dbHandle.db, events })
        for (const r of results) {
          if (r.emitted) logger.warn({ product: r.product, status: r.status, previous: r.previous }, `webhooks: ${r.emitted}`)
        }
      },
    },
    logger,
    QUEUES,
    { failures: { events, db: dbHandle.db } },
  )
  // Chạy bù (Story 4.2): trang đã kết nối trước khi có job đăng ký webhook (hoặc job bị mất) → enqueue một lần.
  // Lỗi ở đây không được làm chết worker — chỉ log; lần khởi động sau chạy lại.
  try {
    const enqueued = await enqueueMissingSubscriptions(dbHandle.db, jobs)
    if (enqueued > 0) logger.info({ enqueued }, 'connections: chạy bù đăng ký webhook trang')
  } catch (err) {
    logger.error({ err }, 'connections: chạy bù đăng ký webhook trang lỗi')
  }
  // Heartbeat ngay khi khởi động, rồi mỗi 30 giây (spec); cron 1 phút của pg-boss vẫn ghi song song.
  await writeHeartbeat(dbHandle.db, instanceId)
  heartbeatTimer = setInterval(() => {
    writeHeartbeat(dbHandle.db, instanceId).catch((err: unknown) => logger.error({ err }, 'ghi heartbeat lỗi'))
  }, HEARTBEAT_INTERVAL_MS)
  logger.info({ instanceId }, 'worker đã chạy')
} catch (err) {
  logger.fatal({ err }, 'worker không khởi động được')
  await shutdown('startup-failure', 1)
}
