// Tìm nhanh ⌘K (Story 4.10, AD-18): `GET /api/v1/search?q=` — trang, nhóm, khách khớp không dấu. Dưới /api/v1 → guard
// auth đã yêu cầu phiên. `q` rỗng / chỉ khoảng trắng / quá 100 ký tự → VALIDATION_FAILED. Ghép ở
// `read-models/search.ts`. Từ khoá có thể là SĐT: không log (`redactUrl` thay `q` khi log URL request).
import { SearchQuery, SearchResponse } from '@ottm/shared'
import type { FastifyInstance } from 'fastify'
import type { Db } from '../platform/db/index.ts'
import { searchAll } from './read-models/search.ts'

export function registerSearch(app: FastifyInstance, deps: { db: Db }): void {
  app.get('/api/v1/search', async (req): Promise<SearchResponse> => {
    const { q } = SearchQuery.parse(req.query ?? {})
    return SearchResponse.parse(await searchAll(deps.db, q))
  })
}
