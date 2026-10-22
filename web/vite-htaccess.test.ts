import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { renderHtaccess, validateApiOrigin } from './vite-htaccess.ts'

const template = readFileSync(fileURLToPath(new URL('../deploy/hostinger/htaccess.template', import.meta.url)), 'utf8')

describe('validateApiOrigin (VITE_API_ORIGIN lúc build)', () => {
  it('trống → api cùng origin', () => {
    expect(validateApiOrigin(undefined)).toBe('')
    expect(validateApiOrigin('  ')).toBe('')
  })

  it('origin https hợp lệ', () => {
    expect(validateApiOrigin('https://api.example.com')).toBe('https://api.example.com')
    expect(validateApiOrigin('https://api.example.com:8443')).toBe('https://api.example.com:8443')
  })

  it.each(['https://api.example.com/', 'https://api.example.com/api', 'https://api.example.com?x=1', 'api.example.com', 'ftp://api.example.com', 'https://u:p@api.example.com'])(
    '%s → dừng build',
    (value) => {
      expect(() => validateApiOrigin(value)).toThrow(/VITE_API_ORIGIN không hợp lệ/)
    },
  )

  it('mọi lần build chỉ nhận https (kể cả --mode staging), trừ loopback (thử vite preview cục bộ)', () => {
    expect(() => validateApiOrigin('http://api.example.com')).toThrow(/https/)
    expect(validateApiOrigin('http://localhost:3000')).toBe('http://localhost:3000')
    expect(validateApiOrigin('http://127.0.0.1:3000')).toBe('http://127.0.0.1:3000')
    expect(validateApiOrigin('http://[::1]:3000')).toBe('http://[::1]:3000')
  })
})

describe('renderHtaccess', () => {
  const csp = (htaccess: string) => /Content-Security-Policy "([^"]+)"/.exec(htaccess)![1]!

  it('có origin api → CSP connect-src và img-src gồm api', () => {
    const out = renderHtaccess(template, 'https://api.example.com')
    expect(csp(out)).toContain("connect-src 'self' https://api.example.com;")
    expect(csp(out)).toMatch(/img-src 'self' data: blob: https:\/\/api\.example\.com /)
    expect(csp(out)).toMatch(/img-src [^;]*https:\/\/res\.cloudinary\.com/)
    expect(csp(out)).toContain("frame-ancestors 'none'")
    expect(out).not.toMatch(/\{\{/)
  })

  it('trống → lỗi (cùng origin không sinh .htaccess)', () => {
    expect(() => renderHtaccess(template, '')).toThrow(/VITE_API_ORIGIN/)
  })

  it('đủ các phần bắt buộc: HTTPS, SPA fallback trừ assets, header, cache, chặn liệt kê, bọc IfModule', () => {
    const out = renderHtaccess(template, 'https://api.example.com')
    expect(out).toContain('Options -Indexes')
    expect(out).toContain('RewriteRule ^ https://%{HTTP_HOST}%{REQUEST_URI} [L,R=301]')
    expect(out).toContain('RewriteRule ^assets/ - [E=OTTM_ASSET:1,L]')
    expect(out).toContain('RewriteRule ^ index.html [L]')
    for (const h of ['Strict-Transport-Security', 'X-Content-Type-Options "nosniff"', 'Referrer-Policy', 'X-Frame-Options "DENY"', 'Permissions-Policy']) {
      expect(out).toContain(`Header always set ${h}`)
    }
    expect(out).toContain('Header set Cache-Control "public, max-age=31536000, immutable" env=OTTM_ASSET')
    expect(out).toContain('Header set Cache-Control "no-cache" env=!OTTM_ASSET')
    // Mọi chỉ thị của module nằm trong <IfModule>.
    const body = out.split('\n').filter((l) => !l.trim().startsWith('#'))
    let depth = 0
    for (const line of body) {
      if (line.trim().startsWith('<IfModule')) depth++
      else if (line.trim().startsWith('</IfModule>')) depth--
      else if (/^\s*(Rewrite|Header|Expires|AddOutputFilter)/.test(line)) expect(depth, line).toBeGreaterThanOrEqual(1)
    }
    expect(depth).toBe(0)
  })

  it('mẫu còn chỗ trống lạ → lỗi', () => {
    expect(() => renderHtaccess('x {{KHAC}}', 'https://api.example.com')).toThrow(/KHAC/)
  })
})
