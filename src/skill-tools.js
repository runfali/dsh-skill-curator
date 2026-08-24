/**
 * dsh-skill-curator — 技能库读写工具组（skill-library-*）。
 *
 * 评审子代理的全部写盘能力都收敛在这组工具里（配合 subagents toolFilter
 * 白名单，子代理看不到其他任何工具）。设计对齐 hermes 的 curator 产权模型：
 *
 *   - 插件创建的 skill 在 frontmatter 盖 `author: dsh-skill-curator` 章；
 *   - 只有「已盖章」或「用户显式收养」的 skill 才允许 patch / 写支持文件；
 *   - 用户手写 / 其他来源的 skill 只读，工具明确报「请先 adopt」；
 *   - 写盘统一 原子写（tmp + rename），路径做越界与穿越校验。
 *
 * 技能根（对齐 dsh-skill-filesystem rank 表）：可写根 = <DSH_HOME>/skills，
 * 可被 patch 行 config.skillsRoot 覆盖。
 */
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, join, normalize, relative, sep } from 'node:path'
import { homedir } from 'node:os'
import { defineTool } from '@deepseek-ai/dsh-tools'

/** 插件盖章身份（frontmatter author）。 */
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
  'skill-library-adopt'
]

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

/** 是否为插件可管理的 skill（frontmatter 已盖章）。 */
export function isCuratorManaged(fm) {
  return fm && (fm.author === CURATOR_AUTHOR || fm['x-curator'] === 'managed')
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

// ---------------------------------------------------------------------------
// 读取
// ---------------------------------------------------------------------------

/** 列出一个根下的全部 bundle skill（<name>/SKILL.md）。 */
export async function listSkills(root) {
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
    const { fm, hasFrontmatter } = parseSkillMd(raw)
    out.push({
      name: entry.name,
      description: typeof fm.description === 'string' ? fm.description : '',
      managed: isCuratorManaged(fm),
      hasFrontmatter
    })
  }
  out.sort((a, b) => a.name.localeCompare(b.name))
  return out
}

/** 读 SKILL.md 全文。 */
export async function readSkill(root, name) {
  if (!SKILL_ID.test(name)) throw new Error(`invalid skill name: ${name}`)
  const path = skillPath(root, name)
  return readFile(path, 'utf8')
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

/**
 * 产权守卫：managed（盖章）或是 adoptSkills 清单成员才允许写。
 * @returns {string|null} 拒绝原因；null=通过。
 */
export function writeGuard(name, fm, adoptSkills) {
  if (isCuratorManaged(fm)) return null
  if (Array.isArray(adoptSkills) && adoptSkills.includes(name)) return null
  return (
    `skill '${name}' 不是本插件创建（frontmatter 无 author: ${CURATOR_AUTHOR}），且不在收养清单。` +
    '如需让后台自动维护它，请先调用 skill-library-adopt（仅限你本人确认后调用）。'
  )
}

// ---------------------------------------------------------------------------
// 工具定义
// ---------------------------------------------------------------------------

/** 构造全部工具定义（注册进 tools 服务）。 */
export function createSkillToolDefinitions(getConfig) {
  const rootOf = () => skillsRoot(getConfig())

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

  const adoptList = () => (getConfig() || {}).adoptSkills || []

  return [
    tool(
      'skill-library-list',
      'List all skills in the user skill library (name, description, whether this curator may update them). ' +
        'Use this BEFORE deciding whether to update an existing umbrella skill or create a new one.',
      {},
      async () => ok(await listSkills(rootOf()))
    ),
    tool(
      'skill-library-read',
      'Read the full SKILL.md content of one skill by its exact name.',
      {
        name: { type: 'string', required: true, description: 'Exact skill name (kebab-case).' }
      },
      async (args) => ok(await readSkill(rootOf(), String(args.name)))
    ),
    tool(
      'skill-library-create',
      'Create a NEW class-level umbrella skill. Name must be kebab-case and class-level ' +
        '(NOT a PR number, error string, library-alone name, or one-session artifact). ' +
        'SKILL.md body should be written in Chinese with a bilingual description; ' +
        'frontmatter (name/description) is generated automatically and authorship is stamped.',
      {
        name: { type: 'string', required: true, description: 'Class-level kebab-case skill name.' },
        description: { type: 'string', required: true, description: 'Bilingual description (English preferred for model discovery, Chinese allowed).' },
        content: { type: 'string', required: true, description: 'SKILL.md body in Chinese.' }
      },
      async (args) => {
        const root = rootOf()
        const name = String(args.name)
        if (!SKILL_ID.test(name)) throw new Error(`invalid skill name (must match ${SKILL_ID}): ${name}`)
        const target = skillPath(root, name)
        const existing = await stat(target).then(() => true, () => false)
        if (existing) throw new Error(`skill '${name}' already exists — patch it instead of creating`)
        const { md } = normalizeSkillMd(name, String(args.description || ''), String(args.content || ''))
        await atomicWrite(target, md)
        return ok({ created: name, path: target })
      }
    ),
    tool(
      'skill-library-patch',
      'Patch an EXISTING skill this curator owns (or that the user adopted). ' +
        'Two modes: pass oldString+newString for a targeted edit; or pass content to replace the whole body ' +
        'while preserving its frontmatter. Ownership-guarded: unowned skills are refused.',
      {
        name: { type: 'string', required: true, description: 'Exactly the existing skill name.' },
        oldString: { type: 'string', description: 'Literal text to replace; must appear exactly once.' },
        newString: { type: 'string', description: 'Replacement text.' },
        content: { type: 'string', description: 'Whole-body replacement (frontmatter preserved).' }
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
        const { fm } = parseSkillMd(raw)
        const denied = writeGuard(name, fm, adoptList())
        if (denied) throw new Error(denied)
        let next
        if (typeof args.content === 'string') {
          // 全量替换正文，保留原 frontmatter
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
        await atomicWrite(target, next)
        return ok({ patched: name, path: target })
      }
    ),
    tool(
      'skill-library-write-file',
      'Write a support file under an existing owned skill: references/<topic>.md (session detail / knowledge banks), ' +
        'templates/<name>.<ext> (starter files to copy), or scripts/<name>.<ext> (re-runnable actions). ' +
        'Remember to add a one-line pointer in SKILL.md via skill-library-patch so future agents find it.',
      {
        name: { type: 'string', required: true, description: 'Exactly the owning skill name.' },
        filePath: { type: 'string', required: true, description: "Relative path under the skill dir, e.g. 'references/deploy-notes.md'." },
        content: { type: 'string', required: true, description: 'File content (Chinese preferred).' }
      },
      async (args) => {
        const root = rootOf()
        const name = String(args.name)
        const rel = normalize(String(args.filePath || ''))
        const allowed = ['references/', 'templates/', 'scripts/']
        if (!allowed.some((prefix) => rel.startsWith(prefix))) {
          throw new Error(`filePath must start with one of: ${allowed.join(', ')}`)
        }
        // 规范化后再验一次前缀（防 references/../x.md 这类 join 归一化绕过）
        const target = join(root, name, rel)
        assertInside(join(root, name), target)
        const md = skillPath(root, name)
        let raw
        try {
          raw = await readFile(md, 'utf8')
        } catch {
          throw new Error(`skill '${name}' not found`)
        }
        const { fm } = parseSkillMd(raw)
        const denied = writeGuard(name, fm, adoptList())
        if (denied) throw new Error(denied)
        await atomicWrite(target, String(args.content || ''))
        return ok({ wrote: `${name}/${rel}`, path: target })
      }
    ),
    tool(
      'skill-library-adopt',
      'Take ownership of an existing unowned skill so the curator may maintain it from now on. ' +
        'Only use this after the user explicitly asked to let the curator manage that skill. ' +
        'Stamps frontmatter author: dsh-skill-curator; refuses skills without frontmatter.',
      {
        name: { type: 'string', required: true, description: 'Exactly the existing skill name.' }
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
        const next = renderFrontmatter({ ...fm, author: CURATOR_AUTHOR }) + body
        await atomicWrite(target, next)
        return ok({ adopted: name, path: target })
      }
    )
  ]
}