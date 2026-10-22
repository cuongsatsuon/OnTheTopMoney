// Route OAuth công khai (Story 2.2, AD-23). Nằm ngoài /api/v1 (Meta chuyển hướng trình duyệt tới đây) nên
// guard auth không áp: route tự đọc cookie phiên và `connections` so với phiên lưu cùng `state` — không khớp
// thì không đổi `code`. Luôn trả 302 về màn của app (lỗi bất ngờ cũng vậy); URL chuyển hướng không chứa token.
// `/oauth/{facebook,threads}/fake-consent`: trang đồng ý giả cục bộ, chỉ đăng ký khi `META_FAKE=1` (dev).
// Threads (Story 2.3): `/oauth/threads/callback` cùng khung với Facebook.
// Location tuyệt đối theo `WEB_BASE_URL`: callback ở host api, web có thể ở host khác (Hostinger).
// Location luôn kết thúc bằng fragment rỗng (`…#`): Meta/Threads nối `#_` / `#_=_` vào URL callback và trình duyệt
// giữ fragment đó qua 302 nếu Location không có fragment riêng.
import type { OAuthProvider } from '@ottm/shared'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import {
  FACEBOOK_CALLBACK_PATH,
  FACEBOOK_FAKE_CONSENT_PATH,
  FAKE_CODE,
  FAKE_THREADS_CODE,
  THREADS_CALLBACK_PATH,
  THREADS_FAKE_CONSENT_PATH,
  errorLocation,
  handleFacebookCallback,
  handleThreadsCallback,
  webLocation,
  type CallbackQuery,
  type ConnectionsDeps,
} from '../modules/connections/index.ts'
import { resolveSession } from '../modules/settings/index.ts'
import { SESSION_COOKIE } from './auth/index.ts'

const firstString = (v: unknown): string | undefined =>
  typeof v === 'string' ? v : Array.isArray(v) && typeof v[0] === 'string' ? v[0] : undefined

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

/** Trang đồng ý giả: "Đồng ý" (kèm tuỳ chọn bỏ quyền tin nhắn) → callback với `code` giả; "Huỷ" → `error=access_denied`. */
export function fakeConsentHtml(state: string): string {
  const s = escapeHtml(state)
  return `<!doctype html>
<html lang="vi">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Meta giả — Đồng ý kết nối</title>
<style>
  :root { color-scheme: light; }
  body { margin: 0; font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; background: #f0f2f5; color: #1c1e21; }
  main { max-width: 440px; margin: 48px auto; padding: 0 16px; }
  .card { background: #fff; border-radius: 12px; box-shadow: 0 1px 3px rgba(0,0,0,.12); padding: 24px; }
  .badge { display: inline-block; font-size: 12px; font-weight: 600; color: #92400e; background: #fef3c7; border-radius: 999px; padding: 2px 10px; }
  h1 { font-size: 20px; margin: 12px 0 4px; }
  p { margin: 0 0 12px; color: #4b5563; }
  ul { margin: 0 0 16px; padding-left: 20px; color: #374151; }
  label { display: flex; gap: 8px; align-items: flex-start; padding: 12px; border: 1px solid #e5e7eb; border-radius: 8px; margin-bottom: 16px; cursor: pointer; }
  .row { display: flex; gap: 8px; }
  button { flex: 1; font: inherit; font-weight: 600; border-radius: 8px; padding: 10px 14px; cursor: pointer; border: 1px solid #d1d5db; background: #fff; color: #1c1e21; }
  button.primary { background: #0866ff; border-color: #0866ff; color: #fff; }
</style>
</head>
<body>
<main>
  <div class="card">
    <span class="badge">Chế độ Meta giả (META_FAKE=1) — chỉ dùng khi dev</span>
    <h1>OnTheTopMoney muốn kết nối với Facebook của bạn</h1>
    <p>Meta giả sẽ trả về 2 Fanpage:</p>
    <ul>
      <li>Mỹ phẩm Lan Anh (giả) — có Instagram Business liên kết</li>
      <li>Gia dụng Minh Phát (giả) — Instagram liên kết chưa phải tài khoản Business</li>
    </ul>
    <form method="get" action="${FACEBOOK_CALLBACK_PATH}" id="consent">
      <input type="hidden" name="state" value="${s}">
      <input type="hidden" name="code" value="${FAKE_CODE.full}" id="code">
      <label><input type="checkbox" id="drop-messaging"> <span><strong>Bỏ quyền tin nhắn</strong><br><small>Không cấp pages_messaging và instagram_manage_messages — để thử thông báo thiếu quyền.</small></span></label>
      <div class="row">
        <button type="submit" name="error" value="access_denied" formnovalidate id="cancel">Huỷ</button>
        <button type="submit" class="primary" id="agree">Đồng ý</button>
      </div>
    </form>
  </div>
</main>
<script>
  document.getElementById('agree').addEventListener('click', function () {
    // Huỷ rồi quay lại (bfcache) để ô code bị tắt → bật lại.
    document.getElementById('code').disabled = false
    document.getElementById('code').value = document.getElementById('drop-messaging').checked ? '${FAKE_CODE.noMessaging}' : '${FAKE_CODE.full}'
  })
  document.getElementById('cancel').addEventListener('click', function () {
    document.getElementById('code').disabled = true
  })
</script>
</body>
</html>`
}

/**
 * Trang đồng ý Threads giả: "Đồng ý" (kèm tuỳ chọn bỏ quyền trả lời) → callback với `code` giả và fragment `#_`
 * như Threads thật (form GET giữ fragment của `action`); "Huỷ" → `error=access_denied`.
 */
export function fakeThreadsConsentHtml(state: string): string {
  const s = escapeHtml(state)
  const full = FAKE_THREADS_CODE.full
  const noReplies = FAKE_THREADS_CODE.noReplies
  return `<!doctype html>
<html lang="vi">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Threads giả — Đồng ý kết nối</title>
<style>
  :root { color-scheme: light; }
  body { margin: 0; font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; background: #f5f5f5; color: #101010; }
  main { max-width: 440px; margin: 48px auto; padding: 0 16px; }
  .card { background: #fff; border-radius: 16px; box-shadow: 0 1px 3px rgba(0,0,0,.12); padding: 24px; }
  .badge { display: inline-block; font-size: 12px; font-weight: 600; color: #92400e; background: #fef3c7; border-radius: 999px; padding: 2px 10px; }
  h1 { font-size: 20px; margin: 12px 0 4px; }
  p { margin: 0 0 12px; color: #4b5563; }
  ul { margin: 0 0 16px; padding-left: 20px; color: #374151; }
  label { display: flex; gap: 8px; align-items: flex-start; padding: 12px; border: 1px solid #e5e7eb; border-radius: 10px; margin-bottom: 16px; cursor: pointer; }
  .row { display: flex; gap: 8px; }
  button { flex: 1; font: inherit; font-weight: 600; border-radius: 10px; padding: 10px 14px; cursor: pointer; border: 1px solid #d1d5db; background: #fff; color: #101010; }
  button.primary { background: #101010; border-color: #101010; color: #fff; }
</style>
</head>
<body>
<main>
  <div class="card">
    <span class="badge">Chế độ Meta giả (META_FAKE=1) — chỉ dùng khi dev</span>
    <h1>OnTheTopMoney muốn kết nối với Threads của bạn</h1>
    <p>Threads giả sẽ trả về tài khoản @lananh.threads với các quyền:</p>
    <ul>
      <li>threads_basic, threads_content_publish</li>
      <li>threads_read_replies, threads_manage_replies</li>
      <li>threads_manage_insights</li>
    </ul>
    <form method="get" action="${THREADS_CALLBACK_PATH}#_" id="consent">
      <input type="hidden" name="state" value="${s}">
      <input type="hidden" name="code" value="${full}" id="code">
      <label><input type="checkbox" id="drop-replies"> <span><strong>Bỏ quyền trả lời</strong><br><small>Không cấp threads_read_replies và threads_manage_replies — để thử thông báo thiếu quyền.</small></span></label>
      <div class="row">
        <button type="submit" name="error" value="access_denied" formnovalidate id="cancel">Huỷ</button>
        <button type="submit" class="primary" id="agree">Đồng ý</button>
      </div>
    </form>
  </div>
</main>
<script>
  document.getElementById('agree').addEventListener('click', function () {
    // Huỷ rồi quay lại (bfcache) để ô code bị tắt → bật lại.
    document.getElementById('code').disabled = false
    document.getElementById('code').value = document.getElementById('drop-replies').checked ? '${noReplies}' : '${full}'
  })
  document.getElementById('cancel').addEventListener('click', function () {
    document.getElementById('code').disabled = true
  })
</script>
</body>
</html>`
}

type CallbackHandler = (deps: ConnectionsDeps, input: { sessionId: string | null; query: CallbackQuery }) => Promise<{ location: string }>

function callbackRoute(deps: ConnectionsDeps, provider: OAuthProvider, handle: CallbackHandler) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const q = (req.query ?? {}) as Record<string, unknown>
    try {
      const session = await resolveSession(deps.db, req.cookies[SESSION_COOKIE])
      const { location } = await handle(deps, {
        sessionId: session?.id ?? null,
        query: { code: firstString(q.code), state: firstString(q.state), error: firstString(q.error) },
      })
      return reply.redirect(`${location}#`, 302)
    } catch (err) {
      // Không log err đầy đủ (có thể mang URL / phản hồi): chỉ tên lỗi. Lỗi trước khi đọc state → chưa biết màn
      // gốc: về Trang & Nhóm, kèm nền tảng (lỗi sau khi đọc state đã được `connections` chuyển về đúng màn gốc).
      req.log.error({ provider, errName: err instanceof Error ? err.name : typeof err }, 'OAuth callback lỗi')
      return reply.redirect(`${webLocation(deps.config, errorLocation(provider, 'pages', 'INTERNAL'))}#`, 302)
    }
  }
}

function fakeConsentRoute(html: (state: string) => string) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const state = firstString((req.query as Record<string, unknown> | undefined)?.state) ?? ''
    return reply
      .header('Cache-Control', 'no-store')
      .header('Referrer-Policy', 'no-referrer')
      .type('text/html; charset=utf-8')
      .send(html(state.slice(0, 200)))
  }
}

export function registerOAuth(app: FastifyInstance, deps: ConnectionsDeps): void {
  app.get(FACEBOOK_CALLBACK_PATH, callbackRoute(deps, 'facebook', handleFacebookCallback))
  app.get(THREADS_CALLBACK_PATH, callbackRoute(deps, 'threads', handleThreadsCallback))

  if (deps.config.META_FAKE) {
    app.get(FACEBOOK_FAKE_CONSENT_PATH, fakeConsentRoute(fakeConsentHtml))
    app.get(THREADS_FAKE_CONSENT_PATH, fakeConsentRoute(fakeThreadsConsentHtml))
  }
}
