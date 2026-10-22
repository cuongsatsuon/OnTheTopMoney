// Kết nối Fanpage + Instagram Business (Story 2.2) và Threads (Story 2.3). Mọi route dưới /api/v1 → guard auth đã yêu cầu phiên;
// id phiên gắn với `state` OAuth và kết quả callback. Phản hồi không bao giờ chứa token (AD-5, AD-12).
import {
  ConfirmConnectionsRequest,
  StartConnectRequest,
  type ConfirmConnectionsResponse,
  type OAuthResultResponse,
  type StartConnectResponse,
} from '@ottm/shared'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import {
  confirmConnections,
  getOAuthResult,
  startFacebookOAuth,
  startThreadsOAuth,
  type ConnectionsDeps,
} from '../modules/connections/index.ts'
import { AppError } from '../platform/errors/index.ts'

const ResultParams = z.object({ id: z.string() })

function sessionIdOf(req: FastifyRequest): string {
  const id = req.ownerSession?.id
  if (!id) throw new AppError('UNAUTHENTICATED', 401, { message: 'Session required' })
  return id
}

export function registerConnections(app: FastifyInstance, deps: ConnectionsDeps): void {
  app.post('/api/v1/connections/facebook/start', async (req): Promise<StartConnectResponse> => {
    const { from, pageId } = StartConnectRequest.parse(req.body ?? {})
    return startFacebookOAuth(deps, { sessionId: sessionIdOf(req), from, pageId })
  })

  app.post('/api/v1/connections/threads/start', async (req): Promise<StartConnectResponse> => {
    const { from, pageId } = StartConnectRequest.parse(req.body ?? {})
    return startThreadsOAuth(deps, { sessionId: sessionIdOf(req), from, pageId })
  })

  app.get('/api/v1/connections/oauth-results/:id', async (req): Promise<OAuthResultResponse> => {
    const { id } = ResultParams.parse(req.params)
    // Id sai dạng: cùng phản hồi với id không tồn tại.
    if (!z.uuid().safeParse(id).success) throw new AppError('NOT_FOUND', 404, { message: 'Kết quả kết nối không tồn tại' })
    return getOAuthResult(deps, { sessionId: sessionIdOf(req), resultId: id })
  })

  app.post('/api/v1/connections/confirm', async (req): Promise<ConfirmConnectionsResponse> => {
    const request = ConfirmConnectionsRequest.parse(req.body ?? {})
    return confirmConnections(deps, { sessionId: sessionIdOf(req), request })
  })
}
