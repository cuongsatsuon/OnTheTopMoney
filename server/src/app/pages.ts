// Danh sách trang đã kết nối (Story 2.2), lọc theo phạm vi (Story 2.6). Dưới /api/v1 → guard auth đã yêu cầu phiên.
// Phạm vi giải qua `pages.resolveScope` (nguồn duy nhất): `scope=all|group:<id>|page:<id>`; cú pháp/uuid sai →
// VALIDATION_FAILED, nhóm/trang không tồn tại → 404.
import type { ListPagesResponse } from '@ottm/shared'
import { ScopeParam } from '@ottm/shared'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { listPages } from '../modules/pages/index.ts'
import type { Db } from '../platform/db/index.ts'

const PagesQuery = z.object({ scope: ScopeParam.optional() })

export function registerPages(app: FastifyInstance, deps: { db: Db }): void {
  app.get('/api/v1/pages', async (req): Promise<ListPagesResponse> => {
    const { scope } = PagesQuery.parse(req.query ?? {})
    return { items: await listPages(deps.db, scope) }
  })
}
