// REST của trung tâm thông báo (Story 1.4). Mọi route dưới /api/v1 → guard auth đã yêu cầu phiên.
import {
  ListNotificationsQuery,
  MarkNotificationsReadRequest,
  NotificationPrefs,
  type ListNotificationsResponse,
  type MarkNotificationsReadResponse,
} from '@ottm/shared'
import type { FastifyInstance } from 'fastify'
import type { Db } from '../platform/db/index.ts'
import type { EventPublisher } from '../platform/events/index.ts'
import { listNotifications, markNotificationsRead } from '../modules/notifications/index.ts'
import { getNotificationPrefs, setNotificationPrefs } from '../modules/settings/index.ts'

export function registerNotifications(app: FastifyInstance, deps: { db: Db; events: EventPublisher }): void {
  const { db, events } = deps

  app.get('/api/v1/notifications', async (req): Promise<ListNotificationsResponse> => {
    const query = ListNotificationsQuery.parse(req.query ?? {})
    return listNotifications(db, query)
  })

  app.post('/api/v1/notifications/read', async (req): Promise<MarkNotificationsReadResponse> => {
    const body = MarkNotificationsReadRequest.parse(req.body ?? {})
    return { unreadCount: await markNotificationsRead(db, body) }
  })

  app.get('/api/v1/settings/notifications', async (): Promise<NotificationPrefs> => getNotificationPrefs(db))

  app.put('/api/v1/settings/notifications', async (req): Promise<NotificationPrefs> => {
    const prefs = NotificationPrefs.strict().parse(req.body ?? {})
    return setNotificationPrefs(db, events, prefs)
  })
}
