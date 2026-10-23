// Chiến dịch nuôi page (Story 7.1, AD-15). Route dưới /api/v1 → guard auth đã yêu cầu phiên; ghi kiểm Origin (AD-19).
// Nghiệp vụ ở `campaigns`; route parse + mở transaction (chiến dịch, chủ đề, trang đích cùng có hoặc cùng không).
// - `GET /campaigns/page-options`: trang chọn được làm đích (mất kết nối / thiếu hồ sơ → kèm lý do).
// - `POST /campaigns`: tạo nháp (wizard sang bước 4); `PUT /campaigns/:id`: thay toàn bộ cấu hình nháp;
// - `GET /campaigns/:id`: mở lại nháp ở wizard (`/chien-dich/tao?id=<id>`).
import { CampaignPageOptionsResponse, SaveCampaignRequest, type CampaignDto } from '@ottm/shared'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { createCampaignDraft, getCampaign, listPageOptions, updateCampaignDraft } from '../modules/campaigns/index.ts'
import type { Db } from '../platform/db/index.ts'
import { AppError } from '../platform/errors/index.ts'

const IdParams = z.object({ id: z.uuid() })

export interface CampaignsDeps {
  db: Db
  /** Đồng hồ (test cố định "hôm nay" khi kiểm ngày bắt đầu). */
  now?: () => Date
}

export function registerCampaigns(app: FastifyInstance, deps: CampaignsDeps): void {
  const { db } = deps
  const now = () => deps.now?.() ?? new Date()

  app.get('/api/v1/campaigns/page-options', async (): Promise<CampaignPageOptionsResponse> => ({ items: await listPageOptions(db) }))

  app.post('/api/v1/campaigns', async (req, reply): Promise<CampaignDto> => {
    const input = SaveCampaignRequest.parse(req.body ?? {})
    const campaign = await db.transaction((tx) => createCampaignDraft(tx, input, now()))
    return reply.code(201).send(campaign)
  })

  app.get('/api/v1/campaigns/:id', async (req): Promise<CampaignDto> => {
    const { id } = IdParams.parse(req.params)
    const campaign = await getCampaign(db, id)
    if (!campaign) throw new AppError('NOT_FOUND', 404, { message: 'Chiến dịch không tồn tại', details: { campaignId: id } })
    return campaign
  })

  app.put('/api/v1/campaigns/:id', async (req): Promise<CampaignDto> => {
    const { id } = IdParams.parse(req.params)
    const input = SaveCampaignRequest.parse(req.body ?? {})
    return db.transaction((tx) => updateCampaignDraft(tx, id, input, now()))
  })
}
