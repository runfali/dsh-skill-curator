/**
 * dsh-skill-curator host apply 全链路集成测试。
 *
 * 运行：node --test test/apply.test.mjs
 * 真实加载 @deepseek-ai/dsh-settings / dsh-tools（经 node_modules symlink），
 * mock cordis ctx（effect/on/inject/settings/tools/logger/get），
 * 验证：
 * 1. apply 全链路注册（7 工具经真实 defineTool 编译、agent/created 监听、
 *    /skill-refine 命令、status 接口、设置命名空间 configure）
 * 2. 触发链路：agent/created → turn-stopping ×3 → 异步评审调度（mock subagents）
 * 3. 子代理排除：header.origin==='subagent' / delegationDepth>0 不计数
 * 4. enabled=false 不触发；interval 动态生效
 * 5. 互斥：评审进行中重复触发被跳过
 *
 * 评审历史持久化到临时文件（DSH_CURATOR_HISTORY 必须在 import 前设置——
 * 模块单例在加载时按该路径同步读盘），避免测试污染真实 ~/.dsh。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_CURATOR_HISTORY = join(mkdtempSync(join(tmpdir(), 'sc-apply-')), 'reviews.json')
// 注意：reviewLog 是 export let（historyPath 覆盖时 apply 会重建），
// 解构 import 会快照旧引用——经 mod 延迟读取才是 live binding。
const mod = await import('../src/index.js')
const { apply, name } = mod
const reviewLog = mod.reviewLog
import { Config } from '../src/settings.js'

// 0.1.7 起设置值不再经 settings 服务读回：apply 收到的 config 里，可热编辑字段
// 是 {get()} 活引用（宿主 _commitVolatile 原地写入），普通字段是裸值。
// 名字仍导出着，防止有测试把它当 schema 用。
void Config

/**
 * 0.1.7 语义助手：config 里的每个字段都变成 `{get()}` 活引用，
 * 与宿主 `_commitVolatile` 注入运行中 fiber 的形状一致。
 */
function live(config = {}) {
  const out = {}
  for (const [key, value] of Object.entries(config)) out[key] = { get: () => value }
  return out
}

function makeCtx(config = {}) {
  const effects = []
  const listeners = new Map() // event -> [cb]
  const tools = []
  const commands = []
  const routes = []
  const agentCtxs = []
  const presentations = []

  const ctx = {
    fiber: { state: 0 },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    effect(fn) {
      const disposer = fn()
      effects.push(typeof disposer === 'function' ? disposer : undefined)
      return disposer
    },
    on(event, cb) {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push(cb)
      return () => {
        const arr = listeners.get(event) || []
        const i = arr.indexOf(cb)
        if (i >= 0) arr.splice(i, 1)
      }
    },
    inject(services, cb) { cb(ctx) },
    settings: {
      // dsh 0.1.7：installSection / register 均已从 dsh-settings 移除（全库 0 命中），
      // 只剩 configure(presentation, owner) —— 注册设置页展示策略。
      // 设置值不再经 settings 读回：apply 直接收到 config 对象，volatile 字段是 {get()} 活引用。
      configure(presentation, owner) {
        presentations.push({ presentation, owner })
        return () => {}
      }
    },
    get(key) {
      if (key === 'commands') return { register(def) { commands.push(def); return () => {} } }
      if (key === 'webServer') return { register(route) { routes.push(route); return () => {} } }
      return undefined
    },
    tools: { register(def) { tools.push(def) } },
    // agent 级 scoped ctx 工厂：真实环境 agent.ctx.on 只收本 agent 事件
    createAgentCtx(agent) {
      const actxListeners = new Map()
      const actx = {
        on(event, cb) {
          if (!actxListeners.has(event)) actxListeners.set(event, [])
          actxListeners.get(event).push(cb)
          return () => {}
        }
      }
      agentCtxs.push({ agent, listeners: actxListeners })
      return actx
    },
    __test: { effects, listeners, tools, commands, routes, agentCtxs, presentations }
  }
  return ctx
}

function makeAgent(ctx, { origin, delegationDepth, legacyEvents } = {}) {
  const history = [
    { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '第一轮提问' }] } },
    { type: 'assistant/message', data: { message: { source: { kind: 'model' }, content: [{ type: 'text', text: '第一轮回答' }] } } }
  ]
  const session = {
    id: 'sess-' + Math.random().toString(36).slice(2, 8),
    header: { ...(origin !== undefined ? { origin } : {}), ...(delegationDepth !== undefined ? { delegationDepth } : {}) }
  }
  if (legacyEvents) {
    // 旧版 dsh（≤0.1.2-alpha.3）形状：Session 直接暴露 events 属性
    session.events = history
  } else {
    // dsh 0.1.2-alpha.4+ 真实形状：Session 仅有 snapshotEvents()（无 events 属性）
    session.snapshotEvents = () => history
  }
  return { id: session.id, session, ctx: ctx.createAgentCtx({}) }
}

const emitOn = (listeners, event, ...args) => Promise.all((listeners.get(event) || []).map((cb) => cb(...args)))

test('apply registers full chain (tools/listener/command/route)', async () => {
  const env = makeCtx({})
  apply(env, {})
  const t = env.__test
  assert.equal(t.tools.length, 7, 'seven skill-library tools registered')
  assert.equal(t.listeners.has('agent/created'), true, 'agent/created listener registered')
  assert.equal(t.commands.length, 1, '/skill-refine registered')
  assert.equal(t.commands[0].name, 'skill-refine')
  assert.equal(t.routes.length, 1, 'status route registered')
  assert.equal(t.routes[0].path, '/api/skill-curator/status')
  // 0.1.7：设置页展示策略仍要注册（关掉宿主按 schema 自动生成的默认页）
  assert.equal(t.presentations.length, 1, 'settings.configure called once')
  assert.equal(t.presentations[0].presentation.auto, false, 'auto page disabled')
})

test('tools read live (dereferenced) config: excludedSkills works as a protection list', async () => {
  // 回归：excludedSkills 是 volatile 活引用。若工具注册时传 base()（原始 config），
  // Array.isArray({get:…}) === false → 保护名单静默失效（写入保护形同虚设）。
  const dir = mkdtempSync(join(tmpdir(), 'sc-live-'))
  const env = makeCtx({})
  env.get = () => undefined
  let excluded = ['keep-me']
  apply(env, { skillsRoot: dir, excludedSkills: { get: () => excluded } })
  const t = env.__test
  const tool = (name) => t.tools.find((d) => d.name === name)
  const sig = { signal: new AbortController().signal }

  const created = await tool('skill-library-create').execute(
    { name: 'keep-me', description: 'd', content: '# x' }, sig)
  assert.equal(created.ok, false, 'live excludedSkills blocks creation')
  assert.ok(created.error.includes('excludedSkills'))

  const okCreate = await tool('skill-library-create').execute(
    { name: 'free-one', description: 'd', content: '# x' }, sig)
  assert.equal(okCreate.ok, true, 'non-member still writable')

  // 活引用之后变化也要生效（热改保护名单）
  excluded = []
  const nowOk = await tool('skill-library-create').execute(
    { name: 'keep-me', description: 'd', content: '# x' }, sig)
  assert.equal(nowOk.ok, true, 'clearing the live list unblocks writes')
})

test('trigger chain: 3 turns fire one review via mocked subagents', async () => {
  const started = []
  const env = makeCtx({})
  env.get = (key) => {
    if (key === 'subagents') {
      return {
        getProvider(n) { return n === 'spawn' ? { name: n } : undefined },
        list: () => ['spawn'],
        async start(provider, request) {
          started.push({ provider, label: request.label, prompt: request.prompt, toolFilter: request.toolFilter })
          return {
            result: Promise.resolve({
              output: [{ type: 'text', text: '已创建 skill demo-flow（演示流程）。' }],
              stopReason: 'completed'
            }),
            dispose: async () => {}
          }
        }
      }
    }
    if (key === 'commands') return { register() { return () => {} } }
    return undefined
  }
  apply(env, {})
  const t = env.__test

  // 模拟一个真人 agent 发布
  const createdPayloads = []
  for (const cb of t.listeners.get('agent/created')) createdPayloads.push(cb)
  const agent = makeAgent(env)
  await emitOn(t.listeners, 'agent/created', { agent })
  assert.equal(t.agentCtxs.length, 1, 'agent scoped ctx captured')

  // 前 2 轮不触发，第 3 轮触发
  const turnCbs = t.agentCtxs[0].listeners.get('agent/turn-stopping') || []
  assert.equal(turnCbs.length, 1, 'turn-stopping scoped listener attached')
  for (let i = 0; i < 2; i++) await emitOn(t.agentCtxs[0].listeners, 'agent/turn-stopping', { turn: i + 1 })
  assert.equal(started.length, 0, 'no review before interval')

  await emitOn(t.agentCtxs[0].listeners, 'agent/turn-stopping', { turn: 3 })
  await new Promise((r) => setTimeout(r, 10)) // 微任务调度
  assert.equal(started.length, 1, 'review spawned at interval')
  assert.equal(started[0].provider, 'spawn')
  assert.equal(started[0].toolFilter.allow.length, 7, 'whitelist lists all seven tools')
  const promptText = started[0].prompt.map((b) => b.text || '').join('\n')
  assert.ok(promptText.includes('第一轮提问'), 'digest contains user turn')
  assert.ok(promptText.includes('技能策展子代理'), 'instructions appended')
  assert.ok(promptText.includes('skill-library-delete'), 'delete tool advertised to the reviewer')

  // 结果落 reviewLog
  await new Promise((r) => setTimeout(r, 10))
  const recent = reviewLog.recent()
  assert.ok(recent.length >= 1, 'review logged')
  assert.equal(recent[0].ok, true)
  assert.ok(recent[0].actions[0].includes('demo-flow'), 'summary surfaced')
})

test('subagent-origin and delegated agents never trigger', async () => {
  const env = makeCtx({})
  env.get = () => ({ register() { return () => {} } })
  apply(env, {})
  const t = env.__test

  const subAgent = makeAgent(env, { origin: 'subagent' })
  const delegated = makeAgent(env, { delegationDepth: 2 })
  await emitOn(t.listeners, 'agent/created', { agent: subAgent })
  await emitOn(t.listeners, 'agent/created', { agent: delegated })
  assert.equal(
    t.agentCtxs.some((a) => a.listeners.has('agent/turn-stopping')),
    false,
    'neither got a scoped turn-stopping listener'
  )
})

test('enabled=false suppresses trigger; interval change applies live', async () => {
  const started = []
  const env = makeCtx()
  env.get = (key) => {
    if (key === 'subagents') {
      return {
        getProvider(n) { return n === 'spawn' ? { name: n } : undefined },
        list: () => ['spawn'],
        async start(provider, request) {
          started.push(request)
          return { result: Promise.resolve({ output: [], stopReason: 'completed' }), dispose: async () => {} }
        }
      }
    }
    return undefined
  }
  const toggles = { enabled: true, skillNudgeInterval: 2 }
  const toggle = (key, value) => { toggles[key] = value }
  apply(env, { enabled: { get: () => toggles.enabled }, skillNudgeInterval: { get: () => toggles.skillNudgeInterval } })
  const t = env.__test
  const agent = makeAgent(env)
  await emitOn(t.listeners, 'agent/created', { agent })

  toggle('enabled', false)
  await emitOn(t.agentCtxs[0].listeners, 'agent/turn-stopping', { turn: 1 })
  await emitOn(t.agentCtxs[0].listeners, 'agent/turn-stopping', { turn: 2 })
  assert.equal(started.length, 0, 'disabled → no review')

  toggle('enabled', true)
  await emitOn(t.agentCtxs[0].listeners, 'agent/turn-stopping', { turn: 3 }) // bump 1
  await emitOn(t.agentCtxs[0].listeners, 'agent/turn-stopping', { turn: 4 }) // bump 2 → fire
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(started.length, 1, 'fires at interval=2 after re-enable')

  // 动态间隔：改为 5 后（计数已清零）连续 4 轮不再触发
  toggle('skillNudgeInterval', 5)
  for (let i = 5; i <= 8; i++) await emitOn(t.agentCtxs[0].listeners, 'agent/turn-stopping', { turn: i })
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(started.length, 1, 'interval change applied to live agent')
})

test('empty-status session (no user/model turns) never spawns review', async () => {
  const started = []
  const env = makeCtx()
  env.get = (key) => {
    if (key === 'subagents') {
      return {
        getProvider(n) { return n === 'spawn' ? { name: n } : undefined },
        list: () => ['spawn'],
        async start(provider, request) {
          started.push(request)
          return { result: Promise.resolve({ output: [], stopReason: 'completed' }), dispose: async () => {} }
        }
      }
    }
    return undefined
  }
  apply(env, live({ skillNudgeInterval: 1 }))
  const t = env.__test
  // 会话 events 只有 tool 结果与插件注入，没有 user/model 回合
  const session = {
    id: 'sess-empty',
    header: {},
    events: [
      { type: 'tool/result', data: { message: { content: [] } } },
      { type: 'user/message', data: { source: { kind: 'plugin', plugin: 'x' }, content: [{ type: 'text', text: '系统提醒' }] } },
      { type: 'turn/start', data: { turn: 1 } }
    ]
  }
  const agent = { id: 'sess-empty', session, ctx: env.createAgentCtx({}) }
  await emitOn(t.listeners, 'agent/created', { agent })
  const cbs = t.agentCtxs[0].listeners.get('agent/turn-stopping')
  for (const cb of cbs) await cb({ turn: 1 })
  for (const cb of cbs) await cb({ turn: 2 })
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(started.length, 0, 'no review for content-less session')
})

test('alpha.4 session shape (snapshotEvents, no events property) still spawns review (2026-09-02 回归)', async () => {
  const started = []
  const env = makeCtx()
  env.get = (key) => {
    if (key === 'subagents') {
      return {
        getProvider(n) { return n === 'spawn' ? { name: n } : undefined },
        list: () => ['spawn'],
        async start(provider, request) {
          started.push(request)
          return { result: Promise.resolve({ output: [], stopReason: 'completed' }), dispose: async () => {} }
        }
      }
    }
    return undefined
  }
  apply(env, live({ skillNudgeInterval: 1 }))
  const t = env.__test
  // dsh 0.1.2-alpha.4 真实形状：session 只有 snapshotEvents()，读 events 属性为
  // undefined——修复前摘要恒空，每次评审被静默跳过（无记录、无日志）
  const session = {
    id: 'sess-alpha4',
    header: {},
    snapshotEvents: () => [
      { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '真实回合输入' }] } },
      { type: 'assistant/message', data: { message: { source: { kind: 'model' }, content: [{ type: 'text', text: '真实回合输出' }] } } }
    ]
  }
  const agent = { id: 'sess-alpha4', session, ctx: env.createAgentCtx({}) }
  await emitOn(t.listeners, 'agent/created', { agent })
  const cbs = t.agentCtxs[0].listeners.get('agent/turn-stopping')
  for (const cb of cbs) await cb({ turn: 1 })
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(started.length, 1, 'review spawned on alpha.4 session shape')
  const promptText = started[0].prompt.map((b) => b.text || '').join('\n')
  assert.ok(promptText.includes('真实回合输入'), 'digest built from snapshotEvents')
})

test('legacy session shape (plain events array) keeps working via fallback', async () => {
  const started = []
  const env = makeCtx()
  env.get = (key) => {
    if (key === 'subagents') {
      return {
        getProvider(n) { return n === 'spawn' ? { name: n } : undefined },
        list: () => ['spawn'],
        async start(provider, request) {
          started.push(request)
          return { result: Promise.resolve({ output: [], stopReason: 'completed' }), dispose: async () => {} }
        }
      }
    }
    return undefined
  }
  apply(env, live({ skillNudgeInterval: 1 }))
  const t = env.__test
  const agent = makeAgent(env, { legacyEvents: true })
  await emitOn(t.listeners, 'agent/created', { agent })
  const cbs = t.agentCtxs[0].listeners.get('agent/turn-stopping')
  for (const cb of cbs) await cb({ turn: 1 })
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(started.length, 1, 'review spawned on legacy events shape')
  const promptText = started[0].prompt.map((b) => b.text || '').join('\n')
  assert.ok(promptText.includes('第一轮提问'), 'digest built from legacy events')
})

test('mutual exclusion: concurrent triggers are skipped', async () => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const started = []
  const env = makeCtx({})
  env.get = (key) => {
    if (key === 'subagents') {
      return {
        getProvider(n) { return n === 'spawn' ? { name: n } : undefined },
        list: () => ['spawn'],
        async start(provider, request) {
          started.push(request)
          await gate
          return { result: Promise.resolve({ output: [], stopReason: 'completed' }), dispose: async () => {} }
        }
      }
    }
    return undefined
  }
  apply(env, live({ skillNudgeInterval: 1 }))
  const t = env.__test
  const agent = makeAgent(env)
  await emitOn(t.listeners, 'agent/created', { agent })
  const cbs = t.agentCtxs[0].listeners.get('agent/turn-stopping')

  for (const cb of cbs) await cb({ turn: 1 })
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(started.length, 1, 'first review running (gated)')
  // 评审未结束，再次触发应跳过
  for (const cb of cbs) await cb({ turn: 2 })
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(started.length, 1, 'second trigger skipped while running')
  release()
  await new Promise((r) => setTimeout(r, 20))
})

test('/skill-refine command schedules with focus', async () => {
  const started = []
  const env = makeCtx({})
  env.get = (key) => {
    if (key === 'commands') return { register(def) { env.__cmd = def; return () => {} } }
    if (key === 'subagents') {
      return {
        getProvider() { return undefined },
        list: () => ['fork'],
        async start(p, request) {
          started.push({ provider: p, request })
          return { result: Promise.resolve({ output: [{ type: 'text', text: '无需保存。' }], stopReason: 'completed' }), dispose: async () => {} }
        }
      }
    }
    return undefined
  }
  apply(env, {})
  const cmd = env.__cmd
  const agent = makeAgent(env)
  await emitOn(env.__test.listeners, 'agent/created', { agent })
  const out = await cmd.handler({ agent, rawInput: ' 重点提炼部署流程 ', signal: new AbortController().signal })
  assert.equal(out.kind, 'success')
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(started.length, 1)
  assert.equal(started[0].provider, 'fork', 'provider fallback when spawn missing')
  assert.ok(started[0].request.prompt[0].text.includes('重点提炼部署流程'), 'focus clause injected')
})

test('historyPath override rebuilds store immediately (P2-1)', async () => {
  const env = makeCtx({})
  const dir = mkdtempSync(join(tmpdir(), 'sc-hist-'))
  const target = join(dir, 'custom-reviews.json')
  apply(env, { historyPath: target })
  // 重建后 path 立即指向覆盖路径（经 mod 读 live binding——reviewLog 是 export let）
  assert.equal(mod.reviewLog.path, target, 'store path must switch in-process')
  mod.reviewLog.record({ at: new Date().toISOString(), sessionId: 'x', ok: true, actions: ['a'] })
  const parsed = JSON.parse(readFileSync(target, 'utf8'))
  assert.ok(Array.isArray(parsed) && parsed.length >= 1, 'record persisted to override path')
})

test('turn counter inherited across agent re-creation per sessionId (P2-2)', async () => {
  const started = []
  const env = makeCtx({})
  env.get = (key) => {
    if (key === 'subagents') {
      return {
        getProvider() { return undefined },
        list: () => ['spawn'],
        async start(p, request) {
          started.push({ provider: p, request })
          return { result: Promise.resolve({ output: [{ type: 'text', text: '无需保存。' }], stopReason: 'completed' }), dispose: async () => {} }
        }
      }
    }
    return undefined
  }
  apply(env, {})
  const t = env.__test
  // 第一次 agent：2 轮（不触发）
  const agent1 = makeAgent(env)
  await emitOn(t.listeners, 'agent/created', { agent: agent1 })
  const cb1 = t.agentCtxs.at(-1).listeners.get('agent/turn-stopping') || []
  assert.equal(cb1.length, 1)
  for (let i = 0; i < 2; i++) await cb1[0]({ turn: i + 1 })
  assert.equal(started.length, 0)
  // agent 重建（同一 sessionId），第 3 轮应立即触发（计数继承）
  const agent2 = makeAgent(env)
  agent2.session.id = agent1.session.id // 继承同一 session
  await emitOn(t.listeners, 'agent/created', { agent: agent2 })
  const cb2 = t.agentCtxs.at(-1).listeners.get('agent/turn-stopping') || []
  assert.equal(cb2.length, 1)
  await cb2[0]({ turn: 3 })
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(started.length, 1, 'counter inherited → 3rd turn fires review')
})

test('stale agent disposed must not drop inherited counter (P2-2 race)', async () => {
  const started = []
  const env = makeCtx({})
  env.get = (key) => {
    if (key === 'subagents') {
      return {
        getProvider() { return undefined },
        list: () => ['spawn'],
        async start(p, request) {
          started.push({ provider: p, request })
          return { result: Promise.resolve({ output: [{ type: 'text', text: '无需保存。' }], stopReason: 'completed' }), dispose: async () => {} }
        }
      }
    }
    return undefined
  }
  apply(env, {})
  const t = env.__test
  // agent1：创建并跑 2 轮（不触发）
  const agent1 = makeAgent(env)
  await emitOn(t.listeners, 'agent/created', { agent: agent1 })
  const cb1 = t.agentCtxs.at(-1).listeners.get('agent/turn-stopping') || []
  for (let i = 0; i < 2; i++) await cb1[0]({ turn: i + 1 })
  // agent2 同 session 继承计数
  const agent2 = makeAgent(env)
  agent2.session.id = agent1.session.id
  await emitOn(t.listeners, 'agent/created', { agent: agent2 })
  // agent1 的 disposed 延迟到达（旧 agent scoped ctx 的监听器）
  const disp1 = t.agentCtxs.at(-2).listeners.get('agent/disposed') || []
  assert.ok(disp1.length >= 1, 'agent1 has disposed listener')
  for (const cb of disp1) await cb({})
  // 继承计数未被误删：agent2 的第 3 轮应立即触发
  const cb2 = t.agentCtxs.at(-1).listeners.get('agent/turn-stopping') || []
  await cb2[0]({ turn: 3 })
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(started.length, 1, 'stale disposed must not reset inherited counter')
})
