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

test('description 必须自带用法散文（because catalog 不渲染 whenToUse）', () => {
  // 旧版数关键词（read/sha256/delete/lifecycle）**名不副实**：纯工具名枚举 +
  // 「(sha256)」这种零散文的 description 也能全数命中而存活。改为剥掉全部工具名后
  // 再找**动作性短语**与**说明性散文**——只有真正写了用法才可能通过。
  const prose = TOOL_NAMES.reduce((acc, n) => acc.split(n).join(' '), CURATOR_SKILL.description)
  assert.match(prose, /\bread first\b|先读后改/i, 'description 必须含非工具名的动作性用法短语（如 read first）')
  assert.match(prose, /\bmust\b|\bprefer\b|\balways\b|必须|优先/i, 'description 必须是说明性散文，不是纯工具名枚举')
})

test('content 覆盖全部白名单工具名（精确成行，禁止子串命中）', () => {
  // 旧版用 includes()：`- `skill-library-delete-file`` 包含 `skill-library-delete`，
  // 于是删掉 delete 那一行也照样绿。必须按行精确匹配。
  const lines = CURATOR_SKILL.content.split('\n').map((l) => l.trim())
  for (const name of TOOL_NAMES) {
    assert.ok(lines.includes(`- \`${name}\``), `content 必须成行精确列出 ${name}（子串匹配会漏掉它）`)
  }
})

test('content 写明「先读后改」与「归档优先于删除」', () => {
  assert.ok(CURATOR_SKILL.content.includes('sha256'))
  assert.ok(CURATOR_SKILL.content.includes('归档'))
})
