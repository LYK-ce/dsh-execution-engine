import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { PtcBindingFunction } from '@deepseek-ai/dsh-ptc-runtime'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SubagentResult, SubagentRun, SubagentRuntime, SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import { createSubagentBindings } from '../host/subagent-binding.ts'

/** 一次脚本化 `start` 收到的请求摘录；归属与 provider 断言比对的就是这几项。 */
interface StartRecord {
  readonly provider: string
  readonly prompt: ContentBlock[]
  readonly parent: Agent
}

/** 脚本化子 agent 执行缝：记录每次 `start`，返回给定的 run。 */
interface FakeSubagents {
  readonly runtime: SubagentRuntime
  readonly starts: StartRecord[]
}

/** 发起本次 run 的主 agent；binding 只把它当不透明的归属入参用。 */
const PARENT = { id: 'scripted-parent' } as unknown as Agent

/**
 * 建一个最小 `SubagentRun`。
 * @param result - `run.result` 交回的结果。
 * @param dispose - 清理实现；缺省为空操作。
 * @returns 只带 binding 真正会读的三项。
 */
function runOf(result: SubagentResult, dispose: () => Promise<void> = () => Promise.resolve()): SubagentRun {
  return {
    id: 'scripted-child' as unknown as SessionId,
    localAgent: undefined,
    result: Promise.resolve(result),
    dispose,
  }
}

/**
 * 建一个脚本化的 `ctx.subagents` 替身：只实现 binding 用到的那一个方法。
 * @param next - 每次 `start` 交回的 run。
 * @returns 替身与它记录的 start 列表。
 */
function scriptedSubagents(next: (record: StartRecord) => SubagentRun): FakeSubagents {
  const starts: StartRecord[] = []
  const runtime = {
    start(provider: string, request: SubagentStartRequest): Promise<SubagentRun> {
      const record: StartRecord = { provider, prompt: request.prompt, parent: request.parent }
      starts.push(record)
      return Promise.resolve(next(record))
    },
  }
  return { runtime: runtime as unknown as SubagentRuntime, starts }
}

/** 一次 binding 调用要用的装配参数。 */
interface BindingOptions {
  readonly subagents: SubagentRuntime
  /** 发起者；省略表示用 {@link PARENT}——binding 的入参是必填，缺席在类型层就不可表达。 */
  readonly parent?: Agent
  readonly signal?: AbortSignal
  readonly warnings?: string[]
}

/**
 * 组装一份 `flow` 绑定。
 * @param options - 子 agent 执行缝、发起者、取消信号与告警收集器。
 * @returns 注册进 PTC 绑定命名空间的那份函数表。
 */
function bindingsFor(options: BindingOptions): Record<string, PtcBindingFunction> {
  return createSubagentBindings({
    parent: options.parent ?? PARENT,
    provider: 'scripted',
    signal: options.signal ?? new AbortController().signal,
    subagents: options.subagents,
    warn: (message: string) => { options.warnings?.push(message) },
  })
}

/**
 * 调一次 `dispatchsubagent`。
 * @param bindings - `flow` 命名空间。
 * @param prompt - 程序传进来的那个参数值。
 * @returns binding 的完成值。
 */
async function dispatch(
  bindings: Record<string, PtcBindingFunction>,
  prompt: unknown,
): Promise<unknown> {
  const binding = bindings.dispatchsubagent
  assert.ok(binding !== undefined, 'the flow namespace must expose dispatchsubagent')
  return await binding({ prompt })
}

/**
 * 调一次 `dispatchsubagent` 并把抛出物拿回来，供逐字段断言用。
 * @param bindings - `flow` 命名空间。
 * @param prompt - 程序传进来的那个参数值。
 * @returns 抛出的错误。
 */
async function failureOf(bindings: Record<string, PtcBindingFunction>, prompt: unknown): Promise<Error> {
  try {
    await dispatch(bindings, prompt)
  } catch (error: unknown) {
    assert.ok(error instanceof Error, 'dispatchsubagent must throw an Error')
    return error
  }
  throw new Error('dispatchsubagent was expected to throw')
}

/** 正常完成：文本块按序拼接，非文本块不进返回值。 */
test('正常完成时返回子 agent 的最终文本', async () => {
  const fake = scriptedSubagents(() => runOf({
    output: [
      { type: 'text', text: '前半' },
      { type: 'reasoning', text: '不进文本' },
      { type: 'text', text: '后半' },
    ],
    stopReason: 'completed',
  }))
  assert.equal(await dispatch(bindingsFor({ subagents: fake.runtime }), 'do the thing'), '前半后半')
  assert.equal(fake.starts.length, 1)
})

/** 归属与路由都是入参：`start` 收到的 provider 名和 parent 逐字来自装配方。 */
test('provider 名与父 agent 原样透传', async () => {
  const fake = scriptedSubagents(() => runOf({ output: [{ type: 'text', text: 'ok' }], stopReason: 'completed' }))
  await dispatch(bindingsFor({ subagents: fake.runtime }), 'p')
  const start = fake.starts[0]
  assert.ok(start !== undefined)
  assert.equal(start.provider, 'scripted', 'the configured provider name must reach ctx.subagents')
  assert.equal(start.parent, PARENT, 'the initiating agent must be the one and only parent')
  assert.deepEqual(start.prompt, [{ type: 'text', text: 'p' }])
})

/** `stopReason` 不是 `completed` 就抛，消息里带上 reason（phase2-plan §9 Q1）。 */
test('非正常完成时抛出并带上 reason', async () => {
  for (const stopReason of ['error', 'aborted', 'max-tokens', 'refusal'] as const) {
    const fake = scriptedSubagents(() => runOf({ output: [], stopReason }))
    const failure = await failureOf(bindingsFor({ subagents: fake.runtime }), 'p')
    assert.ok(failure.message.includes(stopReason), `the message must name ${stopReason}`)
    assert.ok(!failure.message.includes('Diagnostic:'), 'a result without a diagnostic must not grow one')
  }
})

/**
 * 非正常完成的消息带上 provider 的诊断与结束前的部分输出：`SubagentResult` 把两者定义为有意的
 * 信息通道（`packages/subagent/subagent/src/types.ts:288-294`），丢掉就是丢掉"为什么失败"与
 * "已经拿到什么"（形态先例 `packages/subagent/tool-subagent/src/index.ts:183-195`）。
 */
test('非正常完成时带上 diagnostic 与结束前的部分输出', async () => {
  const fake = scriptedSubagents(() => runOf({
    output: [{ type: 'text', text: 'PARTIAL-ANSWER' }],
    stopReason: 'error',
    diagnostic: 'DIAGNOSTIC-TEXT',
  }))
  const failure = await failureOf(bindingsFor({ subagents: fake.runtime }), 'p')
  assert.match(failure.message, /error/)
  assert.match(failure.message, /Diagnostic: DIAGNOSTIC-TEXT/)
  assert.match(failure.message, /Partial output before the run ended:\nPARTIAL-ANSWER/)
  // 同一进程里的调用方按类别分支，不必从消息文本里认。
  assert.equal((failure as { stopReason?: unknown }).stopReason, 'error')
})

/** `run.result` 本身的拒绝（基础设施故障）原样上抛，不被清理顶掉。 */
test('result 的拒绝原样上抛', async () => {
  const runtime = {
    start: () => Promise.resolve({
      id: 'child',
      localAgent: undefined,
      result: Promise.reject(new Error('provider blew up')),
      dispose: () => Promise.resolve(),
    }),
  }
  await assert.rejects(
    () => dispatch(bindingsFor({ subagents: runtime as unknown as SubagentRuntime }), 'p'),
    /provider blew up/,
  )
})

/** 成功与失败两条路都要 dispose——漏了就会漏子 agent。 */
test('成功与失败两条路都 dispose 一次', async () => {
  let completed = 0
  const ok = scriptedSubagents(() => runOf(
    { output: [{ type: 'text', text: 'ok' }], stopReason: 'completed' },
    () => { completed += 1; return Promise.resolve() },
  ))
  assert.equal(await dispatch(bindingsFor({ subagents: ok.runtime }), 'p'), 'ok')
  assert.equal(completed, 1, 'a completed run must still be disposed')

  let failed = 0
  const bad = scriptedSubagents(() => runOf(
    { output: [], stopReason: 'error' },
    () => { failed += 1; return Promise.resolve() },
  ))
  await assert.rejects(() => dispatch(bindingsFor({ subagents: bad.runtime }), 'p'))
  assert.equal(failed, 1, 'a failed run must still be disposed')
})

/** dispose 失败只告警：已经选定的结果不因为清理失败而改变。 */
test('dispose 失败只告警，不改变结果', async () => {
  const warnings: string[] = []
  const fake = scriptedSubagents(() => runOf(
    { output: [{ type: 'text', text: 'ok' }], stopReason: 'completed' },
    () => Promise.reject(new Error('cleanup exploded')),
  ))
  assert.equal(await dispatch(bindingsFor({ subagents: fake.runtime, warnings }), 'p'), 'ok')
  assert.equal(warnings.length, 1, 'the dispose failure must be reported through warn')
  assert.match(warnings[0] ?? '', /cleanup exploded/)
})

/** 信号已经中止：不起子 agent。 */
test('信号已中止时不调用 start', async () => {
  const fake = scriptedSubagents(() => runOf({ output: [{ type: 'text', text: 'ok' }], stopReason: 'completed' }))
  const controller = new AbortController()
  controller.abort(new Error('run cancelled'))
  await assert.rejects(() => dispatch(bindingsFor({ subagents: fake.runtime, signal: controller.signal }), 'p'))
  assert.equal(fake.starts.length, 0, 'an aborted run must not start a child')
})

/**
 * 信号在 start 挂起期间中止：provider 仍然可能 publish 出一个 run，它必须被 dispose 掉再抛，
 * 否则就是一个没有归属的孤儿（先例 `packages/workflow/workflow-ptc/src/host.ts:214-218`）。
 */
test('信号在 start 挂起期间中止：dispose 该 run 并抛', async () => {
  const controller = new AbortController()
  let disposed = 0
  const fake = scriptedSubagents(() => runOf(
    { output: [{ type: 'text', text: 'ok' }], stopReason: 'completed' },
    () => { disposed += 1; return Promise.resolve() },
  ))
  const pending = dispatch(bindingsFor({ subagents: fake.runtime, signal: controller.signal }), 'p')
  // start 是同步记录的，所以这里中止的正是"起动还没 resolve"的那一段。
  controller.abort(new Error('run cancelled'))
  await assert.rejects(() => pending, /started after the run was cancelled/)
  assert.equal(fake.starts.length, 1, 'the provider had already published the run')
  assert.equal(disposed, 1, 'a run published after cancellation must still be disposed')
})

/**
 * 信号在等 result 期间中止，而 provider 的 result 不因 abort settle：不能永远挂着，
 * 更不能因此不 dispose（那样就漏子 agent）。形态照 `workflow-ptc/src/host.ts:222-238` 的 race。
 */
test('信号中止后 result 不 settle：抛中止原因并 dispose', async () => {
  const controller = new AbortController()
  let disposed = 0
  const fake = scriptedSubagents(() => ({
    id: 'scripted-child' as unknown as SessionId,
    localAgent: undefined,
    result: new Promise<SubagentResult>(() => {}),
    dispose: () => { disposed += 1; return Promise.resolve() },
  }))
  const pending = dispatch(bindingsFor({ subagents: fake.runtime, signal: controller.signal }), 'p')
  // 让 binding 走完 post-start 复查、真正等上 result，再中止。
  await delay(5)
  controller.abort(new Error('run cancelled'))
  await assert.rejects(() => pending, /run cancelled/)
  assert.equal(fake.starts.length, 1)
  assert.equal(disposed, 1, 'the aborted run must still be disposed')
})

// 发起者缺席这一支在 binding 里不可表达：`SubagentBindingOptions.parent` 是必填。生产上唯一会
// 触发的那一层判空在 `host/index.ts`（`exec.agent` 是可选字段），由 `tests/loader-driver.ts` 端到端覆盖。

/** 参数是程序给的，属于运行期解析边界：坏参数以拒绝表达，且不会变成一次 start。 */
test('坏参数被拒且不产生 start', async () => {
  const fake = scriptedSubagents(() => runOf({ output: [{ type: 'text', text: 'ok' }], stopReason: 'completed' }))
  const bindings = bindingsFor({ subagents: fake.runtime })
  const binding = bindings.dispatchsubagent
  assert.ok(binding !== undefined)
  await assert.rejects(() => dispatch(bindings, 42), /prompt string/)
  await assert.rejects(() => dispatch(bindings, undefined), /prompt string/)
  // 绑定函数对坏参数是同步抛；外壳那一层是 async，所以程序看到的仍是拒绝（与 `process` 同形）。
  await assert.rejects(async () => await binding('not-an-object'), /argument object/)
  await assert.rejects(async () => await binding(['prompt']), /argument object/)
  assert.equal(fake.starts.length, 0)
})
