/**
 * dsh-skill-curator — 评审子代理编排。
 *
 * 对齐 hermes 的「后台 fork 评审」：插件在 turn 结束后起一个平台子代理
 * （provider: spawn，默认注册于 dsh-base 组合），把会话摘要 + 评审指令
 * 作为它的唯一输入，并用 toolFilter 白名单把它限制为只能调用
 * skill-library-* 工具（工具级等价 hermes 的运行时白名单）。
 *
 * 模型覆盖与回退（发哥要求）：
 *   - reviewBaseUrl + reviewModel（自定义端点，OpenAI 兼容）→ 专用 adapter
 *     路由；reviewProvider + reviewModel（已注册路由）→ 直接 agentOptions；
 *     均空 → 跟随父会话模型。
 *   - 自定义端点/覆盖模型**无法工作**（端点 HTTP/网络/鉴权/模型缺失/超时）
 *     → 自动回退：去掉 agentOptions 以父会话模型重跑一次（只回退一次），
 *     结果带 fallback 标记（日志与状态面板可见）。
 *
 * 隔离设计：
 *   - 评审子代理是独立 session，绝不往父会话写任何事件（无污染）；
 *   - 摘要而非全量会话注入（控制成本）；
 *   - 每次尝试独立超时兜底；settleRun 永不 reject（失败转 status）。
 */
import { settleRun } from '@deepseek-ai/dsh-subagent'
import { TOOL_NAMES } from './skill-tools.js'
import { createCustomAdapter } from './custom-adapter.js'

/** 自定义端点默认 provider 路由名（设置 reviewProvider 非空时用之）。 */
export const CUSTOM_REVIEW_ROUTE = 'skill-curator-review'

/** 自定义端点 adapter 注册缓存：route -> adapter 实例（凭据每请求读 settings）。 */
const customAdapters = new Map() // route -> adapter

/**
 * 确保自定义端点 adapter 已注册到 llm 服务。
 * 幂等：同名路由已注册则复用；llm 服务缺失时抛错（评审前由调用方兜底）。
 * @param {object} ctx - cordis 上下文。
 * @param {string} route - provider 路由名。
 * @param {() => object} getSpec - 当前设置快照读取器（adapter 每次 stream 现读）。
 */
export function ensureCustomAdapter(ctx, route, getSpec) {
  if (customAdapters.has(route)) return
  const llm = ctx.get('llm')
  if (llm === undefined || typeof llm.registerAdapter !== 'function') {
    throw new Error('llm service unavailable — cannot register custom review endpoint')
  }
  const adapter = createCustomAdapter(getSpec, route)
  customAdapters.set(route, adapter)
  try {
    llm.registerAdapter([route], adapter)
  } catch (error) {
    customAdapters.delete(route)
    throw error
  }
}

/** 评审运行状态（供状态面板/日志）。 */
export function createReviewLog() {
  const runs = [] // { at, sessionId, result, summary, actions, error }
  const MAX_RUNS = 50
  return {
    record(entry) {
      runs.unshift(entry)
      if (runs.length > MAX_RUNS) runs.length = MAX_RUNS
    },
    recent() {
      return runs
    }
  }
}

/**
 * 解析评审用的子代理 provider 名：优先 'spawn'（dsh-base 默认注册），
 * 不在时回退到第一个可用 provider；一个都没有则抛错。
 */
function resolveProvider(subagents) {
  try {
    if (typeof subagents.getProvider === 'function' && subagents.getProvider('spawn')) return 'spawn'
    if (typeof subagents.list === 'function') {
      const names = subagents.list() || []
      if (names.includes('spawn')) return 'spawn'
      if (names.length > 0) return names[0]
    }
  } catch {
    // 注册表不可用时按默认名走，让 start 给出权威报错
  }
  return 'spawn'
}

/**
 * 判定失败是否属于「端点/模型层」问题（值得回退主模型）。
 * 特征：自定义端点错误前缀、网络错误码、HTTP 状态、鉴权/限流/模型缺失。
 * @param {unknown} errorOrDetail - start 抛错信息或 settleRun 的 detail。
 */
export function isEndpointModelFailure(errorOrDetail) {
  const text = String(errorOrDetail || '')
  return /custom review endpoint|review endpoint|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|EPIPE|EHOSTUNREACH|HTTP \d{3}|unauthorized|invalid api|401|403|404|429|too many requests|model[^\n]{0,40}not found|no such model/i.test(text)
}

/**
 * 单次评审尝试：起子代理并 settle（永不 reject；start 抛错向上传）。
 * 每次尝试独立 AbortController + 超时预算。
 */
async function runOnce(subagents, provider, request, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('skill review timeout')), timeoutMs)
  try {
    return await settleRun(await subagents.start(provider, { ...request, signal: controller.signal }))
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 起一个评审子代理并等待结果（含自定义端点失败回退主模型）。
 *
 * @param {object} ctx - cordis 上下文（须含 subagents；自定义端点时含 llm）。
 * @param {object} agent - 触发评审的父 agent（live）。
 * @param {object} opts
 * @param {string} opts.prompt - 完整评审消息（摘要 + 指令）。
 * @param {object} opts.spec - 当前设置快照。
 * @param {() => object} opts.getSpec - 设置读取器（自定义 adapter 现读端点/凭据）。
 * @param {string} [opts.label='skill review'] - 子代理显示标签。
 * @returns {Promise<object>} { ok, summary, actions, diagnostic, stopReason, fallback? }
 */
export async function runSkillReview(ctx, agent, { prompt, spec, getSpec = () => spec, label = 'skill review' }) {
  const subagents = ctx.get('subagents')
  if (subagents === undefined) {
    throw new Error('subagents service unavailable')
  }
  const provider = resolveProvider(subagents)
  const timeoutMs = Number((spec && spec.reviewTimeoutMs) || 900000)

  const baseRequest = {
    label,
    prompt: [{ type: 'text', text: prompt }],
    parent: agent,
    // 白名单：子代理只能看到/执行 skill 工具（hermes 运行时白名单等价物）
    toolFilter: { allow: TOOL_NAMES }
  }

  // 模型覆盖判定：
  //  - 自定义端点：reviewBaseUrl + reviewModel（+ reviewApiKey 可选）→ adapter 路由
  //  - 已注册路由：reviewProvider + reviewModel → agentOptions 直传
  //  - 均空 → 跟随父会话
  const reviewProvider = String((spec && spec.reviewProvider) || '').trim()
  const reviewModel = String((spec && spec.reviewModel) || '').trim()
  const reviewBaseUrl = String((spec && spec.reviewBaseUrl) || '').trim()
  const custom = Boolean(reviewBaseUrl && reviewModel)

  const overrideRequest = { ...baseRequest }
  if (custom) {
    const route = reviewProvider || CUSTOM_REVIEW_ROUTE
    ensureCustomAdapter(ctx, route, getSpec)
    overrideRequest.agentOptions = { provider: route, model: reviewModel }
  } else if (reviewProvider && reviewModel) {
    overrideRequest.agentOptions = { provider: reviewProvider, model: reviewModel }
  }

  // 第一次尝试（可能带模型覆盖）
  let outcome
  let fallbackReason = null
  try {
    outcome = await runOnce(subagents, provider, overrideRequest, timeoutMs)
  } catch (error) {
    // start 抛错：provider 拒绝 / 模型解析失败等
    const message = String((error && error.message) || error)
    if (custom && isEndpointModelFailure(message)) {
      fallbackReason = message
    } else {
      throw error
    }
  }
  // settleRun 失败：端点错误 / 超时杀停。
  // killed（超时 abort）在自定义端点下直接视为端点问题（慢/挂起）→ 回退；
  // failed 需 detail 命中端点/模型特征才回退（非端点失败不重试）。
  if (fallbackReason === null && outcome && outcome.status !== 'completed' && custom) {
    if (outcome.status === 'killed' || isEndpointModelFailure(outcome.detail || '')) {
      fallbackReason = String(outcome.detail || outcome.status)
    }
  }

  // 回退：去掉模型覆盖，以父会话模型重跑一次（只回退一次）
  if (fallbackReason !== null) {
    outcome = await runOnce(subagents, provider, baseRequest, timeoutMs)
  }

  // 有限重试：评审跟随/回退到主模型后，主模型的连接类瞬断不再直接终止本次评审
  // （2026-08-25 发哥要求）。仅对端点/模型层特征或无详情的 killed 重试——
  // 工具层报错等非端点失败仍不重试，保持既有哲学；次数与退避可配。
  const retryMax = Math.max(0, Math.trunc(Number((spec && spec.reviewRetryCount) ?? 1)))
  const retryDelay = Math.max(0, Number((spec && spec.reviewRetryDelayMs) ?? 5000))
  for (let attempt = 1; attempt <= retryMax; attempt++) {
    if (!outcome || outcome.status === 'completed') break
    const detail = String(outcome.detail || '')
    const retryable = outcome.status === 'killed' || isEndpointModelFailure(detail)
    if (!retryable) break
    if (retryDelay > 0) await new Promise((r) => setTimeout(r, retryDelay * attempt))
    ctx.logger?.info?.(`skill-curator: review retry ${attempt}/${retryMax} after ${outcome.status}${detail ? `: ${detail.slice(0, 120)}` : ''}`)
    outcome = await runOnce(subagents, provider, baseRequest, timeoutMs)
  }

  const ok = outcome && outcome.status === 'completed'
  const summary = (typeof (outcome && outcome.output) === 'string' ? outcome.output : '').trim()
  const diagnostic = String((outcome && outcome.detail) || '')
  const isNothing = /无需保存|nothing to save/i.test(summary)
  return {
    ok,
    stopReason: outcome ? outcome.status : 'unknown',
    diagnostic,
    summary,
    actions: isNothing || !ok ? [] : [summary],
    ...(fallbackReason !== null ? { fallback: { reason: fallbackReason.slice(0, 300) } } : {})
  }
}