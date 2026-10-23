// Màn chào 4 bước (Story 5.7, AD-18): `GET /api/v1/onboarding` — 4 cờ bước + tin AI đã gửi gần nhất. Dưới /api/v1 →
// guard auth đã yêu cầu phiên. Ghép ở `read-models/onboarding.ts`; route chỉ kiểm hợp đồng shared.
import { OnboardingStatusResponse } from '@ottm/shared'
import type { FastifyInstance } from 'fastify'
import type { AiDeps } from '../modules/ai/index.ts'
import { onboardingStatus } from './read-models/onboarding.ts'

export function registerOnboarding(app: FastifyInstance, deps: Pick<AiDeps, 'db' | 'cipher'>): void {
  app.get('/api/v1/onboarding', async (): Promise<OnboardingStatusResponse> => OnboardingStatusResponse.parse(await onboardingStatus(deps)))
}
