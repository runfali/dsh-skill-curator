/**
 * dsh-skill-curator — 冒烟测试：模块可加载、工具定义可编译、契约常量正确。
 * 运行：node test/smoke.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 1. 模块可加载
const settings = await import('../src/settings.js')
const counters = await import('../src/counters.js')
const digest = await import('../src/digest.js')
const prompt = await import('../src/review-prompt.js')
const reviewer = await import('../src/reviewer.js')
const tools = await import('../src/skill-tools.js')
const host = await import('../src/index.js')

assert.equal(host.name, 'skill-curator', 'host name')
assert.deepEqual(host.inject.sort(), ['settings', 'tools'], 'host inject')
assert.equal(settings.NS, 'skill-curator', 'settings namespace')

// 2. 依赖真实可解析（离线 symlink 布局）
assert.equal(typeof settings.Config, 'function', 'schemastery Config')
assert.equal(typeof host.reviewLog.recent, 'function', 'review log')

// 3. 工具定义真实编译（defineTool 会校验 schema 形状）
const definitions = tools.createSkillToolDefinitions(() => ({}))
assert.equal(definitions.length, 6, 'six skill-library tools')
for (const def of definitions) {
  assert.match(def.name, /^skill-library-/, `name ${def.name}`)
  assert.equal(typeof def.execute, 'function', `${def.name} execute`)
  assert.ok(def.output && def.output.schema, `${def.name} output schema`)
  assert.ok(def.parameters, `${def.name} parameters`)
}

// 4. 白名单与工具名一致
for (const name of tools.TOOL_NAMES) {
  assert.ok(definitions.some((d) => d.name === name), `whitelist contains ${name}`)
}

// 5. frontmatter 解析与盖章
const rawMd = `---
name: test-skill
description: "A test skill"
tags: [a, b]
---

# 正文
`
const parsed = tools.parseSkillMd(rawMd)
assert.equal(parsed.fm.name, 'test-skill', 'fm name')
assert.equal(parsed.fm.description, 'A test skill', 'fm description (quoted)')
assert.deepEqual(parsed.fm.tags, ['a', 'b'], 'fm tags (inline array)')
assert.equal(parsed.hasFrontmatter, true, 'has frontmatter')
assert.equal(parsed.body.includes('正文'), true, 'body kept')

const normalized = tools.normalizeSkillMd('my-skill', 'desc', '正文内容')
assert.match(normalized.md, /^---\nname: "my-skill"/, 'normalize stamps name')
assert.ok(normalized.md.includes(`author: "${tools.CURATOR_AUTHOR}"`), 'normalize stamps author')
assert.ok(normalized.md.includes('正文内容'), 'normalize keeps body')
assert.ok(!normalized.md.includes('```'), 'no code fence leak')

// 6. 产权守卫
assert.equal(tools.writeGuard('x', { author: tools.CURATOR_AUTHOR }, []), null, 'managed passes')
assert.equal(tools.writeGuard('x', {}, ['x']), null, 'adopted passes')
assert.ok(tools.writeGuard('x', {}, []), 'unowned refused')

// 7. 技能根解析
const root = tools.skillsRoot({ skillsRoot: '/tmp/x' })
assert.equal(root, '/tmp/x', 'skillsRoot override')
process.env.DSH_HOME = join(tmpdir(), 'sc-smoke-home')
assert.equal(tools.skillsRoot({}), join(process.env.DSH_HOME, 'skills'), 'DSH_HOME default')
delete process.env.DSH_HOME

// 8. 计数
const counter = counters.createCounter()
assert.equal(counter.bump(3), false, '1st bump')
assert.equal(counter.bump(3), false, '2nd bump')
assert.equal(counter.bump(3), true, '3rd bump fires')
assert.equal(counter.bump(3), false, 'reset after fire')
assert.equal(counter.countOf(), 1, 'count continues')

// 9. 事件形状
const evts = [
  { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '你好' }] } },
  { type: 'assistant/message', data: { message: { source: { kind: 'model' }, content: [{ type: 'text', text: '你好，有什么可以帮你' }] } } },
  { type: 'plugin-ish', data: { source: { kind: 'plugin' } } }
]
const d = digest.buildDigest(evts)
assert.equal(d.stats.total, 2, 'only user+model counted')
assert.ok(d.text.includes('你好'), 'digest keeps text')
assert.ok(!d.text.includes('plugin-ish'), 'digest drops plugin events')

// 10. 评审提示词关键条款
const p = prompt.buildReviewPrompt({ digestText: 'SESSION' })
assert.ok(p.includes('SESSION'), 'digest first')
for (const clause of ['类级', 'references', '无需保存', 'skill-library', '中文']) {
  assert.ok(p.includes(clause), `prompt contains ${clause}`)
}

// 11. 临时目录写盘冒烟
const dir = mkdtempSync(join(tmpdir(), 'sc-smoke-'))
const defs = tools.createSkillToolDefinitions(() => ({ skillsRoot: dir }))
const byName = Object.fromEntries(defs.map((d) => [d.name, d]))
const created = await byName['skill-library-create'].execute(
  { name: 'smoke-ops', description: 'Smoke ops skill', content: '# 冒烟技能\n\n正文内容。' },
  { signal: new AbortController().signal }
)
assert.equal(created.ok, true, 'create ok')
const listing = await byName['skill-library-list'].execute({}, { signal: new AbortController().signal })
assert.equal(listing.data.length, 1, 'list finds one')
assert.equal(listing.data[0].name, 'smoke-ops', 'listed name')
assert.equal(listing.data[0].managed, true, 'managed stamp')
// 用户手写的 skill（无 author 章）——直接落盘模拟
import { mkdirSync } from 'node:fs'
mkdirSync(join(dir, 'user-own'), { recursive: true })
writeFileSync(join(dir, 'user-own', 'SKILL.md'), `---
name: user-own
description: "This skill was hand-written by the user"
---

# User owned
`)
// 未收养写入被拒
const denied = await byName['skill-library-patch'].execute(
  { name: 'user-own', oldString: '# User', newString: '# Changed' },
  { signal: new AbortController().signal }
)
assert.equal(denied.ok, false, 'unowned patch refused')
assert.ok(denied.error.includes('收养'), 'deny mentions adopt')
// 收养后可通过
const adopted = await byName['skill-library-adopt'].execute(
  { name: 'user-own' },
  { signal: new AbortController().signal }
)
assert.equal(adopted.ok, true, 'adopt ok')
const allowed = await byName['skill-library-patch'].execute(
  { name: 'user-own', oldString: '# User', newString: '# Changed' },
  { signal: new AbortController().signal }
)
assert.equal(allowed.ok, true, 'patched after adopt')
// 支持文件
const wf = await byName['skill-library-write-file'].execute(
  { name: 'smoke-ops', filePath: 'references/notes.md', content: '记录' },
  { signal: new AbortController().signal }
)
assert.equal(wf.ok, true, 'write-file ok')
const badPath = await byName['skill-library-write-file'].execute(
  { name: 'smoke-ops', filePath: '../escape.md', content: 'x' },
  { signal: new AbortController().signal }
)
assert.equal(badPath.ok, false, 'path escape refused')
// 重复创建被拒
const dup = await byName['skill-library-create'].execute(
  { name: 'smoke-ops', description: 'd', content: 'x' },
  { signal: new AbortController().signal }
)
assert.equal(dup.ok, false, 'duplicate create refused')

console.log('smoke OK: 11 groups passed')
process.exit(0)