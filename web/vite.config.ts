import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig, loadEnv, type Plugin } from 'vite'
import { renderHtaccess, validateApiOrigin } from './vite-htaccess.ts'

// API chạy ở :3000 (server/). Dev: proxy để web và API cùng origin → cookie phiên (SameSite=Lax, HttpOnly) đi kèm
// tự nhiên, giống production khi web + api cùng VPS sau reverse proxy (nginx). Chế độ tách (web trên Hostinger, api
// trên VPS): build với VITE_API_ORIGIN=https://api.<miền> (deploy/hostinger/publish-web-hostinger.sh).
const API_TARGET = process.env.API_TARGET ?? 'http://localhost:3000'
const HTACCESS_TEMPLATE = fileURLToPath(new URL('../deploy/hostinger/htaccess.template', import.meta.url))

/**
 * Lúc build: kiểm VITE_API_ORIGIN (sai → dừng build). Có VITE_API_ORIGIN (chế độ tách, web trên Hostinger) → phát
 * `dist/.htaccess` cho Apache/LiteSpeed (SPA fallback, header bảo mật với CSP gồm origin api, cache). Trống (web +
 * api cùng VPS, nginx phục vụ dist) → không sinh `.htaccess`. Không chạy khi dev.
 */
function hostingerHtaccess(): Plugin {
  let apiOrigin = ''
  return {
    name: 'ottm-hostinger-htaccess',
    apply: 'build',
    configResolved(config) {
      const env = loadEnv(config.mode, config.envDir || config.root, 'VITE_')
      apiOrigin = validateApiOrigin(env.VITE_API_ORIGIN)
    },
    generateBundle() {
      if (!apiOrigin) return
      this.emitFile({ type: 'asset', fileName: '.htaccess', source: renderHtaccess(readFileSync(HTACCESS_TEMPLATE, 'utf8'), apiOrigin) })
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss(), hostingerHtaccess()],
  server: {
    // Thử OAuth/webhook Meta qua tunnel (deploy/runbook.md mục 6.4): cho phép host của quick tunnel
    // cloudflared và host trong DEV_TUNNEL_HOSTS (phẩy ngăn cách, cho named tunnel).
    allowedHosts: ['.trycloudflare.com', ...(process.env.DEV_TUNNEL_HOSTS ?? '').split(',').map((h) => h.trim()).filter(Boolean)],
    proxy: {
      '/api': { target: API_TARGET },
      '/healthz': { target: API_TARGET },
      '/oauth': { target: API_TARGET },
      '/webhooks': { target: API_TARGET },
    },
  },
})
