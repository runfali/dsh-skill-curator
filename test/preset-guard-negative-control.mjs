/**
 * 反向对照：同一个真实拓扑下，**去掉就绪握手**（= 修复前的代码形态），
 * 必须复现真机那条报错 "names unknown global tools"。
 *
 * 为什么必须做：PASS 只证明「加了握手能过」，不证明「握手是过的原因」。
 * 没有这个反向对照，前面的 PASS 可能来自别的因素（拓扑、时序碰巧）。
 *
 * 跑法：node D:/DSH/_tmp/verify-negative-control.mjs
 */
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(pathToFileURL(join(ROOT, 'package.json')).href)
const depsRoot = dirname(require.resolve('@deepseek-ai/dsh-tools/package.json'))
const sib = join(depsRoot, '..')
const load = (rel) => import(pathToFileURL(join(sib, rel)).href)

const { Context } = await load('cordis/lib/index.js')
const { createScope } = await load('dsh-scope/lib/index.js')
const { ToolRuntime } = await load('dsh-tools/lib/index.js')

const { TOOL_NAMES } = await import(pathToFileURL(join(ROOT, 'src/skill-tools.js')).href)

const log = []
const root = new Context()

const systemPromptStub = {
  tools: () => () => {}, section: () => () => {},
  getContextOrder: () => 0, getSectionOrder: () => 0, context: () => () => {}
}

const owner = root.plugin({ name: 'preset-registry', apply() { log.push('registry apply') } }).ctx

root.plugin({
  name: 'system-prompt-stub',
  apply(ctx) { ctx.provide('systemPrompt', systemPromptStub) }
})

root.plugin({
  name: 'tools-runtime',
  inject: ['systemPrompt'],
  apply(ctx) { new ToolRuntime(ctx, {}) }
})

// 兄弟行 skill-curator：**延迟**注册工具（模拟它还要等 settings 服务）
// 这正是真机竞态的形态：preset 行只等 tools，所以它会先跑完。
root.plugin({
  name: 'skill-curator',
  inject: ['gate'],
  apply(ctx) {
    for (const name of TOOL_NAMES) {
      // 真实注册一个最小可用定义
      ctx.tools.register({
        name,
        description: 'stub',
        parameters: { type: 'object', properties: {} },
        output: { schema: { type: 'object' }, render: () => [] },
        execute: async () => ({})
      })
    }
    log.push(`skill-curator registered ${TOOL_NAMES.length} tools (late)`)
    ctx.provide('skillCuratorTools', { names: [...TOOL_NAMES] })
  }
})

// preset：**不 inject 就绪标记**（= 修复前的 preset-guard.inject）
const scope = createScope(owner, {})
let caught
scope.ctx.extend({ baseUrl: undefined }).plugin({
  name: 'preset-guard-old',
  inject: ['tools'],                       // ← 旧形态：只等 tools
  apply(ctx) {
    try {
      ctx.tools.restrict({ allow: TOOL_NAMES })
      log.push('restrict accepted (unexpected!)')
    } catch (error) {
      caught = error.message
      log.push('restrict threw: ' + error.message.slice(0, 90))
    }
  }
})

// gate 晚一点才来，保证 preset 抢跑
setTimeout(() => { log.push('gate provided (skill-curator may now register)'); root.provide('gate', true) }, 60)

await new Promise((r) => setTimeout(r, 700))

console.log('=== event order ===')
log.forEach((l, i) => console.log(`  ${i + 1}. ${l}`))

const reproduced = typeof caught === 'string' && /names unknown global tools/.test(caught)
console.log('\n=== verdict ===')
console.log(`复现真机报错 : ${reproduced ? 'YES' : 'NO'}`)
if (caught) console.log(`报错原文     : ${caught.slice(0, 200)}`)
console.log(`\n${reproduced ? 'PASS — 反向对照成立：没有握手就会抛这条错，握手确实是修复的原因' : 'FAIL — 没复现，说明握手不是唯一因素，前面的 PASS 不可信'}`)
process.exitCode = reproduced ? 0 : 1
