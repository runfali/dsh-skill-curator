/**
 * dsh-skill-curator — 宿主入口与声明契约守护测试（0.1.5-rc.1 适配轮新增）。
 *
 * 历史教训（dsh-plugin-audit 的第 0/1/4 路盲区）：
 *   - \`node --check\` 只查语法不查模块解析；smoke 只测零依赖逻辑模块；client-smoke
 *     只测 client 半——三路都绕开宿主入口的真实加载路径。真实 P0（schemastery 只有
 *     default export 却被 named import）就是靠 entry 直载才炸出来的。
 *   - 顶层 \`inject\` 写错服务名不会报错，插件会永远 pending（静默不生效）。
 *   - 「声明适配 X」必须有测试证明 engines 区间覆盖 X（npm semver 预发布规则：
 *     预发布只被「区间内含同 [major,minor,patch] 元组预发布」的区间满足）。
 *
 * 运行：node --test test/entry.test.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'

const PASS = []
const ok = (label) => { PASS.push(label); console.log('  ✓ ' + label) }
const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

// ---------------------------------------------------------------------------
// 1. 真实入口加载（P0 守卫：import 期错误当场炸出）
// ---------------------------------------------------------------------------
const mod = await import('../src/index.js')
assert.equal(typeof mod.apply, 'function', 'src/index.js 必须导出 apply 函数')
assert.equal(mod.name, 'skill-curator', 'Cordis 插件短名必须是 skill-curator')
assert.ok(Array.isArray(mod.inject), '顶层 inject 必须是数组')
assert.deepEqual([...mod.inject].sort(), ['settings', 'tools'], '顶层 inject 面必须恰为 settings + tools')
ok('宿主入口真实 import 成功（apply / name / inject 面齐备）')

// ---------------------------------------------------------------------------
// 2. 声明面：版本号、exports、bundle 挂载三面、client 半
// ---------------------------------------------------------------------------
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
assert.equal(typeof pkg.version, 'string', 'package.json 缺 version')
assert.equal(pkg.version, '0.1.5-rc.1', '版本号必须跟宿主发布号（家族惯例）')
assert.equal(pkg.type, 'module', '必须是 ESM 包')
assert.equal(pkg.exports['.'], './src/index.js', 'exports["."] 必须指向宿主入口')
assert.equal(pkg.exports['./client'], './lib/client.js', 'exports["./client"] 必须指向 client bundle')
assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml', 'dsh.bundle.patch 必须声明（装上≠挂载：无声明不进组合树）')
assert.equal(pkg.dsh.client.platform, 'web', 'dsh.client.platform 必须是 web')
const bundleNames = Array.isArray(pkg.dsh.bundle) ? [] : null
void bundleNames
ok('package.json 版本/导出/挂载声明齐备（version=' + pkg.version + '）')

// ---------------------------------------------------------------------------
// 3. dsh.engines.dsh 区间守护（内置判定表，不引 semver 依赖，防测试自身漂移）
// ---------------------------------------------------------------------------
const range = pkg.dsh && pkg.dsh.engines && pkg.dsh.engines.dsh
assert.equal(typeof range, 'string', 'package.json 缺 dsh.engines.dsh 声明')
ok('package.json 声明了 dsh.engines.dsh：' + range)

/** 手写 semver 比较器：只处理本仓区间用到的形状（不引依赖，防测试自身依赖漂移）。 */
function parseVersion(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(v).trim())
  if (!m) throw new Error('unparseable version: ' + v)
  return { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split('.') : [] }
}
function cmpPre(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const x = a[i]
    const y = b[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const nx = /^\d+$/.test(x)
    const ny = /^\d+$/.test(y)
    if (nx && ny) {
      if (Number(x) !== Number(y)) return Number(x) < Number(y) ? -1 : 1
      continue
    }
    if (nx !== ny) return nx ? -1 : 1
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}
function compare(a, b) {
  for (let i = 0; i < 3; i += 1) {
    if (a.nums[i] !== b.nums[i]) return a.nums[i] < b.nums[i] ? -1 : 1
  }
  if (a.pre.length === 0 && b.pre.length === 0) return 0
  if (a.pre.length === 0) return 1
  if (b.pre.length === 0) return -1
  return cmpPre(a.pre, b.pre)
}
/** npm semver 预发布可见性规则：预发布版本只被「区间内含同 [M,m,p] 元组预发布」的区间满足。 */
function preReleaseVisible(version, comparators) {
  if (version.pre.length === 0) return true
  return comparators.some((c) => {
    const mv = parseVersion(c.version)
    return mv.nums[0] === version.nums[0] && mv.nums[1] === version.nums[1] && mv.nums[2] === version.nums[2] && mv.pre.length > 0
  })
}
function satisfies(version, rng) {
  const v = parseVersion(version)
  for (const group of String(rng).split('||')) {
    const parts = group.trim().split(/\s+/).filter(Boolean)
    const comparators = []
    let groupOk = true
    for (const part of parts) {
      const m = /^(>=|<=|>|<|=)?\s*(.+)$/.exec(part)
      const op = m[1] || '='
      comparators.push({ op, version: m[2] })
      const c = compare(v, parseVersion(m[2]))
      if (op === '>=' && c < 0) groupOk = false
      else if (op === '<=' && c > 0) groupOk = false
      else if (op === '>' && c <= 0) groupOk = false
      else if (op === '<' && c >= 0) groupOk = false
      else if (op === '=' && c !== 0) groupOk = false
    }
    if (groupOk && preReleaseVisible(v, comparators)) return true
  }
  return false
}

const TABLE = [
  ['0.1.2-alpha.3', true],
  ['0.1.2-rc.1', true],
  ['0.1.5-alpha.1', true],
  ['0.1.5-alpha.2', true],
  ['0.1.5-rc.1', true],
  ['0.1.5', true],
  ['0.1.6', true],
  ['0.1.3-alpha.1', false],
  ['0.2.0', false],
  ['0.0.1', false]
]
for (const [version, expected] of TABLE) {
  assert.equal(satisfies(version, range), expected, 'engines 区间对 ' + version + ' 的判定应为 ' + expected + '（区间=' + range + '）')
}
ok('engines 判定表 ' + TABLE.length + ' 行逐行通过（含 0.1.5-rc.1 覆盖）')

// 反证：旧单区间不覆盖 0.1.5-rc.1 —— 这正是本次必须加析取的原因
assert.equal(satisfies('0.1.5-rc.1', '>=0.1.2-alpha.3 <0.2.0'), false, '旧单区间本不应覆盖 0.1.5-rc.1，判定器写反了')
ok('反证：旧单区间不覆盖 0.1.5-rc.1（故必须加析取，非冗余声明）')

// 交叉验证：同一判定表与宿主真实 semver 逐行一致（宿主不可解析则显式跳过，不假绿）
const req = createRequire(import.meta.url)
let semver = null
for (const candidate of ['/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/semver', 'semver']) {
  try { semver = req(candidate); break } catch { /* next */ }
}
if (semver && typeof semver.satisfies === 'function') {
  for (const [version, expected] of TABLE) {
    assert.equal(semver.satisfies(version, range), expected, '宿主 semver 对 ' + version + ' 的判定与内置判定表不一致')
  }
  ok('内置判定器与宿主真实 semver.satisfies 逐行一致（' + TABLE.length + '/' + TABLE.length + '）')
} else {
  ok('宿主 semver 不可解析，跳过交叉验证（不假绿）')
}

// 运行时依赖必须钉在同一发布号上（caret 语义在预发布下由 npm 自行判定：
// ^0.1.5-rc.1 会解析到 0.1.5-rc.1 这一发布号，正是家族惯例「版本号跟宿主发布号」的落地面）。
const dshDeps = Object.keys(pkg.dependencies || {}).filter((d) => d.startsWith('@deepseek-ai/dsh-'))
assert.equal(dshDeps.length, 4, 'dsh 系运行时依赖应为 4 个（llm/settings/subagent/tools）')
for (const dep of dshDeps) {
  assert.equal(pkg.dependencies[dep], '^' + pkg.version, dep + ' 必须钉在 ' + pkg.version + '（家族惯例：版本号跟宿主发布号）')
}
ok('4 个 @deepseek-ai/dsh-* 运行时依赖均钉在 ^' + pkg.version)

// ---------------------------------------------------------------------------
// 4. 宿主服务名真实存在（顶层 inject 写错名 = 插件永远 pending，且完全静默）
// ---------------------------------------------------------------------------
const HOST = '/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai'
const serviceOwners = {
  settings: join(HOST, 'dsh-settings', 'lib', 'index.js'),
  tools: join(HOST, 'dsh-tools', 'lib', 'index.js')
}
let hostChecked = 0
for (const svc of mod.inject) {
  const file = serviceOwners[svc]
  assert.ok(file, 'inject 声明了未知服务名：' + svc)
  let src
  try { src = readFileSync(file, 'utf8') } catch { continue }
  assert.ok(src.includes('super(ctx, "' + svc + '")'), '宿主源码里找不到服务 "' + svc + '" 的注册点（文件名或服务名漂移）')
  hostChecked += 1
}
ok(hostChecked === 2 ? '顶层 inject 的 2 个服务名均在宿主真实源码中找到注册点' : '宿主源码不可读，跳过服务名核验（不假绿）')

// ---------------------------------------------------------------------------
// 5. 键集合一致性（host Config ↔ client FIELDS 逐键相等）
//    不等 = 「设置页调不到该开关」且完全静默（dsh-plugin-audit 第八路盲区）。
// ---------------------------------------------------------------------------
const hostSrc = readFileSync(join(root, 'src', 'settings.js'), 'utf8')
const clientSrc = readFileSync(join(root, 'lib', 'client.js'), 'utf8')
const configBlock = /export const Config = z\.object\(\{([\s\S]*?)\n\}\)/.exec(hostSrc)
assert.ok(configBlock, 'src/settings.js 里找不到 Config schema（键集合守卫失效）')
const hostKeys = [...configBlock[1].matchAll(/^\s{2}([A-Za-z_][\w]*):/gm)].map((m) => m[1]).sort()
const fieldsBlock = /const FIELDS = \[([\s\S]*?)\n    \]/.exec(clientSrc)
assert.ok(fieldsBlock, 'lib/client.js 里找不到 FIELDS（键集合守卫失效）')
const clientKeys = [...fieldsBlock[1].matchAll(/key: "([^"]+)"/g)].map((m) => m[1]).sort()
assert.deepEqual(clientKeys, hostKeys, 'client FIELDS 键集合必须与 host Config 键集合逐键相等（缺一键 = 设置页调不到该开关）')
assert.equal(hostKeys.length, 13, 'host Config 键数为 13（漂移则同步本断言与文档）')
// 枚举字面量三处一致：host schema default / client 分段按钮选项 / 展示文案
for (const literal of ['off', 'on', 'verbose']) {
  assert.ok(hostSrc.includes("'" + literal + "'"), 'host schema 缺 notifyMode 字面量 ' + literal)
  assert.ok(clientSrc.includes('"' + literal + '"'), 'client 缺 notifyMode 字面量 ' + literal)
}
ok('键集合逐键相等（host Config ↔ client FIELDS，共 ' + hostKeys.length + ' 键）+ notifyMode 枚举三字面量一致')

// ---------------------------------------------------------------------------
// 6. 依赖卫生（家族硬要求：无安装脚本副作用 / 无原生编译 / 仅 @deepseek-ai 系）
// ---------------------------------------------------------------------------
const scripts = pkg.scripts || {}
for (const key of ['preinstall', 'install', 'postinstall', 'prepare', 'prepublishOnly']) {
  assert.equal(scripts[key], undefined, '包内不得声明安装类脚本副作用：' + key)
}
assert.equal(pkg.optionalDependencies, undefined, '不得声明 optionalDependencies')
for (const dep of Object.keys(pkg.dependencies || {})) {
  const allowed = dep.startsWith('@deepseek-ai/')
  assert.ok(allowed, '运行时依赖只允许 @deepseek-ai/* 系列（零 gyp 风险）：' + dep)
}
ok('依赖卫生：无安装脚本、无 optionalDependencies、依赖面仅 @deepseek-ai/*')

console.log('\nentry OK: ' + PASS.length + ' 组守护通过（判定表 ' + TABLE.length + ' 行交叉验证）')