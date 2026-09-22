/**
 * 把一段程序交给 `ctx.ptcRuntime` 执行（phase1-plan §2）。
 *
 * 引擎负责四件事：组装程序正文（外壳 + 用户源码）、把 `dispatchsubagent` 与
 * `process` / `processOrThrow` 作为 `flow` 绑定命名空间挂上、**让一次 run 的在飞外部执行在 run
 * 结束前真正静默**（阶段 3）、把 PTC 的结果渲染成模型可读文本。
 * 程序失败**不是**异常——它是结果里的一个字段（design.md §3.3 的同一条理由）。
 * @module dsh-execution-engine/engine
 */

import { randomUUID } from 'node:crypto'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { PtcBindingFunction, PtcJsonValue, PtcRunResult, PtcRuntime } from '@deepseek-ai/dsh-ptc-runtime'
import type { SandboxExecutionPolicy, SandboxProvider } from '@deepseek-ai/dsh-sandbox'
import type { SubagentRuntime } from '@deepseek-ai/dsh-subagent'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { guestSource } from './capabilities.ts'
import type { ProcessTimeouts } from './config.ts'
import { createProcessBindings } from './process-binding.ts'
import { createSubagentBindings } from './subagent-binding.ts'
import { createRunTmpDir, removeRunTmpDir } from './tmp-dir.ts'

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
 * @param request - 程序正文、cwd、发起者、可选的已解析文件策略、取消信号。
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
