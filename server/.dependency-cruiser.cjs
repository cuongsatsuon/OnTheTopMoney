// Ranh giới module (AD-1), sinh từ `dependency-rules.cjs`.
// Parser: swc — dependency-cruiser 18.7 chưa đọc được API của TypeScript 7 (xem spike-ts7.md).
const { arrows, base, metaCallers: META_CALLERS } = require('./dependency-rules.cjs')

const MODULES = [...Object.keys(arrows), ...base]
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const alt = (names) => names.map(esc).join('|')

/** Mỗi module một luật: chỉ được import module trong arrows[X] ∪ base ∪ {X}. */
const arrowRules = MODULES.map((mod) => {
  const allowed = base.includes(mod) ? [mod] : [...new Set([mod, ...arrows[mod], ...base])]
  return {
    name: `ad1-${mod}`,
    severity: 'error',
    comment: `AD-1: modules/${mod} chỉ được gọi: ${allowed.filter((m) => m !== mod).join(', ') || '(không module nào)'}`,
    from: { path: `^src/modules/${esc(mod)}/` },
    to: { path: '^src/modules/[^/]+/', pathNot: `^src/modules/(${alt(allowed)})/` },
  }
})

/**
 * Cấm một nhóm file theo cả ba hướng: nó import gì đó, bị ai đó import, hoặc mồ côi
 * (không import, không bị import) — để file "im lặng" cũng không lọt.
 */
const everyDirection = (name, comment, path) => [
  { name, severity: 'error', comment, from: { path }, to: {} },
  { name, severity: 'error', comment, from: {}, to: { path } },
  { name, severity: 'error', comment, from: { orphan: true, path }, to: {} },
]

module.exports = {
  forbidden: [
    ...arrowRules,
    ...everyDirection(
      'ad1-unknown-module',
      'Thư mục module chưa có trong dependency-rules.cjs — thêm vào bảng mũi tên AD-1 trước.',
      `^src/modules/(?!(${alt(MODULES)})/)[^/]+/`,
    ),
    ...everyDirection(
      'ad1-loose-module-file',
      'Không đặt file trực tiếp dưới src/modules/ — mỗi module là một thư mục có index.ts.',
      '^src/modules/[^/]+$',
    ),
    {
      name: 'ad1-module-internals',
      severity: 'error',
      comment: 'AD-1: ngoài module chỉ được import modules/<m>/index.ts, không import ruột module.',
      from: { path: '^src/modules/([^/]+)/' },
      to: { path: '^src/modules/([^/]+)/(?!index[.]ts$)', pathNot: '^src/modules/$1/' },
    },
    {
      name: 'ad1-module-internals-from-outside',
      severity: 'error',
      comment: 'AD-1: entrypoint, read-model, platform, adapter chỉ được import modules/<m>/index.ts.',
      from: { pathNot: '^src/modules/' },
      to: { path: '^src/modules/[^/]+/(?!index[.]ts$)' },
    },
    {
      name: 'layer-no-entrypoint-imports',
      severity: 'error',
      comment: 'Module, adapter, platform không import entrypoint (app/, worker/).',
      from: { path: '^src/(modules|adapters|platform)/' },
      to: { path: '^src/(app|worker)/' },
    },
    {
      name: 'layer-infra-no-business',
      severity: 'error',
      comment: 'Adapter và platform không biết nghiệp vụ: không import modules/.',
      from: { path: '^src/(adapters|platform)/' },
      to: { path: '^src/modules/' },
    },
    {
      name: 'ad7-openai-only-ai',
      severity: 'error',
      comment: 'AD-7: chỉ modules/ai gọi adapters/openai (AI gateway duy nhất).',
      from: { pathNot: '^src/(modules/ai|adapters/openai)/' },
      to: { path: '^src/adapters/openai/' },
    },
    {
      name: 'ad6-meta-adapter-only',
      severity: 'error',
      comment: `AD-6: chỉ modules/{${META_CALLERS.join(',')}} gọi adapters/meta (cổng Meta duy nhất); entrypoint cũng không.`,
      from: { pathNot: `^src/(modules/(${alt(META_CALLERS)})|adapters/meta)/` },
      to: { path: '^src/adapters/meta/' },
    },
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'Không vòng phụ thuộc.',
      from: {},
      to: { circular: true },
    },
  ],
  options: {
    // swc vẫn thấy `import type`, nên luật áp cả cho phụ thuộc chỉ-kiểu
    // (`tsPreCompilationDeps` cần API tsc, không dùng được với TS 7).
    parser: 'swc',
    doNotFollow: { path: 'node_modules' },
    exclude: { path: 'node_modules' },
    moduleSystems: ['es6'],
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'default'],
      extensions: ['.ts', '.js'],
    },
  },
}
