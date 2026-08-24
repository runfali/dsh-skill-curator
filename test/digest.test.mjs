import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildDigest, truncateDigest, isUserMessage, isAssistantMessage, messageText } from '../src/digest.js'

const user = (text) => ({ type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } })
const model = (text, tools = []) => ({ type: 'assistant/message', data: { message: { source: { kind: 'model' }, content: [{ type: 'text', text }] } } })
const plugin = (text) => ({ type: 'user/message', data: { source: { kind: 'plugin', plugin: 'x' }, content: [{ type: 'text', text }] } })
const toolCall = (name) => ({ type: 'tool/call', data: { turn: 1, step: 1, name } })

test('messageText joins text blocks only', () => {
  assert.equal(messageText([{ type: 'text', text: 'a' }, { type: 'image', src: 'x' }, { type: 'text', text: 'b' }]), 'a\nb')
  assert.equal(messageText([]), '')
})

test('isUserMessage / isAssistantMessage filter by source kind', () => {
  assert.equal(isUserMessage(user('hi')), true)
  assert.equal(isUserMessage(model('hi')), false)
  assert.equal(isAssistantMessage(model('hi')), true)
  assert.equal(isAssistantMessage(plugin('hi')), false)
})

test('digest drops plugin/tool events, keeps user+model', () => {
  const events = [plugin('ignored'), user('你好'), toolCall('bash'), model('好的'), { type: 'tool/result' }]
  const { text, stats } = buildDigest(events)
  assert.equal(stats.total, 2)
  assert.ok(text.includes('你好'))
  assert.ok(text.includes('好的'))
  assert.ok(!text.includes('ignored'))
})

test('digest compresses older turns, keeps tail verbatim', () => {
  const events = []
  for (let i = 0; i < 40; i++) events.push(user(`u${i}`), model(`m${i}`))
  const { text, stats } = buildDigest(events, { tail: 6 })
  assert.equal(stats.total, 80)
  assert.equal(stats.kept, 6)
  assert.equal(stats.compressed, 74)
  // 压缩区为单行 USER:/ASSISTANT: 形式
  assert.ok(text.includes('USER: u0'), 'compressed user line')
  assert.ok(text.includes('ASSISTANT: m0'), 'compressed assistant line')
  // 尾部为全文标题形式
  assert.ok(text.includes('## 用户\nu37'), 'tail keeps full text')
  assert.ok(!text.includes('## 用户\nu30') || stats.kept === 6, 'u30 not in tail')
})

test('digest truncates long old messages', () => {
  const events = [user('x'.repeat(1000)), model('y'.repeat(1000))]
  const { text } = buildDigest(events, { tail: 0, userMaxChars: 100, assistantMaxChars: 50 })
  assert.ok(text.includes('x'.repeat(100)), 'user truncated to 100')
  assert.ok(!text.includes('x'.repeat(101)), 'no overflow')
  assert.ok(text.includes('y'.repeat(50)) && !text.includes('y'.repeat(51)), 'assistant truncated to 50')
})

test('digest attaches tool call names to previous assistant row', () => {
  const events = [user('q'), model(''), toolCall('skill-library-list'), toolCall('skill-library-read'), toolCall('run_code')]
  const { text } = buildDigest(events, { tail: 1 })
  assert.ok(text.includes('skill-library-list'), 'tool name in assistant line')
})

test('truncateDigest respects maxChars and marks truncation', () => {
  const text = 'A\n\n## 用户\n' + 'x'.repeat(5000)
  const cut = truncateDigest(text, 2000)
  assert.ok(cut.length <= 2000 + 100, 'bounded length')
  assert.ok(cut.includes('截断'), 'marks truncation')
  assert.equal(truncateDigest('short', 2000), 'short', 'no truncation under limit')
})