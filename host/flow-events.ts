/**
 * `flow/*` 的声明合并（design.md §8.1；phase4-plan §4、phase5-plan §4）。
 *
 * 引擎发出的 observe-only 事件：run 启动、原语调用开始与结束、`report` 投递成功、run 结束。
 * payload 带运行身份与事件自身的数据，**不带任何活动句柄**——监听者拿不到取消或清理权限
 * （§8.1；形态照 `packages/workflow/workflow/src/index.ts:31-91` 的 `workflow/*`）。
 *
 * §8.1 与 §12 列的五类事件在本阶段发全：程序源码折进 `flow/start`（它要随行号映射一起定形，
 * 而映射就是阶段 5 定的），原语调用起止就是位置上报本身。
 *
 * 本模块只有类型，运行时是空模块。先例 `host/jobs-types.ts`：同一个 `declare module` 与
 * `import type {} from` 并存的写法。
 * @module dsh-execution-engine/flow-events
 */

import type {} from '@deepseek-ai/cordis'
import type { JobId, JobOutcome } from '@deepseek-ai/dsh-jobs'
import type { SessionId } from '@deepseek-ai/dsh-session'

/** 一次 run 的身份快照：`flow/start` 的 payload。 */
export interface FlowStartEvent {
  /** 注册表发的 `<kind>-N`。 */
  readonly runId: JobId
  /**
   * 注册用的一行标签（程序首行截出来的摘要），**展示用，最多 80 字符**
   * （`host/job-runner.ts` 的 `programLabel`）。它和 {@link FlowStartEvent.code} 的详略不对称是
   * 有意的：这一条进状态行，太长会污染它；那一份是行号的参照物，截了就对不上位置。
   */
  readonly label: string
  /** 发起本次 run 的会话 id；job 的 owner 就是它。 */
  readonly ownerSession: SessionId
  /**
   * 发起本次 run 的**程序正文原文**，逐字未截断——与 `label` 不同，它不是展示用的摘要，而是
   * `flow/call-start.line` / `flow/call-end.line` 的参照物（design.md §8.2）。
   *
   * 是原文而不是已经剥掉类型的 JS：类型擦除只删类型、不动行结构（`host/capabilities.ts` 的
   * `stripUserProgram`），所以调用事件的 `line` 指的就是这份正文的行号，面板拿它对行号显示即可。
   */
  readonly code: string
}

/**
 * `flow/call-start` 的 payload：一次原语调用开始。
 *
 * 与 {@link FlowCallEndEvent} 按 `(runId, callId)` 成对：**guest 活着期间结算的调用各发一对**
 * （失败与参数被拒的调用也算），run 终止时仍未闭合的由宿主补发一条 `synthetic` 的 `end`
 * （{@link FlowCallEndEvent.synthetic}）。程序里 `await Promise.all([process(a), process(b)])`
 * 这类并发调用可以乱序闭合，所以配对靠 `callId`，不靠到达顺序。
 */
export interface FlowCallStartEvent {
  /** 发起这次调用的 run。 */
  readonly runId: JobId
  /**
   * 本次 run 内唯一的调用序号，由外壳按调用发生顺序发（从 `0` 起）。配对是
   * `(runId, callId)`：循环里同一行反复出现时行号相同而 `callId` 不同。
   */
  readonly callId: number
  /** 被调用的原语名（`process` / `processOrThrow` / `dispatchsubagent` / `report`）。 */
  readonly member: string
  /** 调用点在用户源码里的行号（1-based）；拿不到栈时是 `null`，不猜。 */
  readonly line: number | null
  /** 实参预览，有界。 */
  readonly args: string
  /** `args` 是否丢掉了原值的一部分：截到字符上界，或超大结构被收窄（`host/guest-source.ts` 的 `preview`）。 */
  readonly argsTruncated: boolean
}

/** `flow/call-end` 的 payload：一次原语调用结算（正常返回或抛出）。 */
export interface FlowCallEndEvent {
  /** 发起这次调用的 run。 */
  readonly runId: JobId
  /** 与配对的 `flow/call-start` 同号。 */
  readonly callId: number
  /** 被调用的原语名。 */
  readonly member: string
  /** 调用点行号，与配对的 `flow/call-start` 同值。 */
  readonly line: number | null
  /**
   * 从调用开始到这次结算的毫秒数，非负。
   *
   * 合成事件报的是**宿主**这一侧从收到 `start` 到 run 终止的时间：guest 那一侧的计时器已经随着
   * 进程没了。
   */
  readonly ms: number
  /** `ok` 是正常返回；`error` 是抛出（含参数被外壳拒绝）。 */
  readonly outcome: 'ok' | 'error'
  /** `outcome === 'ok'` 时的返回值预览，有界；失败时缺席。 */
  readonly result?: string
  /**
   * `result` 是否丢掉了原值的一部分：截到字符上界，或超大结构被收窄
   * （`host/guest-source.ts` 的 `preview`）；失败时缺席。
   */
  readonly resultTruncated?: boolean
  /** `outcome === 'error'` 时的错误文本，有界；成功时缺席。 */
  readonly error?: string
  /**
   * `error` 是否丢掉了原值的一部分：截到字符上界，或超大结构被收窄
   * （`host/guest-source.ts` 的 `preview`）；成功时缺席。
   */
  readonly errorTruncated?: boolean
  /**
   * 这条 `end` 是**宿主补发**的：程序在调用结算前就终止了（取消、超时，或不 `await` 一个调用
   * 就 `return`），`flow/call-end` 只由 guest 侧那条 `.then` 发出，所以它永远不会来
   * （`host/job-runner.ts` 的 `FlowCallSink.closeOpenCalls`）。
   *
   * 字段在场**就是**合成的（类型是字面量 `true`），程序自己报的结局不带它；面板据此区分"程序
   * 报的结局"与"宿主替它收的尾"。这时 `outcome` 一定是 `error`。
   */
  readonly synthetic?: true
}

/**
 * `flow/report` 的 payload：一次投递成功的 `report`。
 *
 * `text` 是**逐字正文，没有上界**：面板要显示这条 report 说了什么，而引擎不管 report 的额度
 * （§10.1：报什么、报几次由程序自己掌握）。要加就得上界与 `truncated` 布尔一起加，本阶段不做。
 */
export interface FlowReportEvent {
  /** 投出这条 report 的那次 run。 */
  readonly runId: JobId
  /** report 正文，逐字，不截断。 */
  readonly text: string
}

/** `flow/end` 的 payload：一次 run 的终结。 */
export interface FlowEndEvent {
  /** 终结的那次 run。 */
  readonly runId: JobId
  /** 终态：跑完（`completed`）、被取消（`killed`）、程序自己失败（`failed`）。 */
  readonly status: JobOutcome['status']
  /**
   * 本次结算真的被作废的未读 report 条数；没有作废（非取消路径）时是 `0`。
   *
   * 作废范围是"投递成功但主 agent 还没领取"的那些（design.md §4.4）。观察面靠它把
   * {@link FlowReportEvent} 的"报出去了"和"真的被读到了"对齐。
   */
  readonly discarded: number
  /** 终态说明（取消原因，或程序自己的失败原因）；没有时缺席。 */
  readonly detail?: string
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * 一个程序 job 注册成功，开始执行。与
     * {@link Events['flow/end']} 成对：每个 job 恰好一次。程序正文随它一起发出去——它是
     * `flow/call-start.line` / `flow/call-end.line` 的参照物。
     * @param info - 本次 run 的身份快照与程序正文；不含活动句柄。
     * @mode emit
     */
    'flow/start'(info: FlowStartEvent): void
    /**
     * 程序开始调一次原语。与 {@link Events['flow/call-end']} 按 `(runId, callId)` 成对：
     * **guest 活着期间结算的调用各发一对**（失败与参数被拒的调用也算），run 终止时仍未闭合的由
     * 宿主补一条合成的 `flow/call-end`，所以每次 `flow/call-start` 最终都有且只有一条 `end` 回应它。
     * 并发调用可以乱序闭合，所以消费方按 `callId` 配对，不要按到达顺序配对
     * （design.md §8.3 的轨迹就是这一串）。
     * @param info - 本次 run 的身份、调用序号、原语名、调用点行号与实参预览。
     * @mode emit
     */
    'flow/call-start'(info: FlowCallStartEvent): void
    /**
     * 一次原语调用结算。**失败路径也发**：不发的话面板上会留下一条永远在转的调用。程序在调用结算前
     * 终止时（取消、超时，或不 `await` 就 `return`），由宿主补发一条 `synthetic: true` 的
     * `flow/call-end`，它带的是"程序没等到这次调用结算"这个结局，不是程序自己报的结局。
     * @param info - 本次 run 的身份、调用序号、原语名、调用点行号、耗时与结果或错误。
     * @mode emit
     */
    'flow/call-end'(info: FlowCallEndEvent): void
    /**
     * 程序调了一次 `report`，且投递成功（消息已经进了发起者的挂起队列）。这条说的是
     * "报出去了"，不是"主 agent 读到了"——取消之后它还会被作废（design.md §4.4）。
     * @param info - 本次 run 的身份与这次汇报的正文。
     * @mode emit
     */
    'flow/report'(info: FlowReportEvent): void
    /**
     * 一次 run 结算（跑完、被取消或程序自己失败）。与
     * {@link Events['flow/start']} 成对：每个 job 恰好一次。取消路径上它会带上被作废的未读
     * report 条数——`flow/report` 说的是"报出去了"，这一项说的是"其中有多少被这次取消吃掉"。
     * @param info - 本次 run 的身份、终态、被作废的条数与终态说明。
     * @mode emit
     */
    'flow/end'(info: FlowEndEvent): void
  }
}
