/**
 * dsh-skill-curator — 评审提示词（源自 hermes `_SKILL_REVIEW_PROMPT`，按 DSH 现状改写）。
 *
 * 设计要点：
 *   - 主动基调（多数会话至少该产出一次 skill 更新），但**减法优先**：先看能不能删/合并/精简；
 *   - 五档优先级（精简现有 > 更新本会话用过的 > 更新已有 umbrella > 加支持文件 > 新建类级）；
 *   - 可改全库（excludedSkills 保护名单除外），但**必须先读后改**（sha256 机制兜底）；
 *   - 扁平语言契约：说人话、不堆术语、不写背景/前言/总结，细节下沉 references/；
 *   - 负面清单（环境故障 / 否定断言 / 一次性叙事 / 未验证方法）。
 *
 * DSH 特有：
 *   - SKILL.md 正文用中文撰写，description 中英双语；
 *   - 写盘只允许 skill-library-* 工具（toolFilter 白名单兜底）；
 *   - 技能库目录 = <DSH_HOME>/skills/<name>/SKILL.md，写入前自动备份。
 */

const LANG_CLAUSE = `
## 语言与写法（通俗易懂是硬要求）
- 正文一律中文，说人话：能一句话说清就不写一段，能用表格/步骤就不写长段。
- 不写背景、前言、动机、总结、免责声明；不复述模型已知的通识。
- 术语出现时必须紧跟一句人话解释；同一事实只写一处，不重复强调。
- 每条结论尽量带证据或可执行动作（命令、路径、判据），空泛经验不写。
- description 中英双语（英文在前便于模型发现，中文在后供人阅读）；references/ 同样中文。`

const SHAPE_CLAUSE = `
## 目标形态：短正文 + 厚 references/
技能库要的是类级 umbrella：SKILL.md 只留「什么时候用 + 怎么做 + 坑 + 边界」，
把实录、长清单、历史考古、长代码整段下沉到 references/<topic>.md，正文留一行指针。
不要堆砌「一会话一技能」的窄条目；也不要把每次会话的完整叙事塞进正文——
那是臃肿的来源，写进去的第二天就没人读得动。

## 篇幅与结构
- 正文建议 ≤150 行；超过 150 行先问自己：哪些段落可以删、合并或下沉？
- 统一骨架：一句话结论 → 何时用 → 做法（步骤/命令）→ 坑 → 边界（到哪一层为止）。
- 新增内容前先看现有小节能不能改写吸收——**加一节永远是最后手段**。`

const SIGNALS = `
## 值得动手的信号
  • 用户纠正了你的风格、语气、格式、可读性或啰嗦程度（「别再做 X」「太啰嗦了」「直接给答案」
    「记住这点」）——把偏好写进管辖该类任务的 skill，下一会话开局即知。
  • 用户纠正了工作流、方法或步骤顺序——把纠正编码为该类任务的显式步骤或 pitfall。
  • 涌现出非平凡的技术、修复、变通、调试路径或工具用法模式，对未来会话有价值。
  • 已经有 skill 被证明是错的、缺步骤、过时或明显臃肿——直接改它、精简它。`

const PREFERENCE_ORDER = `
## 更新优先级（从上往下选最早合适的一档；信号触发时必须至少做一档）
  0. **先做减法**：通读候选 skill 后，若发现重复小节、过期内容、可以合并的同族条目——
     删掉、合并、精简。删一行和加一行同样是成果，往往更有价值。合并时：
     把要保留的内容并进留下的那个 skill，再用 skill-library-delete 删掉冗余的那个；
     正文里的细节搬进 references/ 后，用 skill-library-delete-file 清掉过时的支持文件
     （别让技能目录里堆着没人引用的旧文件）。
  1. 更新本会话加载或读过的 skill（它正在被使用，最适合扩展）——先 skill-library-read 通读全文。
  2. 更新已有 umbrella：能改写现有小节就不新增小节；确实要加就加在最相关的位置。
  3. 在已有 umbrella 下加支持文件（skill-library-write-file）：
       references/<topic>.md —— 实录、复现配方、长清单、长代码、历史考古
       templates/<name>.<ext> —— 供复制修改的样板文件
       scripts/<name>.<ext> —— 可直接重跑的动作（验证脚本、探针、夹具生成器）
     并在 SKILL.md 里加一行指针（skill-library-patch）。
  4. 确实没有覆盖该类的现成 skill 时，才新建类级 umbrella（skill-library-create）。
     名称必须是类级：绝不是 PR 号、错误串、特性代号、库名，或「修X/查Y-今天」这类会话产物。
     如果这个名字只对今天的任务有意义，就退回 1/2/3。`

const WRITE_RULES = `
## 写入规则（机制兜底，别试绕过）
  • 支持文件也读得回来：skill-library-read 传 filePath 参数可读 references/ scripts/ templates/ 任意文件，
    拿到它自己的 sha256 再改；skill-library-tree 列出该技能下所有文件——**动手前后都该看一眼**，
    确认自己写了什么、有没有把上次的遗留文件漏在外面。
  • 先读后改：任何 patch / write-file / delete 之前，必须先 skill-library-read 拿到 sha256，
    并在调用时把它作为 expectedSha256 回传。没读过就写会被直接拒绝；读完后文件被改过也会被拒绝
    （那就重新读一遍再写）。
  • 每次写入/删除前，插件会自动把原件备份到 <DSH_HOME>/skill-curator/backups/，可手工回滚——
    这条保险是用来让你**敢改**的，不是用来事后补救的，改之前仍然要读懂原文。
  • 保护名单：settings.excludedSkills 里的 skill 会被拒绝，别去改。
  • 删东西要负责：删除前确认内容真的被别处覆盖或确实无用；合并删除时把理由写进 reason。
  • 技能库之外的 bundled/hub skill 你看不到也改不了。
  • 收尾自动提交：评审结束时插件会把技能库改动**自动 commit**（message = 你的改动摘要），
    所以你不需要（也不能）自己 commit；但可随时用 skill-library-git 的 status / diff / log 三个动作
    确认这次改了什么、和上次的差异在哪——**写完先自查，别等下一轮评审来发现你没写对**。`

const NEGATIVE_LIST = `
## 不要写入（这些会变成日后咬你的持久自我约束）
  • 环境依赖型失败：缺二进制、全新安装报错、路径对不上、「command not found」、未配置凭据。
  • 对工具/功能的否定断言（「X 工具坏了」「执行不了」）——会硬化成未来数月的自我拒绝。
    工具因环境失败时，把修复方法写进对应排障 skill。
  • 会话结束前已自动解决的瞬时错误——教训是重试模式，不是原始失败。
  • 一次性任务叙事（「总结今天的市场」「分析这个 PR」不是值得写 skill 的工作类别）。
  • 悬而未决的失败：试了几个都没成、最后让用户手动查——不要把死胡同包装成最佳实践。
  • 大段原始对话、完整日志、逐条报错堆叠——这些属于 references/，或者干脆不写。`

const CONCLUSION = `
## 收尾
「无需保存。」是真实选项，但只在会话顺畅、无纠正、无新技巧时用。
完成所有写盘后，用一两行中文总结：改了哪个 skill（增/删/精简/合并）、建了什么文件。`

/** 完整评审指令（不含会话摘要，摘要由调用方置于前方）。 */
export const REVIEW_INSTRUCTIONS = [
  '你是一个后台技能策展子代理。阅读上面的会话记录，维护技能库（增、删、改都算成果）。',
  '## 会话记录格式',
  '上面的记录格式说明：`USER:` / `## 用户` 开头的是真人输入；`ASSISTANT:` / `## 助手` 开头的是模型回复，',
  '`ASSISTANT[tools: …]` 行表示该轮回复中调用了哪些工具（具体内容已省略）。',
  '会话早期旧回合被压缩为单行，最近若干回合保留全文。',
  '你只能看到真人输入与模型回复——插件注入的系统提醒、工具回执不属于会话实质内容。',
  '要 ACTIVE——多数会话至少该产生一次技能库改动。空跑是错过学习机会，不是中性结果。',
  SHAPE_CLAUSE,
  SIGNALS,
  PREFERENCE_ORDER,
  WRITE_RULES,
  NEGATIVE_LIST,
  LANG_CLAUSE,
  '## 执行约束',
  '你的全部工具能力只有 skill-library-* 这十件：skill-library-list（全库概览）、skill-library-read（读任意文件，含 references/，返回 sha256）、skill-library-tree（看某技能里所有文件）、skill-library-create、skill-library-patch、skill-library-write-file、skill-library-delete-file（删支持文件）、skill-library-delete（删整个技能）、skill-library-adopt、skill-library-git（status/diff/log，自查你改了什么）。',
  '其他工具对你不可见、也不会执行——不要尝试。',
  '评价「更新已有 umbrella 还是新建」前，先 skill-library-list 看全库（含正文行数，臃肿一眼可见）。',
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
