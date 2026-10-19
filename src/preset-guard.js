/**
 * dsh-skill-curator — 评审子代理的工具白名单守卫（preset 内挂载）。
 *
 * 为什么需要它（2026-10-18 适配轮实测）：
 *   dsh 0.2.1-rc.2 起 `startLocal` 只把 `agentPreset` 写进 child composition
 *   （dsh-subagent/lib/index.js:1452），**本地起子代理拿不到 `request.toolFilter`**
 *   （只有 continuation.js:124/168 那条 continuable 路径会读它）。同时
 *   `dsh-tool-subagent` 对 `config.toolFilter` 直接抛错并指明
 *   "configure persona and tool plugins in an Agent Preset"——官方把
 *   「按子代理过滤工具」的语义整个搬到了 Agent Preset 层。
 *
 *   于是插件原本的 `toolFilter: { allow: TOOL_NAMES }` 在 0.2.1 上不生效：
 *   评审子代理拿到父组合的全部工具，而它的输入是**完整会话摘要**。
 *   这行代码把它按支持的 API 恢复回来。
 *
 * 为什么这样能生效：本行声明在 preset 的 plugins 里，挂载点是**子代理自己的
 * scope**（`mountPreset` → `createScope` → child ctx）。`tools.restrict()` 要求
 * 有 scope，且它过滤的是**继承面**（global + 各祖先层），不影响本层自己注册的
 * 工具——正是「给这个孩子戴眼罩」的语义，与宿主 `applyChildOverrides` 里
 * `childCtx.tools.restrict(composition.toolFilter)` 完全同源。
 *
 * ⚠️ 必须等就绪标记（2026-10-18 真机事故）：
 *   `restrict()` 用 `view(scope).restrictableNames` 校验名字，而它**只收继承面**
 *   （dsh-tools/lib/index.js:3058-3070，`if (layer === own) continue`）。
 *   profile 各行由 `EntryGroup.update` 的 `Promise.all` **并发**创建
 *   （cordis-plugin-loader/lib/index.js:87-92），preset 行只 inject `tools`，
 *   skill-curator 还要等 `settings` → preset 先跑完，那一刻
 *   `skill-library-*` 尚未注册 → 抛 "names unknown global tools"
 *   → `activate()` 写死 `record.broken`（"A mount failure is final"），
 *   preset **永久** broken，设置页显示「加载失败」。
 *   所以这里 inject 本插件的就绪标记，让 restrict 在工具注册后才执行。
 */
import { TOOL_NAMES, TOOLS_READY_SERVICE } from './skill-tools.js'

/** Cordis 插件短名。 */
export const name = 'skill-curator-review-guard'

/**
 * 守卫修订标记。出现在报错文本里 = **这个版本的模块确实被加载并执行了**。
 *
 * 为什么需要：preset 的 `activate()` 把 mount 失败写死进 `record.broken`
 * （registry 源码注释 "A mount failure is final"），之后 Loader 行照样显示
 * `fiberPhase: 'active'`，而 `diagnostic()` 在 `generation === undefined` 时
 * **直接返回缓存的 broken 文本**。于是「preset 没重新挂载」与「重新挂了但
 * 守卫仍失败」产生**逐字相同**的报错，无法区分。2026-10-18 真机就卡在这里：
 * 我一度把行 active 当成验收通过。带上修订标记后，看报错里有没有它就够了。
 */
export const GUARD_REVISION = 'guard-rev-2026-10-18b'

/**
 * 需要 tools 服务与本插件的就绪标记都到位再 apply。
 * 标记缺失时本 fiber 进 INACTIVE（不阻塞启动），标记发布后自动唤醒。
 */
export const inject = ['tools', TOOLS_READY_SERVICE]

/**
 * 把子代理可见的工具面收敛到 skill-library-*。
 *
 * 失败即**关闭**：restrict 抛错时重新抛出（附诊断），让 preset 挂载失败。
 * 绝不吞错继续——那会让评审子代理带着父组合的全部工具（含 shell）跑，
 * 而它读的是完整会话摘要。
 *
 * @param {object} ctx - 子代理 scope 上的 cordis 上下文。
 */
export function apply(ctx) {
  try {
    ctx.tools.restrict({ allow: TOOL_NAMES })
  } catch (error) {
    const ready = ctx.get ? ctx.get(TOOLS_READY_SERVICE) !== undefined : 'ctx.get unavailable'
    throw new Error(
      `[${GUARD_REVISION}] tools.restrict({allow: ${TOOL_NAMES.length} names}) failed. ` +
        `inject=${JSON.stringify(inject)}; ${TOOLS_READY_SERVICE} resolvable=${ready}. ` +
        `cause: ${(error && error.message) || error}`
    )
  }
}
