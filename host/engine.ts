/**
 * 把一段程序交给 `ctx.ptcRuntime` 执行（phase1-plan §2）。
 *
 * 引擎负责四件事：组装程序正文（外壳 + 用户源码）、把 `dispatchsubagent`、
 * `process` / `processOrThrow`、`report` 与内部的 `trace` 作为 `flow` 绑定命名空间挂上、
 * **让一次 run 的在飞外部执行在 run 结束前真正静默**（阶段 3）、把 PTC 的结果渲染成模型可读文本。
 * 程序失败**不是**异常——它是结果里的一个字段（design.md §3.3 的同一条理由）。
 *
 * `trace` 是阶段 5 加的内部通道：外壳的包装函数经它上报调用点位置，本模块把它折成
 * `flow/call-start` / `flow/call-end`。它**不是原语**，程序看不见它（见 `runProgram` 里的挂载处）。
 *
 * `report` 的投递助手（`createUserMessage` 与 `boundContextSummary`）在这里注入，是因为
 * `host/report-binding.ts` 要能在纯 Node 的 `pnpm run test` 下加载：本模块只经 tsx 装配，
 * 而那个模块不是（理由见 `host/config.ts` 的模块头与 `host/report-binding.ts` 的模块头）。
 * @module dsh-execution-engine/engine
 */

import { randomUUID } from 'node:crypto'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { PtcBindingFunction, PtcJsonValue, PtcRunResult, PtcRuntime } from '@deepseek-ai/dsh-ptc-runtime'
import type { SandboxExecutionPolicy, SandboxProvider } from '@deepseek-ai/dsh-sandbox'
import type { SubagentRuntime } from '@deepseek-ai/dsh-subagent'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { guestSource } from './capabilities.ts'
import type { ProcessTimeouts } from './config.ts'
import type { FlowCallEndEvent, FlowCallStartEvent } from './flow-events.ts'
import { createProcessBindings } from './process-binding.ts'
import { createReportBindings } from './report-binding.ts'
import type { ReportLedger } from './report-binding.ts'
import { createSubagentBindings } from './subagent-binding.ts'
import { createRunTmpDir, removeRunTmpDir } from './tmp-dir.ts'

/** 一条 `flow/call-start` 事件去掉 run 身份后的部分；身份由 `host/job-runner.ts` 补。 */
export type FlowCallStart = Omit<FlowCallStartEvent, 'runId'>

/** 一条 `flow/call-end` 事件去掉 run 身份后的部分；身份由 `host/job-runner.ts` 补。 */
export type FlowCallEnd = Omit<FlowCallEndEvent, 'runId'>

/**
 * 外壳上报原语调用的出口（阶段 5）。
 *
 * 外壳的包装函数按 fire-and-forget 调 `flow.trace`，本模块把每条记录折成上面两种事件之一后交给
 * 这个出口；run 身份（job id）只有提交那次 run 的 `host/job-runner.ts` 拿得到，所以由它补。
 * 前两个方法必须是同步的：`ctx.emit` 是同步的，挂起的上报会让事件顺序变得不可解释。
 *
 * `closeOpenCalls` 是"每次调用恰好一对"在终止路径上的最后一手：`end` 由 guest 侧那条 `.then`
 * 发出，而取消、超时与"不 `await` 就 `return`"都会让 guest 先死掉，在飞的调用再也回不到那条
 * `.then`。未闭合的记账与补发都在 `host/job-runner.ts` 里，因为 run 的终态与 run 身份都在那里，
 * 而那个模块不许有运行时依赖（见它的模块头）。
 */
export interface FlowCallSink {
  /** 一次原语调用开始。 */
  start(call: FlowCallStart): void
  /** 一次原语调用结算（正常返回或抛出）。 */
  end(call: FlowCallEnd): void
  /**
   * 为本次 run 仍未闭合的调用补发合成的 `end`（`outcome: 'error'`、`synthetic: true`），然后清空
   * 记账。没有未闭合的调用时什么也不发。
   *
   * 调用点必须是 run 的终态、且在 `flow/end` **之前**：面板要先看到所有调用闭合，再看到 run 结束。
   * @param termination - 写进合成错误文本的终止说明（取消原因，或终态分类）。
   */
  closeOpenCalls(termination: string): void
}

/** 一次 `run_program` 的执行请求：程序正文加上发起会话现场快照下来的权威。 */
export interface RunProgramRequest {
  /** 用户写的程序源码。 */
  readonly code: string
  /** 本次执行的工作目录。 */
  readonly cwd: string
  /** 发起本次 run 的主 agent；每个 `dispatchsubagent` 派出的子 agent 都挂在它下面（design.md §5.1）。 */
  readonly parent: Agent
  /** provider 支持限定时一并快照的文件策略；不支持时不传。 */
  readonly sandboxPolicy?: SandboxExecutionPolicy
  /** 本次调用的取消信号；abort 会终止程序与其在飞的子进程。 */
  readonly signal: AbortSignal
  /**
   * 本次 run 的 report 记账；由 job-runner 按 job 建，`report` 每次投递都记在它上面，
   * run 被取消时按它作废还没被领取的那部分（`host/job-runner.ts`）。
   */
  readonly reports: ReportLedger
  /**
   * 本次 run 的原语调用上报出口；由 job-runner 按 job 建，因为 run 身份（job id）在它那里
   * （`host/job-runner.ts`）。外壳的 `flow.trace` 绑定收到的每条记录都折成事件从这里出去。
   */
  readonly trace: FlowCallSink
}

/** `runProgram` 需要的外部服务与部署策略。 */
export interface RunProgramDeps {
  /** PTC 执行缝。 */
  readonly ptcRuntime: PtcRuntime
  /** 外部程序的执行缝。 */
  readonly subprocess: SubprocessRuntime
  /** 派子 agent 的执行缝。 */
  readonly subagents: SubagentRuntime
  /** 把 `process` 的 argv 包成受限执行形态的 provider。 */
  readonly sandbox: SandboxProvider
  /** 部署已解析的超时策略。 */
  readonly timeouts: ProcessTimeouts
  /** 部署配置里的子 agent provider 名。 */
  readonly subagentProvider: string
  /** 清理失败一类非致命问题的告警出口。 */
  readonly warn: (message: string) => void
}

/** 一次 `run_program` 的模型可见结果。 */
export interface RunProgramOutcome {
  /** 给模型看的文本：程序的返回值、程序自己写的输出，或失败原因。 */
  readonly output: string
  /**
   * 程序自己的结局。取消不在这里表达——那是 job 层对信号的判断（`host/job-runner.ts` 的
   * `toJobOutcome`），引擎这一层只分得清"跑完了"和"程序自己失败了"。
   */
  readonly status: 'completed' | 'failed'
  /** 失败的种类与原因（进 job 的 `detail`）；正常完成时缺席。 */
  readonly detail?: string
}

/**
 * 执行一段程序并等它结束，然后整体删除本次 run 的临时目录。
 *
 * 整段程序没有截止时间（`timeoutMs: null`）：它天然长跑，加整体截止会误杀正常任务
 * （design.md §9）。单次 `process` 的超时由 `process-binding.ts` 负责。
 *
 * `finally` 里的顺序就是"三层生命周期"那条链的末两跳：**先**等本次 run 派出去的外部执行真正
 * 收尾，**再**删临时目录。反过来的话，取消刚返回就会有一个旧进程还在往一个已经被删掉的目录里写。
 * 取消路径上的逐跳位置见 {@link trackExternalWork} 的说明。
 * @param deps - PTC / subprocess / subagents / sandbox 执行缝与部署的策略。
 * @param request - 程序正文、cwd、发起者、可选的已解析文件策略、取消信号、report 记账。
 * @returns 渲染好的模型可见结果与程序自己的结局分类。
 */
export async function runProgram(deps: RunProgramDeps, request: RunProgramRequest): Promise<RunProgramOutcome> {
  const tmpDir = await createRunTmpDir(request.cwd, randomUUID())
  // 组装绑定表不会启动任何东西，所以它可以放在 `try` 之外，好让 `finally` 里拿得到它。
  const external = trackExternalWork({
    ...createProcessBindings({
      subprocess: deps.subprocess,
      sandbox: deps.sandbox,
      cwd: request.cwd,
      ...request.sandboxPolicy === undefined ? {} : { sandboxPolicy: request.sandboxPolicy },
      signal: request.signal,
      timeouts: deps.timeouts,
    }),
    ...createSubagentBindings({
      parent: request.parent,
      provider: deps.subagentProvider,
      signal: request.signal,
      subagents: deps.subagents,
      warn: deps.warn,
    }),
    ...createReportBindings({
      owner: request.parent,
      signal: request.signal,
      ledger: request.reports,
      createMessage: createUserMessage,
      boundSummary: boundContextSummary,
    }),
    // 内部通道，不是原语：它挂在外壳拿到的 `flow` 命名空间上，**不进能力面**，所以程序看不见它
    // （`host/guest-source.ts` 的 `__dshMakeSurface` 只把四个原语与文件助手放进返回对象）。
    trace: createTraceBinding(request.trace),
  })
  try {
    const program = guestSource({ program: request.code, tmpDir, cwd: request.cwd })
    const result = await deps.ptcRuntime.run(deps.ptcRuntime.resolve({
      program,
      bindings: [{ global: 'flow', functions: external.functions }],
      cwd: request.cwd,
      timeoutMs: null,
      ...request.sandboxPolicy === undefined ? {} : { sandboxPolicy: request.sandboxPolicy },
      signal: request.signal,
    }))
    return renderOutcome(result)
  } finally {
    await external.drain()
    await removeRunTmpDir(tmpDir, deps.warn)
  }
}

/**
 * 把 PTC 结果渲染成模型可读文本。捕获输出在前、完成值在最后：值是这个工具的结果，
 * 放在尾部读起来是结论，也让"从尾部取返回值"这类消费者有一个稳定的落点。
 * 失败种类与原因是结果文本的一部分，不是异常路径，也不是工具失败标记。
 * @param result - PTC 的一次 run 结果。
 * @returns 模型可见的结果文本与结局分类。
 */
function renderOutcome(result: PtcRunResult): RunProgramOutcome {
  const captured = result.logs.length === 0 ? '' : `程序输出：\n${result.logs.join('\n')}\n\n`
  if (result.error !== undefined) {
    const detail = `${result.error.kind}: ${result.error.message}`
    return { output: `${captured}程序执行失败（${result.error.kind}）：${result.error.message}`, status: 'failed', detail }
  }
  return { output: `${captured}${renderValue(result.value)}`, status: 'completed' }
}

/**
 * 渲染程序的 `return` 值。值本来就是 lossless JSON（不是就被 PTC 判成 `invalid-output`），
 * 所以这里只做序列化。
 * @param value - PTC 交回的完成值；程序没有 `return` 时缺席。
 * @returns 模型可见的文本。
 */
function renderValue(value: PtcJsonValue | undefined): string {
  if (value === undefined) return '程序没有返回值。'
  return `程序返回值：\n${JSON.stringify(value, null, 2)}`
}

/**
 * 外壳 `trace(...)` 发来的一条记录。`phase` 决定后面哪些字段在场：
 *
 * - `start`：`args` / `argsTruncated`（实参预览）。
 * - `end`：`ms` / `outcome`，以及结果或错误二选一的 `text` / `textTruncated`。
 *
 * 成功与失败共用 `text` / `textTruncated` 而不是各留一套字段名：外壳的两条路径因此共用一段
 * 代码，"这是结果还是错误"已经由 `outcome` 说清。
 */
type TraceRecord =
  | {
    readonly phase: 'start'
    readonly callId: number
    readonly member: string
    readonly line: number | null
    readonly args: string
    readonly argsTruncated: boolean
  }
  | {
    readonly phase: 'end'
    readonly callId: number
    readonly member: string
    readonly line: number | null
    readonly ms: number
    readonly outcome: 'ok' | 'error'
    readonly text: string
    readonly textTruncated: boolean
  }

/**
 * `flow.trace` 绑定：把外壳的一条记录折成 `start` / `end` 两个事件之一。
 *
 * 记录从 guest 进程过来，所以这里逐项校验（`host/report-binding.ts` 的 `readText` 同形）——
 * 静默兜底会让面板显示一个编出来的位置。外壳按 fire-and-forget 调它，返回的 promise 那一侧
 * 只挂了收尾的拒绝处理器，所以被拒只影响诊断，不影响程序。
 * @param sink - 折好之后交出去的事件出口。
 * @returns 注册进 PTC `flow` 绑定命名空间的内部函数。
 */
function createTraceBinding(sink: FlowCallSink): PtcBindingFunction {
  return async (args: unknown): Promise<PtcJsonValue> => {
    const record = readTraceRecord(args)
    const call = { callId: record.callId, member: record.member, line: record.line }
    if (record.phase === 'start') {
      sink.start({ ...call, args: record.args, argsTruncated: record.argsTruncated })
      return null
    }
    const settled = { ...call, ms: record.ms, outcome: record.outcome }
    sink.end(record.outcome === 'ok'
      ? { ...settled, result: record.text, resultTruncated: record.textTruncated }
      : { ...settled, error: record.text, errorTruncated: record.textTruncated })
    return null
  }
}

/**
 * 解析外壳发来的跟踪记录。
 * @param value - `flow.trace` 绑定收到的参数。
 * @returns 已窄化的记录。
 * @throws 参数不是这条通道约定的形态时。
 */
function readTraceRecord(value: unknown): TraceRecord {
  const source = readTraceObject(value)
  const phase = source.phase
  if (phase !== 'start' && phase !== 'end') throw new TypeError('trace requires a phase of "start" or "end"')
  const callId = readTraceInteger(source.callId, 'trace callId', 0)
  const member = readTraceString(source.member, 'trace member')
  const line = source.line === null ? null : readTraceInteger(source.line, 'trace line', 1)
  if (phase === 'start') {
    return {
      phase,
      callId,
      member,
      line,
      args: readTraceString(source.args, 'trace args'),
      argsTruncated: readTraceBoolean(source.argsTruncated, 'trace argsTruncated'),
    }
  }
  const outcome = source.outcome
  if (outcome !== 'ok' && outcome !== 'error') throw new TypeError('trace requires an outcome of "ok" or "error"')
  return {
    phase,
    callId,
    member,
    line,
    ms: readTraceDuration(source.ms),
    outcome,
    text: readTraceString(source.text, 'trace text'),
    textTruncated: readTraceBoolean(source.textTruncated, 'trace textTruncated'),
  }
}

/**
 * 把一条跟踪记录窄化成普通对象。
 * @param value - 待判定的值。
 * @returns 同一个值，类型上是普通对象。
 * @throws 它不是普通对象时。
 */
function readTraceObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('trace requires an argument object')
  }
  return value as Record<string, unknown>
}

/**
 * 读一个必须存在的字符串字段。
 * @param value - 待判定的值。
 * @param label - 报错时点名字段；用 wire 上的原名。
 * @returns 同一个字符串。
 * @throws 它不是字符串时。
 */
function readTraceString(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new TypeError(`${label} must be a string`)
  return value
}

/**
 * 读一个必须存在且不低于下界的整数字段。
 * @param value - 待判定的值。
 * @param label - 报错时点名字段。
 * @param minimum - 允许的最小值（含）。
 * @returns 同一个整数。
 * @throws 它不是不小于下界的安全整数时。
 */
function readTraceInteger(value: unknown, label: string, minimum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) {
    throw new TypeError(`${label} must be an integer of at least ${String(minimum)}`)
  }
  return value
}

/**
 * 读一条 `end` 的耗时。
 *
 * 度量字段不合理（墙钟回跳把耗时变成负数）不构成"丢掉整条闭合事件"的理由：夹到非负照发，
 * 起始时刻本来就只有 guest 那一侧知道，为它整条不闭合是拿诊断换一个数字。它不是数字时仍然
 * 拒绝——那说明这条通道的形态坏了，不是单个字段偏了。
 * @param value - 待判定的值。
 * @returns 非负整数毫秒数。
 * @throws 它不是有限数字时。
 */
function readTraceDuration(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError('trace ms must be a finite number')
  }
  return Math.max(0, Math.round(value))
}

/**
 * 读一个必须存在的布尔字段。
 * @param value - 待判定的值。
 * @param label - 报错时点名字段。
 * @returns 同一个布尔值。
 * @throws 它不是布尔值时。
 */
function readTraceBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new TypeError(`${label} must be a boolean`)
  return value
}

/** 在飞绑定调用的登记处；见 {@link trackExternalWork}。 */
interface TrackedExternalWork {
  /** 交给 PTC 的 `flow` 绑定表，逐个包了登记。 */
  readonly functions: Record<string, PtcBindingFunction>
  /** 等当前在飞的全部绑定调用 settle；正常路径下它一直是空的。 */
  drain(): Promise<void>
}

/**
 * 记录一次 run 里所有绑定调用的在飞 promise，让 run 结束前能等它们真正收尾。
 *
 * **这一步是"取消等到清理完成"（design.md §4.4）能不能成立的关键，不是保险措施。**
 * `PtcRunRequest.signal` 的契约写着："在飞的绑定调用归**调用方**收尾——runtime 只是不再问了"
 * （`packages/ptc-runtime/ptc-runtime/src/types.ts:92-97`）。取消时 PTC 杀掉自己的子进程就
 * resolve，而宿主这一侧的 `process` 起的外部进程、`dispatchsubagent` 派出的子 agent 还在收尾。
 * 不等它们，"取消返回后立刻启动新的"就会撞上一个旧进程还在跑的世界，单例形同虚设。
 *
 * 在飞的那两个 promise 正好各自等到自己那一层的静默：`runProcess` 等到 `waitForExit()`
 * （`host/process-binding.ts`），`runSubagent` 等到 `run.dispose()`（`host/subagent-binding.ts`）。
 * @param functions - `flow` 命名空间的绑定表。
 * @returns 包好登记的绑定表与 drain。
 */
function trackExternalWork(functions: Record<string, PtcBindingFunction>): TrackedExternalWork {
  const inflight = new Set<Promise<PtcJsonValue>>()
  const tracked: Record<string, PtcBindingFunction> = {}
  for (const [name, call] of Object.entries(functions)) {
    tracked[name] = (args: unknown) => {
      const pending = call(args)
      inflight.add(pending)
      // 结果归 PTC 那一侧的 await 处理，这里只负责把它从在飞表里摘掉，所以拒绝在这里吞掉。
      void pending.then(
        () => { inflight.delete(pending) },
        () => { inflight.delete(pending) },
      )
      return pending
    }
  }
  return {
    functions: tracked,
    async drain() {
      // 循环而不是只等一次：中止期间还可能再排进一个调用，等表空为止。
      while (inflight.size > 0) await Promise.allSettled([...inflight])
    },
  }
}
