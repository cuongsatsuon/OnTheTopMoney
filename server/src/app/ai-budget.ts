// Hạn mức chi phí AI (Story 1.6). Mọi route dưới /api/v1 → guard auth đã yêu cầu phiên.
import type { AiBudgetSummary } from '@ottm/shared'
import type { FastifyInstance } from 'fastify'
import { getBudgetSummary } from '../modules/ai/index.ts'
import type { Db } from '../platform/db/index.ts'

export function registerAiBudget(app: FastifyInstance, deps: { db: Db; now?: () => Date }): void {
  app.get('/api/v1/ai/budget', async (): Promise<AiBudgetSummary> => getBudgetSummary(deps))
}
