/**
 * `process` / `processOrThrow` 两个原语（design.md §3.2、§3.4；phase1-plan §5）。
 *
 * 底座是 `ctx.subprocess`：argv 不经 shell、超时由引擎自己的定时器掌握、终止走
 * `terminate()` + `waitForExit()`——后者才是"整个受管范围静默"的证明（design.md §7.3）。
 * stdout / stderr 只用于诊断，不承载业务返回值。
 *
 * 外部进程与 PTC 程序自己受同一份文件策略约束：argv 在 spawn 之前先过
 * `ctx.sandbox.confine`（形态照 `packages/shell/bash-sandbox/src/index.ts:89-105`）。
 * provider 无法限定时它**拒绝**，绝不静默不受限执行。
 * @module dsh-execution-engine/process-binding
 */

import { SubprocessExecutableNotFoundError } from '@deepseek-ai/dsh-subprocess'
import type { SubprocessHandle, SubprocessOutcome, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { PtcBindingFunction, PtcJsonValue } from '@deepseek-ai/dsh-ptc-runtime'
import type { SandboxExecutionPolicy, SandboxProvider } from '@deepseek-ai/dsh-sandbox'
import { resolveRequestedTimeout } from './config.ts'
import type { ProcessTimeouts } from './config.ts'

/** 每条被收集的输出流的内存上限；超出保留尾部。 */
const STREAM_MAX_BYTES = 1 << 20

/**
 * 交给 subprocess provider 的终止宽限期。取值与 `ptc-runtime-node` 的 `graceMs`
 * 默认一致：它既是 provider 的终止阶梯预算，也是直接命令退出后仍在排空收集管道的上界。
 */
const TERMINATION_GRACE_MS = 3_000

/** 程序看到的 `process` 结果。非零退出码与超时都是正常字段，不是异常。 */
export interface ProcessResult {
  /** 退出码；进程被信号杀死时为 `-1`。 */
  readonly code: number
  /** 诊断用标准输出；不承载业务返回值。 */
  readonly stdout: string
  /** 诊断用标准错误。 */
  readonly stderr: string
  /** 本次执行是否撞上了引擎的超时。 */
  readonly timedOut: boolean
}

/** `processOrThrow` 成功时返回的输出。 */
export interface ProcessOutput {
  /** 诊断用标准输出。 */
  readonly stdout: string
  /** 诊断用标准错误。 */
  readonly stderr: string
}

/** 一次程序请求：argv 加可选的单次超时。 */
interface ProcessRequest {
  readonly argv: string[]
  readonly timeoutMs?: number
}

/** `createProcessBindings` 需要的外部依赖与本次 run 的权威。 */
export interface ProcessBindingOptions {
  /** 执行外部程序的 subprocess provider。 */
  readonly subprocess: SubprocessRuntime
  /** 把 argv 包成受限执行形态的 provider。 */
  readonly sandbox: SandboxProvider
  /** 子进程的工作目录；来自发起会话的现场快照。 */
  readonly cwd: string
  /** 与本次 run 交给 PTC 的同一份文件策略；挂载的 PTC provider 不限定时缺席。 */
  readonly sandboxPolicy?: SandboxExecutionPolicy
  /** 外层取消；abort 会终止本次 run 里在飞的每个子进程。 */
  readonly signal: AbortSignal
  /** 部署已解析的超时策略。 */
  readonly timeouts: ProcessTimeouts
}

/**
 * 两个原语的实现。`process` 非零退出码与超时都正常返回；`processOrThrow` 两者都抛。
 * @param options - provider、cwd、取消信号与超时策略。
 * @returns 注册进 PTC `flow` 绑定命名空间的两个函数。
 */
export function createProcessBindings(options: ProcessBindingOptions): Record<string, PtcBindingFunction> {
  return {
    process: (args: unknown) => runProcess(options, readRequest(args)).then(toJson),
    processOrThrow: async (args: unknown) => {
      const request = readRequest(args)
      const result = await runProcess(options, request)
      const argv = request.argv.join(' ')
      if (result.timedOut) {
        throw new Error(`process timed out: ${argv}`)
      }
      if (result.code !== 0) {
        throw new Error(`process exited with code ${String(result.code)}: ${argv}${diagnosticTail(result.stderr)}`)
      }
      return { stdout: result.stdout, stderr: result.stderr }
    },
  }
}

/** 把校验后的请求正文转成 lossless JSON 结果。 */
function toJson(result: ProcessResult): PtcJsonValue {
  return { code: result.code, stdout: result.stdout, stderr: result.stderr, timedOut: result.timedOut }
}

/** 失败时把 stderr 尾部带进错误文本，让程序（和人）知道为什么。 */
function diagnosticTail(stderr: string): string {
  const trimmed = stderr.trim()
  if (trimmed.length === 0) return ''
  return `: ${trimmed.length > 500 ? `…${trimmed.slice(-500)}` : trimmed}`
}

/**
 * 校验程序给的请求。程序是外部输入，所以这里是运行期的解析边界：argv 必须是非空字符串数组，
 * `timeoutMs`（若有）必须是正整数。
 * @param value - 绑定调用收到的单个参数值。
 * @returns 校验后的请求。
 */
function readRequest(value: unknown): ProcessRequest {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('process requires an argument object with an argv array')
  }
  const record = value as Record<string, unknown>
  const rawArgv = record.argv
  if (!Array.isArray(rawArgv) || rawArgv.length === 0) {
    throw new TypeError('process requires a non-empty argv array')
  }
  const argv = rawArgv.map((entry, index) => {
    if (typeof entry !== 'string') throw new TypeError(`process argv[${String(index)}] must be a string`)
    return entry
  })
  const timeoutMs = record.timeoutMs
  if (timeoutMs === undefined) return { argv }
  if (typeof timeoutMs !== 'number') throw new TypeError('process timeoutMs must be a number of milliseconds')
  return { argv, timeoutMs }
}

/**
 * 执行一次外部程序并等它真正结束。
 *
 * 四条正确性要求：
 * 1. 超时先经上限校验（`resolveRequestedTimeout`），越界在启动任何进程之前就被拒绝；
 * 2. argv 先过 `ctx.sandbox.confine`：`danger-full-access` 是显式的不受限选择，其余模式
 *    一律受限，provider 拒绝时原样上抛（`SandboxUnavailableError` 就是"不能受限"）；
 * 3. `done` 只报直接命令的结局，`waitForExit()` 才报受管范围静默——两个都等；
 * 4. abort 时**调用方**必须自己收拾在飞的子进程（`PtcRunRequest.signal` 的契约），
 *    所以这里把同一个 signal 交给 spawn，并保证 `waitForExit()` 被 await。
 * @param options - provider、sandbox、cwd、取消信号与超时策略。
 * @param request - 已校验的 argv 与可选超时。
 * @returns 退出码与诊断输出。
 */
async function runProcess(options: ProcessBindingOptions, request: ProcessRequest): Promise<ProcessResult> {
  const timeoutMs = resolveRequestedTimeout(request.timeoutMs, options.timeouts)
  const command = request.argv[0]
  /* v8 ignore next -- readRequest guarantees a non-empty argv. */
  if (command === undefined) throw new TypeError('process requires a non-empty argv array')
  let executable: string
  try {
    executable = await options.subprocess.resolveExecutable(command, undefined, options.signal)
  } catch (error: unknown) {
    if (error instanceof SubprocessExecutableNotFoundError) {
      throw new Error(`process could not find the executable ${JSON.stringify(command)}: ${error.message}`)
    }
    throw error
  }
  const argv = [executable, ...request.argv.slice(1)]
  const policy = options.sandboxPolicy
  // 重新点出判别式：对象展开不保留它的收窄结果（先例 packages/shell/bash-sandbox/src/index.ts:101）。
  const confined = policy === undefined || policy.mode === 'danger-full-access'
    ? undefined
    : await options.sandbox.confine(argv, { ...policy, mode: policy.mode }, options.signal)
  options.signal.throwIfAborted()

  let timedOut = false
  const handle: SubprocessHandle = options.subprocess.spawn({
    argv: confined?.argv ?? argv,
    cwd: options.cwd,
    stdio: {
      stdin: 'ignore',
      stdout: { maxBytes: STREAM_MAX_BYTES },
      stderr: { maxBytes: STREAM_MAX_BYTES },
    },
    graceMs: TERMINATION_GRACE_MS,
    signal: options.signal,
  })

  // 超时是引擎自己的判断：到点终止托管范围，然后照常等它真的清空。
  const timer = setTimeout(() => {
    timedOut = true
    handle.terminate()
  }, timeoutMs)

  let outcome: SubprocessOutcome
  try {
    // 直接命令一 settle 就撤掉定时器：命令在截止点附近正常退出时，到点的定时器仍会被
    // 排进宏任务队列，而这段续体跑在它之前，所以撤得掉——否则会把 code 0 报成 timedOut。
    outcome = await handle.done
  } catch (error: unknown) {
    // `done` 的拒绝才是真正的原因（spawn 失败、provider 故障）。受管范围仍要等静默，
    // 但它自己的失败不能顶掉那个原因。
    clearTimeout(timer)
    await handle.waitForExit().catch(() => { /* the `done` failure above is the cause */ })
    throw error
  }
  clearTimeout(timer)
  // 无条件等受管范围静默：直接命令结束不掩盖存活的子孙进程，"杀整个进程树"就是这一句。
  await handle.waitForExit()
  options.signal.throwIfAborted()
  return {
    code: outcome.exitCode ?? -1,
    stdout: handle.collected.stdout?.readFrom(0).text ?? '',
    stderr: handle.collected.stderr?.readFrom(0).text ?? '',
    timedOut,
  }
}
