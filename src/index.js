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
 *   3. 写盘：~/.dsh/skills/<name>/SKILL.md（中文正文 + 双语描述），frontmatter
 *      盖 author 章做产权标记；只更新插件创建或用户收养的 skill。
 *   4. 手动：/skill-refine [focus] 命令立即对当前会话发起评审。
 *
 * 已知平台约束（docs/COMPARISON.md）：
 *   - turn-stopping 运行时载荷无 agent 字段（d.ts 声明有，实现没有），
 *     所以用 agent/created（实测带 agent）闭包注册 agent.ctx 子监听；
 *   - 回调里不往父会话注入任何事件（防污染会话历史与记忆）；
 *   - 评审异步执行，与主线完全解耦。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createSettings } from './settings.js'
import { createCounter } from './counters.js'
import { buildDigest, truncateDigest } from './digest.js'
import { buildReviewPrompt } from './review-prompt.js'
import { runSkillReview } from './reviewer.js'
import { createSkillToolDefinitions, TOOL_NAMES, CURATOR_AUTHOR } from './skill-tools.js'
import { createHistoryStore, defaultHistoryPath } from './history-store.js'

/** Cordis 插件短名（路由/日志用）。 */
export const name = 'skill-curator'

/** 需要这些服务就绪再 apply。 */
export const inject = ['settings', 'tools']

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

  // ---------------------------------------------------------------------
  // 工具注册：skill-library-*（全局注册；语义无害，只写插件自有/收养的 skill）
  // ---------------------------------------------------------------------
  for (const definition of createSkillToolDefinitions(() => settings.base())) {
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
        const events = agent.session && agent.session.events ? [...agent.session.events] : []
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
        reviewLog.record({
          at: new Date().toISOString(),
          sessionId: agent.session && agent.session.id,
          ok: out.ok,
          stopReason: out.stopReason,
          actions,
          summary: out.summary,
          diagnostic: out.diagnostic || undefined,
          fallback: out.fallback
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

  // 全局监听 agent/created（载荷带 agent，实测确认），在 agent 级 scoped ctx 上注册
  // turn-stopping——其运行时载荷仅有 {turn, signal}，没有 agent 字段（实现与 d.ts 漂移），
  // 会话标识从闭包拿。cordis 的 on 第三参数是过滤器，绝不能当 label 传。
  // 计数按 sessionId（非 agent 对象）维护：agent 重建（/compact、会话恢复）时继承计数，
  // 避免触发间隔被重置（审计 P2-2）；agent/disposed 时清理。
  const countersBySession = new Map()
  ctx.effect(() => ctx.on('agent/created', (payload) => {
    const agent = payload && payload.agent
    if (!agent || !agent.ctx || !agent.session) return
    const header = agent.session.header || {}
    // 评审子代理自身不参与触发（双保险：origin 标记 + 委派深度）
    if (header.origin === 'subagent') return
    if (typeof header.delegationDepth === 'number' && header.delegationDepth > 0) return
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
  }), 'skill-curator: agent track')

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
  const webServer = ctx.get('webServer')
  if (webServer !== undefined) {
    // 同源守卫（对齐 dsh-config-center 先例）：/api 信任围栏校验 Host/Origin
    const LOOPBACK = /^(127\.0\.0\.1|\[::1\]|localhost)(:\d+)?$/i
    const sameOrigin = (req) => {
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
    webServer.register({
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
    })
  }
}