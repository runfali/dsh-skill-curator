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
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply, name, reviewLog } from '../src/index.js'
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
      register(ns, schema, options) {
        scopeValue = resolveConfig(schema, (options && options.base) || config)
        // 模拟宿主行为：把解析后的设置读取器交给插件（createSettings 的 setSource）
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

function makeAgent(ctx, { origin, delegationDepth } = {}) {
  const session = {
    id: 'sess-' + Math.random().toString(36).slice(2, 8),
    header: { ...(origin !== undefined ? { origin } : {}), ...(delegationDepth !== undefined ? { delegationDepth } : {}) },
    events: [
      { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '第一轮提问' }] } },
      { type: 'assistant/message', data: { message: { source: { kind: 'model' }, content: [{ type: 'text', text: '第一轮回答' }] } } }
    ]
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
