/**
 * dsh-skill-curator — 注册给主会话的运行时技能（工具的用法说明书）。
 *
 * 为什么需要：插件注册了 11 个 skill-library-* 工具，但主会话里**没有任何一行**
 * 说明这组工具该怎么用 —— 模型只能靠工具描述猜。dsh-learn 用
 * `skills.register()` 解决了这一点，本文件是同一形态的采纳。
 *
 * ⚠️ 关键约束（实测）：宿主把技能渲染进会话目录时只取 name + description
 * （dsh-tool-skill/lib/index.js:42-47 `catalogSourceEntries`，description 上限 500 字符），
 * `whenToUse` **不进**模型可见目录。所以「怎么用」必须写进 description，
 * 不能像 dsh-learn 那样只写在 whenToUse 里（那样模型看不到）。
 *
 * rank 说明（方向别写反）：运行时技能 rank=250，用户目录 rank=400
 * （dsh-skill-filesystem:23 `USER_DSH_RANK`）。宿主按 rank **升序**排序、
 * 去重时**第一个胜出**（dsh-skill/lib/index.js:519-521 `compareIndexedCandidates`
 * 返回 `left.rank - right.rank`；:314-325 排序后遍历 `seen` 去重）——
 * 所以 **rank 250 的运行时版压过 rank 400 的用户目录版**。
 * 只有 project 级（`.dsh/skills` rank=100、`.agents/skills` rank=200）能遮蔽它；
 * custom(300)/user-dsh(400)/user-agents(500) 全被运行时版遮蔽，宿主只打一条告警
 * `skill "…" from <source> ignored because a higher-priority skill already exists`。
 * 即：用户手写的同名 `skill-curator` 会被**静默遮蔽**（不报错）。
 */
import { TOOL_NAMES } from './skill-tools.js'

export const CURATOR_SKILL = {
  name: 'skill-curator',
  description:
    'Curate the local DSH skill library with the skill-library-* tools: list/read/tree/create/patch/write-file/' +
    'delete-file/delete/adopt/lifecycle/git. Always read first — every write must echo the sha256 returned by ' +
    'skill-library-read (read-before-write is enforced, not advisory). Prefer patching an existing umbrella over ' +
    'creating a new skill; prefer archiving (skill-library-lifecycle, recoverable) over delete; put long detail in ' +
    'references/ and leave one pointer line in SKILL.md.',
  whenToUse:
    '当你要新建、改写、合并、精简或退役一个技能时；当用户提到「沉淀成技能 / 更新技能库 / 技能库整理 / 这个技能过时了」时。',
  content: [
    '## 用途',
    '',
    'skill-curator 让你直接维护本机技能库（`<DSH_HOME>/skills/<name>/SKILL.md`）：读、写、合并、精简、归档。',
    '',
    '## 工具速览',
    '',
    ...TOOL_NAMES.map((name) => `- \`${name}\``),
    '',
    '## 铁律',
    '',
    '1. **先读后改**：任何 patch / write-file / delete 之前，先用 `skill-library-read` 拿 `sha256`，',
    '   再把它作为 `expectedSha256` 回传。没读过就写会被直接拒绝；读完后文件被别人改过也会被拒绝。',
    '2. **写前自动备份**：每次写入/删除前，原件（删除时整个目录）会备份到 `<DSH_HOME>/skill-curator/backups/`，',
    '   保留最近 30 份。这条保险是让你**敢改**的，不是让你事后补救的。',
    '3. **归档优先于删除**：看起来没用的技能先用 `skill-library-lifecycle` 的 `archive`（可 restore），',
    '   别直接 `skill-library-delete`。',
    '4. **保护名单**：`excludedSkills` 里的技能只读，写入会被拒绝。',
    '',
    '## 形态',
    '',
    '- 类级 umbrella，不是「一会话一技能」：名字必须类级（绝不是 PR 号、错误串、库名或今天才成立的名字）。',
    '- 短正文 + 厚 references/：正文只留「什么时候用 + 怎么做 + 坑 + 边界」，',
    '  实录/长清单/长代码下沉到 `references/<topic>.md`，正文留一行指针。',
    '- 正文一律中文；`description` 中英双语（英文在前，便于模型按描述发现）。',
    '',
    '## 生命周期',
    '',
    '`skill-library-lifecycle` 可查每个技能的状态与最后使用时间（active / stale / archived / pinned）。',
    '「最后使用」按 `skill` 工具真实加载计算，不是文件修改时间。'
  ].join('\n')
}
