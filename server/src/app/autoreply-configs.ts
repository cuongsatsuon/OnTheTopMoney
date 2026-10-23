// Cấu hình AI trả lời tự động (Story 5.1, AD-8). Mọi route dưới /api/v1 → guard auth đã yêu cầu phiên; ghi kiểm
// Origin (AD-19). Nghiệp vụ + kế thừa nằm ở `profiles`; route chỉ parse bằng schema shared rồi gọi service.
// Route tĩnh (`overview`, `script-template`, `bulk-enabled`) đứng cạnh route tham số `/:ownerType/:ownerId` — Fastify
// ưu tiên đoạn tĩnh nên không đụng nhau.
import {
  AutoreplyScriptTemplateRequest,
  BulkSetAutoreplyRequest,
  ConfigOwnerType,
  SaveAutoreplyConfigRequest,
  SetUseOwnRequest,
  type AutoreplyConfigDto,
  type AutoreplyConfigResponse,
  type AutoreplyOverviewResponse,
  type AutoreplyScriptTemplateResponse,
  type BulkSetAutoreplyResponse,
  type EffectiveAutoreplyConfigResponse,
} from '@ottm/shared'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import {
  autoreplyOverview,
  buildAutoreplyScript,
  bulkSetAutoreplyEnabled,
  getAutoreplyConfig,
  getEffectiveAutoreply,
  saveAutoreplyConfig,
  setAutoreplyUseOwn,
  type ProfileOwner,
} from '../modules/profiles/index.ts'
import type { Db } from '../platform/db/index.ts'

const OwnerParams = z.object({ ownerType: ConfigOwnerType, ownerId: z.uuid() })
const PageIdParams = z.object({ id: z.uuid() })

export function registerAutoreplyConfigs(app: FastifyInstance, deps: { db: Db }): void {
  const { db } = deps

  // Trạng thái AI mọi nhóm/trang: cây ở /ai-tra-loi, cột AI ở Trang & Nhóm (`Page.autoReply` dẫn xuất).
  app.get('/api/v1/autoreply-configs/overview', async (): Promise<AutoreplyOverviewResponse> => autoreplyOverview(db))

  // "Lấy từ Hồ sơ thương hiệu" / "Mẫu theo ngành" — template xác định, không gọi AI (AD-2).
  app.post('/api/v1/autoreply-configs/script-template', async (req): Promise<AutoreplyScriptTemplateResponse> => {
    return buildAutoreplyScript(db, AutoreplyScriptTemplateRequest.parse(req.body ?? {}))
  })

  // Bật/Tắt hàng loạt ở Bảng trang (FE đã xác nhận). Kết quả theo từng trang.
  app.post('/api/v1/autoreply-configs/bulk-enabled', async (req): Promise<BulkSetAutoreplyResponse> => {
    const { pageIds, enabled } = BulkSetAutoreplyRequest.parse(req.body ?? {})
    return bulkSetAutoreplyEnabled(db, pageIds, enabled)
  })

  // Cấu hình hiệu lực của trang (đã giải kế thừa). `effective=null` = CONFIG_MISSING.
  app.get('/api/v1/autoreply-configs/effective/page/:id', async (req): Promise<EffectiveAutoreplyConfigResponse> => {
    const { id } = PageIdParams.parse(req.params)
    return getEffectiveAutoreply(db, id)
  })

  // Bật/tắt "Dùng cấu hình AI riêng" (áp khi Lưu); tắt = xoá cấu hình riêng (FE đã hỏi lại).
  app.put('/api/v1/autoreply-configs/use-own/page/:id', async (req): Promise<EffectiveAutoreplyConfigResponse> => {
    const { id } = PageIdParams.parse(req.params)
    const { useOwn } = SetUseOwnRequest.parse(req.body ?? {})
    return setAutoreplyUseOwn(db, id, useOwn)
  })

  app.get('/api/v1/autoreply-configs/:ownerType/:ownerId', async (req): Promise<AutoreplyConfigResponse> => {
    const owner: ProfileOwner = OwnerParams.parse(req.params)
    return { config: await getAutoreplyConfig(db, owner) }
  })

  app.put('/api/v1/autoreply-configs/:ownerType/:ownerId', async (req): Promise<AutoreplyConfigDto> => {
    const owner: ProfileOwner = OwnerParams.parse(req.params)
    return saveAutoreplyConfig(db, owner, SaveAutoreplyConfigRequest.parse(req.body ?? {}))
  })
}
