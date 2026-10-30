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
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLifecycleStore, DAY_MS } from '../src/lifecycle.js'

function fixture(opts = {}) {
  const home = mkdtempSync(join(tmpdir(), 'sc-life-'))
  const root = join(home, 'skills')
  const file = join(home, 'skill-curator', 'lifecycle.json')
  // 必须把 DSH_HOME 指向临时 home：否则 archiveRoot 会落到真实的
  // ~/.dsh/skill-curator/archived，测试就把垃圾写进用户真技能库旁边（实测踩到）。
  process.env.DSH_HOME = home
  mkdirSync(root, { recursive: true })
  return { home, root, file, store: createLifecycleStore({ file, ...opts }) }
}

function addSkill(root, name) {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: d\n---\n\nbody\n`)
  return dir
}

// ---------------------------------------------------------------------------
// 运行时技能（skill-curator）必须能在 syncWith 后存活
// ---------------------------------------------------------------------------
// 真机实测（2026-10-20）：加载 `skill-curator` 运行时技能 → markUsed 写进状态表
// → 下一轮评审 syncWith() 按**磁盘技能列表**重建 → 它不在磁盘上 → 被当「已消失」
// 删掉，`lastUsedAt` 归零、状态表里再也查不到。运行时技能由插件 skills.register
// 注册，**磁盘上没有目录**，与「真的被删掉的技能」必须区分开。
test('syncWith 不得删除磁盘上不存在的技能（运行时技能 skill-curator）', () => {
  const { root, store } = fixture()
  addSkill(root, 'on-disk-skill')
  // 运行时技能：不在磁盘上，只有 markUsed 记过它
  store.markUsed('skill-curator', { now: Date.now() })
  assert.ok(store.snapshot().skills['skill-curator'], '前置：markUsed 已登记运行时技能')

  const counts = store.syncWith(root) // 磁盘上只有 on-disk-skill

  assert.ok(
    store.snapshot().skills['skill-curator'],
    '磁盘上没有的技能不得被 syncWith 删掉（运行时技能会被误删）'
  )
  assert.equal(counts.dropped, 0, '不得把它计入 dropped')
  assert.ok(store.snapshot().skills['on-disk-skill'], '磁盘上的技能照常登记')
})

test('syncWith 仍能清掉「曾经在磁盘上、现已消失」的技能', () => {
  const { root, store } = fixture()
  addSkill(root, 'gone-skill')
  store.syncWith(root)
  assert.ok(store.snapshot().skills['gone-skill'], '前置：先登记')
  // 从磁盘移走
  renameSync(join(root, 'gone-skill'), join(root, 'moved-away'))
  const counts = store.syncWith(root)
  assert.equal(store.snapshot().skills['gone-skill'], undefined, '磁盘上真消失的技能必须被清掉')
  assert.equal(counts.dropped, 1)
})

test('新技能被登记为 active，lastUsedAt 为 null（从未使用）', () => {  const { root, store } = fixture()
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

test('归档后目录被放回（git checkout 恢复）→ syncWith 复活为 active，且不再虚报够格归档', () => {
  const { home, root, store } = fixture()
  addSkill(root, 'alpha-skill')
  store.syncWith(root)
  const state = store.snapshot()
  const oldUse = Date.now() - 200 * DAY_MS
  state.skills['alpha-skill'].lastUsedAt = oldUse
  store.__replaceForTest(state)
  const first = store.transitions({
    staleDays: 30, archiveDays: 90, archiveEnabled: true,
    archiveFn: (n) => store.archive(n, root)
  })
  assert.equal(first.archived, 1)
  assert.equal(store.snapshot().skills['alpha-skill'].state, 'archived')

  // 归档后：目录已不在技能库 → transitions() 不得再把它算进 wouldArchive
  // （否则每轮评审都虚报「1 个够格归档」，而归档必然失败）
  const second = store.transitions({ staleDays: 30, archiveDays: 90, archiveEnabled: true, archiveFn: () => true })
  assert.equal(second.wouldArchive, 0, '已归档记录必须短路，不得重复计入 wouldArchive')
  assert.equal(second.archived, 0)

  // 目录重新出现（技能库是 git 工作树，checkout 就能放回来，绕过 restore 工具）
  renameSync(join(home, 'skill-curator', 'archived', 'alpha-skill'), join(root, 'alpha-skill'))
  const sync = store.syncWith(root)
  assert.equal(sync.restored, 1, '目录重现必须被识别为「已恢复」')
  assert.equal(sync.dropped, 0, '不得把它当「已消失」drop 掉')
  assert.equal(store.snapshot().skills['alpha-skill'].state, 'active', '状态必须回到 active')
  assert.equal(store.snapshot().skills['alpha-skill'].archivedAt, null, 'archivedAt 必须清空')
  assert.equal(store.summary().archived.includes('alpha-skill'), false, 'summary().archived 不得再含它')
  // ⚠️ 关键判据（2026-10-20 真机踩到）：目录重现 **不等于** 被使用过。
  // 复活时若写 lastUsedAt = now，一个 200 天没用过的技能会被刷成「刚刚用过」，
  // 于是永远不进 stale、永远不进归档候选 —— 直接毁掉「按真实使用计时」这条核心。
  assert.equal(
    store.snapshot().skills['alpha-skill'].lastUsedAt,
    oldUse,
    '复活不得改写 lastUsedAt（恢复 ≠ 使用）'
  )
  assert.deepEqual(
    store.summary({ archiveDays: 90 }).wouldArchive,
    ['alpha-skill'],
    '复活后仍须是归档候选（它的上次使用时间没变）'
  )

  // markUsed 同样要从 archived 复活（与 stale → active 同理）
  const st = store.snapshot()
  st.skills['alpha-skill'].state = 'archived'
  store.__replaceForTest(st)
  store.markUsed('alpha-skill')
  assert.equal(store.snapshot().skills['alpha-skill'].state, 'active', 'markUsed 必须把 archived 拉回 active')
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

// ---------------------------------------------------------------------------
// summary({archiveDays}) 的 wouldArchive —— UI 一键归档的候选集
// ---------------------------------------------------------------------------
// 判据必须与 transitions() 同源：面板推荐归档的技能，archive() 必须真能归档。
// 否则会出现「点了没反应」——用户看到的是候选，系统拒绝执行。
test('summary 不传 archiveDays 时不返回 wouldArchive（宁可不给，也不给错的）', () => {
  const { root, store } = fixture()
  addSkill(root, 'a-skill')
  store.syncWith(root)
  const s = store.summary()
  assert.equal(s.wouldArchive, undefined, '没有阈值就不该猜一个候选集')
})

test('summary({archiveDays}) 只收「超期 + 非 pinned + 非 archived + 磁盘技能」', () => {
  const { root, store } = fixture()
  for (const n of ['old-skill', 'fresh-skill', 'pinned-old']) addSkill(root, n)
  store.syncWith(root)
  const old = Date.now() - 200 * DAY_MS
  store.markUsed('old-skill', { now: old })
  store.markUsed('fresh-skill', { now: Date.now() })
  store.markUsed('pinned-old', { now: old })
  store.setPinned('pinned-old', true)
  // 运行时技能：不在磁盘上，归档必失败 → 不进候选
  store.markUsed('skill-curator', { now: old })

  const s = store.summary({ archiveDays: 90 })
  assert.deepEqual(s.wouldArchive, ['old-skill'], '只有超期、未 pinned、非运行时的磁盘技能')
})

test('summary 的 wouldArchive 与 transitions 判定同源（推荐的都是真能归档的）', () => {
  const { root, store } = fixture()
  addSkill(root, 'old-skill')
  store.syncWith(root)
  store.markUsed('old-skill', { now: Date.now() - 200 * DAY_MS })

  const recommended = store.summary({ archiveDays: 90 }).wouldArchive
  const counts = store.transitions({
    staleDays: 30,
    archiveDays: 90,
    archiveEnabled: false,
    now: Date.now()
  })
  assert.deepEqual(recommended, ['old-skill'], '面板推荐')
  assert.equal(counts.wouldArchive, 1, 'transitions 也认为它够格')
})

test('markUsed / has 不接受原型魔法名：__proto__ 不得污染 Object.prototype', () => {
  // 2026-10-30 审计实测：state.skills['__proto__'] 命中的是 Object.prototype，
  // ensure() 会把 lastUsedAt 写到整个进程共享的原型上（({}).lastUsedAt 就有值）。
  const { store } = fixture()
  store.markUsed('__proto__', { now: Date.now() })
  store.markUsed('__defineGetter__', { now: Date.now() })
  assert.equal(store.has('__proto__'), false, 'has 不得命中原型链（__proto__ 走 setter）')
  assert.equal(({}).lastUsedAt, undefined, 'Object.prototype 不得被污染')
  assert.deepEqual(Object.keys(store.snapshot().skills), [], '首字符是下划线的名字一条都不许登记')

  // 'constructor' 是合法形状的名字。这里真正守住的是 syncWith 里那句
  // Object.hasOwn(state.skills, name)：若退回 state.skills[name] 直接取，
  // 'constructor' 会命中原型上的 Object 构造函数，origin='disk' 被写到**全局 Object** 上，
  // 而且这个技能根本不会被登记（2026-10-30 复审实测）。
  store.markUsed('constructor', { now: Date.now() })
  assert.equal(Object.hasOwn(store.snapshot().skills, 'constructor'), true, '合法名字可以登记')
  assert.equal(Object.prototype.constructor, Object, 'Object.prototype 不得被改写')
  // 合法名字照常工作（白名单与 harness 的 SKILL_ID 同源：小写 kebab）
  store.markUsed('ok-skill', { now: Date.now() })
  store.markUsed('ok-skill-v2', { now: Date.now() })
  assert.ok(store.has('ok-skill') && store.has('ok-skill-v2'))
  // 与归档路由同源：记录得进却归档不了的僵尸名（大写/点/下划线）一律不收
  store.markUsed('Not-Kebab', { now: Date.now() })
  assert.equal(store.has('Not-Kebab'), false, '白名单必须与归档路由同源')
})

test('syncWith：技能根**读不到**时不得清空已有记录', () => {
  const { root, store } = fixture()
  addSkill(root, 'a-skill')
  addSkill(root, 'b-skill')
  store.syncWith(root)
  const before = store.snapshot().skills
  // 不存在的根 = 读不到的典型形态（权限/挂载/DSH_HOME 指错同理）
  const res = store.syncWith(join(root, 'not-mounted-here'), [])
  assert.equal(res.dropped, 0, '读不到的根不得删任何记录')
  assert.equal(res.skippedEmpty, true)
  assert.deepEqual(store.snapshot().skills, before, 'firstSeenAt/lastUsedAt 必须原样保留')
})

test('syncWith：技能库**真的**被删光时照常清理（不能永久留僵尸）', () => {
  const { root, store, file } = fixture()
  addSkill(root, 'a-skill')
  addSkill(root, 'b-skill')
  store.syncWith(root)
  // 真把目录删掉（不是只传空名单）：目录还在但认不出来 ≠ 删光，必须区分
  rmSync(join(root, 'a-skill'), { recursive: true })
  rmSync(join(root, 'b-skill'), { recursive: true })
  const res = store.syncWith(root, [])
  assert.equal(res.skippedEmpty, undefined, '空目录不是"读不到/扫描退化"')
  assert.equal(res.dropped, 2, '真空库必须清理僵尸记录')
  assert.deepEqual(Object.keys(store.snapshot().skills), [])
  assert.ok(existsSync(file + '.bak'), '空列表触发的清理必须无条件留快照（哪怕只删 2 条）')
})

test('syncWith：根里还有目录但认不出技能（SKILL.md 读不到）时不得清表', () => {
  const { root, store } = fixture()
  addSkill(root, 'alpha')
  addSkill(root, 'beta')
  store.syncWith(root)
  // 模拟云同步脱水 / 权限变更：目录都在，只是 listSkills 认不出来（传空名单）
  const res = store.syncWith(root, [])
  assert.equal(res.dropped, 0, '目录还在就绝不能清表')
  assert.equal(res.skippedEmpty, true)
  assert.deepEqual(Object.keys(store.snapshot().skills).sort(), ['alpha', 'beta'])
})

test('syncWith：只剩 .git 时算真删光（点条目不计入存活）', () => {
  const { root, store } = fixture()
  addSkill(root, 'alpha')
  store.syncWith(root)
  rmSync(join(root, 'alpha'), { recursive: true })
  mkdirSync(join(root, '.git'), { recursive: true })
  const res = store.syncWith(root, [])
  assert.equal(res.dropped, 1, '技能库是 git 工作树，只剩 .git 时应判为真删光')
})

test('syncWith：旧格式记录（无 origin 字段）同样受空根守卫保护', () => {
  // origin 是 2026-10-20 才加的；v0.2.0-rc.1 的 lifecycle.json 没有它。
  // 若 diskKnown 只数 origin==='disk'，这批记录会整条绕过守卫被静默清空。
  const { root, store, file } = fixture()
  const now = Date.now()
  const legacy = (at) => ({ state: 'active', firstSeenAt: at, lastUsedAt: null, archivedAt: null, pinned: false })
  store.__replaceForTest({ skills: { 'old-a': legacy(now), 'old-b': legacy(now), 'old-c': legacy(now) }, lastPassAt: null })
  store.flush() // 让状态文件真的落盘（真实场景里它本来就存在，.bak 才有东西可拷）

  // ① 根不存在 → 必须原样保留
  const missing = store.syncWith(join(root, 'not-mounted'), [])
  assert.equal(missing.skippedEmpty, true, '旧格式记录也要走守卫')
  assert.deepEqual(Object.keys(store.snapshot().skills).sort(), ['old-a', 'old-b', 'old-c'])

  // ② 根存在且真空（连目录都没有，用户真删光）→ 清理，但必须先留 .bak
  const res = store.syncWith(root, [])
  assert.equal(res.dropped, 3)
  assert.ok(existsSync(file + '.bak'), '旧格式触发清理时同样必须留快照')
})

test('syncWith：runtime 记录 firstSeenAt=0 不得被判 1970 删掉', () => {
  const { root, store } = fixture()
  store.__replaceForTest({
    skills: { 'bad-runtime': { state: 'active', firstSeenAt: 0, lastUsedAt: 0, archivedAt: null, pinned: false, origin: 'runtime' } },
    lastPassAt: null
  })
  const res = store.syncWith(root)
  assert.equal(store.has('bad-runtime'), true, '锚点无效就不该判过期（删除比误判更不可逆）')
  assert.equal(res.dropped, 0)
})

test('syncWith：根里只剩 README 这类普通文件时仍算真删光', () => {
  const { root, store } = fixture()
  addSkill(root, 'a-skill')
  addSkill(root, 'b-skill')
  store.syncWith(root)
  rmSync(join(root, 'a-skill'), { recursive: true })
  rmSync(join(root, 'b-skill'), { recursive: true })
  writeFileSync(join(root, 'README.md'), '# skills' + String.fromCharCode(10))
  const res = store.syncWith(root, [])
  assert.equal(res.dropped, 2, '普通文件不算存活，否则僵尸记录永远清不掉')
})

test('syncWith：长期未命中的 runtime 幽灵记录会被清掉（写错名字不会永久留痕）', () => {
  const { root, store } = fixture()
  store.markUsed('ghost-typo', { now: Date.now() - 200 * DAY_MS })
  assert.ok(store.has('ghost-typo'), '前置：已登记')
  const res = store.syncWith(root)
  assert.equal(store.has('ghost-typo'), false, '超过 180 天未命中的 runtime 记录应被清掉')
  assert.ok(res.dropped >= 1)
})

test('syncWith：磁盘上叫 __proto__ 的目录不得写穿原型', () => {
  const { root, store } = fixture()
  addSkill(root, '__proto__')
  const res = store.syncWith(root)
  assert.equal(store.has('__proto__'), false)
  assert.equal(({}).state, undefined, 'Object.prototype 不得被写 state/origin')
  assert.equal(res.seeded, 0, '非法目录名不登记')
})

test('syncWith：磁盘上叫 constructor 的技能必须登记在自有属性上（不写全局 Object）', () => {
  // 用普通 state.skills[name]=... 时，'constructor' 命中原型上的 Object 构造函数，
  // origin='disk' 会被写到**全局 Object** 上，且这个技能不会被登记。
  const { root, store, file } = fixture()
  addSkill(root, 'constructor')
  store.syncWith(root)
  assert.equal(store.has('constructor'), true, '合法 kebab 名必须登记')
  assert.equal(Object.origin, undefined, '绝不能把 origin 写到全局 Object 构造函数上')
  store.flush()
  assert.ok(readFileSync(file, 'utf8').includes('constructor'), '必须真正落盘')
})

test('syncWith：一次删 5 条以上先落 .bak 快照', () => {
  const { root, store, file } = fixture()
  for (const n of ['s1', 's2', 's3', 's4', 's5', 's6']) addSkill(root, n)
  store.syncWith(root)
  assert.ok(!existsSync(file + '.bak'), '前置：还没有备份')
  const res = store.syncWith(root, ['keep-one'])
  assert.equal(res.dropped, 6)
  assert.ok(existsSync(file + '.bak'), '大规模清理前必须留快照（DSH_HOME 指错时能救回历史）')
})

test('markUsed 节流窗口内的最后一次使用最终会落盘（尾随 flush）', async () => {
  // 真机事故（2026-10-30）：cloud-cost-estimation 主会话加载成功，但 markUsed
  // 落在 60s 节流窗口内，进程随后重启 → 这次使用永久丢失。尾随 flush 修的就是它。
  const { file, store } = fixture({ flushThrottleMs: 10 })
  const now = Date.now()
  store.markUsed('first-skill', { now })            // 首次：立即落盘
  const snapshot = readFileSync(file, 'utf8')
  store.markUsed('second-skill', { now: now + 1 })  // 窗口内：先不落盘
  assert.ok(!readFileSync(file, 'utf8').includes('second-skill'), '前置：窗口内不立即落盘')
  await new Promise((r) => setTimeout(r, 60))
  assert.ok(readFileSync(file, 'utf8').includes('second-skill'), '窗口过后必须自动补写（否则重启即丢）')
  assert.notEqual(readFileSync(file, 'utf8'), snapshot, '补写后文件内容与首次不同')
})

// ---------------------------------------------------------------------------
// usageReport：面板三组数字（未使用 / 超阈值未用 / 够格归档）
// ---------------------------------------------------------------------------
function seedState(store, skills) {
  const map = {}
  for (const [name, rec] of Object.entries(skills)) {
    map[name] = {
      state: 'active', firstSeenAt: Date.now(), lastUsedAt: null, archivedAt: null,
      pinned: false, origin: 'disk', ...rec
    }
  }
  store.__replaceForTest({ skills: map, lastPassAt: null })
}

test('markUsed 的历史时间戳不触发 TimeoutOverflowWarning（delay 必须 clamp）', async () => {
  // 回填会传几天甚至几个月前的时间戳，now - lastFlushAt 为负 → 旧实现算出巨大的
  // delay，node 打 TimeoutOverflowWarning 并把 timer 压成 1ms（每条一次，刷屏）。
  const warnings = []
  const onWarn = (w) => warnings.push(String(w && w.name) + ': ' + String(w && w.message))
  process.on('warning', onWarn)
  try {
    const { store } = fixture()
    const now = Date.now()
    store.markUsed('a-skill', { now })
    store.markUsed('b-skill', { now: now - 60 * DAY_MS })
    await new Promise((r) => setTimeout(r, 60))
    assert.deepEqual(warnings, [], '历史时间戳不得触发 timer 溢出告警')
  } finally {
    process.off('warning', onWarn)
  }
})

test('usageReport：三个桶的天数口径与包含关系', () => {
  const { store } = fixture()
  const now = Date.now()
  seedState(store, {
    'used-recent': { lastUsedAt: now - 5 * DAY_MS, firstSeenAt: now - 200 * DAY_MS },
    'used-old': { lastUsedAt: now - 40 * DAY_MS, firstSeenAt: now - 200 * DAY_MS },
    'used-ancient': { lastUsedAt: now - 120 * DAY_MS, firstSeenAt: now - 200 * DAY_MS },
    'never-old': { firstSeenAt: now - 50 * DAY_MS },
    'never-new': { firstSeenAt: now - 2 * DAY_MS }
  })
  const r = store.usageReport({ staleDays: 30, archiveDays: 90, now })
  assert.deepEqual(r.neverUsed.map((x) => x.name), ['never-old', 'never-new'], '从未使用按首见时间计龄')
  assert.deepEqual(r.idle.map((x) => x.name), ['used-ancient', 'never-old', 'used-old'], '超过 staleDays（含从未使用里超龄的），按年龄降序')
  assert.deepEqual(r.archiveable.map((x) => x.name), ['used-ancient'], '超过 archiveDays')
  // 天数口径：整数天，向下取整
  const ancient = r.archiveable[0]
  assert.equal(ancient.days, 120)
  assert.equal(ancient.lastUsedAt, now - 120 * DAY_MS)
  const never = r.neverUsed.find((x) => x.name === 'never-old')
  assert.equal(never.lastUsedAt, null, '从未使用必须显式给 null，前端据此区分')
  assert.equal(never.days, 50)
})

test('usageReport：归档 / 运行时技能 / 钉住 都不进任何桶', () => {
  const { store } = fixture()
  const now = Date.now()
  seedState(store, {
    'kept-old': { lastUsedAt: now - 100 * DAY_MS },
    'archived-skill': { state: 'archived', firstSeenAt: now - 400 * DAY_MS, archivedAt: now - 300 * DAY_MS },
    'runtime-skill': { origin: 'runtime', firstSeenAt: now - 400 * DAY_MS },
    'pinned-old': { lastUsedAt: now - 100 * DAY_MS, pinned: true }
  })
  const r = store.usageReport({ staleDays: 30, archiveDays: 90, now })
  const all = [...r.neverUsed, ...r.idle, ...r.archiveable].map((x) => x.name)
  assert.ok(!all.includes('archived-skill'), '已归档不得出现')
  assert.ok(!all.includes('runtime-skill'), '运行时技能不在磁盘上，归档必失败，不得出现')
  assert.ok(!all.includes('pinned-old'), '钉住 = 永久豁免')
  assert.deepEqual(r.archiveable.map((x) => x.name), ['kept-old'])
})

test('usageReport：坏数据（缺 firstSeenAt / 非数字 lastUsedAt）不产生 NaN', () => {
  // 手改或半写的 lifecycle.json 会缺字段。NaN 参与排序是乱序，序列化后变 null，
  // 前端会渲染成 "null 天" —— 必须在分桶这一层就归一。
  const { store } = fixture()
  const now = Date.now()
  seedState(store, {
    'broken-anchor': { firstSeenAt: undefined, lastUsedAt: 'oops' },
    'ok-skill': { lastUsedAt: now - 5 * DAY_MS }
  })
  const r = store.usageReport({ staleDays: 30, archiveDays: 90, now })
  const all = [...r.neverUsed, ...r.idle, ...r.archiveable]
  assert.ok(all.every((x) => Number.isFinite(x.days)), 'days 必须是有限数字')
  const broken = r.neverUsed.find((x) => x.name === 'broken-anchor')
  assert.equal(broken.days, 0, '缺锚点按 0 天处理')
  assert.equal(broken.lastUsedAt, null, '非数字 lastUsedAt 归一成 null')
})

test('transitions：lastUsedAt=0 不得被当成 1970 年（否则会真归档）', () => {
  // 与 usageReport 同一把尺：0 是坏数据。不归一的话 ageDays ≈ 20000 天，
  // archiveEnabled 打开后 transitions 会**真的**把目录移进 archived/，
  // 而同一时刻面板说「从未使用」—— 2026-10-30 复审实测的形态。
  const { root, store } = fixture()
  addSkill(root, 'zero-skill')
  const now = Date.now()
  store.__replaceForTest({
    skills: {
      'zero-skill': { state: 'active', firstSeenAt: now - 3 * DAY_MS, lastUsedAt: 0, archivedAt: null, pinned: false, origin: 'disk' }
    },
    lastPassAt: null
  })
  const counts = store.transitions({
    staleDays: 30, archiveDays: 90, archiveEnabled: true, now,
    archiveFn: (name) => store.archive(name, root)
  })
  assert.equal(counts.wouldArchive, 0, '0 不是 1970 年 → 不得进归档候选')
  assert.equal(counts.archived, 0, '绝不能真把目录移走')
  assert.ok(existsSync(join(root, 'zero-skill')), '目录必须原地不动')
})

test('usageReport：lastUsedAt=0 视为坏数据（不是 1970 年用过）', () => {
  const { store } = fixture()
  const now = Date.now()
  seedState(store, { 'zero-skill': { lastUsedAt: 0, firstSeenAt: now } })
  const r = store.usageReport({ staleDays: 30, archiveDays: 90, now })
  assert.deepEqual(r.archiveable, [], '0 不能被当成 1970 → 不得进归档候选')
  assert.deepEqual(r.neverUsed.map((x) => x.name), ['zero-skill'], '归一到「从未使用」')
  assert.equal(r.neverUsed[0].days, 0)
})

test('usageReport：旧格式记录（无 origin 字段）也要进分桶', () => {
  // origin 是 2026-10-20 才加的；升级后第一次 syncWith 之前，旧记录不该在面板上"消失"
  const { store } = fixture()
  const now = Date.now()
  store.__replaceForTest({
    skills: {
      'legacy-old': { state: 'active', firstSeenAt: now - 100 * DAY_MS, lastUsedAt: null, archivedAt: null, pinned: false }
    },
    lastPassAt: null
  })
  const r = store.usageReport({ staleDays: 30, archiveDays: 90, now })
  assert.deepEqual(r.neverUsed.map((x) => x.name), ['legacy-old'], '无 origin 视为磁盘技能')
  assert.deepEqual(r.archiveable.map((x) => x.name), ['legacy-old'])
})

test('usageReport：阈值跟随设置，非法值响亮失败', () => {
  const { store } = fixture()
  const now = Date.now()
  seedState(store, { 'ten-days': { lastUsedAt: now - 10 * DAY_MS } })
  assert.deepEqual(store.usageReport({ staleDays: 7, archiveDays: 90, now }).idle.map((x) => x.name), ['ten-days'], 'staleDays 改成 7 就应命中')
  assert.deepEqual(store.usageReport({ staleDays: 30, archiveDays: 90, now }).idle, [], '默认 30 天不命中')
  assert.throws(() => store.usageReport({ staleDays: undefined, archiveDays: 90 }), /finite numbers/)
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
