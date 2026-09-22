/**
 * `dispatchsubagent`：程序里那个非确定的洞（design.md §3.2、§5.1；phase2-plan §2）。
 *
 * 归属只有一个落点：`SubagentStartRequest.parent`——发起本次 `run_program` 调用的主 agent。
 * 子 agent 的最终文本只经 PTC 控制通道回到程序，不进主 agent 上下文（design.md §5.1、§12）。
 *
 * 本模块**不引入任何包**：纯 Node 的 `pnpm run test` 要能直接加载它（phase1-plan §10 A 档）。
 * 跨包引用一律 `import type`，运行时被擦除。
 * @module dsh-execution-engine/subagent-binding
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { PtcBindingFunction } from '@deepseek-ai/dsh-ptc-runtime'
import type { SubagentResult, SubagentRuntime, SubagentStopReason } from '@deepseek-ai/dsh-subagent'

/** `createSubagentBindings` 需要的外部依赖、本次 run 的权威与取消信号。 */
export interface SubagentBindingOptions {
  /**
   * 发起本次 run 的主 agent；每个子 agent 都挂在它下面（design.md §5.1）。
   * 必填：缺席在这里不可表达，装配方必须先把发起者拿到手——静默换一个 parent 会直接破坏归属承诺
   * （判空在唯一的取用处 `host/index.ts`）。
   */
  readonly parent: Agent
  /** 部署配置里的 provider 名（`subagentProvider`）；引擎不写死。 */
  readonly provider: string
  /** run 级取消信号；子 agent 跟着一起取消。 */
  readonly signal: AbortSignal
  /** 子 agent 执行缝。 */
  readonly subagents: SubagentRuntime
  /** dispose 失败一类非致命问题的告警出口；它不改变已经选定的结果。 */
  readonly warn: (message: string) => void
}

/**
 * 子 agent 非正常完成时抛出的错误（phase2-plan §9 Q1 的裁决：抛出，而不是静默把失败当成功）。
 *
 * 消息照 `packages/subagent/tool-subagent/src/index.ts:183-195` 的形态：先给结束类别，再补
 * provider 写的 diagnostic 与结束前已经产生的部分输出。`SubagentResult` 把这两项定义为有意的
 * 信息通道（`packages/subagent/subagent/src/types.ts:288-294`），丢掉它们就是把"为什么失败"和
 * "已经拿到什么"一起藏起来（design.md §1.3）。
 *
 * `stopReason` 同时挂成属性：同一个进程里的调用方按类别分支，不必从消息文本里认。
 * 程序那一侧看不到它——PTC 控制通道只带 `message` 过边界（`ptc-runtime-node` 的
 * `messageOf(error)`），所以程序仍然读消息文本。
 */
export class SubagentRunEndedError extends Error {
  /** 子 agent 的结束类别，与 `SubagentResult.stopReason` 逐字相同。 */
  readonly stopReason: SubagentStopReason

  /**
   * @param result - 子 agent 的终态结果。
   */
  constructor(result: SubagentResult) {
    super(endedMessage(result))
    this.name = 'SubagentRunEndedError'
    this.stopReason = result.stopReason
  }
}

/**
 * `dispatchsubagent` 的实现。子 agent 非正常完成时**抛出**（phase2-plan §9 Q1 的裁决）：
 * 静默返回一段可能是错误信息的文本会让失败伪装成成功，程序自己 `try/catch` 决定重试或改道。
 * @param options - provider、发起者、取消信号与告警出口。
 * @returns 注册进 PTC `flow` 绑定命名空间的函数。
 */
export function createSubagentBindings(options: SubagentBindingOptions): Record<string, PtcBindingFunction> {
  return {
    dispatchsubagent: (args: unknown) => runSubagent(options, readPrompt(args)),
  }
}

/**
 * 派一个子 agent 并等它结束。
 *
 * `run.dispose()` 放进 `finally`：漏了就会漏子 agent。dispose 自己的失败只记日志，
 * 不顶掉已经选定的结果（先例 `packages/workflow/workflow-ptc/src/host.ts:240-244` 的 `disposeChild`）。
 * @param options - provider、发起者、取消信号与告警出口。
 * @param prompt - 交给子 agent 的 prompt 正文。
 * @returns 子 agent 的最终文本。
 * @throws 子 agent 非正常完成或起动晚于取消，或 provider 起动失败。
 */
async function runSubagent(options: SubagentBindingOptions, prompt: string): Promise<string> {
  options.signal.throwIfAborted()
  // 归属就是这一个入参：provider 从它派生子 agent 的会话 lineage 与工作目录。
  const run = await options.subagents.start(options.provider, {
    prompt: [{ type: 'text', text: prompt }],
    parent: options.parent,
    signal: options.signal,
  })
  try {
    // provider 可以在起动挂起的这段里才 publish：信号此时已经中止，这次派发不该再有子 agent
    // （先例 `packages/workflow/workflow-ptc/src/host.ts:214-218`）。`finally` 负责把它 dispose 掉。
    if (options.signal.aborted) {
      throw new Error('dispatchsubagent: the subagent started after the run was cancelled')
    }
    const result = await raceWithAbort(run.result, options.signal)
    if (result.stopReason !== 'completed') {
      throw new SubagentRunEndedError(result)
    }
    return textOf(result.output)
  } finally {
    try {
      await run.dispose()
    } catch (error: unknown) {
      options.warn(`execution-engine: dispatchsubagent dispose failed: ${renderThrown(error)}`)
    }
  }
}

/**
 * 等子 agent 的终态，但信号一中止就不再等。
 *
 * 只 `await run.result` 时，provider 的 `result` 不因 abort 而 settle，这次派发就会永远挂着，
 * `finally` 里的 dispose 也就永远不会执行——留下一个孤儿 run。形态照
 * `packages/workflow/workflow-ptc/src/host.ts:222-238`。
 * @param result - 子 agent 的终态 promise。
 * @param signal - run 级取消信号。
 * @returns 子 agent 的终态。
 * @throws signal 的中止原因。
 */
async function raceWithAbort(result: Promise<SubagentResult>, signal: AbortSignal): Promise<SubagentResult> {
  const aborted = Promise.withResolvers<never>()
  const onAbort = (): void => { aborted.reject(signal.reason) }
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    return await Promise.race([result, aborted.promise])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

/**
 * 把非正常结束渲染成一条诊断消息：结束类别，加上存在的 provider 诊断与部分输出。
 * @param result - 子 agent 的终态结果。
 * @returns 给程序和上层看的失败文本。
 */
function endedMessage(result: SubagentResult): string {
  const diagnostic = result.diagnostic === undefined ? '' : `\nDiagnostic: ${result.diagnostic}`
  const text = textOf(result.output)
  const partial = text.length === 0 ? '' : `\nPartial output before the run ended:\n${text}`
  return `dispatchsubagent: subagent run ended with ${result.stopReason}${diagnostic}${partial}`
}

/**
 * 把子 agent 的最终内容块折成文本。design.md §3.2 的原语面只承诺一段文本，
 * 所以非文本块在这里被丢掉（`structured` 不在阶段 2 的原语面里）。
 * @param output - 子 agent 的最终助理内容块。
 * @returns 拼接后的文本；没有文本块时为空串。
 */
function textOf(output: readonly ContentBlock[]): string {
  return output
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('')
}

/**
 * 校验程序给的参数。程序是外部输入，所以这里是运行期的解析边界：必须是一个带字符串
 * `prompt` 的对象（形态与 `process` 的 `{ argv }` 一致）。
 * @param value - 绑定调用收到的单个参数值。
 * @returns prompt 正文。
 */
function readPrompt(value: unknown): string {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('dispatchsubagent requires an argument object with a prompt string')
  }
  const prompt = (value as Record<string, unknown>).prompt
  if (typeof prompt !== 'string') {
    throw new TypeError('dispatchsubagent requires a prompt string')
  }
  return prompt
}

/** 把任意抛出物渲染成一行诊断文本。 */
function renderThrown(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
