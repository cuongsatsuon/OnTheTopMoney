// Danh sách trang đã kết nối (Story 2.2). Dưới /api/v1 → guard auth đã yêu cầu phiên.
import type { ListPagesResponse } from '@ottm/shared'
import type { FastifyInstance } from 'fastify'
import { listPages } from '../modules/pages/index.ts'
import type { Db } from '../platform/db/index.ts'

export function registerPages(app: FastifyInstance, deps: { db: Db }): void {
  app.get('/api/v1/pages', async (): Promise<ListPagesResponse> => ({ items: await listPages(deps.db) }))
}
