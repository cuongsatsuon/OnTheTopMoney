// Trạng thái đăng nhập phía web (AD-19): query `/auth/me`, đăng nhập / đăng xuất,
// điều hướng `next` an toàn (chỉ đường dẫn nội bộ). Component chặn route: `auth.tsx`.
import { MeResponse } from '@ottm/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { ApiError, ME_QUERY_KEY, apiFetch, isApiError } from './api'

export const LOGIN_PATH = '/dang-nhap'

/** Chỉ nhận đường dẫn nội bộ bắt đầu bằng một `/` (chặn `//evil`, `/\evil`, URL tuyệt đối). */
export function safeNext(next: string | null | undefined): string {
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return '/'
  if ([...next].some((ch) => ch.charCodeAt(0) < 0x20)) return '/' // ký tự điều khiển
  if (next === LOGIN_PATH || next.startsWith(`${LOGIN_PATH}?`) || next.startsWith(`${LOGIN_PATH}/`)) return '/'
  return next
}

export function loginUrl(next: string): string {
  const target = safeNext(next)
  return target === '/' ? LOGIN_PATH : `${LOGIN_PATH}?next=${encodeURIComponent(target)}`
}

/** `MeResponse` khi có phiên, `null` khi 401; lỗi khác ném tiếp. */
export async function fetchMe({ signal }: { signal: AbortSignal }): Promise<MeResponse | null> {
  try {
    return await apiFetch('/auth/me', { schema: MeResponse, signal })
  } catch (err) {
    if (isApiError(err) && err.status === 401) return null
    throw err
  }
}

export function useMe() {
  return useQuery({ queryKey: ME_QUERY_KEY, queryFn: fetchMe, staleTime: 60_000 })
}

export function useLogin() {
  const queryClient = useQueryClient()
  return useMutation<void, ApiError, string>({
    mutationFn: (password) => apiFetch('/auth/login', { method: 'POST', body: { password } }),
    onSuccess: () => {
      queryClient.setQueryData(ME_QUERY_KEY, { authenticated: true } satisfies MeResponse)
    },
  })
}

export function useLogout() {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  return useMutation<void, ApiError>({
    mutationFn: () => apiFetch('/auth/logout', { method: 'POST' }),
    onSuccess: () => {
      navigate(LOGIN_PATH, { replace: true })
      // Bỏ toàn bộ cache của phiên cũ.
      queryClient.clear()
      queryClient.setQueryData(ME_QUERY_KEY, null)
    },
  })
}
