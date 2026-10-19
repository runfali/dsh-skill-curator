/**
 * dsh-skill-curator — 子代理运行结算（内联实现）。
 *
 * 为什么内联而不是从宿主导入（2026-10-18 适配轮实测）：
 *   `@deepseek-ai/dsh-subagent` 0.2.1-rc.2 的**包根不再导出 `settleRun`**——
 *   根导出清单只剩 `settleRunResult`。实现仍在 `lib/types/run-settlement.js`，
 *   但该包的 `exports` 只有
 *   `.` / `./internal` / `./client` / `./typert` / `./remote` / `./src/*`，
 *   **没有对应子路径**，`src/` 也不随包发布（files 只含 lib）。
 *   → 外部拿不到它，模块顶层 `import { settleRun }` 会在 ESM 链接期抛
 *   SyntaxError，`apply()` 从未执行，**整个插件全死**。
 *
 *   本地 `node_modules` 那份夹具是 0.2.0-rc.1（仍有该导出），所以这个故障
 *   在 `npm test` 里永远看不见 —— 夹具保真度问题，不是逻辑问题。
 *
 * 语义与宿主 0.2.1 逐条对齐（lib/types/run-settlement.js:30-69）：
 *   - completed            → { status:'completed', result: <文本块拼接> }
 *   - aborted 无 diagnostic → { status:'killed' }（空串也算「有」→ failed）
 *   - aborted 有 diagnostic / error / max-tokens / refusal / 其他 → failed + detail
 *   - result 拒绝          → failed（**永不 reject**）
 *   - dispose 失败         → failed，原 detail 前缀保留
 *   - 任何路径都调用 dispose（资源必须释放）
 *
 * 契约稳定性：这是宿主自 0.1.5 起从未改变的三态语义，内联后不再随宿主
 * 导出面漂移；宿主若再改字段名，本文件的守护测试会红。
 */

/** 子代理最终输出里的文本块拼接（非文本块不计入）。 */
function finalText(blocks) {
  if (!Array.isArray(blocks)) return ''
  return blocks
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('')
}

/** 失败原因渲染：带 provider 诊断时拼上，否则只用 stopReason。 */
function failureDetail(result) {
  const stopReason = result.stopReason
  return result.diagnostic === undefined
    ? stopReason
    : `${stopReason}; diagnostic: ${result.diagnostic}`
}

/**
 * 把一次子代理的终态结果映射成任务结果（与宿主 runOutcome 同形）。
 * @param {object} result - 子代理终态（`{ output, stopReason, diagnostic? }`）。
 * @returns {{status: string, result?: string, detail?: string}}
 */
export async function runOutcome(result) {
  const stopReason = result && result.stopReason
  switch (stopReason) {
    case 'completed':
      return { status: 'completed', result: finalText(result.output) }
    case 'aborted':
      // 本地取消（无诊断）判 killed；provider 自述的诊断判 failed。
      return result.diagnostic === undefined
        ? { status: 'killed' }
        : { status: 'failed', detail: failureDetail(result) }
    case 'error':
    case 'max-tokens':
    case 'refusal':
      return { status: 'failed', detail: failureDetail(result) }
    default:
      // 可合并扩展的 stopReason 一律按失败处理，不假装成功。
      return { status: 'failed', detail: failureDetail(result) }
  }
}

/**
 * 等子代理终态、释放资源、返回任务结果。**永不 reject**：结果与释放的失败都转成 status。
 * @param {{result: Promise<object>, dispose: () => Promise<unknown>}} run - 活着的 run 句柄。
 * @returns {Promise<{status: string, result?: string, detail?: string}>}
 */
export async function settleRun(run) {
  let outcome
  try {
    outcome = await runOutcome(await run.result)
  } catch (error) {
    outcome = { status: 'failed', detail: String(error) }
  }
  try {
    await run.dispose()
  } catch (error) {
    const prefix = outcome.detail === undefined ? '' : `${outcome.detail}; `
    return { status: 'failed', detail: `${prefix}dispose failed: ${String(error)}` }
  }
  return outcome
}
