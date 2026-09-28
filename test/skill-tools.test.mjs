import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CURATOR_AUTHOR, SKILL_ID, TOOL_NAMES, TOOL_OUTPUT_SCHEMA, SUPPORT_DIRS,
  parseSkillMd, renderFrontmatter, isCuratorManaged, assertInside, hashOf, assertFresh,
  skillsRoot, backupRoot, backupFile, backupDirTree, normalizeSkillMd, writeGuard, shapeWarnings,
  BODY_SOFT_LINES, BODY_HARD_LINES, BACKUP_KEEP, listSkills, createSkillToolDefinitions,
  skillFilePath, runGit, gitRootOf, GIT_ACTIONS
} from '../src/skill-tools.js'

test('SKILL_ID validation', () => {
  for (const ok of ['a', 'skill-name', 'abc123', 'a0-b1']) assert.match(ok, SKILL_ID)
  for (const bad of ['Aaa', '-x', 'x_', 'x y', 'x/Y', '']) assert.doesNotMatch(bad, SKILL_ID)
})

test('parseSkillMd handles scalar, quoted, inline array; rejects blocks', () => {
  const raw = `---
name: demo
description: "A demo skill"
tags: [linux, dsh]
author: someone
multi: |
  folded
---

# body
`
  const { fm, body, hasFrontmatter } = parseSkillMd(raw)
  assert.equal(hasFrontmatter, true)
  assert.equal(fm.name, 'demo')
  assert.equal(fm.description, 'A demo skill')
  assert.deepEqual(fm.tags, ['linux', 'dsh'])
  assert.equal('multi' in fm, false, 'multiline block skipped')
  assert.ok(body.trim().startsWith('# body'))
})

test('parseSkillMd tolerates no frontmatter', () => {
  const { fm, hasFrontmatter, body } = parseSkillMd('plain text')
  assert.equal(hasFrontmatter, false)
  assert.equal(fm.name, undefined)
  assert.equal(body, 'plain text')
})

test('renderFrontmatter round-trips', () => {
  const md = renderFrontmatter({ name: 'x', tags: ['a', 'b'], enabled: true })
  assert.ok(md.includes('name: "x"'))
  assert.ok(md.includes('tags: ["a", "b"]'))
  assert.ok(md.includes('enabled: true'))
})

test('isCuratorManaged', () => {
  assert.equal(isCuratorManaged({ author: CURATOR_AUTHOR }), true)
  assert.equal(isCuratorManaged({ author: 'someone' }), false)
  assert.equal(isCuratorManaged({ 'x-curator': 'managed' }), true)
  assert.equal(isCuratorManaged({}), false)
})

test('writeGuard: library-wide editing, exclusion list, frontmatter requirement', () => {
  // 0.1.7 起默认全库可改（评审要能对原有 skill 增删改），只挡两类
  assert.equal(writeGuard('a', {}), null, 'unowned skill is editable')
  assert.equal(writeGuard('a', { excluded: ['b'] }), null, 'non-member passes')
  assert.ok(writeGuard('a', { excluded: ['a'] }), 'excluded refused')
  assert.ok(writeGuard('a', { hasFrontmatter: false }), 'frontmatter-less refused')
})

test('hashOf + assertFresh enforce read-before-write', () => {
  const raw = '---\nname: "a"\n---\n\n正文'
  assert.match(hashOf(raw), /^[0-9a-f]{64}$/)
  assert.equal(assertFresh('a', raw, hashOf(raw)), hashOf(raw))
  assert.throws(() => assertFresh('a', raw, undefined), /skill-library-read/)
  assert.throws(() => assertFresh('a', raw, hashOf(raw + 'x')), /重新|变了/)
})

test('shapeWarnings nudges bloat above the line thresholds', () => {
  assert.deepEqual(shapeWarnings('a', BODY_SOFT_LINES), [])
  assert.match(shapeWarnings('a', BODY_SOFT_LINES + 1)[0], /references/)
  assert.match(shapeWarnings('a', BODY_HARD_LINES + 1)[0], /臃肿/)
})

test('backupFile prunes to the newest BACKUP_KEEP copies (no unbounded growth)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sc-prune-'))
  const src = join(dir, 'SKILL.md')
  const backups = join(dir, 'backups')
  const seen = []
  for (let i = 0; i < BACKUP_KEEP + 3; i++) {
    writeFileSync(src, `---\nname: "a"\n---\n\n第 ${i} 版`)
    // 备份名解析到秒，同秒会撞名——这里靠序号写入不同内容 + 强制不同时间戳文件名
    const target = await backupFile(src, { backupDir: backups, label: `v${String(i).padStart(2, '0')}` })
    seen.push(target)
  }
  // readdirSync / mkdirSync 已在文件顶部引入
  // 目录型备份（delete 用）同样计入配额——否则删多了照样无限增长
  for (let i = 0; i < 3; i++) {
    const tree = join(dir, `tree${i}`)
    mkdirSync(join(tree, 'references'), { recursive: true })
    writeFileSync(join(tree, 'SKILL.md'), 'x')
    await backupDirTree(tree, { backupDir: backups, label: `tree${i}` })
  }
  const kept = readdirSync(backups)
  assert.equal(kept.length, BACKUP_KEEP, 'files and directories share one BACKUP_KEEP quota, got ' + kept.length)
  assert.ok(kept.some((n) => n.endsWith('.d')), 'directory backups survive the prune')
  // 最旧的被删：第一份备份文件不应还在
  assert.equal(kept.includes(seen[0].split(/[\\/]/).pop()), false, 'oldest backup pruned')
})

test('skillFilePath: resolves inside the skill dir and refuses escapes', () => {
  const root = mkdtempSync(join(tmpdir(), 'sc-path-'))
  assert.equal(skillFilePath(root, 'demo'), join(root, 'demo', 'SKILL.md'), 'default is SKILL.md')
  assert.equal(skillFilePath(root, 'demo', 'references/x.md'), join(root, 'demo', 'references', 'x.md'))
  assert.equal(skillFilePath(root, 'demo', ''), join(root, 'demo', 'SKILL.md'), 'empty falls back to SKILL.md')
  for (const bad of ['../evil.md', 'references/../../evil.md', '..']) {
    assert.throws(() => skillFilePath(root, 'demo', bad), /escape/, `refused ${bad}`)
  }
  assert.throws(() => skillFilePath(root, 'Bad Name'), /invalid skill name/)
})

test('readSkill reads support files (the 2026-09-28 fix) + tree lists every file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sc-tree-'))
  const backups = mkdtempSync(join(tmpdir(), 'sc-tree-bk-'))
  const defs = createSkillToolDefinitions(() => ({ skillsRoot: dir, backupRoot: backups }))
  const byName = Object.fromEntries(defs.map((d) => [d.name, d]))
  const sig = { signal: new AbortController().signal }

  await byName['skill-library-create'].execute({ name: 'tree-demo', description: 'd', content: '# T' }, sig)
  const mdHash = (await byName['skill-library-read'].execute({ name: 'tree-demo' }, sig)).data.sha256
  await byName['skill-library-write-file'].execute(
    { name: 'tree-demo', filePath: 'references/deep.md', content: '# 深水区\n小节', expectedSha256: mdHash }, sig)

  // 修复前：readSkill 硬编码 SKILL.md，支持文件读不回来
  const support = await byName['skill-library-read'].execute({ name: 'tree-demo', filePath: 'references/deep.md' }, sig)
  assert.equal(support.ok, true, 'support file readable now')
  assert.ok(support.data.content.includes('深水区'), 'support content returned')
  assert.match(support.data.sha256, /^[0-9a-f]{64}$/, 'support file carries its own sha256')

  const tree = await byName['skill-library-tree'].execute({ name: 'tree-demo' }, sig)
  assert.deepEqual(tree.data.files.map((f) => f.file), ['SKILL.md', 'references/deep.md'])
  assert.ok(tree.data.files.every((f) => f.lines > 0 && f.bytes > 0))

  const escape = await byName['skill-library-read'].execute({ name: 'tree-demo', filePath: '../../etc/passwd' }, sig)
  assert.equal(escape.ok, false, 'escape refused')
})

test('write-file on an existing support file backs up the previous content', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sc-ow-'))
  const backups = mkdtempSync(join(tmpdir(), 'sc-ow-bk-'))
  const defs = createSkillToolDefinitions(() => ({ skillsRoot: dir, backupRoot: backups }))
  const byName = Object.fromEntries(defs.map((d) => [d.name, d]))
  const sig = { signal: new AbortController().signal }
  const readHash = async (name, filePath) => (await byName['skill-library-read'].execute({ name, ...(filePath ? { filePath } : {}) }, sig)).data.sha256

  await byName['skill-library-create'].execute({ name: 'ow', description: 'd', content: '# O' }, sig)
  await byName['skill-library-write-file'].execute(
    { name: 'ow', filePath: 'references/a.md', content: 'V1', expectedSha256: await readHash('ow') }, sig)
  const before = readdirSync(backups).length
  const rewrite = await byName['skill-library-write-file'].execute(
    { name: 'ow', filePath: 'references/a.md', content: 'V2', expectedSha256: await readHash('ow') }, sig)
  assert.equal(rewrite.ok, true)
  assert.equal(rewrite.data.overwritten, true, 'reports overwrite')
  // 只备份被覆盖的支持文件本身；SKILL.md 没动就不该产生备份（否则备份目录堆噪音）
  assert.equal(readdirSync(backups).length, before + 1, 'exactly one backup — the overwritten file')
  const kept = readdirSync(backups).filter((n) => n.includes('references-a.md-support'))
  assert.equal(kept.length, 1, 'backup labelled with the file path')
  assert.equal(readFileSync(join(backups, kept[0]), 'utf8'), 'V1', 'backed up the OLD content')
  // 新增（非覆盖）不产生备份
  const added = await byName['skill-library-write-file'].execute(
    { name: 'ow', filePath: 'references/b.md', content: 'fresh', expectedSha256: await readHash('ow') }, sig)
  assert.equal(added.data.overwritten, false)
  assert.equal(added.data.backup, null, 'brand-new file needs no backup')
})

test('delete-file: read-first, backed up, SKILL.md itself refused', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sc-delf-'))
  const backups = mkdtempSync(join(tmpdir(), 'sc-delf-bk-'))
  const defs = createSkillToolDefinitions(() => ({ skillsRoot: dir, backupRoot: backups }))
  const byName = Object.fromEntries(defs.map((d) => [d.name, d]))
  const sig = { signal: new AbortController().signal }
  const readHash = async (name, filePath) => (await byName['skill-library-read'].execute({ name, ...(filePath ? { filePath } : {}) }, sig)).data.sha256

  await byName['skill-library-create'].execute({ name: 'df', description: 'd', content: '# D' }, sig)
  const mdHash = await readHash('df')
  await byName['skill-library-write-file'].execute(
    { name: 'df', filePath: 'references/gone.md', content: 'bye', expectedSha256: mdHash }, sig)

  const main = await byName['skill-library-delete-file'].execute(
    { name: 'df', filePath: 'SKILL.md', expectedSha256: mdHash }, sig)
  assert.equal(main.ok, false, 'SKILL.md refused (use patch)')

  await assert.rejects(
    async () => byName['skill-library-delete-file'].execute({ name: 'df', filePath: 'references/gone.md' }, sig),
    /expectedSha256/
  )

  const del = await byName['skill-library-delete-file'].execute(
    { name: 'df', filePath: 'references/gone.md', expectedSha256: await readHash('df', 'references/gone.md'), reason: 'merged' }, sig)
  assert.equal(del.ok, true)
  assert.ok(del.data.backup.includes('deleted-merged'), 'reason recorded in the backup name')
  const tree = await byName['skill-library-tree'].execute({ name: 'df' }, sig)
  assert.deepEqual(tree.data.files.map((f) => f.file), ['SKILL.md'], 'file gone, skill intact')
})

test('git backstop: status/diff/log/commit only; push and friends do not exist', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'sc-git-'))
  const skills = join(repo, 'skills')
  mkdirSync(skills, { recursive: true })
  const init = await runGit(skills, ['init'])
  if (init.code !== 0) { assert.ok(true, 'git unavailable — skipped'); return }
  await runGit(skills, ['config', 'user.email', 'curator@test.local'])
  await runGit(skills, ['config', 'user.name', 'curator-test'])

  const backups = mkdtempSync(join(tmpdir(), 'sc-git-bk-'))
  const defs = createSkillToolDefinitions(() => ({ skillsRoot: skills, backupRoot: backups }))
  const byName = Object.fromEntries(defs.map((d) => [d.name, d]))
  const sig = { signal: new AbortController().signal }

  assert.deepEqual(GIT_ACTIONS, ['status', 'diff', 'log', 'commit'], 'read + commit only — no push/reset')
  assert.equal(await gitRootOf(skills) !== null, true, 'work tree detected')

  await byName['skill-library-create'].execute({ name: 'gitted', description: 'd', content: '# G' }, sig)
  const st = await byName['skill-library-git'].execute({ action: 'status' }, sig)
  assert.equal(st.ok, true)
  assert.ok(st.data.changes.some((l) => l.includes('gitted')), 'new skill shows in status')

  const first = await byName['skill-library-git'].execute({ action: 'commit', message: 'test: first' }, sig)
  assert.equal(first.data.committed, true, 'first commit lands')
  assert.match(first.data.sha, /^[0-9a-f]+$/, 'returns the new sha')

  const nothing = await byName['skill-library-git'].execute({ action: 'commit' }, sig)
  assert.equal(nothing.data.committed, false, 'nothing to commit → no empty commit')

  const log = await byName['skill-library-git'].execute({ action: 'log' }, sig)
  assert.ok(log.data.entries.length >= 1, 'commit visible in log')

  for (const action of ['push', 'reset', 'checkout', 'clean', 'remote']) {
    const bad = await byName['skill-library-git'].execute({ action }, sig)
    assert.equal(bad.ok, false, `${action} refused`)
  }
})

test('backupRoot follows DSH_HOME; SUPPORT_DIRS is the write allow-list', () => {
  process.env.DSH_HOME = join(tmpdir(), 'sc-backup-home')
  assert.equal(backupRoot({}), join(process.env.DSH_HOME, 'skill-curator', 'backups'))
  delete process.env.DSH_HOME
  assert.deepEqual(SUPPORT_DIRS, ['references/', 'templates/', 'scripts/'])
})

test('assertInside rejects escapes', () => {
  assert.doesNotThrow(() => assertInside('/root/skills', '/root/skills/a/references/x.md'))
  assert.throws(() => assertInside('/root/skills', '/root/skills/../etc/passwd'))
  assert.throws(() => assertInside('/root/skills', '/root/skills_other/x'))
})

test('skillsRoot resolution', () => {
  assert.equal(skillsRoot({ skillsRoot: '/tmp/custom' }), '/tmp/custom')
  process.env.DSH_HOME = join(tmpdir(), 'sc-home')
  assert.equal(skillsRoot({}), join(process.env.DSH_HOME, 'skills'))
  delete process.env.DSH_HOME
})

test('normalizeSkillMd stamps name/description/author and preserves body', () => {
  const { md, fm } = normalizeSkillMd('ops', 'desc', '# 正文\n\n细节')
  assert.equal(fm.name, 'ops')
  assert.equal(fm.description, 'desc')
  assert.equal(fm.author, CURATOR_AUTHOR)
  assert.ok(md.includes('# 正文'))
})

test('normalizeSkillMd adopts existing frontmatter but forces author', () => {
  const { md, fm } = normalizeSkillMd('ops', 'desc', '---\nname: old\nauthor: someone\nversion: 2.0.0\n---\n\nbody here')
  assert.equal(fm.author, CURATOR_AUTHOR)
  assert.equal(fm.version, '2.0.0', 'other fields preserved')
  assert.ok(md.includes('body here'), 'body kept')
})

test('tools: create/patch/write-file/adopt/guard against real dir', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sc-test-'))
  const backups = mkdtempSync(join(tmpdir(), 'sc-backup-'))
  const config = { skillsRoot: dir, backupRoot: backups }
  const defs = createSkillToolDefinitions(() => config)
  const byName = Object.fromEntries(defs.map((d) => [d.name, d]))
  const sig = { signal: new AbortController().signal }
  // 先读后改：每次动笔前重新读一遍拿 sha256（真机里也是这个顺序）
  const readHash = async (name) => {
    const r = await byName['skill-library-read'].execute({ name }, sig)
    assert.equal(r.ok, true, `read ${name}`)
    return r.data.sha256
  }

  // create
  const created = await byName['skill-library-create'].execute(
    { name: 'ops-runbook', description: 'Ops runbook skill', content: '# 运维手册\n\n中文正文。' }, sig)
  assert.equal(created.ok, true)
  const raw = readFileSync(join(dir, 'ops-runbook', 'SKILL.md'), 'utf8')
  assert.ok(raw.includes(`author: "${CURATOR_AUTHOR}"`))

  // duplicate refused
  const dup = await byName['skill-library-create'].execute(
    { name: 'ops-runbook', description: 'd', content: 'x' }, sig)
  assert.equal(dup.ok, false)
  assert.ok(dup.error.includes('already exists'))

  // invalid name refused
  const badName = await byName['skill-library-create'].execute(
    { name: 'Bad Name', description: 'd', content: 'x' }, sig)
  assert.equal(badName.ok, false)

  // 未先读就写 → 两道拦截：SDK 参数校验（缺 expectedSha256 直接 ToolArgsError），
  // 以及即使传了空串也会被插件自己的 assertFresh 拒掉（先读后改是硬约束，不是提醒）
  await assert.rejects(
    async () => byName['skill-library-patch'].execute(
      { name: 'ops-runbook', oldString: '# 运维手册', newString: '# 运维手册（v2）' }, sig),
    /expectedSha256/,
    'patch without read rejected at the args layer'
  )
  const emptyHash = await byName['skill-library-patch'].execute(
    { name: 'ops-runbook', oldString: '# 运维手册', newString: '# 运维手册（v2）', expectedSha256: '' }, sig)
  assert.equal(emptyHash.ok, false, 'empty sha256 refused')
  assert.ok(emptyHash.error.includes('skill-library-read'), 'refusal names the read tool')

  // patch targeted（先读拿 sha256，再改）
  const patched = await byName['skill-library-patch'].execute(
    { name: 'ops-runbook', oldString: '# 运维手册', newString: '# 运维手册（v2）', expectedSha256: await readHash('ops-runbook') }, sig)
  assert.equal(patched.ok, true)
  assert.ok(patched.data.backup && patched.data.backup.startsWith(backups), 'backup written before patch')
  assert.ok(readFileSync(join(dir, 'ops-runbook', 'SKILL.md'), 'utf8').includes('（v2）'))

  // 读完之后文件又变 → 旧 sha256 被拒
  const stale = await byName['skill-library-patch'].execute(
    { name: 'ops-runbook', oldString: '# 运维手册（v2）', newString: 'x', expectedSha256: hashOf('别的内容') }, sig)
  assert.equal(stale.ok, false, 'stale sha256 refused')

  // patch ambiguous anchor refused（先制造两处 '运维'）
  const mkDup = await byName['skill-library-patch'].execute(
    { name: 'ops-runbook', oldString: '# 运维手册（v2）', newString: '# 运维手册（v2）·运维要点', expectedSha256: await readHash('ops-runbook') }, sig)
  assert.equal(mkDup.ok, true)
  const multi = await byName['skill-library-patch'].execute(
    { name: 'ops-runbook', oldString: '运维', newString: 'x', expectedSha256: await readHash('ops-runbook') }, sig)
  assert.equal(multi.ok, false, 'multi occurrence refused')
  assert.ok(multi.error.includes('appears'))

  // whole-body replacement keeps frontmatter + 体量提醒（不拦截）
  const replaced = await byName['skill-library-patch'].execute(
    { name: 'ops-runbook', content: '全新正文，不带 frontmatter。\n'.repeat(200), expectedSha256: await readHash('ops-runbook') }, sig)
  assert.equal(replaced.ok, true)
  assert.match(replaced.data.warnings[0], /references/, 'bloated body nudged toward references/')
  const after = readFileSync(join(dir, 'ops-runbook', 'SKILL.md'), 'utf8')
  assert.ok(after.startsWith('---'), 'frontmatter preserved')
  assert.ok(after.includes('全新正文'))

  // write-file kinds + escape
  for (const rel of ['references/deploy.md', 'templates/conf.yaml', 'scripts/check.sh']) {
    const wf = await byName['skill-library-write-file'].execute(
      { name: 'ops-runbook', filePath: rel, content: 'x', expectedSha256: await readHash('ops-runbook') }, sig)
    assert.equal(wf.ok, true, `write-file ${rel}`)
  }
  for (const bad of ['../evil.md', 'evil.md', 'docs/x.md', 'references/../../evil.md']) {
    const wf = await byName['skill-library-write-file'].execute(
      { name: 'ops-runbook', filePath: bad, content: 'x', expectedSha256: await readHash('ops-runbook') }, sig)
    assert.equal(wf.ok, false, `write-file refused ${bad}`)
  }

  // list（带正文行数，臃肿一眼可见）
  const listed = await byName['skill-library-list'].execute({}, sig)
  assert.equal(listed.data.skills.length, 1)
  assert.equal(listed.data.skills[0].managed, true)
  assert.ok(listed.data.skills[0].bodyLines > 0, 'body size reported')

  // 用户手写的 skill 现在也允许直接改（默认全库可编辑），同样要先读后改
  mkdirSync(join(dir, 'user-owned'), { recursive: true })
  writeFileSync(join(dir, 'user-owned', 'SKILL.md'), '---\nname: user-owned\ndescription: "u"\n---\n\n# u')
  const allowed = await byName['skill-library-patch'].execute(
    { name: 'user-owned', oldString: '# u', newString: '# v', expectedSha256: await readHash('user-owned') }, sig)
  assert.equal(allowed.ok, true, 'hand-written skill editable without adopting')
  // adopt 仍可用：盖 author 章标记来源
  const adopted = await byName['skill-library-adopt'].execute({ name: 'user-owned' }, sig)
  assert.equal(adopted.ok, true)
  assert.ok(readFileSync(join(dir, 'user-owned', 'SKILL.md'), 'utf8').includes(`author: "${CURATOR_AUTHOR}"`))

  // delete：先读后删，**整个技能目录**（含 references/ scripts/）落备份，再从列表消失
  await byName['skill-library-write-file'].execute(
    { name: 'user-owned', filePath: 'scripts/check.sh', content: 'echo ok', expectedSha256: await readHash('user-owned') }, sig)
  const del = await byName['skill-library-delete'].execute(
    { name: 'user-owned', expectedSha256: await readHash('user-owned'), reason: 'merged into ops-runbook' }, sig)
  assert.equal(del.ok, true)
  assert.ok(del.data.backup.endsWith('.d'), 'delete backs up a directory, not just SKILL.md')
  assert.ok(del.data.backup.includes('deleted-merged-into-ops-runbook'), 'backup name carries the reason')
  const { readFileSync: rf, readdirSync: rd } = await import('node:fs')
  assert.ok(rf(join(del.data.backup, 'SKILL.md'), 'utf8').includes('user-owned'), 'SKILL.md preserved in the backup dir')
  assert.deepEqual(rd(join(del.data.backup, 'scripts')), ['check.sh'], 'support files preserved too')
  const afterDel = await byName['skill-library-list'].execute({}, sig)
  assert.deepEqual(afterDel.data.skills.map((s) => s.name), ['ops-runbook'])

  // 无 frontmatter 的垃圾目录：可删（否则永远清不掉），但不可改写
  mkdirSync(join(dir, 'junk-dir'), { recursive: true })
  writeFileSync(join(dir, 'junk-dir', 'SKILL.md'), 'plain text, no frontmatter')
  const junkPatch = await byName['skill-library-patch'].execute(
    { name: 'junk-dir', content: 'x', expectedSha256: await readHash('junk-dir') }, sig)
  assert.equal(junkPatch.ok, false, 'frontmatter-less skill cannot be rewritten')
  const junkDel = await byName['skill-library-delete'].execute(
    { name: 'junk-dir', expectedSha256: await readHash('junk-dir'), reason: 'junk' }, sig)
  assert.equal(junkDel.ok, true, 'frontmatter-less directory is still deletable')

  // 保护名单成员：任何写入都被拒
  const guardedDefs = createSkillToolDefinitions(() => ({ skillsRoot: dir, backupRoot: backups, excludedSkills: ['ops-runbook'] }))
  const guarded = Object.fromEntries(guardedDefs.map((d) => [d.name, d]))
  const blocked = await guarded['skill-library-patch'].execute(
    { name: 'ops-runbook', content: 'x', expectedSha256: await readHash('ops-runbook') }, sig)
  assert.equal(blocked.ok, false, 'excluded skill refused')
  assert.ok(blocked.error.includes('excludedSkills'))

  // adopt skill without frontmatter refused
  mkdirSync(join(dir, 'no-fm'), { recursive: true })
  writeFileSync(join(dir, 'no-fm', 'SKILL.md'), 'plain text')
  const noFm = await byName['skill-library-adopt'].execute({ name: 'no-fm' }, sig)
  assert.equal(noFm.ok, false)

  // list on missing root returns empty
  const emptyRoot = createSkillToolDefinitions(() => ({ skillsRoot: join(dir, 'nope') }))
  const empty = await emptyRoot.find((d) => d.name === 'skill-library-list').execute({}, sig)
  assert.deepEqual(empty.data.skills, [])
})

test('listSkills aggregates bundle dirs only', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sc-test-'))
  mkdirSync(join(dir, 'a-skill'), { recursive: true })
  writeFileSync(join(dir, 'a-skill', 'SKILL.md'), '---\nname: a-skill\ndescription: "A"\n---\n\n# A')
  mkdirSync(join(dir, 'b-skill'), { recursive: true })
  writeFileSync(join(dir, 'b-skill', 'SKILL.md'), '---\nname: b-skill\ndescription: "B"\nauthor: dsh-skill-curator\n---\n\n# B')
  mkdirSync(join(dir, 'no-md'), { recursive: true })
  writeFileSync(join(dir, 'flat.md'), 'x')
  const out = await listSkills(dir)
  assert.deepEqual(out.map((s) => s.name).sort(), ['a-skill', 'b-skill'])
  assert.equal(out.find((s) => s.name === 'b-skill').managed, true)
})

test('whitelist and output schema shape', () => {
  assert.equal(TOOL_NAMES.length, 10)
  for (const t of ['skill-library-delete', 'skill-library-delete-file', 'skill-library-tree', 'skill-library-git']) {
    assert.ok(TOOL_NAMES.includes(t), `whitelist includes ${t}`)
  }
  assert.ok(TOOL_NAMES.includes('skill-library-delete'), 'delete is part of the reviewer whitelist')
  assert.ok(TOOL_OUTPUT_SCHEMA.properties.ok.required === true)
  assert.equal(TOOL_OUTPUT_SCHEMA.properties.error.type, 'string')
})