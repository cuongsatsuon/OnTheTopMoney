// Chiến dịch nuôi page (Story 7.1, AD-15). Route dưới /api/v1 → guard auth đã yêu cầu phiên; ghi kiểm Origin (AD-19).
// Nghiệp vụ ở `campaigns`; route parse + mở transaction (chiến dịch, chủ đề, trang đích cùng có hoặc cùng không).
// - `GET /campaigns/page-options`: trang chọn được làm đích (mất kết nối / thiếu hồ sơ → kèm lý do).
// - `POST /campaigns`: tạo nháp (wizard sang bước 4); `PUT /campaigns/:id`: thay toàn bộ cấu hình nháp;
// - `GET /campaigns/:id`: mở lại nháp ở wizard (`/chien-dich/tao?id=<id>`).
// - Story 7.2: lưu nháp đồng bộ 7 bài xem trước (slot `planned` + `held`) và enqueue `campaigns.preview` cùng
//   transaction; `GET /campaigns/:id/preview` đọc bài xem trước; `POST /campaigns/:id/slots/:targetId/transition` Sửa /
//   Xoá / Tạo lại (qua `content.transitionTarget` với `version` — cần `jobs` + `events`).
// - Story 7.3: `GET /campaigns?scope=` danh sách kèm tiến độ (read-model `read-models/campaigns.ts`, phạm vi giải bằng
//   `pages.resolveScope`); `POST /campaigns/:id/start` bắt đầu chiến dịch trong MỘT transaction (cần `jobs` + `events`:
//   "Tự đăng" enqueue `publish.target`, phát `campaign.started`). Bấm hai lần → 200 `alreadyStarted`.
// - Story 7.4: `GET /campaigns/pending-slots?scope=` hàng đợi "Bài chờ duyệt" (read-model `read-models/campaign-queue.ts`);
//   route hành động slot nhận thêm Duyệt / Từ chối cho chiến dịch đã bắt đầu (cùng endpoint cho hàng đợi và Lịch nội
//   dung) và trả `{slot}` thay vì cả danh sách xem trước.
import {
  CampaignListQuery,
  CampaignPageOptionsResponse,
  CampaignSlotActionRequest,
  PendingSlotsQuery,
  SaveCampaignRequest,
  StartCampaignRequest,
  type CampaignDto,
  type CampaignListResponse,
  type CampaignPreviewResponse,
  type CampaignSlotActionResponse,
  type PendingSlotsResponse,
  type StartCampaignResponse,
} from '@ottm/shared'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import {
  applySlotAction,
  createCampaignDraft,
  getCampaign,
  getPreview,
  listCampaigns,
  listPageOptions,
  startCampaign,
  syncPreviewSlots,
  updateCampaignDraft,
} from '../modules/campaigns/index.ts'
import { resolveScope } from '../modules/pages/index.ts'
import type { Db } from '../platform/db/index.ts'
import { AppError } from '../platform/errors/index.ts'
import type { EventPublisher } from '../platform/events/index.ts'
import type { JobSender } from '../platform/jobs/index.ts'
import { pendingQueue } from './read-models/campaign-queue.ts'
import { campaignSummaries } from './read-models/campaigns.ts'

const IdParams = z.object({ id: z.uuid() })
const SlotParams = z.object({ id: z.uuid(), targetId: z.uuid() })

export interface CampaignsDeps {
  db: Db
  /** Thiếu → lưu nháp vẫn dựng bài xem trước nhưng không enqueue `campaigns.preview`; thiếu cả `events` → không có route hành động slot. */
  jobs?: JobSender | undefined
  events?: EventPublisher | undefined
  /** Đồng hồ (test cố định "hôm nay" khi kiểm ngày bắt đầu). */
  now?: () => Date
}

export function registerCampaigns(app: FastifyInstance, deps: CampaignsDeps): void {
  const { db, jobs, events } = deps
  const now = () => deps.now?.() ?? new Date()
  const notFound = (id: string) => new AppError('NOT_FOUND', 404, { message: 'Chiến dịch không tồn tại', details: { campaignId: id } })

  app.get('/api/v1/campaigns/page-options', async (): Promise<CampaignPageOptionsResponse> => ({ items: await listPageOptions(db) }))

  app.get('/api/v1/campaigns', async (req): Promise<CampaignListResponse> => {
    const { scope } = CampaignListQuery.parse(req.query ?? {})
    // Không phạm vi / "tất cả" → mọi chiến dịch; nhóm / trang → giao `campaign_pages` (nhóm / trang lạ → 404).
    const pageIds = scope && scope.kind !== 'all' ? await resolveScope(db, scope) : null
    return { items: await campaignSummaries(db, await listCampaigns(db, pageIds), now()) }
  })

  app.get('/api/v1/campaigns/pending-slots', async (req): Promise<PendingSlotsResponse> => {
    const { scope } = PendingSlotsQuery.parse(req.query ?? {})
    // Luôn giải phạm vi (kể cả "Tất cả") để bỏ bài của trang đã gỡ — như Lịch nội dung.
    return pendingQueue(db, await resolveScope(db, scope ?? { kind: 'all' }))
  })

  app.post('/api/v1/campaigns', async (req, reply): Promise<CampaignDto> => {
    const input = SaveCampaignRequest.parse(req.body ?? {})
    const campaign = await db.transaction(async (tx) => {
      const saved = await createCampaignDraft(tx, input, now())
      await syncPreviewSlots(tx, saved, jobs)
      return saved
    })
    return reply.code(201).send(campaign)
  })

  app.get('/api/v1/campaigns/:id', async (req): Promise<CampaignDto> => {
    const { id } = IdParams.parse(req.params)
    const campaign = await getCampaign(db, id)
    if (!campaign) throw notFound(id)
    return campaign
  })

  app.get('/api/v1/campaigns/:id/preview', async (req): Promise<CampaignPreviewResponse> => {
    const { id } = IdParams.parse(req.params)
    const preview = await getPreview(db, id)
    if (!preview) throw notFound(id)
    return preview
  })

  if (jobs && events) {
    app.post('/api/v1/campaigns/:id/start', async (req): Promise<StartCampaignResponse> => {
      const { id } = IdParams.parse(req.params)
      const input = StartCampaignRequest.parse(req.body ?? {})
      const at = now()
      const result = await db.transaction((tx) => startCampaign(tx, { jobs, events, now: () => at }, id, input, at))
      const [campaign] = await campaignSummaries(db, [(await getCampaign(db, id))!], now())
      return { campaign: campaign!, alreadyStarted: result.alreadyStarted }
    })

    app.post('/api/v1/campaigns/:id/slots/:targetId/transition', async (req): Promise<CampaignSlotActionResponse> => {
      const { id, targetId } = SlotParams.parse(req.params)
      const input = CampaignSlotActionRequest.parse(req.body ?? {})
      const slot = await db.transaction((tx) => applySlotAction(tx, { jobs, events, ...(deps.now ? { now: deps.now } : {}) }, id, targetId, input))
      return { slot }
    })
  }

  app.put('/api/v1/campaigns/:id', async (req): Promise<CampaignDto> => {
    const { id } = IdParams.parse(req.params)
    const input = SaveCampaignRequest.parse(req.body ?? {})
    return db.transaction(async (tx) => {
      const saved = await updateCampaignDraft(tx, id, input, now())
      await syncPreviewSlots(tx, saved, jobs)
      return saved
    })
  })
}
