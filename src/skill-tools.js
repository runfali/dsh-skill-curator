/**
 * dsh-skill-curator — 技能库读写工具组（skill-library-*）。
 *
 * 评审子代理的全部读写能力都收敛在这组工具里（配合 subagents toolFilter 白名单，
 * 子代理看不到其他任何工具）。目标是让评审**自主增删改任意 skill**，同时用机制
 * （而不是叮嘱）挡住最危险的动作：
 *
 *   1. 先读后改：skill-library-read 返回 SKILL.md 的 sha256；patch / write-file /
 *      delete 必须回传 expectedSha256，对不上直接拒绝（防凭印象重写别人的 skill）。
 *   2. 写前备份：任何写入/删除前，原 SKILL.md（删除时整个技能目录）先复制到
 *      <DSH_HOME>/skill-curator/backups/，保留最近 30 份，可手工回滚。
 *   3. 保护名单：settings.excludedSkills 里的 skill 只读（默认空 = 全库可改）。
 *   4. 通俗不堆砌：写入后按正文行数给提醒——超 150 行建议下沉 references/，
 *      只留一行指针（提醒不拦截，判断权在评审）。
 *
 * 技能根（对齐 dsh-skill-filesystem rank 表）：可写根 = <DSH_HOME>/skills，
 * 可被 patch 行 config.skillsRoot 覆盖。
 */
import { createHash } from 'node:crypto'
import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
import { homedir } from 'node:os'
import { defineTool } from '@deepseek-ai/dsh-tools'

/** 插件盖章身份（frontmatter author，仅作来源标记）。 */
export const CURATOR_AUTHOR = 'dsh-skill-curator'

/** skill 名合法格式（对齐 dsh skill id 规则）。 */
export const SKILL_ID = /^[a-z0-9][a-z0-9-]*$/

/** 白名单工具全名（子代理 toolFilter allow 用）。 */
export const TOOL_NAMES = [
  'skill-library-list',
  'skill-library-read',
  'skill-library-create',
  'skill-library-patch',
  'skill-library-write-file',
  'skill-library-delete',
  'skill-library-adopt'
]

/** 支持文件允许的目录前缀（统一正斜杠比较）。 */
export const SUPPORT_DIRS = ['references/', 'templates/', 'scripts/']

/** 正文体量提醒阈值（行）。 */
export const BODY_SOFT_LINES = 150
export const BODY_HARD_LINES = 250

/** 备份保留份数上限。 */
export const BACKUP_KEEP = 30

export const TOOL_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true },
    error: { type: 'string' },
    data: { type: 'json' }
  }
}

// ---------------------------------------------------------------------------
// 路径与 frontmatter
// ---------------------------------------------------------------------------

/** 可写技能根目录。 */
export function skillsRoot(config = {}) {
  if (config.skillsRoot) return config.skillsRoot
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'skills')
}

/** 备份根目录（每次写入前的原件快照落这里）。 */
export function backupRoot(config = {}) {
  if (config.backupRoot) return config.backupRoot
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'skill-curator', 'backups')
}

/**
 * 轻量 frontmatter 标量解析：只取 name/description/author/version 等
 * 单行标量键 + 行内数组（tags）；多行块（| >）保守返回空。
 * @returns {{ fm: object, body: string, hasFrontmatter: boolean }}
 */
export function parseSkillMd(raw) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw)
  if (!m) return { fm: {}, body: raw, hasFrontmatter: false }
  const fm = {}
  for (const line of m[1].split('\n')) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
    if (!kv) continue
    const [, key, rawValue] = kv
    const value = rawValue.trim()
    if (value === '' || value === '>' || value === '|') continue // 多行块跳过
    if (/^\[.*\]$/.test(value)) {
      fm[key] = value
        .slice(1, -1)
        .split(',')
        .map((s) => s.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean)
    } else if (/^["'].*["']$/.test(value)) {
      fm[key] = value.slice(1, -1)
    } else {
      fm[key] = value
    }
  }
  return { fm, body: raw.slice(m[0].length), hasFrontmatter: true }
}

/** 序列化 frontmatter（标量 + 行内数组）。 */
export function renderFrontmatter(fm) {
  const lines = []
  for (const [key, value] of Object.entries(fm)) {
    if (Array.isArray(value)) {
      lines.push(`${key}: [${value.map((v) => JSON.stringify(String(v))).join(', ')}]`)
    } else if (typeof value === 'boolean') {
      lines.push(`${key}: ${value}`)
    } else {
      lines.push(`${key}: ${JSON.stringify(String(value))}`)
    }
  }
  return `---\n${lines.join('\n')}\n---\n`
}

/** 是否为插件创建的 skill（frontmatter 盖章，仅作来源标记，不再决定可写性）。 */
export function isCuratorManaged(fm) {
  return Boolean(fm && (fm.author === CURATOR_AUTHOR || fm['x-curator'] === 'managed'))
}

/** 目录 bundle 绝对路径：<root>/<name>/SKILL.md。 */
function skillPath(root, name) {
  return join(root, name, 'SKILL.md')
}

/** 越界校验：resolved 必须落在 root 内。 */
export function assertInside(root, resolved) {
  const rel = relative(root, resolved)
  if (rel === '' || rel.startsWith('..') || rel.includes(`..${sep}`) || rel.includes(`${sep}..`)) {
    throw new Error(`path escapes skills root: ${resolved}`)
  }
}

/** 内容 sha256（先读后改的凭据）。 */
export function hashOf(text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex')
}

/** 相对路径归一化为正斜杠（跨平台前缀判断用）。 */
export function normalizeRel(input) {
  return String(input || '').replace(/\\/g, '/').replace(/^\.\//, '')
}

/**
 * 写入守卫：返回拒绝原因，null = 放行。
 * 默认全库可改，只挡两类：保护名单成员、没有 frontmatter 的文件。
 * @param {string} name - skill 名。
 * @param {object} opts
 * @param {boolean} [opts.hasFrontmatter=true] - 该 SKILL.md 是否带 frontmatter。
 * @param {string[]} [opts.excluded=[]] - 保护名单（settings.excludedSkills）。
 */
export function writeGuard(name, { hasFrontmatter = true, excluded = [] } = {}) {
  if (Array.isArray(excluded) && excluded.includes(name)) {
    return `skill '${name}' 在 excludedSkills 保护名单里，本次评审不得改动。`
  }
  if (!hasFrontmatter) {
    return `skill '${name}' 没有 frontmatter，无法安全改写；如需接管请用 skill-library-create 重建。`
  }
  return null
}

// ---------------------------------------------------------------------------
// 读取
// ---------------------------------------------------------------------------

/** 列出一个根下的全部 bundle skill（<name>/SKILL.md）。 */
export async function listSkills(root, excluded = []) {
  const out = []
  let entries = []
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return out // 根不存在 → 空表
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (!SKILL_ID.test(entry.name)) continue
    const md = skillPath(root, entry.name)
    let raw
    try {
      raw = await readFile(md, 'utf8')
    } catch {
      continue // 目录无 SKILL.md → provider 不递归发现，跳过
    }
    const { fm, body, hasFrontmatter } = parseSkillMd(raw)
    out.push({
      name: entry.name,
      description: typeof fm.description === 'string' ? fm.description : '',
      managed: isCuratorManaged(fm),
      hasFrontmatter,
      lines: raw.split('\n').length,
      bodyLines: body.trim() ? body.trim().split('\n').length : 0,
      protected: excluded.includes(entry.name)
    })
  }
  out.sort((a, b) => a.name.localeCompare(b.name))
  return out
}

/** 读 SKILL.md 全文 + sha256。 */
export async function readSkill(root, name) {
  if (!SKILL_ID.test(name)) throw new Error(`invalid skill name: ${name}`)
  const path = skillPath(root, name)
  const raw = await readFile(path, 'utf8')
  return {
    name,
    path,
    sha256: hashOf(raw),
    lines: raw.split('\n').length,
    bytes: Buffer.byteLength(raw, 'utf8'),
    content: raw
  }
}

// ---------------------------------------------------------------------------
// 写入（原子：tmp + rename）
// ---------------------------------------------------------------------------

async function atomicWrite(path, content) {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.curator-tmp-${process.pid}-${Date.now()}`
  await writeFile(tmp, content, { mode: 0o600 })
  await rename(tmp, path)
}

/**
 * 时间戳（备份条目名用）：20260928-161234-567（到毫秒）。
 *
 * 为什么要毫秒：一次评审里同一 skill 可能连着 patch + write-file，秒级时间戳
 * 会让两份备份**同名互相覆盖**；同一秒内的条目排序也会退化成按 label 排，
 * 裁剪「最旧」时可能删错那一份。
 */
function stamp() {
  const d = new Date()
  const p = (n, w = 2) => String(n).padStart(w, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${p(d.getMilliseconds(), 3)}`
}

/** 备份条目命名：<YYYYMMDD-HHmmss>-<label>，既覆盖 .md 也覆盖 .d 目录。 */
const STAMPED = /^\d{8}-\d{6}-\d{3}-/

/** 备份保留最近 BACKUP_KEEP 份（按时间戳前缀排序，删最旧；文件与目录一视同仁）。 */
async function pruneBackups(dir) {
  try {
    const names = (await readdir(dir)).filter((n) => STAMPED.test(n)).sort()
    for (const name of names.slice(0, Math.max(0, names.length - BACKUP_KEEP))) {
      await rm(join(dir, name), { recursive: true, force: true })
    }
  } catch {
    // 清理失败不影响主流程
  }
}

/**
 * 备份一个文件到备份根（先读后改之外的第二道保险）。
 * @returns {Promise<string|null>} 备份文件路径；源文件不存在时返回 null。
 */
export async function backupFile(file, { backupDir, label = 'snapshot' } = {}) {
  let raw
  try {
    raw = await readFile(file, 'utf8')
  } catch {
    return null
  }
  const dir = backupDir || backupRoot()
  await mkdir(dir, { recursive: true })
  // 后缀必须是 .md：pruneBackups 按 .md 过滤，丢了后缀 = 备份永不清理（无限增长）。
  const target = join(dir, `${stamp()}-${normalizeRel(label).replace(/\//g, '-')}.md`)
  await writeFile(target, raw, { mode: 0o600 })
  await pruneBackups(dir)
  return target
}

/**
 * 备份**整个技能目录**（删除专用）。删除会连带 references/ templates/ scripts/ 一起消失，
 * 只备份 SKILL.md 不够——那会让「可回滚」变成半真半假。
 * @returns {Promise<string>} 备份目录路径（<stamp>-<label>.d）。
 */
export async function backupDirTree(skillDir, { backupDir, label = 'snapshot' } = {}) {
  const dest = backupDir || backupRoot()
  await mkdir(dest, { recursive: true })
  const target = join(dest, `${stamp()}-${normalizeRel(label).replace(/\//g, '-')}.d`)
  await rm(target, { recursive: true, force: true })
  await cp(skillDir, target, { recursive: true })
  await pruneBackups(dest)
  return target
}

/** 正文体量提醒（不拦截）：鼓励把细节下沉 references/，只留一行指针。 */
export function shapeWarnings(name, bodyLines) {
  if (bodyLines > BODY_HARD_LINES) {
    return [`'${name}' 正文 ${bodyLines} 行，偏臃肿：把细节（实录/长清单/历史）搬到 references/<topic>.md，正文只留一行指针。`]
  }
  if (bodyLines > BODY_SOFT_LINES) {
    return [`'${name}' 正文 ${bodyLines} 行，建议检查能否精简或下沉 references/。`]
  }
  return []
}

/**
 * 归一化技能正文：content 自带 frontmatter 时取并强制盖章，否则生成。
 * @returns {{ md: string, fm: object }}
 */
export function normalizeSkillMd(name, description, content, extra = {}) {
  const { fm, body, hasFrontmatter } = parseSkillMd(content || '')
  const merged = { ...fm, name, description, ...extra }
  merged.author = CURATOR_AUTHOR
  merged.version = typeof merged.version === 'string' ? merged.version : '0.1.0'
  const md = renderFrontmatter(merged) + (hasFrontmatter ? body.trimStart() : (content || '').trimStart())
  return { md, fm: merged }
}

/** 先读后改校验：expectedSha256 必须等于当前文件 hash。 */
export function assertFresh(name, raw, expectedSha256) {
  const current = hashOf(raw)
  const expected = String(expectedSha256 || '').trim()
  if (!expected) {
    throw new Error(`请先用 skill-library-read 读 '${name}'，再把返回的 sha256 作为 expectedSha256 传进来（本次写入被拒：未先读）。`)
  }
  if (expected !== current) {
    throw new Error(`'${name}' 的 SKILL.md 在你读取之后变了（期望 ${expected.slice(0, 12)}…，当前 ${current.slice(0, 12)}…）；重新 skill-library-read 后再改。`)
  }
  return current
}

// ---------------------------------------------------------------------------
// 工具定义
// ---------------------------------------------------------------------------

/** 构造全部工具定义（注册进 tools 服务）。 */
export function createSkillToolDefinitions(getConfig) {
  const cfg = () => getConfig() || {}
  const rootOf = () => skillsRoot(cfg())
  const backupDirOf = () => backupRoot(cfg())
  const excludedOf = () => (Array.isArray(cfg().excludedSkills) ? cfg().excludedSkills.map(String) : [])

  const ok = (data) => ({ ok: true, data })
  const fail = (error) => ({ ok: false, error: String(error && error.message || error) })

  const tool = (name, description, parameters, execute) =>
    defineTool({
      name,
      description,
      parameters,
      output: {
        schema: TOOL_OUTPUT_SCHEMA,
        render: (_args, value) => [
          {
            type: 'text',
            text: !value || value.ok !== true
              ? `Error: ${(value && value.error) || 'unknown error'}`
              : (typeof value.data === 'string' ? value.data : JSON.stringify(value.data, null, 2))
          }
        ]
      },
      isConcurrencySafe: () => true,
      async execute(args) {
        try {
          return await execute(args)
        } catch (error) {
          return fail(error)
        }
      }
    })

  /**
   * 读写前置：读全文 → 守卫 → 先读后改校验。
   * 备份刻意不在这里做——delete 要备份**整个目录**而不是单个 SKILL.md，
   * 由各调用点选对应策略（backupFile / backupDirTree）。
   * @param {string} name - skill 名。
   * @param {string} expectedSha256 - skill-library-read 返回的 sha256。
   * @param {object} [opts]
   * @param {boolean} [opts.requireFrontmatter=true] - false 时允许无 frontmatter 的目录
   *   （删除垃圾 skill 目录时需要；改写仍必须带 frontmatter）。
   */
  async function prepareWrite(name, expectedSha256, { requireFrontmatter = true } = {}) {
    const root = rootOf()
    const md = skillPath(root, name)
    let raw
    try {
      raw = await readFile(md, 'utf8')
    } catch {
      throw new Error(`skill '${name}' not found`)
    }
    const { hasFrontmatter } = parseSkillMd(raw)
    const denied = writeGuard(name, {
      hasFrontmatter: requireFrontmatter ? hasFrontmatter : true,
      excluded: excludedOf()
    })
    if (denied) throw new Error(denied)
    assertFresh(name, raw, expectedSha256)
    return { root, md, raw }
  }

  /** patch / write-file 的前置 + 单文件备份。 */
  async function prepareFileWrite(name, expectedSha256, label) {
    const ctx = await prepareWrite(name, expectedSha256)
    const backup = await backupFile(ctx.md, { backupDir: backupDirOf(), label: `${name}-${label}` })
    return { ...ctx, backup }
  }

  return [
    tool(
      'skill-library-list',
      'List every skill in the user skill library with body line counts (spot bloat) and whether it is protected. ' +
        'Use this BEFORE deciding whether to update an existing skill, merge two skills, or create a new one.',
      {},
      async () => ok({ root: rootOf(), excluded: excludedOf(), skills: await listSkills(rootOf(), excludedOf()) })
    ),
    tool(
      'skill-library-read',
      'Read the full SKILL.md of one skill (frontmatter + body) together with its sha256. ' +
        'The writing tools refuse to run unless you pass back the sha256 you just read — always read before you edit.',
      {
        name: { type: 'string', required: true, description: 'Exact skill name (kebab-case).' }
      },
      async (args) => ok(await readSkill(rootOf(), String(args.name)))
    ),
    tool(
      'skill-library-create',
      'Create a NEW class-level umbrella skill (name must be kebab-case and class-level, NOT a PR number, ' +
        'error string, library-alone name, or one-session artifact). Body in Chinese, plain and practical; ' +
        'description bilingual (English first). Frontmatter is generated automatically.',
      {
        name: { type: 'string', required: true, description: 'Class-level kebab-case skill name.' },
        description: { type: 'string', required: true, description: 'Bilingual description (English preferred for model discovery, Chinese allowed).' },
        content: { type: 'string', required: true, description: 'SKILL.md body in Chinese.' }
      },
      async (args) => {
        const root = rootOf()
        const name = String(args.name)
        if (!SKILL_ID.test(name)) throw new Error(`invalid skill name (must match ${SKILL_ID}): ${name}`)
        if (excludedOf().includes(name)) throw new Error(`skill '${name}' 在 excludedSkills 保护名单里，禁止重建。`)
        const target = skillPath(root, name)
        const existing = await stat(target).then(() => true, () => false)
        if (existing) throw new Error(`skill '${name}' already exists — read + patch it instead of creating`)
        const { md } = normalizeSkillMd(name, String(args.description || ''), String(args.content || ''))
        await atomicWrite(target, md)
        const bodyLines = (parseSkillMd(md).body.trim() || '').split('\n').length
        return ok({ created: name, path: target, sha256: hashOf(md), lines: md.split('\n').length, warnings: shapeWarnings(name, bodyLines) })
      }
    ),
    tool(
      'skill-library-patch',
      'Edit an EXISTING skill (any skill in the library except protected ones). Pass expectedSha256 from ' +
        'skill-library-read plus either oldString+newString for a targeted edit, or content to replace the whole ' +
        'body while preserving frontmatter. The original is backed up first. Prefer targeted edits; when rewriting, ' +
        'keep it plain and drop anything that does not earn its line.',
      {
        name: { type: 'string', required: true, description: 'Exact existing skill name.' },
        expectedSha256: { type: 'string', required: true, description: 'sha256 returned by skill-library-read.' },
        oldString: { type: 'string', description: 'Literal text to replace; must appear exactly once.' },
        newString: { type: 'string', description: 'Replacement text.' },
        content: { type: 'string', description: 'Whole-body replacement (frontmatter preserved).' }
      },
      async (args) => {
        const name = String(args.name)
        const { md, raw, backup } = await prepareFileWrite(name, args.expectedSha256, 'patch')
        const { fm } = parseSkillMd(raw)
        let next
        if (typeof args.content === 'string') {
          next = renderFrontmatter(fm) + args.content.trimStart()
        } else {
          if (typeof args.oldString !== 'string' || typeof args.newString !== 'string') {
            throw new Error('skill-library-patch requires oldString+newString (targeted) or content (whole-body)')
          }
          const oldText = args.oldString
          const count = raw.split(oldText).length - 1
          if (count !== 1) {
            throw new Error(`oldString appears ${count} times in SKILL.md; expected exactly 1 — re-read the file and choose a unique anchor`)
          }
          next = raw.replace(oldText, args.newString)
        }
        await atomicWrite(md, next)
        const bodyLines = (parseSkillMd(next).body.trim() || '').split('\n').length
        return ok({
          patched: name,
          path: md,
          sha256: hashOf(next),
          lines: next.split('\n').length,
          backup,
          warnings: shapeWarnings(name, bodyLines)
        })
      }
    ),
    tool(
      'skill-library-write-file',
      'Write a support file under an existing skill: references/<topic>.md (session detail, evidence, long lists), ' +
        'templates/<name>.<ext> (starter files to copy), or scripts/<name>.<ext> (re-runnable actions). ' +
        'This is where bulky detail belongs so SKILL.md stays short — then add a one-line pointer in SKILL.md with ' +
        'skill-library-patch. Needs expectedSha256 from skill-library-read first.',
      {
        name: { type: 'string', required: true, description: 'Exact owning skill name.' },
        filePath: { type: 'string', required: true, description: "Relative path under the skill dir, e.g. 'references/deploy-notes.md'." },
        content: { type: 'string', required: true, description: 'File content (Chinese preferred).' },
        expectedSha256: { type: 'string', required: true, description: 'sha256 of SKILL.md returned by skill-library-read.' }
      },
      async (args) => {
        const name = String(args.name)
        const rel = normalizeRel(args.filePath)
        if (!SUPPORT_DIRS.some((prefix) => rel.startsWith(prefix))) {
          throw new Error(`filePath must start with one of: ${SUPPORT_DIRS.join(', ')}`)
        }
        const { root, backup } = await prepareFileWrite(name, args.expectedSha256, 'support')
        const target = join(root, name, ...rel.split('/'))
        assertInside(join(root, name), target)
        await atomicWrite(target, String(args.content || ''))
        return ok({ wrote: `${name}/${rel}`, path: target, backup, hint: '记得用 skill-library-patch 在 SKILL.md 加一行指针。' })
      }
    ),
    tool(
      'skill-library-delete',
      'Delete a skill that is redundant or has been merged away (protected ones are refused). The whole skill ' +
        'directory is backed up under <DSH_HOME>/skill-curator/backups before removal, so a wrong deletion is ' +
        'recoverable. Pass the reason: it is recorded in the backup name.',
      {
        name: { type: 'string', required: true, description: 'Exact skill name to delete.' },
        expectedSha256: { type: 'string', required: true, description: 'sha256 of its SKILL.md returned by skill-library-read.' },
        reason: { type: 'string', description: 'Short reason, e.g. merged into dsh-plugin-development.' }
      },
      async (args) => {
        const name = String(args.name)
        const reason = String(args.reason || 'redundant').replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 60) || 'redundant'
        // 删除允许无 frontmatter 的目录（垃圾目录不该因为「不合法」而删不掉）
        const { root, raw } = await prepareWrite(name, args.expectedSha256, { requireFrontmatter: false })
        const dir = join(root, name)
        assertInside(root, dir)
        // 整个技能目录先落备份：references/ templates/ scripts/ 一并保住，删除才真可回滚
        const backup = await backupDirTree(dir, { backupDir: backupDirOf(), label: `${name}-deleted-${reason}` })
        await rm(dir, { recursive: true, force: true })
        return ok({ deleted: name, backup, bytes: Buffer.byteLength(raw, 'utf8'), root })
      }
    ),
    tool(
      'skill-library-adopt',
      'Stamp an externally authored skill with frontmatter author so its provenance is visible. ' +
        'Editing no longer requires adoption, so use this only when explicitly asked.',
      {
        name: { type: 'string', required: true, description: 'Exact existing skill name.' }
      },
      async (args) => {
        const root = rootOf()
        const name = String(args.name)
        const target = skillPath(root, name)
        let raw
        try {
          raw = await readFile(target, 'utf8')
        } catch {
          throw new Error(`skill '${name}' not found`)
        }
        const { fm, body, hasFrontmatter } = parseSkillMd(raw)
        if (!hasFrontmatter || !fm.name) {
          throw new Error(`skill '${name}' has no frontmatter — cannot adopt; re-create it via skill-library-create instead`)
        }
        const backup = await backupFile(target, { backupDir: backupDirOf(), label: `${name}-adopt` })
        const next = renderFrontmatter({ ...fm, author: CURATOR_AUTHOR }) + body
        await atomicWrite(target, next)
        return ok({ adopted: name, path: target, sha256: hashOf(next), backup })
      }
    )
  ]
}
