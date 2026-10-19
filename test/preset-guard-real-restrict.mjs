/**
 * 决定性集成验证：用**真实** dsh-tools ToolRuntime 的 restrict 实现，
 * 跑真实 preset-guard 模块，验证「等就绪标记」后 restrict 不再抛错。
 *
 * 为什么必须做：mock 版测试只能证明「我们调用了 restrict」，证明不了
 * 「restrict 会接受这些名字」。真机 preset 一挂就报
 * "names unknown global tools"，所以验收必须打在真实 restrict 上。
 *
 * 依赖来源：插件自己的 pnpm store 里就是 0.2.1 的真实宿主包
 * （dsh-tools 的兄弟目录含 cordis / dsh-scope / dsh-system-prompt / schemastery）。
 *
 * 拓扑照抄 registry 的 activate()：
 *   owner = registry 的 ctx（root 下的一行）
 *   scope = createScope(owner, key)
 *   guard = scope.ctx.extend({baseUrl}).plugin(真实 preset-guard 模块)
 *
 * 跑法：node D:/DSH/_tmp/verify-real-restrict.mjs
 */
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(pathToFileURL(join(ROOT, 'package.json')).href)
const depsRoot = dirname(require.resolve('@deepseek-ai/dsh-tools/package.json'))
const sib = join(depsRoot, '..') // .../node_modules/@deepseek-ai
const load = (rel) => import(pathToFileURL(join(sib, rel)).href)

const { Context } = await load('cordis/lib/index.js')
const { createScope } = await load('dsh-scope/lib/index.js')
const { ToolRuntime } = await load('dsh-tools/lib/index.js')

const GUARD = pathToFileURL(join(ROOT, 'src/preset-guard.js')).href
const TOOLS = pathToFileURL(join(ROOT, 'src/skill-tools.js')).href

const log = []
const root = new Context()

// systemPrompt 桩：ToolRuntime 构造时要注册 schemas/section
const systemPromptStub = {
  tools: () => () => {},
  section: () => () => {},
  getContextOrder: () => 0,
  getSectionOrder: () => 0,
  context: () => () => {}
}

// registry 的 owner 层
const owner = root.plugin({ name: 'preset-registry', apply() { log.push('registry apply') } }).ctx

// systemPrompt 服务（ToolRuntime 的 inject 依赖）
root.plugin({
  name: 'system-prompt-stub',
  apply(ctx) { ctx.provide('systemPrompt', systemPromptStub); log.push('systemPrompt provided') }
})

// 真实 ToolRuntime（提供 tools 服务）
root.plugin({
  name: 'tools-runtime',
  inject: ['systemPrompt'],
  apply(ctx) { new ToolRuntime(ctx, {}); log.push('ToolRuntime constructed') }
})

// 兄弟行：skill-curator —— 注册真实工具定义，再发布就绪标记
const { createSkillToolDefinitions, TOOL_NAMES, TOOLS_READY_SERVICE } = await import(TOOLS)
root.plugin({
  name: 'skill-curator',
  inject: ['tools'],
  apply(ctx) {
    for (const def of createSkillToolDefinitions(() => ({ skillsRoot: 'C:/nonexistent' }))) {
      ctx.tools.register(def)
    }
    log.push(`skill-curator registered ${TOOL_NAMES.length} tools`)
    ctx.provide(TOOLS_READY_SERVICE, { names: [...TOOL_NAMES] })
    log.push('skill-curator provided ready marker')
  }
})

// preset：owner 下建 scope，挂**真实** preset-guard 模块
const guardModule = await import(GUARD)
const scope = createScope(owner, {})
scope.ctx.extend({ baseUrl: undefined }).plugin({
  name: 'preset-guard',
  inject: ['tools', TOOLS_READY_SERVICE],
  apply(ctx) {
    guardModule.apply(ctx)
    log.push('guard apply OK — real restrict accepted all names')
  }
})

await new Promise((r) => setTimeout(r, 600))

console.log('=== event order ===')
log.forEach((l, i) => console.log(`  ${i + 1}. ${l}`))

const ok = log.some((l) => l.startsWith('guard apply OK'))
console.log('\n=== verdict ===')
console.log(`真实 restrict 接受了白名单 : ${ok ? 'YES' : 'NO'}`)
console.log(`guard 修订标记             : ${guardModule.GUARD_REVISION}`)
console.log(`guard inject               : ${JSON.stringify(guardModule.inject)}`)
console.log(`\n${ok ? 'PASS — 修复在真实 restrict 上成立' : 'FAIL — 修复无效'}`)
process.exitCode = ok ? 0 : 1
