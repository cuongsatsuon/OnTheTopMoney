// Hộp thư `/hop-thu` (Story 4.3, 4.4): danh sách hội thoại (tin DM, bình luận FB/IG, trả lời Threads), khung chat, panel
// khách đọc API thật. Tin mới tới → hint
// realtime làm cũ `['conversations', …]` + `['messages', …]` → refetch (≤3 giây); mất kết nối → dải "Đang kết nối
// lại…" của AppShell, nối lại thì tải bù (lib/realtime.ts).
// Story 4.6: tab lọc + số "Cần xử lý" từ server; Tiếp quản (nút, công tắc "AI tự trả lời", phím `T`), bật lại AI,
// Đánh dấu xong; ghi chú "AI chuyển cho bạn" nêu lý do + thời gian khách chờ (UX-DR5).
// Story 4.7: ô soạn gửi tin thật (`⌘↵`; bình luận FB/IG chọn "Trả lời công khai" / "Nhắn riêng", Threads chỉ trả lời
// công khai), bong bóng hiện "Đang gửi…" / lỗi (icon đỏ + lý do theo mã + gợi ý) + "Gửi lại" — tin lỗi không mất.
// Story 4.8: "Gợi ý bằng AI" trong ô soạn — "AI đang viết…" + Dừng (huỷ request thật), bản nháp điền vào ô soạn (không
// gửi, có "Hoàn tác"), cụm vi phạm hậu kiểm được đánh dấu; nút khoá theo khoá OpenAI / hạn mức / hồ sơ / mã lỗi, ô soạn
// vẫn gõ tay và gửi được.
// Story 4.9: panel khách sửa được giai đoạn, thẻ, SĐT, ghi chú và "Tóm tắt bằng AI" (`ContactProfile`, API thật); liên
// kết tới hồ sơ + lịch sử ở `/khach-hang`; báo khi có gợi ý gộp khách.
// Story 5.4: AI tự trả lời — chip "AI đang trả lời" kèm chấm "đang gõ" và bong bóng "AI đang trả lời…" cuối khung chat
// theo `aiTyping` (UX-DR4); tin AI lỗi có "Gửi lại" (= bạn tiếp quản).
import {
  INBOX_TABS,
  type AiViolation,
  type AttachmentDto,
  type ConversationAction,
  type ConversationChannel,
  type ConversationDto,
  type InboxTab,
  type MessageDelivery,
  type MessageDto,
  type Platform,
} from '@ottm/shared'
import { CheckCheck, CircleAlert, FileText, Hand, Lock, MessageSquareText, Newspaper, Paperclip, RotateCw, Search, SendHorizontal, Sparkles, Square, TriangleAlert, Undo2, UserRound } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { AiLockHint } from '../components/AiLockHint'
import { ContactProfile } from '../components/ContactProfile'
import { Skeleton } from '../components/Skeleton'
import { Avatar, Button, Chip, Drawer, EmptyState, PageAvatar, PlatformIcon, Switch, Tabs, cn } from '../components/ui'
import { pages as pageStore, type Page } from '../data/mock'
import { useAiBudget } from '../lib/ai-budget'
import { useApp } from '../lib/app-context'
import { errorMessageOf } from '../lib/error-messages'
import {
  ATTACHMENT_ERROR_TEXT,
  CHANNEL_LABEL,
  INBOX_TAB_LABEL,
  REASON_TEXT,
  REMOVAL_TEXT,
  SEND_ERROR_TEXT,
  SEND_MODE_LABEL,
  aiSwitchAction,
  attachmentUrl,
  bubbleKind,
  canResend,
  channelLabel,
  composerLimit,
  composerModes,
  composerPlaceholder,
  contactLabel,
  conversationControls,
  durationLabel,
  flattenMessages,
  handoffNote,
  isSendRefusal,
  isSendShortcut,
  listTimeLabel,
  messageTimeLabel,
  outboundAuthorLabel,
  outboundStatusLabel,
  postLine,
  previewText,
  remainingViolations,
  resendTitle,
  sendErrorHint,
  senderLabel,
  suggestErrorMessage,
  suggestLock,
  suggestLockCodeOf,
  useConversation,
  useConversationAction,
  useConversations,
  useMessages,
  useNeedsHumanCount,
  useNow,
  useResendMessage,
  useSendMessage,
  useSuggestReply,
  type SuggestLockCode,
} from '../lib/inbox'
import { avatarColorOf, useContact } from '../lib/contacts'
import { markViolations, useEffectiveBrandProfile } from '../lib/profiles'
import { WEBHOOK_PRODUCT_LABEL, WEBHOOK_SETTINGS_PATH, stalledProducts, useWebhookHealth } from '../lib/webhooks'


/** Trang trong kho (trang thật đã chép vào kho mẫu khi tải `/pages`); chưa tải xong → undefined. */
const findPage = (id: string): Page | undefined => pageStore.find((p) => p.id === id)


/* ---------- Màn hình ---------- */

export default function Inbox() {
  const { scope, scopeLabel, notify } = useApp()
  const [params, setParams] = useSearchParams()
  const [tab, setTab] = useState<InboxTab>('all')
  const [query, setQuery] = useState('')
  const [panelOpen, setPanelOpen] = useState(false)
  const now = useNow()
  const rowRefs = useRef<Record<string, HTMLButtonElement | null>>({})

  // Server lọc theo tab (AD-9); ô tìm chỉ lọc trong các hội thoại đã tải của tab.
  const convs = useConversations(scope, tab)
  const all = useMemo(() => convs.data?.pages.flatMap((p) => p.items) ?? [], [convs.data])
  const list = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return all
    return all.filter((c) => {
      const page = findPage(c.pageId)
      return [contactLabel(c.contact, page?.platform), page?.name ?? '', previewText(c.preview)].some((s) => s.toLowerCase().includes(q))
    })
  }, [all, query])
  const needsCount = useNeedsHumanCount(scope)

  const paramId = params.get('c')
  const inList = all.find((c) => c.id === paramId)
  const detail = useConversation(paramId && !inList ? paramId : null)
  const selected: ConversationDto | null = inList ?? detail.data ?? list[0] ?? null

  const select = useCallback((id: string) => setParams({ c: id }, { replace: true }), [setParams])

  const { mutate: mutateAction, isPending: actionPending } = useConversationAction()
  // Ghim hội thoại vào `?c=` trước khi đổi trạng thái: hội thoại rời tab hiện tại (vd Tiếp quản ở tab "AI đang trả
  // lời") thì khung chat vẫn ở khách vừa thao tác, không nhảy sang `list[0]` là khách khác.
  const runAction = useCallback(
    (id: string, a: ConversationAction) => {
      if (paramId !== id) select(id)
      mutateAction({ id, action: a }, { onError: (err) => notify(errorMessageOf(err)) })
    },
    [mutateAction, notify, paramId, select],
  )

  useEffect(() => {
    if (selected) rowRefs.current[selected.id]?.scrollIntoView({ block: 'nearest' })
  }, [selected])

  // Phím tắt: ↑/↓ chuyển hội thoại, `T` tiếp quản (khi không gõ trong ô nhập, không có hộp thoại).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null
      if (el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.isContentEditable)) return
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (document.querySelector('[role="dialog"]')) return
      if (e.key === 't' || e.key === 'T') {
        if (!selected || actionPending || !conversationControls(selected.state).takeover) return
        e.preventDefault()
        runAction(selected.id, 'takeover')
        return
      }
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
  }, [list, selected, select, runAction, actionPending])

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
          tabs={INBOX_TABS.map((id) => ({ id, label: INBOX_TAB_LABEL[id], ...(id === 'needs_human' ? { count: needsCount } : {}) }))}
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
          <Kbd>↑</Kbd> <Kbd>↓</Kbd> chuyển hội thoại · <Kbd>T</Kbd> tiếp quản
        </div>
      </section>

      {/* ---- Khung chat ---- */}
      <section className="flex min-w-[480px] flex-1 flex-col bg-background" aria-label="Khung chat">
        {selected ? (
          <>
            <ChatHeader
              conv={selected}
              name={name}
              page={page}
              now={now}
              busy={actionPending}
              onAction={(a) => runAction(selected.id, a)}
              onOpenPanel={() => setPanelOpen(true)}
            />
            <ChatBody conv={selected} platform={page?.platform} now={now} />
            <Composer key={selected.id} conv={selected} platform={page?.platform} />
          </>
        ) : (
          <div className="flex flex-1 items-center justify-center">
            <EmptyState icon={<MessageSquareText size={22} />} title="Chọn một hội thoại để bắt đầu">
              Tin nhắn Messenger, Instagram, bình luận và trả lời Threads của mọi trang trong phạm vi đang chọn hiện ở cột bên trái.
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
  if (tab === 'needs_human') return 'Không còn tin nhắn cần xử lý. AI đang trông giúp bạn.'
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
      <Avatar name={name} color={avatarColorOf(id)} size={size} />
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
          {conv.aiTyping && <TypingDots />}
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

/** Chấm "đang gõ" của AI (UX-DR4) — lượt AI trả lời đang soạn câu (`conversation.aiTyping`). */
function TypingDots() {
  return (
    <span className="ml-1 inline-flex items-center gap-0.5" aria-label="đang gõ" role="status">
      {[0, 150, 300].map((delay) => (
        <span key={delay} className="size-1 animate-bounce rounded-full bg-current" style={{ animationDelay: `${delay}ms` }} />
      ))}
    </span>
  )
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
          {page ? `qua ${page.name} · ${channelLabel(page.platform, conv.channel)}` : 'Đang tải trang…'}
        </span>
        <span className={cn('mt-0.5 block truncate text-[13px]', conv.needsAttention ? 'text-foreground' : 'text-muted-foreground')}>{previewText(conv.preview)}</span>
        <span className="mt-1.5 block">
          <StateChip conv={conv} now={now} />
        </span>
      </span>
    </button>
  )
}

function ChatHeader({
  conv,
  name,
  page,
  now,
  busy,
  onAction,
  onOpenPanel,
}: {
  conv: ConversationDto
  name: string
  page: Page | undefined
  now: Date
  busy: boolean
  onAction: (action: ConversationAction) => void
  onOpenPanel: () => void
}) {
  const controls = conversationControls(conv.state)
  const note = handoffNote(conv, now)
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
        <span className="flex items-center gap-2 text-[13px] font-medium">
          <Switch
            ai
            label="AI tự trả lời"
            checked={controls.aiSwitch.checked}
            disabled={controls.aiSwitch.disabled || busy}
            title={controls.aiSwitch.checked ? 'Tắt: bạn tiếp quản hội thoại này' : 'Bật: AI tự trả lời hội thoại này'}
            onChange={(next) => onAction(aiSwitchAction(next))}
          />
          <span className="hidden xl:inline">AI tự trả lời</span>
        </span>
        {controls.takeover && (
          <Button variant="primary" size="sm" icon={<Hand size={15} />} disabled={busy} onClick={() => onAction('takeover')} title="Tiếp quản (phím T)">
            Tiếp quản
          </Button>
        )}
        {controls.markDone && (
          <Button size="sm" icon={<CheckCheck size={15} />} disabled={busy} onClick={() => onAction('done')}>
            Đánh dấu xong
          </Button>
        )}
        <Button variant="ghost" size="sm" icon={<UserRound size={15} />} onClick={onOpenPanel} className="min-[1440px]:hidden">
          Hồ sơ khách
        </Button>
      </div>
      {conv.post && (
        <div className="flex items-center gap-2 border-t border-border px-5 py-2 text-[13px] text-muted-foreground">
          <Newspaper size={15} className="shrink-0" />
          <span className="truncate" title={conv.post.text ?? undefined}>
            {postLine(conv.post, page?.platform)}
          </span>
        </div>
      )}
      {note && (
        <div className="flex items-center gap-2 border-t border-amber-200 bg-warning-soft px-5 py-2 text-[13px] text-amber-900">
          <TriangleAlert size={15} className="shrink-0 text-warning" />
          <span>
            <b>AI chuyển cho bạn:</b> {note}
          </span>
        </div>
      )}
    </div>
  )
}

function ChatBody({ conv, platform, now }: { conv: ConversationDto; platform: Platform | undefined; now: Date }) {
  const { notify } = useApp()
  const messages = useMessages(conv.id)
  const resend = useResendMessage()
  const onResend = useCallback(
    (messageId: string) =>
      resend.mutate(
        { messageId, conversationId: conv.id },
        // Bị từ chối lại → bong bóng đổi lý do (đã làm cũ tin); lỗi khác → toast.
        { onError: (err) => (isSendRefusal(err) ? undefined : notify(errorMessageOf(err))) },
      ),
    [resend, conv.id, notify],
  )
  const items = useMemo(() => flattenMessages(messages.data?.pages), [messages.data])
  const endRef = useRef<HTMLDivElement>(null)
  const lastId = items.at(-1)?.id
  // Tin mới nhất đổi (mở hội thoại / tin mới tới / AI bắt đầu gõ) → cuộn xuống cuối; tải tin cũ hơn thì không.
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' })
  }, [conv.id, lastId, conv.aiTyping])

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
              <Bubble
                key={m.id}
                msg={m}
                senderName={senderLabel(m, conv, platform)}
                now={now}
                channel={conv.channel}
                resending={resend.isPending && resend.variables?.messageId === m.id}
                onResend={onResend}
              />
            ))}
            {conv.aiTyping && (
              <div className="flex justify-end">
                <div className="inline-flex items-center gap-1.5 rounded-lg rounded-br-sm border border-violet-200 bg-ai-soft px-3.5 py-2 text-[13px] font-medium text-ai">
                  <Sparkles size={12} /> AI đang trả lời
                  <TypingDots />
                </div>
              </div>
            )}
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

function Bubble({
  msg,
  senderName,
  now,
  channel,
  resending,
  onResend,
}: {
  msg: MessageDto
  senderName: string
  now: Date
  channel: ConversationChannel
  resending: boolean
  onResend: (messageId: string) => void
}) {
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
      {msg.text && <div className={cn('whitespace-pre-wrap', msg.attachments.length > 0 && 'mt-1.5', msg.removal && 'line-through')}>{msg.text}</div>}
      {!msg.text && msg.attachments.length === 0 && <div className="italic opacity-80">Tin nhắn không hiển thị được trong app</div>}
    </>
  )
  if (kind === 'customer')
    return (
      <div className="flex justify-start">
        <div className="max-w-[70%]">
          <div className={cn('rounded-lg rounded-bl-sm bg-slate-100 px-3.5 py-2 text-sm', msg.removal && 'opacity-60')}>{content}</div>
          <div className="mt-1 text-[11px] text-muted-foreground">
            {senderName} · {time}
            {msg.editedAt && ' · Đã sửa'}
            {msg.removal && <span className="font-medium text-foreground"> · {REMOVAL_TEXT[msg.removal]}</span>}
          </div>
        </div>
      </div>
    )
  const ai = kind === 'ai'
  const failed = msg.status === 'failed'
  const status = outboundStatusLabel(msg.status)
  return (
    <div className="flex justify-end">
      <div className="max-w-[70%]">
        <div
          className={cn(
            'rounded-lg rounded-br-sm px-3.5 py-2 text-sm',
            ai ? 'border border-violet-200 bg-ai-soft text-foreground' : 'bg-primary text-primary-foreground',
            (failed || msg.status === 'pending' || msg.status === 'sending') && 'opacity-70',
          )}
        >
          {content}
        </div>
        <div className="mt-1 flex items-center justify-end gap-1 text-[11px] text-muted-foreground">
          {failed && <CircleAlert size={13} className="text-danger" aria-label="Gửi lỗi" />}
          {ai ? (
            <span className="inline-flex items-center gap-1 font-medium text-ai">
              <Sparkles size={11} /> AI trả lời
            </span>
          ) : (
            <span className="font-medium">{outboundAuthorLabel(msg.origin)}</span>
          )}
          {msg.delivery === 'private_reply' && (
            <span className="inline-flex items-center gap-0.5">
              · <Lock size={10} /> Nhắn riêng
            </span>
          )}
          · {time}
          {status && ` · ${status}`}
        </div>
        {failed && <SendFailure msg={msg} channel={channel} resending={resending} onResend={onResend} />}
      </div>
    </div>
  )
}

/** "Gửi tin lỗi" (EXPERIENCE.md › State Patterns): icon đỏ + lý do theo mã + gợi ý + "Gửi lại". Tin không mất. */
function SendFailure({ msg, channel, resending, onResend }: { msg: MessageDto; channel: ConversationChannel; resending: boolean; onResend: (messageId: string) => void }) {
  const code = msg.errorCode ?? 'SEND_FAILED'
  const hint = sendErrorHint(code, channel)
  return (
    <div role="alert" className="mt-1.5 rounded-md border border-red-200 bg-danger-soft px-3 py-2 text-xs text-danger-foreground">
      <div className="flex items-start gap-1.5">
        <CircleAlert size={14} className="mt-px shrink-0 text-danger" />
        <div className="min-w-0 flex-1">
          <div className="font-medium">{SEND_ERROR_TEXT[code]}</div>
          {hint && <div className="mt-0.5 text-red-900/80">{hint}</div>}
        </div>
        {canResend(msg) && (
          <Button
            size="sm"
            variant="ghost"
            className="-my-1 h-7 px-2 text-danger-foreground"
            icon={<RotateCw size={13} />}
            disabled={resending}
            title={resendTitle(msg.origin)}
            onClick={() => onResend(msg.id)}
          >
            {resending ? 'Đang gửi…' : 'Gửi lại'}
          </Button>
        )}
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

/**
 * Ô soạn tin (Story 4.7): DM gửi tin thường; bình luận FB/IG chọn "Trả lời công khai" / "Nhắn riêng"; Threads chỉ trả
 * lời công khai. `⌘↵`/`Ctrl+↵` gửi. Server từ chối gửi (quá 24 giờ, đã nhắn riêng…) → tin hiện thành bong bóng lỗi, ô soạn
 * xoá chữ như gửi thường; lỗi khác (mạng, phiên…) → toast, giữ chữ để gửi lại.
 * Story 4.8: "Gợi ý bằng AI" theo cách trả lời đang chọn — bản nháp thay chữ trong ô (giữ chữ cũ để "Hoàn tác"), không
 * gửi; cụm vi phạm còn trong chữ được đánh dấu bên dưới.
 */
function Composer({ conv, platform }: { conv: ConversationDto; platform: Platform | undefined }) {
  const { notify, aiLock, openAiKeyStatus } = useApp()
  const modes = composerModes(platform, conv.channel)
  const [picked, setPicked] = useState<MessageDelivery>(modes[0]!)
  const mode = modes.includes(picked) ? picked : modes[0]!
  const [text, setText] = useState('')
  const send = useSendMessage()
  const limit = composerLimit(platform, mode)
  const trimmed = text.trim()
  const tooLong = trimmed.length > limit
  const canSubmit = trimmed !== '' && !tooLong && !send.isPending

  // Gợi ý bằng AI (Story 4.8).
  const suggestM = useSuggestReply()
  const controller = useRef<AbortController | null>(null)
  const [writing, setWriting] = useState(false)
  // Bản nháp AI đang nằm trong ô soạn: chữ trước đó (để Hoàn tác) + cụm vi phạm server trả về.
  const [draft, setDraft] = useState<{ before: string; violations: AiViolation[] } | null>(null)
  const budgetState = useAiBudget().data?.state
  const configMissing = useEffectiveBrandProfile(conv.pageId).data?.effective === null
  // Mã khoá của lần gọi trước chỉ còn hiệu lực khi khoá OpenAI / hạn mức / hồ sơ chưa đổi (realtime làm cũ query) —
  // đổi rồi thì để trạng thái mới quyết định.
  const lockStamp = `${openAiKeyStatus}|${budgetState ?? ''}|${configMissing}`
  const [serverLock, setServerLock] = useState<{ code: SuggestLockCode; stamp: string } | null>(null)
  const serverCode = serverLock?.stamp === lockStamp ? serverLock.code : null
  useEffect(() => () => controller.current?.abort(), [])
  const lock = suggestLock({ key: aiLock, budgetBlocked: budgetState === 'blocked', configMissing, serverCode, pageId: conv.pageId })
  const violations = draft ? remainingViolations(text, draft.violations) : []
  const marks = violations.filter((v) => v.kind !== 'too_long')

  const suggest = () => {
    if (writing || lock.locked) return
    const ctrl = new AbortController()
    controller.current = ctrl
    setWriting(true)
    suggestM.mutate(
      { conversationId: conv.id, mode, signal: ctrl.signal },
      {
        onSuccess: (res) => {
          setDraft({ before: draft ? draft.before : text, violations: res.violations })
          setText(res.draft)
        },
        onError: (err) => {
          if (ctrl.signal.aborted) return // nút Dừng: giữ nguyên ô soạn
          // Thiếu/khoá hỏng, hết hạn mức, chưa có hồ sơ → khoá nút (tooltip); lỗi khác → chỉ toast, bấm lại được.
          const code = suggestLockCodeOf(err)
          setServerLock(code ? { code, stamp: lockStamp } : null)
          notify(suggestErrorMessage(err))
        },
        onSettled: () => {
          if (controller.current === ctrl) controller.current = null
          setWriting(false)
        },
      },
    )
  }
  const stop = () => {
    controller.current?.abort()
    setWriting(false)
  }
  const undo = () => {
    if (!draft) return
    setText(draft.before)
    setDraft(null)
  }

  const submit = () => {
    if (!canSubmit) return
    send.mutate(
      { conversationId: conv.id, text: trimmed, mode },
      {
        onSuccess: () => {
          setText('')
          setDraft(null)
        },
        onError: (err) => {
          if (isSendRefusal(err)) {
            setText('')
            setDraft(null)
          } else notify(errorMessageOf(err))
        },
      },
    )
  }

  return (
    <div className="border-t border-border bg-surface px-5 py-3">
      {modes.length > 1 && (
        <div role="radiogroup" aria-label="Cách trả lời" className="mb-2 inline-flex rounded-md border border-border bg-background p-0.5 text-[13px]">
          {modes.map((m) => (
            <button
              key={m}
              role="radio"
              aria-checked={mode === m}
              onClick={() => setPicked(m)}
              className={cn('inline-flex items-center gap-1 rounded px-2.5 py-1 font-medium transition-colors', mode === m ? 'bg-primary-soft text-primary' : 'text-muted-foreground hover:text-foreground')}
            >
              {m === 'private_reply' && <Lock size={12} />}
              {SEND_MODE_LABEL[m]}
            </button>
          ))}
        </div>
      )}
      <div className={cn('rounded-md border bg-background focus-within:ring-2', draft ? 'border-ai/40 focus-within:border-ai focus-within:ring-ai/15' : 'border-border focus-within:border-primary focus-within:ring-primary/15')}>
        {draft && (
          <div className="flex items-center gap-2 border-b border-ai/20 bg-ai-soft/50 px-3 py-1 text-[11px] font-medium text-ai">
            <Sparkles size={11} /> Bản nháp AI — sửa lại trước khi gửi
            <button type="button" onClick={undo} className="ml-auto inline-flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-ai/10">
              <Undo2 size={11} /> Hoàn tác
            </button>
          </div>
        )}
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (isSendShortcut({ key: e.key, metaKey: e.metaKey, ctrlKey: e.ctrlKey, isComposing: e.nativeEvent.isComposing })) {
              e.preventDefault()
              submit()
            }
          }}
          rows={3}
          placeholder={composerPlaceholder(mode)}
          aria-label="Soạn tin nhắn"
          className="block w-full resize-none bg-transparent px-3 py-2 text-sm focus:outline-none"
        />
        <div className="flex items-center gap-2 border-t border-border px-2 py-1.5">
          {writing ? (
            <span className="inline-flex items-center gap-2 px-1 text-[13px] font-medium text-ai" role="status">
              <span className="size-2 animate-pulse rounded-full bg-ai" />
              AI đang viết…
              <button type="button" onClick={stop} className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs hover:bg-ai/10">
                <Square size={11} /> Dừng
              </button>
            </span>
          ) : (
            <AiLockHint locked={lock.locked} hint={lock.hint} link={lock.link} align="start">
              <Button size="sm" variant="ai" disabled={lock.locked} onClick={suggest}>
                Gợi ý bằng AI
              </Button>
            </AiLockHint>
          )}
          <span className={cn('ml-auto text-[11px]', tooLong ? 'font-medium text-danger' : 'text-muted-foreground')}>
            {trimmed.length > limit * 0.8 ? `${trimmed.length}/${limit}` : <><Kbd>⌘</Kbd> <Kbd>↵</Kbd> gửi</>}
          </span>
          <Button size="sm" variant="primary" icon={<SendHorizontal size={14} />} disabled={!canSubmit} onClick={submit}>
            {send.isPending ? 'Đang gửi…' : mode === 'dm' ? 'Gửi' : SEND_MODE_LABEL[mode]}
          </Button>
        </div>
      </div>
      {violations.some((v) => v.kind === 'too_long') && (
        <p className="mt-2 rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-800" role="alert">
          Bản nháp quá dài — rút gọn bớt trước khi gửi.
        </p>
      )}
      {marks.length > 0 && (
        <div className="mt-2 rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-800" role="alert">
          <p className="font-medium">AI vẫn dùng cụm cần tránh — sửa lại trước khi gửi:</p>
          {/* Từ cấm (đỏ) và URL ngoài danh sách cho phép (cam); markViolations dùng chung với Viết thử (Story 3.4). */}
          <p className="mt-1 leading-relaxed break-words whitespace-pre-wrap text-amber-900">
            {markViolations(text, marks).map((seg, i) =>
              seg.kind === null ? (
                <span key={i}>{seg.text}</span>
              ) : (
                <mark key={i} className={cn('rounded px-0.5', seg.kind === 'banned_word' ? 'bg-red-200 text-red-900' : 'bg-orange-200 text-orange-900')}>
                  {seg.text}
                </mark>
              ),
            )}
          </p>
        </div>
      )}
    </div>
  )
}

function CustomerPanel({ conv, name, all, onOpenConv }: { conv: ConversationDto; name: string; all: readonly ConversationDto[]; onOpenConv: (id: string) => void }) {
  const page = findPage(conv.pageId)
  const contact = useContact(conv.contact.id)
  const otherPages = conv.contact.pageIds.filter((id) => id !== conv.pageId)
  const profileLink = `/khach-hang?id=${conv.contact.id}`
  return (
    <div className="space-y-5 p-5">
      <div className="flex flex-col items-center text-center">
        <CustomerAvatar name={name} id={conv.contact.id} platform={page?.platform} size={64} />
        <div className="mt-2 text-base font-semibold">{name}</div>
        {page && <div className="mt-0.5 text-[13px] text-muted-foreground">Khách {CHANNEL_LABEL[page.platform]} của {page.name}</div>}
        <Link to={profileLink} className="mt-1 text-[13px] font-medium text-primary hover:underline">
          Xem hồ sơ và lịch sử
        </Link>
      </div>

      {contact.data ? (
        <>
          {contact.data.mergeSuggestions.length > 0 && (
            <p className="rounded-md bg-amber-50 p-3 text-xs text-amber-900">
              Meta xác nhận khách này cũng là {contact.data.mergeSuggestions.length === 1 ? 'một khách khác' : `${contact.data.mergeSuggestions.length} khách khác`} trong danh sách.{' '}
              <Link to={profileLink} className="font-semibold underline">
                Gộp khách
              </Link>
            </p>
          )}
          <ContactProfile key={contact.data.id} contact={contact.data} />
        </>
      ) : contact.isError ? (
        <p className="rounded-md bg-slate-50 p-3 text-xs text-muted-foreground">Không tải được hồ sơ khách.</p>
      ) : (
        <div className="space-y-3" aria-label="Đang tải hồ sơ khách">
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-6 w-2/3" />
          <Skeleton className="h-20 w-full" />
        </div>
      )}

      <div>
        <div className="mb-2 text-[13px] font-medium">Hội thoại trên trang khác</div>
        {otherPages.length === 0 ? (
          <p className="text-xs text-muted-foreground">Khách chỉ nhắn trang này.</p>
        ) : (
          <ul className="space-y-1">
            {otherPages.map((pid) => {
              const other = findPage(pid)
              const otherConv = contact.data?.conversations.find((c) => c.pageId === pid) ?? all.find((c) => c.contact.id === conv.contact.id && c.pageId === pid)
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
    </div>
  )
}
