import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createCounter } from '../src/counters.js'
import { buildReviewPrompt, REVIEW_INSTRUCTIONS } from '../src/review-prompt.js'

test('counter fires exactly at interval, then resets', () => {
  const c = createCounter(3)
  const a = {}
  assert.equal([c.bump(a), c.bump(a), c.bump(a)].join(','), 'false,false,true')
  assert.equal(c.countOf(a), 0, 'reset after fire')
})

test('counters are per-agent (WeakMap isolation)', () => {
  const c = createCounter(2)
  const a1 = {}
  const a2 = {}
  c.bump(a1)
  assert.equal(c.countOf(a1), 1)
  assert.equal(c.countOf(a2), 0)
  c.bump(a2)
  assert.equal(c.bump(a2), true, 'a2 fires on its own cadence')
})

test('reset clears state', () => {
  const c = createCounter(5)
  const a = {}
  c.bump(a)
  c.reset(a)
  assert.equal(c.countOf(a), 0)
})

test('interval 1 fires every bump', () => {
  const c = createCounter(1)
  const a = {}
  assert.equal(c.bump(a), true)
  assert.equal(c.bump(a), true)
})

test('review prompt: digest first, then instructions, focus appended', () => {
  const p = buildReviewPrompt({ digestText: 'SESSION-TEXT', focus: '重点提炼部署流程' })
  assert.ok(p.startsWith('SESSION-TEXT'), 'digest leads')
  assert.ok(p.includes('重点提炼部署流程'), 'focus clause present')
  const p2 = buildReviewPrompt({ digestText: 'SESSION-TEXT' })
  assert.ok(!p2.includes('## 用户明确要求'), 'no focus → no clause')
})

test('review instructions contain hermes-derived guardrails', () => {
  for (const clause of [
    '类级', 'references/', 'templates/', 'scripts/',
    'skill-library-list', 'skill-library-adopt',
    '无需保存', '否定断言', '中文', 'author: dsh-skill-curator',
    'ACTIVE', '旧 24 条' // 无此条款，防呆：确保只查真实条款
  ]) {
    if (clause === '旧 24 条') continue
    assert.ok(REVIEW_INSTRUCTIONS.includes(clause), `instructions contain ${clause}`)
  }
})

test('review instructions are non-empty and coherent', () => {
  assert.ok(REVIEW_INSTRUCTIONS.length > 500)
  assert.ok(!REVIEW_INSTRUCTIONS.includes('hermes_'), 'no hermes identifiers leaked')
})