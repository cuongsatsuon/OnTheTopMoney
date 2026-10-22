// Postgres thật cho test: TEST_DATABASE_URL nếu có (CI dùng service postgres:18),
// ngược lại bật Postgres 18 nhúng trên cổng trống, dữ liệu tạm, xoá khi xong.
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TestProject } from 'vitest/node'
import { runMigrations } from '../src/platform/db/migrate.ts'
import { freePort } from './helpers/net.ts'

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string
  }
}

/**
 * `embedded-postgres` đăng ký `async-exit-hook` lúc nạp module: hook này nghe `beforeExit` và gọi
 * `process.exit(0)`, đè `process.exitCode = 1` mà vitest đặt khi có test đỏ → `vitest run` thoát 0. Ở `exit`
 * nó gọi hook dừng Postgres không kèm callback → `TypeError: done is not a function`.
 * Nạp module rồi gỡ đúng các listener `beforeExit` / `exit` mới thêm (teardown tự dừng Postgres; hook tín hiệu
 * SIGINT/SIGTERM giữ nguyên để Ctrl-C vẫn dừng Postgres).
 */
async function importWithoutExitOverride() {
  const beforeExit = new Set(process.listeners('beforeExit'))
  const exit = new Set(process.listeners('exit'))
  const mod = await import('../scripts/lib/embedded-pg.ts')
  for (const l of process.listeners('beforeExit')) if (!beforeExit.has(l)) process.removeListener('beforeExit', l)
  for (const l of process.listeners('exit')) if (!exit.has(l)) process.removeListener('exit', l)
  return mod
}

export default async function setup(project: TestProject) {
  let url = process.env.TEST_DATABASE_URL
  let teardown = async () => {}
  if (!url) {
    const { startEmbeddedPostgres } = await importWithoutExitOverride()
    const dataDir = await mkdtemp(join(tmpdir(), 'ottm-test-pg-'))
    const pg = await startEmbeddedPostgres({
      dataDir,
      port: await freePort(),
      database: 'ottm_test',
      persistent: false,
    })
    url = pg.url
    teardown = async () => {
      await pg.stop().catch(() => {})
      await rm(dataDir, { recursive: true, force: true })
    }
  }
  await runMigrations(url)
  project.provide('databaseUrl', url)
  return teardown
}
