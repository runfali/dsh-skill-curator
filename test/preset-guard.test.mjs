/**
 * 契约守护：评审子代理的工具白名单载体（dsh 0.2.1-rc.2 适配轮）。
 *
 * 为什么需要它：0.2.1 起 `startLocal` 只把 `agentPreset` 写进 child
 * composition（dsh-subagent/lib/index.js:1452），评审子代理拿不到
 * `request.toolFilter`（continuation.js:124/168 那条路才读它，本地起子代理不走）。
 * 宿主 dsh-tool-subagent 对 `config.toolFilter` 直接抛错并指明
 * "configure persona and tool plugins in an Agent Preset" —— 官方把
 * 「按子代理过滤工具」的语义整个搬到了 preset 层。
 *
 * 于是白名单必须由 preset 承载：cordis.patch.yml 声明 preset 行 →
 * preset 内挂 src/preset-guard.js → 它在**子代理自己的 scope** 上调
 * `tools.restrict()`。任一段断了，评审子代理就会拿到父组合的全部工具
 * （含 shell/fs），而它的输入是完整会话摘要。
 *
 * ⚠️ 就绪握手（2026-10-18 真机事故后补）：`tools.restrict()` 用
 * `view(scope).restrictableNames` 校验名字，而它**只收继承面**（global 层 +
 * 祖先链，dsh-tools/lib/index.js:3058-3070）。profile 各行由
 * `EntryGroup.update` 的 `Promise.all` **并发**创建，preset 行只 inject
 * `tools`、skill-curator 还要等 `settings` → preset 先跑完，此刻
 * `skill-library-*` 尚未注册 → restrict 抛 "names unknown global tools"
 * → `activate()` 把 `record.broken` 写死（"A mount failure is final"），
 * 该 preset **永久** broken，设置页显示「加载失败」。
 * 修法是让 guard 等到 skill-curator 发布就绪标记再 apply。
 *
 * 运行：node --test test/preset-guard.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { apply as applyGuard, inject as guardInject, name as guardName, GUARD_REVISION } from '../src/preset-guard.js'
import { reviewPresetStatus } from '../src/index.js'
import { REVIEW_AGENT_PRESET } from '../src/reviewer.js'
import { TOOL_NAMES, TOOLS_READY_SERVICE } from '../src/skill-tools.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

test('preset-guard：在子代理 scope 上把工具面收敛到 skill-library-*', () => {
  const seen = []
  const ctx = { tools: { restrict: (filter) => { seen.push(filter); return () => {} } }, get: () => ({}) }
  applyGuard(ctx)
  assert.equal(seen.length, 1, '必须调用一次 restrict')
  assert.deepEqual(seen[0], { allow: TOOL_NAMES }, 'allow 面必须恰为 skill-library-* 白名单')
})

test('preset-guard：restrict 失败必须**重新抛出**并带修订标记（失败即关闭，不吞错）', () => {
  // 吞错继续 = 评审子代理带着父组合的全部工具（含 shell）去读完整会话摘要。
  // 修订标记则用来区分「preset 没重挂」与「重挂了但守卫仍失败」——
  // 两者在 record.broken 里逐字相同（registry: "A mount failure is final"）。
  const ctx = {
    tools: { restrict: () => { throw new Error('names unknown global tools') } },
    get: () => ({ names: [] })
  }
  assert.throws(() => applyGuard(ctx), (err) => {
    assert.ok(err.message.includes(GUARD_REVISION), `报错必须带修订标记 ${GUARD_REVISION}，实际：${err.message}`)
    assert.ok(err.message.includes('names unknown global tools'), '必须保留 cause，否则看不到真因')
    assert.ok(/resolvable=/.test(err.message), '必须回报就绪标记能否解析（区分「没等」与「等了但没用」）')
    return true
  })
})

test('preset-guard：声明 tools 服务依赖（缺它 restrict 会静默不生效）', () => {
  assert.ok(guardInject.includes('tools'), 'guard 必须 inject tools')
  assert.equal(guardName, 'skill-curator-review-guard')
})

test('preset-guard：必须等 skill-curator 的工具就绪标记（否则并发装载下 restrict 抢跑 → preset 永久 broken）', () => {
  assert.ok(
    guardInject.includes(TOOLS_READY_SERVICE),
    `guard 必须 inject ${TOOLS_READY_SERVICE}：profile 各行并发创建，` +
      '不等标记就会在 skill-library-* 注册前调 restrict，抛 "names unknown global tools"'
  )
})

test('skill-curator：注册完 skill-library-* 之后才发布就绪标记（顺序是全部意义所在）', () => {
  const src = readFileSync(join(ROOT, 'src/index.js'), 'utf8')
  const registerAt = src.indexOf('ctx.tools.register(definition)')
  const provideAt = src.indexOf(`ctx.provide(TOOLS_READY_SERVICE`)
  assert.ok(registerAt >= 0, 'index.js 必须注册工具')
  assert.ok(
    provideAt >= 0,
    `index.js 必须在注册后 ctx.provide(${TOOLS_READY_SERVICE}, …)：` +
      '标记先于注册会让 guard 在工具就位前放行'
  )
  assert.ok(
    provideAt > registerAt,
    `就绪标记必须在工具注册**之后**发布（register@${registerAt} vs provide@${provideAt}）`
  )
})

test('就绪标记名与 preset-guard 的 inject 共用同一常量（防止两处各写一个字面量而漂移）', () => {
  const src = readFileSync(join(ROOT, 'src/skill-tools.js'), 'utf8')
  // 字面量硬编码：preset-guard 是**另一个模块实例**（preset 行按
  // 'dsh-skill-curator/preset-guard' 子路径解析，主入口按 'dsh-skill-curator' 解析），
  // 两者共享同一份 skill-tools.js 模块实例的前提是解析到同一 realpath。
  // 名字一旦被静默改动，跨实例契约就断了——所以这里钉死字面量。
  assert.ok(
    src.includes("export const TOOLS_READY_SERVICE = 'skillCuratorTools'"),
    `TOOLS_READY_SERVICE 必须在 skill-tools.js 单点定义为 'skillCuratorTools'（实际：${TOOLS_READY_SERVICE}）`
  )
  assert.equal(TOOLS_READY_SERVICE, 'skillCuratorTools', '导出值必须与钉死的字面量一致')
})

test('preset-guard 必须**导入**该常量，不得自己再写一个字面量（单一事实源）', () => {
  const src = readFileSync(join(ROOT, 'src/preset-guard.js'), 'utf8')
  assert.ok(
    /import\s*\{[^}]*TOOLS_READY_SERVICE[^}]*\}\s*from\s*'\.\/skill-tools\.js'/.test(src),
    'preset-guard.js 必须从 ./skill-tools.js 导入 TOOLS_READY_SERVICE：' +
      '自己写一份字面量，改常量时两处会静默漂移，guard 永远等不到标记（白名单失效且无报错）'
  )
  assert.ok(
    !/const\s+TOOLS_READY_SERVICE\s*=/.test(src),
    'preset-guard.js 不得本地重定义 TOOLS_READY_SERVICE'
  )
})

// ── 验收诊断（reviewPresetStatus）────────────────────────────────────
// 为什么需要：preset 的 mount 失败会被 `activate()` 吞掉、只写死 record.broken，
// 而 Loader 行照样显示 fiberPhase:'active' —— 看行状态会误判为正常（2026-10-18
// 真机就踩了这个：我一度用行 active 当作验收通过）。这个诊断读的是
// `agentPresets.list()`，它每次调用都重跑 diagnostic()，是活体判据。

test('reviewPresetStatus：preset 健康时返回 ok', async () => {
  const ctx = {
    get: (k) => (k === 'agentPresets'
      ? { list: async () => [{ id: 'standard', order: 1 }, { id: REVIEW_AGENT_PRESET, order: 99 }] }
      : undefined)
  }
  assert.deepEqual(await reviewPresetStatus(ctx), { id: REVIEW_AGENT_PRESET, ok: true })
})

test('reviewPresetStatus：preset 报错时如实回报 broken 文本（不吞错）', async () => {
  const brokenText = 'preset-guard: tools.restrict() names unknown global tools "skill-library-list"'
  const ctx = {
    get: (k) => (k === 'agentPresets'
      ? { list: async () => [{ id: REVIEW_AGENT_PRESET, order: 99, broken: brokenText }] }
      : undefined)
  }
  const out = await reviewPresetStatus(ctx)
  assert.equal(out.id, REVIEW_AGENT_PRESET)
  assert.equal(out.broken, brokenText, '必须原样带出 broken，否则排查时看不到真因')
})

test('reviewPresetStatus：服务缺失 / 未声明 / 抛错一律降级为 error，绝不炸路由', async () => {
  assert.deepEqual(
    await reviewPresetStatus({ get: () => undefined }),
    { error: 'agentPresets service unavailable' }
  )
  assert.deepEqual(
    await reviewPresetStatus({ get: () => ({ list: async () => [{ id: 'standard' }] }) }),
    { error: `preset ${REVIEW_AGENT_PRESET} not declared` }
  )
  const thrown = await reviewPresetStatus({
    get: () => ({ list: async () => { throw new Error('registry exploded') } })
  })
  assert.equal(thrown.error, 'registry exploded', '抛错必须被兜住并回显，否则状态路由 500')
})

test('preset-guard：apply 必须同步（Cordis 契约：await 后注册 effect 会抛 Invalid effect）', () => {
  const seen = []
  const ctx = { tools: { restrict: (f) => { seen.push(f); return () => {} } }, get: () => ({}) }
  const ret = applyGuard(ctx)
  assert.equal(ret, undefined, 'apply 不得返回 Promise')
  assert.equal(seen.length, 1, 'restrict 必须在同步段完成')
})

test('cordis.patch.yml：声明了评审 preset 行并指向本包 preset-guard', () => {
  const patch = readFileSync(join(ROOT, 'cordis.patch.yml'), 'utf8')
  assert.ok(patch.includes('preset-skill-curator-review'), '缺 preset 行 id')
  assert.ok(patch.includes('@deepseek-ai/dsh-agent-preset'), 'preset 行必须用 dsh-agent-preset 声明')
  // 行尾锚点（`$` 带 m 标志）是必需的：无锚点时 `id: skill-curator-review`
  // 会前缀匹配到 `id: skill-curator-review-typo`，让这条守护静默失效（变异 M10 实测）。
  assert.ok(
    new RegExp(`^\\s*id:\\s*${REVIEW_AGENT_PRESET}\\s*$`, 'm').test(patch),
    `preset 的 config.id 必须**恰好**等于 REVIEW_AGENT_PRESET（${REVIEW_AGENT_PRESET}）——两者不一致则评审起不来`
  )
  assert.ok(patch.includes("'dsh-skill-curator/preset-guard'"), 'preset 内必须挂本包的 preset-guard 子路径')
})

test('cordis.patch.yml：preset 行排官方之后（不抢默认选择位）', () => {
  const patch = readFileSync(join(ROOT, 'cordis.patch.yml'), 'utf8')
  const m = /id:\s*preset-skill-curator-review[\s\S]*?order:\s*(\d+)/.exec(patch)
  assert.ok(m, 'preset 行必须声明 order')
  assert.ok(Number(m[1]) >= 90, `order=${m[1]} 必须排在官方 preset（1..4）之后，避免误占默认位`)
})

test('package.json：exports 暴露 ./preset-guard（preset 行按包名解析它）', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  assert.equal(pkg.exports['./preset-guard'], './src/preset-guard.js')
  assert.ok(
    (pkg.files || []).includes('src'),
    'files 必须含 src/，否则发布后 preset-guard 不存在'
  )
})
