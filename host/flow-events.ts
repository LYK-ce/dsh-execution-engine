/**
 * `flow/*` 的声明合并（design.md §8.1；phase4-plan §4）。
 *
 * 引擎发出的三个 observe-only 事件：run 启动、`report` 投递成功、run 结束。payload 带运行身份与事件
 * 自身的数据，**不带任何活动句柄**——监听者拿不到取消或清理权限（§8.1；形态照
 * `packages/workflow/workflow/src/index.ts:31-91` 的 `workflow/*`）。
 *
 * §8.1 与 §12 阶段 4 一共列了 5 类事件，本阶段发 3 类。两条缺席各有理由，都不是"没有消费者"：
 *
 * - **程序源码**推迟到阶段 5：它要随**行号映射**一起定形。面板显示的是带行号的源码（§8.2），而
 *   同一份源码在 guest 里怎么拼接、行号怎么算回用户源码，决定事件该带原文还是带已编号的行
 *   （§8.3、§12 阶段 5）。现在定形就是猜。
 * - **原语调用起止**（位置、参数、结果、耗时）明确归阶段 5：它就是位置上报本身（§8.3）。
 *
 * 本阶段的消费者是阶段 6 的侧边栏面板（§12），所以本阶段只发不收。
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
  /** 注册用的一行标签（程序首行截出来的摘要）。 */
  readonly label: string
  /** 发起本次 run 的会话 id；job 的 owner 就是它。 */
  readonly ownerSession: SessionId
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
     * {@link Events['flow/end']} 成对：每个 job 恰好一次。
     * @param info - 本次 run 的身份快照；不含活动句柄。
     * @mode emit
     */
    'flow/start'(info: FlowStartEvent): void
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
