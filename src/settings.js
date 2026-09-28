/**
 * dsh-skill-curator — 设置定义与读写（dsh 0.1.7 契约）。
 *
 * 0.1.7 起 dsh-settings 的 `installSection()` / `settingsNamespace()` 通道已移除：
 *   - 命名空间 = cordis 行的 id（本插件即 'skill-curator'，patch 行 id 不可改名）；
 *   - Config schema 必须从插件模块导出（宿主按 entry.fiber.runtime.Config 枚举设置视图）；
 *   - 只有 `.volatile()` 字段能在插件页热编辑（_commitVolatile 原地写活引用，不重启 fiber），
 *     非 volatile 字段的改动会走整条 fiber 重启链。
 *
 * apply 收到的 config 里，volatile 字段是 `{get()}` 活引用（cosmokit createVolatile），
 * 普通字段是裸值——统一经 readField() 解引用，两种形状都兼容。
 */
import z from '@deepseek-ai/schemastery'

/** Settings 命名空间（必须等于 cordis 行 id；浏览器卡片与 host 共用同一字符串）。 */
export const NS = 'skill-curator'

/** 解引用配置字段：volatile 活引用 .get()，普通值原样返回。 */
export function readField(value) {
  if (value !== null && typeof value === 'object' && typeof value.get === 'function' && !Array.isArray(value)) {
    return value.get()
  }
  return value
}

/** 设置命名空间的字段模式（也是插件页渲染/校验的依据）。全部字段 volatile：热改即生效。 */
export const Config = z.object({
  /** 自动后台评审总开关。 */
  enabled: z.boolean().default(true).volatile(),
  /** 多少轮真实对话触发一次评审（默认 3）。 */
  skillNudgeInterval: z.number().step(1).min(1).max(100).default(3).volatile(),
  /** 会话历史摘要保留的最近消息条数（全文），更早的逐轮压缩。 */
  digestTail: z.number().step(1).min(1).max(100).default(24).volatile(),
  /** 注入评审子代理的摘要文本字符上限。 */
  digestMaxChars: z.number().step(1).min(2000).max(200000).default(30000).volatile(),
  /** 评审子代理运行超时（毫秒）。 */
  reviewTimeoutMs: z.number().step(1).min(30000).max(3600000).default(900000).volatile(),
  /** 评审最终尝试因端点/模型层瞬断失败后的额外重试次数（0=不重试）。 */
  reviewRetryCount: z.number().step(1).min(0).max(5).default(1).volatile(),
  /** 重试退避基数（毫秒），第 n 次重试延迟 = 基数 × n。 */
  reviewRetryDelayMs: z.number().step(1).min(0).max(60000).default(5000).volatile(),
  /** 评审模型覆盖 provider；空 = 跟随父会话当前模型（自定义端点时作路由名）。 */
  reviewProvider: z.string().default('').volatile(),
  /** 评审模型覆盖 model；空 = 跟随父会话当前模型。 */
  reviewModel: z.string().default('').volatile(),
  /** 评审子代理自定义端点 base_url（OpenAI 兼容 /chat/completions）；空 = 不启用自定义端点。 */
  reviewBaseUrl: z.string().default('').volatile(),
  /** 评审子代理自定义端点 api key（仅 reviewBaseUrl 非空时生效）。 */
  reviewApiKey: z.string().default('').volatile(),
  /** 保护名单：这些 skill 只读，评审绝不改动（默认空 = 库内全部可改）。 */
  excludedSkills: z.array(z.string()).default([]).volatile(),
  /** 通知模式：off=静默 / on=宿主日志摘要 / verbose=日志含内容预览。 */
  notifyMode: z.union(['off', 'on', 'verbose']).default('on').volatile()
})

/**
 * 手工合并 schema 默认值（只补 **缺失** 的键）。
 *
 * 为什么需要：宿主只把「用户显式写过的键」注入 apply 的 config；.volatile() 包出来的
 * 活引用也只存在于这些键上。缺省键（用户没碰过的开关/数值）**不会**出现在 config 里，
 * 直接展开会让 enabled 变成 undefined → 自动评审被静默关掉。
 * 这里用 schema 自身的默认值补齐，不复制 volatile 引用（缺失键没有引用可复制）。
 *
 * @param {object} raw - apply 收到的 config。
 * @param {object} schema - schemastery Config。
 * @returns {object} 补全后的读取结果（值已解引用）。
 */
export function mergeDefaults(raw, schema = Config) {
  const out = {}
  for (const [key, child] of Object.entries(schema.dict || {})) {
    const fallback = child && child.meta ? child.meta.default : undefined
    out[key] = fallback === undefined ? undefined : structuredClone(fallback)
  }
  for (const [key, value] of Object.entries(raw || {})) out[key] = readField(value)
  return out
}

/**
 * 创建设置访问器。
 *
 * @param {object} ctx - cordis 上下文。
 * @param {object} config - apply 收到的 config（volatile 字段为活引用）。
 * @returns {{ spec: () => object, base: () => object }}
 *   spec() 返回当前生效设置（已解引用、已补默认值）；base() 返回原始 config。
 */
export function createSettings(ctx, config = {}) {
  // 注册 {auto:false} 展示策略：关掉宿主按 schema 自动生成的默认页，
  // 设置卡由 client 半注册进插件页 plugins.item 槽位。
  ctx.inject(['settings'], (sctx) => {
    sctx.effect(() => sctx.settings.configure({ auto: false }, ctx.fiber))
  })
  return {
    // spec()：热路径唯一入口——合并 schema 默认值 + 解引用 volatile 活引用。
    // 任何消费点（工具、触发判定、状态面板）都必须用它；用 base() 会把 {get()} 对象
    // 当成普通值读走（如 excludedSkills 的 Array.isArray 判 false → 保护名单静默失效）。
    spec: () => mergeDefaults(config, Config),
    base: () => config
  }
}
