/**
 * ExecutionEngine 的 host 半边：注册 `run_program` 与它的 `.d.ts` 系统提示段。
 *
 * 阶段 1 的边界（phase1-plan §7）：`run_program` 是**前台阻塞**调用，没有后台 job、
 * 没有单例、没有取消工具、没有 `report`、没有 `dispatchsubagent`、没有 UI。
 * @module dsh-execution-engine
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import type { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
// 仅类型：解析 `ctx.systemPrompt` 的服务声明。
import type {} from '@deepseek-ai/dsh-system-prompt'
import {
  DEFAULT_PROCESS_TIMEOUT_MS,
  MAX_PROCESS_TIMEOUT_MS,
  resolveProcessTimeouts,
} from './config.ts'
import type { Config as ExecutionEngineConfig, ProcessConfig } from './config.ts'
import { runProgram } from './engine.ts'
import { SDK_SECTION_NAME, sdkText } from './sdk.ts'
import { createRunProgramTool, createSkeletonTool } from './tool.ts'

/** 部署配置的类型面；值面是下面的 schemastery 模式（同名合并，先例 packages/todo/tool-todo/src/index.ts:29）。 */
export type Config = ExecutionEngineConfig

/**
 * `process` 超时策略的模式。类型参数写成全可选的 `ProcessConfig`，`.default({})` 才是
 * 合法整体缺省：两个内层字段各自带缺省，运行时由模式补齐（先例
 * packages/client/connection/src/index.ts:91）。
 */
const ProcessConfigSchema: z<ProcessConfig> = z.object({
  defaultTimeoutMs: z.natural().default(DEFAULT_PROCESS_TIMEOUT_MS),
  maxTimeoutMs: z.natural().default(MAX_PROCESS_TIMEOUT_MS),
})

export const Config: z<ExecutionEngineConfig> = z.object({
  process: ProcessConfigSchema.default({}),
})

export const name = 'execution-engine'

/**
 * 阶段 1 真正用得到的服务：工具注册表、PTC 执行缝、子进程执行缝、进程沙箱、系统提示。
 * `sandbox` 与 `sandboxPolicy` 不同：`process` 起的外部进程要先过 `ctx.sandbox.confine`
 * （`danger-full-access` 是显式的不受限模式），所以 `sandbox` 进 `inject`
 * （先例 packages/shell/bash-sandbox/src/index.ts:46）。
 */
export const inject = ['tools', 'ptcRuntime', 'subprocess', 'sandbox', 'systemPrompt']

/** 一次工具调用要用的权威：从发起会话现场快照，不固化在引擎上（design.md §5.2）。 */
interface RunAuthority {
  readonly cwd: string
  /** 本次 run 的文件策略；挂载的 PTC provider 不限定时缺席，`process` 随之不受限。 */
  readonly sandboxPolicy?: SandboxExecutionPolicy
}

/**
 * 注册 `run_program`（外加阶段 0 的占位工具）与 `.d.ts` 系统提示段。
 *
 * `sandboxPolicy` 不在 `inject` 里：它只在挂载的 PTC provider 确实限定时才被需要，
 * 走 `ctx.get` 读取（先例 packages/shell/tool-bash/src/index.ts:193）。provider 限定却
 * 没有策略，就是装配错误，加载时抛。快照下来的同一份策略既交给 PTC，也交给 `process`
 * 的 `ctx.sandbox.confine`——两条执行路径受同一个文件策略约束。
 * @param ctx - 宿主上下文。
 * @param config - 已套用模式缺省的部署配置。
 */
export function apply(ctx: Context, config: Config): void {
  const timeouts = resolveProcessTimeouts(config)

  const sandboxPolicy: SandboxPolicyService | undefined =
    ctx.ptcRuntime.sandboxMode === undefined ? undefined : ctx.get('sandboxPolicy')
  if (ctx.ptcRuntime.sandboxMode !== undefined && sandboxPolicy === undefined) {
    throw new Error('execution-engine: the mounted PTC runtime confines but ctx.sandboxPolicy is missing')
  }

  /** 每次调用现场解析 cwd 与文件策略；两者同源，都挂在发起会话上。 */
  const authorityOf = (exec: ToolRunContext): RunAuthority => {
    const session = exec.agent?.session
    const policy = sandboxPolicy?.resolve(session === undefined ? {} : { session })
    const cwd = session?.header.cwd ?? policy?.workspaceRoot
    if (cwd === undefined) {
      throw new Error(
        'execution-engine: run_program needs a working directory; mount sandboxPolicy or call it from an agent session',
      )
    }
    return { cwd, ...policy === undefined ? {} : { sandboxPolicy: policy } }
  }

  ctx.tools.register(createSkeletonTool())
  ctx.tools.register(createRunProgramTool(async (args, exec) => {
    const authority = authorityOf(exec)
    return await runProgram(
      {
        ptcRuntime: ctx.ptcRuntime,
        subprocess: ctx.subprocess,
        sandbox: ctx.sandbox,
        timeouts,
        warn: (message) => { ctx.logger.warn(message) },
      },
      {
        code: args.code,
        cwd: authority.cwd,
        signal: exec.signal,
        ...authority.sandboxPolicy === undefined ? {} : { sandboxPolicy: authority.sandboxPolicy },
      },
    )
  }))

  // section() 返回的就是挂在调用方 fiber 上的 effect disposer；这里照 phase1-plan §9
  // 用 ctx.effect 再持有一次，并带上 label（先例 packages/preset/persona/src/index.ts:63,68）。
  ctx.effect(() => ctx.systemPrompt.section({
    name: SDK_SECTION_NAME,
    order: ctx.systemPrompt.getSectionOrder('TOOLS_SDK'),
    // 程序示例里的花括号不是提示变量引用。
    interpolate: false,
    text: sdkText(timeouts),
  }), 'execution-engine.sdk-section()')
}
