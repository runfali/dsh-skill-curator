/**
 * dsh-skill-curator — 会话历史摘要（digest）。
 *
 * 对齐 hermes `_digest_history` 的形态：评审子代理不拿全量原始会话，
 * 而是拿到一份「近 N 条全文 + 更早逐轮压缩」的快照，控制注入成本。
 *
 * 输入：agent.session.events（SessionEvent[]）。
 * 只提取真人输入（user/message，source.kind==='user'）与模型回复
 * （assistant/message，source.kind==='model'）：
 *   - plugin 注入（source.kind==='plugin'，如 dsh-mem0-plugins 的提醒）不进摘要
 *   - tool 结果不进摘要（逐轮压缩时保留工具名即可）
 */

/** 从消息 content 块里取文本。 */
export function messageText(content) {
  if (!Array.isArray(content)) return ''
  const texts = []
  for (const block of content) {
    if (block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      texts.push(block.text)
    }
  }
  return texts.join('\n').trim()
}

/** 事件是否真人输入（plugin 注入的 user 角色不算——source.kind 必须是 'user'）。 */
export function isUserMessage(event) {
  return (
    event &&
    event.type === 'user/message' &&
    event.data &&
    event.data.source &&
    event.data.source.kind === 'user'
  )
}

/** 事件是否模型输出。 */
export function isAssistantMessage(event) {
  return (
    event &&
    event.type === 'assistant/message' &&
    event.data &&
    event.data.message &&
    event.data.message.source &&
    event.data.message.source.kind === 'model'
  )
}

/**
 * 构建会话摘要。
 *
 * @param {Array} events - session.events 快照。
 * @param {object} opts
 * @param {number} [opts.tail=24] 保留全文的最近消息条数（仅计 user/assistant）。
 * @param {number} [opts.userMaxChars=600] 旧消息单条 user 截断长度。
 * @param {number} [opts.assistantMaxChars=400] 旧消息单条 assistant 截断长度。
 * @returns {{ text: string, stats: object }} text=摘要文本。
 */
export function buildDigest(events, opts = {}) {
  const tail = opts.tail ?? 24
  const userMaxChars = opts.userMaxChars ?? 600
  const assistantMaxChars = opts.assistantMaxChars ?? 400

  const pairs = []
  let lastAssistant = -1
  for (const event of events || []) {
    if (isUserMessage(event)) {
      pairs.push({ role: 'user', text: messageText(event.data.content), tools: [] })
      lastAssistant = -1
    } else if (isAssistantMessage(event)) {
      pairs.push({
        role: 'assistant',
        text: messageText(event.data.message.content),
        tools: []
      })
      lastAssistant = pairs.length - 1
    } else if (event.type === 'tool/call' && lastAssistant >= 0) {
      // 模型发起的工具调用：挂到最近的 assistant 行（压缩行显示工具名）
      const name = event.data && typeof event.data.name === 'string' ? event.data.name : '?'
      const row = pairs[lastAssistant]
      if (row && !row.tools.includes(name)) row.tools.push(name)
    }
  }

  const total = pairs.length
  const kept = Math.max(0, Math.min(tail, total))
  const head = pairs.slice(0, Math.max(0, total - kept))
  const recent = pairs.slice(Math.max(0, total - kept))

  const lines = []
  // 更早的回合压缩为摘要行
  for (const p of head) {
    if (!p.text && p.tools.length === 0) continue
    if (p.role === 'user') {
      lines.push(`USER: ${p.text.replace(/\s+/g, ' ').slice(0, userMaxChars)}`)
    } else {
      if (p.tools.length > 0) {
        lines.push(`ASSISTANT[tools: ${p.tools.join(', ')}]`)
      }
      if (p.text) {
        lines.push(`ASSISTANT: ${p.text.replace(/\s+/g, ' ').slice(0, assistantMaxChars)}`)
      }
    }
  }
  // 最近 tail 条全文
  for (const p of recent) {
    if (!p.text && p.tools.length === 0) continue
    if (p.role === 'user') {
      lines.push(`## 用户\n${p.text}`)
    } else {
      if (p.tools.length > 0) {
        lines.push(`## 助手（调用工具：${p.tools.join(', ')}）`)
      }
      if (p.text) {
        lines.push(`## 助手\n${p.text}`)
      }
    }
  }

  const stats = { total, kept: recent.length, compressed: head.length }
  return { text: lines.join('\n\n'), stats }
}

/**
 * 按字符上限裁剪摘要文本（保留头部，附截断说明）。
 * @param {string} text
 * @param {number} maxChars
 */
export function truncateDigest(text, maxChars) {
  if (!text || text.length <= maxChars) return text
  const head = text.slice(0, maxChars)
  const cut = head.lastIndexOf('\n\n## ')
  return (
    (cut > maxChars * 0.6 ? head.slice(0, cut) : head) +
    `\n\n[会话历史过长，已按 ${maxChars} 字符截断；如需完整历史请单独查看会话记录]`
  )
}