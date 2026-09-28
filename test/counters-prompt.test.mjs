import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createCounter } from '../src/counters.js'
import { buildReviewPrompt, REVIEW_INSTRUCTIONS } from '../src/review-prompt.js'

test('counter fires exactly at interval, then resets', () => {
  const c = createCounter()
  assert.equal([c.bump(3), c.bump(3), c.bump(3)].join(','), 'false,false,true')
  assert.equal(c.countOf(), 0, 'reset after fire')
})

test('counter interval is dynamic per bump', () => {
  const c = createCounter()
  c.bump(5)
  c.bump(5)
  c.bump(5)
  c.bump(5)
  assert.equal(c.countOf(), 4, 'not fired under interval=5')
  assert.equal(c.bump(3), true, 'interval lowered to 3 fires immediately')
})

test('reset clears state', () => {
  const c = createCounter()
  c.bump(5)
  c.reset()
  assert.equal(c.countOf(), 0)
})

test('interval 1 fires every bump; invalid interval clamps to 1', () => {
  const c = createCounter()
  assert.equal(c.bump(1), true)
  assert.equal(c.bump(1), true)
  assert.equal(createCounter().bump(undefined), true, 'undefined → clamp 1')
})

test('review prompt: digest first, then instructions, focus appended', () => {
  const p = buildReviewPrompt({ digestText: 'SESSION-TEXT', focus: '重点提炼部署流程' })
  assert.ok(p.startsWith('SESSION-TEXT'), 'digest leads')
  assert.ok(p.includes('重点提炼部署流程'), 'focus clause present')
  const p2 = buildReviewPrompt({ digestText: 'SESSION-TEXT' })
  assert.ok(!p2.includes('## 用户明确要求'), 'no focus → no clause')
})

test('review instructions carry the curation guardrails', () => {
  for (const clause of [
    // 形态与工具面
    '类级', 'references/', 'templates/', 'scripts/',
    'skill-library-list', 'skill-library-read', 'skill-library-create',
    'skill-library-patch', 'skill-library-write-file', 'skill-library-delete', 'skill-library-adopt',
    // 减法优先 + 通俗不堆砌（2026-09 发哥新增要求）
    '先做减法', '合并', '篇幅', '通俗', '说人话',
    // 写入机制
    '先读后改', 'expectedSha256', 'backups',
    // 基线条款
    '无需保存', '否定断言', '中文', 'ACTIVE'
  ]) {
    assert.ok(REVIEW_INSTRUCTIONS.includes(clause), `instructions contain ${clause}`)
  }
})

test('review instructions are non-empty and coherent', () => {
  assert.ok(REVIEW_INSTRUCTIONS.length > 500)
  assert.ok(!REVIEW_INSTRUCTIONS.includes('hermes_'), 'no hermes identifiers leaked')
})