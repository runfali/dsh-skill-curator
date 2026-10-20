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
import { TOOLS_READY_SERVICE } from '../src/skill-tools.js'
import { createLifecycleStore } from '../src/lifecycle.js'

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
  const provided = []
  // webServer 就绪开关：默认关（真机 apply 期的常见形态），需要时按测试打开。
  let webServerReady = false
  const webServerReadyGetter = () => webServerReady
  // agents 服务就绪开关 + 现存 agent 清单（backfill 的唯一输入）
  let agentsReady = false
  const agentsReadyGetter = () => agentsReady
  let agentsList = []
  // 隔离：apply 时不给 skillsRoot，autoCommit 会落到**真实** ~/.dsh/skills 上提交。
  // 每个测试一个临时技能根（+ 独立备份根），杜绝测试跑到真实技能库。
  const skillsRoot = mkdtempSync(join(tmpdir(), 'sc-apply-skills-'))
  const backupRoot = mkdtempSync(join(tmpdir(), 'sc-apply-backup-'))
  // 隔离：lifecycle store 的默认路径是 <DSH_HOME>/skill-curator/lifecycle.json，
  // 而 DSH_HOME 缺省指向**真实** ~/.dsh（Task 2 踩过：夹具没隔离 DSH_HOME，
  // 真写进了用户目录）。这里给每个测试一个临时 home，applyIn 会把它显式
  // 传给 createLifecycleStore（file + archiveRoot 都落在临时 home 内）。
  const home = mkdtempSync(join(tmpdir(), 'sc-apply-home-'))

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
    // 保真桩（第七路盲区）：真实宿主里 webServer 由 dsh-web-app 组合挂载，
    // 与本插件 apply 的时序**不保证**。默认「未就绪」——只有显式就绪（或测试
    // 传 webServerReady:true）时才回调依赖它的 inject，避免 stub 永远在场导致假绿。
    inject(services, cb) {
      const list = Array.isArray(services) ? services : [services]
      // 只按「服务是否就绪」决定回调：webServer 由 dsh-web-app 组合挂载，
      // 与本插件 apply 时序不保证（默认未就绪，需测试显式打开）。
      const ready = list.every((s) =>
        (s !== 'webServer' || webServerReadyGetter()) &&
        (s !== 'agents' || agentsReadyGetter()))
      if (!ready) return () => {}
      // 注入回调拿到的是**子 ctx**：按请求的服务名挂上对应服务面（真实宿主同形）。
      // 官方范例把路由注册包在 effect 里（dsh-client-connection/lib/index.js:843），
      // 子 ctx 必须提供 effect，否则「注册了但没托管」这类缺陷测不出来。
      const services_ = {}
      for (const s of list) {
        if (s === 'webServer') services_.webServer = { register(route) { routes.push(route); return () => {} } }
        if (s === 'settings') services_.settings = ctx.settings
        // agents：补注册现存 agent 的唯一通路（真机由 dsh-base 的 agent 行提供）
        if (s === 'agents') services_.agents = { list: () => agentsList }
      }
      cb({
        ...services_,
        effect(fn) { const d = fn(); effects.push(typeof d === 'function' ? d : undefined); return d }
      })
      return () => {}
    },
    settings: {
      // dsh 0.1.7：installSection / register 均已从 dsh-settings 移除（全库 0 命中），
      // 只剩 configure(presentation, owner) —— 注册设置页展示策略。
      // 设置值不再经 settings 读回：apply 直接收到 config 对象，volatile 字段是 {get()} 活引用。
      configure(presentation, owner) {
        presentations.push({ presentation, owner })
        return () => {}
      }
    },
    // 一次性 ctx.get：真机 apply 期常常拿不到 webServer（服务未激活）→ 返回 undefined。
    // 这正是本轮踩中的静默空转形态，桩必须如实模拟。
    get(key) {
      if (key === 'commands') return { register(def) { commands.push(def); return () => {} } }
      if (key === 'webServer') {
        return webServerReadyGetter() ? { register(route) { routes.push(route); return () => {} } } : undefined
      }
      return undefined
    },
    tools: { register(def) { tools.push(def) } },
    // ctx.provide：cordis reflect mixin 暴露的官方服务发布 API（cordis/lib/index.js:736-742）。
    // preset 内的 preset-guard 靠它 inject 就绪标记，所以桩必须记下来 ——
    // 不记就等于「发布了但没人看得见」，顺序错误会静默通过。
    provide(name, value) { provided.push({ name, value }); return () => {} },
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
    __setWebServerReady(v) { webServerReady = v },
    __setAgentsReady(v, list) { agentsReady = v; if (Array.isArray(list)) agentsList = list },
    __test: { effects, listeners, tools, commands, routes, agentCtxs, presentations, provided, skillsRoot, backupRoot, home }
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

/**
 * 带隔离技能根的 apply。
 *
 * 为什么必须有：插件收尾的 autoCommit 会真的在 skillsRoot 里跑 git commit。
 * 测试若不给 skillsRoot，就会落到**真实** ~/.dsh/skills 上提交（2026-09-28 实测踩过，
 * 产生了两条垃圾提交）。这里统一兜底，任何测试都不可能再写真实技能库。
 */
function applyIn(env, config = {}) {
  const { __webServerReady, __agentsReady, __agentsList, ...real } = config
  env.__setWebServerReady(__webServerReady === true)
  env.__setAgentsReady(__agentsReady === true, __agentsList)
  // 显式注入测试用 lifecycle store：file 与 archiveRoot 都落在本测试的临时
  // home 内。不走 DSH_HOME 环境变量——apply.test.mjs 是独立进程，但同进程里
  // 其他用例（history-store 等）也读 DSH_HOME，改环境变量会串味；
  // 显式传参是唯一不会误写真实 ~/.dsh/skill-curator 的形态。
  const life = createLifecycleStore({
    file: join(env.__test.home, 'skill-curator', 'lifecycle.json'),
    archiveRoot: join(env.__test.home, 'skill-curator', 'archived')
  })
  env.__test.lifecycle = life
  return apply(env, {
    skillsRoot: env.__test.skillsRoot,
    backupRoot: env.__test.backupRoot,
    __lifecycle: life,
    ...real
  })
}

test('apply registers full chain (tools/listener/command/route)', async () => {
  const env = makeCtx({})
  applyIn(env, { __webServerReady: true })
  const t = env.__test
  assert.equal(t.tools.length, 10, 'ten skill-library tools registered')
  assert.equal(t.listeners.has('agent/created'), true, 'agent/created listener registered')
  assert.equal(t.commands.length, 1, '/skill-refine registered')
  assert.equal(t.commands[0].name, 'skill-refine')
  assert.equal(t.routes.length, 1, 'status route registered')
  assert.equal(t.routes[0].path, '/api/skill-curator/status')
  // 0.1.7：设置页展示策略仍要注册（关掉宿主按 schema 自动生成的默认页）
  assert.equal(t.presentations.length, 1, 'settings.configure called once')
  assert.equal(t.presentations[0].presentation.auto, false, 'auto page disabled')
})

test('apply 必须在注册完 10 个工具**之后**才发布就绪标记（顺序反了 = preset 守卫失效）', async () => {
  // 真机事故（2026-10-18）：preset 内的 preset-guard 用 tools.restrict({allow}) 收敛
  // 子代理工具面，而 restrict 用 view(scope).restrictableNames 校验名字 —— 它只收
  // **继承面**（dsh-tools/lib/index.js:3058-3070）。profile 各行由 EntryGroup.update
  // 的 Promise.all 并发创建，preset 行只 inject tools、本插件还要等 settings →
  // preset 先跑完，那一刻工具还没注册 → restrict 抛 "names unknown global tools"
  // → registry 写死 record.broken（"A mount failure is final"）→ preset 永久 broken。
  // 判据：记录 register / provide 的**调用顺序**，标记必须在最后一个工具之后。
  const env = makeCtx({})
  const order = []
  env.tools.register = (d) => order.push(`register:${d.name}`)
  const origProvide = env.provide
  env.provide = (name, value) => { order.push(`provide:${name}`); return origProvide(name, value) }

  applyIn(env, {})

  const provideAt = order.findIndex((s) => s.startsWith('provide:'))
  assert.ok(provideAt >= 0, '必须发布就绪标记，否则 preset 内的 guard 永远 INACTIVE')
  assert.equal(
    order[provideAt],
    `provide:${TOOLS_READY_SERVICE}`,
    '就绪标记名必须与 preset-guard 的 inject 键一致'
  )
  assert.equal(
    order.filter((s) => s.startsWith('register:')).length,
    10,
    '10 个工具都要在标记之前注册'
  )
  assert.equal(
    provideAt,
    order.length - 1,
    `就绪标记必须是最后一步（实际顺序：${order.join(' → ')}）；` +
      '先发布会让 guard 在工具未就绪时调 restrict 而抛错'
  )
})

test('agents 未就绪不得静默丢补注册；就绪后必须挂上现存 agent（第七路盲区回归）', async () => {
  // 2026-09-28 实测形态：backfill 原用一次性 ctx.get('agents')，服务未就绪时
  // 静默跳过 → 宿主重启后 resume 的第一个会话永远挂不上 turn-stopping →
  // 无论聊多少轮都不触发评审（且零日志）。修法 = ctx.inject(['agents'], cb)。
  // 两态钉死：① 未就绪不挂（也不抛错）；② 就绪必须把现存 agent 挂上。
  // 判据看「有没有挂上 turn-stopping 监听」，不看 agentCtxs 数量
  //（makeAgent 自己就会建一个 scoped ctx，计入数量会误判）。
  const hasTracked = (env) => env.__test.agentCtxs.some((a) => a.listeners.has('agent/turn-stopping'))

  const env = makeCtx({})
  const existingAgent = makeAgent(env)
  applyIn(env, { __agentsReady: false, __agentsList: [existingAgent] })
  assert.equal(hasTracked(env), false, 'agents not ready → nothing backfilled, and no error thrown')

  const env2 = makeCtx({})
  const agent2 = makeAgent(env2)
  applyIn(env2, { __agentsReady: true, __agentsList: [agent2] })
  assert.equal(hasTracked(env2), true, 'agents ready → existing agent gets tracked')
  // 注：不断言「挂的是哪个 agent 对象」——makeAgent 的桩把 ctx 建在空对象上，
  // 那是测试夹具的形状，不是被测行为；真实语义由 installAgentTrack 保证。
})

test('webServer 未就绪时不静默丢路由；就绪后必须注册（第七路盲区回归）', async () => {
  // 2026-09-28 实机故障回归：状态接口原用一次性 ctx.get('webServer')，
  // webServer 由 dsh-web-app 组合挂载、与本插件 apply 时序不保证 →
  // 服务未就绪时**永不注册**且零日志，设置卡「最近评审」永远显示"状态获取失败"。
  // 修法 = ctx.inject(['webServer'], cb) 等待式。本条钉住两态：
  //   ① 未就绪：不得注册（也没有别的手段），但不许抛错；
  //   ② 服务随后就绪：必须补注册。
  const env = makeCtx({})
  applyIn(env, { __webServerReady: false })
  const t = env.__test
  assert.equal(t.routes.length, 0, 'not ready → not registered yet (no silent half-state)')

  // 服务就绪（等价于宿主把 webServer 挂上）→ inject 回调触发 → 路由注册
  const env2 = makeCtx({})
  applyIn(env2, { __webServerReady: true })
  assert.equal(env2.__test.routes.length, 1, 'ready → route registered')
  assert.equal(env2.__test.routes[0].path, '/api/skill-curator/status')
})

test('tools read live (dereferenced) config: excludedSkills works as a protection list', async () => {
  // 回归：excludedSkills 是 volatile 活引用。若工具注册时传 base()（原始 config），
  // Array.isArray({get:…}) === false → 保护名单静默失效（写入保护形同虚设）。
  const dir = mkdtempSync(join(tmpdir(), 'sc-live-'))
  const env = makeCtx({})
  env.get = () => undefined
  let excluded = ['keep-me']
  applyIn(env, { skillsRoot: dir, excludedSkills: { get: () => excluded } })
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
  applyIn(env, {})
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
  assert.equal(started[0].toolFilter.allow.length, 10, 'whitelist lists all ten tools')
  const promptText = started[0].prompt.map((b) => b.text || '').join('\n')
  assert.ok(promptText.includes('第一轮提问'), 'digest contains user turn')
  assert.ok(promptText.includes('技能策展子代理'), 'instructions appended')
  assert.ok(promptText.includes('skill-library-delete'), 'delete tool advertised to the reviewer')
  assert.ok(promptText.includes('skill-library-git'), 'git self-check tool advertised')
  assert.ok(promptText.includes('skill-library-tree'), 'tree tool advertised')

  // 结果落 reviewLog。注意给足时间：收尾 autoCommit 是异步 git 调用，
  // 固定 10ms 会在慢盘上偶发抢跑（轮询到出现为止，2s 上限）。
  const deadline = Date.now() + 2000
  while (reviewLog.recent().length === 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20))
  }
  const recent = reviewLog.recent()
  assert.ok(recent.length >= 1, 'review logged')
  // 收尾自动提交：测试根不是 git 库 → 明确记录原因而不是崩
  assert.equal(recent[0].commit.committed, false, 'non-git skills root → no commit')
  assert.ok(String(recent[0].commit.reason).includes('not a git work tree'), 'reason recorded')
  assert.equal(recent[0].ok, true)
  assert.ok(recent[0].actions[0].includes('demo-flow'), 'summary surfaced')
})

test('subagent-origin and delegated agents never trigger', async () => {
  const env = makeCtx({})
  env.get = () => ({ register() { return () => {} } })
  applyIn(env, {})
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
  applyIn(env, { enabled: { get: () => toggles.enabled }, skillNudgeInterval: { get: () => toggles.skillNudgeInterval } })
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
  applyIn(env, live({ skillNudgeInterval: 1 }))
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
  applyIn(env, live({ skillNudgeInterval: 1 }))
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
  applyIn(env, live({ skillNudgeInterval: 1 }))
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
  applyIn(env, live({ skillNudgeInterval: 1 }))
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
  applyIn(env, {})
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
  applyIn(env, { historyPath: target })
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
  applyIn(env, {})
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
  applyIn(env, {})
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

test('tools/pre-execute 观测 skill 工具调用 → 记 lastUsedAt（子代理不计数）', async () => {
  const env = makeCtx({})
  applyIn(env, {})
  const t = env.__test
  const cbs = t.listeners.get('tools/pre-execute')
  assert.ok(cbs && cbs.length === 1, '必须注册一个 tools/pre-execute 监听')

  // 模拟宿主 waterfall 签名 (exec, next)。用计数器把「next() 真的被调用」变成
  // 可观测断言：只返回 allow 字面量而不调 next，等于跳过后续监听器与内建处理
  // （实际把工具拦掉），但返回值形状完全看不出来。
  let nextCalls = 0
  const next = async () => { nextCalls += 1; return { kind: 'allow' } }
  await cbs[0]({ name: 'skill', arguments: { name: 'alpha-skill' }, agent: { session: { header: {} } } }, next)
  const life = env.__test.lifecycle
  assert.ok(life, 'apply 必须暴露 lifecycle store 供状态接口复用')
  assert.ok(life.snapshot().skills['alpha-skill'].lastUsedAt > 0, 'skill 调用必须记 lastUsedAt')

  // 其他工具不动状态。**必须用一个自己也吃 `name` 参数的兄弟工具**：
  // skill-library-* 全都收 name，若只判 `typeof arguments.name === 'string'`
  // 而不判 `exec.name === 'skill'`，读一个技能就会把它记成「被使用」。
  await cbs[0]({ name: 'skill-library-read', arguments: { name: 'not-used-skill' }, agent: { session: { header: {} } } }, next)
  assert.equal(life.snapshot().skills['not-used-skill'], undefined, '非 skill 工具不记（哪怕它也有 name 参数）')
  await cbs[0]({ name: 'bash', arguments: { command: 'ls' }, agent: { session: { header: {} } } }, next)
  assert.equal(life.snapshot().skills['bash'], undefined, '非 skill 工具不记')

  // 子代理调用不计数（评审子代理读技能不是「使用」）
  await cbs[0]({ name: 'skill', arguments: { name: 'beta-skill' }, agent: { session: { header: { origin: 'subagent' } } } }, next)
  assert.equal(life.snapshot().skills['beta-skill'], undefined, '子代理不计数')

  // 委派深度 > 0 同样不计数（origin 缺失时靠深度兜底）
  await cbs[0]({ name: 'skill', arguments: { name: 'gamma-skill' }, agent: { session: { header: { delegationDepth: 1 } } } }, next)
  assert.equal(life.snapshot().skills['gamma-skill'], undefined, '委派深度 > 0 不计数')

  // 必须放行（waterfall 语义：**必须真的调用 next()**，只返回 allow 字面量不算 ——
  // 不调 next 等于跳过后续监听器与内建处理，实际把工具拦掉，而返回值形状看不出来）
  const beforePass = nextCalls
  const decision = await cbs[0]({ name: 'skill', arguments: { name: 'alpha-skill' }, agent: { session: { header: {} } } }, next)
  assert.equal(nextCalls, beforePass + 1, 'pre-execute 必须调用 next()（不调 = 跳过后续监听器与内建处理，等于拦掉工具）')
  assert.deepEqual(decision, { kind: 'allow' }, 'pre-execute 必须放行，不能拦工具')

  // 观测自身抛错也只 warn：绝不把工具拦掉、绝不炸主线
  let boomCalls = 0
  const boom = async () => { boomCalls += 1; return { kind: 'allow' } }
  const original = life.markUsed
  life.markUsed = () => { throw new Error('boom') }
  const afterThrow = await cbs[0]({ name: 'skill', arguments: { name: 'delta-skill' }, agent: { session: { header: {} } } }, boom)
  assert.equal(boomCalls, 1, '观测异常后仍必须调用 next()（不调 = 把工具拦掉）')
  assert.deepEqual(afterThrow, { kind: 'allow' }, '观测异常后仍必须放行')
  life.markUsed = original
})
