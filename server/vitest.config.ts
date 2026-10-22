import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['test/fixtures/**', 'node_modules/**'],
    globalSetup: ['test/global-setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 120_000,
    // Các file test dùng chung một DB (worker_heartbeats, pgboss) → chạy tuần tự.
    fileParallelism: false,
  },
})
