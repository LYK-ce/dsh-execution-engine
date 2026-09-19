/**
 * 把一段程序交给 `ctx.ptcRuntime` 执行（phase1-plan §2）。
 *
 * 引擎负责三件事：组装程序正文（外壳 + 用户源码）、把 `process` / `processOrThrow` 作为
 * `flow` 绑定命名空间挂上、把 PTC 的结果渲染成模型可读文本。程序失败**不是**异常——它
 * 是结果里的一个字段（design.md §3.3 的同一条理由）。
 * @module dsh-execution-engine/engine
 */

import { randomUUID } from 'node:crypto'
import type { PtcJsonValue, PtcRunResult, PtcRuntime } from '@deepseek-ai/dsh-ptc-runtime'
import type { SandboxExecutionPolicy, SandboxProvider } from '@deepseek-ai/dsh-sandbox'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { guestSource } from './capabilities.ts'
import type { ProcessTimeouts } from './config.ts'
import { createProcessBindings } from './process-binding.ts'
import { createRunTmpDir, removeRunTmpDir } from './tmp-dir.ts'

/** 一次 `run_program` 的执行请求：程序正文加上发起会话现场快照下来的权威。 */
export interface RunProgramRequest {
  /** 用户写的程序源码。 */
  readonly code: string
  /** 本次执行的工作目录。 */
  readonly cwd: string
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
  /** 把 `process` 的 argv 包成受限执行形态的 provider。 */
  readonly sandbox: SandboxProvider
  /** 部署已解析的超时策略。 */
  readonly timeouts: ProcessTimeouts
  /** 清理失败一类非致命问题的告警出口。 */
  readonly warn: (message: string) => void
}

/** 一次 `run_program` 的模型可见结果。 */
export interface RunProgramOutcome {
  /** 给模型看的文本：程序的返回值、程序自己写的输出，或失败原因。 */
  readonly output: string
}

/**
 * 执行一段程序并等它结束，然后整体删除本次 run 的临时目录。
 *
 * 整段程序没有截止时间（`timeoutMs: null`）：它天然长跑，加整体截止会误杀正常任务
 * （design.md §9）。单次 `process` 的超时由 `process-binding.ts` 负责。
 * @param deps - PTC / subprocess / sandbox 执行缝与部署的超时策略。
 * @param request - 程序正文、cwd、可选的已解析文件策略、取消信号。
 * @returns 渲染好的模型可见结果。
 */
export async function runProgram(deps: RunProgramDeps, request: RunProgramRequest): Promise<RunProgramOutcome> {
  const tmpDir = await createRunTmpDir(request.cwd, randomUUID())
  try {
    const program = guestSource({ program: request.code, tmpDir, cwd: request.cwd })
    const result = await deps.ptcRuntime.run(deps.ptcRuntime.resolve({
      program,
      bindings: [{
        global: 'flow',
        functions: createProcessBindings({
          subprocess: deps.subprocess,
          sandbox: deps.sandbox,
          cwd: request.cwd,
          ...request.sandboxPolicy === undefined ? {} : { sandboxPolicy: request.sandboxPolicy },
          signal: request.signal,
          timeouts: deps.timeouts,
        }),
      }],
      cwd: request.cwd,
      timeoutMs: null,
      ...request.sandboxPolicy === undefined ? {} : { sandboxPolicy: request.sandboxPolicy },
      signal: request.signal,
    }))
    return renderOutcome(result)
  } finally {
    await removeRunTmpDir(tmpDir, deps.warn)
  }
}

/**
 * 把 PTC 结果渲染成模型可读文本。捕获输出在前、完成值在最后：值是这个工具的结果，
 * 放在尾部读起来是结论，也让"从尾部取返回值"这类消费者有一个稳定的落点。
 * 失败种类与原因是结果文本的一部分，不是异常路径，也不是工具失败标记。
 * @param result - PTC 的一次 run 结果。
 * @returns 模型可见的结果文本。
 */
function renderOutcome(result: PtcRunResult): RunProgramOutcome {
  const captured = result.logs.length === 0 ? '' : `程序输出：\n${result.logs.join('\n')}\n\n`
  if (result.error !== undefined) {
    return { output: `${captured}程序执行失败（${result.error.kind}）：${result.error.message}` }
  }
  return { output: `${captured}${renderValue(result.value)}` }
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
