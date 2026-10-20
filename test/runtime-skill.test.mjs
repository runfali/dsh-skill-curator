/**
 * 运行时技能的形态守卫。
 * 关键：宿主 catalog 只渲染 name + description（dsh-tool-skill:42-47），
 * whenToUse 不进模型可见目录 —— 所以「怎么用」必须写进 description。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CURATOR_SKILL } from '../src/runtime-skill.js'
import { TOOL_NAMES } from '../src/skill-tools.js'

test('运行时技能名符合宿主 SKILL_NAME', () => {
  assert.match(CURATOR_SKILL.name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/)
})

test('description 非空且 ≤500 字符（catalog 渲染上限）', () => {
  assert.ok(CURATOR_SKILL.description.length > 0)
  assert.ok(CURATOR_SKILL.description.length <= 500, `实际 ${CURATOR_SKILL.description.length}`)
})

test('description 必须自带用法（because catalog 不渲染 whenToUse）', () => {
  // 至少要提到核心动作与「先读后改」，否则模型看到目录也不知道怎么用
  for (const needle of ['read', 'sha256', 'delete', 'lifecycle']) {
    assert.ok(CURATOR_SKILL.description.toLowerCase().includes(needle), `description 必须提到 ${needle}`)
  }
})

test('content 覆盖全部白名单工具名', () => {
  for (const name of TOOL_NAMES) {
    assert.ok(CURATOR_SKILL.content.includes(name), `content 必须说明 ${name}`)
  }
})

test('content 写明「先读后改」与「归档优先于删除」', () => {
  assert.ok(CURATOR_SKILL.content.includes('sha256'))
  assert.ok(CURATOR_SKILL.content.includes('归档'))
})
