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
 *   - 0.1.7-rc.2 契约：settleRun 仍从包根导出（dsh-subagent/lib/index.js:3201），
 *     返回 { status:'completed'|'killed'|'failed', output?, detail? }，与 0.1.5 同名同形。
 */
import { settleRun } from '@deepseek-ai/dsh-subagent'
import { TOOL_NAMES } from './skill-tools.js'
import { createCustomAdapter } from './custom-adapter.js'

/** 自定义端点默认 provider 路由名（设置 reviewProvider 非空时用之）。 */
export const CUSTOM_REVIEW_ROUTE = 'skill-curator-review'

/**
 * 自定义端点 adapter 的进程内注册记录：route -> { adapter, handle }。
 *
 * 为什么需要它（2026-09-10 适配轮实测的存量缺陷）：宿主 `registerAdapter` 的
 * 服务代理把 `this.ctx` 绑到**调用方 fiber**，返回的 handle 是 `ctx.effect(...)` 的
 * disposer——**本插件 fiber 卸载（patch 热重载 / 卸载重挂）时路由会被宿主自动摘掉**。
 * 原实现只做「Map 里有就跳过」的存在性判断，卸载后 Map 里仍留着过期条目 →
 * 同一进程内重新 apply 时直接 return、**永不重注册** → 自定义端点评审在「首次评审后
 * 发生过一次插件重载」的进程里 100% 失败（provider 路由不存在）。
 *
 * 修法：判据从「注册过一次」改为「**当下仍挂载**」——用 `llm.listProviders()`（服务端
 * 权威读，dsh-llm lib/index.js:1846）核验 route 在列；不在列即重注册并刷新记录。
 * （handle 仅作记录留痕，不参与判据。）
 */
const customAdapters = new Map() // route -> { adapter, handle }

/**
 * 确保自定义端点 adapter 已注册到 llm 服务。
 *
 * 语义 = 「确保**当下可用**」而非「确保注册过一次」：路由仍挂载时幂等复用，
 * 被宿主摘掉（本插件 fiber 卸载）时重注册。llm 服务缺失时抛错（评审前由调用方兜底）。
 * @param {object} ctx - cordis 上下文。
 * @param {string} route - provider 路由名。
 * @param {() => object} getSpec - 当前设置快照读取器（adapter 每次 stream 现读）。
 * @param {object} [llm] - llm 服务（缺省从 ctx 取；测试可注入）。
 */
export function ensureCustomAdapter(ctx, route, getSpec, llm = ctx.get('llm')) {
  if (llm === undefined || typeof llm.registerAdapter !== 'function') {
    throw new Error('llm service unavailable — cannot register custom review endpoint')
  }
  // 存活判据：宿主注册表里仍认得这条路由（卸载后 handle 已被宿主 dispose，路由消失）。
  // `listProviders` 缺席（老宿主/极简桩）时退回「已注册即视为存活」——不制造重注册抖动，
  // 但真宿主 dsh-llm 提供该方法（lib/index.js:1846），故真机走的是权威判据。
  const live = customAdapters.get(route)
  if (live !== undefined && !canProbeRoutes(llm)) return
  if (live !== undefined && routeIsMounted(llm, route)) return
  const adapter = createCustomAdapter(getSpec, route)
  let handle
  try {
    handle = llm.registerAdapter([route], adapter)
  } catch (error) {
    // 重复注册（DUPLICATE_ADAPTER）说明路由已被本进程别处/旧注册占着——读回存活即可
    if (routeIsMounted(llm, route)) {
      customAdapters.set(route, { adapter: (live && live.adapter) || adapter, handle: live && live.handle })
      return
    }
    customAdapters.delete(route)
    throw error
  }
  customAdapters.set(route, { adapter, handle })
}

/**
 * 宿主是否提供路由存活探测能力（`listProviders`，dsh-llm lib/index.js:1846）。
 * @param {object} llm - llm 服务。
 * @returns {boolean} true = 可用服务端权威读判断路由存活。
 */
export function canProbeRoutes(llm) {
  return Boolean(llm && typeof llm.listProviders === 'function')
}

/**
 * 路由当前是否真的挂在宿主注册表上（服务端权威读）。
 * @param {object} llm - llm 服务。
 * @param {string} route - provider 路由名。
 * @returns {boolean} true = 路由仍可被宿主解析。
 */
export function routeIsMounted(llm, route) {
  if (!canProbeRoutes(llm)) return false
  try {
    const providers = llm.listProviders()
    if (!Array.isArray(providers)) return false
    return providers.some((entry) => (typeof entry === 'string' ? entry : entry && entry.id) === route)
  } catch {
    return false
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
    // 重试仍带模型覆盖：端点恢复后就能继续用专用评审模型/自定义端点，
    // 不必等下一次评审；回退只发生在「确实跑不动」时（去掉覆盖再跑）。
    outcome = await runOnce(subagents, provider, fallbackReason !== null ? baseRequest : overrideRequest, timeoutMs)
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