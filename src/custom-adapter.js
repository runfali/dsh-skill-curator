/**
 * dsh-skill-curator — 评审自定义端点适配器。
 *
 * 发哥要求评审子代理的 base_url / model_id / api_key / provider 全部可自定义。
 * DSH 的 AgentOptions 只承载 provider/model/maxTokens（无端点与凭据字段），
 * 所以自定义端点走 llm.registerAdapter 路由：插件注册一个专用 provider 路由
 * （默认 'skill-curator-review'），adapter 在每次 stream 时从设置闭包读取
 * reviewBaseUrl / reviewApiKey（设置热改即时生效，无需重注册）。
 *
 * 实现为鸭子对象（非 extends LlmAdapter）：唯一的纯抽象方法 stream() 必实现，
 * 其余（providerInfo/listModels/resolveModel/prepareCall/retryPolicy）提供最小
 * 语义；wire 格式为 OpenAI 兼容 /chat/completions（非流式），输出转成
 * StreamChunk 协议（block-start → deltas → block-end → finish），并正确
 * 表达模型发起的工具调用（tool-call 块），使评审子代理的 skill-library-*
 * 工具链路可用。
 */

/** 消息内容块 → OpenAI content 文本（text/tool-result 等非图块）。 */
export function blocksToOpenAiText(content) {
  const parts = []
  for (const block of content || []) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    else if (block.type === 'tool-result') {
      parts.push(`[tool result ${block.toolCallId}: ${typeof block.content === 'string' ? block.content : JSON.stringify(block.content)}]`)
    } else {
      parts.push(`[${block.type} block]`)
    }
  }
  return parts.join('\n')
}

/** role 归一化（tool 结果在 OpenAI 兼容端点里以 user 角色回灌）。 */
export function openAiRole(role) {
  if (role === 'assistant' || role === 'user' || role === 'system') return role
  return 'user'
}

/** 终端块索引：文本块 0，工具调用块 1..n（每组 start→end 完整）。 */
export async function* streamChunksFromOpenAi(data) {
  const choice = data && data.choices && data.choices[0]
  const message = choice && choice.message
  const text = message && typeof message.content === 'string' ? message.content : ''
  const toolCalls = message && Array.isArray(message.tool_calls) ? message.tool_calls : []

  let index = 0
  if (text) {
    yield { type: 'block-start', index, blockType: 'text' }
    if (text) yield { type: 'text-delta', index, text }
    yield { type: 'block-end', index, block: { type: 'text', text } }
    index += 1
  }
  for (const tc of toolCalls) {
    const id = String((tc && tc.id) || `call_${index}`)
    const name = tc && tc.function && typeof tc.function.name === 'string' ? tc.function.name : ''
    const args = tc && tc.function && typeof tc.function.arguments === 'string' ? tc.function.arguments : '{}'
    yield { type: 'block-start', index, blockType: 'tool-call' }
    yield { type: 'tool-call-delta', index, id, name, argumentsDelta: args }
    yield { type: 'block-end', index, block: { type: 'tool-call', id, name, arguments: args } }
    index += 1
  }
  if (choice && choice.finish_reason === 'tool_calls') {
    yield { type: 'finish', reason: 'tool-calls' }
  } else {
    yield { type: 'finish', reason: choice && choice.finish_reason === 'length' ? 'max-tokens' : 'stop' }
  }
}

/**
 * 创建自定义端点适配器（鸭子实现）。
 *
 * @param {() => object} getSpec - 读取当前设置快照（reviewBaseUrl/reviewApiKey/reviewModel）。
 * @param {string} route - 注册给该适配器的 provider 路由名。
 */
export function createCustomAdapter(getSpec, route) {
  const endpoints = () => {
    const s = getSpec() || {}
    return {
      baseUrl: String(s.reviewBaseUrl || '').trim().replace(/\/+$/, ''),
      apiKey: String(s.reviewApiKey || ''),
      model: String(s.reviewModel || '').trim()
    }
  }
  const modelInfo = (provider, model) => ({ provider, id: model, name: model })

  return {
    providerInfo(provider) {
      return { id: provider, name: `Skill review (${provider})` }
    },
    providerRetryPolicy() {
      return undefined
    },
    async listModels(provider) {
      const c = endpoints()
      return c.model ? [modelInfo(provider, c.model)] : []
    },
    async resolveModel(provider, model, _signal) {
      const c = endpoints()
      return modelInfo(provider, model || c.model || 'unknown')
    },
    async prepareCall(provider, model, signal) {
      const info = await this.resolveModel(provider, model, signal)
      return { model: info, stream: (options) => this.stream(options) }
    },
    async *stream(options) {
      const c = endpoints()
      if (!c.baseUrl) throw new Error(`custom review endpoint not configured (provider=${options.provider}); set reviewBaseUrl + reviewModel + reviewApiKey`)
      const baseUrl = c.baseUrl.includes('/chat/completions') ? c.baseUrl : `${c.baseUrl}/chat/completions`
      const payload = {
        model: options.model || c.model,
        messages: (options.messages || []).map((m) => ({
          role: openAiRole(m.role),
          content: blocksToOpenAiText(m.content)
        })),
        ...(options.tools && options.tools.length
          ? { tools: options.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters || {} } })) }
          : {}),
        ...(typeof options.maxTokens === 'number' ? { max_tokens: options.maxTokens } : {}),
        ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
        stream: false
      }
      const res = await fetch(baseUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          ...(c.apiKey ? { authorization: `Bearer ${c.apiKey}` } : {})
        },
        body: JSON.stringify(payload),
        signal: options.signal
      })
      if (!res.ok) {
        const detail = await res.text().catch(() => '')
        throw new Error(`custom review endpoint HTTP ${res.status}: ${detail.slice(0, 300)}`)
      }
      const data = await res.json()
      yield* streamChunksFromOpenAi(data)
    }
  }
}