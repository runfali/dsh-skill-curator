/**
 * dsh-skill-curator — 回合计数与触发判定（纯函数，可单测）。
 *
 * 对齐 hermes 的 design：每 N 轮真实对话触发一次后台评审。
 * 评审子代理自身的回合不计入（按 session header origin 判定，见 trigger.js）。
 */
import { EventEmitter } from 'node:events'

/** 每 agent 的计数状态。 */
export function createCounter(interval) {
  const state = new WeakMap() // agent -> { turns: number }

  /**
   * 记录一轮真实对话（turn-stopping 里调用）。
   * @param {object} agent - live Agent。
   * @returns {boolean} 是否达到触发阈值（达标后自动清零）。
   */
  function bump(agent) {
    const s = state.get(agent) || { turns: 0 }
    s.turns += 1
    state.set(agent, s)
    if (s.turns >= interval) {
      s.turns = 0
      return true
    }
    return false
  }

  /** 当前计数（面板/调试用）。 */
  function countOf(agent) {
    const s = state.get(agent)
    return s ? s.turns : 0
  }

  function reset(agent) {
    state.delete(agent)
  }

  return { bump, countOf, reset }
}