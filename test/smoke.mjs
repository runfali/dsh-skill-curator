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
// schemastery schema 是可调用对象（typeof 'function'）+ 带 ~standard 校验协议
assert.equal(typeof settings.Config, 'function', 'schemastery Config 必须是导出 schema（0.1.7 设置契约）')
assert.ok(settings.Config['~standard'] && typeof settings.Config['~standard'].validate === 'function', 'Config 必须带 ~standard 校验协议')
assert.ok(host.Config === settings.Config, 'host 半必须 re-export 同一 Config（宿主按 runtime.Config 枚举设置视图）')

// 2b. 缺省键必须由 schema 默认值补齐：宿主只注入用户显式写过的键，
// 直接展开 config 会让 enabled=undefined → 自动评审被静默关掉。
const merged = settings.mergeDefaults({ skillNudgeInterval: { get: () => 2 } })
assert.equal(merged.enabled, true, 'missing key falls back to schema default')
assert.equal(merged.skillNudgeInterval, 2, 'volatile live reference is dereferenced')
assert.deepEqual(merged.excludedSkills, [], 'array default cloned, not shared')
assert.equal(typeof host.reviewLog.recent, 'function', 'review log')

// 3. 工具定义真实编译（defineTool 会校验 schema 形状）
const definitions = tools.createSkillToolDefinitions(() => ({}))
assert.equal(definitions.length, 7, 'seven skill-library tools')
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

// 6. 写入守卫（0.1.7 起默认全库可改，只挡保护名单 + 无 frontmatter）
assert.equal(tools.writeGuard('x', {}), null, 'library skill editable by default')
assert.equal(tools.writeGuard('x', { excluded: ['y'] }), null, '非名单成员可改')
assert.ok(tools.writeGuard('x', { excluded: ['x'] }), 'excluded refused')
assert.ok(tools.writeGuard('x', { hasFrontmatter: false }), 'frontmatter-less refused')

// 6b. 先读后改：sha256 必须对得上
const rawA = '---\nname: "a"\n---\n\n正文'
assert.equal(tools.hashOf(rawA).length, 64, 'sha256 hex length')
assert.equal(tools.assertFresh('a', rawA, tools.hashOf(rawA)), tools.hashOf(rawA), 'fresh pass')
assert.throws(() => tools.assertFresh('a', rawA, ''), /skill-library-read/, 'missing hash refused')
assert.throws(() => tools.assertFresh('a', rawA, 'deadbeef'), /变了|re-read|重新/, 'stale hash refused')

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
const backups = mkdtempSync(join(tmpdir(), 'sc-backup-'))
const defs = tools.createSkillToolDefinitions(() => ({ skillsRoot: dir, backupRoot: backups }))
const byName = Object.fromEntries(defs.map((d) => [d.name, d]))
const created = await byName['skill-library-create'].execute(
  { name: 'smoke-ops', description: 'Smoke ops skill', content: '# 冒烟技能\n\n正文内容。' },
  { signal: new AbortController().signal }
)
assert.equal(created.ok, true, 'create ok')
const listing = await byName['skill-library-list'].execute({}, { signal: new AbortController().signal })
assert.equal(listing.data.skills.length, 1, 'list finds one')
assert.equal(listing.data.skills[0].name, 'smoke-ops', 'listed name')
assert.equal(listing.data.skills[0].managed, true, 'managed stamp')
assert.equal(listing.data.skills[0].bodyLines > 0, true, 'list reports body size (bloat可见)')
// 用户手写的 skill（无 author 章）——直接落盘模拟
import { mkdirSync } from 'node:fs'
mkdirSync(join(dir, 'user-own'), { recursive: true })
writeFileSync(join(dir, 'user-own', 'SKILL.md'), `---
name: user-own
description: "This skill was hand-written by the user"
---

# User owned
`)
// 未先读就写 → 两道拦截：SDK 参数校验（缺 expectedSha256）+ 插件自己的 assertFresh
await assert.rejects(
  async () => byName['skill-library-patch'].execute(
    { name: 'user-own', oldString: '# User', newString: '# Changed' },
    { signal: new AbortController().signal }
  ),
  /expectedSha256/,
  'patch without read rejected at the args layer'
)
const emptyHash = await byName['skill-library-patch'].execute(
  { name: 'user-own', oldString: '# User', newString: '# Changed', expectedSha256: '' },
  { signal: new AbortController().signal }
)
assert.equal(emptyHash.ok, false, 'empty sha256 refused')
assert.ok(emptyHash.error.includes('skill-library-read'), 'refusal points at skill-library-read')
// 先读拿到 sha256 → 允许改写（用户手写 skill 现在也可改：默认全库可编辑）
const readUser = await byName['skill-library-read'].execute({ name: 'user-own' }, { signal: new AbortController().signal })
assert.equal(readUser.ok, true, 'read ok')
assert.ok(readUser.data.content.includes('# User owned'), 'read returns full body')
const allowed = await byName['skill-library-patch'].execute(
  { name: 'user-own', oldString: '# User', newString: '# Changed', expectedSha256: readUser.data.sha256 },
  { signal: new AbortController().signal }
)
assert.equal(allowed.ok, true, 'patched after read')
assert.ok(allowed.data.backup && allowed.data.backup.includes('user-own'), 'patch backed the original up')
// 读完之后文件又变了 → 旧 hash 被拒
const stale = await byName['skill-library-patch'].execute(
  { name: 'user-own', oldString: '# Changed', newString: '# Again', expectedSha256: readUser.data.sha256 },
  { signal: new AbortController().signal }
)
assert.equal(stale.ok, false, 'stale sha256 refused')
// 保护名单成员被拒
const dirProtected = Object.fromEntries(
  tools.createSkillToolDefinitions(() => ({ skillsRoot: dir, backupRoot: backups, excludedSkills: ['user-own'] }))
    .map((d) => [d.name, d])
)
const guarded = await dirProtected['skill-library-patch'].execute(
  { name: 'user-own', oldString: '# Changed', newString: '# Nope', expectedSha256: allowed.data.sha256 },
  { signal: new AbortController().signal }
)
assert.equal(guarded.ok, false, 'excluded skill refused')
// 支持文件
const readOps = await byName['skill-library-read'].execute({ name: 'smoke-ops' }, { signal: new AbortController().signal })
const wf = await byName['skill-library-write-file'].execute(
  { name: 'smoke-ops', filePath: 'references/notes.md', content: '记录', expectedSha256: readOps.data.sha256 },
  { signal: new AbortController().signal }
)
assert.equal(wf.ok, true, 'write-file ok')
const badPath = await byName['skill-library-write-file'].execute(
  { name: 'smoke-ops', filePath: '../escape.md', content: 'x', expectedSha256: readOps.data.sha256 },
  { signal: new AbortController().signal }
)
assert.equal(badPath.ok, false, 'path escape refused')
// 删除：先读后删，整目录进备份
const readDel = await byName['skill-library-read'].execute({ name: 'user-own' }, { signal: new AbortController().signal })
const del = await byName['skill-library-delete'].execute(
  { name: 'user-own', expectedSha256: readDel.data.sha256, reason: 'smoke merge' },
  { signal: new AbortController().signal }
)
assert.equal(del.ok, true, 'delete ok')
assert.ok(del.data.backup && del.data.backup.includes('deleted-smoke-merge'), 'delete backup named with reason')
const afterDel = await byName['skill-library-list'].execute({}, { signal: new AbortController().signal })
assert.equal(afterDel.data.skills.some((s) => s.name === 'user-own'), false, 'deleted skill gone from listing')
// 重复创建被拒
const dup = await byName['skill-library-create'].execute(
  { name: 'smoke-ops', description: 'd', content: 'x' },
  { signal: new AbortController().signal }
)
assert.equal(dup.ok, false, 'duplicate create refused')

console.log('smoke OK: 11 groups passed（含 0.1.7 设置契约 / 先读后改 sha256 / 备份 / 删除 / 保护名单）')
process.exit(0)