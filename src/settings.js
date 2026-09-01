/**
 * dsh-skill-curator — 设置定义与读写。
 *
 * 命名空间 `skill-curator` 与浏览器端卡片共享；设置改动即时生效
 * （applies=live，各消费点每 tick 读 current()）。
 */
import z from '@deepseek-ai/schemastery'
/** Settings 命名空间（浏览器卡片与 host 共用同一字符串）。
 * dsh 0.1.2-alpha 起 settingsNamespace() brand 辅助已从 dsh-settings 移除；
 * 命名空间改为在 settings.register/installSection 处校验（小写连字符标识符）。 */
export const NS = 'skill-curator'

/** 设置命名空间的字段模式（也是 Settings 页面渲染/校验的依据）。 */
export const Config = z.object({
  /** 自动后台评审总开关。 */
  enabled: z.boolean().default(true),
  /** 多少轮真实对话触发一次评审（发哥拍板：默认 3）。 */
  skillNudgeInterval: z.number().step(1).min(1).max(100).default(3),
  /** 会话历史摘要保留的最近消息条数（全文），更早的逐轮压缩。 */
  digestTail: z.number().step(1).min(1).max(100).default(24),
  /** 注入评审子代理的摘要文本字符上限。 */
  digestMaxChars: z.number().step(1).min(2000).max(200000).default(30000),
  /** 评审子代理运行超时（毫秒）。 */
  reviewTimeoutMs: z.number().step(1).min(30000).max(3600000).default(900000),
  /** 评审最终尝试因端点/模型层瞬断失败后的额外重试次数（0=不重试）。 */
  reviewRetryCount: z.number().step(1).min(0).max(5).default(1),
  /** 重试退避基数（毫秒），第 n 次重试延迟 = 基数 × n。 */
  reviewRetryDelayMs: z.number().step(1).min(0).max(60000).default(5000),
  /** 评审模型覆盖 provider；空 = 跟随父会话当前模型（自定义端点时作路由名）。 */
  reviewProvider: z.string().default(''),
  /** 评审模型覆盖 model；空 = 跟随父会话当前模型。 */
  reviewModel: z.string().default(''),
  /** 评审子代理自定义端点 base_url（OpenAI 兼容 /chat/completions）；空 = 不启用自定义端点。 */
  reviewBaseUrl: z.string().default(''),
  /** 评审子代理自定义端点 api key（仅 reviewBaseUrl 非空时生效）。 */
  reviewApiKey: z.string().default(''),
  /** 用户显式收养（允许插件更新）的 skill 名清单。 */
  adoptSkills: z.array(z.string()).default([]),
  /** 通知模式：off=静默 / on=宿主日志摘要 / verbose=日志含内容预览。 */
  notifyMode: z.union(['off', 'on', 'verbose']).default('on')
})

/**
 * 创建设置访问器。
 *
 * @param {object} ctx - cordis 上下文。
 * @param {object} config - composition 层配置（patch 行的 config）。
 * @returns {{ spec: () => object, base: () => object }}
 *   spec() 返回当前生效 schema 设置（含 base 合并）；base() 返回原始 patch config
 *   （含 schema 外的字段，如 skillsRoot）。
 */
export function createSettings(ctx, config = {}) {
  let current = () => config
  // dsh 0.1.2-alpha：独立 installSettingsSection 帮助函数已从 dsh-settings 移除，
  // 同样的接线改为 provider 上的 settings.installSection(owner, ns, schema, entry, hooks)
  // （源码级核对：register(base=entry) → setSource(scope.get) → 卸载回落 effect →
  // onChange() 同步首发 → scope.watch 持续通知）。
  // hooks 在 inject 回调内执行——此处 onChange 为空操作、setSource 只赋值上方
  // 已声明的 current，无 TDZ 风险，故保持原位置。
  ctx.inject(['settings'], (sctx) => {
    sctx.settings.installSection(ctx, NS, Config, config, {
      setSource: (source) => {
        current = source
      },
      onChange: () => {
        // 各消费点每 tick 读取 current()，无需主动刷新
      }
    })
  })
  return {
    spec: () => ({ ...current() }),
    base: () => config
  }
}