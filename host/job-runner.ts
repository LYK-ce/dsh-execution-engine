/**
 * `run_program` 的后台 job 半边：提交、单例、取消、`report` 记账与 `flow/*` 事件
 * （design.md §4.1–§4.4、§8.1；phase3-plan §2–§4、phase4-plan §3–§4）。
 *
 * 四条契约：
 *
 * - **提交即返回**：`ctx.jobs.start` 同步调用 `run()` 并要它同步交回 hooks，所以这里只把
 *   `execute(...)` 这个 pending promise 接过来，绝不 `await`（phase3-plan R3）。
 * - **每个发起 agent 一个**：同一个 owner 已有 `running`/`stopping` 的程序时**拒绝**，错误文本里
 *   带上当前 job id。拒绝而不是自动取消，因为静默杀掉一个正在发邮件的程序，主 agent 不会知道
 *   （design.md §4.3）。
 * - **取消等清理**：`cancel` 同步且幂等；`cancel()` 在 `await` 到 job 的 `done` 之后才返回，而
 *   `done` 在 `runProgram` 的 `finally`（删临时目录）与在飞外部执行静默之后才 resolve
 *   （design.md §4.4；逐跳位置见 `host/engine.ts` 的 `runProgram`）。
 * - **取消作废未投递的 report**：结算时若终态是 `killed`，把还挂在发起者队列里的 report 摘掉
 *   （design.md §4.4）。四条取消入口（工具、注册表、owner disposal、插件卸载）都收敛到 producer 的
 *   `hooks.cancel`，所以判据挂在**终态**上而不是挂在 `cancel()` 上。摘的动作自己也收住异常：owner
 *   已被 dispose 时收件箱投影已经注销，摘会抛而不是返回 `false`（见 `discardPending`）。
 *
 * 阶段 5 起它还是 `flow/*` 的**身份补全点**：外壳的原语调用上报折成的事件只带调用自己的字段，
 * run 身份由这里补（`runIdentity`），因为 job id 只有持有单例槽位的这里拿得到。程序正文也随
 * `flow/start` 一起发出去——调用事件的 `line` 指的就是它的行号。它还是未闭合调用的**补发点**：
 * run 结算时给取消/超时/未 await 而失去 `flow/call-end` 的调用补一条合成的 `end`
 * （{@link FlowCallSink.closeOpenCalls}），再发 `flow/end`。
 *
 * 本模块**不引入任何运行时依赖**：跨包一律 `import type`，`runProgram` 由装配方注入，所以纯 Node
 * 的 `pnpm run test` 能直接加载它（phase1-plan §10 A 档）。
 * @module dsh-execution-engine/job-runner
 */

import { performance } from 'node:perf_hooks'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { JobHooks, JobId, JobOutcome } from '@deepseek-ai/dsh-jobs'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { FlowCallSink, RunProgramOutcome, RunProgramRequest } from './engine.ts'
// 仅类型：`JobKindMap` 与 `Events`（`flow/*`）两个合并入口，本模块的 `kind` 与 `ctx.emit` 靠它们
// 才成立。
import type {} from './jobs-types.ts'
import type {} from './flow-events.ts'
import { createReportLedger } from './report-binding.ts'
import type { ReportLedger } from './report-binding.ts'

/** job 标签的上限；标签是一行摘要（`JobStart.label`），太长会污染状态行。 */
const LABEL_MAX_LENGTH = 80

/** 取消原因原文；注册表把它逐字转给 producer，也写进 job 的终止记录。 */
const CANCEL_REASON = 'cancelled by the initiating agent'

/**
 * 一次 `run_program` 的提交请求：`RunProgramRequest` 去掉 `signal`、`reports` 与 `trace`。
 *
 * 这三个 `Omit` 是设计的一部分，不是省事：主 agent 取消**一轮 turn**（`ToolRunContext.signal`）
 * 不该杀掉后台程序——"绑的是 agent 实例的生命周期，不是 turn"（design.md §5.3）。所以程序的
 * 取消信号只有一个来源，就是提交时为它新建的那个 controller。`reports` 与 `trace` 同理：两者的
 * 作用域都是一次 job，而 run 身份（job id）也只有持有单例槽位的这里拿得到。
 */
export type ProgramRequest = Omit<RunProgramRequest, 'signal' | 'reports' | 'trace'>

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
 * @param ctx - 宿主上下文；`ctx.jobs` 是注册表，`ctx.emit` 发 `flow/*` 观察事件，
 *   `ctx.effect` 负责插件 dispose 时清空记账。
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

      // 本次 run 的 report 记账与 `flow/*` 发射点。run 身份（job id）要等 `ctx.jobs.start` 返回才有，
      // 所以这里先声明、拿到 id 之后立刻填；第一次投递最早也只能发生在那一刻之后——`runProgram`
      // 先 await 建临时目录，再把绑定交给 PTC。填不上就是这段时序被改坏了：记一条警告、放弃这条
      // 观察事件（`runIdentity`）。
      let runId: JobId | undefined
      const reports = createReportLedger({
        onDelivered: ({ text }) => {
          const identity = runIdentity(ctx, runId, 'delivered report')
          if (identity === undefined) return
          emitFlow(ctx, () => { ctx.emit('flow/report', { runId: identity, text }) })
        },
      })
      // 阶段 5：外壳的原语调用上报。与 report 同一时序约束，所以同样在发射的那一刻读 `runId`。
      //
      // 未闭合调用的记账写在这里，不从别处借一个工厂：`flow/call-end` **只**由 guest 侧那条
      // `.then` 发出（`host/guest-source.ts` 的 `wrap`），而 PTC 的 `finish` 对每一种结局都先
      // `channel?.close()` 再 `handle.terminate()`
      // （`packages/ptc-runtime/ptc-runtime-node/src/index.ts:165-199`）——取消、超时，以及程序不
      // `await` 一个调用就 `return`，都会让那条 `.then` 永远不跑。槽位与 run 终态都在本模块，而
      // 本模块不许有运行时依赖（模块头第 4 条），`host/engine.ts` 在运行时拉进 `@deepseek-ai/dsh-llm`。
      const openCalls = new Map<number, { readonly member: string; readonly line: number | null; readonly startedAt: number }>()
      const trace: FlowCallSink = {
        start: (call) => {
          const identity = runIdentity(ctx, runId, 'primitive call report')
          if (identity === undefined) return
          // 合成 `end` 的耗时从**宿主**收到 start 的那一刻算起：guest 那一侧的计时器已经随它一起没了。
          openCalls.set(call.callId, { member: call.member, line: call.line, startedAt: performance.now() })
          emitFlow(ctx, () => { ctx.emit('flow/call-start', { runId: identity, ...call }) })
        },
        end: (call) => {
          const identity = runIdentity(ctx, runId, 'primitive call report')
          if (identity === undefined) return
          openCalls.delete(call.callId)
          emitFlow(ctx, () => { ctx.emit('flow/call-end', { runId: identity, ...call }) })
        },
        closeOpenCalls: (termination) => {
          const identity = runIdentity(ctx, runId, 'synthetic primitive call closure')
          if (identity === undefined || openCalls.size === 0) return
          const now = performance.now()
          // 先取快照再清空：合成的 end 经 `emit` 同步发出去，重入的 start 不该被这一轮补发吃掉。
          const unclosed = [...openCalls]
          openCalls.clear()
          for (const [callId, call] of unclosed) {
            emitFlow(ctx, () => {
              ctx.emit('flow/call-end', {
                runId: identity,
                callId,
                member: call.member,
                line: call.line,
                ms: Math.max(0, Math.round(now - call.startedAt)),
                outcome: 'error',
                error: `the program ended before this call settled (${termination})`,
                errorTruncated: false,
                synthetic: true,
              })
            })
          }
        },
      }
      const label = programLabel(request.code)

      // `run()` 在 `ctx.jobs.start` 返回 id 之前被同步调用，此时还没有 id 可记，所以 hooks
      // 先落在槽位里，`start` 返回后再连同 id 一起记账。
      const slot: { hooks: JobHooks | null } = { hooks: null }
      const jobId = ctx.jobs.start({
        kind: 'execution-engine',
        label,
        owner,
        run: () => {
          // 取消的唯一来源。它可以早于 `runProgram` 建临时目录：abort 之后再跑的那一段，
          // PTC 会以 `abort` 结算，`finally` 照样把临时目录删掉。
          const controller = new AbortController()
          const hooks: JobHooks = {
            cancel: (reason) => { controller.abort(reason) },
            done: toJobOutcome(execute({ ...request, signal: controller.signal, reports, trace }), controller),
          }
          slot.hooks = hooks
          return hooks
        },
      })
      runId = jobId

      const hooks = slot.hooks
      /* v8 ignore next -- 注册表契约：`run()` 在 `start` 返回之前必然被调用一次。 */
      if (hooks === null) throw new Error('execution-engine: ctx.jobs.start returned without running the producer')
      const submitted: LiveProgram = { jobId, cancel: hooks.cancel, done: hooks.done }
      live.set(owner.id, submitted)
      // 清理挂在 `done` 上，不挂在 `cancel()` 上：`done` 是"资源已经释放"的证明，
      // 而 `cancel()` 只表示"已经请求终止"（phase3-plan §3 的 R7 也由这一条覆盖）。
      void hooks.done.then((outcome) => {
        if (live.get(owner.id) === submitted) live.delete(owner.id)
        // 取消作废，正常结算不作废。判据是**终态**：`toJobOutcome` 只在 controller 被 abort 过时
        // 给 `killed`，而四条取消入口（`cancel_program`、注册表、owner disposal、插件卸载）都会走
        // 到 producer 的 `hooks.cancel`，所以这一条覆盖了它们全部。
        //
        // 正常结算不作废，是因为 `followup` 只是把消息放进 `next-turn` 挂起队列
        // （`packages/core/agent-loop/src/agent.ts:137-139`），主 agent 还没领取——那是一条还没说
        // 出口的正常汇报，不是幽灵报告。作废它会把"最后一条 report 刚投出去、程序立刻结束"这种
        // 时序下的末条汇报吃掉（phase4-plan §10 Q1）。
        //
        // 摘的条数进 `flow/end`：观察面要能把"报出去了"（`flow/report`）和"真的被读到了"对齐，
        // 只发前者的话，阶段 6 的面板重建不出哪些 report 被这次取消吃掉了。
        const discarded = outcome.status === 'killed' ? discardPending(ctx, reports, owner) : 0
        // 每个原语调用都恰好配一对（`flow-events.ts` 的成对承诺）。`flow/call-end` 由 guest 侧那条
        // `.then` 发出，而取消、超时、以及"不 await 就 return"都会让 guest 先死掉——那些在飞的调用
        // 只能在这里闭合。必须在 `flow/end` **之前**：面板要先看到所有调用闭合，再看到 run 结束。
        // 到这里 guest 已经不在（`done` 在 `runProgram` 的 finally 里等过在飞的上报），所以集合里剩
        // 下的都是真的不会再有 `end` 的。
        trace.closeOpenCalls(outcome.detail ?? outcome.status)
        emitFlow(ctx, () => {
          ctx.emit('flow/end', {
            runId: jobId,
            status: outcome.status,
            discarded,
            ...outcome.detail === undefined ? {} : { detail: outcome.detail },
          })
        })
      })
      emitFlow(ctx, () => {
        // 程序正文随 `flow/start` 一起发：调用事件的 `line` 指的就是这份正文的行号，面板要它才对得上
        // （design.md §8.2；行结构的保证见 `host/capabilities.ts` 的 `stripUserProgram`）。
        ctx.emit('flow/start', { runId: jobId, label, ownerSession: owner.id, code: request.code })
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
 * 读本次提交的 run 身份；读不到就记一条警告并**放弃这条观察事件**。
 *
 * run 身份要等 `ctx.jobs.start` 返回才有，而 `run()` 是在它返回**之前**被同步调用的；不过
 * `runProgram` 先 await 建临时目录、再把绑定交给 PTC，所以第一次投递与第一次上报最早也只能发生在
 * 那一行之后。读不到就是这段时序被改坏了：这时**只记一声**、不发事件——发一条没有身份的观察事件
 * 会让面板把两条不同 run 的轨迹拼在一起，而抛出去只会被 guest 的 `ignoreRejection` 吞掉，
 * 变成既没有事件也没有日志的静默缺口（`host/guest-source.ts` 的 `trace`）。
 * @param ctx - 宿主上下文；这条警告从这里出。
 * @param runId - `start` 闭包里的 run 身份；提交填好之前是 `undefined`。
 * @param subject - 出错时点名的动作，写成一个名词短语（`primitive call report`）。
 * @returns 同一个身份；这次提交还没有身份时是 `undefined`，调用方据此跳过这次发射。
 */
function runIdentity(ctx: Context, runId: JobId | undefined, subject: string): JobId | undefined {
  if (runId === undefined) {
    ctx.logger.warn(`execution-engine: dropping a ${subject}: this run has no job id yet`)
    return undefined
  }
  return runId
}

/**
 * 发一个 `flow/*` 观察事件。
 *
 * observe-only 的契约是单向的：监听者坏了不能反过来影响 job。`flow/end` 是在 job 结算回调里发的，
 * 那里抛出去就是一个没人接收的 rejection；`flow/start` 在 `run_program` 的返回路径上，那里抛出去
 * 会把一次成功的提交报成失败。所以监听者的异常在这里收住，只记一条警告
 * （先例 `packages/workflow/workflow/src/index.ts:175-186` 的 `emitWorkflowEvent`）。
 * @param ctx - 宿主上下文；事件与告警都从这里出。
 * @param emit - 真正的那一次 emit。
 */
function emitFlow(ctx: Context, emit: () => void): void {
  try {
    emit()
  } catch (error: unknown) {
    ctx.logger.warn(`execution-engine: a flow/* listener threw: ${renderThrown(error)}`)
  }
}

/**
 * 摘掉本次 run 还挂在发起者队列里的 report，并收住异常。
 *
 * 收住是必须的：`owner.inbox.remove` 在收件箱投影已经注销时**抛**而不是返回 `false`
 * （`packages/core/agent-loop/src/inbox.ts:189-197` 的 `current()` 显式 throw），而 owner disposal
 * 正是取消入口之一（design.md §4.4）——取消到一个已经被 dispose 的会话上，这一步就会抛。这个调用
 * 在 job 结算回调里，抛出去有两个后果：同一段里的 `flow/end` 发不出去（破坏 start↔end 成对），
 * 以及这条 `.then` 链变成一个没人接收的 rejection。所以和 {@link emitFlow} 同形态：只记一条警告。
 * 投影不存在时一条也摘不掉，所以回落的计数是 `0`。
 * @param ctx - 宿主上下文；告警从这里出。
 * @param reports - 本次 run 的 report 记账。
 * @param owner - 发起本次 run 的主 agent。
 * @returns 真的被摘掉的条数；摘的动作失败时是 `0`。
 */
function discardPending(ctx: Context, reports: ReportLedger, owner: Agent): number {
  try {
    return reports.discardPending(owner)
  } catch (error: unknown) {
    ctx.logger.warn(`execution-engine: discarding undelivered reports failed: ${renderThrown(error)}`)
    return 0
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
