/**
 * dsh-skill-curator — 自动技能策展 bundle 插件（Host 半）。
 *
 * 把 hermes 的「后台评审自动提炼 skill」闭环移植到 DSH（零侵入，不改 dsh 源码）：
 *
 *   1. 触发：agent/created 闭包注册 agent 级 turn-stopping（serial）监听，
 *      每 N 轮真实对话（默认 3）计数达标后异步调度一次评审（fire-and-forget，
 *      绝不阻塞 turn 关闭；子代理 session 不计数、不递归）。
 *   2. 评审：起一个 spawn 子代理，注入「会话摘要 + 评审指令」；toolFilter
 *      allow 白名单把它限制为只能调用 skill-library-* 工具（hermes 运行时
 *      白名单的工具级等价物）；结果经日志/状态面板回显，不污染父会话。
 *   3. 写盘：~/.dsh/skills/<name>/SKILL.md（中文正文 + 双语描述）。评审可对库内
 *      任意 skill 增删改（excludedSkills 保护名单除外）：动笔前必须 skill-library-read
 *      取 sha256 并在写入时回传（硬约束「先读后改」），每次写入前自动备份。
 *   4. 手动：/skill-refine [focus] 命令立即对当前会话发起评审。
 *
 * 已知平台约束（docs/COMPARISON.md）：
 *   - 触发计数用 agent/created 闭包注册 agent.ctx 子监听（scoped 监听天然多会话隔离）；
 *     turn-stopping 载荷经 agentEvents 的 fused() 注入 agent（0.1.7-rc.2 源码核对：
 *     dsh-agent-loop/lib/index.js:984 dispatch.serial("agent/turn-stopping", {turn,signal})
 *     走 agent-scoped carrier），但闭包取 agent 同样正确，不依赖该字段的稳定性；
 *   - 回调里不往父会话注入任何事件（防污染会话历史与记忆）；
 *   - 评审异步执行，与主线完全解耦。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Config, createSettings } from './settings.js'
import { createCounter } from './counters.js'
import { buildDigest, truncateDigest } from './digest.js'
import { buildReviewPrompt } from './review-prompt.js'
import { runSkillReview } from './reviewer.js'
import { createSkillToolDefinitions, TOOL_NAMES, CURATOR_AUTHOR, skillsRoot, gitRootOf, runGit } from './skill-tools.js'
import { createHistoryStore, defaultHistoryPath } from './history-store.js'

/** Cordis 插件短名（路由/日志用）。 */
export const name = 'skill-curator'

/** 需要这些服务就绪再 apply。 */
export const inject = ['settings', 'tools']

// 0.1.7 起设置命名空间注册已移除：Config 必须从插件模块导出（宿主按 runtime.Config
// 枚举设置视图），命名空间 = cordis 行 id 'skill-curator'。未导出 = 插件页无配置入口。
export { Config }

/** 插件版本（读自 package.json，状态接口回显用）。 */
const VERSION = (() => {
  try {
    return JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8')).version || '0.0.0'
  } catch {
    return '0.0.0'
  }
})()

/**
 * 宿主侧评审历史（持久化：<DSH_HOME>/skill-curator/reviews.json，patch
 * config.historyPath 可覆盖）。卸载/重装/重启后记录仍在。模块级存储工厂：
 * 默认路径在模块加载时按环境初始化（apply 必须同步），config.historyPath
 * 覆盖在 apply 时重建 store 并立即可用（2026-09-01 修复：原实现仅打日志
 * 提示「下次启动生效」，本进程内覆盖不生效）。
 */
export function createReviewLog(overrideFile) {
  return createHistoryStore({
    file: overrideFile || process.env.DSH_CURATOR_HISTORY || undefined,
    log: (level, message) => console.log(`[${level}] ${message}`)
  })
}

/** 默认历史存储（显式覆盖路径时由 apply 重建）。 */
export let reviewLog = createReviewLog(undefined)

/**
 * @param {object} ctx - cordis 上下文（settings/tools 注入）。
 * @param {object} config - composition 补丁配置（可含 skillsRoot / historyPath）。
 */
export function apply(ctx, config = {}) {
  const settings = createSettings(ctx, config)
  // config.historyPath 覆盖：重建 store（读新路径历史），立即生效——
  // 原实现只提示「下次启动生效」，覆盖在本进程内不生效（审计 P2-1）。
  if (config.historyPath && reviewLog.path !== config.historyPath) {
    reviewLog = createReviewLog(config.historyPath)
    ctx.logger.info('skill-curator: historyPath override applied → %s (prev %s)', config.historyPath, reviewLog.path)
  }

  /**
   * 评审收尾自动 commit：把技能库的改动落进 git。
   *
   * 为什么放在插件侧而不是让子代理自己调：子代理的 git 工具（skill-library-git）只是
   * 给它自查用的；真正「每次评审都有版本兜底」必须由主线保证，否则子代理漏调就没了。
   * @returns {Promise<object|null>} { committed, sha?, reason? }；非 git 库或失败返回 null/原因。
   */
  async function autoCommit(ctxRef, spec, actions, agentRef) {
    try {
      const root = skillsRoot(spec)
      const repo = await gitRootOf(root)
      if (repo === null) return { committed: false, reason: 'skills root is not a git work tree' }
      const summary = actions.length > 0
        ? actions.join(' · ').slice(0, 160)
        : 'review produced no skill change'
      const session = (agentRef.session && agentRef.session.id) || 'unknown'
      const message = `skill-curator: ${summary}\n\nsession: ${session}`
      const res = await runGit(repo, ['add', '-A', '--', '.'])
      if (res.code !== 0) return { committed: false, reason: `git add failed: ${res.stderr.trim()}` }
      const status = await runGit(repo, ['status', '--porcelain', '--untracked-files=all'])
      if (!status.stdout.trim()) return { committed: false, reason: 'nothing to commit' }
      const commit = await runGit(repo, ['commit', '-m', message])
      if (commit.code !== 0) return { committed: false, reason: `git commit failed: ${commit.stderr.trim()}` }
      const head = await runGit(repo, ['rev-parse', '--short', 'HEAD'])
      const out = { committed: true, sha: head.stdout.trim() }
      ctxRef.logger.info('skill-curator: auto-committed review changes → %s', out.sha)
      console.log(`skill-curator: 💾 已提交技能库改动 ${out.sha}`)
      return out
    } catch (error) {
      ctxRef.logger.warn('skill-curator: auto-commit failed: %s', (error && error.message) || error)
      return { committed: false, reason: String((error && error.message) || error) }
    }
  }

  // ---------------------------------------------------------------------
  // 工具注册：skill-library-*（全局注册；语义无害，写入受 excludedSkills 与「先读后改」约束）
  // ---------------------------------------------------------------------
  // 注意：必须传 spec()（已解引用 volatile 活引用），不能传 base()（原始 config）。
  // base() 里的 excludedSkills 是 {get()} 对象，Array.isArray 判为 false →
  // 保护名单会静默失效（写入保护形同虚设）。skillsRoot/backupRoot 是普通字段，spec() 同样带出。
  for (const definition of createSkillToolDefinitions(() => settings.spec())) {
    ctx.tools.register(definition)
  }
  ctx.logger.info(
    `skill-curator: registered ${TOOL_NAMES.length} skill-library tools ` +
    `(curator author: ${CURATOR_AUTHOR})`
  )

  // ---------------------------------------------------------------------
  // 触发：agent/created → agent 级 turn-stopping 计数
  // ---------------------------------------------------------------------
  const running = new WeakSet() // 同会话互斥：一次只跑一个评审
  const tracked = new WeakSet() // 同 agent 幂等：agent/created 与补注册共用 installAgentTrack

  /**
   * 异步后台评审（不阻塞调用方；全异常兜底，绝不炸主线）。
   * @param {object} agent
   * @param {string} [focus] - /skill-refine 附加关注点
   */
  function scheduleReview(agent, focus) {
    if (running.has(agent)) {
      ctx.logger.info('skill-curator: review already running for %s; skipped', agent.session && agent.session.id)
      return
    }
    running.add(agent)
    const done = () => running.delete(agent)
    // 微任务延后：turn-stopping 的 serial 事务结束后再跑评审
    Promise.resolve()
      .then(async () => {
        const s = settings.spec()
        // dsh 0.1.2-alpha.4 起 Session 不再暴露 events 属性（prototype 实证仅有
        // snapshotEvents()）——旧读法恒为 undefined → 摘要恒空 → 每次评审被
        // 「no user/model turns」静默跳过且不留任何记录（2026-09-02 修复）。
        // 保留 events 兜底以兼容旧版 dsh 与测试 mock。
        const session = agent.session
        const rawEvents = session
          ? (typeof session.snapshotEvents === 'function' ? session.snapshotEvents() : session.events)
          : undefined
        const events = Array.isArray(rawEvents) ? [...rawEvents] : []
        const { text, stats } = buildDigest(events, { tail: s.digestTail })
        // 无实质对话内容（events 全为 tool/plugin/系统事件）时不起评审
        if (stats.total === 0) {
          ctx.logger.info(
            'skill-curator: review skipped for %s (no user/model turns in %d events)',
            agent.session && agent.session.id,
            events.length
          )
          return
        }
        const digestText = truncateDigest(text, s.digestMaxChars)
        const prompt = buildReviewPrompt({ digestText, focus })
        ctx.logger.info(
          'skill-curator: review started for %s (events=%d compressed=%d chars=%d)',
          agent.session && agent.session.id,
          stats.total,
          stats.compressed,
          digestText.length
        )
        const out = await runSkillReview(ctx, agent, {
          prompt,
          spec: s,
          // 自定义端点 adapter 每次请求现读设置（热改即时生效）
          getSpec: () => settings.spec()
        })
        const actions = out.actions || []
        // 收尾自动 commit（2026-09-28 发哥拍板）：评审写进技能库的改动立刻进 git，
        // 否则「子代理写了什么」既无历史也无 diff 兜底。失败只告警，绝不影响评审结论。
        let versionBackstop = null
        if (out.ok) versionBackstop = await autoCommit(ctx, settings.spec(), actions, agent)
        reviewLog.record({
          at: new Date().toISOString(),
          sessionId: agent.session && agent.session.id,
          ok: out.ok,
          stopReason: out.stopReason,
          actions,
          summary: out.summary,
          diagnostic: out.diagnostic || undefined,
          fallback: out.fallback,
          commit: versionBackstop || undefined
        })
        const notify = String(s.notifyMode || 'on')
        if (notify !== 'off') {
          const headline = actions.length > 0
            ? `💾 Skill review: ${actions.join(' · ')}`
            : '💾 Skill review: 无需保存'
          const fallbackMark = out.fallback ? ' [已回退主模型]' : ''
          const line = `skill-curator: ${headline}${fallbackMark} (session=${agent.session && agent.session.id})`
          // 双通道：ctx.logger 进结构化日志；console.log 直出宿主 stdout
          //（dsh 的 LoggerService 默认不透出 info 级别到 stdout）
          ctx.logger.info(line)
          console.log(line)
          if (notify === 'verbose' && out.summary) {
            const detail = `skill-curator: [detail] ${out.summary.slice(0, 2000)}`
            ctx.logger.info(detail)
            console.log(detail)
          }
        }
      })
      .catch((error) => {
        reviewLog.record({
          at: new Date().toISOString(),
          sessionId: agent.session && agent.session.id,
          ok: false,
          error: String((error && error.message) || error)
        })
        ctx.logger.warn('skill-curator: review failed: %s', (error && error.message) || error)
      })
      .finally(done)
  }

  // 全局监听 agent/created（载荷 {agent}），在 agent 级 scoped ctx 上注册
  // turn-stopping。0.1.7-rc.2 源码核对（dsh-agent-loop/lib/index.js:984）：该事件经 agentEvents 的 fused() 注入 agent
  // （载荷 {agent, turn, signal}），但会话标识仍从闭包拿——不依赖事件字段，更稳。
  // cordis 的 on 第三参数是过滤器，绝不能当 label 传。
  // 计数按 sessionId（非 agent 对象）维护：agent 重建（/compact、会话恢复）时继承计数，
  // 避免触发间隔被重置（审计 P2-2）；agent/disposed 时清理。
  const countersBySession = new Map()

  /**
   * 给单个 agent 挂 turn-stopping 计数钩子（agent/created 与 apply 期补注册
   * 共用；幂等保护：同会话重复到达不重挂、不重置计数——审计 P2-2）。
   * @param {object} agent
   * @returns {boolean} 是否实际挂上（guard 不过或重复到达为 false）
   */
  function installAgentTrack(agent) {
    if (!agent || !agent.ctx || !agent.session) return false
    if (tracked.has(agent)) return false
    tracked.add(agent)
    const header = agent.session.header || {}
    // 评审子代理自身不参与触发（双保险：origin 标记 + 委派深度）
    if (header.origin === 'subagent') return false
    if (typeof header.delegationDepth === 'number' && header.delegationDepth > 0) return false
    const sessionId = agent.session.id
    let counter = countersBySession.get(sessionId)
    let ownsCounter = false
    if (!counter) {
      counter = createCounter()
      countersBySession.set(sessionId, counter)
      ownsCounter = true
    }
    agent.ctx.on('agent/turn-stopping', () => {
      try {
        const s = settings.spec()
        if (!s.enabled) return
        let fired = false
        try {
          fired = counter.bump(s.skillNudgeInterval)
        } catch {
          fired = false
        }
        if (fired) scheduleReview(agent)
      } catch (error) {
        ctx.logger.warn('skill-curator: turn-stopping handler error: %s', (error && error.message) || error)
      }
    })
    agent.ctx.on('agent/disposed', () => {
      // 仅当该 session 的计数仍由本 agent 首次创建时清理；
      // 若重建后的新 agent 已继承（ownsCounter=false），延迟到达的
      // 旧 agent disposed 不得误删新计数（审计复核 P2-2 边界）。
      if (ownsCounter && countersBySession.get(sessionId) === counter) {
        countersBySession.delete(sessionId)
      }
    })
    return true
  }

  // 触发路径一：agent/created（新创建的 agent）。
  ctx.effect(() => ctx.on('agent/created', (payload) => {
    try {
      installAgentTrack(payload && payload.agent)
    } catch (error) {
      ctx.logger.warn('skill-curator: agent/created handler error: %s', (error && error.message) || error)
    }
  }), 'skill-curator: agent track')

  // 触发路径二：补注册已存在的 agent（2026-09-02 修复，2026-09-28 修正时序）。
  // dsh 重启后 resume 的 agent（及任何插件晚于 agent 创建的时序），其
  // agent/created 在本监听注册之前已经 emit——错过即永久错过，resume 会话
  // 永远挂不上 turn-stopping（症状：重启后当前会话 3 轮结束不触发评审；
  // 同坑先例 = dsh-mem0-plugins 2026-08-25 补注册修复）。
  //
  // ⚠️ 必须是**等待式注入**，不能用一次性 ctx.get('agents')：
  // agents 由 dsh-base 的 agent 行提供，与本插件 apply 的时序不保证 ——
  // 服务未就绪时一次性读拿到 undefined，补注册被静默跳过、零日志，
  // 症状是「重启后第一个会话永远不被策展」（2026-09-28 实测：同一形态
  // 先在 webServer 上爆发过一次，这里同源）。
  // installAgentTrack 幂等，与路径一重复到达不会双挂。
  ctx.inject(['agents'], (agentCtx) => {
    try {
      const existing = agentCtx.agents && typeof agentCtx.agents.list === 'function'
        ? agentCtx.agents.list()
        : []
      if (existing && existing.length) {
        for (const agent of existing) installAgentTrack(agent)
        ctx.logger.info('skill-curator: backfilled %d existing agent(s)', existing.length)
      }
    } catch (error) {
      ctx.logger.warn('skill-curator: existing-agent backfill failed: %s', (error && error.message) || error)
    }
  })

  // ---------------------------------------------------------------------
  // 手动命令：/skill-refine [focus]
  // ---------------------------------------------------------------------
  const commands = ctx.get('commands')
  if (commands !== undefined) {
    commands.register({
      name: 'skill-refine',
      description: '立即对本次会话发起一次后台技能评审（可附加关注点：/skill-refine <focus>）',
      handler: ({ agent, rawInput, signal }) => {
        try {
          scheduleReview(agent, (rawInput || '').trim())
          return {
            kind: 'success',
            text: '🎓 技能评审已在后台启动，完成后结果会出现在宿主日志与设置卡片。'
          }
        } catch (error) {
          return { kind: 'error', text: `技能评审启动失败：${(error && error.message) || error}` }
        }
      }
    })
  }

  // ---------------------------------------------------------------------
  // 状态接口：GET /api/skill-curator/status（设置卡片轮询展示）
  // ---------------------------------------------------------------------
  // 等待式注入（第七路盲区，2026-09-28 实测踩中）：
  // webServer 由 dsh-web-app 组合挂载，与本插件的 apply 时序不保证——
  // 用一次性 ctx.get('webServer') 会在服务未就绪时静默空转（状态接口永不注册，
  // 设置卡「最近评审」永远拿不到数据，且没有任何报错）。正确形态是 ctx.inject 等待就绪。
  const LOOPBACK = /^(127\.0\.0\.1|\[::1\]|localhost)(:\d+)?$/i
  const sameOrigin = (req) => {
    // 同源守卫（对齐 dsh-config-center 先例）：/api 信任围栏校验 Host/Origin
    const host = String(req.headers && (req.headers.host || req.headers.Host) || '')
    if (!LOOPBACK.test(host)) return false
    const origin = req.headers && (req.headers.origin || req.headers.Origin)
    if (!origin) return true // 同源 GET 可能不带 Origin
    try {
      return LOOPBACK.test(new URL(String(origin)).host)
    } catch {
      return false
    }
  }
  ctx.inject(['webServer'], (wsCtx) => {
    // 官方范例（dsh-client-connection/lib/index.js:843）：注册必须包在 effect 里，
    // 卸载时 disposer 由 fiber 收口，避免热重载后残留旧路由。
    wsCtx.effect(() => wsCtx.webServer.register({
      kind: 'exact',
      path: '/api/skill-curator/status',
      handler: async (req, res) => {
        try {
          if (!sameOrigin(req)) {
            res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ ok: false, error: 'forbidden: cross-origin' }))
            return
          }
          if (req.method !== 'GET' && req.method !== 'HEAD') {
            res.writeHead(405, { allow: 'GET' })
            res.end('method not allowed')
            return
          }
          const body = JSON.stringify({
            ok: true,
            name,
            version: VERSION,
            enabled: settings.spec().enabled,
            interval: settings.spec().skillNudgeInterval,
            reviews: reviewLog.recent().slice(0, 5)
          })
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
          res.end(body)
        } catch (error) {
          res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ ok: false, error: String(error && error.message || error) }))
        }
      }
    }), 'skill-curator: status route')
  })
}