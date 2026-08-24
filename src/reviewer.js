/**
 * dsh-skill-curator — 评审子代理编排。
 *
 * 对齐 hermes 的「后台 fork 评审」：插件在 turn 结束后起一个平台子代理
 * （provider: spawn，默认注册于 dsh-base 组合），把会话摘要 + 评审指令
 * 作为它的唯一输入，并用 toolFilter 白名单把它限制为只能调用
 * skill-library-* 工具（工具级等价 hermes 的运行时白名单）。
 *
 * 隔离设计：
 *   - 评审子代理是独立 session，绝不往父会话写任何事件（无污染）；
 *   - 摘要而非全量会话注入（控制成本）；
 *   - 超时兜底 dispose；父 agent 已释放（agent/disposed）时不再回显。
 */
import { settleRun } from '@deepseek-ai/dsh-subagent'
import { TOOL_NAMES } from './skill-tools.js'

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
 * 起一个评审子代理并等待结果。
 *
 * @param {object} ctx - cordis 上下文（须含 subagents/tools）。
 * @param {object} agent - 触发评审的父 agent（live）。
 * @param {object} opts
 * @param {string} opts.prompt - 完整评审消息（摘要 + 指令）。
 * @param {object} opts.spec - 当前设置快照。
 * @param {string} [opts.label='skill review'] - 子代理显示标签。
 * @returns {Promise<object>} { ok, summary, actions, diagnostic, stopReason }
 */
export async function runSkillReview(ctx, agent, { prompt, spec, label = 'skill review' }) {
  const subagents = ctx.get('subagents')
  if (subagents === undefined) {
    throw new Error('subagents service unavailable')
  }
  const controller = new AbortController()
  const timeoutMs = Number((spec && spec.reviewTimeoutMs) || 900000)
  const timer = setTimeout(() => controller.abort(new Error('skill review timeout')), timeoutMs)

  const request = {
    label,
    prompt: [{ type: 'text', text: prompt }],
    parent: agent,
    signal: controller.signal,
    // 白名单：子代理只能看到/执行 skill 工具（hermes 运行时白名单等价物）
    toolFilter: { allow: TOOL_NAMES }
  }
  // 评审模型覆盖（设置里配了 provider+model 才传；空 = 继承父会话运行时）
  const reviewProvider = String((spec && spec.reviewProvider) || '').trim()
  const reviewModel = String((spec && spec.reviewModel) || '').trim()
  if (reviewProvider && reviewModel) {
    request.agentOptions = { provider: reviewProvider, model: reviewModel }
  }

  let run
  try {
    run = await subagents.start('spawn', request)
  } catch (error) {
    clearTimeout(timer)
    throw error
  }

  try {
    const result = await settleRun(run)
    clearTimeout(timer)
    const output = result.output || []
    const summary = output
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('\n')
      .trim()
    const isNothing = /无需保存|nothing to save/i.test(summary)
    return {
      ok: result.stopReason === 'completed',
      stopReason: result.stopReason,
      diagnostic: result.diagnostic || '',
      summary,
      actions: isNothing ? [] : [summary]
    }
  } catch (error) {
    clearTimeout(timer)
    try {
      await run.dispose()
    } catch {
      // dispose 失败不掩盖原始错误
    }
    throw error
  }
}