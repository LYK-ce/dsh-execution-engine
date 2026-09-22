/**
 * `dispatchsubagent`：程序里那个非确定的洞（design.md §3.2、§5.1；phase2-plan §2）。
 *
 * 归属只有一个落点：`SubagentStartRequest.parent`——发起本次 `run_program` 调用的主 agent。
 * 子 agent 的最终文本只经 PTC 控制通道回到程序，不进主 agent 上下文（design.md §5.1、§12）。
 *
 * 程序可以显式指定这一步用哪个 `{ provider, model }`（design.md §3.2、§12 阶段 8）。授权来源是
 * 部署挂的 `ctx.subagentModelSelection` 策略：命中清单才转发成 `agentOptions`，服务缺席或没命中
 * 就抛——引擎不新造第二份白名单，也不查 LLM 目录（见 `assertAllowedRoute`）。
 *
 * 本模块**不引入任何包**：纯 Node 的 `pnpm run test` 要能直接加载它（phase1-plan §10 A 档）。
 * 跨包引用一律 `import type`，运行时被擦除。
 * @module dsh-execution-engine/subagent-binding
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { PtcBindingFunction } from '@deepseek-ai/dsh-ptc-runtime'
import type { SubagentResult, SubagentRuntime, SubagentStopReason } from '@deepseek-ai/dsh-subagent'

/**
 * 一条子 agent LLM 路由。`provider` 与 `model` 必须成对出现：只给一个会变成"用这个 provider
 * 配父 agent 的 model"那种未必存在的组合（phase8-plan §2）。
 */
export interface SubagentModelRoute {
  /** LLM provider id，逐字转发给 `ctx.subagents.start`。 */
  readonly provider: string
  /** 该 provider 下的 model id，同样逐字转发。 */
  readonly model: string
}

/**
 * 本部署允许显式指定的子 agent LLM 路由清单（`ctx.subagentModelSelection.current()` 的读取结果）。
 *
 * `undefined`（服务缺席）表示这个部署没有授权来源，显式指定一律拒绝——放行会把"部署说了算"
 * 重新变成"调用方说了算"（phase8-plan §3.2、§10 Q1）。
 */
export interface SubagentModelSelection {
  /** 策略是否开启；关闭时清单里的路由一条都不算数。 */
  readonly enabled: boolean
  /** 允许显式选择的路由；同一对 provider/model 至多一条。 */
  readonly allowedModels: readonly SubagentModelRoute[]
}

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
  /**
   * 读本部署允许的显式子 agent 路由。做成访问器而不是一次取值：策略可以在 run 期间改变，
   * 而校验的对象是**这一次调用**的参数，所以每次调用现读（phase8-plan §3.3、§9 R2）。
   * 返回 `undefined` 表示这个部署没有挂策略服务。
   */
  readonly modelSelection: () => SubagentModelSelection | undefined
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
 * @param options - provider、发起者、取消信号、路由策略与告警出口。
 * @returns 注册进 PTC `flow` 绑定命名空间的函数。
 */
export function createSubagentBindings(options: SubagentBindingOptions): Record<string, PtcBindingFunction> {
  return {
    dispatchsubagent: (args: unknown) => runSubagent(options, readRequest(args)),
  }
}

/**
 * 派一个子 agent 并等它结束。
 *
 * `run.dispose()` 放进 `finally`：漏了就会漏子 agent。dispose 自己的失败只记日志，
 * 不顶掉已经选定的结果（先例 `packages/workflow/workflow-ptc/src/host.ts:240-244` 的 `disposeChild`）。
 * @param options - provider、发起者、取消信号、路由策略与告警出口。
 * @param request - 已解析的 prompt 正文与可选显式路由。
 * @returns 子 agent 的最终文本。
 * @throws 取消早于起动、显式路由不被允许、子 agent 非正常完成，或 provider 起动失败。
 */
async function runSubagent(options: SubagentBindingOptions, request: SubagentRequest): Promise<string> {
  // 取消先于一切：已经中止的 run 不该再有任何按参数分支的行为。
  options.signal.throwIfAborted()
  if (request.route !== undefined) assertAllowedRoute(options.modelSelection(), request.route)
  // 归属就是这一个入参：provider 从它派生子 agent 的会话 lineage 与工作目录。
  // `agentOptions` 只在程序显式指定了路由时出现：省略它才是"继承父 agent"（phase8-plan §0 B），
  // 合并语义归 `packages/subagent/subagent/src/child-agent.ts:99-120`。
  const run = await options.subagents.start(options.provider, {
    prompt: [{ type: 'text', text: request.prompt }],
    parent: options.parent,
    signal: options.signal,
    ...request.route === undefined
      ? {}
      : { agentOptions: { provider: request.route.provider, model: request.route.model } },
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

/** 一条 `dispatchsubagent` 调用：prompt 正文加上可选的显式路由。 */
interface SubagentRequest {
  /** 交给子 agent 的 prompt 正文。 */
  readonly prompt: string
  /** 程序显式指定的路由；省略表示沿用当前会话的模型。 */
  readonly route?: SubagentModelRoute
}

/**
 * 校验程序给的参数。程序是外部输入，所以这里是运行期的解析边界：必须是一个带字符串
 * `prompt` 的对象（形态与 `process` 的 `{ argv }` 一致），而 `provider` 与 `model` 要么都省略、
 * 要么都给出非空字符串（phase8-plan §2）。
 *
 * 只给一个就抛而不是回落：把"我要 X 模型"静默变成"我要父 provider 下的 X 模型"，会把失败点
 * 推到下游看不见的地方。
 * @param value - 绑定调用收到的单个参数值。
 * @returns 已解析的 prompt 与可选路由。
 * @throws 参数不是约定的对象形态、prompt 不是字符串，或路由字段缺失/不合法。
 */
function readRequest(value: unknown): SubagentRequest {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('dispatchsubagent requires an argument object with a prompt string')
  }
  const source = value as Record<string, unknown>
  const prompt = source.prompt
  if (typeof prompt !== 'string') {
    throw new TypeError('dispatchsubagent requires a prompt string')
  }
  const provider = source.provider
  const model = source.model
  if (provider === undefined && model === undefined) return { prompt }
  if (provider === undefined) throw new Error('dispatchsubagent: `model` requires `provider`')
  if (model === undefined) throw new Error('dispatchsubagent: `provider` requires `model`')
  return {
    prompt,
    route: { provider: readRouteId(provider, 'provider'), model: readRouteId(model, 'model') },
  }
}

/**
 * 读一个路由字段。措辞照 `list_subagent_models` 的两条
 * （`packages/subagent/tool-subagent/src/list-models.ts:56,69`）：非字符串与空串分开报，
 * 所以"忘了填"和"填错了"在程序那条错误消息里就能分开。
 * @param value - 待判定的值。
 * @param field - 报错时点名字段；用程序侧的原名。
 * @returns 同一个非空字符串。
 * @throws 它不是字符串，或它是空串时。
 */
function readRouteId(value: unknown, field: 'provider' | 'model'): string {
  if (typeof value !== 'string') throw new TypeError(`dispatchsubagent: \`${field}\` must be a string`)
  if (value.length === 0) throw new TypeError(`dispatchsubagent: \`${field}\` must be non-empty`)
  return value
}

/**
 * 错误消息里最多列出的 route 条数，超出加一个省略号。清单是人工维护的小表格，但它是部署配置，
 * 而这段文本进程序抛出的异常、可能被程序原样带进上下文，所以照 `boundContextSummary` 的做法给它
 * 一个界（phase8-plan §9 R6）。截断只影响诊断：模型仍可用 `list_subagent_models` 看全。
 */
const MAX_LISTED_ROUTES = 12

/**
 * 校验显式指定的路由确实在这个部署允许的清单里。
 *
 * 只查策略，不查别的：**不查 `ctx.llm` 的目录**（`LlmModelInfo` 的目录成员资格是 advisory，
 * 不是请求校验，见 `list-models.ts:92-93`），**也不查 provider 的能力位**——
 * `ctx.subagents.start` 自己会拒（`packages/subagent/subagent/src/index.ts:641-643`），
 * 再加一道只是重复。
 * @param selection - 本次调用现读的策略；`undefined` 表示部署没有挂策略服务。
 * @param route - 程序显式指定的路由。
 * @throws 策略缺席、没有开启、清单为空，或这条 route 不在清单里。
 */
function assertAllowedRoute(selection: SubagentModelSelection | undefined, route: SubagentModelRoute): void {
  // 缺席、关掉、空清单折成同一件事：这个部署没有授权任何可选路由，三者对调用方的后果完全相同。
  // 其中 `enabled && allowedModels.length === 0` 在生产里不可达（`model-selection-settings` 加载与写入
  // 两侧都拒），保留它只是不代 `ctx.get` 拿到的实现断言"这条不会出现"。
  const allowed = selection === undefined || !selection.enabled ? [] : selection.allowedModels
  if (allowed.some(candidate => candidate.provider === route.provider && candidate.model === route.model)) return
  throw new Error(
    `dispatchsubagent: child LLM route "${route.provider}/${route.model}" is not allowed for this Session; `
    + `available routes: ${renderRoutes(allowed)}`,
  )
}

/**
 * 把可用路由折成一行：`provider/model` 逗号分隔，没有可选路由时是 `(none)`——后者就是"这个部署
 * 没有授权任何路由"在消息里的说法（形态照 `list-models.ts:23-27` 的 available 列表）。
 * @param routes - 本次部署允许的路由。
 * @returns 有界的单行清单。
 */
function renderRoutes(routes: readonly SubagentModelRoute[]): string {
  if (routes.length === 0) return '(none)'
  const listed = routes.slice(0, MAX_LISTED_ROUTES).map(route => `${route.provider}/${route.model}`)
  if (routes.length > listed.length) listed.push('…')
  return listed.join(', ')
}

/** 把任意抛出物渲染成一行诊断文本。 */
function renderThrown(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
