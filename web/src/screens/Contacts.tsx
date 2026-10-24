// Khách hàng `/khach-hang` (Story 4.9, AD-11, AD-18): danh sách khách thật theo phạm vi — lọc giai đoạn (hàng nút có số
// đếm), thẻ, chữ (server lọc, cursor "Xem thêm"); gắn thẻ / đổi giai đoạn hàng loạt. Ngăn kéo `?id=`: trang khách đã nhắn,
// gợi ý gộp (Meta xác nhận cùng người), hồ sơ sửa được (`ContactProfile`: giai đoạn, thẻ, tên, SĐT, ghi chú, tóm tắt AI
// "AI tạo"), lịch sử nhắn tin của mọi hội thoại (mỗi đoạn ghi rõ trang), "Gộp khách" (chọn khách khác → gộp vào khách
// đang mở, xác nhận vì không hoàn tác). `pageIds`, "Xử lý bởi" là trường dẫn xuất của server. Xuất CSV: sắp có.
// Story 9.2: "Xoá khách" → hộp xác nhận (ô "Tôi hiểu…" bắt buộc) → yêu cầu xoá + link trang trạng thái công khai.
import { CONTACT_STAGES, type ContactDeletionResponse, type ContactDetailDto, type ContactDto, type ContactStage } from '@ottm/shared'
import { Download, ExternalLink, GitMerge, MessageSquareText, Phone, Search, Tag, Trash2, Users, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { Content } from '../components/AppShell'
import { ContactProfile, StagePill } from '../components/ContactProfile'
import { Skeleton } from '../components/Skeleton'
import { AiBadge, Avatar, Button, Card, Chip, Drawer, EmptyState, Field, Input, Modal, PageAvatar, PageHeader, PlatformIcon, Select, cn, platformLabel } from '../components/ui'
import { pages as pageStore, type Page, type Platform } from '../data/mock'
import { useApp } from '../lib/app-context'
import {
  CONTACT_STAGE_LABEL,
  STAGE_OPTIONS,
  STAGE_STYLE,
  avatarColorOf,
  deleteContactConfirmText,
  historyAuthor,
  historySegments,
  historyText,
  mergeConfirmText,
  useBulkUpdateContacts,
  useContact,
  useContactFacets,
  useContactHistory,
  useContacts,
  useDeleteContact,
  useMergeContacts,
  type ContactFilters,
} from '../lib/contacts'
import { errorMessageOf } from '../lib/error-messages'
import { channelLabel, contactLabel, durationLabel, flattenMessages, messageTimeLabel, previewText, useNow } from '../lib/inbox'

const ALL = ''

/** Trang trong kho (trang thật đã chép vào kho mẫu khi tải `/pages`); chưa tải xong / đã gỡ → undefined. */
const findPage = (id: string): Page | undefined => pageStore.find((p) => p.id === id)

const platformsOf = (pageIds: readonly string[]): Platform[] => [...new Set(pageIds.map((id) => findPage(id)?.platform).filter((p): p is Platform => !!p))]

/** Tên hiển thị (chưa có tên → nhãn dự phòng theo nền tảng của trang đầu). */
const nameOf = (c: Pick<ContactDto, 'id' | 'name' | 'pageIds'>) => contactLabel(c, findPage(c.pageIds[0] ?? '')?.platform)

/** Giá trị trễ (ô tìm: chỉ gửi server khi ngừng gõ). */
function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value)
  useEffect(() => {
    const t = window.setTimeout(() => setV(value), ms)
    return () => window.clearTimeout(t)
  }, [value, ms])
  return v
}

export default function Contacts() {
  const { scope, notify, scopeLabel } = useApp()
  const [params, setParams] = useSearchParams()
  const [query, setQuery] = useState('')
  const [stage, setStage] = useState<ContactStage | null>(null)
  const [tag, setTag] = useState<string | null>(null)
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [bulk, setBulk] = useState<null | 'tag' | 'stage'>(null)
  const [bulkTag, setBulkTag] = useState('')
  const [bulkStage, setBulkStage] = useState<ContactStage>('consulting')
  const q = useDebounced(query)
  const filters: ContactFilters = { stage, tag, q }
  const now = useNow()

  const list = useContacts(scope, filters)
  const facets = useContactFacets(scope)
  const bulkM = useBulkUpdateContacts()
  const items = useMemo(() => list.data?.pages.flatMap((p) => p.items) ?? [], [list.data])
  const total = facets.data?.total ?? 0
  const allTags = facets.data?.tags ?? []

  const openId = params.get('id')
  const openDrawer = (id: string) => setParams({ id }, { replace: false })
  const closeDrawer = () => setParams({}, { replace: false })

  const visibleIds = items.map((c) => c.id)
  // Chỉ khách đang hiện mới tính là đã chọn: đổi phạm vi / bộ lọc / gộp khách thì khách đã chọn trước đó không bị sửa ngầm.
  const selectedIds = visibleIds.filter((id) => checked.has(id))
  const allChecked = visibleIds.length > 0 && selectedIds.length === visibleIds.length
  const toggleAll = () => setChecked(allChecked ? new Set() : new Set(visibleIds))
  const toggleOne = (id: string) =>
    setChecked((s) => {
      const n = new Set(s)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })

  const applyBulk = () => {
    const ids = selectedIds
    const t = bulkTag.trim()
    if (ids.length === 0 || (bulk === 'tag' && !t)) return
    bulkM.mutate(bulk === 'tag' ? { ids, addTag: t } : { ids, stage: bulkStage }, {
      onSuccess: () => {
        notify(bulk === 'tag' ? `Đã gắn thẻ "${t}" cho ${ids.length} khách` : `Đã chuyển ${ids.length} khách sang "${CONTACT_STAGE_LABEL[bulkStage]}"`)
        setBulk(null)
        setBulkTag('')
        setChecked(new Set())
      },
      onError: (err) => notify(errorMessageOf(err)),
    })
  }

  const filtersOn = !!query || stage !== null || tag !== null
  const loading = list.isPending

  return (
    <Content>
      <PageHeader
        title="Khách hàng"
        subtitle={
          <>
            {total} khách · {scopeLabel}
          </>
        }
        actions={
          <Button icon={<Download size={16} />} disabled title="Sắp có">
            Xuất CSV
          </Button>
        }
      />

      {/* Pipeline theo giai đoạn */}
      <div className="mb-4 flex flex-wrap gap-2" role="group" aria-label="Lọc theo giai đoạn">
        {CONTACT_STAGES.map((s) => {
          const active = stage === s
          return (
            <button
              key={s}
              onClick={() => setStage(active ? null : s)}
              aria-pressed={active}
              className={cn(
                'flex items-center gap-2 rounded-md border px-3 py-2 text-left transition-colors',
                active ? 'border-primary bg-primary-soft/40' : 'border-border bg-surface hover:bg-slate-50',
              )}
            >
              <span className={cn('size-2 rounded-full', STAGE_STYLE[s].dot)} />
              <span className="text-[13px] font-medium">{CONTACT_STAGE_LABEL[s]}</span>
              <span className="tabular text-base font-bold">{facets.data?.stages[s] ?? 0}</span>
            </button>
          )
        })}
      </div>

      <Card>
        {/* Thanh lọc */}
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
          <div className="relative w-72">
            <Search size={16} className="absolute top-1/2 left-3 -translate-y-1/2 text-muted-foreground" />
            <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Tìm tên, số điện thoại, thẻ…" className="pl-9" aria-label="Tìm khách hàng" />
          </div>
          <Select
            options={[{ value: ALL, label: 'Tất cả giai đoạn' }, ...STAGE_OPTIONS]}
            value={stage ?? ALL}
            onChange={(e) => setStage((e.target.value || null) as ContactStage | null)}
            className="w-48"
            aria-label="Giai đoạn"
          />
          <Select
            options={[{ value: ALL, label: 'Tất cả thẻ' }, ...(tag && !allTags.includes(tag) ? [tag] : []), ...allTags]}
            value={tag ?? ALL}
            onChange={(e) => setTag(e.target.value || null)}
            className="w-48"
            aria-label="Thẻ"
          />
          {filtersOn && (
            <Button
              variant="ghost"
              size="sm"
              icon={<X size={14} />}
              onClick={() => {
                setQuery('')
                setStage(null)
                setTag(null)
              }}
            >
              Xoá lọc
            </Button>
          )}
          <span className="ml-auto text-[13px] text-muted-foreground">
            Hiện {items.length}
            {list.hasNextPage ? '+' : ''} khách
          </span>
        </div>

        {/* Thanh thao tác hàng loạt */}
        {selectedIds.length > 0 && (
          <div className="flex items-center gap-2 border-b border-border bg-primary-soft/40 px-4 py-2">
            <span className="text-[13px] font-semibold">Đã chọn {selectedIds.length} khách</span>
            <Button size="sm" icon={<Tag size={14} />} onClick={() => setBulk('tag')}>
              Gắn thẻ
            </Button>
            <Button size="sm" onClick={() => setBulk('stage')}>
              Đổi giai đoạn
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setChecked(new Set())} className="ml-auto">
              Bỏ chọn
            </Button>
          </div>
        )}

        {loading ? (
          <div className="space-y-3 p-4" aria-label="Đang tải khách hàng">
            {Array.from({ length: 5 }, (_, i) => (
              <div key={i} className="flex items-center gap-3">
                <Skeleton className="size-[34px] rounded-full" />
                <Skeleton className="h-4 w-48" />
                <Skeleton className="h-4 w-24" />
                <Skeleton className="ml-auto h-4 w-64" />
              </div>
            ))}
          </div>
        ) : list.isError ? (
          <EmptyState icon={<Users size={22} />} title="Không tải được danh sách khách" action={<Button onClick={() => void list.refetch()}>Thử lại</Button>}>
            {errorMessageOf(list.error)}
          </EmptyState>
        ) : items.length === 0 ? (
          <EmptyState icon={<Users size={22} />} title={filtersOn ? 'Không có khách khớp bộ lọc' : 'Chưa có khách hàng nào trong phạm vi này'}>
            {filtersOn ? 'Thử đổi giai đoạn, thẻ hoặc từ khoá.' : 'Khách nhắn tin vào trang sẽ tự xuất hiện ở đây.'}
          </EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-[13px] text-muted-foreground">
                  <th className="w-10 py-2.5 pl-4">
                    <input type="checkbox" checked={allChecked} onChange={toggleAll} aria-label="Chọn tất cả" className="size-4 accent-primary" />
                  </th>
                  <th className="px-3 py-2.5 font-medium">Khách hàng</th>
                  <th className="px-3 py-2.5 font-medium">Kênh</th>
                  <th className="px-3 py-2.5 font-medium">Trang gần nhất</th>
                  <th className="px-3 py-2.5 font-medium">Giai đoạn</th>
                  <th className="px-3 py-2.5 font-medium">Thẻ</th>
                  <th className="px-3 py-2.5 font-medium">Tin nhắn cuối</th>
                  <th className="px-3 py-2.5 font-medium">Xử lý bởi</th>
                  <th className="px-3 py-2.5 pr-4" />
                </tr>
              </thead>
              <tbody>
                {items.map((c) => (
                  <ContactRow key={c.id} c={c} now={now} checked={checked.has(c.id)} onToggle={() => toggleOne(c.id)} onOpen={() => openDrawer(c.id)} />
                ))}
              </tbody>
            </table>
            {list.hasNextPage && (
              <div className="border-t border-border p-3 text-center">
                <Button size="sm" onClick={() => void list.fetchNextPage()} disabled={list.isFetchingNextPage}>
                  {list.isFetchingNextPage ? 'Đang tải…' : 'Xem thêm'}
                </Button>
              </div>
            )}
          </div>
        )}
      </Card>

      {openId && <ContactDrawer key={openId} id={openId} onClose={closeDrawer} onOpenContact={openDrawer} />}

      <Modal
        open={bulk !== null}
        onClose={() => setBulk(null)}
        title={bulk === 'tag' ? `Gắn thẻ cho ${selectedIds.length} khách` : `Đổi giai đoạn cho ${selectedIds.length} khách`}
        width={440}
        footer={
          <>
            <Button variant="ghost" onClick={() => setBulk(null)}>
              Huỷ
            </Button>
            <Button variant="primary" onClick={applyBulk} disabled={(bulk === 'tag' && !bulkTag.trim()) || bulkM.isPending}>
              {bulk === 'tag' ? 'Gắn thẻ' : 'Đổi giai đoạn'}
            </Button>
          </>
        }
      >
        {bulk === 'tag' ? (
          <div className="space-y-3">
            <Field label="Tên thẻ">
              <Input autoFocus value={bulkTag} maxLength={40} onChange={(e) => setBulkTag(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && applyBulk()} placeholder="Ví dụ: Đổi trả" />
            </Field>
            <div className="flex flex-wrap gap-1.5">
              {allTags.map((t) => (
                <button key={t} onClick={() => setBulkTag(t)} className={cn('rounded-full border px-2.5 py-0.5 text-xs', bulkTag === t ? 'border-primary bg-primary-soft/50 text-primary-hover' : 'border-border text-muted-foreground hover:bg-slate-50')}>
                  {t}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <Field label="Giai đoạn mới">
            <Select options={STAGE_OPTIONS} value={bulkStage} onChange={(e) => setBulkStage(e.target.value as ContactStage)} />
          </Field>
        )}
      </Modal>
    </Content>
  )
}

function ContactRow({ c, now, checked, onToggle, onOpen }: { c: ContactDto; now: Date; checked: boolean; onToggle: () => void; onOpen: () => void }) {
  const latestPage = c.latest ? findPage(c.latest.pageId) : undefined
  const name = nameOf(c)
  return (
    <tr onClick={onOpen} className={cn('cursor-pointer border-b border-border last:border-0 hover:bg-slate-50', checked && 'bg-primary-soft/20')}>
      <td className="py-3 pl-4" onClick={(e) => e.stopPropagation()}>
        <input type="checkbox" checked={checked} onChange={onToggle} aria-label={`Chọn ${name}`} className="size-4 accent-primary" />
      </td>
      <td className="px-3 py-3">
        <div className="flex items-center gap-2.5">
          <Avatar name={name} color={avatarColorOf(c.id)} size={34} />
          <div className="min-w-0">
            <button
              className="block max-w-52 truncate text-left font-medium hover:text-primary"
              onClick={(e) => {
                e.stopPropagation()
                onOpen()
              }}
            >
              {name}
            </button>
            {c.phone && <div className="tabular text-xs text-muted-foreground">{c.phone}</div>}
          </div>
        </div>
      </td>
      <td className="px-3 py-3">
        <div className="flex items-center gap-1">
          {platformsOf(c.pageIds).map((p) => (
            <span key={p} title={platformLabel[p]}>
              <PlatformIcon platform={p} size={18} />
            </span>
          ))}
        </div>
      </td>
      <td className="px-3 py-3">
        {latestPage ? (
          <div className="flex items-center gap-2">
            <PageAvatar page={latestPage} size={22} />
            <span className="max-w-36 truncate text-[13px]">{latestPage.name}</span>
          </div>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        )}
      </td>
      <td className="px-3 py-3">
        <StagePill stage={c.stage} />
      </td>
      <td className="px-3 py-3">
        <div className="flex max-w-52 flex-wrap gap-1">
          {c.tags.map((t) => (
            <Chip key={t}>{t}</Chip>
          ))}
        </div>
      </td>
      <td className="max-w-64 px-3 py-3">
        {c.latest ? (
          <>
            <div className="truncate text-[13px]">{previewText(c.latest.preview)}</div>
            <div className="text-xs text-muted-foreground">{durationLabel(c.latest.preview?.at ?? c.latest.lastMessageAt, now)} trước</div>
          </>
        ) : (
          <span className="text-xs text-muted-foreground">Chưa có tin nhắn</span>
        )}
      </td>
      <td className="px-3 py-3">{c.handledBy === 'ai' ? <AiBadge label="AI" /> : c.handledBy === 'human' ? <Chip>Bạn</Chip> : <span className="text-xs text-muted-foreground">—</span>}</td>
      <td className="px-3 py-3 pr-4 text-right" onClick={(e) => e.stopPropagation()}>
        {c.latest && (
          <Link to={`/hop-thu?c=${c.latest.id}`} className="inline-flex items-center gap-1 text-[13px] font-medium whitespace-nowrap text-primary hover:underline">
            <MessageSquareText size={14} /> Mở hội thoại
          </Link>
        )}
      </td>
    </tr>
  )
}

function ContactDrawer({ id, onClose, onOpenContact }: { id: string; onClose: () => void; onOpenContact: (id: string) => void }) {
  const navigate = useNavigate()
  const contact = useContact(id)
  const [merging, setMerging] = useState<{ sourceId?: string } | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [deleted, setDeleted] = useState<ContactDeletionResponse | null>(null)
  const c = contact.data

  // Sau khi gửi yêu cầu xoá: chỉ còn hộp "Đã nhận" (chi tiết khách đã thành 404 — khách bị ẩn ngay).
  if (deleted) return <DeletionDoneModal deletion={deleted} onClose={onClose} />
  if (!c) {
    return (
      <Drawer open onClose={onClose} width={460} title="Hồ sơ khách hàng">
        {contact.isError ? (
          <EmptyState icon={<Users size={22} />} title="Không tìm thấy khách">
            Khách có thể đã được gộp vào khách khác hoặc trang của khách đã bị gỡ.
          </EmptyState>
        ) : (
          <div className="space-y-3" aria-label="Đang tải hồ sơ khách">
            <Skeleton className="h-6 w-1/2" />
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-20 w-full" />
          </div>
        )}
      </Drawer>
    )
  }

  const name = nameOf(c)
  return (
    <Drawer
      open
      onClose={onClose}
      width={460}
      title={
        <span className="flex items-center gap-3">
          <Avatar name={name} color={avatarColorOf(c.id)} size={36} />
          <span>
            <span className="block">{name}</span>
            {c.phone && (
              <span className="flex items-center gap-1.5 text-xs font-normal text-muted-foreground">
                <Phone size={12} /> {c.phone}
              </span>
            )}
          </span>
        </span>
      }
      footer={
        <>
          <Button variant="danger" icon={<Trash2 size={15} />} onClick={() => setDeleting(true)} className="mr-auto">
            Xoá khách
          </Button>
          <Button icon={<GitMerge size={15} />} onClick={() => setMerging({})}>
            Gộp khách
          </Button>
          {c.latest && (
            <Button variant="primary" icon={<MessageSquareText size={15} />} onClick={() => navigate(`/hop-thu?c=${c.latest!.id}`)}>
              Mở hội thoại
            </Button>
          )}
        </>
      }
    >
      <div className="space-y-5">
        <div>
          <div className="mb-1.5 text-[13px] font-medium">Đã nhắn qua</div>
          <div className="flex flex-wrap gap-2">
            {c.pageIds.map((pid) => {
              const p = findPage(pid)
              return (
                <span key={pid} className="inline-flex items-center gap-1.5 rounded-full border border-border py-0.5 pr-2.5 pl-0.5 text-xs">
                  {p ? <PageAvatar page={p} size={20} /> : <span className="size-5 rounded-full bg-slate-200" />}
                  {p?.name ?? 'Trang'}
                  {p && <span className="sr-only">({platformLabel[p.platform]})</span>}
                </span>
              )
            })}
          </div>
        </div>

        {c.mergeSuggestions.length > 0 && (
          <div className="space-y-2 rounded-md border border-amber-200 bg-amber-50 p-3">
            <p className="text-xs text-amber-900">Meta xác nhận đây là cùng một người (qua tin nhắn riêng từ bình luận):</p>
            {c.mergeSuggestions.map((s) => (
              <div key={s.contactId} className="flex items-center gap-2">
                <button onClick={() => onOpenContact(s.contactId)} className="min-w-0 flex-1 truncate text-left text-[13px] font-medium hover:text-primary">
                  {contactLabel({ id: s.contactId, name: s.name }, undefined)}
                </button>
                <Button size="sm" icon={<GitMerge size={14} />} onClick={() => setMerging({ sourceId: s.contactId })}>
                  Gộp vào khách này
                </Button>
              </div>
            ))}
          </div>
        )}

        <ContactProfile key={c.id} contact={c} showName />

        <ContactHistory contact={c} />
      </div>

      {merging && <MergeModal target={c} initialSourceId={merging.sourceId ?? null} onClose={() => setMerging(null)} />}
      {deleting && <DeleteContactModal contact={c} onCancel={() => setDeleting(false)} onDeleted={setDeleted} />}
    </Drawer>
  )
}

function ContactHistory({ contact }: { contact: ContactDetailDto }) {
  const history = useContactHistory(contact.id)
  const segments = useMemo(() => historySegments(flattenMessages(history.data?.pages)), [history.data])
  const now = useNow()
  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[13px] font-medium">Lịch sử nhắn tin trên các trang</span>
        {history.hasNextPage && (
          <button onClick={() => void history.fetchNextPage()} disabled={history.isFetchingNextPage} className="text-xs font-medium text-primary hover:underline">
            {history.isFetchingNextPage ? 'Đang tải…' : 'Tải tin cũ hơn'}
          </button>
        )}
      </div>
      {history.isPending ? (
        <div className="space-y-2">
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : history.isError ? (
        <p className="text-xs text-muted-foreground">Không tải được lịch sử.</p>
      ) : segments.length === 0 ? (
        <p className="text-xs text-muted-foreground">Chưa có tin nhắn.</p>
      ) : (
        <ol className="relative space-y-4 border-l border-border pl-5">
          {segments.map((seg, i) => {
            const p = findPage(seg.pageId)
            return (
              <li key={`${seg.conversationId}-${i}`} className="relative">
                <span className="absolute top-0.5 -left-[27px] rounded-full bg-surface p-0.5">
                  {p ? <PlatformIcon platform={p.platform} size={13} /> : <span className="block size-[13px] rounded-full bg-slate-200" />}
                </span>
                <div className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
                  <span className="font-medium text-foreground">{p?.name ?? 'Trang'}</span>
                  {p && <span>· {channelLabel(p.platform, seg.channel)}</span>}
                  <Link to={`/hop-thu?c=${seg.conversationId}`} className="ml-auto text-primary hover:underline">
                    Mở
                  </Link>
                </div>
                <ul className="space-y-1.5">
                  {seg.items.map((m) => {
                    const author = historyAuthor(m, contact.id)
                    return (
                      <li key={m.id} className="text-[13px]">
                        <span className="mr-1.5 inline-flex items-center gap-1 align-middle">
                          {author.kind === 'ai' ? <AiBadge label={author.label} /> : <span className={cn('text-xs font-medium', author.kind === 'human' ? 'text-primary' : 'text-muted-foreground')}>{author.label}</span>}
                        </span>
                        <span className={cn(m.removal && 'text-muted-foreground line-through')}>{historyText(m)}</span>
                        <span className="ml-1.5 text-xs text-muted-foreground">{messageTimeLabel(m.platformTimestamp, now)}</span>
                      </li>
                    )
                  })}
                </ul>
              </li>
            )
          })}
        </ol>
      )}
    </div>
  )
}

/** Chọn khách khác (tìm trong mọi trang) rồi gộp VÀO khách đang mở, sau khi xác nhận. */
function MergeModal({ target, initialSourceId, onClose }: { target: ContactDetailDto; initialSourceId: string | null; onClose: () => void }) {
  const { notify } = useApp()
  const [query, setQuery] = useState('')
  const q = useDebounced(query)
  const [sourceId, setSourceId] = useState<string | null>(initialSourceId)
  const candidates = useContacts({ kind: 'all' }, { stage: null, tag: null, q })
  const source = useContact(sourceId)
  const merge = useMergeContacts()
  const options = (candidates.data?.pages.flatMap((p) => p.items) ?? []).filter((c) => c.id !== target.id)
  const targetName = nameOf(target)

  const confirm = () => {
    if (!sourceId) return
    merge.mutate(
      { targetId: target.id, sourceId },
      {
        onSuccess: () => {
          notify(`Đã gộp khách vào "${targetName}"`)
          onClose()
        },
        onError: (err) => notify(errorMessageOf(err)),
      },
    )
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={`Gộp khách vào "${targetName}"`}
      width={480}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Huỷ
          </Button>
          <Button variant="danger" icon={<GitMerge size={15} />} onClick={confirm} disabled={!sourceId || !source.data || merge.isPending}>
            {merge.isPending ? 'Đang gộp…' : 'Gộp khách'}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="relative">
          <Search size={16} className="absolute top-1/2 left-3 -translate-y-1/2 text-muted-foreground" />
          <Input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Tìm khách theo tên, số điện thoại, thẻ…" className="pl-9" aria-label="Tìm khách để gộp" />
        </div>
        <ul className="max-h-60 space-y-1 overflow-y-auto" role="radiogroup" aria-label="Khách sẽ gộp">
          {candidates.isPending ? (
            <li>
              <Skeleton className="h-10 w-full" />
            </li>
          ) : options.length === 0 ? (
            <li className="p-2 text-xs text-muted-foreground">Không có khách nào khớp.</li>
          ) : (
            options.map((c) => {
              const name = nameOf(c)
              return (
                <li key={c.id}>
                  <button
                    role="radio"
                    aria-checked={sourceId === c.id}
                    onClick={() => setSourceId(c.id)}
                    className={cn('flex w-full items-center gap-2.5 rounded-md border p-2 text-left', sourceId === c.id ? 'border-primary bg-primary-soft/40' : 'border-transparent hover:bg-slate-50')}
                  >
                    <Avatar name={name} color={avatarColorOf(c.id)} size={28} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] font-medium">{name}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {[c.phone, ...c.pageIds.map((pid) => findPage(pid)?.name).filter(Boolean)].filter(Boolean).join(' · ')}
                      </span>
                    </span>
                    <StagePill stage={c.stage} />
                  </button>
                </li>
              )
            })
          )}
        </ul>
        {source.data && <p className="rounded-md bg-amber-50 p-3 text-xs text-amber-900">{mergeConfirmText(targetName, nameOf(source.data))}</p>}
      </div>
    </Modal>
  )
}

/**
 * Story 9.2: "Xoá khách và toàn bộ hội thoại". Phá huỷ, không hoàn tác → phải tích ô "Tôi hiểu…" mới bấm được. Gửi xong
 * thì ngăn hồ sơ chuyển sang `DeletionDoneModal` (link trang trạng thái công khai `statusUrl` trên host api).
 */
function DeleteContactModal({ contact, onCancel, onDeleted }: { contact: ContactDetailDto; onCancel: () => void; onDeleted: (d: ContactDeletionResponse) => void }) {
  const { notify } = useApp()
  const [understood, setUnderstood] = useState(false)
  const del = useDeleteContact()
  const name = nameOf(contact)

  const confirm = () => {
    if (!understood) return
    del.mutate(contact.id, {
      onSuccess: (res) => {
        notify(`Đang xoá "${name}" và toàn bộ hội thoại`)
        onDeleted(res)
      },
      onError: (err) => notify(errorMessageOf(err)),
    })
  }

  return (
    <Modal
      open
      onClose={onCancel}
      title={`Xoá khách "${name}"?`}
      width={480}
      footer={
        <>
          <Button variant="ghost" onClick={onCancel}>
            Huỷ
          </Button>
          <Button variant="danger" icon={<Trash2 size={15} />} onClick={confirm} disabled={!understood || del.isPending}>
            {del.isPending ? 'Đang gửi…' : 'Xoá khách và toàn bộ hội thoại'}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="rounded-md bg-red-50 p-3 text-xs text-red-900">{deleteContactConfirmText(name)}</p>
        <label className="flex items-start gap-2 text-[13px]">
          <input type="checkbox" checked={understood} onChange={(e) => setUnderstood(e.target.checked)} className="mt-0.5" />
          <span>Tôi hiểu dữ liệu của khách sẽ bị xoá vĩnh viễn.</span>
        </label>
      </div>
    </Modal>
  )
}

function DeletionDoneModal({ deletion, onClose }: { deletion: ContactDeletionResponse; onClose: () => void }) {
  return (
    <Modal
      open
      onClose={onClose}
      title={deletion.status === 'completed' ? 'Khách đã được xoá' : 'Đã nhận yêu cầu xoá'}
      width={480}
      footer={
        <Button variant="primary" onClick={onClose}>
          Đóng
        </Button>
      }
    >
      <div className="space-y-3 text-[13px]">
        <p>
          {deletion.status === 'completed'
            ? 'Hồ sơ, hội thoại, tin nhắn và tệp đính kèm của khách đã được xoá khỏi ứng dụng.'
            : 'Khách đã được ẩn khỏi danh sách. Hội thoại, tin nhắn và tệp đính kèm đang được xoá ở nền, thường xong trong vài giây.'}
        </p>
        <a href={deletion.statusUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 font-medium text-primary hover:underline">
          Xem trạng thái xoá <ExternalLink size={13} />
        </a>
      </div>
    </Modal>
  )
}
