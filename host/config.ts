/**
 * 部署配置的取值与解析期校验：一次 `process` 的默认超时与上限、派子 agent 用的 provider
 * （design.md §9）。
 *
 * 校验是显式的：配置在加载时失败，程序越界的请求在解析阶段失败，两者都不悄悄截断。
 *
 * 本模块**不引入任何包**——连 schemastery 都不引。原因是纯 Node 的 `pnpm run test` 要能
 * 直接加载它做解析期校验（phase1-plan §10 A 档 / §11.3），而本目录是独立 workspace，
 * `@deepseek-ai/schemastery` 在纯 Node 下没有解析路径（只有 tsx 走的 tsconfig paths）。
 * 因此 schemastery 模式放在 `host/index.ts`，这里只留类型、缺省常量与纯函数。
 * @module dsh-execution-engine/config
 */

/** 缺省的单次 `process` 超时（毫秒）。 */
export const DEFAULT_PROCESS_TIMEOUT_MS = 300_000

/** 程序能申请的单次超时上限（毫秒）。 */
export const MAX_PROCESS_TIMEOUT_MS = 900_000

/**
 * 缺省的子 agent provider 名。与 `@deepseek-ai/dsh-subagent-spawn-in-process` 注册的
 * `providerName` 缺省一致，所以没有额外 provider 的部署照样能派子 agent。
 */
export const DEFAULT_SUBAGENT_PROVIDER = 'spawn'

/** `process` / `processOrThrow` 的超时策略。 */
export interface ProcessConfig {
  /** 程序没给 `timeoutMs` 时用的超时（毫秒）。 */
  defaultTimeoutMs?: number
  /** 程序申请的 `timeoutMs` 不得超出的上限（毫秒）。 */
  maxTimeoutMs?: number
}

/** ExecutionEngine 的部署配置。 */
export interface Config {
  /** 外部程序的超时策略。 */
  process?: ProcessConfig
  /** 派子 agent 时用的 `ctx.subagents` provider 名；缺省 {@link DEFAULT_SUBAGENT_PROVIDER}。 */
  subagentProvider?: string
}

/** 已解析的超时策略；`resolveProcessTimeouts` 是唯一的产出点。 */
export interface ProcessTimeouts {
  /** 程序没给 `timeoutMs` 时用的超时。 */
  readonly defaultTimeoutMs: number
  /** 程序能申请的上限。 */
  readonly maxTimeoutMs: number
}

/**
 * 校验并补全部署的超时策略。加载期调用，配置不自洽时整个插件拒绝启动。
 * @param config - 已套用模式缺省的插件配置。
 * @returns 两个字段都齐备的正整数超时。
 * @throws 值不是正整数，或默认超时高于上限。
 */
export function resolveProcessTimeouts(config: Config): ProcessTimeouts {
  const defaultTimeoutMs = config.process?.defaultTimeoutMs ?? DEFAULT_PROCESS_TIMEOUT_MS
  const maxTimeoutMs = config.process?.maxTimeoutMs ?? MAX_PROCESS_TIMEOUT_MS
  if (!Number.isSafeInteger(defaultTimeoutMs) || defaultTimeoutMs <= 0) {
    throw new Error(`execution-engine: process.defaultTimeoutMs must be a positive integer, got ${String(defaultTimeoutMs)}`)
  }
  if (!Number.isSafeInteger(maxTimeoutMs) || maxTimeoutMs <= 0) {
    throw new Error(`execution-engine: process.maxTimeoutMs must be a positive integer, got ${String(maxTimeoutMs)}`)
  }
  if (defaultTimeoutMs > maxTimeoutMs) {
    throw new Error(
      `execution-engine: process.defaultTimeoutMs (${String(defaultTimeoutMs)}) must not exceed process.maxTimeoutMs (${String(maxTimeoutMs)})`,
    )
  }
  return { defaultTimeoutMs, maxTimeoutMs }
}

/**
 * 解析派子 agent 用的 provider 名。直接 `apply()` 会绕过 schemastery，所以这里显式校验：
 * 空名字与带首尾空白的名字都不是"回落到默认"，是装配错误——静默换一个 provider 会把子 agent
 * 挂到部署没选的后端上，而带空白的名字在 `ctx.subagents` 里也永远匹配不到任何 provider
 * （先例 `packages/workflow/workflow-ptc/src/index.ts:69`）。
 * @param config - 已套用模式缺省的插件配置。
 * @returns 非空且已规范化的 provider 名。
 * @throws 值不是非空、无首尾空白的字符串。
 */
export function resolveSubagentProvider(config: Config): string {
  const provider = config.subagentProvider ?? DEFAULT_SUBAGENT_PROVIDER
  if (typeof provider !== 'string' || provider.length === 0 || provider !== provider.trim()) {
    throw new Error(
      `execution-engine: subagentProvider must be a non-empty provider name, got ${JSON.stringify(provider)}`,
    )
  }
  return provider
}

/**
 * 解析一次程序请求的超时。给数字就用它，但先过上限——越界是**解析期拒绝**，
 * 不是运行时截断（design.md §9）。
 * @param requested - 程序给的 `timeoutMs`；省略表示用默认。
 * @param timeouts - 部署已解析的超时策略。
 * @returns 本次执行实际使用的超时。
 * @throws 请求不是正整数，或高于上限。
 */
export function resolveRequestedTimeout(requested: number | undefined, timeouts: ProcessTimeouts): number {
  if (requested === undefined) return timeouts.defaultTimeoutMs
  if (!Number.isSafeInteger(requested) || requested <= 0) {
    throw new Error(`process timeoutMs must be a positive integer number of milliseconds, got ${String(requested)}`)
  }
  if (requested > timeouts.maxTimeoutMs) {
    throw new Error(
      `process timeoutMs ${String(requested)} exceeds the configured maximum of ${String(timeouts.maxTimeoutMs)} milliseconds`,
    )
  }
  return requested
}
