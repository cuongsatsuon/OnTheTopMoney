// Hộp thư `/hop-thu` (Story 4.3): danh sách hội thoại, khung chat, panel khách đọc API thật. Tin mới tới → hint
// realtime làm cũ `['conversations', …]` + `['messages', …]` → refetch (≤3 giây); mất kết nối → dải "Đang kết nối
// lại…" của AppShell, nối lại thì tải bù (lib/realtime.ts).
// Thao tác của story sau (Tiếp quản, Đánh dấu xong, bật AI — 4.6; gửi tin — 4.7; Gợi ý bằng AI — 4.8; sửa panel
// khách — 4.9) hiện nhưng khoá, có gợi ý "Sắp có": không giả lập thao tác trên khách thật.
import type { AttachmentDto, ConversationDto, MessageDto, Platform } from '@ottm/shared'
import { CheckCheck, FileText, Hand, MessageSquareText, Paperclip, Search, Sparkles, TriangleAlert, UserRound } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { Skeleton } from '../components/Skeleton'
import { Avatar, Button, Chip, Drawer, EmptyState, PageAvatar, PlatformIcon, Tabs, cn } from '../components/ui'
import { pages as pageStore, type Page } from '../data/mock'
import { useApp } from '../lib/app-context'
import { errorMessageOf } from '../lib/error-messages'
import {
  ATTACHMENT_ERROR_TEXT,
  CHANNEL_LABEL,
  REASON_TEXT,
  attachmentUrl,
  bubbleKind,
  contactLabel,
  countNeedsAttention,
  durationLabel,
  flattenMessages,
  listTimeLabel,
  matchesTab,
  messageTimeLabel,
  previewText,
  useConversation,
  useConversations,
  useMessages,
  type InboxTab,
} from '../lib/inbox'
import { WEBHOOK_PRODUCT_LABEL, WEBHOOK_SETTINGS_PATH, stalledProducts, useWebhookHealth } from '../lib/webhooks'

/** Gợi ý trên nút của story sau. */
const SOON = 'Sắp có — tạm thời trả lời khách trên Messenger/Instagram'

const STAGE_LABEL: Record<ConversationDto['contact']['stage'], string> = {
  new: 'Mới',
  consulting: 'Đang tư vấn',
  ordered: 'Chốt đơn',
  loyal: 'Khách quen',
  complaint: 'Khiếu nại',
}

const AVATAR_COLORS = ['#FDE68A', '#BFDBFE', '#FBCFE8', '#C7D2FE', '#A7F3D0', '#FED7AA', '#FECACA', '#DDD6FE']
/** Màu avatar ổn định theo id khách. */
function avatarColor(id: string): string {
  let h = 0
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return AVATAR_COLORS[h % AVATAR_COLORS.length]!
}

/** Trang trong kho (trang thật đã chép vào kho mẫu khi tải `/pages`); chưa tải xong → undefined. */
const findPage = (id: string): Page | undefined => pageStore.find((p) => p.id === id)

/** Đồng hồ cho nhãn "x phút" (cập nhật mỗi 30 giây). */
function useNow(intervalMs = 30_000): Date {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), intervalMs)
    return () => window.clearInterval(t)
  }, [intervalMs])
  return now
}

/* ---------- Màn hình ---------- */

export default function Inbox() {
  const { scope, scopeLabel } = useApp()
  const [params, setParams] = useSearchParams()
  const [tab, setTab] = useState<InboxTab>('all')
  const [query, setQuery] = useState('')
  const [panelOpen, setPanelOpen] = useState(false)
  const now = useNow()
  const rowRefs = useRef<Record<string, HTMLButtonElement | null>>({})

  const convs = useConversations(scope)
  const all = useMemo(() => convs.data?.pages.flatMap((p) => p.items) ?? [], [convs.data])
  const searched = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return all
    return all.filter((c) => {
      const page = findPage(c.pageId)
      return [contactLabel(c.contact, page?.platform), page?.name ?? '', previewText(c.preview)].some((s) => s.toLowerCase().includes(q))
    })
  }, [all, query])
  const list = useMemo(() => searched.filter((c) => matchesTab(c, tab)), [searched, tab])
  const needsCount = countNeedsAttention(all)

  const paramId = params.get('c')
  const inList = all.find((c) => c.id === paramId)
  const detail = useConversation(paramId && !inList ? paramId : null)
  const selected: ConversationDto | null = inList ?? detail.data ?? list[0] ?? null

  const select = useCallback((id: string) => setParams({ c: id }, { replace: true }), [setParams])

  useEffect(() => {
    if (selected) rowRefs.current[selected.id]?.scrollIntoView({ block: 'nearest' })
  }, [selected])

  // Phím tắt: ↑/↓ chuyển hội thoại (khi không gõ trong ô nhập).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null
      if (el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.isContentEditable)) return
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (document.querySelector('[role="dialog"]')) return
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
      if (!list.length) return
      e.preventDefault()
      const idx = selected ? list.findIndex((c) => c.id === selected.id) : -1
      const next = e.key === 'ArrowDown' ? Math.min(list.length - 1, idx + 1) : Math.max(0, idx === -1 ? 0 : idx - 1)
      select(list[next]!.id)
      rowRefs.current[list[next]!.id]?.focus()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [list, selected, select])

  const page = selected ? findPage(selected.pageId) : undefined
  const name = selected ? contactLabel(selected.contact, page?.platform) : ''
  const panel = selected ? <CustomerPanel conv={selected} name={name} onOpenConv={(id) => (select(id), setPanelOpen(false))} all={all} /> : null

  return (
    <div className="flex h-[calc(100vh-56px)] min-h-0 bg-surface">
      {/* ---- Danh sách hội thoại ---- */}
      <section className="flex w-[340px] shrink-0 flex-col border-r border-border" aria-label="Danh sách hội thoại">
        <div className="space-y-3 px-3 pt-4">
          <div className="flex items-baseline justify-between px-1">
            <h1 className="text-xl font-semibold">Hộp thư</h1>
            <span className="truncate pl-2 text-xs text-muted-foreground">{scopeLabel}</span>
          </div>
          <div className="relative">
            <Search size={16} className="absolute top-1/2 left-3 -translate-y-1/2 text-muted-foreground" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Tìm khách, trang, nội dung…"
              aria-label="Tìm hội thoại"
              className="h-9 w-full rounded-sm border border-border bg-background pr-3 pl-9 text-sm focus:border-primary focus:ring-2 focus:ring-primary/15 focus:outline-none"
            />
          </div>
        </div>
        <Tabs<InboxTab>
          className="mt-2 px-2 [&>button]:px-1.5 [&>button]:text-[13px]"
          value={tab}
          onChange={setTab}
          tabs={[
            { id: 'all', label: 'Tất cả' },
            { id: 'needs', label: 'Cần xử lý', count: needsCount },
            { id: 'ai', label: 'AI đang trả lời' },
            { id: 'done', label: 'Đã xong' },
          ]}
        />
        <WebhookStalledBanner />
        <div className="scrollbar-thin flex-1 overflow-y-auto" role="listbox" aria-label="Hội thoại">
          {convs.isPending ? (
            <ListSkeleton />
          ) : convs.isError && all.length === 0 ? (
            <EmptyState icon={<TriangleAlert size={22} />} title="Chưa tải được hội thoại" action={<Button size="sm" onClick={() => void convs.refetch()}>Thử lại</Button>}>
              {errorMessageOf(convs.error)}
            </EmptyState>
          ) : list.length === 0 ? (
            <EmptyState icon={<CheckCheck size={22} />} title={emptyTitle(tab, query, all.length)}>
              {query ? 'Thử từ khoá khác hoặc đổi tab.' : `Phạm vi: ${scopeLabel}`}
            </EmptyState>
          ) : (
            <>
              {list.map((c) => (
                <ConversationRow
                  key={c.id}
                  conv={c}
                  now={now}
                  active={selected?.id === c.id}
                  onClick={() => select(c.id)}
                  buttonRef={(el) => {
                    rowRefs.current[c.id] = el
                  }}
                />
              ))}
              {convs.hasNextPage && (
                <div className="p-3 text-center">
                  <Button size="sm" variant="ghost" onClick={() => void convs.fetchNextPage()} disabled={convs.isFetchingNextPage}>
                    {convs.isFetchingNextPage ? 'Đang tải…' : 'Xem thêm hội thoại'}
                  </Button>
                </div>
              )}
            </>
          )}
        </div>
        <div className="border-t border-border px-4 py-2 text-[11px] text-muted-foreground">
          <Kbd>↑</Kbd> <Kbd>↓</Kbd> chuyển hội thoại
        </div>
      </section>

      {/* ---- Khung chat ---- */}
      <section className="flex min-w-[480px] flex-1 flex-col bg-background" aria-label="Khung chat">
        {selected ? (
          <>
            <ChatHeader conv={selected} name={name} page={page} now={now} onOpenPanel={() => setPanelOpen(true)} />
            <ChatBody conv={selected} name={name} now={now} />
            <ComposerSoon />
          </>
        ) : (
          <div className="flex flex-1 items-center justify-center">
            <EmptyState icon={<MessageSquareText size={22} />} title="Chọn một hội thoại để bắt đầu">
              Tin nhắn Messenger và Instagram của mọi trang trong phạm vi đang chọn hiện ở cột bên trái.
            </EmptyState>
          </div>
        )}
      </section>

      {/* ---- Hồ sơ khách: cột cố định ≥1440px, ngăn kéo khi hẹp hơn ---- */}
      {panel && (
        <aside className="scrollbar-thin hidden w-[320px] shrink-0 overflow-y-auto border-l border-border min-[1440px]:block" aria-label="Hồ sơ khách hàng">
          {panel}
        </aside>
      )}
      <Drawer open={panelOpen && !!panel} onClose={() => setPanelOpen(false)} title="Hồ sơ khách hàng" width={360}>
        <div className="-m-5">{panel}</div>
      </Drawer>
    </div>
  )
}

function emptyTitle(tab: InboxTab, query: string, total: number): string {
  if (query) return 'Không có hội thoại khớp từ khoá'
  if (tab === 'needs') return 'Không còn tin nhắn cần xử lý. AI đang trông giúp bạn.'
  if (tab === 'done') return 'Chưa có hội thoại nào xong'
  if (tab === 'ai') return 'AI chưa trả lời hội thoại nào'
  return total === 0 ? 'Chưa có tin nhắn nào' : 'Không có hội thoại'
}

/* ---------- Thành phần con ---------- */

function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded border border-border bg-surface px-1 font-sans text-[10px]">{children}</kbd>
}

function ListSkeleton() {
  return (
    <div aria-busy="true" role="status">
      <span className="sr-only">Đang tải hội thoại…</span>
      {Array.from({ length: 6 }, (_, i) => (
        <div key={i} className="flex gap-3 border-b border-border px-4 py-3">
          <Skeleton className="size-10 rounded-full" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-3.5 w-32" />
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-3 w-48" />
          </div>
        </div>
      ))}
    </div>
  )
}

function CustomerAvatar({ name, id, platform, size = 40 }: { name: string; id: string; platform: Platform | undefined; size?: number }) {
  return (
    <span className="relative inline-flex shrink-0">
      <Avatar name={name} color={avatarColor(id)} size={size} />
      {platform && (
        <span className="absolute -right-0.5 -bottom-0.5 rounded-full bg-white p-px">
          <PlatformIcon platform={platform} size={Math.max(12, Math.round(size * 0.38))} />
        </span>
      )}
    </span>
  )
}

function StateChip({ conv, now }: { conv: ConversationDto; now: Date }) {
  const waiting = conv.waitingSince ? ` · chờ ${durationLabel(conv.waitingSince, now)}` : ''
  switch (conv.state) {
    case 'ai':
      return (
        <Chip tone="ai" icon={<Sparkles size={11} />}>
          AI đang trả lời
        </Chip>
      )
    case 'handoff':
      return (
        <Chip tone="warning" icon={<Hand size={11} />}>
          Chuyển cho bạn{waiting}
        </Chip>
      )
    case 'human':
      return <Chip tone={conv.needsAttention ? 'warning' : 'primary'}>{conv.needsAttention ? `Khách đang chờ${waiting}` : 'Bạn đang trả lời'}</Chip>
    case 'triage':
      return <Chip tone="neutral">Đang phân loại</Chip>
    case 'done':
      return <Chip tone="success">✓ Đã xong</Chip>
  }
}

function ConversationRow({ conv, now, active, onClick, buttonRef }: { conv: ConversationDto; now: Date; active: boolean; onClick: () => void; buttonRef: (el: HTMLButtonElement | null) => void }) {
  const page = findPage(conv.pageId)
  const name = contactLabel(conv.contact, page?.platform)
  return (
    <button
      ref={buttonRef}
      role="option"
      aria-selected={active}
      onClick={onClick}
      className={cn('relative flex w-full gap-3 border-b border-border px-4 py-3 text-left transition-colors', active ? 'bg-primary-soft/50' : 'hover:bg-slate-50')}
    >
      {active && <span className="absolute top-0 bottom-0 left-0 w-[3px] bg-primary" />}
      <CustomerAvatar name={name} id={conv.contact.id} platform={page?.platform} />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className={cn('truncate text-sm', conv.needsAttention ? 'font-semibold' : 'font-medium')}>{name}</span>
          <span className="ml-auto shrink-0 text-xs text-muted-foreground">{listTimeLabel(conv.lastMessageAt, now)}</span>
        </span>
        <span className="block truncate text-xs text-muted-foreground">
          {page ? `qua ${page.name} · ${CHANNEL_LABEL[page.platform]}` : 'Đang tải trang…'}
        </span>
        <span className={cn('mt-0.5 block truncate text-[13px]', conv.needsAttention ? 'text-foreground' : 'text-muted-foreground')}>{previewText(conv.preview)}</span>
        <span className="mt-1.5 block">
          <StateChip conv={conv} now={now} />
        </span>
      </span>
    </button>
  )
}

function ChatHeader({ conv, name, page, now, onOpenPanel }: { conv: ConversationDto; name: string; page: Page | undefined; now: Date; onOpenPanel: () => void }) {
  return (
    <div className="border-b border-border bg-surface">
      <div className="flex items-center gap-4 px-5 py-3">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-base font-semibold">{name}</h2>
          <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
            {page ? (
              <>
                qua <PageAvatar page={page} size={18} /> <span className="truncate font-medium text-foreground">{page.name}</span>
              </>
            ) : (
              'Đang tải trang…'
            )}
          </div>
        </div>
        <StateChip conv={conv} now={now} />
        {conv.state === 'ai' || conv.state === 'handoff' ? (
          <Button variant="primary" size="sm" icon={<Hand size={15} />} disabled title={SOON}>
            Tiếp quản
          </Button>
        ) : (
          conv.state !== 'done' && (
            <Button size="sm" icon={<CheckCheck size={15} />} disabled title={SOON}>
              Đánh dấu xong
            </Button>
          )
        )}
        <Button variant="ghost" size="sm" icon={<UserRound size={15} />} onClick={onOpenPanel} className="min-[1440px]:hidden">
          Hồ sơ khách
        </Button>
      </div>
      {conv.state === 'handoff' && conv.stateReason && (
        <div className="flex items-center gap-2 border-t border-amber-200 bg-warning-soft px-5 py-2 text-[13px] text-amber-900">
          <TriangleAlert size={15} className="shrink-0 text-warning" />
          <span>
            <b>AI chuyển cho bạn:</b> {REASON_TEXT[conv.stateReason]}
            {conv.waitingSince && <> · khách chờ {durationLabel(conv.waitingSince, now)}</>}
          </span>
        </div>
      )}
    </div>
  )
}

function ChatBody({ conv, name, now }: { conv: ConversationDto; name: string; now: Date }) {
  const messages = useMessages(conv.id)
  const items = useMemo(() => flattenMessages(messages.data?.pages), [messages.data])
  const endRef = useRef<HTMLDivElement>(null)
  const lastId = items.at(-1)?.id
  // Tin mới nhất đổi (mở hội thoại / tin mới tới) → cuộn xuống cuối; tải tin cũ hơn thì không.
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' })
  }, [conv.id, lastId])

  return (
    <div className="scrollbar-thin flex-1 overflow-y-auto px-6 py-5">
      <div className="mx-auto max-w-3xl space-y-3">
        {messages.isPending ? (
          <div aria-busy="true" role="status" className="space-y-3">
            <span className="sr-only">Đang tải tin nhắn…</span>
            <Skeleton className="h-10 w-2/5" />
            <Skeleton className="ml-auto h-10 w-1/3" />
            <Skeleton className="h-14 w-1/2" />
          </div>
        ) : messages.isError && items.length === 0 ? (
          <EmptyState icon={<TriangleAlert size={22} />} title="Chưa tải được tin nhắn" action={<Button size="sm" onClick={() => void messages.refetch()}>Thử lại</Button>}>
            {errorMessageOf(messages.error)}
          </EmptyState>
        ) : (
          <>
            {messages.hasNextPage && (
              <div className="text-center">
                <Button size="sm" variant="ghost" onClick={() => void messages.fetchNextPage()} disabled={messages.isFetchingNextPage}>
                  {messages.isFetchingNextPage ? 'Đang tải…' : 'Tải tin cũ hơn'}
                </Button>
              </div>
            )}
            {items.map((m) => (
              <Bubble key={m.id} msg={m} contactName={name} now={now} />
            ))}
          </>
        )}
        <div ref={endRef} />
      </div>
    </div>
  )
}

/**
 * Banner vàng khi webhook ngừng nhận tin (Story 4.2): có sản phẩm `stalled` → dẫn tới Cài đặt › Webhook. Hint
 * realtime `webhook.recovered` làm cũ `['webhooks', …]` → refetch → banner tự biến mất, không cần tải lại trang.
 */
function WebhookStalledBanner() {
  const health = useWebhookHealth()
  const stalled = stalledProducts(health.data)
  if (stalled.length === 0) return null
  return (
    <div role="status" className="mx-3 mt-2 flex items-center gap-2 rounded-md border border-amber-200 bg-warning-soft px-3 py-2 text-[13px] text-amber-900">
      <TriangleAlert size={15} className="shrink-0 text-warning" />
      <span>
        Chưa nhận tin mới 30 phút ({stalled.map((p) => WEBHOOK_PRODUCT_LABEL[p]).join(', ')}) —{' '}
        <Link to={WEBHOOK_SETTINGS_PATH} className="font-medium underline hover:text-amber-950">
          Kiểm tra webhook
        </Link>
      </span>
    </div>
  )
}

function Bubble({ msg, contactName, now }: { msg: MessageDto; contactName: string; now: Date }) {
  const time = messageTimeLabel(msg.platformTimestamp, now)
  const kind = bubbleKind(msg.origin)
  if (kind === 'system')
    return (
      <div className="flex justify-center py-1">
        <span className="inline-flex max-w-[80%] items-center gap-1.5 rounded-full border border-amber-200 bg-warning-soft px-3 py-1 text-xs text-amber-900">
          <Hand size={12} className="shrink-0" />
          {msg.reasonCode ? REASON_TEXT[msg.reasonCode] : 'Hội thoại đổi trạng thái'} · {time}
        </span>
      </div>
    )
  const content = (
    <>
      {msg.attachments.length > 0 && (
        <div className="space-y-1.5">
          {msg.attachments.map((a) => (
            <Attachment key={a.id} att={a} />
          ))}
        </div>
      )}
      {msg.text && <div className={cn('whitespace-pre-wrap', msg.attachments.length > 0 && 'mt-1.5')}>{msg.text}</div>}
      {!msg.text && msg.attachments.length === 0 && <div className="italic opacity-80">Tin nhắn không hiển thị được trong app</div>}
    </>
  )
  if (kind === 'customer')
    return (
      <div className="flex justify-start">
        <div className="max-w-[70%]">
          <div className="rounded-lg rounded-bl-sm bg-slate-100 px-3.5 py-2 text-sm">{content}</div>
          <div className="mt-1 text-[11px] text-muted-foreground">
            {contactName} · {time}
          </div>
        </div>
      </div>
    )
  const ai = kind === 'ai'
  return (
    <div className="flex justify-end">
      <div className="max-w-[70%]">
        <div className={cn('rounded-lg rounded-br-sm px-3.5 py-2 text-sm', ai ? 'border border-violet-200 bg-ai-soft text-foreground' : 'bg-primary text-primary-foreground')}>{content}</div>
        <div className="mt-1 flex items-center justify-end gap-1 text-[11px] text-muted-foreground">
          {ai ? (
            <span className="inline-flex items-center gap-1 font-medium text-ai">
              <Sparkles size={11} /> AI trả lời
            </span>
          ) : (
            <span className="font-medium">Bạn</span>
          )}
          · {time}
        </div>
      </div>
    </div>
  )
}

/** Đính kèm của khách: ảnh/voice/video hiện tại chỗ, file khác là link tải; đang tải / lỗi có câu rõ ràng. */
function Attachment({ att }: { att: AttachmentDto }) {
  if (att.status === 'pending')
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
        <Paperclip size={13} /> Đang tải tệp đính kèm…
      </span>
    )
  if (att.status === 'failed')
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
        <TriangleAlert size={13} className="text-warning" /> {att.errorCode ? ATTACHMENT_ERROR_TEXT[att.errorCode] : 'Không tải được tệp đính kèm'}
      </span>
    )
  const src = attachmentUrl(att.id)
  // MIME do server lưu quyết định cách hiển thị (voice IG có thể là `video/mp4`).
  const mime = att.mime ?? ''
  if (mime.startsWith('image/'))
    return (
      <a href={src} target="_blank" rel="noreferrer">
        <img src={src} alt="Ảnh khách gửi" loading="lazy" className="max-h-64 max-w-full rounded-md" />
      </a>
    )
  if (att.kind === 'audio' || mime.startsWith('audio/')) return <audio controls preload="none" src={src} className="w-64 max-w-full" aria-label="Tin nhắn thoại" />
  if (mime.startsWith('video/')) return <video controls preload="metadata" src={src} className="max-h-64 max-w-full rounded-md" aria-label="Video khách gửi" />
  return (
    <a href={src} className="inline-flex items-center gap-1.5 text-sm underline" download>
      <FileText size={14} /> Tệp đính kèm
    </a>
  )
}

/** Ô soạn tin (Story 4.7) — tạm thay bằng ghi chú. */
function ComposerSoon() {
  return (
    <div className="border-t border-border bg-surface px-5 py-3">
      <div className="flex items-center gap-3 rounded-md border border-dashed border-border px-3 py-3 text-[13px] text-muted-foreground">
        <MessageSquareText size={16} className="shrink-0" />
        <span className="flex-1">Gửi tin và “Gợi ý bằng AI” từ Hộp thư sắp có. Tạm thời trả lời khách trên Messenger/Instagram.</span>
      </div>
    </div>
  )
}

function CustomerPanel({ conv, name, all, onOpenConv }: { conv: ConversationDto; name: string; all: readonly ConversationDto[]; onOpenConv: (id: string) => void }) {
  const page = findPage(conv.pageId)
  const otherPages = conv.contact.pageIds.filter((id) => id !== conv.pageId)
  return (
    <div className="space-y-5 p-5">
      <div className="flex flex-col items-center text-center">
        <CustomerAvatar name={name} id={conv.contact.id} platform={page?.platform} size={64} />
        <div className="mt-2 text-base font-semibold">{name}</div>
        {page && <div className="mt-0.5 text-[13px] text-muted-foreground">Khách {CHANNEL_LABEL[page.platform]} của {page.name}</div>}
      </div>

      <div>
        <div className="mb-1.5 text-[13px] font-medium">Giai đoạn</div>
        <Chip tone="neutral">{STAGE_LABEL[conv.contact.stage]}</Chip>
      </div>

      <div>
        <div className="mb-2 text-[13px] font-medium">Hội thoại trên trang khác</div>
        {otherPages.length === 0 ? (
          <p className="text-xs text-muted-foreground">Khách chỉ nhắn trang này.</p>
        ) : (
          <ul className="space-y-1">
            {otherPages.map((pid) => {
              const other = findPage(pid)
              const otherConv = all.find((c) => c.contact.id === conv.contact.id && c.pageId === pid)
              const body = (
                <>
                  {other ? <PageAvatar page={other} size={24} /> : <span className="size-6 rounded-full bg-slate-200" />}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-medium">{other?.name ?? 'Trang đã gỡ'}</span>
                    {otherConv && <span className="block truncate text-xs text-muted-foreground">{previewText(otherConv.preview)}</span>}
                  </span>
                </>
              )
              return (
                <li key={pid}>
                  {otherConv ? (
                    <button onClick={() => onOpenConv(otherConv.id)} className="flex w-full items-center gap-2.5 rounded-md p-1.5 text-left hover:bg-slate-50">
                      {body}
                    </button>
                  ) : (
                    <div className="flex items-center gap-2.5 p-1.5">{body}</div>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </div>

      <p className="rounded-md bg-slate-50 p-3 text-xs text-muted-foreground">Thẻ, ghi chú, số điện thoại và tóm tắt bằng AI sắp có ở hồ sơ khách.</p>
    </div>
  )
}
