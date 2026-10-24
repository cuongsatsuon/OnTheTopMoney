// Ngăn kéo thông báo mở từ chuông ở thanh trên (Story 1.4) [ASSUMPTION: EXPERIENCE.md chưa mô tả].
// Mở ngăn kéo = đã xem → đánh dấu đã đọc đúng các mục chưa đọc đang hiện (theo id, không `{all}` để
// không đánh dấu mục tới sau lần tải); mục mới tới trong lúc mở cũng được đánh dấu. Mục chưa đọc lúc
// thấy vẫn được làm nổi để dễ nhận ra. "Xem thêm" đi theo `nextCursor`.
import type { MarkNotificationsReadRequest, Notification } from '@ottm/shared'
import { AlertTriangle, Bell, BotMessageSquare, CalendarX, KeyRound, Megaphone, Unplug } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { errorMessageOf } from '../lib/error-messages'
import {
  fetchNotifications,
  markItemsRead,
  relativeTime,
  useMarkNotificationsRead,
  useNotifications,
} from '../lib/notifications'
import { Skeleton } from './Skeleton'
import { Button, Drawer, EmptyState, cn } from './ui'

const TYPE_ICON: Record<Notification['type'], ReactNode> = {
  ai_handoff: <BotMessageSquare size={16} />,
  token_expiring: <KeyRound size={16} />,
  publish_failed: <CalendarX size={16} />,
  campaign_paused: <Megaphone size={16} />,
  page_disconnected: <Unplug size={16} />,
  system_error: <AlertTriangle size={16} />,
}

/** Màn liên quan theo thực thể của thông báo; không có thì không điều hướng. */
const ENTITY_ROUTE: Record<string, string> = {
  conversation: '/hop-thu',
  page: '/trang-nhom',
  post_target: '/lich',
  campaign: '/chien-dich',
}

/** Giới hạn `ids` của `POST /notifications/read`. */
const MARK_READ_BATCH = 200

export function NotificationsDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const list = useNotifications()
  const markRead = useMarkNotificationsRead()
  const navigate = useNavigate()
  const [highlight, setHighlight] = useState<ReadonlySet<string>>(new Set())
  /** Id đã gửi đánh dấu đọc trong lần mở này. */
  const requested = useRef<Set<string>>(new Set())
  /** Các trang cũ hơn tải bằng "Xem thêm" (ngoài cache của trang đầu). */
  const [more, setMore] = useState<Notification[]>([])
  const [moreCursor, setMoreCursor] = useState<string | null | undefined>(undefined)
  const [loadingMore, setLoadingMore] = useState(false)
  const [moreError, setMoreError] = useState<unknown>(null)

  const unreadCount = list.data?.unreadCount ?? 0
  const items = useMemo(() => {
    const first = list.data?.items ?? []
    const ids = new Set(first.map((n) => n.id))
    return [...first, ...more.filter((n) => !ids.has(n.id))]
  }, [list.data, more])
  const nextCursor = moreCursor === undefined ? (list.data?.nextCursor ?? null) : moreCursor

  const { mutate } = markRead // ổn định giữa các lần render (TanStack Query)
  const mark = useCallback(
    (body: MarkNotificationsReadRequest) =>
      mutate(body, { onSuccess: () => setMore((m) => markItemsRead(m, body, new Date().toISOString())) }),
    [mutate],
  )

  // Đang mở: mọi mục chưa đọc đang hiện mà chưa gửi → làm nổi rồi đánh dấu đã đọc theo id.
  useEffect(() => {
    if (!open) return
    const fresh = items.filter((n) => n.readAt === null && !requested.current.has(n.id)).map((n) => n.id)
    if (fresh.length === 0) return
    for (const id of fresh) requested.current.add(id)
    setHighlight((h) => new Set([...h, ...fresh]))
    for (let i = 0; i < fresh.length; i += MARK_READ_BATCH) mark({ ids: fresh.slice(i, i + MARK_READ_BATCH) })
  }, [open, items, mark])

  const close = () => {
    requested.current = new Set()
    setHighlight(new Set())
    setMore([])
    setMoreCursor(undefined)
    setMoreError(null)
    onClose()
  }

  const loadMore = async () => {
    if (!nextCursor) return
    setLoadingMore(true)
    setMoreError(null)
    try {
      const page = await fetchNotifications({ cursor: nextCursor })
      setMore((m) => [...m, ...page.items])
      setMoreCursor(page.nextCursor)
    } catch (err) {
      setMoreError(err)
    } finally {
      setLoadingMore(false)
    }
  }

  const go = (n: Notification) => {
    const to = ENTITY_ROUTE[n.entity]
    if (!to) return
    close()
    navigate(to)
  }

  return (
    <Drawer
      open={open}
      onClose={close}
      title="Thông báo"
      footer={
        <Button
          variant="ghost"
          onClick={() => mark({ all: true })}
          disabled={unreadCount === 0 || markRead.isPending}
        >
          Đánh dấu đã đọc tất cả
        </Button>
      }
    >
      {list.isPending ? (
        <div className="space-y-3" aria-busy="true" role="status">
          <span className="sr-only">Đang tải thông báo…</span>
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="flex gap-3">
              <Skeleton className="size-8 rounded-full" />
              <div className="flex-1 space-y-1.5">
                <Skeleton className="h-4 w-3/4" />
                <Skeleton className="h-3 w-full" />
              </div>
            </div>
          ))}
        </div>
      ) : list.isError && !list.data ? (
        <div className="py-8 text-center" role="alert">
          <p className="text-sm">{errorMessageOf(list.error)}</p>
          <Button className="mt-4" onClick={() => void list.refetch()}>
            Thử lại
          </Button>
        </div>
      ) : list.data && list.data.items.length === 0 ? (
        <EmptyState icon={<Bell size={22} />} title="Chưa có thông báo">
          Khi AI chuyển hội thoại cho bạn, kết nối sắp hết hạn hay bài đăng lỗi, bạn sẽ thấy ở đây.
        </EmptyState>
      ) : (
        <>
          {markRead.isError && (
            <p className="mb-3 text-[13px] text-danger-foreground" role="alert">
              {errorMessageOf(markRead.error)}
            </p>
          )}
          <ul className="-mx-2 space-y-1">
            {items.map((n) => {
              const fresh = n.readAt === null || highlight.has(n.id)
              const clickable = Boolean(ENTITY_ROUTE[n.entity])
              const body = (
                <>
                  <span
                    className={cn(
                      'mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full',
                      n.type === 'system_error' || n.type === 'publish_failed' ? 'bg-danger-soft text-danger-foreground' : 'bg-primary-soft text-primary',
                    )}
                  >
                    {TYPE_ICON[n.type]}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-start gap-2">
                      <span className={cn('flex-1 text-sm', fresh ? 'font-semibold' : 'font-medium')}>{n.title}</span>
                      {fresh && <span className="sr-only">Mới</span>}
                      {fresh && <span aria-hidden className="mt-1.5 size-2 shrink-0 rounded-full bg-primary" />}
                    </span>
                    <span className="mt-0.5 block text-[13px] text-muted-foreground">{n.body}</span>
                    <span className="mt-1 block text-xs text-muted-foreground">{relativeTime(n.createdAt)}</span>
                  </span>
                </>
              )
              return (
                <li key={n.id}>
                  {clickable ? (
                    <button
                      type="button"
                      onClick={() => go(n)}
                      className={cn('flex w-full gap-3 rounded-md px-2 py-2.5 text-left hover:bg-slate-50', fresh && 'bg-primary-soft/30')}
                    >
                      {body}
                    </button>
                  ) : (
                    <div className={cn('flex gap-3 rounded-md px-2 py-2.5', fresh && 'bg-primary-soft/30')}>{body}</div>
                  )}
                </li>
              )
            })}
          </ul>
          {nextCursor && (
            <div className="mt-3 text-center">
              {moreError !== null && (
                <p className="mb-2 text-[13px] text-danger-foreground" role="alert">
                  {errorMessageOf(moreError)}
                </p>
              )}
              <Button variant="ghost" onClick={() => void loadMore()} disabled={loadingMore}>
                {loadingMore ? 'Đang tải…' : 'Xem thêm'}
              </Button>
            </div>
          )}
        </>
      )}
    </Drawer>
  )
}
