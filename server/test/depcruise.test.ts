import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// `bin/` không nằm trong `exports` của gói → suy từ entry chính (src/main/index.mjs).
const depcruiseBin = fileURLToPath(new URL('../../bin/dependency-cruiser.mjs', import.meta.resolve('dependency-cruiser')))
const configPath = fileURLToPath(new URL('../.dependency-cruiser.cjs', import.meta.url))
const fixtureDir = fileURLToPath(new URL('./fixtures/ad1-violation', import.meta.url))
const serverDir = fileURLToPath(new URL('..', import.meta.url))

function run(cwd: string, outputType: 'err' | 'json') {
  return spawnSync(process.execPath, [depcruiseBin, 'src', '--config', configPath, '--output-type', outputType], {
    cwd,
    encoding: 'utf8',
    timeout: 60_000,
  })
}

/** `err` (mặc định của `npm run depcruise`) cho exit code; `json` để đọc danh sách vi phạm. */
function cruise(cwd: string) {
  const report = JSON.parse(run(cwd, 'json').stdout) as {
    summary: { error: number; violations: { rule: { name: string }; from: string; to: string }[] }
  }
  return { status: run(cwd, 'err').status, report }
}

describe('dependency-cruiser — ranh giới AD-1', () => {
  it('fixture vi phạm: báo lỗi, exit ≠ 0', () => {
    const { status, report } = cruise(fixtureDir)
    expect(status).not.toBe(0)
    const found = report.summary.violations.map((v) => `${v.rule.name}: ${v.from} → ${v.to}`).sort()
    expect(found).toEqual([
      'ad1-inbox: src/modules/inbox/index.ts → src/modules/campaigns/index.ts',
      'ad1-module-internals-from-outside: src/app/main.ts → src/modules/inbox/reply.ts',
      'ad1-module-internals: src/modules/inbox/reply.ts → src/modules/connections/token.ts',
      'no-circular: src/modules/ai/index.ts → src/modules/ai/loop.ts',
      'layer-infra-no-business: src/platform/bad.ts → src/modules/connections/index.ts',
      'layer-no-entrypoint-imports: src/modules/connections/uses-app.ts → src/app/main.ts',
      'ad1-unknown-module: src/modules/rogue/index.ts → src/modules/rogue/index.ts',
      'ad1-loose-module-file: src/modules/loose.ts → src/modules/loose.ts',
      'ad7-openai-only-ai: src/app/uses-openai.ts → src/adapters/openai/index.ts',
      'ad6-meta-adapter-only: src/app/uses-meta.ts → src/adapters/meta/index.ts',
      'ad6-meta-adapter-only: src/modules/campaigns/meta.ts → src/adapters/meta/index.ts',
    ].sort())
  })

  it('mọi mục dưới src/modules/ là thư mục có trong dependency-rules.cjs', () => {
    const { arrows, base } = createRequire(import.meta.url)('../dependency-rules.cjs') as {
      arrows: Record<string, string[]>
      base: string[]
    }
    const registered = new Set([...Object.keys(arrows), ...base])
    const entries = readdirSync(new URL('../src/modules', import.meta.url), { withFileTypes: true })
    for (const entry of entries) {
      expect(entry.isDirectory(), `src/modules/${entry.name} phải là thư mục`).toBe(true)
      expect(registered.has(entry.name), `src/modules/${entry.name} chưa khai báo`).toBe(true)
    }
  })

  it('src thật không vi phạm', () => {
    const { status, report } = cruise(serverDir)
    expect(report.summary.violations).toEqual([])
    expect(status).toBe(0)
  })
})
