import { Download, MessageSquareText, Phone, Plus, Search, Sparkles, Tag, Users, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { Content } from '../components/AppShell'
import {
  AiBadge,
  Avatar,
  Button,
  Card,
  Chip,
  Drawer,
  EmptyState,
  Field,
  Input,
  Modal,
  PageAvatar,
  PageHeader,
  PlatformIcon,
  Select,
  Textarea,
  cn,
  platformLabel,
} from '../components/ui'
import { contacts as seedContacts, conversations, pageById, type Contact, type Platform, type Stage } from '../data/mock'
import { useApp } from '../lib/app-context'

const STAGES: Stage[] = ['Mới', 'Đang tư vấn', 'Chốt đơn', 'Khách quen', 'Khiếu nại']
const ALL_STAGES = 'Tất cả giai đoạn'
const ALL_TAGS = 'Tất cả thẻ'

const stageStyle: Record<Stage, { pill: string; dot: string }> = {
  Mới: { pill: 'bg-blue-50 text-blue-700', dot: 'bg-blue-500' },
  'Đang tư vấn': { pill: 'bg-cyan-50 text-cyan-800', dot: 'bg-cyan-500' },
  'Chốt đơn': { pill: 'bg-green-50 text-green-700', dot: 'bg-green-500' },
  'Khách quen': { pill: 'bg-primary-soft text-primary-hover', dot: 'bg-primary' },
  'Khiếu nại': { pill: 'bg-red-50 text-red-700', dot: 'bg-red-500' },
}

function StagePill({ stage }: { stage: Stage }) {
  return (
    <span className={cn('inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap', stageStyle[stage].pill)}>
      <span className={cn('size-1.5 rounded-full', stageStyle[stage].dot)} />
      {stage}
    </span>
  )
}

/** Lịch sử tương tác ngoài các hội thoại đang mở (dữ liệu mẫu). */
const EXTRA_TIMELINE: Record<string, { pageId: string; text: string; when: string; kind: 'customer' | 'ai' | 'human' | 'order' }[]> = {
  c1: [{ pageId: 'p2', text: 'Hỏi kem chống nắng nâng tông, AI gửi bảng giá', when: '3 ngày trước', kind: 'ai' }],
  c3: [{ pageId: 'p2', text: 'Đơn #1042 · 2 hộp kem chống nắng', when: 'Tháng 9', kind: 'order' }],
  c5: [
    { pageId: 'p1', text: 'Mua combo dưỡng da 3 bước', when: '2 tuần trước', kind: 'order' },
    { pageId: 'p1', text: 'Bình luận: "Dùng 1 tháng thấy da sáng hẳn"', when: '3 tuần trước', kind: 'customer' },
  ],
  c7: [{ pageId: 'p4', text: 'Hỏi thời gian bảo hành, AI trả lời 12 tháng', when: '5 ngày trước', kind: 'ai' }],
}

const convOf = (contactId: string) => conversations.find((c) => c.customerId === contactId)

const platformsOf = (c: Contact): Platform[] => [...new Set(c.pageIds.map((id) => pageById(id).platform))]

const latestPageId = (c: Contact) => convOf(c.id)?.pageId ?? c.pageIds[0]

export default function Contacts() {
  const { inScope, notify, scopeLabel } = useApp()
  const [params, setParams] = useSearchParams()
  const [list, setList] = useState<Contact[]>(() => seedContacts.map((c) => ({ ...c, tags: [...c.tags] })))
  const [query, setQuery] = useState('')
  const [stage, setStage] = useState<string>(ALL_STAGES)
  const [tag, setTag] = useState<string>(ALL_TAGS)
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [bulk, setBulk] = useState<null | 'tag' | 'stage'>(null)
  const [bulkTag, setBulkTag] = useState('')
  const [bulkStage, setBulkStage] = useState<Stage>('Đang tư vấn')

  const openId = params.get('id')
  const open = list.find((c) => c.id === openId) ?? null

  const scoped = useMemo(() => list.filter((c) => inScope(c.pageIds)), [list, inScope])
  const allTags = useMemo(() => [...new Set(list.flatMap((c) => c.tags))].sort((a, b) => a.localeCompare(b, 'vi')), [list])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return scoped.filter(
      (c) =>
        (stage === ALL_STAGES || c.stage === stage) &&
        (tag === ALL_TAGS || c.tags.includes(tag)) &&
        (!q || c.name.toLowerCase().includes(q) || c.phone.replace(/\s/g, '').includes(q.replace(/\s/g, '')) || c.tags.some((t) => t.toLowerCase().includes(q))),
    )
  }, [scoped, query, stage, tag])

  const stageCounts = useMemo(() => Object.fromEntries(STAGES.map((s) => [s, scoped.filter((c) => c.stage === s).length])) as Record<Stage, number>, [scoped])

  const patch = (id: string, p: Partial<Contact>) => setList((l) => l.map((c) => (c.id === id ? { ...c, ...p } : c)))

  const openDrawer = (id: string) => setParams({ id }, { replace: false })
  const closeDrawer = () => setParams({}, { replace: false })

  const visibleIds = filtered.map((c) => c.id)
  const allChecked = visibleIds.length > 0 && visibleIds.every((id) => checked.has(id))
  const toggleAll = () => setChecked(allChecked ? new Set() : new Set(visibleIds))
  const toggleOne = (id: string) =>
    setChecked((s) => {
      const n = new Set(s)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })

  const applyBulk = () => {
    const n = checked.size
    if (bulk === 'tag') {
      const t = bulkTag.trim()
      if (!t) return
      setList((l) => l.map((c) => (checked.has(c.id) && !c.tags.includes(t) ? { ...c, tags: [...c.tags, t] } : c)))
      notify(`Đã gắn thẻ "${t}" cho ${n} khách`)
    } else if (bulk === 'stage') {
      setList((l) => l.map((c) => (checked.has(c.id) ? { ...c, stage: bulkStage } : c)))
      notify(`Đã chuyển ${n} khách sang "${bulkStage}"`)
    }
    setBulk(null)
    setBulkTag('')
    setChecked(new Set())
  }

  const filtersOn = query || stage !== ALL_STAGES || tag !== ALL_TAGS

  return (
    <Content>
      <PageHeader
        title="Khách hàng"
        subtitle={
          <>
            {scoped.length} khách · {scopeLabel}
          </>
        }
        actions={
          <Button icon={<Download size={16} />} onClick={() => notify(`Đã xuất ${filtered.length} khách ra file CSV`)}>
            Xuất CSV
          </Button>
        }
      />

      {/* Pipeline theo giai đoạn */}
      <div className="mb-4 flex flex-wrap gap-2" role="group" aria-label="Lọc theo giai đoạn">
        {STAGES.map((s) => {
          const active = stage === s
          return (
            <button
              key={s}
              onClick={() => setStage(active ? ALL_STAGES : s)}
              aria-pressed={active}
              className={cn(
                'flex items-center gap-2 rounded-md border px-3 py-2 text-left transition-colors',
                active ? 'border-primary bg-primary-soft/40' : 'border-border bg-surface hover:bg-slate-50',
              )}
            >
              <span className={cn('size-2 rounded-full', stageStyle[s].dot)} />
              <span className="text-[13px] font-medium">{s}</span>
              <span className="tabular text-base font-bold">{stageCounts[s]}</span>
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
          <Select options={[ALL_STAGES, ...STAGES]} value={stage} onChange={(e) => setStage(e.target.value)} className="w-48" aria-label="Giai đoạn" />
          <Select options={[ALL_TAGS, ...allTags]} value={tag} onChange={(e) => setTag(e.target.value)} className="w-48" aria-label="Thẻ" />
          {filtersOn && (
            <Button
              variant="ghost"
              size="sm"
              icon={<X size={14} />}
              onClick={() => {
                setQuery('')
                setStage(ALL_STAGES)
                setTag(ALL_TAGS)
              }}
            >
              Xoá lọc
            </Button>
          )}
          <span className="ml-auto text-[13px] text-muted-foreground">Hiện {filtered.length} khách</span>
        </div>

        {/* Thanh thao tác hàng loạt */}
        {checked.size > 0 && (
          <div className="flex items-center gap-2 border-b border-border bg-primary-soft/40 px-4 py-2">
            <span className="text-[13px] font-semibold">Đã chọn {checked.size} khách</span>
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

        {filtered.length === 0 ? (
          <EmptyState icon={<Users size={22} />} title={scoped.length === 0 ? 'Chưa có khách hàng nào trong phạm vi này' : 'Không có khách khớp bộ lọc'}>
            {scoped.length === 0 ? 'Khách nhắn tin vào trang sẽ tự xuất hiện ở đây.' : 'Thử đổi giai đoạn, thẻ hoặc từ khoá.'}
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
                {filtered.map((c) => {
                  const conv = convOf(c.id)
                  const latest = pageById(latestPageId(c))
                  return (
                    <tr
                      key={c.id}
                      onClick={() => openDrawer(c.id)}
                      className={cn('cursor-pointer border-b border-border last:border-0 hover:bg-slate-50', checked.has(c.id) && 'bg-primary-soft/20')}
                    >
                      <td className="py-3 pl-4" onClick={(e) => e.stopPropagation()}>
                        <input type="checkbox" checked={checked.has(c.id)} onChange={() => toggleOne(c.id)} aria-label={`Chọn ${c.name}`} className="size-4 accent-primary" />
                      </td>
                      <td className="px-3 py-3">
                        <div className="flex items-center gap-2.5">
                          <Avatar name={c.name} color={c.avatarColor} size={34} />
                          <div className="min-w-0">
                            <button
                              className="block truncate text-left font-medium hover:text-primary"
                              onClick={(e) => {
                                e.stopPropagation()
                                openDrawer(c.id)
                              }}
                            >
                              {c.name}
                            </button>
                            <div className="tabular text-xs text-muted-foreground">{c.phone}</div>
                          </div>
                        </div>
                      </td>
                      <td className="px-3 py-3">
                        <div className="flex items-center gap-1">
                          {platformsOf(c).map((p) => (
                            <PlatformIcon key={p} platform={p} size={18} />
                          ))}
                        </div>
                      </td>
                      <td className="px-3 py-3">
                        <div className="flex items-center gap-2">
                          <PageAvatar page={latest} size={22} />
                          <span className="max-w-36 truncate text-[13px]">{latest.name}</span>
                        </div>
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
                        <div className="truncate text-[13px]">{c.lastMessage}</div>
                        <div className="text-xs text-muted-foreground">{c.lastTime} trước</div>
                      </td>
                      <td className="px-3 py-3">{c.handledBy === 'ai' ? <AiBadge label="AI" /> : <Chip>Bạn</Chip>}</td>
                      <td className="px-3 py-3 pr-4 text-right" onClick={(e) => e.stopPropagation()}>
                        {conv && (
                          <Link to={`/hop-thu?c=${conv.id}`} className="inline-flex items-center gap-1 text-[13px] font-medium whitespace-nowrap text-primary hover:underline">
                            <MessageSquareText size={14} /> Mở hội thoại
                          </Link>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <ContactDrawer key={open?.id ?? "none"} contact={open} onClose={closeDrawer} onPatch={patch} onSaved={() => notify('Đã lưu hồ sơ khách')} />

      <Modal
        open={bulk !== null}
        onClose={() => setBulk(null)}
        title={bulk === 'tag' ? `Gắn thẻ cho ${checked.size} khách` : `Đổi giai đoạn cho ${checked.size} khách`}
        width={440}
        footer={
          <>
            <Button variant="ghost" onClick={() => setBulk(null)}>
              Huỷ
            </Button>
            <Button variant="primary" onClick={applyBulk} disabled={bulk === 'tag' && !bulkTag.trim()}>
              {bulk === 'tag' ? 'Gắn thẻ' : 'Đổi giai đoạn'}
            </Button>
          </>
        }
      >
        {bulk === 'tag' ? (
          <div className="space-y-3">
            <Field label="Tên thẻ">
              <Input autoFocus value={bulkTag} onChange={(e) => setBulkTag(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && applyBulk()} placeholder="Ví dụ: Đổi trả" />
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
            <Select options={STAGES} value={bulkStage} onChange={(e) => setBulkStage(e.target.value as Stage)} />
          </Field>
        )}
      </Modal>
    </Content>
  )
}

function ContactDrawer({ contact, onClose, onPatch, onSaved }: { contact: Contact | null; onClose: () => void; onPatch: (id: string, p: Partial<Contact>) => void; onSaved: () => void }) {
  const [tagInput, setTagInput] = useState('')
  const navigate = useNavigate()
  if (!contact) return null

  const conv = convOf(contact.id)
  const addTag = () => {
    const t = tagInput.trim()
    if (t && !contact.tags.includes(t)) onPatch(contact.id, { tags: [...contact.tags, t] })
    setTagInput('')
  }

  // Dòng thời gian: tin trong hội thoại đang mở + lịch sử ở các trang khác.
  const timeline = [
    ...(conv
      ? [...conv.messages]
          .reverse()
          .slice(0, 4)
          .map((m) => ({ key: `${conv.id}-${m.id}`, pageId: conv.pageId, text: m.text, when: `Hôm nay ${m.time}`, kind: m.from }))
      : []),
    ...(EXTRA_TIMELINE[contact.id] ?? []).map((e, i) => ({ key: `x-${i}`, ...e })),
  ]

  return (
    <Drawer
      open
      onClose={onClose}
      width={460}
      title={
        <span className="flex items-center gap-3">
          <Avatar name={contact.name} color={contact.avatarColor} size={36} />
          <span>
            <span className="block">{contact.name}</span>
            <span className="flex items-center gap-1.5 text-xs font-normal text-muted-foreground">
              <Phone size={12} /> {contact.phone}
            </span>
          </span>
        </span>
      }
      footer={
        <>
          <Button
            onClick={() => {
              onSaved()
              onClose()
            }}
          >
            Lưu và đóng
          </Button>
          {conv && (
            <Button variant="primary" icon={<MessageSquareText size={15} />} onClick={() => navigate(`/hop-thu?c=${conv.id}`)}>
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
            {contact.pageIds.map((pid) => {
              const p = pageById(pid)
              return (
                <span key={pid} className="inline-flex items-center gap-1.5 rounded-full border border-border py-0.5 pr-2.5 pl-0.5 text-xs">
                  <PageAvatar page={p} size={20} />
                  {p.name}
                  <span className="sr-only">({platformLabel[p.platform]})</span>
                </span>
              )
            })}
          </div>
        </div>

        <Field label="Giai đoạn">
          <Select options={STAGES} value={contact.stage} onChange={(e) => onPatch(contact.id, { stage: e.target.value as Stage })} />
        </Field>

        <div>
          <div className="mb-1.5 text-[13px] font-medium">Thẻ</div>
          <div className="flex flex-wrap items-center gap-1.5">
            {contact.tags.map((t) => (
              <span key={t} className="inline-flex items-center gap-1 rounded-full bg-slate-100 py-0.5 pr-1 pl-2 text-xs font-medium text-slate-700">
                {t}
                <button onClick={() => onPatch(contact.id, { tags: contact.tags.filter((x) => x !== t) })} aria-label={`Bỏ thẻ ${t}`} className="rounded-full p-0.5 hover:bg-slate-200">
                  <X size={11} />
                </button>
              </span>
            ))}
            <span className="inline-flex items-center gap-1">
              <input
                value={tagInput}
                onChange={(e) => setTagInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && addTag()}
                placeholder="Thêm thẻ…"
                aria-label="Thêm thẻ"
                className="h-6 w-24 rounded-full border border-dashed border-slate-300 px-2 text-xs focus:border-primary focus:outline-none"
              />
              {tagInput && (
                <button onClick={addTag} className="rounded-full p-0.5 text-primary hover:bg-primary-soft" aria-label="Thêm">
                  <Plus size={14} />
                </button>
              )}
            </span>
          </div>
        </div>

        <Field label="Ghi chú">
          <Textarea rows={3} value={contact.note} onChange={(e) => onPatch(contact.id, { note: e.target.value })} placeholder="Thêm ghi chú về khách…" />
        </Field>

        <div className="rounded-md border border-violet-200 bg-ai-soft/60 p-3">
          <div className="mb-1 flex items-center gap-1.5 text-[13px] font-semibold text-ai">
            <Sparkles size={14} /> Tóm tắt bằng AI
          </div>
          <p className="text-[13px] leading-relaxed text-slate-700">{contact.aiSummary}</p>
        </div>

        <div>
          <div className="mb-2 text-[13px] font-medium">Tương tác trên các trang</div>
          {timeline.length === 0 ? (
            <p className="text-xs text-muted-foreground">Chưa có tương tác.</p>
          ) : (
            <ol className="relative space-y-4 border-l border-border pl-5">
              {timeline.map((t) => {
                const p = pageById(t.pageId)
                return (
                  <li key={t.key} className="relative">
                    <span className="absolute top-1 -left-[27px] rounded-full bg-surface p-0.5">
                      <PlatformIcon platform={p.platform} size={13} />
                    </span>
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <span className="font-medium text-foreground">{p.name}</span>· {t.when}
                      {t.kind === 'ai' && <AiBadge label="AI trả lời" />}
                      {t.kind === 'human' && <Chip>Bạn trả lời</Chip>}
                      {t.kind === 'system' && <Chip tone="warning">Chuyển cho bạn</Chip>}
                      {t.kind === 'order' && <Chip tone="success">Đơn hàng</Chip>}
                    </div>
                    <p className="mt-0.5 text-[13px]">{t.text}</p>
                  </li>
                )
              })}
            </ol>
          )}
        </div>
      </div>
    </Drawer>
  )
}
