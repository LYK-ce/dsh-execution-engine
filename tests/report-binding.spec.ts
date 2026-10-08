import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { MessageId, UserMessage } from '@deepseek-ai/dsh-llm'
import type { PtcBindingFunction } from '@deepseek-ai/dsh-ptc-runtime'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { createReportBindings, createReportLedger, REPORT_PLUGIN } from '../host/report-binding.ts'
import type { DeliveredReport, ReportMessageFactory } from '../host/report-binding.ts'

/**
 * `report` 的投递形态与记账（phase4-plan §7）：用假发起者覆盖四条契约——消息带正确的 `source`、
 * 投递后记住 `MessageId`、程序已被拆掉时抛、以及"未投递作废"只摘还挂着的那些。
 *
 * 本文件是纯 Node 的 `pnpm run test` 直接加载的，所以跨包一律 `import type`：`@deepseek-ai/dsh-llm`
 * 在这个独立 workspace 里没有解析路径。造消息与截摘要因此由用例注入替身——它们的契约就是
 * `createUserMessage` 与 `boundContextSummary`，本模块负责的只是"用哪个 source、传什么摘要进去、
 * 投给谁、记什么账"。
 *
 * **真实装配只由 B 档覆盖**：`createUserMessage` 与 `boundContextSummary` 在这里都是替身，所以
 * 这里断言的是"摘要来自注入的截断助手"（`summary:summary:…` 那一条），**不是**"摘要被截断"——真正
 * 对 `summary` 的 ≤120 上界只有 `tests/loader-driver.ts` 的 B11 在真实装配上验证。
 */

/** 一条投递记录；与 `report-binding.ts` 的 `DeliveredReport` 同形，用于断言。 */
type Received = DeliveredReport

/** 取消原因原文；`AbortSignal.reason` 就是它，`report` 中止时抛的也是它。 */
const CANCEL_REASON = 'cancelled by the initiating agent'

/** 假的发起者：收下 `followup` 的消息，并按身份支持 `remove`（`Inbox` 里本模块用到的那两个成员）。 */
interface FakeOwner {
  readonly agent: Agent
  readonly pending: UserMessage[]
}

/**
 * 造一个假的发起者。
 * @param id - 会话 id。
 * @returns 发起者与它挂起队列里的消息。`remove` 对已经被领取的（这里用"不在队列里"表示）返回
 *   `false`，与 `Inbox.remove` 的契约一致。
 */
function fakeOwner(id: string): FakeOwner {
  const pending: UserMessage[] = []
  const agent = {
    id: id as unknown as SessionId,
    followup(message: UserMessage): void {
      pending.push(message)
    },
    inbox: {
      remove(messageId: MessageId): boolean {
        const index = pending.findIndex(message => message.id === messageId)
        if (index < 0) return false
        pending.splice(index, 1)
        return true
      },
    },
  } as unknown as Agent
  return { agent, pending }
}

/** 一个补齐身份与角色的消息构造替身；记录收到的每一份输入，便于断言 `source`。 */
function fakeMessageFactory(): { create: ReportMessageFactory; inputs: unknown[] } {
  const inputs: unknown[] = []
  let seq = 0
  return {
    inputs,
    create(input) {
      inputs.push(input)
      return {
        id: `message-${String(++seq)}` as unknown as MessageId,
        role: 'user',
        content: input.content,
        source: input.source,
      }
    },
  }
}

/** 取出 `report` 绑定；缺了就是本模块的导出面被改坏了。 */
function reportOf(bindings: Record<string, PtcBindingFunction>): PtcBindingFunction {
  const report = bindings.report
  assert.ok(report !== undefined, 'the bindings must expose report')
  return report
}

/** 一次装配好的 `report`：发起者、记账、消息构造替身与调用入口。 */
function harness(aborted = false) {
  const owner = fakeOwner('owner-a')
  const received: Received[] = []
  const ledger = createReportLedger({ onDelivered: report => { received.push(report) } })
  const factory = fakeMessageFactory()
  const controller = new AbortController()
  if (aborted) controller.abort(CANCEL_REASON)
  const report = reportOf(createReportBindings({
    owner: owner.agent,
    signal: controller.signal,
    ledger,
    createMessage: factory.create,
    boundSummary: text => `summary:${text}`,
  }))
  return { owner, ledger, factory, received, controller, report }
}

test('report 造出的消息带 execution-engine/notice 的 source，摘要来自注入的截断助手', async () => {
  const h = harness()

  assert.equal(await h.report({ text: '阶段 3 完成' }), null)

  assert.deepEqual(h.factory.inputs, [{
    content: [{ type: 'text', text: '阶段 3 完成' }],
    source: {
      kind: 'execution-engine',
      form: 'notice',
      // 整段正文进截断助手，出来的是摘要——不是把正文直接塞进 summary。
      summary: 'summary:阶段 3 完成',
    },
  }])
  assert.equal(REPORT_PLUGIN, 'execution-engine')
  assert.equal(h.owner.pending.length, 1, 'report 必须投给发起者')
})

test('投递后记住 MessageId，并把这次投递通知出去（flow/report 的数据来源）', async () => {
  const h = harness()

  await h.report({ text: 'one' })
  await h.report({ text: 'two' })

  // 顺序就是程序调用的顺序：followup 的每一条各自成为一个 turn（design.md §6.2）。
  assert.deepEqual(h.ledger.delivered.map(entry => entry.text), ['one', 'two'])
  assert.deepEqual(h.received.map(entry => entry.text), ['one', 'two'])
  assert.deepEqual(
    h.owner.pending.map(message => message.id),
    h.ledger.delivered.map(entry => entry.id),
    '记下来的身份必须是真正投出去的那条消息的身份',
  )
})

test('程序已经在被拆掉时 report 抛，且不投递也不记账', async () => {
  const h = harness(true)

  await assert.rejects(
    h.report({ text: '太晚了' }),
    (error: unknown) => {
      // 抛的是信号的中止原因本身（`AbortSignal.throwIfAborted`），不是另造一个错误。
      assert.equal(error, CANCEL_REASON)
      return true
    },
    'an aborted run must fail loud instead of silently dropping the report',
  )
  assert.deepEqual(h.owner.pending, [])
  assert.deepEqual(h.ledger.delivered, [])
  assert.deepEqual(h.factory.inputs, [], '中止之后连消息都不该造')
})

test('参数是运行期解析边界：不是带 text 字符串的对象就拒绝，且不投递', async () => {
  const h = harness()

  await assert.rejects(h.report(undefined), /report requires an argument object/)
  await assert.rejects(h.report([]), /report requires an argument object/)
  await assert.rejects(h.report({ text: 42 }), /report requires a text string/)
  assert.deepEqual(h.owner.pending, [])
  assert.deepEqual(h.ledger.delivered, [])
  // 接口声明写的是 Promise：参数不合法也要走拒绝，而不是同步抛出。
  const thrown = h.report(null)
  assert.ok(thrown instanceof Promise)
  await assert.rejects(thrown, /report requires an argument object/)
})

test('作废只摘还挂在队列里的那些，已经被领取的不算', async () => {
  const h = harness()

  await h.report({ text: 'one' })
  await h.report({ text: 'two' })
  await h.report({ text: 'three' })

  // 模拟"主 agent 已经领取了第一条"：它不在挂起队列里了。
  const claimed = h.owner.pending.shift()
  assert.ok(claimed !== undefined)

  assert.equal(h.ledger.discardPending(h.owner.agent), 2, '只有仍挂起的两条能被摘掉')
  assert.deepEqual(h.owner.pending, [], '取消之后不该还有 report 留在队列里')
  // 已投递的记录不清：它记的是"发生过什么"，不是"队列里还剩什么"。
  assert.deepEqual(h.ledger.delivered.map(entry => entry.text), ['one', 'two', 'three'])
  // 幂等：再摘一次摘不到任何东西。
  assert.equal(h.ledger.discardPending(h.owner.agent), 0)
})
