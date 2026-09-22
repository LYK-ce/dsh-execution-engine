/**
 * `flow/*` 的第一个真实消费者：按会话折叠出"当前这一版 run"的状态，供 HTTP 路由读取
 * （phase6-plan §2；design.md §8.1、§8.2）。
 *
 * **为什么面板的数据不走 session log。** `flow/*` 是 Cordis 观察事件，不是会话事件：它们没有进
 * `SessionEventMap`，也不落盘，所以宿主进程之外（浏览器）看不见它们，刷新页面也回放不出来。
 * 把它们改成 log-only 会话事件，面板就能回放——代价是要动 `SessionEventMap` 与持久化，而本轮的目标
 * 是把面板做出来。所以这里选**宿主侧累加 + fetch route**（与 `Workspace/Blackboard` 同一个形态），
 * **面板不可回放**这条代价记在 design.md 的已知限制里。将来若要回放，正是把 `flow/*` 落成
 * log-only 会话事件 + 由本模块改读日志。
 *
 * 三条累加契约：
 *
 * - **单例之下只有当前那一版 run**：`flow/start` 就是"这一版换掉了上一版"，旧记录当场丢掉
 *   （design.md §4.2 保证同一会话同时只有一个程序在跑）。终态**保留**到下一次 `flow/start`，
 *   否则面板会在 run 结算的瞬间把结果清空。
 * - **有界**：轨迹只留最近 {@link MAX_CALLS} 条调用与 {@link MAX_REPORTS} 条 report，超界丢最旧
 *   （phase6-plan §9 Q3 的裁决）。有界不破坏增量：`since` 落到已被丢掉的区间时整份重来
 *   （{@link FlowSnapshot.reset}）。
 * - **不认识的事件直接丢**：run 身份在 `flow/*` 上只有 `runId`，而记录只有 `flow/start` 才建得起来。
 *   收到一个没有对应记录的 run 的事件，说明这条链的时序被改坏了；这里不替它编一份状态。
 *
 * 本模块没有运行时依赖（跨包一律 `import type`），所以纯 Node 的 `pnpm run test` 能直接加载它。
 * @module dsh-execution-engine/flow-state
 */

import type { SessionId } from '@deepseek-ai/dsh-session'
import type {
  FlowCallEndEvent,
  FlowCallStartEvent,
  FlowEndEvent,
  FlowReportEvent,
  FlowStartEvent,
} from './flow-events.ts'
import type { FlowCallEntry, FlowEntry, FlowReportEntry, FlowRunHeader, FlowSnapshot } from '../shared/protocol.ts'

/** 一个会话里保留的调用条数上限（phase6-plan §9 Q3：200 条调用）。 */
export const MAX_CALLS = 200

/** 一个会话里保留的 report 条数上限（phase6-plan §9 Q3：50 条 report）。 */
export const MAX_REPORTS = 50

/** 一个会话当前的 run 记录；`flow/start` 建、后续事件改。 */
interface RunRecord {
  readonly runId: string
  readonly label: string
  readonly code: string
  readonly lineCount: number
  readonly startedAt: number
  status: FlowRunHeader['status']
  endedAt?: number
  detail?: string
  discarded: number
  /** 轨迹条目，按 `seq` 升序；有界见 {@link MAX_CALLS} / {@link MAX_REPORTS}。 */
  entries: FlowEntry[]
  /** 下一条条目的序号，等于对外报告的 `revision`。 */
  nextSeq: number
}

/** 一个还没有过任何 run 的会话的响应。 */
const NO_RUN: FlowSnapshot = { run: null, revision: 0, entries: [], reset: true }

/**
 * 每会话的 run 累加器。
 *
 * 实例由 `host/index.ts` 建一个，生命周期跟插件走；本类自己不订阅任何东西，事件由装配方喂进来
 * （那一条界线让 `pnpm run test` 能在纯 Node 下把折叠逻辑跑透）。
 */
export class FlowState {
  /** runId → 记录。**只有当前这一版**：换 run 时旧的从这里删掉。 */
  private readonly runs = new Map<string, RunRecord>()
  /** 会话 id → 当前 run 的 id。 */
  private readonly current = new Map<string, string>()

  /**
   * 读一个会话当前 run 的状态快照。
   * @param sessionId - 目标会话。
   * @param since - 客户端已经拿到的条目数（下一次要的序号）；调用方已保证它是非负安全整数。
   * @returns 头部、游标与 `since` 之后的条目；接不上时整份重来（`reset: true`）。
   */
  read(sessionId: SessionId, since: number): FlowSnapshot {
    const record = this.currentRun(sessionId)
    if (record === undefined) return NO_RUN
    const oldest = record.entries[0]?.seq ?? record.nextSeq
    // 接不上的两种情形都回退成全量：`since` 落在已经被丢掉的区间里（有界保留挤掉了它），
    // 或者比最新还大（客户端拿着另一次 run / 另一个宿主的游标）。
    const gap = since < oldest || since > record.nextSeq
    return {
      run: header(record),
      revision: record.nextSeq,
      entries: gap ? [...record.entries] : record.entries.filter(entry => entry.seq >= since),
      reset: gap,
    }
  }

  /**
   * `flow/start`：开始新的一版 run，丢掉这个会话上一次的记录。
   * @param info - 事件 payload（run 身份与程序正文）。
   */
  start(info: FlowStartEvent): void {
    const previous = this.current.get(info.ownerSession)
    if (previous !== undefined) this.runs.delete(previous)
    this.current.set(info.ownerSession, info.runId)
    this.runs.set(info.runId, {
      runId: info.runId,
      label: info.label,
      code: info.code,
      lineCount: countLines(info.code),
      startedAt: Date.now(),
      status: 'running',
      discarded: 0,
      entries: [],
      nextSeq: 0,
    })
  }

  /**
   * `flow/call-start`：追加一条 `open` 的调用条目。
   * @param info - 事件 payload。
   */
  callStart(info: FlowCallStartEvent): void {
    const record = this.runs.get(info.runId)
    if (record === undefined) return
    record.entries.push({
      kind: 'call',
      seq: record.nextSeq,
      callId: info.callId,
      member: info.member,
      line: info.line,
      state: 'open',
    })
    record.nextSeq += 1
    this.trim(record)
  }

  /**
   * `flow/call-end`：合上配对的那条调用条目。
   *
   * 找不到配对条目就丢掉这条事件：唯一的可能是那条 `start` 已经被有界保留挤掉（或者这次 run 的记录
   * 已经被换掉了），而"凭空补一条已经结束的调用"会把一个没发生过的调用画到轨迹上。
   * @param info - 事件 payload。
   */
  callEnd(info: FlowCallEndEvent): void {
    const record = this.runs.get(info.runId)
    if (record === undefined) return
    const at = record.entries.findIndex(
      entry => entry.kind === 'call' && entry.callId === info.callId && entry.state === 'open',
    )
    if (at < 0) return
    const entry = record.entries[at] as FlowCallEntry
    const settled = info.outcome === 'ok' ? info.result : info.error
    record.entries[at] = {
      ...entry,
      state: info.outcome === 'ok' ? 'ok' : 'error',
      ms: info.ms,
      ...settled === undefined ? {} : { preview: settled },
      ...info.synthetic === true ? { synthetic: true as const } : {},
    }
  }

  /**
   * `flow/report`：追加一条 report 条目。
   * @param info - 事件 payload。
   */
  report(info: FlowReportEvent): void {
    const record = this.runs.get(info.runId)
    if (record === undefined) return
    const entry: FlowReportEntry = { kind: 'report', seq: record.nextSeq, text: info.text }
    record.entries.push(entry)
    record.nextSeq += 1
    this.trim(record)
  }

  /**
   * `flow/end`：写终态。记录**不删**——面板要看到这次 run 是怎么结束的，直到下一次 `flow/start`。
   * @param info - 事件 payload（终态、作废条数与说明）。
   */
  end(info: FlowEndEvent): void {
    const record = this.runs.get(info.runId)
    if (record === undefined) return
    record.status = info.status
    record.endedAt = Date.now()
    record.discarded = info.discarded
    if (info.detail === undefined) delete record.detail
    else record.detail = info.detail
  }

  /**
   * 取一个会话当前那一版 run。
   * @param sessionId - 目标会话。
   * @returns 记录；这个会话还没有过 run 时是 `undefined`。
   */
  private currentRun(sessionId: SessionId): RunRecord | undefined {
    const runId = this.current.get(sessionId)
    return runId === undefined ? undefined : this.runs.get(runId)
  }

  /**
   * 把两类条目各自裁到上限。
   *
   * 按**种类**而不是按总长度裁：调用与 report 是两条独立的观察流，谁先涨满都不该挤掉另一种。
   * 两类各自按序号从旧到新丢，所以剩下的这一段永远是连续后缀——这正是 `since` 增量成立的前提。
   * @param record - 刚追加过条目的记录。
   */
  private trim(record: RunRecord): void {
    dropOldest(record, 'call', MAX_CALLS)
    dropOldest(record, 'report', MAX_REPORTS)
  }
}

/**
 * 数一个程序正文的行数。
 * @param code - 程序正文。
 * @returns 行数；空正文是 `0`（不是 `String.prototype.split` 会给的 1）。
 */
function countLines(code: string): number {
  return code === '' ? 0 : code.split('\n').length
}

/**
 * 把某一类条目裁到上限，从最旧的一条开始丢。
 * @param record - 目标记录。
 * @param kind - 要裁的条目种类。
 * @param limit - 该种类的保留条数上限。
 */
function dropOldest(record: RunRecord, kind: FlowEntry['kind'], limit: number): void {
  let count = 0
  for (const entry of record.entries) if (entry.kind === kind) count += 1
  while (count > limit) {
    const at = record.entries.findIndex(entry => entry.kind === kind)
    /* v8 ignore next -- count 是刚刚数出来的，> limit ≥ 0 时 findIndex 必然命中。 */
    if (at < 0) return
    record.entries.splice(at, 1)
    count -= 1
  }
}

/**
 * 折出对外的头部。
 * @param record - 目标记录。
 * @returns 头部；可选字段缺席时不带这个键（`exactOptionalPropertyTypes`）。
 */
function header(record: RunRecord): FlowRunHeader {
  return {
    runId: record.runId,
    label: record.label,
    code: record.code,
    lineCount: record.lineCount,
    status: record.status,
    startedAt: record.startedAt,
    ...record.endedAt === undefined ? {} : { endedAt: record.endedAt },
    ...record.detail === undefined ? {} : { detail: record.detail },
    discarded: record.discarded,
  }
}
