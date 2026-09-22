/**
 * `run_program` 的后台 job 半边：提交、单例、取消（design.md §4.1–§4.4；phase3-plan §2–§4）。
 *
 * 三条契约：
 *
 * - **提交即返回**：`ctx.jobs.start` 同步调用 `run()` 并要它同步交回 hooks，所以这里只把
 *   `execute(...)` 这个 pending promise 接过来，绝不 `await`（phase3-plan R3）。
 * - **每个发起 agent 一个**：同一个 owner 已有 `running`/`stopping` 的程序时**拒绝**，错误文本里
 *   带上当前 job id。拒绝而不是自动取消，因为静默杀掉一个正在发邮件的程序，主 agent 不会知道
 *   （design.md §4.3）。
 * - **取消等清理**：`cancel` 同步且幂等；`cancel()` 在 `await` 到 job 的 `done` 之后才返回，而
 *   `done` 在 `runProgram` 的 `finally`（删临时目录）与在飞外部执行静默之后才 resolve
 *   （design.md §4.4；逐跳位置见 `host/engine.ts` 的 `runProgram`）。
 *
 * 本模块**不引入任何运行时依赖**：跨包一律 `import type`，`runProgram` 由装配方注入，所以纯 Node
 * 的 `pnpm run test` 能直接加载它（phase1-plan §10 A 档）。
 * @module dsh-execution-engine/job-runner
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { JobHooks, JobId, JobOutcome } from '@deepseek-ai/dsh-jobs'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { RunProgramOutcome, RunProgramRequest } from './engine.ts'
// 仅类型：`JobKindMap` 的合并入口，本模块的 `kind: 'execution-engine'` 靠它才成立。
import type {} from './jobs-types.ts'

/** job 标签的上限；标签是一行摘要（`JobStart.label`），太长会污染状态行。 */
const LABEL_MAX_LENGTH = 80

/** 取消原因原文；注册表把它逐字转给 producer，也写进 job 的终止记录。 */
const CANCEL_REASON = 'cancelled by the initiating agent'

/**
 * 一次 `run_program` 的提交请求：`RunProgramRequest` 去掉 `signal`。
 *
 * 这个 `Omit` 是设计的一部分，不是省事：主 agent 取消**一轮 turn**（`ToolRunContext.signal`）
 * 不该杀掉后台程序——"绑的是 agent 实例的生命周期，不是 turn"（design.md §5.3）。所以程序的
 * 取消信号只有一个来源，就是提交时为它新建的那个 controller。
 */
export type ProgramRequest = Omit<RunProgramRequest, 'signal'>

/**
 * `runProgram` 的入口。由装配方注入而不是直接 import：`host/engine.ts` 在运行时拉进
 * `@deepseek-ai/dsh-subprocess`，直接 import 会让纯 Node 的 `pnpm run test` 加载不了本模块。
 */
export type ProgramExecute = (request: RunProgramRequest) => Promise<RunProgramOutcome>

/** `cancel_program` 的结果。没有在跑的程序时只有 `cancelled: false` 一项。 */
export interface ProgramCancel {
  /** 本次调用是否真的停掉了一个程序。 */
  readonly cancelled: boolean
  /** 被停掉的 job id；`cancelled: false` 时缺席。 */
  readonly jobId?: JobId
  /** job 的终态；`cancelled: false` 时缺席。 */
  readonly status?: JobOutcome['status']
  /** job 的终态说明（例如程序自己失败的原因）；没有时缺席。 */
  readonly detail?: string
}

/** 引擎的程序槽位：每个发起 agent 同时只有一个。 */
export interface ProgramJobs {
  /**
   * 提交一次程序执行并立刻返回它的 job id。
   * @param request - 程序正文与本次 run 的权威；不含取消信号（信号由本次提交自己掌握）。
   * @returns 注册表发的 `<kind>-N`。
   * @throws 该发起 agent 已有未结算的程序；错误文本里带上当前 job id（design.md §4.3）。
   */
  start(request: ProgramRequest): JobId
  /**
   * 取消该发起 agent 当前在跑的程序，并在清理真正完成后返回。
   * @param owner - 发起 agent；取消的权限范围就是它（design.md §4.2）。
   * @returns 没有在跑的程序时 `{ cancelled: false }`——幂等语义在这里，不在异常里（design.md §4.4）。
   */
  cancel(owner: Agent): Promise<ProgramCancel>
}

/** 一次已提交程序的进程内记账；`done` 结算后整条清掉。 */
interface LiveProgram {
  /** 注册表发的 `<kind>-N`，进拒绝消息与取消结果。 */
  readonly jobId: JobId
  /** job 交出来的取消入口：同步、幂等（`JobHooks.cancel` 的契约）。 */
  readonly cancel: (reason?: string) => void
  /** job 的终态；`cancel()` 等它，用来表达"清理真正完成"。 */
  readonly done: Promise<JobOutcome>
}

/**
 * 造一个按发起会话记账的程序槽位。
 *
 * 记账的作用域是**每个发起 agent 一个**，不是全局一个（design.md §4.2）：不同会话各跑各的。
 * 登记在 `live` 里的条目在 `done` 结算之后才删——若在 `cancel()` 之后就删，"取消返回后立刻
 * 启动新的"会撞上一个还在清理的旧 job（phase3-plan §3）。
 * @param ctx - 宿主上下文；`ctx.jobs` 是注册表，`ctx.effect` 负责插件 dispose 时清空记账。
 * @param execute - 真正的执行入口（装配方传 `runProgram`）。
 * @returns 提交与取消两个操作。
 */
export function createProgramJobs(ctx: Context, execute: ProgramExecute): ProgramJobs {
  const live = new Map<SessionId, LiveProgram>()
  // 插件卸载：**先取消在跑的程序、等它们结算，最后才清记账**。
  //
  // 只清账不取消会留下"记账空了、程序还在跑"的窗口：本插件的 controller 会随它一起摘掉，
  // 但另一个 controller（例如 preset 里的 `tool-jobs`）仍服务同一个 owner 时，下一次
  // `run_program` 会被注册表放行——单例就失效了。取消本身也是 design.md §4.4 列的入口之一
  // （"插件 unload"）。顺序上前两步先做：清理期间槽位仍然占着，账实始终一致。
  //
  // 残余分叉（今天不可达，记录备查）：注册表在 teardown 里遇到 `cancel()` 抛错时，会**不经过
  // `hooks.done`** 直接强杀记录（`jobs-local` 的 `cancelForTeardown`）。那一刻记账会留着一个
  // 注册表已经删掉的 jobId，此后该 owner 的每次 `start` 都被"已经有一个程序在跑"拒掉。
  // 今天打不到——`cancel` 只是 `AbortController.abort`，它不抛。
  ctx.effect(() => async () => {
    const running = [...live.values()]
    for (const entry of running) entry.cancel(CANCEL_REASON)
    await Promise.all(running.map(entry => entry.done))
    live.clear()
  }, 'execution-engine.programs()')

  return {
    start(request: ProgramRequest): JobId {
      const owner = request.parent
      const running = live.get(owner.id)
      if (running !== undefined) throw new Error(alreadyRunning(running.jobId))

      // `run()` 在 `ctx.jobs.start` 返回 id 之前被同步调用，此时还没有 id 可记，所以 hooks
      // 先落在槽位里，`start` 返回后再连同 id 一起记账。
      const slot: { hooks: JobHooks | null } = { hooks: null }
      const jobId = ctx.jobs.start({
        kind: 'execution-engine',
        label: programLabel(request.code),
        owner,
        run: () => {
          // 取消的唯一来源。它可以早于 `runProgram` 建临时目录：abort 之后再跑的那一段，
          // PTC 会以 `abort` 结算，`finally` 照样把临时目录删掉。
          const controller = new AbortController()
          const hooks: JobHooks = {
            cancel: (reason) => { controller.abort(reason) },
            done: toJobOutcome(execute({ ...request, signal: controller.signal }), controller),
          }
          slot.hooks = hooks
          return hooks
        },
      })

      const hooks = slot.hooks
      /* v8 ignore next -- 注册表契约：`run()` 在 `start` 返回之前必然被调用一次。 */
      if (hooks === null) throw new Error('execution-engine: ctx.jobs.start returned without running the producer')
      const submitted: LiveProgram = { jobId, cancel: hooks.cancel, done: hooks.done }
      live.set(owner.id, submitted)
      // 清理挂在 `done` 上，不挂在 `cancel()` 上：`done` 是"资源已经释放"的证明，
      // 而 `cancel()` 只表示"已经请求终止"（phase3-plan §3 的 R7 也由这一条覆盖）。
      void hooks.done.then(() => {
        if (live.get(owner.id) === submitted) live.delete(owner.id)
      })
      return jobId
    },

    async cancel(owner: Agent): Promise<ProgramCancel> {
      const entry = live.get(owner.id)
      if (entry === undefined) return { cancelled: false }
      // 同步且幂等：`AbortController.abort` 重复调用无害，没有在跑的 job 时上面就返回了。
      entry.cancel(CANCEL_REASON)
      // 等 `done`，不是等 `cancel()` 返回。`done` 在临时目录删掉、在飞的外部执行静默之后才
      // resolve，所以"返回时清理已完成"是等出来的，不是猜的（design.md §4.4）。
      const outcome = await entry.done
      return {
        cancelled: true,
        jobId: entry.jobId,
        status: outcome.status,
        ...outcome.detail === undefined ? {} : { detail: outcome.detail },
      }
    },
  }
}

/**
 * 单例拒绝的错误文本。设计里这一句本身就是状态查询——"启动被拒绝"回答了"现在在跑哪一个"
 * （design.md §8.5），所以 job id 必须在这句话里。
 * @param jobId - 当前未结算的 job。
 * @returns 给模型看的拒绝原因。
 */
function alreadyRunning(jobId: JobId): string {
  return `execution-engine: 已经有一个程序在跑（${jobId}），要先取消它再启动新的。`
}

/**
 * 把程序的结局折成 job 的终态。
 *
 * 取消优先：controller 已中止就是 `killed`，而且**不再采用程序那一刻自己的结局**——取消是静默硬杀
 * （design.md §5.4），程序大概率以 PTC 的 `abort` 失败收场，那个失败只是取消的影子，记的是"谁叫停的"。
 * 其余情况用 `runProgram` 给出的分类。拒绝也被收进来——`JobHooks.done` 的契约是"必须不 reject"，
 * 而且 `cancel_program` 要读这个终态。
 * @param settled - `runProgram` 的 pending promise。
 * @param controller - 本次提交的取消信号；它的状态与原因决定 `killed` 与 `detail`。
 * @returns job 的终态。
 */
function toJobOutcome(settled: Promise<RunProgramOutcome>, controller: AbortController): Promise<JobOutcome> {
  return settled.then(
    (outcome) => controller.signal.aborted
      ? { status: 'killed', detail: cancelDetail(controller.signal.reason), output: outcome.output }
      : {
        status: outcome.status,
        ...outcome.detail === undefined ? {} : { detail: outcome.detail },
        output: outcome.output,
      },
    (error: unknown) => controller.signal.aborted
      ? { status: 'killed', detail: cancelDetail(controller.signal.reason), output: `程序执行失败：${renderThrown(error)}` }
      : { status: 'failed', detail: renderThrown(error), output: `程序执行失败：${renderThrown(error)}` },
  )
}

/**
 * 取消原因的一行文本：`JobOutcome.detail` 会进状态行，所以这里必须是一行。
 * @param reason - `AbortController.abort` 收到的原因。
 * @returns 取消原因，缺席时回落到固定的一个词。
 */
function cancelDetail(reason: unknown): string {
  return reason === undefined ? 'cancelled' : renderThrown(reason)
}

/**
 * 从程序源码截一个一行标签：第一行非空内容、折叠空白、超长截断（phase3-plan §11 Q3 的裁决）。
 * 注册表拒绝空标签，所以整段都是空白的程序回落到工具名。
 * @param code - 程序源码。
 * @returns 非空的一行标签。
 */
export function programLabel(code: string): string {
  const first = code.split(/\r?\n/u).find(line => line.trim().length > 0)
  const collapsed = first === undefined ? '' : first.trim().replace(/\s+/gu, ' ')
  if (collapsed.length === 0) return 'run_program'
  return collapsed.length <= LABEL_MAX_LENGTH ? collapsed : `${collapsed.slice(0, LABEL_MAX_LENGTH - 1)}…`
}

/** 把任意抛出物渲染成一行诊断文本。 */
function renderThrown(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
