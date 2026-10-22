import { defineConfig } from 'drizzle-kit'
import { DEV_DB_URL } from './scripts/lib/embedded-pg.ts'

// Bảng Drizzle nằm ở `src/platform/db/schema.ts` và `src/modules/<module>/schema.ts` (AD-1).
export default defineConfig({
  dialect: 'postgresql',
  schema: ['./src/platform/db/schema.ts', './src/modules/*/schema.ts'],
  out: './drizzle',
  dbCredentials: { url: process.env.DATABASE_URL ?? DEV_DB_URL },
  casing: 'snake_case',
  strict: true,
})
