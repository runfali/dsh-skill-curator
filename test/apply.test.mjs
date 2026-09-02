/**
 * dsh-skill-curator host apply 全链路集成测试。
 *
 * 运行：node --test test/apply.test.mjs
 * 真实加载 @deepseek-ai/dsh-settings / dsh-tools（经 node_modules symlink），
 * mock cordis ctx（effect/on/inject/settings/tools/logger/get），
 * 验证：
 * 1. apply 全链路注册（6 工具经真实 defineTool 编译、agent/created 监听、
 *    /skill-refine 命令、status 接口）
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

/** 手工把 base 与 schema 默认值合并（模拟 settings 解析结果）。 */
function resolveConfig(schema, base = {}) {
  const jsonSchema = typeof schema === 'function' ? null : schema
  void jsonSchema
  const merged = {
    enabled: true,
    skillNudgeInterval: 3,
    digestTail: 24,
    digestMaxChars: 30000,
    reviewTimeoutMs: 900000,
    reviewProvider: '',
    reviewModel: '',
    adoptSkills: [],
    notifyMode: 'on',
    ...base
  }
  return merged
}

function makeCtx(config = {}) {
  const effects = []
  const listeners = new Map() // event -> [cb]
  const tools = []
  const commands = []
  const routes = []
  const agentCtxs = []
  let scopeValue = resolveConfig(Config, config)

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
      // dsh 0.1.2-alpha.3：宿主 settings provider 暴露 installSection(owner, ns, schema, entry, hooks)，
      // 语义 = register(base=entry) → setSource(scope.get) → onChange() 同步首发 → scope.watch 持续通知。
      // （installSettingsSection 独立帮助函数已移除，测试 mock 同步升级。）
      installSection(owner, ns, schema, entry, hooks) {
        scopeValue = resolveConfig(schema, entry || config)
        if (hooks && typeof hooks.setSource === 'function') hooks.setSource(() => scopeValue)
        if (hooks && typeof hooks.onChange === 'function') hooks.onChange()
        return { get: () => scopeValue, watch: () => () => {} }
      },
      register(ns, schema, options) {
        scopeValue = resolveConfig(schema, (options && options.base) || config)
        if (options && typeof options.setSource === 'function') {
          options.setSource(() => scopeValue)
        }
        return { get: () => scopeValue, watch: () => () => {} }
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
    __test: { effects, listeners, tools, commands, routes, agentCtxs, setScope: (v) => { scopeValue = v }, getScope: () => scopeValue }
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
  assert.equal(t.tools.length, 6, 'six skill-library tools registered')
  assert.equal(t.listeners.has('agent/created'), true, 'agent/created listener registered')
  assert.equal(t.commands.length, 1, '/skill-refine registered')
  assert.equal(t.commands[0].name, 'skill-refine')
  assert.equal(t.routes.length, 1, 'status route registered')
  assert.equal(t.routes[0].path, '/api/skill-curator/status')
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
  assert.deepEqual(started[0].toolFilter.allow.length >= 6, true, 'whitelist present')
  const promptText = started[0].prompt.map((b) => b.text || '').join('\n')
  assert.ok(promptText.includes('第一轮提问'), 'digest contains user turn')
  assert.ok(promptText.includes('技能策展子代理'), 'instructions appended')

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
  apply(env, { skillNudgeInterval: 2 })
  const t = env.__test
  const agent = makeAgent(env)
  await emitOn(t.listeners, 'agent/created', { agent })

  t.setScope({ ...t.getScope(), enabled: false })
  await emitOn(t.agentCtxs[0].listeners, 'agent/turn-stopping', { turn: 1 })
  await emitOn(t.agentCtxs[0].listeners, 'agent/turn-stopping', { turn: 2 })
  assert.equal(started.length, 0, 'disabled → no review')

  t.setScope({ ...t.getScope(), enabled: true })
  await emitOn(t.agentCtxs[0].listeners, 'agent/turn-stopping', { turn: 3 }) // bump 1
  await emitOn(t.agentCtxs[0].listeners, 'agent/turn-stopping', { turn: 4 }) // bump 2 → fire
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(started.length, 1, 'fires at interval=2 after re-enable')

  // 动态间隔：改为 5 后（计数已清零）连续 4 轮不再触发
  t.setScope({ ...t.getScope(), skillNudgeInterval: 5 })
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
  apply(env, { skillNudgeInterval: 1 })
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
  apply(env, { skillNudgeInterval: 1 })
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
  apply(env, { skillNudgeInterval: 1 })
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
  apply(env, { skillNudgeInterval: 1 })
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
