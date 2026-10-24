import { Bell, Check, Copy, ExternalLink, Eye, EyeOff, KeyRound, Loader2, Plus, RefreshCw, Send, Sparkles, Trash2, TriangleAlert, Webhook } from 'lucide-react'
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { Content } from '../components/AppShell'
import ConnectResultModal from '../components/ConnectResultModal'
import { Button, Card, CardHeader, Chip, Field, Input, Modal, PageHeader, PageLabel, PlatformIcon, Progress, Select, StatusChip, Switch, cn } from '../components/ui'
import {
  EXCHANGE_RATE_VND_MAX,
  IMAGE_SIZES,
  MONTHLY_LIMIT_VND_MAX,
  type ImageSize,
  type NotificationPrefs,
  type NotificationType,
  type OAuthProvider,
  type OpenAiKeyStatus,
  type PageDto,
} from '@ottm/shared'
import { Skeleton } from '../components/Skeleton'
import { budgetToneOf, categoryRows, formatVnd, useAiBudget } from '../lib/ai-budget'
import { useApp } from '../lib/app-context'
import {
  CONNECT_ERROR_PARAM,
  CONNECT_PROVIDER_PARAM,
  CONNECT_RESULT_PARAM,
  PROVIDER_LABEL,
  needsReconnect,
  providerFromParam,
  reconnectInput,
  removePageConfirm,
  splitPagesByProvider,
  stripOAuthFragment,
  uiPageOf,
  usePages,
  useRemovePage,
  useStartConnect,
} from '../lib/connections'
import { errorMessage, errorMessageOf } from '../lib/error-messages'
import { useNotificationPrefs, useSaveNotificationPrefs } from '../lib/notifications'
import { metaAppPrivacyFields, threadsAppPrivacyFields, usePrivacyConfig } from '../lib/privacy'
import {
  WEBHOOK_LOG_SUBTITLE,
  WEBHOOK_PRODUCT_LABEL,
  canRetry,
  lastEventLabel,
  subscribeErrorLabel,
  useRetryWebhookEvent,
  useSendTestEvent,
  useWebhookConfig,
  useWebhookEvents,
  useWebhookHealth,
  webhookEventTime,
  webhookFieldLabel,
  webhookStatusView,
} from '../lib/webhooks'
import {
  IMAGE_SIZE_LABEL,
  formatMoney,
  keyErrorMessage,
  keyFormatError,
  keyStatusLabel,
  moneyFieldError,
  openAiFormOf,
  parseMoney,
  toUpdateRequest,
  useDeleteOpenAiKey,
  useOpenAiSettings,
  useRecheckOpenAiKey,
  useSaveOpenAiKey,
  useSaveOpenAiSettings,
  type OpenAiForm,
} from '../lib/openai'

type Section = 'openai' | 'webhook' | 'meta' | 'notify'

/** `?section=` mở thẳng một mục (vd banner Hộp thư → `/cai-dat?section=webhook`). */
const SECTION_PARAM = 'section'
const sectionOf = (raw: string | null): Section | null =>
  raw === 'openai' || raw === 'webhook' || raw === 'meta' || raw === 'notify' ? raw : null

const SECTIONS: { id: Section; label: string; icon: ReactNode }[] = [
  { id: 'openai', label: 'Kết nối OpenAI', icon: <KeyRound size={16} /> },
  { id: 'webhook', label: 'Webhook tin nhắn', icon: <Webhook size={16} /> },
  { id: 'meta', label: 'Tài khoản Meta', icon: <PlatformIcon platform="facebook" size={16} /> },
  { id: 'notify', label: 'Thông báo', icon: <Bell size={16} /> },
]

const KEY_STATUS_TONE: Record<OpenAiKeyStatus, 'success' | 'neutral' | 'danger'> = { valid: 'success', missing: 'neutral', invalid: 'danger' }
const IMAGE_SIZE_OPTIONS = IMAGE_SIZES.map((size) => ({ value: size, label: IMAGE_SIZE_LABEL[size] }))

const NO_ACTIVE_MODEL = 'Chưa có model nào đang bật'

/**
 * Cài đặt › Tài khoản Meta: hai tài khoản đăng nhập riêng (Story 2.3). Facebook Login cấp Fanpage + Instagram
 * Business liên kết; Threads đăng nhập bằng app Threads riêng, không gộp vào tài khoản Facebook.
 */
const META_BLOCKS: { provider: OAuthProvider; title: string; hint: string; note?: string; connectLabel: string; unit: string; empty: string }[] = [
  {
    provider: 'facebook',
    title: 'Facebook (Fanpage + Instagram)',
    hint: 'Một lần đăng nhập Facebook cấp quyền cho Fanpage và tài khoản Instagram Business liên kết.',
    connectLabel: 'Kết nối Facebook',
    unit: 'trang',
    empty: 'Chưa có Fanpage hay Instagram nào.',
  },
  {
    provider: 'threads',
    title: 'Threads',
    hint: 'Tài khoản Threads đăng nhập riêng. Token Threads hết hạn sau 60 ngày.',
    note: 'Thêm tài khoản Threads thứ hai: trước khi bấm Kết nối Threads, chuyển sang tài khoản Threads/Instagram đó trên trình duyệt này (hoặc đăng xuất tài khoản đang dùng).',
    connectLabel: 'Kết nối Threads',
    unit: 'tài khoản',
    empty: 'Chưa có tài khoản Threads nào.',
  },
]

const connectedDate = (iso: string) => new Date(iso).toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' })

const NOTIFY_ITEMS: { id: NotificationType; label: string; hint: string }[] = [
  { id: 'ai_handoff', label: 'AI chuyển hội thoại cho bạn', hint: 'Báo ngay khi có tin cần bạn xử lý.' },
  { id: 'token_expiring', label: 'Token sắp hết hạn', hint: 'Báo trước 7 ngày để bạn kết nối lại kịp.' },
  { id: 'publish_failed', label: 'Đăng bài lỗi', hint: 'Báo khi một bài không đăng được lên trang.' },
  { id: 'campaign_paused', label: 'Chiến dịch tạm dừng', hint: 'Báo khi chiến dịch tự dừng vì mất kết nối, hết hạn mức AI, thiếu khoá / hồ sơ hoặc đăng lỗi liên tiếp.' },
  { id: 'page_disconnected', label: 'Trang mất kết nối', hint: 'Báo khi một trang không còn nhận tin và đăng bài được — cần kết nối lại.' },
  { id: 'system_error', label: 'Việc chạy nền bị lỗi', hint: 'Báo khi một việc chạy nền quan trọng thử lại nhiều lần vẫn lỗi.' },
]

export default function Settings() {
  const { notify } = useApp()
  const [searchParams, setSearchParams] = useSearchParams()
  // Quay về từ OAuth (`?ket-noi=` / `?ket-noi-loi=`, from: 'settings') → mở thẳng mục Tài khoản Meta;
  // `?section=webhook` (banner Hộp thư) → mở thẳng mục đó.
  const sectionParam = sectionOf(searchParams.get(SECTION_PARAM))
  const [section, setSection] = useState<Section>(() =>
    searchParams.has(CONNECT_RESULT_PARAM) || searchParams.has(CONNECT_ERROR_PARAM) ? 'meta' : (sectionParam ?? 'openai'),
  )
  // Đang ở Cài đặt mà bấm link khác `?section=` (vd banner) → đổi mục theo URL (chỉnh state ngay lúc render khi
  // tham số đổi — mẫu "điều chỉnh state khi prop đổi" của React, không cần effect).
  const [appliedSectionParam, setAppliedSectionParam] = useState(sectionParam)
  if (sectionParam !== appliedSectionParam) {
    setAppliedSectionParam(sectionParam)
    if (sectionParam) setSection(sectionParam)
  }
  const [dirty, setDirty] = useState(false)
  const touch = () => setDirty(true)

  // OpenAI (đọc/ghi API). `openAiDraft` = bản đang sửa; null = theo server.
  const openAiQuery = useOpenAiSettings()
  const saveKey = useSaveOpenAiKey()
  const saveOpenAi = useSaveOpenAiSettings()
  const deleteKey = useDeleteOpenAiKey()
  const recheckKey = useRecheckOpenAiKey()
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [openAiDraft, setOpenAiDraft] = useState<OpenAiForm | null>(null)
  const openAiData = openAiQuery.data
  const openAi = openAiDraft ?? (openAiData ? openAiFormOf(openAiData) : undefined)
  const editOpenAi = (patch: Partial<OpenAiForm>) => {
    if (!openAi) return
    setOpenAiDraft({ ...openAi, ...patch })
    touch()
  }
  const [keyModal, setKeyModal] = useState(false)
  const [newKey, setNewKey] = useState('')
  const [keyError, setKeyError] = useState('')

  // Webhook (Story 4.1): URL callback + verify token + nhật ký — tất cả từ API thật.
  const [showToken, setShowToken] = useState(false)
  const webhookConfig = useWebhookConfig()
  const webhookEvents = useWebhookEvents()
  const sendTestEvent = useSendTestEvent()
  const retryEvent = useRetryWebhookEvent()
  // Sức khoẻ webhook (Story 4.2): tin gần nhất mỗi sản phẩm + trang đăng ký lỗi.
  const webhookHealth = useWebhookHealth()
  // Quyền riêng tư (Story 9.1): URL trang chính sách + callback xoá dữ liệu để dán vào Meta App.
  const privacyConfig = usePrivacyConfig()

  // Tài khoản Meta: trang thật, tách khối Facebook và Threads. "Kết nối" / "Kết nối lại" chạy lại OAuth đúng nền
  // tảng; callback đưa về đây (`from: 'settings'`) và mở bước chọn trang ngay trong Cài đặt.
  const pagesQuery = usePages()
  const startConnect = useStartConnect()
  const openingProvider = startConnect.isPending ? startConnect.variables.provider : null
  const connect = (provider: OAuthProvider) => {
    if (startConnect.isPending) return
    startConnect.mutate({ provider, from: 'settings' }, { onError: (err) => notify(errorMessageOf(err, provider)) })
  }
  // Kết nối lại một trang (Story 2.4): giữ `pageId` để server cập nhật đúng dòng (giữ nhóm, cấu hình, lịch sử).
  const reconnect = (page: PageDto) => {
    if (startConnect.isPending) return
    const input = reconnectInput(page, 'settings')
    startConnect.mutate(input, { onError: (err) => notify(errorMessageOf(err, input.provider)) })
  }
  // Gỡ trang (Story 2.7): hành động phá huỷ → xác nhận trước (modal nút đỏ, mẫu như "Gỡ khoá OpenAI"). Server
  // soft-delete + xoá token; trang biến khỏi bảng + bộ chọn phạm vi (invalidate `['pages']`/`['groups']`). Lịch sử giữ.
  const removePage = useRemovePage()
  const [removeTarget, setRemoveTarget] = useState<PageDto | null>(null)
  const removeCopy = removeTarget ? removePageConfirm(removeTarget) : null
  const confirmRemove = async () => {
    if (!removeTarget || removePage.isPending) return
    try {
      await removePage.mutateAsync(removeTarget.id)
    } catch (err) {
      notify(errorMessageOf(err))
      return
    }
    const noun = removePageConfirm(removeTarget).noun
    setRemoveTarget(null)
    notify(`Đã gỡ ${noun} khỏi app`)
  }
  const resultId = searchParams.get(CONNECT_RESULT_PARAM)
  const urlProvider = providerFromParam(searchParams.get(CONNECT_PROVIDER_PARAM))
  const connectError = searchParams.get(CONNECT_ERROR_PARAM)
  const clearConnectParams = useCallback(
    () =>
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev)
          next.delete(CONNECT_RESULT_PARAM)
          next.delete(CONNECT_ERROR_PARAM)
          next.delete(CONNECT_PROVIDER_PARAM)
          return next
        },
        { replace: true },
      ),
    [setSearchParams],
  )
  // Bỏ `#` / `#_` mà callback OAuth để lại trên thanh địa chỉ.
  useEffect(() => {
    stripOAuthFragment()
  }, [])
  useEffect(() => {
    if (!connectError) return
    notify(errorMessage(connectError, urlProvider))
    clearConnectParams()
  }, [connectError, urlProvider, notify, clearConnectParams])

  // Thông báo (đọc/ghi API). `notifs` = bản đang sửa; null = theo server.
  const prefsQuery = useNotificationPrefs()
  const savePrefs = useSaveNotificationPrefs()
  const [notifsDraft, setNotifsDraft] = useState<NotificationPrefs | null>(null)
  const notifs = notifsDraft ?? prefsQuery.data

  // Rời trang khi chưa lưu thì hỏi lại (EXPERIENCE.md › Interaction Primitives).
  useEffect(() => {
    if (!dirty) return
    const onUnload = (e: BeforeUnloadEvent) => e.preventDefault()
    window.addEventListener('beforeunload', onUnload)
    return () => window.removeEventListener('beforeunload', onUnload)
  }, [dirty])

  // Chi phí tháng này (số thật). % tính theo hạn mức đang sửa để xem trước trước khi lưu.
  const budgetQuery = useAiBudget()
  const budget = budgetQuery.data
  const spent = budget?.spentVnd ?? 0
  const budgetNum = openAi?.monthlyLimitVnd ?? budget?.limitVnd ?? 0
  const pct = budgetNum ? Math.floor((spent * 100) / budgetNum) : 100
  // Cùng luật màu với chip sidebar (tính cả công tắc 80%), theo hạn mức / công tắc đang sửa.
  const pctTone = budgetToneOf({ spentVnd: spent, limitVnd: budgetNum, warn80: openAi?.warn80 ?? budget?.warn80 ?? true })
  const usageRows = budget ? categoryRows(budget) : []
  const limitError = openAi ? moneyFieldError(openAi.monthlyLimitVnd, MONTHLY_LIMIT_VND_MAX) : null
  const rateError = openAi ? moneyFieldError(openAi.exchangeRateVnd, EXCHANGE_RATE_VND_MAX) : null
  const openAiInvalid = limitError !== null || rateError !== null

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      /* trình duyệt chặn clipboard — vẫn báo để người dùng biết thao tác đã chạy */
    }
    notify('Đã sao chép')
  }

  const closeKeyModal = () => {
    if (saveKey.isPending) return
    setKeyModal(false)
    setNewKey('')
    setKeyError('')
  }

  /** "Kiểm tra và lưu": server kiểm với OpenAI, chỉ lưu khi hợp lệ. Lỗi → giữ khoá cũ, hiện lỗi dưới ô. */
  const checkKey = async () => {
    const apiKey = newKey.trim()
    if (!apiKey || saveKey.isPending) return
    // Sai dạng → báo ngay, không gửi (cùng schema với server).
    const formatError = keyFormatError(apiKey)
    if (formatError) {
      setKeyError(formatError)
      return
    }
    setKeyError('')
    try {
      await saveKey.mutateAsync(apiKey)
    } catch (err) {
      setKeyError(keyErrorMessage(err))
      return
    }
    setKeyModal(false)
    setNewKey('')
    notify('Đã kết nối khoá OpenAI')
  }

  const sendTest = async () => {
    if (sendTestEvent.isPending) return
    try {
      await sendTestEvent.mutateAsync('meta')
    } catch (err) {
      notify(errorMessageOf(err))
      return
    }
    notify('Đã gửi sự kiện thử — xem nhật ký bên dưới')
  }

  const retryWebhook = async (id: string) => {
    if (retryEvent.isPending) return
    try {
      await retryEvent.mutateAsync(id)
    } catch (err) {
      notify(errorMessageOf(err))
      return
    }
    notify('Đã xếp lại để xử lý')
  }

  const recheck = async () => {
    try {
      const key = await recheckKey.mutateAsync()
      notify(key.status === 'valid' ? 'Khoá OpenAI vẫn hoạt động' : keyStatusLabel(key))
    } catch (err) {
      notify(errorMessageOf(err))
    }
  }

  const removeKey = async () => {
    try {
      await deleteKey.mutateAsync()
    } catch (err) {
      notify(errorMessageOf(err))
      return
    }
    setConfirmDelete(false)
    notify('Đã gỡ khoá OpenAI')
  }

  const save = async () => {
    if (openAiDraft) {
      if (openAiInvalid) {
        notify('Kiểm tra lại tỉ giá và hạn mức.')
        return
      }
      try {
        await saveOpenAi.mutateAsync(toUpdateRequest(openAiDraft))
      } catch (err) {
        notify(errorMessageOf(err))
        return
      }
      setOpenAiDraft(null)
    }
    if (notifsDraft) {
      try {
        await savePrefs.mutateAsync(notifsDraft)
      } catch (err) {
        notify(errorMessageOf(err))
        return
      }
      setNotifsDraft(null)
    }
    setDirty(false)
    notify('Đã lưu cài đặt')
  }

  return (
    <Content className="pb-0">
      <PageHeader title="Cài đặt" subtitle="Khoá OpenAI, webhook, tài khoản Meta và thông báo" />

      <div className="grid grid-cols-[220px_minmax(0,1fr)] gap-6">
        <nav className="space-y-0.5 self-start" aria-label="Mục cài đặt">
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              onClick={() => setSection(s.id)}
              aria-current={section === s.id ? 'page' : undefined}
              className={cn(
                'flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left text-sm font-medium transition-colors',
                section === s.id ? 'bg-primary-soft text-primary-hover' : 'text-muted-foreground hover:bg-slate-100 hover:text-foreground',
              )}
            >
              {s.icon}
              {s.label}
            </button>
          ))}
        </nav>

        <div className="min-w-0 space-y-6 pb-6">
          {section === 'openai' && (
            <>
              <Card>
                <CardHeader
                  title="Khoá API OpenAI"
                  subtitle="Dùng để AI viết bài, trả lời tin nhắn và tạo ảnh"
                  action={openAiData && <Chip tone={KEY_STATUS_TONE[openAiData.key.status]}>● {keyStatusLabel(openAiData.key)}</Chip>}
                />
                {openAiData ? (
                  <div className="p-4">
                    <div className="flex items-center gap-3">
                      <span className="flex h-9 flex-1 items-center rounded-sm border border-border bg-slate-50 px-3 font-mono text-sm">
                        {openAiData.key.configured ? `sk-••••••••${openAiData.key.last4 ?? ''}` : <span className="font-sans text-muted-foreground">Chưa có khoá</span>}
                      </span>
                      {openAiData.key.configured && openAiData.key.reason !== 'reentry_required' && (
                        <Button icon={<RefreshCw size={15} />} onClick={() => void recheck()} disabled={recheckKey.isPending}>
                          {recheckKey.isPending ? 'Đang kiểm tra…' : 'Kiểm tra lại'}
                        </Button>
                      )}
                      <Button variant={openAiData.key.status === 'valid' ? 'secondary' : 'primary'} onClick={() => setKeyModal(true)}>
                        {openAiData.key.configured ? 'Đổi khoá' : 'Thêm khoá'}
                      </Button>
                      {openAiData.key.configured && (
                        <Button variant="danger" onClick={() => setConfirmDelete(true)}>
                          Gỡ khoá
                        </Button>
                      )}
                    </div>
                    {openAiData.key.status === 'invalid' && (
                      <p className="mt-2 text-[13px] text-danger-foreground" role="alert">
                        {openAiData.key.reason === 'reentry_required'
                          ? 'Khoá đã lưu không giải mã được nữa (khoá mã hoá của máy chủ đã đổi). Nhập lại khoá OpenAI.'
                          : 'OpenAI đã từ chối khoá này. Thêm khoá mới để dùng lại AI.'}
                      </p>
                    )}
                    {openAiData.key.checkedAt && (
                      <p className="mt-2 text-xs text-muted-foreground">Kiểm lần cuối: {new Date(openAiData.key.checkedAt).toLocaleString('vi-VN')}</p>
                    )}
                  </div>
                ) : openAiQuery.isError ? (
                  <div className="px-4 py-6 text-center" role="alert">
                    <p className="text-sm">{errorMessageOf(openAiQuery.error)}</p>
                    <Button className="mt-3" onClick={() => void openAiQuery.refetch()}>
                      Thử lại
                    </Button>
                  </div>
                ) : (
                  <div className="flex items-center gap-3 p-4" aria-busy="true">
                    <Skeleton className="h-9 flex-1" />
                    <Skeleton className="h-9 w-24" />
                  </div>
                )}
              </Card>

              <Card>
                <CardHeader title="Model" />
                {openAi && openAiData ? (
                  <div className="grid grid-cols-1 gap-4 p-4 md:grid-cols-3">
                    <Field label="Model viết nội dung" hint={openAiData.models.text.length ? 'Dùng cho caption và trả lời tin nhắn' : NO_ACTIVE_MODEL}>
                      <Select
                        options={openAiData.models.text.length ? openAiData.models.text.map((m) => ({ value: m.model, label: m.label })) : [{ value: '', label: NO_ACTIVE_MODEL }]}
                        value={openAi.textModel}
                        disabled={openAiData.models.text.length === 0}
                        onChange={(e) => editOpenAi({ textModel: e.target.value })}
                      />
                    </Field>
                    <Field label="Model tạo ảnh" hint={openAiData.models.image.length ? undefined : NO_ACTIVE_MODEL}>
                      <Select
                        options={openAiData.models.image.length ? openAiData.models.image.map((m) => ({ value: m.model, label: m.label })) : [{ value: '', label: NO_ACTIVE_MODEL }]}
                        value={openAi.imageModel}
                        disabled={openAiData.models.image.length === 0}
                        onChange={(e) => editOpenAi({ imageModel: e.target.value })}
                      />
                    </Field>
                    <Field label="Kích thước ảnh">
                      <Select options={IMAGE_SIZE_OPTIONS} value={openAi.imageSize} onChange={(e) => editOpenAi({ imageSize: e.target.value as ImageSize })} />
                    </Field>
                  </div>
                ) : (
                  <div className="grid grid-cols-1 gap-4 p-4 md:grid-cols-3" aria-busy="true">
                    {[0, 1, 2].map((i) => (
                      <div key={i} className="space-y-1.5">
                        <Skeleton className="h-4 w-32" />
                        <Skeleton className="h-9 w-full" />
                      </div>
                    ))}
                  </div>
                )}
              </Card>

              <Card>
                <CardHeader title="Hạn mức chi phí AI" subtitle="Khi hết hạn mức, AI ngừng trả lời và chiến dịch tự tạm dừng" />
                <div className="space-y-4 p-4">
                  {openAi ? (
                    <div className="flex flex-wrap gap-4">
                      <Field
                        label="Hạn mức mỗi tháng"
                        className="w-full max-w-xs"
                        hint={limitError ? <span className="text-danger-foreground">{limitError}</span> : undefined}
                      >
                        <div className="relative">
                          <Input
                            inputMode="numeric"
                            value={formatMoney(openAi.monthlyLimitVnd)}
                            onChange={(e) => editOpenAi({ monthlyLimitVnd: parseMoney(e.target.value) })}
                            aria-invalid={limitError ? true : undefined}
                            className={cn('pr-8 text-right tabular', limitError && 'border-danger')}
                          />
                          <span className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-sm text-muted-foreground">đ</span>
                        </div>
                      </Field>
                      <Field
                        label="Tỉ giá VND/USD"
                        className="w-full max-w-xs"
                        hint={
                          rateError ? <span className="text-danger-foreground">{rateError}</span> : 'Dùng để đổi chi phí OpenAI (USD) sang đồng'
                        }
                      >
                        <div className="relative">
                          <Input
                            inputMode="numeric"
                            value={formatMoney(openAi.exchangeRateVnd)}
                            onChange={(e) => editOpenAi({ exchangeRateVnd: parseMoney(e.target.value) })}
                            aria-invalid={rateError ? true : undefined}
                            className={cn('pr-8 text-right tabular', rateError && 'border-danger')}
                          />
                          <span className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-sm text-muted-foreground">đ</span>
                        </div>
                      </Field>
                    </div>
                  ) : (
                    <div className="flex gap-4" aria-busy="true">
                      <Skeleton className="h-14 w-full max-w-xs" />
                      <Skeleton className="h-14 w-full max-w-xs" />
                    </div>
                  )}
                  {budget ? (
                    <div>
                      <div className="mb-1.5 flex justify-between text-[13px]">
                        <span className="font-medium">Đã dùng tháng {budget.month.slice(5)}/{budget.month.slice(0, 4)}</span>
                        <span className="tabular text-muted-foreground">
                          {formatVnd(spent)} / {formatMoney(budgetNum) || '0'}đ ·{' '}
                          <span
                            className={cn(
                              'font-medium',
                              pctTone === 'blocked' ? 'text-danger-foreground' : pctTone === 'warn' ? 'text-warning-foreground' : 'text-foreground',
                            )}
                          >
                            {pct}%
                          </span>
                        </span>
                      </div>
                      <Progress value={Math.min(100, pct)} />
                      {budget.reservedVnd > 0 && (
                        <p className="mt-1.5 text-xs text-muted-foreground">Đang giữ chỗ cho lời gọi AI đang chạy: {formatVnd(budget.reservedVnd)}</p>
                      )}
                    </div>
                  ) : budgetQuery.isError ? (
                    <div className="flex items-center justify-between text-[13px]" role="alert">
                      <span>{errorMessageOf(budgetQuery.error)}</span>
                      <Button size="sm" onClick={() => void budgetQuery.refetch()}>
                        Thử lại
                      </Button>
                    </div>
                  ) : (
                    <div className="space-y-1.5" aria-busy="true">
                      <Skeleton className="h-4 w-full" />
                      <Skeleton className="h-2 w-full" />
                    </div>
                  )}
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      className="size-4 accent-primary"
                      checked={openAi?.warn80 ?? true}
                      disabled={!openAi}
                      onChange={(e) => editOpenAi({ warn80: e.target.checked })}
                    />
                    Cảnh báo khi đạt 80%
                  </label>
                </div>
                <table className="w-full border-t border-border text-sm">
                  <thead>
                    <tr className="text-left text-[13px] text-muted-foreground">
                      <th className="px-4 py-2 font-medium">Hạng mục</th>
                      <th className="px-4 py-2 text-right font-medium">Số lượng</th>
                      <th className="px-4 py-2 text-right font-medium">Chi phí</th>
                      <th className="w-40 px-4 py-2 font-medium">Tỉ trọng</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border border-t border-border">
                    {budget
                      ? usageRows.map((u) => (
                          <tr key={u.category}>
                            <td className="px-4 py-2.5">
                              <span className="flex items-center gap-2">
                                <Sparkles size={14} className="text-ai" />
                                {u.label}
                              </span>
                            </td>
                            <td className="tabular px-4 py-2.5 text-right">{u.amount}</td>
                            <td className="tabular px-4 py-2.5 text-right">{formatVnd(u.costVnd)}</td>
                            <td className="px-4 py-2.5">
                              <Progress value={u.share} className="h-1.5" />
                            </td>
                          </tr>
                        ))
                      : budgetQuery.isError
                        ? [
                            <tr key="error">
                              <td colSpan={4} className="px-4 py-3" role="alert">
                                <span className="flex items-center justify-between gap-3 text-[13px]">
                                  <span>Chưa tải được chi phí theo hạng mục. {errorMessageOf(budgetQuery.error)}</span>
                                  <Button size="sm" onClick={() => void budgetQuery.refetch()}>
                                    Thử lại
                                  </Button>
                                </span>
                              </td>
                            </tr>,
                          ]
                        : [0, 1, 2].map((i) => (
                          <tr key={i} aria-busy="true">
                            <td className="px-4 py-2.5">
                              <Skeleton className="h-4 w-32" />
                            </td>
                            <td className="px-4 py-2.5">
                              <Skeleton className="ml-auto h-4 w-16" />
                            </td>
                            <td className="px-4 py-2.5">
                              <Skeleton className="ml-auto h-4 w-20" />
                            </td>
                            <td className="px-4 py-2.5">
                              <Skeleton className="h-1.5 w-full" />
                            </td>
                          </tr>
                        ))}
                    <tr className="font-semibold">
                      <td className="px-4 py-2.5">Tổng</td>
                      <td />
                      <td className="tabular px-4 py-2.5 text-right">{budget ? formatVnd(spent) : '—'}</td>
                      <td />
                    </tr>
                  </tbody>
                </table>
              </Card>
            </>
          )}

          {section === 'webhook' && (
            <>
              <Card>
                <CardHeader title="Tình trạng nhận tin" subtitle="Webhook ngừng nhận tin quá 30 phút (08:00–22:00) thì Hộp thư hiện cảnh báo" />
                {webhookHealth.data ? (
                  <div className="divide-y divide-border">
                    {webhookHealth.data.products.map((p) => (
                      <div key={p.product} className="flex flex-wrap items-center gap-3 px-4 py-3">
                        <span className="text-sm font-medium">{WEBHOOK_PRODUCT_LABEL[p.product]}</span>
                        <span className="text-[13px] text-muted-foreground">{lastEventLabel(p.lastEventAt)}</span>
                        {p.status === 'stalled' && (
                          <Chip tone="warning" icon={<TriangleAlert size={11} />} className="ml-auto">
                            Ngừng nhận tin
                          </Chip>
                        )}
                      </div>
                    ))}
                    {webhookHealth.data.pageSubscriptionErrors.length > 0 && (
                      <div className="space-y-2 px-4 py-3" role="alert">
                        <p className="text-[13px] font-medium text-red-700">Trang chưa đăng ký nhận tin được</p>
                        <ul className="space-y-2">
                          {webhookHealth.data.pageSubscriptionErrors.map((e) => (
                            <li key={e.pageId} className="flex flex-wrap items-center gap-2 text-sm">
                              <PlatformIcon platform={e.platform} size={14} />
                              <Link to={`/trang-nhom/trang/${e.pageId}`} className="font-medium hover:text-primary hover:underline">
                                {e.name}
                              </Link>
                              <span className="text-[13px] text-muted-foreground">{subscribeErrorLabel(e.errorCode)}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                ) : webhookHealth.isError ? (
                  <div className="px-4 py-6 text-center" role="alert">
                    <p className="text-sm">{errorMessageOf(webhookHealth.error)}</p>
                    <Button className="mt-3" onClick={() => void webhookHealth.refetch()}>
                      Thử lại
                    </Button>
                  </div>
                ) : (
                  <div className="space-y-3 p-4" aria-busy="true">
                    <Skeleton className="h-5 w-2/3" />
                    <Skeleton className="h-5 w-1/2" />
                  </div>
                )}
              </Card>

              <Card>
                <CardHeader title="Webhook tin nhắn" subtitle="Meta gửi tin nhắn và bình luận mới về các địa chỉ này" />
                {webhookConfig.data ? (
                  <div className="space-y-4 p-4">
                    <Field label="Callback URL — Facebook / Instagram">
                      <div className="flex gap-2">
                        <Input readOnly value={webhookConfig.data.callbacks.meta} className="font-mono" onFocus={(e) => e.target.select()} />
                        <Button icon={<Copy size={15} />} onClick={() => copy(webhookConfig.data!.callbacks.meta)}>
                          Sao chép
                        </Button>
                      </div>
                    </Field>
                    <Field label="Callback URL — Threads">
                      <div className="flex gap-2">
                        <Input readOnly value={webhookConfig.data.callbacks.threads} className="font-mono" onFocus={(e) => e.target.select()} />
                        <Button icon={<Copy size={15} />} onClick={() => copy(webhookConfig.data!.callbacks.threads)}>
                          Sao chép
                        </Button>
                      </div>
                    </Field>
                    <Field label="Verify token">
                      {webhookConfig.data.verifyTokenConfigured && webhookConfig.data.verifyToken ? (
                        <div className="flex gap-2">
                          <div className="relative flex-1">
                            <Input
                              readOnly
                              value={showToken ? webhookConfig.data.verifyToken : '•'.repeat(Math.min(24, webhookConfig.data.verifyToken.length))}
                              className="pr-10 font-mono"
                            />
                            <button
                              type="button"
                              onClick={() => setShowToken((v) => !v)}
                              className="absolute top-1/2 right-2 -translate-y-1/2 rounded p-1 text-muted-foreground hover:text-foreground"
                              aria-label={showToken ? 'Ẩn token' : 'Hiện token'}
                            >
                              {showToken ? <EyeOff size={15} /> : <Eye size={15} />}
                            </button>
                          </div>
                          <Button icon={<Copy size={15} />} onClick={() => copy(webhookConfig.data!.verifyToken ?? '')}>
                            Sao chép
                          </Button>
                        </div>
                      ) : (
                        <p className="text-[13px] text-muted-foreground">
                          Máy chủ chưa đặt <code className="font-mono">META_VERIFY_TOKEN</code>. Đặt biến này rồi khởi động lại để xác minh webhook với Meta.
                        </p>
                      )}
                    </Field>
                    <div>
                      <span className="mb-1.5 block text-[13px] font-medium">Field cần bật ở Meta</span>
                      <div className="flex flex-wrap gap-2">
                        {[...webhookConfig.data.fields.page, ...webhookConfig.data.fields.instagram, ...webhookConfig.data.fields.threads]
                          .filter((e, i, a) => a.indexOf(e) === i)
                          .map((e) => (
                            <Chip key={e} tone="primary" icon={<Check size={11} />} className="font-mono">
                              {e}
                            </Chip>
                          ))}
                      </div>
                    </div>
                  </div>
                ) : webhookConfig.isError ? (
                  <div className="px-4 py-6 text-center" role="alert">
                    <p className="text-sm">{errorMessageOf(webhookConfig.error)}</p>
                    <Button className="mt-3" onClick={() => void webhookConfig.refetch()}>
                      Thử lại
                    </Button>
                  </div>
                ) : (
                  <div className="space-y-4 p-4" aria-busy="true">
                    <Skeleton className="h-9 w-full" />
                    <Skeleton className="h-9 w-full" />
                    <Skeleton className="h-9 w-2/3" />
                  </div>
                )}
              </Card>

              <Card>
                <CardHeader
                  title="Nhật ký sự kiện"
                  subtitle={WEBHOOK_LOG_SUBTITLE}
                  action={
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        variant="secondary"
                        icon={<RefreshCw size={14} />}
                        onClick={() => void webhookEvents.refetch()}
                        disabled={webhookEvents.isFetching}
                      >
                        {webhookEvents.isFetching ? 'Đang tải…' : 'Làm mới'}
                      </Button>
                      <Button size="sm" icon={<Send size={14} />} onClick={() => void sendTest()} disabled={sendTestEvent.isPending}>
                        {sendTestEvent.isPending ? 'Đang gửi…' : 'Gửi sự kiện thử'}
                      </Button>
                    </div>
                  }
                />
                {webhookEvents.data ? (
                  webhookEvents.data.items.length === 0 ? (
                    <p className="px-4 py-6 text-center text-sm text-muted-foreground">
                      Chưa có sự kiện nào. Bấm "Gửi sự kiện thử" để kiểm tra nhật ký.
                    </p>
                  ) : (
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-border text-left text-[13px] text-muted-foreground">
                          <th className="px-4 py-2 font-medium">Thời gian</th>
                          <th className="px-4 py-2 font-medium">Trang</th>
                          <th className="px-4 py-2 font-medium">Sự kiện</th>
                          <th className="px-4 py-2 font-medium">Trạng thái</th>
                          <th className="px-4 py-2">
                            <span className="sr-only">Hành động</span>
                          </th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border">
                        {webhookEvents.data.items.map((ev) => {
                          const status = webhookStatusView(ev)
                          return (
                            <tr key={ev.id}>
                              <td className="tabular px-4 py-2.5 text-muted-foreground">{webhookEventTime(ev.receivedAt)}</td>
                              <td className="px-4 py-2.5">
                                {ev.page ? (
                                  <span className="flex items-center gap-2">
                                    <PlatformIcon platform={ev.page.platform} size={14} />
                                    {ev.page.name}
                                  </span>
                                ) : (
                                  <span className="text-muted-foreground">{ev.test ? '— (thử)' : '—'}</span>
                                )}
                              </td>
                              <td className="px-4 py-2.5 font-mono text-[13px]">
                                {webhookFieldLabel(ev)}
                                {ev.payloadPurged && <span className="ml-2 font-sans text-muted-foreground">· đã dọn nội dung</span>}
                              </td>
                              <td className="px-4 py-2.5">
                                <Chip tone={status.tone}>{status.label}</Chip>
                              </td>
                              <td className="px-4 py-2.5 text-right">
                                {canRetry(ev) && (
                                  <Button
                                    size="sm"
                                    variant="secondary"
                                    icon={<RefreshCw size={13} />}
                                    onClick={() => void retryWebhook(ev.id)}
                                    disabled={retryEvent.isPending}
                                  >
                                    Xử lý lại
                                  </Button>
                                )}
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  )
                ) : webhookEvents.isError ? (
                  <div className="px-4 py-6 text-center" role="alert">
                    <p className="text-sm">{errorMessageOf(webhookEvents.error)}</p>
                    <Button className="mt-3" onClick={() => void webhookEvents.refetch()}>
                      Thử lại
                    </Button>
                  </div>
                ) : (
                  <div className="space-y-2 p-4" aria-busy="true">
                    {[0, 1, 2].map((i) => (
                      <Skeleton key={i} className="h-8 w-full" />
                    ))}
                  </div>
                )}
              </Card>
            </>
          )}

          {section === 'meta' && (
            <Card>
              <CardHeader title="Tài khoản Meta" subtitle="Facebook (Fanpage + Instagram) và Threads là hai tài khoản đăng nhập riêng. Kết nối lại khi trang mất kết nối." />
              {pagesQuery.isError ? (
                <div className="px-4 py-6 text-center" role="alert">
                  <p className="text-sm">Chưa tải được danh sách trang. {errorMessageOf(pagesQuery.error)}</p>
                  <Button className="mt-3" onClick={() => void pagesQuery.refetch()}>
                    Thử lại
                  </Button>
                </div>
              ) : (
                <div className="divide-y divide-border">
                  {META_BLOCKS.map((block) => {
                    const items: PageDto[] = pagesQuery.data ? splitPagesByProvider(pagesQuery.data)[block.provider] : []
                    const busy = openingProvider === block.provider
                    return (
                      <section key={block.provider} className="p-4" aria-label={block.title}>
                        <div className="mb-1 flex flex-wrap items-center gap-2">
                          {block.provider === 'facebook' ? (
                            <span className="flex items-center gap-1">
                              <PlatformIcon platform="facebook" size={18} />
                              <PlatformIcon platform="instagram" size={18} />
                            </span>
                          ) : (
                            <PlatformIcon platform="threads" size={18} />
                          )}
                          <h3 className="font-medium">{block.title}</h3>
                          {pagesQuery.data && <span className="text-xs text-muted-foreground">{items.length} {block.unit}</span>}
                          <Button
                            className="ml-auto"
                            size="sm"
                            variant={items.length ? 'secondary' : 'primary'}
                            icon={busy ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
                            disabled={startConnect.isPending}
                            onClick={() => connect(block.provider)}
                          >
                            {busy ? `Đang mở ${PROVIDER_LABEL[block.provider]}…` : block.connectLabel}
                          </Button>
                        </div>
                        <p className="mb-2 text-xs text-muted-foreground">{block.hint}</p>
                        {block.note && <p className="mb-2 text-xs text-muted-foreground">{block.note}</p>}
                        {pagesQuery.isPending ? (
                          <div className="space-y-2" aria-busy="true">
                            <Skeleton className="h-12 w-full" />
                          </div>
                        ) : items.length === 0 ? (
                          <p className="rounded-md border border-dashed border-border px-3 py-3 text-[13px] text-muted-foreground">{block.empty}</p>
                        ) : (
                          <ul className="divide-y divide-border rounded-md border border-border">
                            {items.map((dto) => {
                              const p = uiPageOf(dto)
                              const st = dto.connectionStatus
                              return (
                                <li key={dto.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-3 py-2.5">
                                  <div className="min-w-48 flex-1">
                                    <PageLabel page={p} sub={dto.handle ? `@${dto.handle}` : undefined} />
                                  </div>
                                  <span className="tabular text-[13px] whitespace-nowrap text-muted-foreground">Kết nối từ {connectedDate(dto.connectedAt)}</span>
                                  <StatusChip status={st} />
                                  {needsReconnect(st) && (
                                    <Button size="sm" icon={<RefreshCw size={14} />} disabled={startConnect.isPending} onClick={() => reconnect(dto)}>
                                      Kết nối lại
                                    </Button>
                                  )}
                                  <Button
                                    size="sm"
                                    variant="danger"
                                    icon={<Trash2 size={14} />}
                                    disabled={removePage.isPending}
                                    onClick={() => setRemoveTarget(dto)}
                                  >
                                    {removePageConfirm(dto).confirmLabel}
                                  </Button>
                                </li>
                              )
                            })}
                          </ul>
                        )}
                      </section>
                    )
                  })}
                </div>
              )}
            </Card>
          )}

          {section === 'meta' && (
            <Card>
              <CardHeader
                title="Quyền riêng tư cho Meta App và Threads app"
                subtitle="Meta cần các địa chỉ này trước khi cho app chạy Live. Dán vào đúng ô trong Meta App và Threads app."
              />
              {privacyConfig.data ? (
                <div className="space-y-4 p-4">
                  {(!privacyConfig.data.operatorConfigured || !privacyConfig.data.metaSecretConfigured || !privacyConfig.data.threadsSecretConfigured) && (
                    <div className="flex gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2.5 text-[13px] text-amber-900" role="status">
                      <TriangleAlert size={15} className="mt-0.5 shrink-0" />
                      <div className="space-y-1">
                        {!privacyConfig.data.operatorConfigured && (
                          <p>
                            Trang chính sách còn thiếu tên đơn vị vận hành hoặc email liên hệ. Đặt <code className="font-mono">PRIVACY_CONTROLLER_NAME</code> và{' '}
                            <code className="font-mono">PRIVACY_CONTACT_EMAIL</code> rồi khởi động lại.
                          </p>
                        )}
                        {!privacyConfig.data.metaSecretConfigured && (
                          <p>
                            Máy chủ chưa đặt <code className="font-mono">META_APP_SECRET</code> nên chưa nhận được yêu cầu xoá dữ liệu từ Meta.
                          </p>
                        )}
                        {!privacyConfig.data.threadsSecretConfigured && (
                          <p>
                            Máy chủ chưa đặt <code className="font-mono">THREADS_APP_SECRET</code> nên chưa nhận được yêu cầu xoá dữ liệu từ Threads.
                          </p>
                        )}
                      </div>
                    </div>
                  )}
                  {[
                    { title: 'Meta App (Facebook và Instagram)', fields: metaAppPrivacyFields(privacyConfig.data) },
                    { title: 'Threads app', fields: threadsAppPrivacyFields(privacyConfig.data) },
                  ].map((group) => (
                    <section key={group.title} className="space-y-4">
                      <h3 className="text-sm font-semibold">{group.title}</h3>
                      {group.fields.map((f) => (
                        <Field key={f.label} label={f.label} hint={f.hint}>
                          <div className="flex gap-2">
                            <Input readOnly value={f.value} className="font-mono" onFocus={(e) => e.target.select()} />
                            <Button icon={<Copy size={15} />} onClick={() => copy(f.value)}>
                              Sao chép
                            </Button>
                          </div>
                        </Field>
                      ))}
                    </section>
                  ))}
                  <a
                    href={privacyConfig.data.policyUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
                  >
                    Xem trang chính sách <ExternalLink size={14} />
                  </a>
                </div>
              ) : privacyConfig.isError ? (
                <div className="px-4 py-6 text-center" role="alert">
                  <p className="text-sm">{errorMessageOf(privacyConfig.error)}</p>
                  <Button className="mt-3" onClick={() => void privacyConfig.refetch()}>
                    Thử lại
                  </Button>
                </div>
              ) : (
                <div className="space-y-3 p-4" aria-busy="true">
                  <Skeleton className="h-9 w-full" />
                  <Skeleton className="h-9 w-full" />
                  <Skeleton className="h-9 w-full" />
                </div>
              )}
            </Card>
          )}

          {section === 'notify' && (
            <Card>
              <CardHeader title="Thông báo" subtitle="Chọn việc bạn muốn được báo ngay" />
              {notifs ? (
                <ul className="divide-y divide-border">
                  {NOTIFY_ITEMS.map((n) => (
                    <li key={n.id} className="flex items-center justify-between gap-4 px-4 py-3.5">
                      <div>
                        <div className="text-sm font-medium">{n.label}</div>
                        <div className="text-xs text-muted-foreground">{n.hint}</div>
                      </div>
                      <Switch
                        checked={notifs[n.id]}
                        label={n.label}
                        onChange={(v) => {
                          setNotifsDraft({ ...notifs, [n.id]: v })
                          touch()
                        }}
                      />
                    </li>
                  ))}
                </ul>
              ) : prefsQuery.isError ? (
                <div className="px-4 py-6 text-center" role="alert">
                  <p className="text-sm">{errorMessageOf(prefsQuery.error)}</p>
                  <Button className="mt-3" onClick={() => void prefsQuery.refetch()}>
                    Thử lại
                  </Button>
                </div>
              ) : (
                <ul className="divide-y divide-border" aria-busy="true">
                  {NOTIFY_ITEMS.map((n) => (
                    <li key={n.id} className="flex items-center justify-between gap-4 px-4 py-3.5">
                      <div className="flex-1 space-y-1.5">
                        <Skeleton className="h-4 w-56" />
                        <Skeleton className="h-3 w-80" />
                      </div>
                      <Skeleton className="h-5 w-9 rounded-full" />
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          )}
        </div>
      </div>

      <div className="sticky bottom-0 z-10 -mx-6 mt-2 flex items-center justify-end gap-3 border-t border-border bg-surface/95 px-6 py-3 backdrop-blur">
        {dirty && <span className="text-[13px] text-warning-foreground">Có thay đổi chưa lưu</span>}
        <Button variant="primary" onClick={() => void save()} disabled={!dirty || savePrefs.isPending || saveOpenAi.isPending}>
          {savePrefs.isPending || saveOpenAi.isPending ? 'Đang lưu…' : 'Lưu thay đổi'}
        </Button>
      </div>

      <Modal
        open={confirmDelete}
        onClose={() => !deleteKey.isPending && setConfirmDelete(false)}
        title="Gỡ khoá OpenAI?"
        width={440}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmDelete(false)} disabled={deleteKey.isPending}>
              Huỷ
            </Button>
            <Button variant="danger" onClick={() => void removeKey()} disabled={deleteKey.isPending}>
              {deleteKey.isPending ? 'Đang gỡ…' : 'Gỡ khoá'}
            </Button>
          </>
        }
      >
        <p className="text-sm">Khoá bị xoá khỏi máy chủ. Mọi tính năng AI dừng ngay cho tới khi bạn thêm khoá mới.</p>
      </Modal>

      <Modal
        open={removeTarget !== null}
        onClose={() => !removePage.isPending && setRemoveTarget(null)}
        title={removeCopy?.title ?? 'Gỡ trang khỏi app?'}
        width={440}
        footer={
          <>
            <Button variant="ghost" onClick={() => setRemoveTarget(null)} disabled={removePage.isPending}>
              Huỷ
            </Button>
            <Button variant="danger" onClick={() => void confirmRemove()} disabled={removePage.isPending}>
              {removePage.isPending ? 'Đang gỡ…' : (removeCopy?.confirmLabel ?? 'Gỡ trang')}
            </Button>
          </>
        }
      >
        <p className="text-sm">{removeCopy?.body}</p>
      </Modal>

      <Modal
        open={keyModal}
        onClose={closeKeyModal}
        title={openAiData?.key.configured ? 'Đổi khoá OpenAI' : 'Thêm khoá OpenAI'}
        footer={
          <>
            <Button variant="ghost" onClick={closeKeyModal} disabled={saveKey.isPending}>
              Huỷ
            </Button>
            <Button variant="primary" onClick={() => void checkKey()} disabled={!newKey.trim() || saveKey.isPending}>
              {saveKey.isPending ? 'Đang kiểm tra…' : 'Kiểm tra và lưu'}
            </Button>
          </>
        }
      >
        <Field
          label="Khoá API mới"
          hint={
            keyError ? (
              <span className="text-danger-foreground" role="alert">
                {keyError}
              </span>
            ) : (
              'Lấy khoá ở platform.openai.com › API keys. Khoá được kiểm với OpenAI và mã hoá khi lưu.'
            )
          }
        >
          <Input
            type="password"
            autoComplete="off"
            autoFocus
            spellCheck={false}
            placeholder="sk-..."
            value={newKey}
            disabled={saveKey.isPending}
            onChange={(e) => {
              setNewKey(e.target.value)
              setKeyError('')
            }}
            onKeyDown={(e) => e.key === 'Enter' && void checkKey()}
            aria-invalid={keyError ? true : undefined}
            className={cn('font-mono', keyError && 'border-danger')}
          />
        </Field>
      </Modal>

      {resultId && (
        <ConnectResultModal
          key={resultId}
          resultId={resultId}
          provider={urlProvider}
          onClose={clearConnectParams}
          onRetry={connect}
          retrying={startConnect.isPending}
          onConnected={(connected) => {
            clearConnectParams()
            notify(`Đã kết nối ${connected.length} ${connected.every((p) => p.platform === 'threads') ? 'tài khoản' : 'trang'}`)
          }}
        />
      )}
    </Content>
  )
}
