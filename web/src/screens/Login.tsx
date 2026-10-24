// Màn đăng nhập tối giản (AD-19) — một ô mật khẩu cho chủ shop. Không có đăng ký qua web.
// [ASSUMPTION] EXPERIENCE.md chưa có màn này: dùng token của index.css + Voice and Tone.
import { LockKeyhole } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom'
import { ScreenSkeleton } from '../components/Skeleton'
import { Button, Card, Field, Input } from '../components/ui'
import { safeNext, useLogin, useMe } from '../lib/session'
import { errorMessageOf } from '../lib/error-messages'
import { privacyPolicyHref } from '../lib/privacy'

export default function Login() {
  const [params] = useSearchParams()
  const next = safeNext(params.get('next'))
  const navigate = useNavigate()
  const me = useMe()
  const login = useLogin()
  const [password, setPassword] = useState('')

  if (me.isPending) return <ScreenSkeleton label="Đang kiểm tra phiên đăng nhập…" />
  if (me.data) return <Navigate to={next} replace />

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!password || login.isPending) return
    login.mutate(password, {
      onSuccess: () => navigate(next, { replace: true }),
      onError: () => setPassword(''),
    })
  }

  const errorId = 'login-error'
  return (
    <main className="flex min-h-full items-center justify-center bg-background p-6">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center justify-center gap-2.5">
          <span className="flex size-9 items-center justify-center rounded-md bg-primary font-bold text-white">O</span>
          <span className="text-lg font-bold tracking-tight">OnTheTopMoney</span>
        </div>
        <Card className="p-6">
          <h1 className="text-xl font-bold tracking-tight">Đăng nhập</h1>
          <p className="mt-1 text-sm text-muted-foreground">Nhập mật khẩu chủ shop để mở app.</p>
          <form className="mt-5 space-y-4" onSubmit={submit} noValidate>
            <Field label="Mật khẩu">
              <Input
                type="password"
                name="password"
                autoComplete="current-password"
                autoFocus
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                aria-invalid={login.isError || undefined}
                aria-describedby={login.isError ? errorId : undefined}
              />
            </Field>
            {login.isError && (
              <p id={errorId} role="alert" className="text-[13px] font-medium text-danger-foreground">
                {errorMessageOf(login.error)}
              </p>
            )}
            <Button type="submit" variant="primary" className="w-full" disabled={!password || login.isPending} icon={<LockKeyhole size={16} />}>
              {login.isPending ? 'Đang đăng nhập…' : 'Đăng nhập'}
            </Button>
          </form>
        </Card>
        <p className="mt-4 text-center text-xs text-muted-foreground">
          Quên mật khẩu? Đặt lại trên máy chủ bằng lệnh <code className="font-mono">npm run set-password -w server</code>.
        </p>
        <p className="mt-2 text-center text-xs">
          <a href={privacyPolicyHref()} target="_blank" rel="noopener noreferrer" className="text-muted-foreground hover:text-primary hover:underline">
            Chính sách quyền riêng tư
          </a>
        </p>
      </div>
    </main>
  )
}
