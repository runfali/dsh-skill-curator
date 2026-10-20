/**
 * dsh-skill-curator — 技能生命周期状态机单测。
 * 运行：node --test test/lifecycle.test.mjs
 *
 * 关键反例（来自 dsh-learn 的实测缺陷，见 _research/dsh-learn/REPORT.md 3.1）：
 * 「最后使用时间」绝不能拿 SKILL.md 的 mtime 当代理 —— 那是「最后修改」。
 * 本测试用「文件 mtime 很老、但 markUsed 刚打过」的技能钉死这一点。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLifecycleStore, DAY_MS } from '../src/lifecycle.js'

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'sc-life-'))
  const root = join(home, 'skills')
  const file = join(home, 'skill-curator', 'lifecycle.json')
  // 必须把 DSH_HOME 指向临时 home：否则 archiveRoot 会落到真实的
  // ~/.dsh/skill-curator/archived，测试就把垃圾写进用户真技能库旁边（实测踩到）。
  process.env.DSH_HOME = home
  mkdirSync(root, { recursive: true })
  return { home, root, file, store: createLifecycleStore({ file }) }
}

function addSkill(root, name) {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: d\n---\n\nbody\n`)
  return dir
}

test('新技能被登记为 active，lastUsedAt 为 null（从未使用）', () => {
  const { root, store } = fixture()
  addSkill(root, 'alpha-skill')
  const counts = store.syncWith(root)
  assert.equal(counts.seeded, 1)
  const rec = store.snapshot().skills['alpha-skill']
  assert.equal(rec.state, 'active')
  assert.equal(rec.lastUsedAt, null, '绝不能拿文件 mtime 当 lastUsedAt')
})

test('从未使用的技能在宽限期内不会被标 stale（反 dsh-learn 的空转缺陷）', () => {
  const { root, store } = fixture()
  addSkill(root, 'alpha-skill')
  store.syncWith(root)
  // 把登记时间推到 10 天前，但 staleDays=30 → 仍在宽限期
  const state = store.snapshot()
  state.skills['alpha-skill'].firstSeenAt = Date.now() - 10 * DAY_MS
  store.__replaceForTest(state)
  const counts = store.transitions({ staleDays: 30, archiveDays: 90, archiveEnabled: false })
  assert.equal(counts.markedStale, 0, '从未使用 + 未过宽限期 → 不标 stale')
})

test('从未使用的技能超过宽限期才标 stale', () => {
  const { root, store } = fixture()
  addSkill(root, 'alpha-skill')
  store.syncWith(root)
  const state = store.snapshot()
  state.skills['alpha-skill'].firstSeenAt = Date.now() - 40 * DAY_MS
  store.__replaceForTest(state)
  const counts = store.transitions({ staleDays: 30, archiveDays: 90, archiveEnabled: false })
  assert.equal(counts.markedStale, 1)
  assert.equal(store.snapshot().skills['alpha-skill'].state, 'stale')
})

test('markUsed 后超过 staleDays 也不标 stale（mtime 老不算数）', () => {
  const { root, store } = fixture()
  addSkill(root, 'alpha-skill')
  store.syncWith(root)
  store.markUsed('alpha-skill') // 刚刚使用
  const state = store.snapshot()
  state.skills['alpha-skill'].firstSeenAt = Date.now() - 200 * DAY_MS
  store.__replaceForTest(state)
  const counts = store.transitions({ staleDays: 30, archiveDays: 90, archiveEnabled: false })
  assert.equal(counts.markedStale, 0, 'lastUsedAt 是现在 → 不该 stale')
  assert.equal(counts.archived, 0)
})

test('超过 archiveDays 时：archiveEnabled=false 只标 stale，不动磁盘', () => {
  const { root, store } = fixture()
  addSkill(root, 'alpha-skill')
  store.syncWith(root)
  const state = store.snapshot()
  state.skills['alpha-skill'].lastUsedAt = Date.now() - 200 * DAY_MS
  store.__replaceForTest(state)
  // 关键两点，缺一就有变异体存活（实测）：
  //   ① 注入 archiveFn —— 否则挡住归档的是 `typeof archiveFn !== 'function'`，
  //      开关本身不可观测（删掉守卫里的 `archiveEnabled &&` 也全绿）。
  //   ② **不传 archiveEnabled** —— 走默认值，否则把默认值改成 true 也全绿。
  const counts = store.transitions({
    staleDays: 30,
    archiveDays: 90,
    archiveFn: (n) => store.archive(n, root)
  })
  assert.equal(counts.archived, 0, '默认不自动归档')
  assert.equal(counts.wouldArchive, 1, '但要报告「够格归档」')
  assert.ok(existsSync(join(root, 'alpha-skill', 'SKILL.md')), '磁盘必须原样不动')
})

test('archiveEnabled=true 时才真的移动目录，且可 restore', () => {
  const { home, root, store } = fixture()
  addSkill(root, 'alpha-skill')
  store.syncWith(root)
  const state = store.snapshot()
  state.skills['alpha-skill'].lastUsedAt = Date.now() - 200 * DAY_MS
  store.__replaceForTest(state)
  // archiveFn 由调用方注入（保持「判定」与「执行」解耦），这里显式接上真实归档动作。
  const counts = store.transitions({
    staleDays: 30,
    archiveDays: 90,
    archiveEnabled: true,
    archiveFn: (n) => store.archive(n, root)
  })
  assert.equal(counts.archived, 1)
  const archived = join(home, 'skill-curator', 'archived', 'alpha-skill', 'SKILL.md')
  assert.ok(existsSync(archived), '归档到技能库之外')
  assert.equal(existsSync(join(root, 'alpha-skill')), false, '原目录已移走')
  assert.equal(store.restore('alpha-skill', root), true)
  assert.ok(existsSync(join(root, 'alpha-skill', 'SKILL.md')), 'restore 回到技能库')
  assert.equal(store.snapshot().skills['alpha-skill'].state, 'active')
})

test('pinned 技能永不被标 stale 或归档', () => {
  const { root, store } = fixture()
  addSkill(root, 'alpha-skill')
  store.syncWith(root)
  store.setPinned('alpha-skill', true)
  const state = store.snapshot()
  state.skills['alpha-skill'].lastUsedAt = Date.now() - 999 * DAY_MS
  store.__replaceForTest(state)
  const counts = store.transitions({ staleDays: 30, archiveDays: 90, archiveEnabled: true })
  assert.equal(counts.markedStale, 0)
  assert.equal(counts.archived, 0)
  assert.ok(existsSync(join(root, 'alpha-skill', 'SKILL.md')))
})

test('落盘是原子的，且损坏文件按空表容错（绝不抛）', () => {
  const { file, store } = fixture()
  store.markUsed('ghost-skill')
  store.flush()
  const parsed = JSON.parse(readFileSync(file, 'utf8'))
  assert.ok(parsed.skills['ghost-skill'], 'markUsed 后落盘')
  writeFileSync(file, '{ not json')
  const reopened = createLifecycleStore({ file })
  assert.deepEqual(reopened.snapshot().skills, {}, '损坏 → 空表，不抛')
})

test('归档目标已存在时返回 false 且绝不覆盖（避开 dsh-learn 的 rmSync 缺陷）', () => {
  const { home, root, file } = fixture()
  const warns = []
  const store = createLifecycleStore({ file, log: (lvl, msg) => warns.push(msg) })
  addSkill(root, 'alpha-skill')
  // 先手工放一个同名旧归档：它代表「唯一可恢复的副本」
  const dst = join(home, 'skill-curator', 'archived', 'alpha-skill')
  mkdirSync(dst, { recursive: true })
  writeFileSync(join(dst, 'SKILL.md'), 'old-archive\n')
  assert.equal(store.archive('alpha-skill', root), false, '目标已存在 → 拒绝')
  assert.equal(readFileSync(join(dst, 'SKILL.md'), 'utf8'), 'old-archive\n', '旧归档必须原样保留')
  assert.ok(existsSync(join(root, 'alpha-skill', 'SKILL.md')), '原技能不动')
  assert.ok(warns.some((m) => m.includes('archive target exists')), '只打 warn')
})

test('staleDays/archiveDays 非有限数字时抛错，绝不静默空转', () => {
  const { root, store } = fixture()
  addSkill(root, 'alpha-skill')
  store.syncWith(root)
  // 不校验时 `ageDays > undefined` 恒 false → 静默「什么都不标」，
  // 看起来像生命周期在工作，实际空转。响亮失败优于静默 no-op。
  assert.throws(
    () => store.transitions({ archiveEnabled: false }),
    /staleDays\/archiveDays must be finite numbers/,
    'undefined 必须抛错'
  )
  assert.throws(
    () => store.transitions({ staleDays: 30, archiveDays: NaN, archiveEnabled: false }),
    /staleDays\/archiveDays must be finite numbers/,
    'NaN 必须抛错'
  )
})

test('markUsed 节流：60s 内多次调用只落盘一次', () => {
  const { file, store } = fixture()
  const t0 = Date.now()
  store.markUsed('a-skill', { now: t0 })
  const firstMtime = readFileSync(file, 'utf8')
  store.markUsed('a-skill', { now: t0 + 1000 })
  store.markUsed('b-skill', { now: t0 + 2000 })
  const secondMtime = readFileSync(file, 'utf8')
  assert.equal(secondMtime, firstMtime, '60s 窗口内不再落盘')
  store.markUsed('b-skill', { now: t0 + 61_000 })
  assert.notEqual(readFileSync(file, 'utf8'), firstMtime, '过了窗口才落盘')
})
