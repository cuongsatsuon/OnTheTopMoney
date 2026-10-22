/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Origin của api lúc build (vd `https://api.example.com`) khi web nằm ở host khác (Hostinger). Trống → gọi
   * `/api/v1` cùng origin (dev qua proxy Vite). `vite.config.ts` kiểm định dạng khi build.
   */
  readonly VITE_API_ORIGIN?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
