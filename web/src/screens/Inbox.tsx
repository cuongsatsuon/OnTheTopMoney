import { CheckCheck, Hand, ImagePlus, MessageSquareText, Phone, Plus, Search, Send, Sparkles, Square, TriangleAlert, UserRound, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { AiLockHint } from '../components/AiLockHint'
import {
  Avatar,
  Button,
  Chip,
  Drawer,
  EmptyState,
  PageAvatar,
  PlatformIcon,
  Select,
  Switch,
  Tabs,
  Textarea,
  cn,
} from '../components/ui'
import {
  contactById,
  conversations as seedConversations,
  pageById,
  type Contact,
  type Conversation,
  type Message,
  type Stage,
} from '../data/mock'
import { useApp } from '../lib/app-context'
import { WEBHOOK_PRODUCT_LABEL, WEBHOOK_SETTINGS_PATH, stalledProducts, useWebhookHealth } from '../lib/webhooks'

/* ---------- Dữ liệu cục bộ ---------- */

type InboxTab = 'all' | 'needs' | 'ai' | 'done'

const STAGES: Stage[] = ['Mới', 'Đang tư vấn', 'Chốt đơn', 'Khách quen', 'Khiếu nại']

const QUICK_REPLIES = ['Dạ shop kiểm tra và báo lại ngay ạ', 'Cho shop xin SĐT và địa chỉ nhận hàng ạ', 'Dạ sản phẩm còn hàng ạ', 'Shop cảm ơn bạn nhiều ạ 💕']

/** Câu gợi ý "Gợi ý bằng AI" theo từng hội thoại mẫu. */
const AI_SUGGESTIONS: Record<string, string> = {
  cv1: 'Dạ chị Hà ơi, serum Vitamin C 30ml giá 450.000đ ạ. Tuần này shop tặng kèm mini kem chống nắng cho đơn từ 400k. Chị cho shop xin SĐT và địa chỉ để lên đơn luôn nha!',
  cv2: 'Dạ shop xin lỗi anh Long vì nồi bị lỗi nút nguồn ạ. Anh gửi giúp shop ảnh hoặc video lỗi kèm mã đơn, shop sẽ đổi nồi mới và cho shipper qua lấy máy cũ miễn phí trong 1–2 ngày ạ.',
  cv3: 'Dạ shop cảm ơn chị Giang ạ! Chị xác nhận giúp shop địa chỉ nhận hàng như lần trước nha, shop gửi 2 hộp kem chống nắng kèm freeship ạ.',
  cv4: 'Dạ shop có giao Đà Nẵng anh nhé. Phí ship 30.000đ, nhận hàng sau 2–3 ngày ạ. Anh nhắn shop địa chỉ để shop báo phí chính xác nha.',
  cv5: 'Dạ shop cảm ơn chị Châu nhiều ạ 💕 Lần tới chị ghé, shop gửi tặng chị voucher 10% dành cho khách thân thiết nha!',
  cv6: 'Dạ áo len BST thu còn size M ạ. Bạn cho shop xin chiều cao và cân nặng để shop tư vấn size chuẩn nhất nha.',
  cv7: 'Dạ nhà mình 4 người thì nồi 7L là vừa đẹp ạ, nướng được gà nguyên con 1,5kg. Cuối tuần này shop giảm 20%, anh muốn shop giữ hàng không ạ?',
}
const FALLBACK_SUGGESTION = 'Dạ shop cảm ơn bạn đã nhắn tin ạ. Shop kiểm tra và phản hồi bạn ngay nhé!'

/** Lịch sử ngắn của khách trên các trang khác (không có hội thoại mở). */
const OTHER_PAGE_HISTORY: Record<string, string> = {
  'c1:p2': 'Hỏi kem chống nắng nâng tông · 3 ngày trước',
  'c5:p1': 'Mua combo dưỡng da 3 bước · 2 tuần trước',
  'c7:p4': 'Hỏi thời gian bảo hành · 5 ngày trước',
}

const nowTime = () => new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })

const lastRealMessage = (c: Conversation) => [...c.messages].reverse().find((m) => m.from !== 'system')

/** Cần bạn xử lý: AI đã chuyển cho bạn, hoặc bạn đã tiếp quản mà khách đang chờ trả lời. */
const needsYou = (c: Conversation) => c.state === 'handoff' || (c.state === 'human' && lastRealMessage(c)?.from === 'customer')

const matchesTab = (c: Conversation, tab: InboxTab) =>
  tab === 'all' ? true : tab === 'needs' ? needsYou(c) : tab === 'ai' ? c.state === 'ai' : c.state === 'done'

type ContactEdit = Pick<Contact, 'stage' | 'tags' | 'note'>

/* ---------- Màn hình ---------- */

export default function Inbox() {
  const { inScope, notify, openAiKeySet, scopeLabel } = useApp()
  const [params, setParams] = useSearchParams()
  const [convs, setConvs] = useState<Conversation[]>(() => seedConversations.map((c) => ({ ...c, messages: [...c.messages] })))
  const [tab, setTab] = useState<InboxTab>('all')
  const [query, setQuery] = useState('')
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [attachments, setAttachments] = useState<Record<string, string>>({})
  const [aiWriting, setAiWriting] = useState<string | null>(null)
  const [aiTyping, setAiTyping] = useState<string | null>(null)
  const [contactEdits, setContactEdits] = useState<Record<string, ContactEdit>>({})
  const [panelOpen, setPanelOpen] = useState(false)

  const writeTimer = useRef<number | null>(null)
  const typingTimer = useRef<number | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const rowRefs = useRef<Record<string, HTMLButtonElement | null>>({})
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(
    () => () => {
      if (writeTimer.current) window.clearTimeout(writeTimer.current)
      if (typingTimer.current) window.clearTimeout(typingTimer.current)
    },
    [],
  )

  const scoped = useMemo(() => convs.filter((c) => inScope([c.pageId])), [convs, inScope])
  const searched = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return scoped
    return scoped.filter((c) => {
      const contact = contactById(c.customerId)
      return [contact.name, contact.phone, pageById(c.pageId).name, c.lastMessage].some((s) => s.toLowerCase().includes(q))
    })
  }, [scoped, query])
  const list = useMemo(() => searched.filter((c) => matchesTab(c, tab)), [searched, tab])
  const needsCount = scoped.filter(needsYou).length

  const paramId = params.get('c')
  const selected = convs.find((c) => c.id === paramId) ?? list[0] ?? null

  const select = useCallback(
    (id: string) => {
      setParams({ c: id }, { replace: true })
      setConvs((cs) => cs.map((c) => (c.id === id && c.unread ? { ...c, unread: false } : c)))
    },
    [setParams],
  )

  // Mở bằng ?c= thì đánh dấu đã đọc.
  useEffect(() => {
    if (!selected?.unread) return
    setConvs((cs) => cs.map((c) => (c.id === selected.id ? { ...c, unread: false } : c)))
  }, [selected?.id, selected?.unread])

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' })
  }, [selected?.id, selected?.messages.length, aiTyping])

  useEffect(() => {
    if (selected) rowRefs.current[selected.id]?.scrollIntoView({ block: 'nearest' })
  }, [selected])

  const update = useCallback((id: string, patch: (c: Conversation) => Partial<Conversation>) => {
    setConvs((cs) => cs.map((c) => (c.id === id ? { ...c, ...patch(c) } : c)))
  }, [])

  const takeOver = useCallback(
    (conv: Conversation) => {
      if (!conv.aiEnabled && conv.state === 'human') return
      if (aiTyping === conv.id && typingTimer.current) {
        window.clearTimeout(typingTimer.current)
        setAiTyping(null)
      }
      update(conv.id, () => ({ aiEnabled: false, state: 'human', waiting: undefined }))
      notify(`Bạn đã tiếp quản hội thoại với ${contactById(conv.customerId).name}. AI tạm dừng ở hội thoại này.`)
      setTimeout(() => textareaRef.current?.focus(), 0)
    },
    [aiTyping, notify, update],
  )

  const setAi = (conv: Conversation, on: boolean) => {
    if (!on) return takeOver(conv)
    if (!openAiKeySet) {
      notify('Thêm khoá OpenAI ở Cài đặt để bật AI trả lời.')
      return
    }
    update(conv.id, () => ({ aiEnabled: true, state: 'ai', waiting: undefined, handoffReason: undefined }))
    notify('Đã bật lại AI cho hội thoại này.')
    // Khách đang chờ → AI trả lời sau vài giây (chấm "đang gõ").
    if (lastRealMessage(conv)?.from === 'customer') {
      setAiTyping(conv.id)
      typingTimer.current = window.setTimeout(() => {
        const text = AI_SUGGESTIONS[conv.id] ?? FALLBACK_SUGGESTION
        update(conv.id, (c) => ({
          messages: [...c.messages, { id: `ai-${Date.now()}`, from: 'ai', text, time: nowTime() }],
          lastMessage: text,
          time: 'Vừa xong',
        }))
        setAiTyping(null)
      }, 1800)
    }
  }

  const markDone = (conv: Conversation) => {
    update(conv.id, () => ({ state: 'done', waiting: undefined }))
    notify('Đã chuyển hội thoại sang "Đã xong".')
  }

  const suggest = (conv: Conversation) => {
    setAiWriting(conv.id)
    writeTimer.current = window.setTimeout(() => {
      setDrafts((d) => ({ ...d, [conv.id]: AI_SUGGESTIONS[conv.id] ?? FALLBACK_SUGGESTION }))
      setAiWriting(null)
    }, 1400)
  }
  const stopSuggest = () => {
    if (writeTimer.current) window.clearTimeout(writeTimer.current)
    setAiWriting(null)
  }

  const send = (conv: Conversation) => {
    const text = (drafts[conv.id] ?? '').trim()
    const file = attachments[conv.id]
    if (!text && !file) return
    const msgs: Message[] = []
    if (file) msgs.push({ id: `img-${Date.now()}`, from: 'human', text: `📷 Ảnh: ${file}`, time: nowTime() })
    if (text) msgs.push({ id: `h-${Date.now()}`, from: 'human', text, time: nowTime() })
    update(conv.id, (c) => ({
      messages: [...c.messages, ...msgs],
      lastMessage: text || `Ảnh: ${file}`,
      time: 'Vừa xong',
      state: c.state === 'handoff' ? 'human' : c.state === 'done' ? 'human' : c.state,
      waiting: undefined,
    }))
    setDrafts((d) => ({ ...d, [conv.id]: '' }))
    setAttachments((a) => {
      const next = { ...a }
      delete next[conv.id]
      return next
    })
  }

  // Phím tắt: ↑/↓ chuyển hội thoại, T tiếp quản (khi không gõ trong ô nhập).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null
      if (el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.isContentEditable)) return
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (document.querySelector('[role="dialog"]')) return
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        if (!list.length) return
        e.preventDefault()
        const idx = selected ? list.findIndex((c) => c.id === selected.id) : -1
        const next = e.key === 'ArrowDown' ? Math.min(list.length - 1, idx + 1) : Math.max(0, idx === -1 ? 0 : idx - 1)
        select(list[next].id)
        rowRefs.current[list[next].id]?.focus()
      } else if ((e.key === 't' || e.key === 'T') && selected) {
        e.preventDefault()
        takeOver(selected)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [list, selected, select, takeOver])

  const contact = selected ? contactById(selected.customerId) : null
  const edit: ContactEdit | null = contact ? (contactEdits[contact.id] ?? { stage: contact.stage, tags: contact.tags, note: contact.note }) : null
  const setEdit = (patch: Partial<ContactEdit>) => {
    if (!contact || !edit) return
    setContactEdits((m) => ({ ...m, [contact.id]: { ...edit, ...patch } }))
  }

  const panel =
    selected && contact && edit ? (
      <CustomerPanel
        conv={selected}
        contact={contact}
        edit={edit}
        onEdit={setEdit}
        allConvs={convs}
        onOpenConv={(id) => {
          select(id)
          setPanelOpen(false)
        }}
      />
    ) : null

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
              placeholder="Tìm khách, số điện thoại, trang…"
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
          {list.length === 0 ? (
            <EmptyState
              icon={<CheckCheck size={22} />}
              title={query ? 'Không có hội thoại khớp từ khoá' : tab === 'done' ? 'Chưa có hội thoại nào xong' : tab === 'ai' ? 'AI chưa trả lời hội thoại nào' : 'Không còn tin nhắn cần xử lý. AI đang trông giúp bạn.'}
            >
              {query ? 'Thử từ khoá khác hoặc đổi tab.' : `Phạm vi: ${scopeLabel}`}
            </EmptyState>
          ) : (
            list.map((c) => (
              <ConversationRow
                key={c.id}
                conv={c}
                active={selected?.id === c.id}
                onClick={() => select(c.id)}
                buttonRef={(el) => {
                  rowRefs.current[c.id] = el
                }}
              />
            ))
          )}
        </div>
        <div className="border-t border-border px-4 py-2 text-[11px] text-muted-foreground">
          <Kbd>↑</Kbd> <Kbd>↓</Kbd> chuyển hội thoại · <Kbd>T</Kbd> tiếp quản · <Kbd>⌘↵</Kbd> gửi
        </div>
      </section>

      {/* ---- Khung chat ---- */}
      <section className="flex min-w-[480px] flex-1 flex-col bg-background" aria-label="Khung chat">
        {selected && contact ? (
          <>
            <ChatHeader
              conv={selected}
              contactName={contact.name}
              onToggleAi={(v) => setAi(selected, v)}
              onTakeOver={() => takeOver(selected)}
              onDone={() => markDone(selected)}
              onOpenPanel={() => setPanelOpen(true)}
              aiLocked={!openAiKeySet}
            />
            <div className="scrollbar-thin flex-1 overflow-y-auto px-6 py-5">
              <div className="mx-auto max-w-3xl space-y-3">
                {pageById(selected.pageId).platform === 'threads' && (
                  <p className="text-center text-xs text-muted-foreground">
                    Trang Threads chỉ nhận trả lời dưới bài đăng. Tin bạn gửi sẽ hiện công khai.
                  </p>
                )}
                {selected.messages.map((m) => (
                  <Bubble key={m.id} msg={m} contactName={contact.name} />
                ))}
                {aiTyping === selected.id && <TypingDots />}
                <div ref={endRef} />
              </div>
            </div>
            <Composer
              value={drafts[selected.id] ?? ''}
              onChange={(v) => setDrafts((d) => ({ ...d, [selected.id]: v }))}
              onSend={() => send(selected)}
              onSuggest={() => suggest(selected)}
              onStop={stopSuggest}
              writing={aiWriting === selected.id}
              aiLocked={!openAiKeySet}
              aiOn={selected.aiEnabled}
              textareaRef={textareaRef}
              attachment={attachments[selected.id]}
              onAttach={() => fileRef.current?.click()}
              onRemoveAttachment={() =>
                setAttachments((a) => {
                  const next = { ...a }
                  delete next[selected.id]
                  return next
                })
              }
            />
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) setAttachments((a) => ({ ...a, [selected.id]: f.name }))
                e.target.value = ''
              }}
            />
          </>
        ) : (
          <div className="flex flex-1 items-center justify-center">
            <EmptyState icon={<MessageSquareText size={22} />} title="Chọn một hội thoại để bắt đầu">
              Tin nhắn từ mọi trang trong phạm vi đang chọn hiện ở cột bên trái.
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

/* ---------- Thành phần con ---------- */

function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded border border-border bg-surface px-1 font-sans text-[10px]">{children}</kbd>
}

function CustomerAvatar({ name, color, pageId, size = 40 }: { name: string; color: string; pageId: string; size?: number }) {
  return (
    <span className="relative inline-flex shrink-0">
      <Avatar name={name} color={color} size={size} />
      <span className="absolute -right-0.5 -bottom-0.5 rounded-full bg-white p-px">
        <PlatformIcon platform={pageById(pageId).platform} size={Math.max(12, Math.round(size * 0.38))} />
      </span>
    </span>
  )
}

function StateChip({ conv }: { conv: Conversation }) {
  if (conv.state === 'ai')
    return (
      <Chip tone="ai" icon={<Sparkles size={11} />}>
        AI đang trả lời
      </Chip>
    )
  if (conv.state === 'handoff')
    return (
      <Chip tone="warning" icon={<Hand size={11} />}>
        Chuyển cho bạn{conv.waiting ? ` · chờ ${conv.waiting}` : ''}
      </Chip>
    )
  if (conv.state === 'human') return <Chip tone="primary">Bạn đang trả lời</Chip>
  return <Chip tone="success">✓ Đã xong</Chip>
}

function ConversationRow({ conv, active, onClick, buttonRef }: { conv: Conversation; active: boolean; onClick: () => void; buttonRef: (el: HTMLButtonElement | null) => void }) {
  const contact = contactById(conv.customerId)
  const page = pageById(conv.pageId)
  return (
    <button
      ref={buttonRef}
      role="option"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        'relative flex w-full gap-3 border-b border-border px-4 py-3 text-left transition-colors',
        active ? 'bg-primary-soft/50' : 'hover:bg-slate-50',
      )}
    >
      {active && <span className="absolute top-0 bottom-0 left-0 w-[3px] bg-primary" />}
      <CustomerAvatar name={contact.name} color={contact.avatarColor} pageId={conv.pageId} />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className={cn('truncate text-sm', conv.unread ? 'font-semibold' : 'font-medium')}>{contact.name}</span>
          <span className="ml-auto shrink-0 text-xs text-muted-foreground">{conv.time}</span>
        </span>
        <span className="block truncate text-xs text-muted-foreground">qua {page.name}</span>
        <span className="mt-0.5 flex items-center gap-2">
          <span className={cn('truncate text-[13px]', conv.unread ? 'text-foreground' : 'text-muted-foreground')}>{conv.lastMessage}</span>
          {conv.unread && <span className="ml-auto size-2 shrink-0 rounded-full bg-primary" aria-label="Chưa đọc" />}
        </span>
        <span className="mt-1.5 block">
          <StateChip conv={conv} />
        </span>
      </span>
    </button>
  )
}

function ChatHeader({
  conv,
  contactName,
  onToggleAi,
  onTakeOver,
  onDone,
  onOpenPanel,
  aiLocked,
}: {
  conv: Conversation
  contactName: string
  onToggleAi: (v: boolean) => void
  onTakeOver: () => void
  onDone: () => void
  onOpenPanel: () => void
  aiLocked: boolean
}) {
  const page = pageById(conv.pageId)
  return (
    <div className="border-b border-border bg-surface">
      <div className="flex items-center gap-4 px-5 py-3">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-base font-semibold">{contactName}</h2>
          <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
            qua <PageAvatar page={page} size={18} /> <span className="truncate font-medium text-foreground">{page.name}</span>
          </div>
        </div>
        <AiLockHint locked={aiLocked} placement="bottom">
          <label className={cn('flex items-center gap-2 text-[13px] font-medium', aiLocked && 'opacity-60')}>
            <span className={conv.aiEnabled ? 'text-ai' : 'text-muted-foreground'}>AI tự trả lời</span>
            <Switch checked={conv.aiEnabled} onChange={onToggleAi} ai label="AI tự trả lời" />
          </label>
        </AiLockHint>
        {conv.aiEnabled || conv.state === 'handoff' ? (
          <Button variant="primary" size="sm" icon={<Hand size={15} />} onClick={onTakeOver} title="Tiếp quản (T)">
            Tiếp quản
          </Button>
        ) : (
          conv.state !== 'done' && (
            <Button size="sm" icon={<CheckCheck size={15} />} onClick={onDone}>
              Đánh dấu xong
            </Button>
          )
        )}
        <Button variant="ghost" size="sm" icon={<UserRound size={15} />} onClick={onOpenPanel} className="min-[1440px]:hidden">
          Hồ sơ khách
        </Button>
      </div>
      {conv.state === 'handoff' && conv.handoffReason && (
        <div className="flex items-center gap-2 border-t border-amber-200 bg-warning-soft px-5 py-2 text-[13px] text-amber-900">
          <TriangleAlert size={15} className="shrink-0 text-warning" />
          <span>
            <b>AI chuyển cho bạn:</b> {conv.handoffReason.charAt(0).toLowerCase() + conv.handoffReason.slice(1)}
            {conv.waiting && <> · khách chờ {conv.waiting}</>}
          </span>
        </div>
      )}
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

function Bubble({ msg, contactName }: { msg: Message; contactName: string }) {
  if (msg.from === 'system')
    return (
      <div className="flex justify-center py-1">
        <span className="inline-flex max-w-[80%] items-center gap-1.5 rounded-full border border-amber-200 bg-warning-soft px-3 py-1 text-xs text-amber-900">
          <Hand size={12} className="shrink-0" />
          {msg.text} · {msg.time}
        </span>
      </div>
    )
  if (msg.from === 'customer')
    return (
      <div className="flex justify-start">
        <div className="max-w-[70%]">
          <div className="rounded-lg rounded-bl-sm bg-slate-100 px-3.5 py-2 text-sm whitespace-pre-wrap">{msg.text}</div>
          <div className="mt-1 text-[11px] text-muted-foreground">
            {contactName} · {msg.time}
          </div>
        </div>
      </div>
    )
  const ai = msg.from === 'ai'
  return (
    <div className="flex justify-end">
      <div className="max-w-[70%]">
        <div
          className={cn(
            'rounded-lg rounded-br-sm px-3.5 py-2 text-sm whitespace-pre-wrap',
            ai ? 'border border-violet-200 bg-ai-soft text-foreground' : 'bg-primary text-primary-foreground',
          )}
        >
          {msg.text}
        </div>
        <div className="mt-1 flex items-center justify-end gap-1 text-[11px] text-muted-foreground">
          {ai ? (
            <span className="inline-flex items-center gap-1 font-medium text-ai">
              <Sparkles size={11} /> AI trả lời
            </span>
          ) : (
            <span className="font-medium">Bạn</span>
          )}
          · {msg.time}
        </div>
      </div>
    </div>
  )
}

function TypingDots() {
  return (
    <div className="flex justify-end">
      <div className="inline-flex items-center gap-2 rounded-lg rounded-br-sm border border-violet-200 bg-ai-soft px-3.5 py-2.5" aria-live="polite">
        <span className="text-xs font-medium text-ai">AI đang gõ</span>
        <span className="flex gap-1">
          {[0, 150, 300].map((d) => (
            <span key={d} className="size-1.5 animate-bounce rounded-full bg-ai" style={{ animationDelay: `${d}ms` }} />
          ))}
        </span>
      </div>
    </div>
  )
}

function Composer({
  value,
  onChange,
  onSend,
  onSuggest,
  onStop,
  writing,
  aiLocked,
  aiOn,
  textareaRef,
  attachment,
  onAttach,
  onRemoveAttachment,
}: {
  value: string
  onChange: (v: string) => void
  onSend: () => void
  onSuggest: () => void
  onStop: () => void
  writing: boolean
  aiLocked: boolean
  aiOn: boolean
  textareaRef: RefObject<HTMLTextAreaElement | null>
  attachment?: string
  onAttach: () => void
  onRemoveAttachment: () => void
}) {
  // Ô soạn bị thay bằng "AI đang viết…" trong lúc gợi ý; khi gợi ý xong thì đưa con trỏ về lại để ⌘↵ gửi được ngay.
  const wasWriting = useRef(writing)
  useEffect(() => {
    if (wasWriting.current && !writing) textareaRef.current?.focus()
    wasWriting.current = writing
  }, [writing, textareaRef])

  const onKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      onSend()
    }
  }
  const canSend = !!value.trim() || !!attachment
  return (
    <div className="border-t border-border bg-surface px-5 pt-3 pb-4">
      <div className="mb-2 flex flex-wrap gap-1.5">
        {QUICK_REPLIES.map((q) => (
          <button
            key={q}
            onClick={() => {
              onChange(value ? `${value.trimEnd()} ${q}` : q)
              textareaRef.current?.focus()
            }}
            className="rounded-full border border-border px-2.5 py-1 text-xs text-muted-foreground hover:border-primary/40 hover:bg-primary-soft/40 hover:text-foreground"
          >
            {q}
          </button>
        ))}
      </div>
      <div className={cn('rounded-md border bg-surface focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/15', writing ? 'border-violet-300' : 'border-border')}>
        {writing ? (
          <div className="flex h-[84px] items-center gap-3 px-3 text-sm text-ai">
            <Sparkles size={16} className="animate-pulse" />
            AI đang viết…
            <Button variant="ghost" size="sm" icon={<Square size={13} />} onClick={onStop} className="ml-auto">
              Dừng
            </Button>
          </div>
        ) : (
          <textarea
            ref={textareaRef}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={onKeyDown}
            rows={3}
            placeholder="Nhập tin nhắn… (⌘↵ để gửi)"
            aria-label="Nội dung tin nhắn"
            className="block w-full resize-none rounded-md bg-transparent px-3 py-2 text-sm placeholder:text-slate-400 focus:outline-none"
          />
        )}
        {attachment && (
          <div className="px-3 pb-2">
            <span className="inline-flex items-center gap-1.5 rounded-sm bg-slate-100 px-2 py-1 text-xs">
              <ImagePlus size={13} /> {attachment}
              <button onClick={onRemoveAttachment} aria-label="Bỏ ảnh" className="text-muted-foreground hover:text-foreground">
                <X size={12} />
              </button>
            </span>
          </div>
        )}
        <div className="flex items-center gap-2 border-t border-border px-2 py-1.5">
          <button onClick={onAttach} className="rounded-md p-1.5 text-muted-foreground hover:bg-slate-100 hover:text-foreground" aria-label="Đính kèm ảnh" title="Đính kèm ảnh">
            <ImagePlus size={18} />
          </button>
          <AiLockHint locked={aiLocked} align="start">
            <Button variant="ai" size="sm" onClick={onSuggest} disabled={writing || aiLocked}>
              Gợi ý bằng AI
            </Button>
          </AiLockHint>
          {aiOn && !aiLocked && <span className="truncate text-xs text-muted-foreground">AI vẫn đang tự trả lời — bấm “Tiếp quản” để tự xử lý.</span>}
          <Button variant="primary" size="sm" icon={<Send size={14} />} onClick={onSend} disabled={!canSend || writing} className="ml-auto">
            Gửi
          </Button>
        </div>
      </div>
    </div>
  )
}

function CustomerPanel({
  conv,
  contact,
  edit,
  onEdit,
  allConvs,
  onOpenConv,
}: {
  conv: Conversation
  contact: Contact
  edit: ContactEdit
  onEdit: (p: Partial<ContactEdit>) => void
  allConvs: Conversation[]
  onOpenConv: (id: string) => void
}) {
  const [tagInput, setTagInput] = useState('')
  const [adding, setAdding] = useState(false)
  const otherPages = contact.pageIds.filter((id) => id !== conv.pageId)

  const addTag = () => {
    const t = tagInput.trim()
    if (t && !edit.tags.includes(t)) onEdit({ tags: [...edit.tags, t] })
    setTagInput('')
    setAdding(false)
  }

  return (
    <div className="space-y-5 p-5">
      <div className="flex flex-col items-center text-center">
        <Avatar name={contact.name} color={contact.avatarColor} size={64} />
        <div className="mt-2 text-base font-semibold">{contact.name}</div>
        <a href={`tel:${contact.phone.replace(/\s/g, '')}`} className="mt-0.5 inline-flex items-center gap-1.5 text-[13px] text-muted-foreground hover:text-primary">
          <Phone size={13} /> {contact.phone}
        </a>
      </div>

      <label className="block">
        <span className="mb-1.5 block text-[13px] font-medium">Giai đoạn</span>
        <Select options={STAGES} value={edit.stage} onChange={(e) => onEdit({ stage: e.target.value as Stage })} />
      </label>

      <div>
        <div className="mb-1.5 text-[13px] font-medium">Thẻ</div>
        <div className="flex flex-wrap items-center gap-1.5">
          {edit.tags.map((t) => (
            <span key={t} className="inline-flex items-center gap-1 rounded-full bg-slate-100 py-0.5 pr-1 pl-2 text-xs font-medium text-slate-700">
              {t}
              <button onClick={() => onEdit({ tags: edit.tags.filter((x) => x !== t) })} aria-label={`Bỏ thẻ ${t}`} className="rounded-full p-0.5 hover:bg-slate-200">
                <X size={11} />
              </button>
            </span>
          ))}
          {adding ? (
            <input
              autoFocus
              value={tagInput}
              onChange={(e) => setTagInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') addTag()
                if (e.key === 'Escape') setAdding(false)
              }}
              onBlur={addTag}
              placeholder="Tên thẻ…"
              className="h-6 w-28 rounded-full border border-primary px-2 text-xs focus:outline-none"
            />
          ) : (
            <button onClick={() => setAdding(true)} className="inline-flex items-center gap-0.5 rounded-full border border-dashed border-slate-300 px-2 py-0.5 text-xs text-muted-foreground hover:border-primary hover:text-primary">
              <Plus size={11} /> Thêm thẻ
            </button>
          )}
        </div>
      </div>

      <label className="block">
        <span className="mb-1.5 block text-[13px] font-medium">Ghi chú</span>
        <Textarea rows={3} value={edit.note} onChange={(e) => onEdit({ note: e.target.value })} placeholder="Thêm ghi chú về khách…" />
      </label>

      <div className="rounded-md border border-violet-200 bg-ai-soft/60 p-3">
        <div className="mb-1 flex items-center gap-1.5 text-[13px] font-semibold text-ai">
          <Sparkles size={14} /> Tóm tắt bằng AI
        </div>
        <p className="text-[13px] leading-relaxed text-slate-700">{contact.aiSummary}</p>
      </div>

      <div>
        <div className="mb-2 text-[13px] font-medium">Hội thoại trên trang khác</div>
        {otherPages.length === 0 ? (
          <p className="text-xs text-muted-foreground">Khách chỉ nhắn trang này.</p>
        ) : (
          <ul className="space-y-1">
            {otherPages.map((pid) => {
              const page = pageById(pid)
              const other = allConvs.find((c) => c.customerId === contact.id && c.pageId === pid)
              const sub = other ? other.lastMessage : (OTHER_PAGE_HISTORY[`${contact.id}:${pid}`] ?? 'Đã từng nhắn trang này')
              const body = (
                <>
                  <PageAvatar page={page} size={24} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-medium">{page.name}</span>
                    <span className="block truncate text-xs text-muted-foreground">{sub}</span>
                  </span>
                </>
              )
              return (
                <li key={pid}>
                  {other ? (
                    <button onClick={() => onOpenConv(other.id)} className="flex w-full items-center gap-2.5 rounded-md p-1.5 text-left hover:bg-slate-50">
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

      <Link to={`/khach-hang?id=${contact.id}`} className="block text-center text-[13px] font-medium text-primary hover:underline">
        Xem hồ sơ khách hàng →
      </Link>
    </div>
  )
}
