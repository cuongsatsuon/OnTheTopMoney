// Module `notifications` (AD-1): sở hữu `notifications`. Chỉ entrypoint (api, worker) gọi module này;
// module khác báo qua sự kiện. Phụ thuộc: chỉ module nền `settings`.
export const MODULE = 'notifications'

export {
  dedupeKey,
  draftFor,
  getNotification,
  handleEvent,
  listNotifications,
  markNotificationsRead,
  unreadCount,
  type HandleEventDeps,
  type HandleEventResult,
  type NotificationDraft,
} from './service.ts'
