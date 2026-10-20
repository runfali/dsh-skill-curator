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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
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
  // 运行时技能注册记录（skills.register 的入参）
  const runtimeSkills = []
  // ctx.logger.warn 留痕（I4 守护用）
  const warns = []
  // skills.register 返回的 disposer（断言它真的被 effect 托管）
  const skillDisposers = []
  // webServer 就绪开关：默认关（真机 apply 期的常见形态），需要时按测试打开。
  let webServerReady = false
  const webServerReadyGetter = () => webServerReady
  // agents 服务就绪开关 + 现存 agent 清单（backfill 的唯一输入）
  let agentsReady = false
  const agentsReadyGetter = () => agentsReady
  let agentsList = []
  // skills 服务就绪开关：由 dsh-base 的 dsh-skill 行提供，与本插件 apply 时序不保证。
  // 默认**关**——不关的话 ctx.inject(['skills'], cb) 永远回调，运行时技能
  // 漏注册会被夹具掩盖成假绿。两种开关方式：makeCtx({__skillsReady:true})（简报用法）
  // 或 applyIn(env, {__skillsReady:true})（与 webServer/agents 同形）。
  let skillsReady = config.__skillsReady === true
  const skillsReadyGetter = () => skillsReady
  // commands 服务就绪开关：由 dsh-base 的 dsh-commands 行提供，与本插件 apply
  // 时序不保证。历史上本插件用一次性 ctx.get('commands') → 服务未就绪即**静默**
  // 不注册 /skill-refine（零日志）。官方命令插件（dsh-command-goal:10、
  // dsh-command-compact:9、dsh-command-feedback:66）一律把 commands 放进 inject
  // 等待就绪。默认**关**，逼出等待式形态。
  let commandsReady = config.__commandsReady === true
  const commandsReadyGetter = () => commandsReady
  // 故障注入（I4 守护）：register 抛错 / register 根本不存在。
  // 前者钉住 try/catch（删掉它 apply 会炸主线）；后者钉住 `typeof register !== 'function'`
  // 守卫（删掉它会走 register(...) → TypeError，落到 catch 里报另一种错，必须靠文案区分）。
  const skillsRegisterThrows = config.__skillsRegisterThrows === true
  const skillsRegisterMissing = config.__skillsRegisterMissing === true
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
    // warn 必须**留痕**：I4 的守护判据就是「register 抛错时不炸、但要 warn」。
    // 原桩是空函数，`ctx.logger.warn` 被调用与否完全不可观测。
    logger: {
      debug() {}, info() {}, error() {},
      warn(...a) { warns.push(a.map((x) => String(x)).join(' ')) }
    },
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
        (s !== 'skills' || skillsReadyGetter()) &&
        (s !== 'commands' || commandsReadyGetter()) &&
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
        // commands：官方命令插件（dsh-command-goal:10 / -compact:9 / -feedback:66）
        // 都把 commands 声明在 inject 里等待就绪；本插件历史上用一次性 ctx.get，
        // 服务未就绪即静默不注册（零日志）。这里必须走 inject 子 ctx 拿服务，
        // 才能测出「等待式注册」这一形态。
        if (s === 'commands') services_.commands = { register(def) { commands.push(def); return () => {} } }
        // skills：dsh-skill 的 register(def) → disposer。只登记，不碰真实 DSH_HOME。
        // 返回**唯一哨兵** disposer：只有把它交给 effect 才测得出「卸载时收口」
        // （若实现直接调 register 而不包 effect，注册照样成功、断言照样绿）。
        if (s === 'skills') services_.skills = skillsRegisterMissing
          ? {} // 服务在、但 register 不是函数（宿主换版/半初始化形态）
          : {
              register(def) {
                if (skillsRegisterThrows) throw new Error('injected register failure')
                runtimeSkills.push(def)
                const d = () => {}
                skillDisposers.push(d)
                return d
              }
            }
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
    // ⚠️ commands **不再**从这里给：它必须走 inject 等待式（官方三插件同形）。
    // 若在这里返回桩对象，实现退回 ctx.get('commands') 也会绿 —— 那是假绿。
    get(key) {
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
    __setSkillsReady(v) { skillsReady = v },
    __setCommandsReady(v) { commandsReady = v },
    __test: { effects, listeners, tools, commands, routes, agentCtxs, presentations, provided, runtimeSkills, skillDisposers, warns, skillsRoot, backupRoot, home }
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

/** 评审子代理桩：立即返回「无需保存」，让评审收尾（含生命周期迁移）跑完。 */
function reviewMock(env) {
  env.get = (key) => {
    if (key === 'subagents') {
      return {
        getProvider() { return undefined },
        list: () => ['spawn'],
        async start() {
          return {
            result: Promise.resolve({ output: [{ type: 'text', text: '无需保存。' }], stopReason: 'completed' }),
            dispose: async () => {}
          }
        }
      }
    }
    return undefined
  }
}

/**
 * 触发一次完整评审并等它落进 reviewLog。
 * @returns {Promise<{agent: object, record: object|undefined}>}
 */
async function fireReview(env) {
  const t = env.__test
  const agent = makeAgent(env)
  await emitOn(t.listeners, 'agent/created', { agent })
  const cbs = t.agentCtxs.at(-1).listeners.get('agent/turn-stopping') || []
  // 默认 skillNudgeInterval=3 → 连跑 3 轮才触发一次评审
  for (let i = 0; i < 3; i++) for (const cb of cbs) await cb({ turn: i + 1 })
  // reviewLog 是 export let：经 mod 读 live binding，并按 sessionId 定位本用例记录
  // （同进程单例，跨用例共享）。
  const mine = () => mod.reviewLog.recent().find((r) => r.sessionId === agent.session.id)
  const deadline = Date.now() + 3000
  while (!mine() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20))
  return { agent, record: mine() }
}

/**
 * 带隔离技能根的 apply。
 *
 * 为什么必须有：插件收尾的 autoCommit 会真的在 skillsRoot 里跑 git commit。
 * 测试若不给 skillsRoot，就会落到**真实** ~/.dsh/skills 上提交（2026-09-28 实测踩过，
 * 产生了两条垃圾提交）。这里统一兜底，任何测试都不可能再写真实技能库。
 */
function applyIn(env, config = {}) {
  const { __webServerReady, __agentsReady, __agentsList, __skillsReady, __commandsReady, ...real } = config
  env.__setWebServerReady(__webServerReady === true)
  env.__setAgentsReady(__agentsReady === true, __agentsList)
  if (__skillsReady !== undefined) env.__setSkillsReady(__skillsReady === true)
  if (__commandsReady !== undefined) env.__setCommandsReady(__commandsReady === true)
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
  applyIn(env, { __webServerReady: true, __commandsReady: true })
  const t = env.__test
  assert.equal(t.tools.length, 11, 'eleven skill-library tools registered')
  assert.equal(t.listeners.has('agent/created'), true, 'agent/created listener registered')
  assert.equal(t.commands.length, 1, '/skill-refine registered')
  assert.equal(t.commands[0].name, 'skill-refine')
  assert.equal(t.routes.length, 1, 'status route registered')
  assert.equal(t.routes[0].path, '/api/skill-curator/status')
  // 0.1.7：设置页展示策略仍要注册（关掉宿主按 schema 自动生成的默认页）
  assert.equal(t.presentations.length, 1, 'settings.configure called once')
  assert.equal(t.presentations[0].presentation.auto, false, 'auto page disabled')
})

// ---------------------------------------------------------------------------
// commands 必须走 inject 等待式（官方三插件同形），不能一次性 ctx.get
// ---------------------------------------------------------------------------
// 真机形态：commands 由 dsh-base 的 dsh-commands 行提供，与本插件 apply 时序
// **不保证**。历史上用 `const commands = ctx.get('commands'); if (commands !== undefined)`
// → 服务未就绪时**静默不注册** /skill-refine，零日志、零报错（与本仓修过的
// webServer / agents / skills 三条「第七路盲区」同源）。
// 官方命令插件一律把 commands 放进 inject：dsh-command-goal:10、
// dsh-command-compact:9、dsh-command-feedback:66。
test('commands 未就绪时不注册 /skill-refine（不得静默假装注册）', async () => {
  const env = makeCtx({})
  applyIn(env, { __webServerReady: true }) // commandsReady 默认 false
  assert.equal(env.__test.commands.length, 0, '未就绪 → 不注册（由 inject 等待，而非 ctx.get 空转）')
})

test('commands 就绪后才注册 /skill-refine（等待式注入生效）', async () => {
  const env = makeCtx({})
  applyIn(env, { __webServerReady: true })
  assert.equal(env.__test.commands.length, 0, '先确认未就绪时不注册')
  env.__setCommandsReady(true)
  // 真实 cordis：服务就绪会唤醒等待中的 inject fiber 重跑回调。
  // 夹具按同形语义重放一次 apply（幂等：installAgentTrack / 工具注册均可重入）。
  applyIn(env, { __webServerReady: true, __commandsReady: true })
  assert.equal(env.__test.commands.length, 1, '就绪后注册')
  assert.equal(env.__test.commands[0].name, 'skill-refine')
})

test('apply 必须在注册完 11 个工具**之后**才发布就绪标记（顺序反了 = preset 守卫失效）', async () => {
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
    11,
    '11 个工具都要在标记之前注册'
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
  assert.equal(started[0].toolFilter.allow.length, 11, 'whitelist lists all eleven tools')
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
    // commands 不再经 ctx.get 提供（必须走 inject 等待式，见本文件开头两条
    // commands 用例）。这里只桩 subagents。
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
  applyIn(env, { __commandsReady: true })
  const cmd = env.__test.commands[0]
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
  //
  // 返回值透传（Task 3 复审转来的要求）：next 返回一个**唯一哨兵对象**，断言用
  // 同一引用比较。若实现改成 `await next(); return { kind: 'allow' }`，字面量 allow
  // 会覆盖掉后续监听器的 deny（安全相关窄口子），而 deepEqual({kind:'allow'}) 会
  // **存活**——引用比较才钉得住「原样透传」。
  let nextCalls = 0
  const sentinel = { kind: 'allow', __sentinel: 'pre-execute-passthrough' }
  const next = async () => { nextCalls += 1; return sentinel }
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
  assert.equal(decision, sentinel, 'pre-execute 必须**原样透传** next() 的返回值（自己造 allow 字面量会覆盖后续监听器的 deny）')

  // 观测自身抛错也只 warn：绝不把工具拦掉、绝不炸主线
  let boomCalls = 0
  const boomSentinel = { kind: 'allow', __sentinel: 'boom-passthrough' }
  const boom = async () => { boomCalls += 1; return boomSentinel }
  const original = life.markUsed
  life.markUsed = () => { throw new Error('boom') }
  const afterThrow = await cbs[0]({ name: 'skill', arguments: { name: 'delta-skill' }, agent: { session: { header: {} } } }, boom)
  assert.equal(boomCalls, 1, '观测异常后仍必须调用 next()（不调 = 把工具拦掉）')
  assert.equal(afterThrow, boomSentinel, '观测异常后仍必须原样透传 next() 的返回值')
  life.markUsed = original
})

test('新增 skill-library-lifecycle 工具：archive/restore/pin/list 四动作', async () => {
  const env = makeCtx({})
  applyIn(env, {})
  const def = env.__test.tools.find((d) => d.name === 'skill-library-lifecycle')
  assert.ok(def, 'skill-library-lifecycle 必须注册')
  // defineTool 编译后是标准 JSON Schema：枚举在 parameters.properties.<key>.enum
  // （实测 probe-enum.mjs；parameters.<key>.enum 恒为 undefined）。
  assert.deepEqual(def.parameters.properties.action.enum, ['list', 'archive', 'restore', 'pin'])
  const listed = await def.execute({ action: 'list' })
  assert.equal(listed.ok, true)
  assert.ok(listed.data.lifecycle, 'list 返回生命周期摘要')
})

test('skill-library-lifecycle 的 archive/restore/pin 真的动盘且可回滚', async () => {
  const env = makeCtx({})
  applyIn(env, {})
  const t = env.__test
  const life = t.tools.find((d) => d.name === 'skill-library-lifecycle')
  const create = t.tools.find((d) => d.name === 'skill-library-create')
  const sig = { signal: new AbortController().signal }
  await create.execute({ name: 'temp-skill', description: 'd', content: '# x' }, sig)

  // archive：技能目录移出技能库 → 归档根（可恢复，不是删除）
  const archived = await life.execute({ action: 'archive', name: 'temp-skill' }, sig)
  assert.equal(archived.ok, true, `archive 应成功：${archived.error || ''}`)
  assert.ok(readdirSync(t.skillsRoot).includes('temp-skill') === false, '技能已移出技能库')
  assert.ok(readdirSync(archived.data.archiveRoot).includes('temp-skill'), '技能落在归档根')

  // 重复归档失败（归档里已有同名）→ 明确报错，不覆盖旧归档
  const dup = await life.execute({ action: 'archive', name: 'temp-skill' }, sig)
  assert.equal(dup.ok, false, '重名归档被拒（覆盖 = 恢复承诺失效）')

  // restore：回到技能库
  const restored = await life.execute({ action: 'restore', name: 'temp-skill' }, sig)
  assert.equal(restored.ok, true, `restore 应成功：${restored.error || ''}`)
  assert.ok(readdirSync(t.skillsRoot).includes('temp-skill'), '技能回到技能库')

  // pin / unpin：pinned 字段随参数变化
  const pinned = await life.execute({ action: 'pin', name: 'temp-skill', pinned: true }, sig)
  assert.equal(pinned.data.pinned, true)
  assert.ok((await life.execute({ action: 'list' }, sig)).data.lifecycle.pinned.includes('temp-skill'))
  const unpinned = await life.execute({ action: 'pin', name: 'temp-skill', pinned: false }, sig)
  assert.equal(unpinned.data.pinned, false)

  // 保护名单成员禁止归档（归档会把它移出库，等于绕过保护）
  const env2 = makeCtx({})
  applyIn(env2, { excludedSkills: ['keep-me'] })
  const life2 = env2.__test.tools.find((d) => d.name === 'skill-library-lifecycle')
  const guarded = await life2.execute({ action: 'archive', name: 'keep-me' }, sig)
  assert.equal(guarded.ok, false)
  assert.ok(guarded.error.includes('excludedSkills'))

  // 非法名 / 未知动作：响亮失败
  // 未知 action 在**参数层**就被 SDK 拒（枚举校验，早于我们的 execute）→ assert.rejects。
  assert.equal((await life.execute({ action: 'archive', name: 'Bad Name' }, sig)).ok, false)
  assert.ok((await life.execute({ action: 'archive', name: 'Bad Name' }, sig)).error.includes('invalid skill name'))
  await assert.rejects(
    async () => life.execute({ action: 'nope' }, sig),
    /must be one of/,
    '未知 action 必须在参数层被拒（枚举是白名单，不是提示）'
  )
})

test('status 接口回显生命周期摘要', async () => {
  const env = makeCtx({})
  applyIn(env, { __webServerReady: true })
  const route = env.__test.routes.find((r) => r.path === '/api/skill-curator/status')
  const body = await new Promise((resolve) => {
    const res = { writeHead() {}, end(payload) { resolve(JSON.parse(payload)) } }
    route.handler({ method: 'GET', headers: { host: '127.0.0.1:7009' } }, res)
  })
  assert.ok(body.lifecycle, 'status 必须带 lifecycle')
  assert.equal(typeof body.lifecycle.stale.length, 'number')
})

// transitions() 对非有限 staleDays/archiveDays 会抛错（Task 2 的响亮失败设计），
// 而它现在挂在评审收尾的同步路径上：不包 try/catch 会让「设置项被写坏」直接炸掉
// 整个评审（reviewLog 里连一条失败记录都不留）。这条钉住「跳过本轮、评审照常记录」。
test('坏掉的 staleDays 不炸评审：transitions 抛错只跳过本轮生命周期迁移', async () => {
  const env = makeCtx({})
  env.get = (key) => {
    if (key === 'subagents') {
      return {
        getProvider() { return undefined },
        list: () => ['spawn'],
        async start(p, request) {
          return { result: Promise.resolve({ output: [{ type: 'text', text: '无需保存。' }], stopReason: 'completed' }), dispose: async () => {} }
        }
      }
    }
    return undefined
  }
  const warnings = []
  env.logger.warn = (...a) => warnings.push(a.join(' '))
  applyIn(env, { staleDays: { get: () => Number.NaN } })
  const t = env.__test
  const agent = makeAgent(env)
  await emitOn(t.listeners, 'agent/created', { agent })
  const cbs = t.agentCtxs[0].listeners.get('agent/turn-stopping')
  for (let i = 0; i < 3; i++) for (const cb of cbs) await cb({ turn: i + 1 })
  // reviewLog 是 export let：前面的 historyPath 覆盖用例会重建 store，
  // 本文件顶部的 `const reviewLog = mod.reviewLog` 是旧引用 → 必须经 mod 读 live binding。
  const deadline = Date.now() + 2000
  const mine = () => mod.reviewLog.recent().find((r) => r.sessionId === agent.session.id)
  while (!mine() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20))
  }
  const record = mine()
  assert.ok(record, '评审照常落记录（生命周期迁移失败不阻断）')
  assert.equal(record.ok, true, '评审本身仍然成功')
  assert.equal(record.lifecycle, undefined, '迁移失败时不写 lifecycle 字段（不写半截数据）')
  assert.ok(warnings.some((w) => w.includes('lifecycle pass failed')), '失败原因进 warn 日志')
})

// summary() 的形状守护（Task 2 评审指出的零覆盖缺口：Task 4 是它的第一个消费者，
// 必须在依赖它之前钉住分桶与 pinned 字段，否则 Task 2 的 `out[rec.state] || out.active`
// 把未知 state 静默归入 active 这类缺陷会一路带到面板上）。
test('lifecycle.summary() 的分桶与 pinned 字段形状', () => {
  const env = makeCtx({})
  applyIn(env, {})
  const life = env.__test.lifecycle
  const now = Date.now()
  life.markUsed('used-skill', { now })
  life.markUsed('pinned-skill', { now })
  life.setPinned('pinned-skill', true)
  const s = life.summary()
  for (const bucket of ['active', 'stale', 'archived', 'neverUsed', 'pinned']) {
    assert.ok(Array.isArray(s[bucket]), `summary().${bucket} 必须是数组`)
  }
  assert.ok(s.active.includes('used-skill'), '刚用过的技能在 active')
  assert.ok(s.pinned.includes('pinned-skill'), 'pinned 列表含被钉住的技能')
  assert.deepEqual(s.active, [...s.active].sort(), 'active 必须有序（面板输出稳定）')
})

test('apply 注册运行时技能（skills.register）', async () => {
  const env = makeCtx({ __skillsReady: true })
  applyIn(env, {})
  const regs = env.__test.runtimeSkills
  assert.equal(regs.length, 1, '注册一个运行时技能')
  assert.equal(regs[0].name, 'skill-curator')
  assert.equal(typeof regs[0].description, 'string')
  assert.ok(regs[0].content.length > 0)
  // 注册必须包在 effect 里（官方范例 dsh-client-connection:843）：disposer 由 fiber
  // 收口，热重载/卸载才不残留旧技能。裸调 register 时上面几条断言**照样全绿**。
  assert.ok(
    env.__test.effects.includes(env.__test.skillDisposers[0]),
    'skills.register 的 disposer 必须交给 effect 托管'
  )
})

test('skills 未就绪不得静默丢运行时技能；就绪后必须注册（第七路盲区回归）', async () => {
  // skills 由 dsh-base 的 dsh-skill 行提供，与本插件 apply 时序不保证。
  // 一次性 ctx.get('skills') 在服务未就绪时拿到 undefined → 静默不注册、零日志。
  // 两态钉死：① 未就绪不注册（也不抛错）；② 服务随后就绪必须补注册。
  const notReady = makeCtx({})
  applyIn(notReady, {})
  assert.equal(notReady.__test.runtimeSkills.length, 0, '未就绪 → 不注册')

  const ready = makeCtx({})
  applyIn(ready, { __skillsReady: true })
  assert.equal(ready.__test.runtimeSkills.length, 1, '就绪 → 注册')
})

// I4 守护：这条全局约束（「skills.register 抛错/缺失时只 warn，绝不抛」）此前
// **无任何测试**——删掉 `typeof register !== 'function'` 守卫或删掉 try/catch，
// 全套测试照样绿。两条用例分别钉死两个分支，且判据落在 warn 文案上，
// 让「守卫被删 → 落到 catch → 报另一种文案」这种退化也能被抓到。
test('skills.register 抛错时 apply 不抛，只 warn（try/catch 守护）', async () => {
  const env = makeCtx({ __skillsReady: true, __skillsRegisterThrows: true })
  assert.doesNotThrow(() => applyIn(env, {}), 'register 抛错绝不能炸掉 apply 主线')
  assert.equal(env.__test.runtimeSkills.length, 0, '抛错时没有注册记录')
  assert.ok(
    env.__test.warns.some((w) => w.includes('runtime skill registration failed')),
    `必须留下 warn（实际：${JSON.stringify(env.__test.warns)}）`
  )
})

test('skills.register 不是函数时只 warn 不抛（typeof 守卫守护，且与 catch 分支可区分）', async () => {
  const env = makeCtx({ __skillsReady: true, __skillsRegisterMissing: true })
  assert.doesNotThrow(() => applyIn(env, {}), 'register 缺失绝不能炸掉 apply 主线')
  assert.equal(env.__test.runtimeSkills.length, 0, '缺失时没有注册记录')
  assert.ok(
    env.__test.warns.some((w) => w.includes('skills.register unavailable')),
    `必须命中守卫分支的专用文案（实际：${JSON.stringify(env.__test.warns)}）`
  )
})

// ---------------------------------------------------------------------------
// 接线层（Task 4 fix round 1）：评审收尾把**用户配置**送进 transitions()，
// 并把结果回显到 reviewLog / status / list。
//
// 为什么补这一组：apply.test.mjs 原来只测「崩溃路径」（坏 staleDays 只跳过本轮），
// 从没有一条断言「配置真的传进去了」。于是 4 个变异全部存活：
//   I-1 `lifecycleCounts || undefined` → `undefined`（记录里静默丢掉结果）
//   I-2 整行删掉 `archiveEnabled: settings.spec().archiveEnabled`（status 不回显）
//   I-3 `staleDays` / `archiveDays` 对调（配置被送错）
//   I-4 删 syncWith / archiveEnabled 强制 true / list 去掉 archiveRoot
// 判据必须落在**真实传参值**上：只断言「字段存在」的话，I-3（对调）照样存活。
// ---------------------------------------------------------------------------

test('评审收尾把 config 的 staleDays/archiveDays/archiveEnabled 原样送进 transitions()', async () => {
  const env = makeCtx({})
  reviewMock(env)
  // 三个值刻意互不相同且顺序敏感：对调 staleDays/archiveDays 会被下面两条断言抓到。
  applyIn(env, {
    staleDays: { get: () => 11 },
    archiveDays: { get: () => 77 },
    archiveEnabled: { get: () => true }
  })
  const life = env.__test.lifecycle
  // 磁盘上放一个技能（**不** markUsed）：transitions() 只能通过 syncWith() 看到它。
  // 没有这条，删掉 syncWith 也照样绿（checked 恒 0）——I-4a 就是这么存活的。
  mkdirSync(join(env.__test.skillsRoot, 'seeded-skill'), { recursive: true })
  writeFileSync(
    join(env.__test.skillsRoot, 'seeded-skill', 'SKILL.md'),
    '---\nname: seeded-skill\ndescription: d\n---\n\n# x\n'
  )

  // 包装 transitions 记录入参（保留原实现调用——只观测，不改语义）
  const seen = []
  const original = life.transitions
  life.transitions = (opts) => { seen.push(opts); return original.call(life, opts) }

  const { record } = await fireReview(env)

  assert.equal(seen.length, 1, '评审收尾必须调用一次 transitions()')
  const opts = seen[0]
  assert.equal(opts.staleDays, 11, 'staleDays 必须等于配置值（对调会变 77）')
  assert.equal(opts.archiveDays, 77, 'archiveDays 必须等于配置值（对调会变 11）')
  assert.equal(opts.archiveEnabled, true, 'archiveEnabled 必须来自配置，不能被写死/丢掉')
  assert.equal(typeof opts.archiveFn, 'function', 'archiveFn 必须传下去（否则开了开关也不会归档）')

  // I-1 正向路径：结果必须真的落进 reviewLog（`|| undefined` 变异会让它消失）
  assert.ok(record, '评审必须落记录')
  assert.ok(record.lifecycle, '记录里必须带 lifecycle 计数（不是 undefined）')
  assert.equal(record.lifecycle.checked, 1, 'syncWith 必须把磁盘上的技能纳入本轮判定')
})

test('archiveEnabled=false 时评审收尾只判定不归档（配置值真的被遵守）', async () => {
  // I-4b 存活体：把 `archiveEnabled: s.archiveEnabled` 改成写死 `true`，
  // 上一组断言照样全绿——因为那里配置本来就是 true。必须有一条 **false** 用例
  // 钉住「默认关 = 只报告不动磁盘」这条红线。
  const env = makeCtx({})
  reviewMock(env)
  applyIn(env, {
    archiveEnabled: { get: () => false },
    archiveDays: { get: () => 1 },
    staleDays: { get: () => 1 }
  })
  const t = env.__test
  mkdirSync(join(t.skillsRoot, 'aged-skill'), { recursive: true })
  writeFileSync(join(t.skillsRoot, 'aged-skill', 'SKILL.md'), '---\nname: aged-skill\ndescription: d\n---\n\n# x\n')
  t.lifecycle.markUsed('aged-skill', { now: Date.now() - 100 * 86400000 })

  const { record } = await fireReview(env)

  assert.equal(record.lifecycle.wouldArchive, 1, '够格归档的技能必须被判定出来（判定与执行分离）')
  assert.equal(record.lifecycle.archived, 0, 'archiveEnabled=false → 一个都不许动盘')
  assert.ok(readdirSync(t.skillsRoot).includes('aged-skill'), '技能必须还在技能库里')
  assert.equal(
    existsSync(t.lifecycle.archiveRoot) ? readdirSync(t.lifecycle.archiveRoot).length : 0,
    0,
    '归档目录必须为空'
  )
})

test('status 接口回显 config 里的 archiveEnabled 与 lifecycle 摘要', async () => {
  const env = makeCtx({})
  applyIn(env, { __webServerReady: true, archiveEnabled: { get: () => true } })
  const route = env.__test.routes.find((r) => r.path === '/api/skill-curator/status')
  const body = await new Promise((resolve) => {
    const res = { writeHead() {}, end(payload) { resolve(JSON.parse(payload)) } }
    route.handler({ method: 'GET', headers: { host: '127.0.0.1:7009' } }, res)
  })
  // 默认（未配置）必须是 false —— 自动归档默认关是红线
  assert.equal(body.archiveEnabled, true, 'status 的 archiveEnabled 必须回显配置值')

  const off = makeCtx({})
  applyIn(off, { __webServerReady: true })
  const offRoute = off.__test.routes.find((r) => r.path === '/api/skill-curator/status')
  const offBody = await new Promise((resolve) => {
    const res = { writeHead() {}, end(payload) { resolve(JSON.parse(payload)) } }
    offRoute.handler({ method: 'GET', headers: { host: '127.0.0.1:7009' } }, res)
  })
  assert.equal(offBody.archiveEnabled, false, '未配置 → 默认 false（不能写死 true）')
  assert.ok(offBody.lifecycle, 'status 必须带 lifecycle')
})

test('skill-library-lifecycle 的 list 回显 archiveRoot', async () => {
  const env = makeCtx({})
  applyIn(env, {})
  const def = env.__test.tools.find((d) => d.name === 'skill-library-lifecycle')
  const listed = await def.execute({ action: 'list' })
  assert.equal(listed.ok, true)
  assert.equal(
    listed.data.archiveRoot,
    env.__test.lifecycle.archiveRoot,
    'list 必须回显归档根（用户要知道归档去了哪）'
  )
  assert.ok(String(listed.data.archiveRoot).length > 0)
})

test('excludedSkills 保护名单同样拦截**自动**归档（工具层之外的第二道闸）', async () => {
  // 真缺陷（2026-10-20 评审）：工具层 skill-library-lifecycle 有保护名单守卫，
  // 但评审收尾的自动归档没有 —— listSkills() 只把 excluded 用于填 protected 标记，
  // 不过滤，随后 archiveFn 直接移目录。archiveEnabled 默认 false 掩盖了它。
  const env = makeCtx({})
  reviewMock(env)
  applyIn(env, {
    archiveEnabled: { get: () => true },
    archiveDays: { get: () => 1 },
    staleDays: { get: () => 1 },
    excludedSkills: ['keep-me']
  })
  const t = env.__test
  const archivedNames = () => (existsSync(t.lifecycle.archiveRoot) ? readdirSync(t.lifecycle.archiveRoot) : [])
  // 两个技能都「超期」：lastUsedAt 设成 100 天前（archiveDays=1）
  const old = Date.now() - 100 * 86400000
  for (const n of ['keep-me', 'free-me']) {
    mkdirSync(join(t.skillsRoot, n), { recursive: true })
    writeFileSync(join(t.skillsRoot, n, 'SKILL.md'), `---\nname: ${n}\ndescription: d\n---\n\n# ${n}\n`)
  }
  t.lifecycle.markUsed('keep-me', { now: old })
  t.lifecycle.markUsed('free-me', { now: old })

  const { record } = await fireReview(env)

  // 保护名单成员：磁盘上必须还在（工具层同源守卫）
  assert.ok(
    readdirSync(t.skillsRoot).includes('keep-me'),
    'excludedSkills 成员不得被自动归档（磁盘文件必须还在）'
  )
  assert.equal(
    archivedNames().includes('keep-me'),
    false,
    '保护名单成员绝不能出现在归档目录'
  )
  // 保护名单成员必须仍在**状态表**里。这是最易走偏的修法：把 `names` 过一道
  // `.filter((k) => !excluded.includes(k.name))`（"既然保护名单，就别让它进 syncWith"）
  // 会让 syncWith 把该记录当"已消失"删掉 → 下一轮以 neverUsed 重新 seed →
  // lastUsedAt 归零 → 永久不 stale。磁盘断言看不出这一点（文件确实还在）。
  const snap = t.lifecycle.snapshot().skills
  assert.ok(
    snap['keep-me'],
    '保护名单成员必须仍在状态表里（被 syncWith 删掉 → 重新 seed → lastUsedAt 归零 → 永久不 stale）'
  )
  assert.equal(snap['keep-me'].lastUsedAt, old, '且 lastUsedAt 不得被重置（归零 = 永久不 stale）')
  assert.equal(record.lifecycle.checked, 2, '两个技能都必须纳入本轮判定（保护名单不是"别看见它"）')
  // 非保护成员：对照——开关真的开了、路径真的通（否则上面的断言可能是「整个归档没跑」的假绿）
  assert.ok(
    archivedNames().includes('free-me'),
    '非保护成员应被归档（证明归档路径确实生效，保护名单断言不是假绿）'
  )
  assert.equal(record.lifecycle.archived, 1, '只归档了 1 个（受保护那个被拦下）')
})

