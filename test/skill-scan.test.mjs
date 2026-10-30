/**
 * 技能扫描：junction / 目录软链 + 悬空链接。
 *
 * 为什么单列：Dirent.isDirectory() 对 junction 返回 false（Windows 上很常见，
 * 技能库放同步盘再链接进来的做法），而 readFile/stat 都会跟随链接。
 * 只按 Dirent 判会把「用链接接入的技能」整批当成不存在 —— 而且守卫会把这种
 * 空列表判成「扫描退化」永远跳过清理，表现为永久空库（2026-10-30 审计）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listSkills } from '../src/skill-tools.js'
import { createLifecycleStore } from '../src/lifecycle.js'

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'sc-scan-'))
  const root = join(home, 'skills')
  mkdirSync(root, { recursive: true })
  process.env.DSH_HOME = home
  return { home, root, store: createLifecycleStore({ file: join(home, 'skill-curator', 'lifecycle.json') }) }
}

function realSkill(dir, name) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), '---\nname: ' + name + '\ndescription: d\n---\n\nbody\n')
}

test('listSkills：junction 接入的技能必须被发现', async () => {
  const { home, root } = fixture()
  const target = join(home, 'elsewhere', 'linked-skill')
  realSkill(target, 'linked-skill')
  symlinkSync(target, join(root, 'linked-skill'), 'junction')

  const list = await listSkills(root)
  assert.deepEqual(list.map((s) => s.name), ['linked-skill'], 'junction 目录不能被 Dirent.isDirectory() 漏掉')
})

test('syncWith 兜底扫描同样认 junction（两条路径判据一致）', () => {
  const { home, root, store } = fixture()
  const target = join(home, 'elsewhere', 'linked-skill')
  realSkill(target, 'linked-skill')
  symlinkSync(target, join(root, 'linked-skill'), 'junction')

  const res = store.syncWith(root) // 不传 names → 自己 readdir
  assert.equal(res.seeded, 1, '兜底扫描必须把 junction 技能登记进来')
  assert.equal(store.has('linked-skill'), true)
})

test('悬空软链不得让扫描抛错，且被当作存活（保守不清库）', () => {
  const { home, root, store } = fixture()
  realSkill(join(home, 'elsewhere', 'gone-skill'), 'gone-skill')
  const link = join(root, 'gone-skill')
  symlinkSync(join(home, 'elsewhere', 'gone-skill'), link, 'junction')
  store.syncWith(root) // 先正常登记
  assert.equal(store.has('gone-skill'), true)

  rmSync(join(home, 'elsewhere', 'gone-skill'), { recursive: true }) // 目标没了 → 链接悬空
  const res = store.syncWith(root, []) // 列表为空，但根里有个 stat 会抛错的条目
  assert.equal(res.skippedEmpty, true, '悬空链接要按「存活」处理，宁可不清库')
  assert.equal(store.has('gone-skill'), true, '记录必须保留（人工可恢复）')
})
