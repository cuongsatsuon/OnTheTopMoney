import { ImagePlus, Plus, Square, Trash2, X } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { AiLockHint } from './AiLockHint'
import { brandProfile, groupById, pages, pagesInGroup, type Page } from '../data/mock'
import { useApp } from '../lib/app-context'
import { AiBadge, Button, Card, CardHeader, Field, InheritanceBar, Input, Modal, PageAvatar, Segmented, Select, Textarea, cn } from './ui'

/* ---------- Kiểu & dữ liệu mẫu ---------- */

type Emoji = 'Không' | 'Vừa phải' | 'Nhiều'

export interface BrandData {
  name: string
  tagline: string
  industry: string
  tones: string[]
  formality: number
  pronoun: string
  emoji: Emoji
  products: { name: string; price: string }[]
  audience: string
  colors: string[]
  hashtags: string[]
  banned: string[]
  logo: string | null
}

type Target = { kind: 'group' | 'page'; id: string }

const TONES = ['Thân thiện', 'Chuyên gia', 'Trẻ trung', 'Sang trọng', 'Hài hước']
const INDUSTRIES = ['Mỹ phẩm', 'Gia dụng', 'Thời trang', 'Thực phẩm', 'Mẹ & bé', 'Khác']
const PRONOUNS = ['Shop – chị/bạn', 'Mình – bạn', 'Em – anh/chị', 'Chúng tôi – quý khách']
const EMOJIS: { id: Emoji; label: string }[] = [
  { id: 'Không', label: 'Không' },
  { id: 'Vừa phải', label: 'Vừa phải' },
  { id: 'Nhiều', label: 'Nhiều' },
]

const beauty: BrandData = { ...brandProfile, emoji: brandProfile.emoji as Emoji, logo: null }

const home: BrandData = {
  name: 'Gia dụng Minh Phát',
  tagline: 'Đồ gia dụng bền, đẹp, giá tốt cho mọi gia đình',
  industry: 'Gia dụng',
  tones: ['Thân thiện', 'Chuyên gia'],
  formality: 55,
  pronoun: 'Em – anh/chị',
  emoji: 'Vừa phải',
  products: [
    { name: 'Nồi chiên không dầu 5L', price: '1.290.000đ' },
    { name: 'Nồi chiên không dầu 7L', price: '1.690.000đ' },
    { name: 'Máy xay sinh tố mini', price: '590.000đ' },
  ],
  audience: 'Gia đình trẻ 28–45 tuổi, nội trợ bận rộn, thích nấu ăn nhanh và lành mạnh.',
  colors: ['#2563EB', '#DBEAFE', '#0F172A'],
  hashtags: ['#giadungminhphat', '#noichienkhongdau', '#meonhabep'],
  banned: ['rẻ nhất thị trường', 'bảo hành trọn đời'],
  logo: null,
}

const fashion: BrandData = {
  name: 'Thời trang Mộc',
  tagline: 'Tối giản, chất liệu tự nhiên, mặc đẹp mỗi ngày',
  industry: 'Thời trang',
  tones: ['Trẻ trung', 'Sang trọng'],
  formality: 60,
  pronoun: 'Mình – bạn',
  emoji: 'Vừa phải',
  products: [
    { name: 'Áo len cổ tròn', price: '420.000đ' },
    { name: 'Quần linen ống suông', price: '380.000đ' },
  ],
  audience: 'Nữ 20–30 tuổi, thích phong cách tối giản, mua sắm qua Instagram.',
  colors: ['#EA580C', '#FFEDD5', '#292524'],
  hashtags: ['#mocfashion', '#toigian', '#ootd'],
  banned: ['hàng hiệu', 'fake'],
  logo: null,
}

const DEFAULTS: Record<string, BrandData> = {
  'group:g-beauty': beauty,
  'group:g-home': home,
  'group:g-fashion': fashion,
  // Trang dùng hồ sơ riêng sẵn trong dữ liệu mẫu
  'page:p3': { ...beauty, name: 'Lan Anh Skincare', tones: ['Trẻ trung', 'Hài hước'], formality: 90, pronoun: 'Mình – bạn', emoji: 'Nhiều', hashtags: ['#lananhskincare', '#skincaretips'] },
  'page:p8': { ...fashion, name: 'mocfashion.vn', hashtags: ['#mocfashion', '#ootd'] },
}

/** Hồ sơ đã lưu trong phiên làm việc (thay cho API). */
const saved = new Map<string, BrandData>()

const keyOf = (t: Target) => `${t.kind}:${t.id}`
const clone = (b: BrandData): BrandData => JSON.parse(JSON.stringify(b)) as BrandData

function blankFor(name: string): BrandData {
  return { name, tagline: '', industry: 'Khác', tones: ['Thân thiện'], formality: 60, pronoun: PRONOUNS[0], emoji: 'Vừa phải', products: [], audience: '', colors: [], hashtags: [], banned: [], logo: null }
}

function loadProfile(t: Target): BrandData {
  const k = keyOf(t)
  if (saved.has(k)) return clone(saved.get(k)!)
  if (DEFAULTS[k]) return clone(DEFAULTS[k])
  if (t.kind === 'group') return blankFor(groupById(t.id)?.name.replace(/^Nhóm\s+/, '') ?? '')
  return blankFor(pages.find((p) => p.id === t.id)?.name ?? '')
}

/* ---------- Câu mẫu AI ---------- */

function pronounPair(p: string): [string, string] {
  if (p.startsWith('Mình')) return ['mình', 'bạn']
  if (p.startsWith('Em')) return ['em', 'anh chị']
  if (p.startsWith('Chúng tôi')) return ['chúng tôi', 'quý khách']
  return ['shop', 'chị em mình']
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

function writeSample(b: BrandData, variant: number): string {
  const [self, you] = pronounPair(b.pronoun)
  const close = b.formality >= 55
  const product = b.products[variant % Math.max(1, b.products.length)] ?? { name: 'sản phẩm mới', price: '' }
  const e = (light: string, heavy: string) => (b.emoji === 'Không' ? '' : b.emoji === 'Nhiều' ? ` ${heavy}` : ` ${light}`)
  const tone = b.tones.length ? b.tones[variant % b.tones.length] : 'Thân thiện'

  const opening = b.formality >= 75 ? `Hello ${you} ơi!${e('✨', '✨💕')}` : close ? `Chào ${you}!${e('👋', '👋✨')}` : `Kính chào ${you}.`

  const body: Record<string, string> = {
    'Thân thiện': `${cap(self)} để sẵn ${product.name} cho ${you} rồi nè, nhắn ${self} một câu là có ngay.`,
    'Chuyên gia': `${product.name} là lựa chọn ${self} luôn gợi ý đầu tiên: dùng đúng cách, đều đặn mỗi ngày sẽ thấy khác biệt rõ.`,
    'Trẻ trung': `Đổi gió tuần này với ${product.name}: gọn, xinh, hợp mọi lịch trình bận rộn.`,
    'Sang trọng': `Tinh tế trong từng chi tiết, ${product.name} dành cho những ai biết chăm chút cho bản thân.`,
    'Hài hước': `Ai bảo chăm mình là mệt? Có ${product.name} rồi thì lười cũng đẹp${b.emoji === 'Không' ? '.' : ' 😆'}`,
  }

  const price = product.price ? ` Giá chỉ ${product.price}${e('🔥', '🔥🛍️')}` : ''
  const cta = close ? `Nhắn ${self} ngay để được tư vấn nha!${e('💬', '💬💖')}` : `Vui lòng nhắn tin để ${self} tư vấn chi tiết.`
  const tags = b.hashtags.slice(0, 3).join(' ')

  return [opening, `${body[tone] ?? body['Thân thiện']}${price}`, cta, tags].filter(Boolean).join('\n\n')
}

/* ---------- Thành phần phụ ---------- */

const SECTIONS = [
  { id: 'co-ban', label: 'Thông tin cơ bản' },
  { id: 'giong-dieu', label: 'Giọng điệu' },
  { id: 'san-pham', label: 'Sản phẩm & dịch vụ' },
  { id: 'khach-hang', label: 'Khách hàng mục tiêu' },
  { id: 'hinh-anh', label: 'Hình ảnh thương hiệu' },
  { id: 'tranh', label: 'Điều cần tránh' },
] as const

function Section({ id, title, hint, children }: { id: string; title: string; hint?: string; children: ReactNode }) {
  return (
    <section id={`bp-${id}`} data-section={id} className="scroll-mt-4 border-b border-border px-5 py-5 last:border-b-0">
      <h3 className="text-base font-semibold">{title}</h3>
      {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
      <div className="mt-4 space-y-4">{children}</div>
    </section>
  )
}

function TagEditor({ values, onChange, placeholder, tone, disabled }: { values: string[]; onChange: (v: string[]) => void; placeholder: string; tone: 'neutral' | 'danger'; disabled: boolean }) {
  const [draft, setDraft] = useState('')
  const add = () => {
    const v = draft.trim()
    if (v && !values.includes(v)) onChange([...values, v])
    setDraft('')
  }
  return (
    <div className={cn('flex min-h-9 flex-wrap items-center gap-1.5 rounded-sm border border-border bg-surface px-2 py-1.5', disabled && 'bg-slate-50')}>
      {values.map((v) => (
        <span
          key={v}
          className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium', tone === 'danger' ? 'bg-red-50 text-red-700' : 'bg-slate-100 text-slate-700')}
        >
          {v}
          {!disabled && (
            <button type="button" onClick={() => onChange(values.filter((x) => x !== v))} aria-label={`Xoá ${v}`} className="rounded-full hover:bg-black/5">
              <X size={12} />
            </button>
          )}
        </span>
      ))}
      {!disabled && (
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ',') {
              e.preventDefault()
              add()
            } else if (e.key === 'Backspace' && !draft && values.length) onChange(values.slice(0, -1))
          }}
          onBlur={add}
          placeholder={placeholder}
          className="h-6 min-w-32 flex-1 bg-transparent text-sm placeholder:text-slate-400 focus:outline-none"
        />
      )}
    </div>
  )
}

/* ---------- Form ---------- */

export function BrandProfileForm({ target }: { target: Target }) {
  return <BrandProfileFormInner key={keyOf(target)} target={target} />
}

function BrandProfileFormInner({ target }: { target: Target }) {
  const { notify } = useApp()
  const page = target.kind === 'page' ? pages.find((p) => p.id === target.id) : undefined
  const group = target.kind === 'group' ? groupById(target.id) : groupById(page?.groupId ?? null)
  const inheritable = target.kind === 'page' && !!group

  const [own, setOwn] = useState(() => !inheritable || page?.brandSource === 'own')
  const [savedValue, setSavedValue] = useState<BrandData>(() => loadProfile(target))
  const [form, setForm] = useState<BrandData>(() => clone(savedValue))
  const [confirmOff, setConfirmOff] = useState(false)
  const [active, setActive] = useState<string>(SECTIONS[0].id)
  const groupValue = group ? loadProfile({ kind: 'group', id: group.id }) : null

  const editable = !inheritable || own
  const data = editable ? form : groupValue!
  const dirty = editable && JSON.stringify(form) !== JSON.stringify(savedValue)
  const set = <K extends keyof BrandData>(k: K, v: BrandData[K]) => setForm((f) => ({ ...f, [k]: v }))

  /* Theo dõi mục đang xem để tô sáng menu trái */
  const rootRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const els = rootRef.current?.querySelectorAll<HTMLElement>('[data-section]')
    if (!els?.length) return
    const io = new IntersectionObserver(
      (entries) => {
        const vis = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)
        if (vis[0]) setActive((vis[0].target as HTMLElement).dataset.section!)
      },
      { rootMargin: '-10% 0px -70% 0px' },
    )
    els.forEach((el) => io.observe(el))
    return () => io.disconnect()
  }, [])

  const goTo = (id: string) => {
    setActive(id)
    document.getElementById(`bp-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  const toggleOwn = (v: boolean) => {
    if (v) {
      const start = clone(groupValue ?? form)
      setForm(start)
      setSavedValue(start)
      setOwn(true)
      if (page) page.brandSource = 'own'
      saved.set(keyOf(target), start)
      notify(`Đã sao chép hồ sơ của ${group?.name} làm điểm xuất phát`)
    } else setConfirmOff(true)
  }

  const backToGroup = () => {
    setOwn(false)
    setConfirmOff(false)
    if (page) page.brandSource = 'group'
    saved.delete(keyOf(target))
    notify(`Trang này giờ dùng hồ sơ của ${group?.name}`)
  }

  const save = () => {
    if (!form.name.trim()) {
      notify('Nhập tên thương hiệu trước khi lưu')
      goTo('co-ban')
      return
    }
    saved.set(keyOf(target), clone(form))
    setSavedValue(clone(form))
    if (target.kind === 'group') {
      const n = pagesInGroup(target.id).filter((p) => p.brandSource === 'group').length
      notify(`Đã lưu hồ sơ. ${n} trang đang dùng hồ sơ của ${group?.name}`)
    } else notify('Đã lưu hồ sơ thương hiệu')
  }

  const cancel = () => {
    setForm(clone(savedValue))
    notify('Đã huỷ thay đổi chưa lưu')
  }

  return (
    <div ref={rootRef}>
      {target.kind === 'page' && <InheritanceBar groupName={group?.name ?? null} own={own} onToggle={toggleOwn} what="hồ sơ thương hiệu" />}
      {target.kind === 'group' && group && (
        <div className="mb-5 rounded-md border border-border bg-slate-50 px-4 py-3 text-sm text-muted-foreground">
          Hồ sơ này là mặc định cho {pagesInGroup(group.id).length} trang trong <b className="text-foreground">{group.name}</b>. Trang nào bật “Dùng hồ sơ riêng” sẽ không bị ảnh hưởng.
        </div>
      )}

      <div className="grid grid-cols-[180px_minmax(0,1fr)_320px] items-start gap-5">
        {/* Menu mục con */}
        <nav className="sticky top-4 space-y-0.5" aria-label="Mục hồ sơ">
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => goTo(s.id)}
              className={cn(
                'block w-full rounded-md px-3 py-2 text-left text-sm font-medium transition-colors',
                active === s.id ? 'bg-primary-soft/70 text-primary-hover' : 'text-muted-foreground hover:bg-slate-100 hover:text-foreground',
              )}
            >
              {s.label}
            </button>
          ))}
        </nav>

        {/* Form */}
        <Card className="min-w-0">
          {!editable && (
            <div className="border-b border-border bg-slate-50 px-5 py-3 text-[13px] text-muted-foreground">
              Đang hiển thị hồ sơ của {group?.name} (chỉ xem). Bật “Dùng hồ sơ thương hiệu riêng” để sửa riêng cho trang này, hoặc{' '}
              <Link to={`/trang-nhom/nhom/${group?.id}`} className="font-medium text-primary hover:underline">
                sửa hồ sơ nhóm
              </Link>
              .
            </div>
          )}
          <fieldset disabled={!editable} className={cn(!editable && 'opacity-70')}>
            <Section id="co-ban" title="Thông tin cơ bản" hint="AI dùng các thông tin này khi viết bài và trả lời khách.">
              <div className="grid grid-cols-2 gap-4">
                <Field label="Tên thương hiệu">
                  <Input value={data.name} onChange={(e) => set('name', e.target.value)} placeholder="VD: Mỹ phẩm Lan Anh" />
                </Field>
                <Field label="Lĩnh vực">
                  <Select options={INDUSTRIES} value={data.industry} onChange={(e) => set('industry', e.target.value)} />
                </Field>
              </div>
              <Field label="Mô tả ngắn" hint={`${data.tagline.length}/120 ký tự`}>
                <Input value={data.tagline} maxLength={120} onChange={(e) => set('tagline', e.target.value)} placeholder="Một câu nói rõ bạn bán gì, cho ai" />
              </Field>
            </Section>

            <Section id="giong-dieu" title="Giọng điệu" hint="Chọn tối đa 3 giọng điệu chính.">
              <div>
                <span className="mb-1.5 block text-[13px] font-medium">Tính cách</span>
                <div className="flex flex-wrap gap-2">
                  {TONES.map((t) => {
                    const on = data.tones.includes(t)
                    return (
                      <button
                        key={t}
                        type="button"
                        aria-pressed={on}
                        onClick={() => {
                          if (on) set('tones', data.tones.filter((x) => x !== t))
                          else if (data.tones.length >= 3) notify('Chọn tối đa 3 giọng điệu')
                          else set('tones', [...data.tones, t])
                        }}
                        className={cn(
                          'rounded-full border px-3 py-1 text-[13px] font-medium transition-colors',
                          on ? 'border-primary bg-primary-soft text-primary-hover' : 'border-border bg-surface text-muted-foreground hover:text-foreground',
                        )}
                      >
                        {t}
                      </button>
                    )
                  })}
                </div>
              </div>
              <div>
                <div className="mb-1.5 flex items-center justify-between text-[13px] font-medium">
                  <span>Mức độ</span>
                  <span className="tabular text-xs text-muted-foreground">{data.formality}/100</span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={100}
                  step={5}
                  value={data.formality}
                  onChange={(e) => set('formality', Number(e.target.value))}
                  className="w-full accent-primary"
                  aria-label="Trang trọng ↔ Gần gũi"
                />
                <div className="mt-1 flex justify-between text-xs text-muted-foreground">
                  <span>Trang trọng</span>
                  <span>Gần gũi</span>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <Field label="Xưng hô">
                  <Select options={PRONOUNS} value={data.pronoun} onChange={(e) => set('pronoun', e.target.value)} />
                </Field>
                <div>
                  <span className="mb-1.5 block text-[13px] font-medium">Emoji</span>
                  <div className={cn(!editable && 'pointer-events-none')}>
                    <Segmented options={EMOJIS} value={data.emoji} onChange={(v) => set('emoji', v)} />
                  </div>
                </div>
              </div>
            </Section>

            <Section id="san-pham" title="Sản phẩm & dịch vụ" hint="AI chỉ báo giá theo danh sách này.">
              <div className="space-y-2">
                {data.products.length === 0 && <p className="text-sm text-muted-foreground">Chưa có sản phẩm. Thêm sản phẩm chủ lực để AI giới thiệu đúng.</p>}
                {data.products.map((p, i) => (
                  <div key={i} className="grid grid-cols-[minmax(0,1fr)_160px_36px] items-center gap-2">
                    <Input
                      value={p.name}
                      placeholder="Tên sản phẩm"
                      aria-label="Tên sản phẩm"
                      onChange={(e) => set('products', data.products.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
                    />
                    <Input
                      value={p.price}
                      placeholder="Giá, VD: 250.000đ"
                      aria-label="Giá"
                      className="tabular"
                      onChange={(e) => set('products', data.products.map((x, j) => (j === i ? { ...x, price: e.target.value } : x)))}
                    />
                    <button
                      type="button"
                      onClick={() => set('products', data.products.filter((_, j) => j !== i))}
                      className="flex size-9 items-center justify-center rounded-md text-muted-foreground hover:bg-red-50 hover:text-danger disabled:hidden"
                      aria-label={`Xoá ${p.name || 'sản phẩm'}`}
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                ))}
              </div>
              {editable && (
                <Button size="sm" variant="ghost" icon={<Plus size={15} />} onClick={() => set('products', [...data.products, { name: '', price: '' }])}>
                  Thêm sản phẩm
                </Button>
              )}
            </Section>

            <Section id="khach-hang" title="Khách hàng mục tiêu">
              <Field label="Mô tả khách hàng" hint="Độ tuổi, nghề nghiệp, nhu cầu, nỗi lo thường gặp.">
                <Textarea rows={3} value={data.audience} onChange={(e) => set('audience', e.target.value)} placeholder="VD: Nữ 22–35 tuổi, dân văn phòng, da dầu…" />
              </Field>
            </Section>

            <Section id="hinh-anh" title="Hình ảnh thương hiệu" hint="Dùng khi AI tạo ảnh và gợi ý hashtag.">
              <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-5">
                <div>
                  <span className="mb-1.5 block text-[13px] font-medium">Logo</span>
                  <label
                    className={cn(
                      'flex size-28 flex-col items-center justify-center gap-1 overflow-hidden rounded-lg border border-dashed border-slate-300 bg-slate-50 text-center text-xs text-muted-foreground',
                      editable && 'cursor-pointer hover:border-primary hover:text-primary',
                    )}
                  >
                    {data.logo ? (
                      <img src={data.logo} alt="Logo" className="size-full object-contain" />
                    ) : (
                      <>
                        <ImagePlus size={20} />
                        Tải logo lên
                        <span className="text-[11px]">PNG, SVG ≤ 2MB</span>
                      </>
                    )}
                    <input
                      type="file"
                      accept="image/*"
                      className="sr-only"
                      onChange={(e) => {
                        const f = e.target.files?.[0]
                        if (f) set('logo', URL.createObjectURL(f))
                      }}
                    />
                  </label>
                  {data.logo && editable && (
                    <button type="button" onClick={() => set('logo', null)} className="mt-1 text-xs text-muted-foreground hover:text-danger">
                      Gỡ logo
                    </button>
                  )}
                </div>
                <div className="space-y-4">
                  <div>
                    <span className="mb-1.5 block text-[13px] font-medium">Màu thương hiệu</span>
                    <div className="flex flex-wrap items-center gap-2">
                      {data.colors.map((c, i) => (
                        <span key={`${c}-${i}`} className="group relative">
                          <span className="block size-9 rounded-md border border-border" style={{ backgroundColor: c }} title={c} />
                          {editable && (
                            <button
                              type="button"
                              onClick={() => set('colors', data.colors.filter((_, j) => j !== i))}
                              className="absolute -top-1.5 -right-1.5 hidden rounded-full border border-border bg-surface p-0.5 text-muted-foreground group-hover:block"
                              aria-label={`Xoá màu ${c}`}
                            >
                              <X size={10} />
                            </button>
                          )}
                        </span>
                      ))}
                      {editable && data.colors.length < 6 && (
                        <label className="flex size-9 cursor-pointer items-center justify-center rounded-md border border-dashed border-slate-300 text-muted-foreground hover:border-primary hover:text-primary" title="Thêm màu">
                          <Plus size={16} />
                          <input type="color" className="sr-only" onChange={(e) => set('colors', [...data.colors, e.target.value.toUpperCase()])} />
                        </label>
                      )}
                    </div>
                  </div>
                  <div>
                    <span className="mb-1.5 block text-[13px] font-medium">Hashtag mặc định</span>
                    <TagEditor values={data.hashtags} onChange={(v) => set('hashtags', v.map((h) => (h.startsWith('#') ? h : `#${h}`)))} placeholder="Gõ rồi Enter" tone="neutral" disabled={!editable} />
                  </div>
                </div>
              </div>
            </Section>

            <Section id="tranh" title="Điều cần tránh" hint="AI sẽ không bao giờ dùng các từ này trong bài viết và tin nhắn.">
              <div>
                <span className="mb-1.5 block text-[13px] font-medium">Từ cấm</span>
                <TagEditor values={data.banned} onChange={(v) => set('banned', v)} placeholder="VD: cam kết 100%" tone="danger" disabled={!editable} />
              </div>
            </Section>
          </fieldset>
        </Card>

        {/* Xem trước */}
        <VoicePreview data={data} pageName={page?.name ?? data.name} page={page} />
      </div>

      {/* Footer cố định */}
      <div className="sticky bottom-0 z-10 -mx-6 mt-6 flex items-center justify-end gap-3 border-t border-border bg-surface/95 px-6 py-3 backdrop-blur">
        {editable ? (
          <>
            <span className="mr-auto text-[13px] text-muted-foreground">{dirty ? '● Có thay đổi chưa lưu' : 'Đã lưu mọi thay đổi'}</span>
            <Button onClick={cancel} disabled={!dirty}>
              Huỷ
            </Button>
            <Button variant="primary" onClick={save}>
              Lưu hồ sơ
            </Button>
          </>
        ) : (
          <>
            <span className="mr-auto text-[13px] text-muted-foreground">Trang này đang theo hồ sơ nhóm, không cần lưu.</span>
            <Link
              to={`/trang-nhom/nhom/${group?.id}`}
              className="inline-flex h-9 items-center rounded-md border border-border bg-surface px-4 text-sm font-medium hover:bg-slate-50"
            >
              Mở hồ sơ nhóm
            </Link>
          </>
        )}
      </div>

      <Modal
        open={confirmOff}
        onClose={() => setConfirmOff(false)}
        title="Bỏ hồ sơ riêng?"
        width={440}
        footer={
          <>
            <Button onClick={() => setConfirmOff(false)}>Giữ hồ sơ riêng</Button>
            <Button variant="danger" onClick={backToGroup}>
              Bỏ và dùng hồ sơ nhóm
            </Button>
          </>
        }
      >
        <p className="text-sm">
          Hồ sơ riêng của trang này sẽ bị xoá. Trang sẽ dùng lại hồ sơ của <b>{group?.name}</b>. Không thể hoàn tác.
        </p>
      </Modal>
    </div>
  )
}

/* ---------- Khung xem trước giọng văn ---------- */

function VoicePreview({ data, pageName, page }: { data: BrandData; pageName: string; page?: Page }) {
  const { openAiKeySet } = useApp()
  const [state, setState] = useState<'idle' | 'writing' | 'done'>('idle')
  const [text, setText] = useState('')
  const [variant, setVariant] = useState(0)
  const timer = useRef<number | undefined>(undefined)

  useEffect(() => () => window.clearTimeout(timer.current), [])

  const run = () => {
    setState('writing')
    const v = state === 'done' ? variant + 1 : variant
    setVariant(v)
    timer.current = window.setTimeout(() => {
      setText(writeSample(data, v))
      setState('done')
    }, 1100)
  }
  const stop = () => {
    window.clearTimeout(timer.current)
    setState(text ? 'done' : 'idle')
  }

  return (
    <Card className="sticky top-4">
      <CardHeader title="Xem trước giọng văn" subtitle="AI viết thử một bài theo hồ sơ hiện tại." />
      <div className="space-y-4 p-4">
        <dl className="space-y-1.5 text-xs">
          <div className="flex justify-between gap-2">
            <dt className="text-muted-foreground">Giọng điệu</dt>
            <dd className="text-right font-medium">{data.tones.join(', ') || 'Chưa chọn'}</dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt className="text-muted-foreground">Xưng hô</dt>
            <dd className="font-medium">{data.pronoun}</dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt className="text-muted-foreground">Emoji</dt>
            <dd className="font-medium">{data.emoji}</dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt className="text-muted-foreground">Mức độ</dt>
            <dd className="font-medium">{data.formality >= 75 ? 'Rất gần gũi' : data.formality >= 55 ? 'Gần gũi' : data.formality >= 30 ? 'Cân bằng' : 'Trang trọng'}</dd>
          </div>
        </dl>

        {state === 'writing' ? (
          <div className="rounded-md border border-ai/30 bg-ai-soft/60 p-3">
            <div className="flex items-center justify-between text-[13px] font-medium text-ai">
              <span className="flex items-center gap-2">
                <span className="size-2 animate-pulse rounded-full bg-ai" />
                AI đang viết…
              </span>
              <button type="button" onClick={stop} className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs hover:bg-ai/10">
                <Square size={11} /> Dừng
              </button>
            </div>
            <div className="mt-3 space-y-2">
              <div className="h-2.5 w-11/12 animate-pulse rounded bg-ai/15" />
              <div className="h-2.5 w-full animate-pulse rounded bg-ai/15" />
              <div className="h-2.5 w-3/4 animate-pulse rounded bg-ai/15" />
            </div>
          </div>
        ) : state === 'done' ? (
          <div className="rounded-md border border-border">
            <div className="flex items-center justify-between border-b border-border px-3 py-2">
              <span className="flex min-w-0 items-center gap-2 text-[13px] font-medium">
                {page && <PageAvatar page={page} size={22} />}
                <span className="truncate">{pageName || 'Thương hiệu của bạn'}</span>
              </span>
              <AiBadge />
            </div>
            <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={9} className="rounded-none border-0 text-[13px] leading-relaxed focus:ring-0" aria-label="Bài viết thử" />
          </div>
        ) : (
          <div className="rounded-md border border-dashed border-slate-300 px-3 py-6 text-center text-[13px] text-muted-foreground">Bấm “Viết thử bằng AI” để xem AI viết theo giọng của bạn.</div>
        )}

        <AiLockHint locked={!openAiKeySet} className="flex w-full">
          <Button variant="ai" className="w-full" onClick={run} disabled={state === 'writing' || !openAiKeySet}>
            {state === 'done' ? 'Viết lại bằng AI' : 'Viết thử bằng AI'}
          </Button>
        </AiLockHint>
        {state === 'done' && data.banned.length > 0 && <p className="text-center text-xs text-muted-foreground">Đã tránh {data.banned.length} từ cấm trong hồ sơ.</p>}
      </div>
    </Card>
  )
}
