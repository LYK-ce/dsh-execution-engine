/**
 * 面板的线格式与两条 exact Fetch route 的路径（phase6-plan §2、§4）。
 *
 * `flow/*` 是 Cordis 事件，出不了宿主进程（`host/flow-events.ts`），浏览器只能经路由拿状态；
 * 这份模块是那两条路由**两侧共用**的声明，所以两边都只能看到它认识的东西：
 *
 * - 不带任何 `@deepseek-ai/*` import——它同时进 host 与 client 两个 program
 *   （`tsconfig.json` 与 `tsconfig.client.json`），而这两半的服务合并是分开的。
 * - **跨进程的 id 在这里是裸 `string`**：`JobId` / `SessionId` 的 brand 是进程内的类型，
 *   出了宿主就得落到 JSON 上；两侧各自在边界处重新收窄（`host/flow-state.ts` 与
 *   `client/index.tsx`）。wire 边界本来就要校验，这里不为它伪造一个类型。
 *
 * @module dsh-execution-engine/shared/protocol
 */

/** 读当前 run 状态的 exact Fetch route；查询参数 `sessionId` 与 `since`。 */
export const STATE_PATH = '/api/execution-engine.state'

/** 取消当前 run 的 exact Fetch route；查询参数 `sessionId`。 */
export const CANCEL_PATH = '/api/execution-engine.cancel'

/**
 * run 的状态。
 *
 * `running` 只在 `flow/start` 之后、`flow/end` 之前；其余三个逐字就是 `JobOutcome['status']`
 * （`flow-events.ts` 的 `FlowEndEvent.status`），所以它们之间不做改名映射。
 */
export type FlowRunStatus = 'running' | 'completed' | 'killed' | 'failed'

/**
 * 面板状态里的 run 头部：**每次响应全量给**，不参与增量。
 *
 * 它很小（源码是唯一的大字段），而增量只值得花在会无限增长的轨迹上；把头部也做成增量的唯一
 * 后果是客户端要自己维护"我这一份头部新不新"，换不来任何东西。
 */
export interface FlowRunHeader {
  /** 注册表发的 `<kind>-N`；客户端拿它判"是不是换了一次 run"。 */
  readonly runId: string
  /** 展示用的单行标签（程序首行摘要，`host/job-runner.ts` 的 `programLabel`）。 */
  readonly label: string
  /** 提交的程序正文原文；`calls` 里 `line` 指的就是它的行号。 */
  readonly code: string
  /** `code` 的行数。面板按行渲染时用它，免得每次自己 split。 */
  readonly lineCount: number
  readonly status: FlowRunStatus
  /** 宿主收到 `flow/start` 的墙钟毫秒数。 */
  readonly startedAt: number
  /** 宿主收到 `flow/end` 的墙钟毫秒数；还在跑时缺席。 */
  readonly endedAt?: number
  /** 终态说明（取消原因，或程序自己的失败原因）；没有时缺席。 */
  readonly detail?: string
  /**
   * `flow/end` 报的作废条数：本次取消吃掉了几条已经投出、但主 agent 还没读到的汇报。
   *
   * 只有条数，没有"是哪几条"——引擎那一侧也只有条数（`host/job-runner.ts` 的
   * `discardPending` 返回计数），观察事件里不存在这个事实，面板不替它编一个。
   */
  readonly discarded: number
}

/** 一条原语调用的轨迹条目；由 `flow/call-start` 开、由配对的 `flow/call-end` 合上。 */
export interface FlowCallEntry {
  readonly kind: 'call'
  /** 在这条轨迹流里的序号（从 `0` 起，1 递增）；客户端拿它当增量游标。 */
  readonly seq: number
  /** 本次 run 内唯一的调用序号，与事件的 `callId` 同值；循环里同一行反复出现时行号相同而它不同。 */
  readonly callId: number
  /** 被调用的原语名。 */
  readonly member: string
  /** 调用点在用户源码里的行号（1-based）；拿不到栈时是 `null`。 */
  readonly line: number | null
  /** 还没有配对的 `flow/call-end` 时是 `open`。 */
  readonly state: 'open' | 'ok' | 'error'
  /** 从调用开始到结算的毫秒数；`open` 时缺席。 */
  readonly ms?: number
  /** 返回值预览（`ok`）或错误文本（`error`），有界；`open` 时缺席。 */
  readonly preview?: string
  /**
   * 这条调用是**宿主补发**的闭合：程序在它结算前就终止了（取消、超时，或不 `await` 就 `return`）。
   *
   * 与 `host/flow-events.ts` 的 `FlowCallEndEvent.synthetic` 同一个事实：程序自己报的结局不带它。
   */
  readonly synthetic?: true
}

/** 一条 `report` 的轨迹条目。 */
export interface FlowReportEntry {
  readonly kind: 'report'
  /** 与 {@link FlowCallEntry.seq} 同一条序列。 */
  readonly seq: number
  /** report 正文，逐字（引擎不截断它，见 `host/flow-events.ts` 的 `FlowReportEvent.text`）。 */
  readonly text: string
}

/** 轨迹条目：一次原语调用或一条 report，按发生顺序。 */
export type FlowEntry = FlowCallEntry | FlowReportEntry

/**
 * `GET {@link STATE_PATH}` 的响应体。
 *
 * 增量契约：`entries` 是 `seq >= since` 的那些条目，`revision` 是下一次请求该拿的游标。
 * **接不上时回退成全量**（`reset: true`，`entries` 是当前保留的全部条目）——`since` 指向已经被
 * 有界保留挤掉的条目、大于最新，或这个会话还没有过 run 时。回退而不是报错：面板是观察面，
 * 它要的是"现在是什么状态"，不是"你的游标错了"。
 */
export interface FlowSnapshot {
  /** 这个会话当前这一版 run 的头部；从来没有跑过程序时是 `null`。 */
  readonly run: FlowRunHeader | null
  /** 这条轨迹流已经分配出去的序号总数，等于下次请求该传的 `since`。 */
  readonly revision: number
  /** `since` 之后新增的条目；`reset` 为真时是当前保留的全部条目。 */
  readonly entries: readonly FlowEntry[]
  /** 本次响应是不是一次整份重来：客户端要先丢掉本地已积累的条目。 */
  readonly reset: boolean
}

/** `POST {@link CANCEL_PATH}` 的响应体；形态与 `cancel_program` 的工具结果一致（design.md §4.4 的幂等）。 */
export interface CancelResult {
  /** 本次调用是否真的停掉了一个程序；没有在跑的程序时是 `false`。 */
  readonly cancelled: boolean
  /** 被停掉的 job id；`cancelled: false` 时缺席。 */
  readonly jobId?: string
  /** job 的终态；`cancelled: false` 时缺席。 */
  readonly status?: Exclude<FlowRunStatus, 'running'>
  /** job 的终态说明；没有时缺席。 */
  readonly detail?: string
}
