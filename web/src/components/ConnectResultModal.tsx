// Bước chọn trang sau OAuth (Story 2.2 Meta, Story 2.3 Threads) — dùng chung cho Trang & Nhóm và Màn chào bước 1.
// Đọc kết quả callback theo `resultId` (server không bao giờ trả token), rồi:
// - huỷ ở Meta / Threads → "Bạn đã huỷ kết nối" + "Thử lại";
// - thiếu quyền bắt buộc → modal thiếu quyền ("Chưa cấp đủ quyền quản lý tin nhắn" với Meta, "Chưa cấp đủ quyền
//   Threads" với Threads) + danh sách quyền thiếu + "Thử lại";
// - còn lại → Meta: chọn Fanpage và IG liên kết (hiển thị cạnh nhau, ứng viên khoá kèm lý do); Threads: chọn tài
//   khoản Threads → xác nhận.
// "Thử lại" chạy lại đúng luồng: nền tảng lấy từ kết quả, hoặc từ `?nen-tang=` khi kết quả đã hết hạn.
import { OAUTH_MAX_PAGES, type OAuthCandidate, type OAuthProvider, type PageDto } from '@ottm/shared'
import { AlertTriangle, Check, Loader2, Lock, RefreshCw, XCircle } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { isApiError } from '../lib/api'
import {
  MISSING_TITLES,
  PERMISSION_LABELS,
  candidateGroupsFor,
  lockReasonText,
  missingPermissions,
  resultProvider,
  toggleCandidate,
  useConfirmConnections,
  useOAuthResult,
} from '../lib/connections'
import { errorMessage, errorMessageOf } from '../lib/error-messages'
import { Button, Modal, PlatformIcon, cn, platformLabel } from './ui'

const TITLES: Record<OAuthProvider, ReactNode> = {
  facebook: (
    <span className="flex items-center gap-2">
      <PlatformIcon platform="facebook" size={20} /> Kết nối Facebook và Instagram
    </span>
  ),
  threads: (
    <span className="flex items-center gap-2">
      <PlatformIcon platform="threads" size={20} /> Kết nối Threads
    </span>
  ),
}

export default function ConnectResultModal({
  resultId,
  provider: providerHint = 'facebook',
  onClose,
  onRetry,
  retrying,
  onConnected,
}: {
  resultId: string
  /** Nền tảng theo URL (`?nen-tang=`) — dùng khi chưa đọc được kết quả. */
  provider?: OAuthProvider
  onClose: () => void
  /** Bắt đầu lại OAuth đúng nền tảng (rời app sang Meta / Threads). */
  onRetry: (provider: OAuthProvider) => void
  retrying: boolean
  onConnected: (pages: PageDto[]) => void
}) {
  const result = useOAuthResult(resultId)
  const provider: OAuthProvider = resultProvider(result.data, providerHint)
  const TITLE = TITLES[provider]
  const isThreads = provider === 'threads'
  const confirm = useConfirmConnections()
  const [stage, setStage] = useState<'auto' | 'pick'>('auto')
  // Không chọn sẵn gì: chủ shop tự chọn trang muốn quản lý (chọn IG thì Fanpage nguồn tự được chọn theo).
  const [selected, setSelected] = useState<string[]>([])

  const candidates = result.data?.status === 'ok' ? result.data.candidates : []
  const missing = missingPermissions(candidates)
  const anySelectable = candidates.some((c) => c.selectable)

  const retryButton = (variant: 'primary' | 'secondary' = 'primary') => (
    <Button variant={variant} onClick={() => onRetry(provider)} disabled={retrying} icon={retrying ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />}>
      Thử lại
    </Button>
  )

  if (result.isPending) {
    return (
      <Modal open onClose={onClose} title={TITLE} width={520}>
        <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
          <Loader2 size={16} className="animate-spin" /> {isThreads ? 'Đang đọc tài khoản Threads…' : 'Đang đọc danh sách trang từ Meta…'}
        </p>
      </Modal>
    )
  }

  if (result.isError) {
    const expired = isApiError(result.error) && result.error.status === 404
    return (
      <Notice
        onClose={onClose}
        icon={<AlertTriangle size={20} className="text-amber-600" />}
        title={expired ? 'Phiên kết nối đã hết hạn' : 'Chưa đọc được kết quả kết nối'}
        footer={
          <>
            <Button onClick={onClose}>Đóng</Button>
            {retryButton()}
          </>
        }
      >
        {expired ? 'Kết quả kết nối chỉ giữ 15 phút và chỉ dùng được một lần. Bấm Thử lại để kết nối lại.' : errorMessageOf(result.error, provider)}
      </Notice>
    )
  }

  const data = result.data
  if (data.status === 'error') {
    const cancelled = data.errorCode === 'OAUTH_CANCELLED'
    return (
      <Notice
        onClose={onClose}
        icon={cancelled ? <XCircle size={20} className="text-muted-foreground" /> : <AlertTriangle size={20} className="text-amber-600" />}
        title={cancelled ? 'Bạn đã huỷ kết nối' : 'Kết nối chưa thành công'}
        footer={
          <>
            <Button onClick={onClose}>Đóng</Button>
            {retryButton()}
          </>
        }
      >
        {cancelled
          ? `Chưa có ${isThreads ? 'tài khoản' : 'trang'} nào được thêm. Bấm Thử lại khi bạn sẵn sàng cấp quyền cho OnTheTopMoney.`
          : errorMessage(data.errorCode, provider)}
      </Notice>
    )
  }

  if (missing.length > 0 && stage === 'auto') {
    return (
      <Modal
        open
        onClose={onClose}
        width={500}
        title={
          <span className="flex items-center gap-2">
            <AlertTriangle size={20} className="text-amber-600" /> {MISSING_TITLES[provider]}
          </span>
        }
        footer={
          <>
            {anySelectable ? <Button onClick={() => setStage('pick')}>Chọn trang đã đủ quyền</Button> : <Button onClick={onClose}>Đóng</Button>}
            {retryButton()}
          </>
        }
      >
        {isThreads ? (
          <p className="text-sm">
            Threads chưa cấp các quyền dưới đây, nên app chưa thể đọc và trả lời bình luận hay đăng bài thay bạn. Bấm <strong>Thử lại</strong> và giữ nguyên mọi quyền khi Threads hỏi.
          </p>
        ) : (
          <p className="text-sm">
            Meta chưa cấp các quyền dưới đây cho trang bạn chọn, nên app chưa thể trả lời tin nhắn và đăng bài thay bạn. Bấm <strong>Thử lại</strong> và giữ nguyên mọi quyền khi Meta hỏi.
          </p>
        )}
        <ul className="mt-3 space-y-1.5 rounded-md border border-amber-200 bg-warning-soft/40 p-3 text-sm" aria-label="Quyền còn thiếu">
          {missing.map((s) => (
            <li key={s} className="flex flex-wrap items-baseline gap-x-2">
              <span className="font-medium">{PERMISSION_LABELS[s] ?? s}</span>
              <code className="text-xs text-muted-foreground">{s}</code>
            </li>
          ))}
        </ul>
      </Modal>
    )
  }

  // Meta: Fanpage kèm IG liên kết; Threads: mỗi tài khoản một dòng.
  const groups = candidateGroupsFor(provider, candidates)
  const picked = selected
  const count = picked.length
  // Kết quả đã hết hạn / đã dùng (vd xác nhận ở tab khác) → xác nhận lại vô ích, chỉ còn cách chạy lại OAuth.
  const resultGone = confirm.isError && isApiError(confirm.error) && confirm.error.status === 404

  const submit = () => {
    if (!count || confirm.isPending) return
    confirm.mutate({ resultId, accountIds: picked }, { onSuccess: (res) => onConnected(res.pages) })
  }

  return (
    <Modal
      open
      onClose={onClose}
      width={640}
      title={TITLE}
      footer={
        groups.length > 0 && !resultGone ? (
          <>
            <Button onClick={onClose}>Huỷ</Button>
            <Button variant="primary" disabled={!count || confirm.isPending} onClick={submit} icon={confirm.isPending ? <Loader2 size={15} className="animate-spin" /> : undefined}>
              {confirm.isPending ? 'Đang kết nối…' : `Kết nối${count ? ` ${count} ${isThreads ? 'tài khoản' : 'trang'}` : ''}`}
            </Button>
          </>
        ) : (
          <>
            <Button onClick={onClose}>Đóng</Button>
            {retryButton()}
          </>
        )
      }
    >
      {groups.length === 0 ? (
        <p className="text-sm">
          {isThreads
            ? 'Threads không trả về tài khoản nào. Đăng nhập đúng tài khoản Threads rồi bấm Thử lại.'
            : 'Meta không trả về Fanpage nào. Kiểm tra bạn là quản trị viên của Fanpage và đã chọn Fanpage khi Meta hỏi, rồi bấm Thử lại.'}
        </p>
      ) : (
        <>
          <p className="mb-3 text-[13px] text-muted-foreground">
            {isThreads
              ? 'Chọn tài khoản Threads muốn quản lý trong OnTheTopMoney. Threads là tài khoản riêng, không đi theo Fanpage.'
              : 'Chọn Fanpage và tài khoản Instagram Business muốn quản lý trong OnTheTopMoney. Instagram dùng quyền của Fanpage liên kết.'}
          </p>
          {data.truncated && (
            <p className="mb-3 rounded-md border border-amber-200 bg-warning-soft/40 px-3 py-2 text-xs text-amber-900" role="status">
              Chỉ hiện {OAUTH_MAX_PAGES.toLocaleString('vi-VN')} trang đầu.
            </p>
          )}
          <ul className="space-y-2.5">
            {groups.map((g) => (
              <li key={g.page.accountId} className={cn('grid grid-cols-1 gap-2', !isThreads && 'sm:grid-cols-2')}>
                <CandidateCard candidate={g.page} checked={picked.includes(g.page.accountId)} onToggle={() => setSelected(toggleCandidate(picked, candidates, g.page.accountId))} />
                {isThreads ? null : g.linked.length > 0 ? (
                  g.linked.map((ig) => (
                    <CandidateCard key={ig.accountId} candidate={ig} checked={picked.includes(ig.accountId)} onToggle={() => setSelected(toggleCandidate(picked, candidates, ig.accountId))} />
                  ))
                ) : (
                  <p className="flex items-center rounded-md border border-dashed border-border px-3 py-2.5 text-xs text-muted-foreground">Chưa liên kết Instagram</p>
                )}
              </li>
            ))}
          </ul>
          {confirm.isError && (
            <p className="mt-3 text-sm text-danger-foreground" role="alert">
              {resultGone ? 'Kết quả kết nối đã hết hạn hoặc đã được dùng. Bấm Thử lại để kết nối lại.' : errorMessageOf(confirm.error, provider)}
            </p>
          )}
        </>
      )}
    </Modal>
  )
}

function CandidateCard({ candidate: c, checked, onToggle }: { candidate: OAuthCandidate; checked: boolean; onToggle: () => void }) {
  const lock = lockReasonText(c)
  return (
    <label
      className={cn(
        'flex items-start gap-3 rounded-md border px-3 py-2.5',
        lock ? 'cursor-not-allowed border-border bg-slate-50' : checked ? 'cursor-pointer border-primary bg-primary-soft/30' : 'cursor-pointer border-border hover:bg-slate-50',
      )}
    >
      <input type="checkbox" className="mt-1 size-4 accent-primary" disabled={!!lock} checked={!lock && checked} onChange={onToggle} aria-label={`Chọn ${c.name}`} />
      <span className="relative inline-flex shrink-0">
        {c.avatarUrl ? (
          <img src={c.avatarUrl} alt="" className="size-8 rounded-full object-cover" />
        ) : (
          <span className="flex size-8 items-center justify-center rounded-full bg-slate-200 text-xs font-semibold text-slate-700">{c.name.slice(0, 1).toUpperCase()}</span>
        )}
        <span className="absolute -right-0.5 -bottom-0.5 rounded-full bg-white p-px">
          <PlatformIcon platform={c.platform} size={13} />
        </span>
      </span>
      <span className="min-w-0 flex-1">
        <span className={cn('block truncate text-sm font-medium', lock && 'text-muted-foreground')}>{c.name}</span>
        <span className="block truncate text-xs text-muted-foreground">
          {c.handle ? `@${c.handle} · ` : ''}
          {platformLabel[c.platform]}
        </span>
        {lock ? (
          <span className="mt-1 flex items-start gap-1 text-xs text-amber-800">
            <Lock size={12} className="mt-0.5 shrink-0" /> {lock}
          </span>
        ) : (
          checked && (
            <span className="mt-1 flex items-center gap-1 text-xs text-success-foreground">
              <Check size={12} /> Sẽ kết nối
            </span>
          )
        )}
      </span>
    </label>
  )
}

function Notice({ onClose, icon, title, children, footer }: { onClose: () => void; icon: ReactNode; title: string; children: ReactNode; footer: ReactNode }) {
  return (
    <Modal
      open
      onClose={onClose}
      width={460}
      title={
        <span className="flex items-center gap-2">
          {icon} {title}
        </span>
      }
      footer={footer}
    >
      <p className="text-sm">{children}</p>
    </Modal>
  )
}
