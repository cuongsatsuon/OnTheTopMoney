// Phần thuần của plugin build `.htaccess` (web/vite.config.ts): kiểm `VITE_API_ORIGIN` và điền mẫu
// `deploy/hostinger/htaccess.template`. Tách ra để test được không cần chạy Vite.

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

/**
 * Kiểm `VITE_API_ORIGIN` lúc build (mọi `--mode`). Trống → `''` (api cùng origin). Có giá trị → phải là origin
 * `scheme://host[:port]` (không path, không query, không dấu `/` cuối) và https, trừ host loopback (thử
 * `vite preview` cục bộ với api ở http://localhost:3000). Sai → ném Error có thông báo rõ.
 */
export function validateApiOrigin(raw: string | undefined): string {
  const value = (raw ?? '').trim()
  if (!value) return ''
  const fail = (why: string): never => {
    throw new Error(`VITE_API_ORIGIN không hợp lệ ('${value}'): ${why}. Ví dụ đúng: https://api.example.com`)
  }
  if (!URL.canParse(value)) fail('không phải URL')
  const url = new URL(value)
  if (url.protocol !== 'https:' && url.protocol !== 'http:') fail('chỉ nhận http(s)')
  if (url.username || url.password) fail('không được chứa thông tin đăng nhập')
  if (url.origin !== value) fail('phải là origin dạng scheme://host[:port] — không path, không query, không dấu / cuối')
  if (url.protocol !== 'https:' && !LOOPBACK_HOSTS.has(url.hostname)) fail('chỉ nhận https (trừ localhost/127.0.0.1)')
  return value
}

/**
 * Điền mẫu `.htaccess`: origin api vào CSP `connect-src` / `img-src`. Chỉ dùng cho chế độ tách (có origin api) —
 * cùng VPS thì nginx phục vụ dist, không sinh `.htaccess`.
 */
export function renderHtaccess(template: string, apiOrigin: string): string {
  if (!apiOrigin) throw new Error('renderHtaccess cần origin api (VITE_API_ORIGIN)')
  const out = template.replaceAll('{{API_SRC}}', ` ${apiOrigin}`).replaceAll('{{API_ORIGIN_LABEL}}', apiOrigin)
  const left = /\{\{[A-Z_]+\}\}/.exec(out)
  if (left) throw new Error(`htaccess.template còn chỗ trống chưa điền: ${left[0]}`)
  return out
}
