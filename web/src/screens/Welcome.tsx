import { ArrowRight, Check, KeyRound, Loader2, Sparkles } from 'lucide-react'
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import ConnectResultModal from '../components/ConnectResultModal'
import { Button, Input, PlatformIcon, cn } from '../components/ui'
import type { Platform } from '../data/mock'
import type { OAuthProvider } from '@ottm/shared'
import { useApp } from '../lib/app-context'
import {
  CONNECT_ERROR_PARAM,
  CONNECT_PROVIDER_PARAM,
  CONNECT_RESULT_PARAM,
  PROVIDER_LABEL,
  providerFromParam,
  providerOfPlatform,
  stripOAuthFragment,
  usePages,
  useStartConnect,
} from '../lib/connections'
import { errorMessage, errorMessageOf } from '../lib/error-messages'
import { keyErrorMessage, keyFormatError, useOpenAiSettings, useSaveOpenAiKey } from '../lib/openai'

/** Facebook và Instagram Business dùng chung một cửa sổ Meta; Threads có OAuth riêng (Story 2.3). */
const CONNECTORS: { platform: Platform; label: string; hint: string; note?: string }[] = [
  { platform: 'facebook', label: 'Facebook Fanpage', hint: 'Fanpage bạn đang quản trị' },
  {
    platform: 'instagram',
    label: 'Instagram Business',
    hint: 'Tài khoản Business đã liên kết Fanpage',
    note: 'Instagram Business cần liên kết với một Fanpage; kết nối Fanpage để chọn IG',
  },
  { platform: 'threads', label: 'Threads', hint: 'Nhận bình luận, đăng bài tự động' },
]


function Step({ n, title, done, active, children }: { n: number; title: string; done: boolean; active: boolean; children?: ReactNode }) {
  return (
    <li className={cn('rounded-lg border bg-surface p-5 transition-colors', active ? 'border-primary/40' : 'border-border')}>
      <div className="flex items-center gap-3">
        <span
          className={cn(
            'flex size-7 shrink-0 items-center justify-center rounded-full text-[13px] font-semibold',
            done ? 'bg-primary text-white' : active ? 'border-2 border-primary text-primary' : 'border border-border text-muted-foreground',
          )}
          aria-hidden
        >
          {done ? <Check size={15} /> : n}
        </span>
        <h2 className={cn('text-base font-semibold', !done && !active && 'text-muted-foreground')}>{title}</h2>
        {done && <span className="ml-auto text-[13px] font-medium text-success-foreground">Xong</span>}
      </div>
      {children && <div className="mt-4 pl-10">{children}</div>}
    </li>
  )
}

export default function Welcome() {
  const { notify } = useApp()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  // Bước 1 dùng chung luồng kết nối với Trang & Nhóm (`from: 'welcome'` → callback đưa về /bat-dau).
  const pagesQuery = usePages()
  const startConnect = useStartConnect()
  const openingProvider = startConnect.isPending ? startConnect.variables.provider : null
  const pages = pagesQuery.data ?? []
  const connected = new Set(pages.map((p) => p.platform))
  const resultId = searchParams.get(CONNECT_RESULT_PARAM)
  const resultProvider = providerFromParam(searchParams.get(CONNECT_PROVIDER_PARAM))
  const connectError = searchParams.get(CONNECT_ERROR_PARAM)
  // Bước 2 dùng đúng luồng của Cài đặt › OpenAI: server kiểm với OpenAI rồi mới lưu khoá.
  const openAiQuery = useOpenAiSettings()
  const saveKey = useSaveOpenAiKey()
  const [apiKey, setApiKey] = useState('')
  const [keyError, setKeyError] = useState('')

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
    notify(errorMessage(connectError, resultProvider))
    clearConnectParams()
  }, [connectError, resultProvider, notify, clearConnectParams])

  const connect = (provider: OAuthProvider) => {
    if (startConnect.isPending) return
    startConnect.mutate({ provider, from: 'welcome' }, { onError: (err) => notify(errorMessageOf(err, provider)) })
  }

  const checkKey = async () => {
    const key = apiKey.trim()
    if (!key || saveKey.isPending) return
    const formatError = keyFormatError(key)
    if (formatError) {
      setKeyError(formatError)
      return
    }
    setKeyError('')
    try {
      await saveKey.mutateAsync(key)
    } catch (err) {
      setKeyError(keyErrorMessage(err))
      return
    }
    setApiKey('')
    notify('Đã kết nối OpenAI')
  }

  const savedKey = openAiQuery.data?.key
  const step1 = pages.length > 0
  const step2 = savedKey?.status === 'valid'
  const doneCount = Number(step1) + Number(step2)

  return (
    <div className="min-h-full bg-background">
      <div className="mx-auto max-w-3xl px-6 py-10">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <span className="flex size-9 items-center justify-center rounded-md bg-primary text-lg font-bold text-white">O</span>
            <span className="text-lg font-bold tracking-tight">OnTheTopMoney</span>
          </div>
          <Link to="/" className="text-[13px] font-medium text-muted-foreground hover:text-foreground hover:underline">
            Bỏ qua, vào bảng điều khiển
          </Link>
        </div>

        <div className="mt-10">
          <h1 className="text-[28px] leading-tight font-bold tracking-tight">Chào bạn! Kết nối trang đầu tiên để bắt đầu</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            4 bước, khoảng 5 phút. Sau đó AI sẽ trả lời tin nhắn và viết bài theo đúng giọng shop của bạn.
          </p>
          <div className="mt-4 flex items-center gap-3">
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-200">
              <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${(doneCount / 4) * 100}%` }} />
            </div>
            <span className="tabular text-[13px] font-medium text-muted-foreground">{doneCount}/4 bước</span>
          </div>
        </div>

        <ol className="mt-6 space-y-3">
          <Step n={1} title="Kết nối trang" done={step1} active={!step1}>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              {CONNECTORS.map((c) => {
                const isDone = connected.has(c.platform)
                const provider = providerOfPlatform(c.platform)
                const isBusy = openingProvider === provider
                return (
                  <button
                    key={c.platform}
                    onClick={() => connect(provider)}
                    disabled={isDone || startConnect.isPending || pagesQuery.isPending || pagesQuery.isError}
                    className={cn(
                      'flex flex-col items-start gap-3 rounded-lg border p-4 text-left transition-colors disabled:cursor-default',
                      isDone ? 'border-primary/40 bg-primary-soft/40' : 'border-border bg-surface hover:border-primary/50 hover:bg-slate-50',
                    )}
                  >
                    <PlatformIcon platform={c.platform} size={32} />
                    <span>
                      <span className="block text-sm font-semibold">{c.label}</span>
                      <span className="mt-0.5 block text-xs text-muted-foreground">{c.hint}</span>
                      {c.note && !isDone && <span className="mt-1 block text-[11px] text-muted-foreground italic">{c.note}</span>}
                    </span>
                    <span className={cn('inline-flex items-center gap-1 text-[13px] font-medium', isDone ? 'text-success-foreground' : 'text-primary')}>
                      {isDone ? (
                        <>
                          <Check size={14} /> Đã kết nối
                        </>
                      ) : isBusy ? (
                        <>
                          <Loader2 size={14} className="animate-spin" /> Đang mở {PROVIDER_LABEL[provider]}…
                        </>
                      ) : (
                        <>
                          Kết nối <ArrowRight size={14} />
                        </>
                      )}
                    </span>
                  </button>
                )
              })}
            </div>
            {pagesQuery.isError && (
              <div className="mt-3 flex flex-wrap items-center gap-3 rounded-md border border-red-200 bg-red-50/60 px-3 py-2 text-[13px]" role="alert">
                <span className="text-danger-foreground">Chưa tải được danh sách trang. {errorMessageOf(pagesQuery.error)}</span>
                <Button size="sm" onClick={() => void pagesQuery.refetch()}>
                  Thử lại
                </Button>
              </div>
            )}
            {step1 && (
              <p className="mt-3 text-[13px]">
                Đã kết nối {pages.length} trang: {pages.map((p) => p.name).join(', ')}.
              </p>
            )}
            <p className="mt-3 text-xs text-muted-foreground">
              Facebook và Instagram Business kết nối chung qua một cửa sổ Meta: bạn đăng nhập, cấp quyền tin nhắn, đăng bài, thống kê rồi chọn trang. Threads là tài khoản riêng, đăng nhập bằng tài khoản Threads. Kết nối thêm trang bất cứ lúc nào ở Trang & Nhóm.
            </p>
          </Step>

          <Step n={2} title="Thêm khoá OpenAI" done={step2} active={step1 && !step2}>
            <div className="rounded-md border border-ai/20 bg-ai-soft/50 p-3 text-[13px]">
              <span className="flex items-start gap-2">
                <Sparkles size={15} className="mt-0.5 shrink-0 text-ai" />
                <span>
                  Cần khoá OpenAI để dùng các tính năng AI: trả lời tin nhắn, viết bài, tạo ảnh. Bạn cũng có thể thêm sau ở{' '}
                  <Link to="/cai-dat" className="font-medium text-primary hover:underline">
                    Cài đặt
                  </Link>
                  .
                </span>
              </span>
            </div>
            {step2 ? (
              <div className="mt-3 flex items-center gap-2 text-sm">
                <KeyRound size={15} className="text-muted-foreground" />
                <span className="font-mono">sk-••••••••{savedKey?.last4 ?? ''}</span>
                <span className="font-medium text-success-foreground">● Đã kết nối</span>
              </div>
            ) : (
              <div className="mt-3">
                <div className="flex gap-2">
                  <Input
                    type="password"
                    autoComplete="off"
                    placeholder="Dán khoá API, bắt đầu bằng sk-"
                    aria-label="Khoá API OpenAI"
                    value={apiKey}
                    onChange={(e) => {
                      setApiKey(e.target.value)
                      setKeyError('')
                    }}
                    onKeyDown={(e) => e.key === 'Enter' && void checkKey()}
                    disabled={saveKey.isPending}
                    aria-invalid={keyError ? true : undefined}
                    className={cn('font-mono', keyError && 'border-danger')}
                  />
                  <Button
                    variant={step1 ? 'primary' : 'secondary'}
                    onClick={() => void checkKey()}
                    disabled={!apiKey.trim() || saveKey.isPending}
                    icon={saveKey.isPending ? <Loader2 size={15} className="animate-spin" /> : undefined}
                  >
                    {saveKey.isPending ? 'Đang kiểm tra…' : 'Kiểm tra và lưu'}
                  </Button>
                </div>
                {keyError && (
                  <p className="mt-1.5 text-xs text-danger-foreground" role="alert">
                    {keyError}
                  </p>
                )}
              </div>
            )}
          </Step>

          <Step n={3} title="Điền hồ sơ thương hiệu" done={false} active={step1 && step2}>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-[13px] text-muted-foreground">Giọng điệu, sản phẩm chủ lực, từ cấm — AI dùng để viết bài và trả lời đúng giọng shop.</p>
              <Button disabled={!step1} onClick={() => navigate('/trang-nhom')}>
                Điền hồ sơ
              </Button>
            </div>
          </Step>

          <Step n={4} title="Bật AI trả lời" done={false} active={false}>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-[13px] text-muted-foreground">AI trả lời tin nhắn trong vài giây và chuyển cho bạn khi cần.</p>
              <Button disabled={!step1 || !step2} onClick={() => navigate('/ai-tra-loi')} title={step2 ? undefined : 'Thêm khoá OpenAI ở bước 2'}>
                Bật AI trả lời
              </Button>
            </div>
          </Step>
        </ol>

        {resultId && (
          <ConnectResultModal
            key={resultId}
            resultId={resultId}
            provider={resultProvider}
            onClose={clearConnectParams}
            onRetry={connect}
            retrying={startConnect.isPending}
            onConnected={(connectedPages) => {
              clearConnectParams()
              notify(`Đã kết nối ${connectedPages.length} trang`)
            }}
          />
        )}

        {step1 && step2 && (
          <div className="mt-6 flex justify-end">
            <Button variant="primary" onClick={() => navigate('/')} icon={<ArrowRight size={15} />}>
              Vào bảng điều khiển
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}
