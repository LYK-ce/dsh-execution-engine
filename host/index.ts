/**
 * ExecutionEngine 的 host 半边：把 `run_program` 变成后台 job，加上 `cancel_program`，
 * 挂上 job controller，注册它的 `.d.ts` 系统提示段，并把面板要的两条 fetch route 挂上。
 *
 * 阶段 6 的边界：`flow/*` 事件有了第一个真实消费者——`host/flow-state.ts` 的累加器，
 * 浏览器经 `ctx.connection.fetch` 上的两条 exact route 读它（见该模块头：面板因此**不可回放**）。
 * @module dsh-execution-engine
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
// 仅类型：`ctx.get('agents')` 的反向查找（sessionId → 发起 agent）要它的服务声明。
import type {} from '@deepseek-ai/dsh-agent'
// 仅类型：面板的两条路由挂在 `ctx.connection.fetch` 上，它的服务声明与路由契约都在这里。
import type {} from '@deepseek-ai/dsh-client-connection'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import type { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
// 仅类型：解析 `ctx.systemPrompt` 与 `ctx.jobs` 的服务声明。
import type {} from '@deepseek-ai/dsh-system-prompt'
import { CANCEL_PATH, STATE_PATH } from '../shared/protocol.ts'
import {
  DEFAULT_PROCESS_TIMEOUT_MS,
  DEFAULT_SUBAGENT_PROVIDER,
  MAX_PROCESS_TIMEOUT_MS,
  resolveProcessTimeouts,
  resolveSubagentProvider,
} from './config.ts'
import type { Config as ExecutionEngineConfig, ProcessConfig } from './config.ts'
import { runProgram } from './engine.ts'
import { FlowState } from './flow-state.ts'
// 仅类型：`ctx.on('flow/*')` 的事件声明由它合并进来。
import type {} from './flow-events.ts'
import { createProgramJobs } from './job-runner.ts'
import type { ProgramCancel } from './job-runner.ts'
import { handleCancel, handleState } from './routes.ts'
import { SDK_SECTION_NAME, sdkText } from './sdk.ts'
import { createCancelProgramTool, createRunProgramTool } from './tool.ts'

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
  // `min(1)` 挡空串；纯空白名是 `resolveSubagentProvider` 的 trim 检查挡的（见 host/config.ts）。
  subagentProvider: z.string().min(1).default(DEFAULT_SUBAGENT_PROVIDER),
})

export const name = 'execution-engine'

/**
 * 真正用得到的服务：工具注册表、后台 job 注册表、PTC 执行缝、子进程执行缝、子 agent 执行缝、
 * 进程沙箱、系统提示。`sandbox` 与 `sandboxPolicy` 不同：`process` 起的外部进程要先过
 * `ctx.sandbox.confine`（`danger-full-access` 是显式的不受限模式），所以 `sandbox` 进 `inject`
 * （先例 packages/shell/bash-sandbox/src/index.ts:46）。
 *
 * **`connection` 故意不在这里。** 面板的两条路由确实需要 HTTP 传输，但**引擎本体不需要**——
 * headless 部署照样要能跑程序。放进 `inject` 会让"没有 web 传输"变成"连 `run_program` 都不注册"，
 * 那是拿客户端特性绑架引擎本体。改成可选注入：传输在场时才注册路由
 * （先例 `packages/client/connection/src/index.ts:119`、`packages/api/gateway/src/index.ts:198`）。
 * 代价是"面板没出现"不再被响亮地报出来——这是有意的取舍，design.md §8.2 把面板列为第二批交付物。
 */
export const inject = ['tools', 'jobs', 'ptcRuntime', 'subprocess', 'subagents', 'sandbox', 'systemPrompt']

/** 一次工具调用要用的权威：从发起会话现场快照，不固化在引擎上（design.md §5.2）。 */
interface RunAuthority {
  readonly cwd: string
  /** 本次 run 的文件策略；挂载的 PTC provider 不限定时缺席，`process` 随之不受限。 */
  readonly sandboxPolicy?: SandboxExecutionPolicy
}

/**
 * 注册 `run_program` / `cancel_program` 与 `.d.ts` 系统提示段，并把执行接到 `ctx.jobs` 上。
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
  const subagentProvider = resolveSubagentProvider(config)

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

  /**
   * 发起者的唯一落点。`ToolRunContext.agent` 是可选字段，缺席时**大声失败**——静默换一个 parent
   * 会直接破坏 design.md §5.1 的归属承诺，而 `owner` 同时还是单例与生命周期的挂载点，没有它
   * 连"谁的程序"都答不上来。
   */
  const ownerOf = (exec: ToolRunContext, tool: string) => {
    const owner = exec.agent
    if (owner === undefined) {
      throw new Error(`execution-engine: ${tool} requires an initiating agent to attribute the program to`)
    }
    return owner
  }

  // producer 只有在"服务于该 owner 的 controller 已挂载"时才能 start（jobs README）。本插件自己挂：
  // 挂 `@deepseek-ai/dsh-tool-jobs` 会额外给模型 job_output / job_list / job_kill 三个通用工具，
  // 把"主 agent 只能启动 / 取消 / 看 report"（design.md §6.4）撑开，而 design.md §8.5 明确说
  // 不需要单独的状态查询工具。从插件自己的上下文挂，落在全局 scope 层，服务每一个 owner
  // （packages/jobs/jobs-local/src/index.ts:315-319）。
  ctx.jobs.attachController('execution-engine')

  const programs = createProgramJobs(ctx, (request) => runProgram(
    {
      ptcRuntime: ctx.ptcRuntime,
      subprocess: ctx.subprocess,
      subagents: ctx.subagents,
      sandbox: ctx.sandbox,
      timeouts,
      subagentProvider,
      warn: (message) => { ctx.logger.warn(message) },
    },
    request,
  ))

  ctx.tools.register(createRunProgramTool((args, exec) => {
    const authority = authorityOf(exec)
    const parent = ownerOf(exec, 'run_program')
    // `exec.signal`（这一轮 turn 的取消）**故意不往下传**：turn 结束或用户取消一轮，不该杀掉
    // 后台程序（design.md §5.3："绑的是 agent 实例的生命周期，不是 turn"）。
    return programs.start({
      code: args.code,
      cwd: authority.cwd,
      parent,
      ...authority.sandboxPolicy === undefined ? {} : { sandboxPolicy: authority.sandboxPolicy },
    })
  }))
  ctx.tools.register(createCancelProgramTool(exec => programs.cancel(ownerOf(exec, 'cancel_program'))))

  // 面板的观察面：`flow/*` 的宿主侧累加器 + 两条 exact Fetch route（phase6-plan §2）。
  //
  // 累加器与监听都挂在插件 fiber 上，所以插件 unload 时它们一起走；路由也走 `ctx.effect`，
  // 与 Blackboard 同一个形态（`ctx.connection.fetch.register` 返回异步 disposer）。
  const flow = new FlowState()
  ctx.on('flow/start', info => { flow.start(info) })
  ctx.on('flow/call-start', info => { flow.callStart(info) })
  ctx.on('flow/call-end', info => { flow.callEnd(info) })
  ctx.on('flow/report', info => { flow.report(info) })
  ctx.on('flow/end', info => { flow.end(info) })

  // `sessionId` → 发起 agent 的反向查找只有 agents 注册表能做，所以它**不在** `inject` 里、
  // 走 `ctx.get` 读（先例同文件上的 `sandboxPolicy`）：`run_program` 的 owner 由工具调用现场给，
  // 引擎本身不需要这个注册表。它缺席时"没有在跑的程序"就是事实本身——那正是 `cancel_program`
  // 的幂等语义（design.md §4.4），不编一个错误出来。
  const cancelBySession = async (sessionId: SessionId): Promise<ProgramCancel> => {
    const owner = ctx.get('agents')?.get(sessionId)
    if (owner === undefined) return { cancelled: false }
    return await programs.cancel(owner)
  }

  // 传输在场时才注册路由。引擎本体不依赖 HTTP，所以 `connection` 走可选注入而不是 `inject`
  // （理由见上面 `inject` 的 JSDoc）；这里的两条路由与 `flow/*` 的累加器都不会因为传输缺席而
  // 影响 `run_program` / `cancel_program`。
  ctx.inject(['connection'], (routeCtx) => {
    routeCtx.effect(() => routeCtx.connection.fetch.register({
      path: STATE_PATH,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: request => handleState(flow, request),
    }), 'execution-engine: state route')
    routeCtx.effect(() => routeCtx.connection.fetch.register({
      path: CANCEL_PATH,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: request => handleCancel(cancelBySession, request),
    }), 'execution-engine: cancel route')
  })

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
