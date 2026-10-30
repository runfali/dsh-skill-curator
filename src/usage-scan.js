/**
 * dsh-skill-curator — 「什么算一次使用」的唯一判据（纯函数，零依赖）。
 *
 * 为什么单独成文件：线上观测（tools/pre-execute）和历史回填（scripts/backfill-usage.mjs）
 * **必须同源**。两套判据一旦漂移，面板上的数字和回填结果就会互相矛盾，而且没人能看出是哪边错。
 *
 * 判据（2026-10-30 定案，依据 484 个会话的真机统计）：
 *   1. `skill` 工具调用 = 使用。主会话与普通子代理都算 —— 评审/TDD 族技能几乎只被
 *      子代理加载（TDD 35 次子代理 / 16 次主会话），只算主会话会让它们永远「从未使用」。
 *   2. 评审子代理自己的加载**不算**。它读技能是为了维护技能库，若计进去，
 *      每轮评审都会把全库刷成「刚刚用过」，生命周期直接失去分辨力。
 *      判据优先看 session header 的 agentPreset（0.2.1+ 由 reviewer.js 写入），
 *      0.2.1 之前没有 preset，用子代理 label 'skill review' 兜底。
 *   3. 任意工具的参数里出现 `<...>/skills/<技能名>/...` = 使用。覆盖 read / grep /
 *      bash / run_code 里跑技能自带脚本 —— llm-wiki 这类脚本型技能的真实用法
 *      （10 天 22 次直接读文件）全在这一类。
 *   4. `skill-library-*` 一律不算：那是维护动作（评审读写技能库每周 2000+ 次），
 *      算进去等于自欺。
 *
 * 误判方向说明：路径判据偏宽松（run_code 的代码文本里提到路径就算），
 * 这会让技能**更难**被归档 —— 与「宁可少归档，不可误归档」一致。
 */

/** 评审子代理专用的 Agent Preset id（真源在此，reviewer.js 从这里 re-export）。 */
export const REVIEW_AGENT_PRESET = 'skill-curator-review'

/** 0.2.1 之前评审子代理没有 preset，只有这个 label。 */
export const REVIEW_LABEL = 'skill review'

/** 维护类工具前缀：技能库读写不算使用。 */
const MAINTENANCE_TOOL = /^skill-library-/

/** `<任意前缀>/skills/<技能名>/<任意>` —— 只认目录边界，不认“名字像”。 */
const SKILL_PATH = /[\\/]skills[\\/]([^\\/"'\s]+)[\\/]/g

/** 单次参数扫描上限（字符）。run_code 的大脚本没必要为此付出正则成本。 */
export const MAX_SCAN_BYTES = 200_000

/**
 * 把工具参数归一成对象。会话日志里 tool/call 的 arguments 是 JSON 字符串，
 * 而宿主 pre-execute 给的是对象 —— 两种形态都必须成立。
 * @param {unknown} args
 * @returns {object|null}
 */
export function parseArguments(args) {
  if (!args) return null
  if (typeof args === 'string') {
    try {
      const parsed = JSON.parse(args)
      return parsed && typeof parsed === 'object' ? parsed : null
    } catch {
      return null
    }
  }
  return typeof args === 'object' ? args : null
}

/**
 * 这个会话是不是本插件自己的评审子代理。
 * @param {object} [header] - session header（含 agentPreset / origin / delegationDepth）
 * @param {string} [label] - 子代理 descriptor 的 label（回填时可得）
 * @returns {boolean}
 */
export function isReviewSession(header, label) {
  if (label === REVIEW_LABEL) return true
  if (!header || typeof header !== 'object') return false
  return header.agentPreset === REVIEW_AGENT_PRESET
}

/**
 * 从任意工具参数里找出被"碰到"的技能名。
 * @param {unknown} args - 工具参数（对象或 JSON 字符串）
 * @param {object} [opts]
 * @param {number} [opts.maxBytes] - 超过则跳过（默认 MAX_SCAN_BYTES）
 * @returns {string[]} 去重并排序的技能名
 */
export function skillsInArguments(args, { maxBytes = MAX_SCAN_BYTES } = {}) {
  const obj = parseArguments(args)
  if (!obj) return []
  const found = new Set()
  let budget = maxBytes
  // 注意：这里**逐个字符串值**扫，不是 JSON.stringify 后扫整串。
  // 理由：stringify 会把 Windows 路径的 \\ 转义成 \\\\，正则要么漏匹配，
  // 要么得写成「1~2 个分隔符」的模糊形态，两种都不可靠（第一版踩过）。
  const visit = (value, depth) => {
    if (budget <= 0 || depth > 8) return
    if (typeof value === 'string') {
      budget -= value.length
      if (budget <= 0 || !value.includes('skills')) return
      SKILL_PATH.lastIndex = 0
      let match
      while ((match = SKILL_PATH.exec(value))) {
        const name = match[1]
        if (name && name !== '..' && name !== '.') found.add(name)
      }
      return
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1)
      return
    }
    if (value && typeof value === 'object') {
      for (const item of Object.values(value)) visit(item, depth + 1)
    }
  }
  visit(obj, 0)
  return [...found].sort()
}

/**
 * 一次工具调用应该记哪些技能为"已使用"。
 *
 * @param {object} call
 * @param {string} call.tool - 工具名（exec.name）
 * @param {unknown} [call.args] - 工具参数
 * @param {object} [call.agent] - 宿主 agent（取 agent.session.header）
 * @param {string} [call.label] - 会话 label（回填用）
 * @param {string} [call.reviewPreset] - 评审 preset id（默认 REVIEW_AGENT_PRESET）
 * @param {number} [call.maxBytes] - 路径扫描上限
 * @returns {string[]} 要 markUsed 的技能名（可能为空）
 */
export function usageCandidates({ tool, args, agent, label, reviewPreset = REVIEW_AGENT_PRESET, maxBytes } = {}) {
  if (!tool || typeof tool !== 'string') return []
  if (MAINTENANCE_TOOL.test(tool)) return []
  const header = agent && agent.session && agent.session.header
  if (isReviewSession(header, label)) return []
  if (header && header.agentPreset === reviewPreset) return []
  if (tool === 'skill') {
    const obj = parseArguments(args)
    const name = obj && obj.name
    return typeof name === 'string' && name ? [name] : []
  }
  return skillsInArguments(args, maxBytes === undefined ? undefined : { maxBytes })
}
