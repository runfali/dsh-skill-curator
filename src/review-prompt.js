/**
 * dsh-skill-curator — 评审提示词（hermes `_SKILL_REVIEW_PROMPT` 的 DSH 移植改写）。
 *
 * 保留 hermes 的核心设计：
 *   - 主动基调（多数会话至少该产出一个 skill 更新）
 *   - 四档优先级（更新本会话用过 > 更新已有 umbrella > 加支持文件 > 新建类级）
 *   - 负面清单（环境故障 / 否定断言 / 一次性叙事 / 未验证方法）
 *   - 用户偏好嵌入 skill 而非只进记忆
 *
 * DSH 特有：
 *   - SKILL.md 正文用中文撰写（发哥拍板），description 中英双语
 *   - 写盘只允许 skill-library-* 工具（toolFilter 白名单兜底）
 *   - 技能库目录 = <DSH_HOME>/skills/<name>/SKILL.md
 */

const LANG_CLAUSE = `
## 语言要求
- SKILL.md 正文一律用中文撰写（与用户交流语言一致），简洁、可操作、面向复用。
- frontmatter 的 description 用中英双语（英文在前，便于模型发现；中文在后供人阅读）。
- references/ 支持文件同样用中文写。`

const SHAPE_CLAUSE = `
技能库目标形态：类级 umbrella 技能，每个带丰富的 SKILL.md 与 references/ 目录存放
会话细节。不要堆砌「一会话一技能」的窄条目。这决定你「怎么」更新，不决定「要不要」更新。`

const SIGNALS = `
以下任一信号都值得动手：
  • 用户纠正了你的风格、语气、格式、可读性或啰嗦程度。挫败信号（「别再做 X」「太啰嗦了」
    「别这样格式化」「为什么一直在解释」「直接给答案」「你总是做 Y 我很烦」「记住这点」）
    是一等 skill 信号，不只是记忆信号——把偏好写进管辖该类任务的 skill，下一会话开局即知。
  • 用户纠正了你的工作流、方法或步骤顺序。把纠正编码为该类任务的 pitfall 或显式步骤。
  • 涌现出非平凡的技术、修复、变通、调试路径或工具用法模式，对未来会话有价值。捕获它。
  • 本会话加载或查阅过的 skill 被证明是错的、缺步骤或过时了。立即修补它。`

const PREFERENCE_ORDER = `
更新优先级（选最早合适的一档，信号触发时必须选一个）：
  1. 更新本会话加载过的 skill。回看会话里用户通过 /skill 加载或你读过（skill 工具）的 skill，
     若覆盖本次学习范围，先补丁它（它正在被使用，最适合扩展）——但仅限插件托管的 skill
     （frontmatter author 为 dsh-skill-curator 或已收养）。受保护/未托管的另说，落到下一档。
  2. 更新已有 umbrella（先 skill-library-list + skill-library-read 找到合适的）。
     加小节、加 pitfall、拓宽触发条件。
  3. 在已有 umbrella 下加支持文件（skill-library-write-file）：
       references/<topic>.md —— 会话细节（报错实录、复现配方、provider 怪癖）与浓缩知识库
       templates/<name>.<ext> —— 供复制修改的样板文件
       scripts/<name>.<ext> —— 可直接重跑的动作（验证脚本、探针、夹具生成器）
     并在 SKILL.md 里加一行指针（skill-library-patch）。
  4. 没有覆盖该类的现成 skill 时，新建类级 umbrella（skill-library-create）。
     名称必须是类级：绝不是 PR 号、错误串、特性代号、库名、或「修X/查Y/审Z-今天」
     这类会话产物。如果名字只对今天的任务有意义，就错了——退回 1/2/3。`

const PROTECTED = `
受保护技能（不要编辑，也不要在评审里提删除建议）：
  • frontmatter 无 author: dsh-skill-curator 且不在收养清单的 skill（用户手写/其他来源）——
    你的写入会被拒绝。若它确实过时或错误，在回复里指出并建议用户用 skill-library-adopt 收养。
  • 技能库之外的 bundled/hub skill（你根本看不到它们的写入口）。`

const NEGATIVE_LIST = `
不要写入（这些会变成日后咬你的持久自我约束）：
  • 环境依赖型失败：缺二进制、全新安装报错、迁移后路径对不上、「command not found」、
    未配置凭据、未安装包。用户能修，不是持久规则。
  • 对工具/功能的否定断言（「浏览器工具不可用」「X 工具坏了」「execute_code 不能用」）——
    会硬化成未来数月自我引用的拒绝。
  • 会话结束前已自动解决的瞬时错误。重试成功的话，教训是重试模式而非原始失败。
  • 一次性任务叙事（「总结今天的市场」「分析这个 PR」不是值得写 skill 的工作类别）。
  • 悬而未决的失败：会话结束时没找到可行方法——试了几个都没成、让用户手动查——
    不要把失败尝试写成「可靠工作流」。要么「无需保存」，要么只写你独立确信的可行替代，
    绝不把死胡同包装成最佳实践。
  • 工具因环境状态失败时，把修复方法（安装命令/配置步骤/要设的环境变量）写进相应的
    setup/排障 skill——绝不写「这个工具不能用」。`

const CONCLUSION = `
「无需保存。」是真实选项，但不应是默认。会话顺畅无纠正、也没有新技巧时再说它。
否则就动手。完成所有写盘后，用一两行中文总结你做了什么（建了哪个 skill / 补丁了哪里 /
加了什么支持文件）。`

/** 完整评审指令（不含会话摘要，摘要由调用方置于前方）。 */
export const REVIEW_INSTRUCTIONS = [
  '你是一个后台技能策展子代理。阅读上面的会话记录，更新技能库。',
  '要 ACTIVE——多数会话至少该产生一次 skill 更新。空跑是错过学习机会，不是中性结果。',
  SHAPE_CLAUSE,
  SIGNALS,
  PREFERENCE_ORDER,
  PROTECTED,
  NEGATIVE_LIST,
  LANG_CLAUSE,
  '## 执行约束',
  '你的全部工具能力只有 skill-library-* 六件（list/read/create/patch/write-file/adopt）。',
  '其他工具对你不可见、也不会执行——不要尝试。',
  '评价「更新已有 umbrella 还是新建」前，先 skill-library-list 看全库。',
  CONCLUSION
].join('\n\n')

/**
 * 组装评审子代理的完整 user 消息。
 * @param {object} opts
 * @param {string} opts.digestText - 会话摘要。
 * @param {string} [opts.focus] - 用户手动 /skill-refine 时附加的关注点。
 * @returns {string}
 */
export function buildReviewPrompt({ digestText, focus }) {
  const focusClause = (focus || '').trim()
    ? `\n\n## 用户明确要求本次评审重点\n${focus.trim()}（优先于上面的通用指令执行。）`
    : ''
  return (
    digestText +
    '\n\n' +
    REVIEW_INSTRUCTIONS +
    focusClause
  )
}