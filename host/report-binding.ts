/**
 * `report`：程序把一段内容单向汇报回发起会话（design.md §6.1–§6.3、§4.4；phase4-plan §2–§3）。
 *
 * 投递形态照 `packages/jobs/tool-jobs/src/index.ts:278-299`：`createUserMessage` 造一条带 `source`
 * 的用户消息（`form: 'notice'` 加一行折叠摘要），再 `owner.followup(message)`。选 followup 而不是
 * inject 是 design.md §6.1 的裁决：每条 report 自己成为一个 turn，**严格有序、不打断**主 agent
 * 正在做的事；代价是每条一次模型调用，而额度不由引擎管（§10.1：频率由程序自己掌握）。
 *
 * 模块的另一半是记账：投递过的 `MessageId` 全留在 {@link ReportLedger} 上，run 被取消时按它们把
 * 还没被领取的消息从挂起队列里摘掉（design.md §4.4 的"未投递的 report 全部作废"）。
 *
 * 本模块**不引入任何运行时依赖**：纯 Node 的 `pnpm run test` 要能直接加载它（phase1-plan §10
 * A 档），而 `@deepseek-ai/dsh-llm` 在这个独立 workspace 里没有解析路径（同 `host/config.ts` 的
 * 理由），所以"造消息"与"截摘要"两个助手由装配方注入（`host/engine.ts`）。
 * @module dsh-execution-engine/report-binding
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock, ContextFormed, MessageId, UserMessage } from '@deepseek-ai/dsh-llm'
import type { PtcBindingFunction, PtcJsonValue } from '@deepseek-ai/dsh-ptc-runtime'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** 本插件发出的 report 消息；`form: 'notice'` 加一行折叠摘要，形态照 `tool-jobs`。 */
    'execution-engine': { kind: 'execution-engine' } & ContextFormed
  }
}

/** 本插件的 Loader 名；report 的 `source.kind` 与它同名（上面那条声明合并登记了它）。 */
export const REPORT_PLUGIN = 'execution-engine'

/**
 * 造一条带身份的 report 消息。装配方注入 `@deepseek-ai/dsh-llm` 的 `createUserMessage`
 * （理由见模块头）。参数与 `createUserMessage` 的输入面一致，`role` 与 `id` 由它补。
 */
export type ReportMessageFactory = (input: {
  readonly content: ContentBlock[]
  readonly source: { readonly kind: 'execution-engine' } & ContextFormed
}) => UserMessage

/** 一条已经投递出去的 report。 */
export interface DeliveredReport {
  /** 这条消息的身份；作废时按它从挂起队列里摘。 */
  readonly id: MessageId
  /** 汇报正文；`flow/report` 事件逐字带上它。 */
  readonly text: string
}

/** 本次 run 的 report 记账。 */
export interface ReportLedger {
  /** 本次 run 已经投出去的 report，按程序调用顺序。 */
  readonly delivered: readonly DeliveredReport[]
  /**
   * 记一次投递。
   * @param messageId - 投出去那条消息的身份。
   * @param text - 该条 report 的正文。
   */
  record(messageId: MessageId, text: string): void
  /**
   * 把还挂在发起者挂起队列里的 report 全部摘掉；已经被某个 turn 领取的摘不到，也不该摘
   * （design.md §4.4："已投递的撤不回"）。
   * @param owner - 发起本次 run 的主 agent。
   * @returns 真的被摘掉的条数，也就是"还没有被领取"的那部分。
   */
  discardPending(owner: Agent): number
}

/** `createReportLedger` 的观察出口。 */
export interface ReportLedgerOptions {
  /**
   * 一条 report 投递成功后的通知出口（`host/job-runner.ts` 用它发 `flow/report`）。run 身份
   * （job id）在 `ctx.jobs.start` 返回之后才成立，所以这里由调用方给一个在投递发生的那一刻读它
   * 自己身份的闭包；第一次投递最早也只能发生在那一刻之后——`runProgram` 先 await 建临时目录，
   * 再把绑定交给 PTC。
   */
  readonly onDelivered: (report: DeliveredReport) => void
}

/**
 * 造一个本次 run 的 report 记账。
 * @param options - 投递成功后的通知出口。
 * @returns 记账：记录、作废、以及已投递清单。
 */
export function createReportLedger(options: ReportLedgerOptions): ReportLedger {
  const delivered: DeliveredReport[] = []
  return {
    delivered,
    record(messageId: MessageId, text: string): void {
      const report: DeliveredReport = { id: messageId, text }
      delivered.push(report)
      options.onDelivered(report)
    },
    discardPending(owner: Agent): number {
      let discarded = 0
      // `Inbox.remove` 对已经被领取的消息返回 `false`（`packages/core/agent/src/runtime-types.ts:79-84`），
      // 所以计数天然只算"仍挂起"的那部分。
      for (const report of delivered) {
        if (owner.inbox.remove(report.id)) discarded += 1
      }
      return discarded
    },
  }
}

/** `createReportBindings` 需要的外部依赖、本次 run 的权威与两个注入助手。 */
export interface ReportBindingOptions {
  /** 发起本次 run 的主 agent；report 投进它的收件箱（design.md §5.1）。 */
  readonly owner: Agent
  /** run 级取消信号；程序已经在被拆掉时 report 直接抛。 */
  readonly signal: AbortSignal
  /** 本次 run 的记账。 */
  readonly ledger: ReportLedger
  /** 造一条带身份的 report 消息；装配方注入 `createUserMessage`。 */
  readonly createMessage: ReportMessageFactory
  /** 把整段 report 截成一行折叠摘要；装配方注入 `boundContextSummary`。 */
  readonly boundSummary: (text: string) => string
}

/**
 * `report` 的实现。
 *
 * 只等**投递成功**，不等主 agent 处理完（design.md §6.3）：程序里因此有一个确定的时序点——这一行
 * 返回时，那条消息已经在发起者的挂起队列里了。
 * @param options - 发起者、取消信号、记账与两个注入助手。
 * @returns 注册进 PTC `flow` 绑定命名空间的函数。
 */
export function createReportBindings(options: ReportBindingOptions): Record<string, PtcBindingFunction> {
  return {
    report: async (args: unknown): Promise<PtcJsonValue> => {
      const text = readText(args)
      // 程序正在被拆掉：静默吞掉会让程序里的"报过了"变成假的（phase4-plan §2 的失败语义）。
      options.signal.throwIfAborted()
      const message = options.createMessage({
        content: [{ type: 'text', text }],
        source: {
          kind: 'execution-engine',
          form: 'notice',
          summary: options.boundSummary(text),
        },
      })
      options.owner.followup(message)
      options.ledger.record(message.id, text)
      return null
    },
  }
}

/**
 * 校验程序给的参数。程序是外部输入，所以这里是运行期的解析边界：必须是一个带字符串 `text` 的对象
 * （形态与 `dispatchsubagent` 的 `{ prompt }` 一致）。
 * @param value - 绑定调用收到的单个参数值。
 * @returns report 正文。
 */
function readText(value: unknown): string {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('report requires an argument object with a text string')
  }
  const text = (value as Record<string, unknown>).text
  if (typeof text !== 'string') {
    throw new TypeError('report requires a text string')
  }
  return text
}
