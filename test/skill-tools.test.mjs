import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CURATOR_AUTHOR, SKILL_ID, TOOL_NAMES, TOOL_OUTPUT_SCHEMA,
  parseSkillMd, renderFrontmatter, isCuratorManaged, assertInside,
  skillsRoot, normalizeSkillMd, writeGuard, listSkills, createSkillToolDefinitions
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

test('writeGuard ownership matrix', () => {
  assert.equal(writeGuard('a', { author: CURATOR_AUTHOR }, []), null)
  assert.equal(writeGuard('a', {}, ['a']), null)
  assert.ok(writeGuard('a', {}, []), 'unowned refused')
  assert.ok(writeGuard('a', { author: 'x' }, ['b']), 'other-author refused')
})

test('assertInside rejects escapes', () => {
  assert.doesNotThrow(() => assertInside('/root/skills', '/root/skills/a/references/x.md'))
  assert.throws(() => assertInside('/root/skills', '/root/skills/../etc/passwd'))
  assert.throws(() => assertInside('/root/skills', '/root/skills_other/x'))
})

test('skillsRoot resolution', () => {
  assert.equal(skillsRoot({ skillsRoot: '/tmp/custom' }), '/tmp/custom')
  process.env.DSH_HOME = '/tmp/sc-home'
  assert.equal(skillsRoot({}), '/tmp/sc-home/skills')
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
  const config = { skillsRoot: dir }
  const defs = createSkillToolDefinitions(() => config)
  const byName = Object.fromEntries(defs.map((d) => [d.name, d]))
  const sig = { signal: new AbortController().signal }

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

  // patch targeted
  const patched = await byName['skill-library-patch'].execute(
    { name: 'ops-runbook', oldString: '# 运维手册', newString: '# 运维手册（v2）' }, sig)
  assert.equal(patched.ok, true)
  assert.ok(readFileSync(join(dir, 'ops-runbook', 'SKILL.md'), 'utf8').includes('（v2）'))

  // patch ambiguous anchor refused（先制造两处 '运维'）
  const mkDup = await byName['skill-library-patch'].execute(
    { name: 'ops-runbook', oldString: '# 运维手册（v2）', newString: '# 运维手册（v2）·运维要点' }, sig)
  assert.equal(mkDup.ok, true)
  const multi = await byName['skill-library-patch'].execute(
    { name: 'ops-runbook', oldString: '运维', newString: 'x' }, sig)
  assert.equal(multi.ok, false, 'multi occurrence refused')
  assert.ok(multi.error.includes('appears'))

  // whole-body replacement keeps frontmatter
  const replaced = await byName['skill-library-patch'].execute(
    { name: 'ops-runbook', content: '全新正文，不带 frontmatter。' }, sig)
  assert.equal(replaced.ok, true)
  const after = readFileSync(join(dir, 'ops-runbook', 'SKILL.md'), 'utf8')
  assert.ok(after.startsWith('---'), 'frontmatter preserved')
  assert.ok(after.includes('全新正文'))

  // write-file kinds + escape
  for (const rel of ['references/deploy.md', 'templates/conf.yaml', 'scripts/check.sh']) {
    const wf = await byName['skill-library-write-file'].execute(
      { name: 'ops-runbook', filePath: rel, content: 'x' }, sig)
    assert.equal(wf.ok, true, `write-file ${rel}`)
  }
  for (const bad of ['../evil.md', 'evil.md', 'docs/x.md', 'references/../../evil.md']) {
    const wf = await byName['skill-library-write-file'].execute(
      { name: 'ops-runbook', filePath: bad, content: 'x' }, sig)
    assert.equal(wf.ok, false, `write-file refused ${bad}`)
  }

  // list
  const listed = await byName['skill-library-list'].execute({}, sig)
  assert.equal(listed.data.length, 1)
  assert.equal(listed.data[0].managed, true)

  // user-owned: unowned patch refused → adopt → allowed
  mkdirSync(join(dir, 'user-owned'), { recursive: true })
  writeFileSync(join(dir, 'user-owned', 'SKILL.md'), '---\nname: user-owned\ndescription: "u"\n---\n\n# u')
  const denied = await byName['skill-library-patch'].execute(
    { name: 'user-owned', oldString: '# u', newString: '# v' }, sig)
  assert.equal(denied.ok, false)
  assert.ok(denied.error.includes('收养'))
  const adopted = await byName['skill-library-adopt'].execute({ name: 'user-owned' }, sig)
  assert.equal(adopted.ok, true)
  const allowed = await byName['skill-library-patch'].execute(
    { name: 'user-owned', oldString: '# u', newString: '# v' }, sig)
  assert.equal(allowed.ok, true)

  // adopt skill without frontmatter refused
  mkdirSync(join(dir, 'no-fm'), { recursive: true })
  writeFileSync(join(dir, 'no-fm', 'SKILL.md'), 'plain text')
  const noFm = await byName['skill-library-adopt'].execute({ name: 'no-fm' }, sig)
  assert.equal(noFm.ok, false)

  // list on missing root returns empty
  const emptyRoot = createSkillToolDefinitions(() => ({ skillsRoot: join(dir, 'nope') }))
  const empty = await emptyRoot.find((d) => d.name === 'skill-library-list').execute({}, sig)
  assert.deepEqual(empty.data, [])
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
  assert.equal(TOOL_NAMES.length, 6)
  assert.ok(TOOL_OUTPUT_SCHEMA.properties.ok.required === true)
  assert.equal(TOOL_OUTPUT_SCHEMA.properties.error.type, 'string')
})