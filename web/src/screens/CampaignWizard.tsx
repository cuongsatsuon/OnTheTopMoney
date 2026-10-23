// Tạo chiến dịch `/chien-dich/tao` (Story 7.1): wizard bước 1–3 trên trang / nhóm thật — mục tiêu + thời lượng, trang
// đích (nhóm hoặc từng trang, tần suất riêng; trang mất kết nối / thiếu hồ sơ mờ kèm lý do), chủ đề + tỉ lệ, khung giờ,
// tỉ lệ ảnh AI, chế độ duyệt. Sang bước 4 thì lưu nháp (`POST`/`PUT /campaigns`, URL thành `?id=<id>` để mở lại);
// lỗi validate (web kiểm sớm bằng schema shared, server kiểm lại) về đúng bước, báo dưới ô.
// Bước 4 (xem trước 7 bài — Story 7.2) và "Bắt đầu chiến dịch" (Story 7.3) khoá kèm "Sắp có".
import { type CampaignDuration, type CampaignFrequency, type CampaignGoal, type PageDto, CAMPAIGN_FREQUENCIES } from '@ottm/shared'
import { ArrowLeft, ArrowRight, Check, CircleCheck, ImageIcon, MessageCircleHeart, Plus, Rocket, ShieldCheck, ShoppingBag, Sparkles, UserPlus, X, Zap } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { Content } from '../components/AppShell'
import { Skeleton } from '../components/Skeleton'
import { Button, Card, CardHeader, Chip, Field, GroupChip, Input, PageAvatar, PageHeader, PageLabel, Segmented, Select, StatusChip, cn } from '../components/ui'
import { useApp } from '../lib/app-context'
import {
  BLOCK_REASON_TEXT,
  CAMPAIGN_PARAM,
  FREQUENCY_LABEL,
  GOALS,
  NO_ERRORS,
  PLAN_DAYS,
  TOPIC_SUGGESTIONS,
  WIZARD_STEPS,
  activePages,
  addDaysKey,
  autoName,
  blockReasonOf,
  buildCampaignBody,
  dailyPlan,
  dayLabel,
  formFromCampaign,
  frequencyOf,
  goalOf,
  hasInstagram,
  initialForm,
  planTotals,
  serverCampaignErrors,
  shortDay,
  splitEven,
  stepHasErrors,
  targetPages,
  topicSum,
  useCampaign,
  useCampaignPageOptions,
  useSaveCampaign,
  validateCampaign,
  type CampaignErrors,
  type CampaignForm,
  type PageOptions,
} from '../lib/campaigns'
import { todayKey } from '../lib/calendar'
import { toUiPage, usePages } from '../lib/connections'
import { errorMessageOf } from '../lib/error-messages'
import { useGroups } from '../lib/groups'

const GOAL_ICON: Record<CampaignGoal, ReactNode> = {
  engage: <MessageCircleHeart size={20} />,
  follow: <UserPlus size={20} />,
  sell: <ShoppingBag size={20} />,
  launch: <Rocket size={20} />,
}
const DEFAULT_OPTION = 'default'
const NO_OPTIONS: PageOptions = new Map()
const FREQ_OPTIONS = CAMPAIGN_FREQUENCIES.map((f) => ({ value: f, label: FREQUENCY_LABEL[f] }))

/* ---------- Màn hình ---------- */

export default function CampaignWizard() {
  const { notify, scope } = useApp()
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const campaignId = params.get(CAMPAIGN_PARAM)
  const pagesQuery = usePages()
  const groupsQuery = useGroups()
  const optionsQuery = useCampaignPageOptions()
  const campaignQuery = useCampaign(campaignId)
  const save = useSaveCampaign()

  const [step, setStep] = useState(1)
  const [maxStep, setMaxStep] = useState(1)
  const [form, setForm] = useState<CampaignForm | null>(null)
  /** Nháp đã nạp vào form: `'new'` hoặc id. Lưu nháp mới đổi `?id=` nhưng đặt trước nên không nạp lại. */
  const [loadedKey, setLoadedKey] = useState<string | null>(null)
  /**
   * Nháp vừa tạo mà URL chưa kịp có `?id=`: router v7 đổi URL trong transition (ưu tiên thấp) nên có một lần render
   * `campaignId` còn `null` trong khi `loadedKey` đã là id mới — không chờ thì form bị nạp lại thành chiến dịch mới
   * (mất dữ liệu đã nhập, về bước 1).
   */
  const [createdId, setCreatedId] = useState<string | null>(null)
  /** Lỗi đang hiện dưới ô — chỉ sau khi bấm "Tiếp tục" (tổng tỉ lệ có dòng trạng thái riêng, luôn hiện). */
  const [errors, setErrors] = useState<CampaignErrors>(NO_ERRORS)
  const [newTopic, setNewTopic] = useState('')
  const [newTime, setNewTime] = useState('08:00')

  const allPages = pagesQuery.data ?? []
  const groupList = groupsQuery.data ?? []
  const options: PageOptions = optionsQuery.data ?? NO_OPTIONS

  // Nạp form ngay khi đủ dữ liệu (trong lúc render, không qua effect): mới → theo Phạm vi; `?id=` → nháp đã lưu.
  const initKey = campaignId ?? 'new'
  if (createdId !== null && campaignId === createdId) setCreatedId(null)
  const awaitingUrl = createdId !== null && campaignId !== createdId
  if (!awaitingUrl && loadedKey !== initKey && groupsQuery.data && (!campaignId || campaignQuery.data)) {
    setForm(campaignId && campaignQuery.data ? formFromCampaign(campaignQuery.data) : initialForm(scope, groupsQuery.data))
    setErrors(NO_ERRORS)
    setStep(1)
    setMaxStep(campaignId ? 3 : 1)
    setLoadedKey(initKey)
  }

  // Nháp không mở được (id sai / đã xoá) → báo và quay về chiến dịch mới. Chỉ khi chưa có dữ liệu: lần tải lại
  // (focus cửa sổ, sự kiện `page.*`) lỗi thì giữ nguyên form đang sửa, không xoá `?id=`.
  useEffect(() => {
    if (!campaignId || !campaignQuery.isError || campaignQuery.data) return
    notify(errorMessageOf(campaignQuery.error))
    setParams(
      (p) => {
        p.delete(CAMPAIGN_PARAM)
        return p
      },
      { replace: true },
    )
  }, [campaignId, campaignQuery.isError, campaignQuery.error, campaignQuery.data, notify, setParams])

  if (!form || pagesQuery.isPending || optionsQuery.isPending) return <WizardSkeleton />

  const status = campaignQuery.data?.status
  if (status && status !== 'draft') {
    return (
      <Content>
        <PageHeader breadcrumb={<Link to="/chien-dich">Chiến dịch nuôi page</Link>} title="Tạo chiến dịch" />
        <Card className="p-8 text-center text-sm text-muted-foreground">Chiến dịch này đã bắt đầu — không sửa cấu hình ở đây được nữa.</Card>
      </Content>
    )
  }

  const goal = goalOf(form.goal)
  const endDate = addDaysKey(form.startDate, form.durationDays - 1)
  const shown = targetPages(form, allPages)
  const active = activePages(form, allPages, options)
  const skipped = shown.length - active.length
  const plan = dailyPlan(form, active)
  const totals = planTotals(form, active)
  const maxPerDay = Math.max(1, ...plan)
  const sum = topicSum(form.topics)
  const name = form.name.trim() || autoName(form, active, groupList)
  const body = buildCampaignBody(form, active, name)
  const withIg = hasInstagram(active)

  /* --- Hành động --- */
  // Sửa bất kỳ ô nào → bỏ lỗi đang hiện (kiểm lại ở lần bấm "Tiếp tục" kế tiếp, tổng tỉ lệ vẫn hiện trực tiếp).
  const update = (patch: Partial<CampaignForm>) => {
    setForm((f) => (f ? { ...f, ...patch } : f))
    setErrors(NO_ERRORS)
  }
  const chooseGoal = (id: CampaignGoal) => update(form.topicsTouched ? { goal: id } : { goal: id, topics: goalOf(id).topics })
  const editTopics = (fn: (t: CampaignForm['topics']) => CampaignForm['topics']) => update({ topics: fn(form.topics), topicsTouched: true })
  const addTopic = (label: string) => {
    const t = label.trim()
    if (!t || form.topics.some((x) => x.name.toLowerCase() === t.toLowerCase())) return
    editTopics((all) => [...all, { name: t, share: 0 }])
    setNewTopic('')
  }
  const addTime = () => {
    if (!newTime || form.postTimes.includes(newTime)) return
    update({ postTimes: [...form.postTimes, newTime].sort() })
  }
  const togglePicked = (pageId: string) =>
    update({ picked: form.picked.includes(pageId) ? form.picked.filter((id) => id !== pageId) : [...form.picked, pageId] })
  const setOverride = (pageId: string, value: string) => {
    const next = { ...form.overrides }
    if (value === DEFAULT_OPTION) delete next[pageId]
    else next[pageId] = value as CampaignFrequency
    update({ overrides: next })
  }

  const show = (s: number) => {
    setStep(s)
    setMaxStep((m) => Math.max(m, s))
  }

  /** Sang bước `target`: chặn nếu bước trước còn lỗi; vào bước 4 = lưu nháp (server kiểm lại). */
  const goTo = (target: number) => {
    if (target <= step) {
      show(target)
      return
    }
    const local = validateCampaign(body)
    setErrors(local)
    if (local.step !== null && local.step < target) {
      show(local.step)
      return
    }
    if (target < 4) {
      show(target)
      return
    }
    save.mutate(
      { id: campaignId, body },
      {
        onSuccess: (saved) => {
          setErrors(NO_ERRORS)
          if (saved.id !== campaignId) {
            setCreatedId(saved.id)
            setLoadedKey(saved.id)
            setParams(
              (p) => {
                p.set(CAMPAIGN_PARAM, saved.id)
                return p
              },
              { replace: true },
            )
          }
          show(4)
        },
        onError: (err) => {
          const fromServer = serverCampaignErrors(err, body)
          if (fromServer) {
            setErrors(fromServer)
            show(fromServer.step!)
          } else notify(errorMessageOf(err))
        },
      },
    )
  }

  const stepBlocked = stepHasErrors(errors, step)

  return (
    <Content className="pb-0">
      <PageHeader
        breadcrumb={
          <Link to="/chien-dich" className="hover:text-foreground">
            Chiến dịch nuôi page
          </Link>
        }
        title="Tạo chiến dịch"
        subtitle="AI viết và đăng bài đều đặn theo mục tiêu, trang và lịch bạn chọn."
        actions={campaignId ? <Chip>Bản nháp đã lưu</Chip> : undefined}
      />

      {/* Stepper */}
      <ol className="mb-6 flex items-center gap-2">
        {WIZARD_STEPS.map((label, i) => {
          const n = i + 1
          const done = n < step
          const current = n === step
          const reachable = n <= maxStep && n !== step && !save.isPending
          return (
            <li key={label} className="flex flex-1 items-center gap-2">
              <button
                disabled={!reachable}
                onClick={() => goTo(n)}
                className={cn('flex items-center gap-2.5 rounded-md px-1 py-1 text-left', reachable && 'hover:bg-slate-100')}
                aria-current={current ? 'step' : undefined}
              >
                <span
                  className={cn(
                    'flex size-7 shrink-0 items-center justify-center rounded-full text-[13px] font-semibold',
                    done && 'bg-primary text-white',
                    current && 'bg-primary-soft text-primary ring-2 ring-primary',
                    !done && !current && 'border border-border bg-surface text-muted-foreground',
                  )}
                >
                  {done ? <Check size={14} /> : n}
                </span>
                <span className={cn('text-sm font-medium whitespace-nowrap', current ? 'text-foreground' : 'text-muted-foreground')}>{label}</span>
              </button>
              {n < WIZARD_STEPS.length && <span className={cn('h-px flex-1', n < step ? 'bg-primary' : 'bg-border')} />}
            </li>
          )
        })}
      </ol>

      <div className="grid grid-cols-[minmax(0,1fr)_340px] items-start gap-4">
        <div className="min-w-0">
          {/* ---------- Bước 1 ---------- */}
          {step === 1 && (
            <Card>
              <CardHeader title="Bạn muốn chiến dịch đạt điều gì?" subtitle="AI chọn chủ đề và giọng bài theo mục tiêu này" />
              <div className="space-y-6 p-4">
                <div role="radiogroup" aria-label="Mục tiêu" className="grid grid-cols-2 gap-3">
                  {GOALS.map((g) => (
                    <RadioCard key={g.id} checked={form.goal === g.id} onSelect={() => chooseGoal(g.id)} icon={GOAL_ICON[g.id]} title={g.label}>
                      {g.desc}
                    </RadioCard>
                  ))}
                </div>
                <div className="flex flex-wrap items-start gap-6">
                  <div>
                    <span className="mb-1.5 block text-[13px] font-medium">Thời lượng</span>
                    <Segmented
                      options={[
                        { id: '7', label: '7 ngày' },
                        { id: '14', label: '14 ngày' },
                        { id: '30', label: '30 ngày' },
                      ]}
                      value={String(form.durationDays) as '7' | '14' | '30'}
                      onChange={(v) => update({ durationDays: Number(v) as CampaignDuration })}
                    />
                    <FieldError message={errors.fields.durationDays} />
                  </div>
                  <Field label="Ngày bắt đầu" className="w-[180px]">
                    <Input type="date" value={form.startDate} min={todayKey()} onChange={(e) => e.target.value && update({ startDate: e.target.value })} />
                    <FieldError message={errors.fields.startDate} />
                  </Field>
                  <p className="pt-8 text-[13px] text-muted-foreground">Kết thúc {dayLabel(endDate, true)}</p>
                </div>
              </div>
            </Card>
          )}

          {/* ---------- Bước 2 ---------- */}
          {step === 2 && (
            <div className="space-y-4">
              <Card>
                <CardHeader
                  title="Đăng lên trang nào?"
                  subtitle="Chọn cả nhóm hoặc từng trang. Trang mất kết nối hoặc chưa có hồ sơ thương hiệu không chọn được."
                  action={
                    <Segmented
                      options={[
                        { id: 'group', label: 'Theo nhóm' },
                        { id: 'pages', label: 'Chọn từng trang' },
                      ]}
                      value={form.targetMode}
                      onChange={(v) => update({ targetMode: v })}
                    />
                  }
                />
                <div className="p-4">
                  {allPages.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      Chưa có trang nào.{' '}
                      <Link to="/trang-nhom" className="font-medium text-primary hover:underline">
                        Kết nối trang
                      </Link>{' '}
                      trước khi tạo chiến dịch.
                    </p>
                  ) : form.targetMode === 'group' ? (
                    groupList.length === 0 ? (
                      <p className="text-sm text-muted-foreground">Chưa có nhóm nào — chuyển sang “Chọn từng trang”.</p>
                    ) : (
                      <div role="radiogroup" aria-label="Nhóm" className="grid grid-cols-3 gap-3">
                        {groupList.map((g) => {
                          const members = allPages.filter((p) => p.groupId === g.id)
                          const usable = members.filter((p) => blockReasonOf(options, p.id) === null).length
                          return (
                            <RadioCard key={g.id} checked={form.groupId === g.id} onSelect={() => update({ groupId: g.id })} title={<GroupChip groupId={g.id} />}>
                              <span className="mt-2 flex items-center gap-2">
                                <span className="flex -space-x-1.5">
                                  {members.map((p) => (
                                    <span key={p.id} className="rounded-full ring-2 ring-white">
                                      <PageAvatar page={toUiPage(p)} size={24} />
                                    </span>
                                  ))}
                                </span>
                                {usable === members.length ? `${members.length} trang` : `${usable}/${members.length} trang chọn được`}
                              </span>
                            </RadioCard>
                          )
                        })}
                      </div>
                    )
                  ) : (
                    <div className="grid grid-cols-2 gap-2">
                      {allPages.map((p) => {
                        const reason = blockReasonOf(options, p.id)
                        const on = form.picked.includes(p.id) && !reason
                        return (
                          <label
                            key={p.id}
                            className={cn(
                              'flex items-center gap-3 rounded-md border px-3 py-2.5',
                              reason ? 'cursor-not-allowed border-border bg-slate-50 opacity-70' : 'cursor-pointer',
                              on ? 'border-primary bg-primary-soft/30' : !reason && 'border-border hover:bg-slate-50',
                            )}
                          >
                            <input type="checkbox" className="size-4 accent-primary" checked={on} disabled={!!reason} onChange={() => togglePicked(p.id)} />
                            <PageLabel
                              page={toUiPage(p)}
                              sub={reason ? <span className="text-danger">{BLOCK_REASON_TEXT[reason]}</span> : p.groupId ? undefined : 'Chưa có nhóm'}
                            />
                          </label>
                        )
                      })}
                    </div>
                  )}
                  <FieldError message={errors.fields.groupId ?? errors.fields.pages} />
                </div>
              </Card>

              <Card>
                <CardHeader
                  title="Tần suất đăng"
                  subtitle="Mặc định cho mọi trang; đặt riêng cho trang cần đăng nhiều hoặc ít hơn"
                  action={
                    <label className="flex items-center gap-2 text-[13px] font-medium whitespace-nowrap">
                      Mặc định
                      <Select
                        options={FREQ_OPTIONS}
                        value={form.defaultFrequency}
                        onChange={(e) => update({ defaultFrequency: e.target.value as CampaignFrequency })}
                        className="w-[140px]"
                      />
                    </label>
                  }
                />
                {shown.length === 0 ? (
                  <p className="p-4 text-sm text-muted-foreground">Chọn ít nhất 1 trang để đặt tần suất.</p>
                ) : (
                  <div className="divide-y divide-border">
                    {shown.map((p) => (
                      <FrequencyRow
                        key={p.id}
                        page={p}
                        reason={blockReasonOf(options, p.id)}
                        override={form.overrides[p.id] ?? null}
                        error={errors.pages[p.id]}
                        onChange={(v) => setOverride(p.id, v)}
                      />
                    ))}
                  </div>
                )}
              </Card>
            </div>
          )}

          {/* ---------- Bước 3 ---------- */}
          {step === 3 && (
            <div className="space-y-4">
              <Card>
                <CardHeader title="Nội dung" subtitle="Chủ đề và tỉ lệ AI sẽ xoay vòng" />
                <div className="space-y-5 p-4">
                  <Field label="Tên chiến dịch">
                    <Input value={form.name} placeholder={autoName(form, active, groupList)} onChange={(e) => update({ name: e.target.value })} />
                    <FieldError message={errors.fields.name} />
                  </Field>

                  <div>
                    <div className="mb-1.5 flex items-center justify-between">
                      <span className="text-[13px] font-medium">Chủ đề & tỉ lệ</span>
                      <Button size="sm" variant="ghost" onClick={() => editTopics(splitEven)} disabled={!form.topics.length}>
                        Chia đều
                      </Button>
                    </div>
                    <div className="space-y-2">
                      {form.topics.map((t, i) => (
                        <div key={t.name} className="flex items-center gap-3">
                          <span className="w-44 truncate rounded-full bg-primary-soft/60 px-3 py-1 text-[13px] font-medium text-primary-hover">{t.name}</span>
                          <div className="h-2 flex-1 overflow-hidden rounded-full bg-slate-100">
                            <div className="h-full rounded-full bg-primary/70" style={{ width: `${Math.min(100, t.share)}%` }} />
                          </div>
                          <div className="flex items-center gap-1">
                            <Input
                              type="number"
                              min={0}
                              max={100}
                              value={Number.isFinite(t.share) ? t.share : ''}
                              onChange={(e) => editTopics((all) => all.map((x, j) => (j === i ? { ...x, share: e.target.value === '' ? 0 : Math.round(Number(e.target.value)) } : x)))}
                              className="tabular w-[72px] text-right"
                              aria-label={`Tỉ lệ ${t.name}`}
                            />
                            <span className="text-sm text-muted-foreground">%</span>
                          </div>
                          <button
                            onClick={() => editTopics((all) => all.filter((_, j) => j !== i))}
                            className="rounded p-1 text-muted-foreground hover:bg-slate-100 hover:text-foreground"
                            aria-label={`Bỏ chủ đề ${t.name}`}
                          >
                            <X size={15} />
                          </button>
                        </div>
                      ))}
                    </div>
                    <div className={cn('mt-2 text-[13px] font-medium', sum === 100 && !errors.fields.topics ? 'text-success' : 'text-danger')} role="status">
                      {errors.fields.topics ??
                        (sum === 100 ? '✓ Tổng 100%' : `Tổng ${sum}% — cần đúng 100% (${sum > 100 ? `bớt ${sum - 100}%` : `thêm ${100 - sum}%`})`)}
                    </div>
                    <div className="mt-3 flex gap-2">
                      <Input
                        value={newTopic}
                        onChange={(e) => setNewTopic(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && addTopic(newTopic)}
                        placeholder="Thêm chủ đề…"
                        className="max-w-[240px]"
                      />
                      <Button size="sm" className="h-9" icon={<Plus size={14} />} onClick={() => addTopic(newTopic)} disabled={!newTopic.trim()}>
                        Thêm
                      </Button>
                    </div>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {TOPIC_SUGGESTIONS.filter((s) => !form.topics.some((t) => t.name === s)).map((s) => (
                        <button
                          key={s}
                          onClick={() => addTopic(s)}
                          className="rounded-full border border-dashed border-border px-2.5 py-0.5 text-xs text-muted-foreground hover:border-primary hover:text-primary"
                        >
                          + {s}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              </Card>

              <Card>
                <CardHeader title="Lịch & chế độ đăng" />
                <div className="space-y-5 p-4">
                  <div>
                    <span className="mb-1.5 block text-[13px] font-medium">Khung giờ đăng</span>
                    <div className="flex flex-wrap items-center gap-2">
                      {form.postTimes.map((t) => (
                        <span key={t} className="tabular inline-flex items-center gap-1 rounded-full border border-border bg-surface py-1 pr-1 pl-3 text-[13px] font-medium">
                          {t}
                          <button
                            onClick={() => update({ postTimes: form.postTimes.filter((x) => x !== t) })}
                            className="rounded-full p-0.5 text-muted-foreground hover:bg-slate-100"
                            aria-label={`Bỏ giờ ${t}`}
                          >
                            <X size={13} />
                          </button>
                        </span>
                      ))}
                      <Input type="time" value={newTime} onChange={(e) => setNewTime(e.target.value)} className="w-[110px]" aria-label="Giờ mới" />
                      <Button size="sm" className="h-9" icon={<Plus size={14} />} onClick={addTime} disabled={!newTime || form.postTimes.includes(newTime)}>
                        Thêm giờ
                      </Button>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">Giờ Việt Nam. Mỗi trang đăng tối đa một bài ở mỗi khung giờ.</p>
                    <FieldError message={errors.fields.postTimes ?? (form.postTimes.length === 0 ? 'Thêm ít nhất 1 khung giờ' : undefined)} />
                  </div>

                  <div>
                    <div className="mb-1.5 flex items-center justify-between text-[13px]">
                      <span className="font-medium">Bài có ảnh AI</span>
                      <span className="tabular font-semibold text-ai">{form.imageRatio}%</span>
                    </div>
                    <input
                      type="range"
                      min={0}
                      max={100}
                      step={10}
                      value={form.imageRatio}
                      onChange={(e) => update({ imageRatio: Number(e.target.value) })}
                      className="w-full accent-ai"
                      aria-label="Tỉ lệ bài có ảnh AI"
                    />
                    <p className="mt-1 text-xs text-muted-foreground">Ảnh làm chi phí mỗi bài cao hơn nhưng thường tăng tương tác.</p>
                    {withIg && (
                      <p className="mt-1.5 flex items-center gap-1.5 text-xs font-medium text-slate-700">
                        <ImageIcon size={13} className="text-ai" /> Instagram luôn cần ảnh — bài trên trang Instagram luôn kèm ảnh AI.
                      </p>
                    )}
                    <FieldError message={errors.fields.imageRatio} />
                  </div>

                  <div>
                    <span className="mb-1.5 block text-[13px] font-medium">Chế độ đăng</span>
                    <div role="radiogroup" aria-label="Chế độ đăng" className="grid grid-cols-2 gap-3">
                      <RadioCard
                        checked={form.mode === 'review'}
                        onSelect={() => update({ mode: 'review' })}
                        icon={<ShieldCheck size={20} />}
                        title={
                          <span className="flex items-center gap-2">
                            Duyệt trước khi đăng <Chip tone="primary">Khuyên dùng</Chip>
                          </span>
                        }
                      >
                        AI viết sẵn, bạn duyệt từng bài trong mục “Bài chờ duyệt”. Bài chưa duyệt sẽ không đăng.
                      </RadioCard>
                      <RadioCard checked={form.mode === 'auto'} onSelect={() => update({ mode: 'auto' })} icon={<Zap size={20} />} title="Tự đăng hoàn toàn">
                        AI tự viết và đăng đúng giờ. Bạn vẫn có thể tạm dừng hoặc sửa bài trên Lịch.
                      </RadioCard>
                    </div>
                  </div>
                </div>
              </Card>
            </div>
          )}

          {/* ---------- Bước 4 ---------- */}
          {step === 4 && (
            <Card>
              <CardHeader title="Duyệt 7 bài đầu" subtitle="Xem trước giọng văn. Sửa, xoá hoặc tạo lại từng bài; phần còn lại AI viết theo cùng cấu hình." />
              <div className="space-y-4 p-4">
                <div className="flex items-start gap-3 rounded-md border border-green-200 bg-green-50/60 px-4 py-3 text-sm">
                  <CircleCheck size={18} className="mt-0.5 shrink-0 text-success" />
                  <div>
                    <div className="font-medium">Đã lưu bản nháp “{name}”</div>
                    <div className="mt-0.5 text-[13px] text-muted-foreground">Quay lại các bước trước để chỉnh; mỗi lần sang bước này cấu hình được lưu lại.</div>
                  </div>
                </div>
                <div className="flex items-start gap-3 rounded-md border border-dashed border-border px-4 py-6 text-sm text-muted-foreground">
                  <Sparkles size={18} className="mt-0.5 shrink-0 text-ai" />
                  <div>
                    <div className="font-medium text-foreground">
                      Xem trước 7 bài đầu <Chip className="ml-1">Sắp có</Chip>
                    </div>
                    <div className="mt-0.5 text-[13px]">AI sẽ viết trước 7 bài đầu theo Hồ sơ thương hiệu của từng trang để bạn sửa, xoá hoặc tạo lại trước khi bắt đầu.</div>
                  </div>
                </div>
              </div>
            </Card>
          )}
        </div>

        {/* ---------- Tóm tắt ---------- */}
        <Card className="sticky top-4">
          <CardHeader title="Tóm tắt" />
          <div className="space-y-4 p-4 text-sm">
            <SummaryRow label="Mục tiêu">{goal.label}</SummaryRow>
            <SummaryRow label="Thời gian">
              {form.durationDays} ngày · {shortDay(form.startDate)} → {shortDay(endDate)}
            </SummaryRow>
            <div>
              <div className="mb-1.5 flex items-center justify-between">
                <span className="text-muted-foreground">Trang</span>
                <span className="font-medium">{active.length} trang</span>
              </div>
              {active.length > 0 ? (
                <div className="flex flex-wrap gap-1.5">
                  {active.map((p) => (
                    <span key={p.id} title={`${p.name} · ${FREQUENCY_LABEL[frequencyOf(form, p.id)]}`}>
                      <PageAvatar page={toUiPage(p)} size={26} />
                    </span>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">Chưa chọn trang</p>
              )}
              {skipped > 0 && <p className="mt-1.5 text-xs text-danger">Bỏ qua {skipped} trang không chọn được</p>}
            </div>
            <div className="grid grid-cols-2 gap-3 border-y border-border py-3">
              <div>
                <div className="text-xs text-muted-foreground">Tổng số bài</div>
                <div className="tabular text-2xl font-bold">{totals.posts}</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Bài có ảnh AI</div>
                <div className="tabular text-2xl font-bold">~{totals.imagePosts}</div>
              </div>
            </div>
            <div>
              <div className="mb-2 flex items-center justify-between">
                <span className="text-muted-foreground">Lịch {PLAN_DAYS} ngày</span>
                <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
                  Ít
                  {['bg-teal-100', 'bg-teal-300', 'bg-teal-600'].map((c) => (
                    <span key={c} className={cn('size-2.5 rounded-sm', c)} />
                  ))}
                  Nhiều
                </span>
              </div>
              <div className="grid grid-cols-10 gap-1">
                {plan.map((v, i) => {
                  const day = addDaysKey(form.startDate, i)
                  const level = v <= 0 ? 0 : v / maxPerDay
                  return (
                    <span
                      key={i}
                      title={v < 0 ? `${shortDay(day)} · ngoài chiến dịch` : `${dayLabel(day)} · ${v} bài`}
                      className={cn(
                        'aspect-square rounded-sm',
                        v < 0 && 'border border-dashed border-border bg-transparent',
                        v === 0 && 'bg-slate-100',
                        v > 0 && level <= 0.34 && 'bg-teal-100',
                        v > 0 && level > 0.34 && level <= 0.67 && 'bg-teal-300',
                        v > 0 && level > 0.67 && 'bg-teal-600',
                      )}
                    />
                  )
                })}
              </div>
            </div>
            <SummaryRow label="Chế độ">
              {form.mode === 'review' ? (
                <Chip tone="primary" icon={<ShieldCheck size={11} />}>
                  Duyệt trước khi đăng
                </Chip>
              ) : (
                <Chip tone="ai" icon={<Zap size={11} />}>
                  Tự đăng
                </Chip>
              )}
            </SummaryRow>
            <div className="flex gap-2 rounded-md border border-ai/20 bg-ai-soft/60 px-3 py-2.5 text-[13px] text-ai">
              <Sparkles size={15} className="mt-0.5 shrink-0" />
              AI sẽ dùng Hồ sơ thương hiệu của từng trang
            </div>
          </div>
        </Card>
      </div>

      {/* Footer */}
      <div className="sticky bottom-0 z-10 -mx-6 mt-6 flex items-center justify-between gap-3 border-t border-border bg-surface px-6 py-3">
        {step === 1 ? (
          <Button variant="ghost" onClick={() => navigate('/chien-dich')}>
            Huỷ
          </Button>
        ) : (
          <Button icon={<ArrowLeft size={15} />} onClick={() => goTo(step - 1)} disabled={save.isPending}>
            Quay lại
          </Button>
        )}
        <div className="flex items-center gap-3">
          <span className="text-[13px] text-muted-foreground">
            Bước {step}/4
            {stepBlocked && ' · Kiểm tra các ô báo lỗi'}
          </span>
          {step < 4 ? (
            <Button variant="primary" disabled={save.isPending} onClick={() => goTo(step + 1)}>
              {step === 3 ? (save.isPending ? 'Đang lưu…' : 'Lưu và tiếp tục') : 'Tiếp tục'} <ArrowRight size={15} />
            </Button>
          ) : (
            <Button variant="primary" icon={<Rocket size={15} />} disabled title="Sắp có">
              Bắt đầu chiến dịch
            </Button>
          )}
        </div>
      </div>
    </Content>
  )
}

/* ---------- Thành phần phụ ---------- */

function FrequencyRow({
  page,
  reason,
  override,
  error,
  onChange,
}: {
  page: PageDto
  reason: keyof typeof BLOCK_REASON_TEXT | null
  override: CampaignFrequency | null
  error: string | undefined
  onChange: (value: string) => void
}) {
  return (
    <div className={cn('px-4 py-3', reason && 'bg-red-50/40')}>
      <div className="flex items-center gap-4">
        <div className="min-w-0 flex-1">
          <PageLabel page={toUiPage(page)} />
        </div>
        {page.connectionStatus !== 'active' && <StatusChip status={page.connectionStatus} />}
        {reason ? (
          <span className="w-[200px] text-right text-xs text-danger">Bỏ qua — {BLOCK_REASON_TEXT[reason].toLowerCase()}</span>
        ) : (
          <Select
            options={[{ value: DEFAULT_OPTION, label: 'Theo mặc định' }, ...FREQ_OPTIONS]}
            value={override ?? DEFAULT_OPTION}
            onChange={(e) => onChange(e.target.value)}
            className={cn('w-[170px]', override && 'border-primary')}
            aria-label={`Tần suất cho ${page.name}`}
          />
        )}
      </div>
      <FieldError message={error} />
    </div>
  )
}

function FieldError({ message }: { message: string | undefined }) {
  if (!message) return null
  return <p className="mt-1.5 text-[13px] text-danger">{message}</p>
}

function RadioCard({ checked, onSelect, icon, title, children }: { checked: boolean; onSelect: () => void; icon?: ReactNode; title: ReactNode; children?: ReactNode }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      onClick={onSelect}
      className={cn(
        'flex w-full items-start gap-3 rounded-lg border p-3.5 text-left transition-colors',
        checked ? 'border-primary bg-primary-soft/30 ring-1 ring-primary' : 'border-border bg-surface hover:bg-slate-50',
      )}
    >
      {icon && <span className={cn('mt-0.5 rounded-md p-1.5', checked ? 'bg-primary text-white' : 'bg-slate-100 text-slate-600')}>{icon}</span>}
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold">{title}</span>
        {children && <span className="mt-0.5 block text-xs text-muted-foreground">{children}</span>}
      </span>
      <span className={cn('mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border', checked ? 'border-primary bg-primary' : 'border-slate-300')}>
        {checked && <span className="size-1.5 rounded-full bg-white" />}
      </span>
    </button>
  )
}

function SummaryRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right font-medium">{children}</span>
    </div>
  )
}

function WizardSkeleton() {
  return (
    <Content>
      <div aria-busy="true" role="status" className="space-y-4">
        <span className="sr-only">Đang tải…</span>
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-9 w-full" />
        <div className="grid grid-cols-[minmax(0,1fr)_340px] gap-4">
          <Skeleton className="h-80 rounded-lg" />
          <Skeleton className="h-96 rounded-lg" />
        </div>
      </div>
    </Content>
  )
}
