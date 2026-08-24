/**
 * dsh-skill-curator — 回合计数与触发判定（纯函数，可单测）。
 *
 * 对齐 hermes 的 design：每 N 轮真实对话触发一次后台评审。
 * interval 在 bump 时动态传入（设置改动即时生效于所有存活会话），
 * 评审子代理自身的回合不计入（按 session header 判定，见 trigger/index）。
 */

/** 创建独立计数器（每 agent 一个实例）。 */
export function createCounter() {
  let turns = 0

  /**
   * 记录一轮真实对话（turn-stopping 里调用）。
   * @param {number} interval - 当前生效的触发间隔。
   * @returns {boolean} 是否达到触发阈值（达标后自动清零）。
   */
  function bump(interval) {
    turns += 1
    const n = Number(interval) > 0 ? Math.trunc(Number(interval)) : 1
    if (turns >= n) {
      turns = 0
      return true
    }
    return false
  }

  /** 当前计数（面板/调试用）。 */
  function countOf() {
    return turns
  }

  function reset() {
    turns = 0
  }

  return { bump, countOf, reset }
}
