/**
 * dsh-skill-curator — 真插件入口端到端生命周期测试。
 *
 * 与 apply.test.mjs 的区别：这里跑的是**完整业务链路**（用户手写 skill → 通读 → 增改 →
 * 下沉 references → 合并新建 → 删除），而不是单点契约。用来盯住「机制能连起来用」：
 * 每个工具单独绿不等于链路通（CRG detect_changes 长期把这些标为 test gap）。
 *
 * 运行：node --test test/e2e-lifecycle.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_CURATOR_HISTORY = join(mkdtempSync(join(tmpdir(), 'sc-e2e-hist-')), 'reviews.json')
const mod = await import('../src/index.js')

/** 最小 cordis 宿主上下文（只需 apply 用到的面）。 */
function makeHost() {
  const seen = { tools: [], listeners: new Map(), routes: [], commands: [], presentations: [], effects: [] }
  const ctx = {
    fiber: { state: 2 },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    effect(fn) { const d = fn(); seen.effects.push(d); return d },
    on(evt, cb) {
      if (!seen.listeners.has(evt)) seen.listeners.set(evt, [])
      seen.listeners.get(evt).push(cb)
      return () => {}
    },
    inject(_services, cb) { cb(ctx) },
    settings: { configure(presentation) { seen.presentations.push(presentation); return () => {} } },
    tools: { register(definition) { seen.tools.push(definition) } },
    get(key) {
      if (key === 'commands') return { register(d) { seen.commands.push(d); return () => {} } }
      if (key === 'webServer') return { register(r) { seen.routes.push(r); return () => {} } }
      return undefined
    }
  }
  return { ctx, seen }
}

/** 每个测试独立沙箱：全新 skillsRoot + backupRoot，互不污染。 */
function setup() {
  const { ctx, seen } = makeHost()
  const skillsRoot = mkdtempSync(join(tmpdir(), 'sc-e2e-skills-'))
  const backupRoot = mkdtempSync(join(tmpdir(), 'sc-e2e-backup-'))
  mod.apply(ctx, { skillsRoot, backupRoot })
  const byName = Object.fromEntries(seen.tools.map((d) => [d.name, d]))
  const sig = { signal: new AbortController().signal }
  const call = (name, args) => byName[name].execute(args, sig)
  const readHash = async (name) => (await call('skill-library-read', { name })).data.sha256
  return { seen, skillsRoot, backupRoot, byName, call, readHash }
}

test('apply wires the full surface (tools / command / route / settings page policy)', () => {
  const { seen } = setup()
  assert.equal(seen.tools.length, 10, 'ten skill-library tools')
  assert.equal(seen.commands[0].name, 'skill-refine', '/skill-refine registered')
  assert.equal(seen.routes[0].path, '/api/skill-curator/status', 'status route registered')
  assert.equal(seen.presentations.length, 1, 'settings.configure called once')
  assert.equal(seen.presentations[0].auto, false, 'host auto-generated settings page disabled')
  assert.ok(seen.listeners.has('agent/created'), 'agent/created listener registered')
})

test('lifecycle: hand-written skill → read → patch → references → merge-create → delete', async () => {
  const { skillsRoot, backupRoot, call, readHash } = setup()

  // 1. 用户手写的 skill（外部来源，无 author 章）直接落盘
  mkdirSync(join(skillsRoot, 'legacy-runbook'), { recursive: true })
  writeFileSync(join(skillsRoot, 'legacy-runbook', 'SKILL.md'),
    '---\nname: legacy-runbook\ndescription: "hand written"\n---\n\n# 老手册\n\n第一步…\n')

  // 2. 通读后增改（不再需要先 adopt）
  const patched = await call('skill-library-patch', {
    name: 'legacy-runbook',
    oldString: '第一步…',
    newString: '第一步…（2026-09 实测：加 --no-cache）',
    expectedSha256: await readHash('legacy-runbook')
  })
  assert.equal(patched.ok, true, 'hand-written skill is editable after a read')
  assert.equal(readdirSync(backupRoot).length, 1, 'one backup written before the patch')
  assert.ok(readFileSync(join(skillsRoot, 'legacy-runbook', 'SKILL.md'), 'utf8').includes('--no-cache'), 'edit landed')

  // 3. 细节下沉 references/
  const support = await call('skill-library-write-file', {
    name: 'legacy-runbook',
    filePath: 'references/errors.md',
    content: '# 报错实录\n\nECONNRESET → 重试即可。',
    expectedSha256: await readHash('legacy-runbook')
  })
  assert.equal(support.ok, true)
  assert.ok(readFileSync(join(skillsRoot, 'legacy-runbook', 'references', 'errors.md'), 'utf8').includes('ECONNRESET'))

  // 4. 合并：建 canonical skill，把老条目删掉（删除连带 references/ 一起进备份，才真可回滚）
  assert.equal((await call('skill-library-create', {
    name: 'runbook', description: 'Ops runbook', content: '# 运维手册\n\n细节见 references/errors.md'
  })).ok, true)
  const del = await call('skill-library-delete', {
    name: 'legacy-runbook', expectedSha256: await readHash('legacy-runbook'), reason: 'merged into runbook'
  })
  assert.equal(del.ok, true, 'merged-away skill deleted')
  assert.ok(del.data.backup.includes('deleted-merged-into-runbook'), 'backup name records the reason')
  assert.ok(readFileSync(join(del.data.backup, 'references', 'errors.md'), 'utf8').includes('ECONNRESET'),
    'the references/ file went into the backup directory')

  // 5. 收尾状态：只剩 canonical。
  // 备份两份 = patch（改 SKILL.md）+ delete（整目录）；write-file 是新建文件，
  // 没有旧内容可备——不备份 SKILL.md 免得堆噪音（2026-09-28 起的行为）。
  const listed = await call('skill-library-list', {})
  assert.deepEqual(listed.data.skills.map((s) => s.name), ['runbook'])
  assert.equal(readdirSync(backupRoot).length, 2, 'patch + delete backed up; a brand-new file needs none')
  assert.ok(readFileSync(join(skillsRoot, 'runbook', 'SKILL.md'), 'utf8').includes('references/errors.md'))
})

test('review tools cover the full lifecycle: tree / read support / delete-file / git', async () => {
  const { skillsRoot, call, readHash } = setup()
  assert.equal((await call('skill-library-create', { name: 'lifecycle', description: 'd', content: '# L' })).ok, true)
  await call('skill-library-write-file', {
    name: 'lifecycle', filePath: 'references/old.md', content: '待清理', expectedSha256: await readHash('lifecycle')
  })

  // tree：看得见自己写了什么（含支持文件）
  const tree = await call('skill-library-tree', { name: 'lifecycle' })
  assert.deepEqual(tree.data.files.map((f) => f.file), ['SKILL.md', 'references/old.md'])

  // read 支持文件：拿到它自己的 sha256（以前读不回来）
  const support = await call('skill-library-read', { name: 'lifecycle', filePath: 'references/old.md' })
  assert.equal(support.ok, true)
  assert.ok(support.data.content.includes('待清理'))

  // delete-file：合并后清掉过时支持文件
  const gone = await call('skill-library-delete-file', {
    name: 'lifecycle', filePath: 'references/old.md', expectedSha256: support.data.sha256, reason: 'merged'
  })
  assert.equal(gone.ok, true)
  assert.deepEqual((await call('skill-library-tree', { name: 'lifecycle' })).data.files.map((f) => f.file), ['SKILL.md'])

  void skillsRoot
})

test('protection list blocks writes end-to-end (live config)', async () => {
  const { ctx, seen } = makeHost()
  const skillsRoot = mkdtempSync(join(tmpdir(), 'sc-e2e-guard-'))
  const excluded = ['locked']
  mod.apply(ctx, { skillsRoot, excludedSkills: { get: () => excluded } })
  const call = (name, args) => seen.tools.find((d) => d.name === name).execute(args, { signal: new AbortController().signal })

  const blocked = await call('skill-library-create', { name: 'locked', description: 'd', content: '# x' })
  assert.equal(blocked.ok, false, 'excluded name refused')
  assert.ok(blocked.error.includes('excludedSkills'))

  excluded.length = 0 // 活引用热改（等价于用户在设置页清空保护名单）
  assert.equal((await call('skill-library-create', { name: 'locked', description: 'd', content: '# x' })).ok, true,
    'clearing the live list unblocks writes')
})
