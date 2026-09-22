import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import type { Agent, AgentOptions } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { PtcBindingFunction } from '@deepseek-ai/dsh-ptc-runtime'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SubagentResult, SubagentRun, SubagentRuntime, SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import { createSubagentBindings } from '../host/subagent-binding.ts'
import type { SubagentModelSelection } from '../host/subagent-binding.ts'

/** 一次脚本化 `start` 收到的请求摘录；归属、prompt 与显式路由断言比对的就是这几项。 */
interface StartRecord {
  readonly provider: string
  readonly prompt: ContentBlock[]
  readonly parent: Agent
  readonly signal: AbortSignal
  /** 请求里的 `agentOptions`；程序没显式指定路由时缺席。 */
  readonly agentOptions: AgentOptions | undefined
  /** 键**是否在场**：省略与显式 `undefined` 是两回事，继承语义靠的是省略。 */
  readonly hasAgentOptions: boolean
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
      const record: StartRecord = {
        provider,
        prompt: request.prompt,
        parent: request.parent,
        signal: request.signal,
        agentOptions: request.agentOptions,
        hasAgentOptions: Object.hasOwn(request, 'agentOptions'),
      }
      starts.push(record)
      return Promise.resolve(next(record))
    },
  }
  return { runtime: runtime as unknown as SubagentRuntime, starts }
}

/**
 * 一份固定的路由策略。默认开启并列出给定 route——`enabled` / 空清单两支由用例自己传。
 * @param allowedModels - 允许显式选择的路由。
 * @param enabled - 策略是否开启。
 * @returns 每次调用都交回同一份策略的访问器。
 */
function selectionOf(
  allowedModels: readonly { provider: string; model: string }[],
  enabled = true,
): () => SubagentModelSelection {
  return () => ({ enabled, allowedModels })
}

/** 本 spec 的样例 route；`MODEL_SELECTION` 与它一致。 */
const ROUTE = { provider: 'route-provider', model: 'route-model' }

/** 一次 binding 调用要用的装配参数。 */
interface BindingOptions {
  readonly subagents: SubagentRuntime
  /** 发起者；省略表示用 {@link PARENT}——binding 的入参是必填，缺席在类型层就不可表达。 */
  readonly parent?: Agent
  readonly signal?: AbortSignal
  /** 路由策略访问器；省略表示这个部署没有挂策略服务。 */
  readonly modelSelection?: () => SubagentModelSelection | undefined
  readonly warnings?: string[]
}

/**
 * 组装一份 `flow` 绑定。
 * @param options - 子 agent 执行缝、发起者、取消信号、路由策略与告警收集器。
 * @returns 注册进 PTC 绑定命名空间的那份函数表。
 */
function bindingsFor(options: BindingOptions): Record<string, PtcBindingFunction> {
  return createSubagentBindings({
    parent: options.parent ?? PARENT,
    provider: 'scripted',
    signal: options.signal ?? new AbortController().signal,
    subagents: options.subagents,
    modelSelection: options.modelSelection ?? (() => undefined),
    warn: (message: string) => { options.warnings?.push(message) },
  })
}

/**
 * 调一次 `dispatchsubagent`。
 * @param bindings - `flow` 命名空间。
 * @param prompt - 程序传进来的 prompt 参数值。
 * @param route - 程序传进来的可选路由字段；省略就是没给第二个参数。
 * @returns binding 的完成值。
 */
async function dispatch(
  bindings: Record<string, PtcBindingFunction>,
  prompt: unknown,
  route?: { provider?: unknown; model?: unknown },
): Promise<unknown> {
  const binding = bindings.dispatchsubagent
  assert.ok(binding !== undefined, 'the flow namespace must expose dispatchsubagent')
  return await binding({ prompt, ...route })
}

/**
 * 调一次 `dispatchsubagent` 并把抛出物拿回来，供逐字段断言用。
 * @param bindings - `flow` 命名空间。
 * @param prompt - 程序传进来的 prompt 参数值。
 * @param route - 程序传进来的可选路由字段。
 * @returns 抛出的错误。
 */
async function failureOf(
  bindings: Record<string, PtcBindingFunction>,
  prompt: unknown,
  route?: { provider?: unknown; model?: unknown },
): Promise<Error> {
  try {
    await dispatch(bindings, prompt, route)
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

// ---- 阶段 8：按调用指定子 agent 模型 ------------------------------------------

/**
 * 不填路由时**省略** `agentOptions`——不是 `undefined`，是键不在场。
 * 继承父 agent 的路由就是靠这一次省略（`child-agent.ts:99-120` 的合并语义），
 * 显式传一个 `undefined` 也会走到同一支，但"键在场"本身是可观察的差别，所以钉住它。
 */
test('不填路由时请求里没有 agentOptions 这一个键', async () => {
  const fake = scriptedSubagents(() => runOf({ output: [{ type: 'text', text: 'ok' }], stopReason: 'completed' }))
  await dispatch(bindingsFor({ subagents: fake.runtime, modelSelection: selectionOf([ROUTE]) }), 'p')
  const start = fake.starts[0]
  assert.ok(start !== undefined)
  assert.equal(start.hasAgentOptions, false, 'an omitted route must leave the key out of the request')
  assert.equal(start.agentOptions, undefined)
})

/** 命中的 route 逐字转发成 `agentOptions`，而 prompt / parent / signal 一个都不变。 */
test('合法 route 转发成 agentOptions，其余入参一字不变', async () => {
  const controller = new AbortController()
  const fake = scriptedSubagents(() => runOf({ output: [{ type: 'text', text: 'ok' }], stopReason: 'completed' }))
  const bindings = bindingsFor({
    subagents: fake.runtime,
    signal: controller.signal,
    modelSelection: selectionOf([ROUTE, { provider: 'other', model: 'other-model' }]),
  })
  await dispatch(bindings, 'p', { provider: ROUTE.provider, model: ROUTE.model })
  const start = fake.starts[0]
  assert.ok(start !== undefined)
  assert.deepEqual(start.agentOptions, { provider: ROUTE.provider, model: ROUTE.model })
  assert.equal(start.hasAgentOptions, true)
  assert.equal(start.provider, 'scripted', 'the subagent provider name is still the configured one')
  assert.equal(start.parent, PARENT)
  assert.equal(start.signal, controller.signal)
  assert.deepEqual(start.prompt, [{ type: 'text', text: 'p' }])
})

/**
 * 只给 `model` 抛，措辞逐字对齐发现工具（`list-models.ts:47` 的 `` `model` requires `provider` ``）：
 * 回落成"父 provider 下的 X 模型"会把失败推到一个程序看不见的地方。
 */
test('只给 model 抛，措辞与 list_subagent_models 一致', async () => {
  const fake = scriptedSubagents(() => runOf({ output: [{ type: 'text', text: 'ok' }], stopReason: 'completed' }))
  const failure = await failureOf(
    bindingsFor({ subagents: fake.runtime, modelSelection: selectionOf([ROUTE]) }),
    'p',
    { model: ROUTE.model },
  )
  assert.ok(
    failure.message.includes('`model` requires `provider`'),
    `the message must use the discovery tool's wording:\n${failure.message}`,
  )
  assert.equal(fake.starts.length, 0, 'a malformed route must not start a child')
})

/** 只给 `provider` 同待遇：两个都给，或者都不给（phase8-plan §10 Q2 的裁决）。 */
test('只给 provider 抛，且不产生 start', async () => {
  const fake = scriptedSubagents(() => runOf({ output: [{ type: 'text', text: 'ok' }], stopReason: 'completed' }))
  const failure = await failureOf(
    bindingsFor({ subagents: fake.runtime, modelSelection: selectionOf([ROUTE]) }),
    'p',
    { provider: ROUTE.provider },
  )
  assert.ok(
    failure.message.includes('`provider` requires `model`'),
    `the message must name the missing half:\n${failure.message}`,
  )
  assert.equal(fake.starts.length, 0)
})

/** 没命中的 route 抛，消息里**列出可用 route**——只被告知"不行"的模型改不动自己的调用。 */
test('route 不在清单里时抛，且消息列出可用 route', async () => {
  const fake = scriptedSubagents(() => runOf({ output: [{ type: 'text', text: 'ok' }], stopReason: 'completed' }))
  const failure = await failureOf(
    bindingsFor({ subagents: fake.runtime, modelSelection: selectionOf([ROUTE]) }),
    'p',
    { provider: 'nope', model: 'nope-model' },
  )
  assert.match(failure.message, /child LLM route "nope\/nope-model" is not allowed/)
  assert.match(failure.message, /available routes: route-provider\/route-model/)
  assert.equal(fake.starts.length, 0)
})

/**
 * 策略服务缺席、没开启、清单为空是同一件事——这个部署没有授权任何路由，一律拒绝显式指定
 * （phase8-plan §3.2、§10 Q1）。消息里的 `(none)` 就是这个事实。
 */
test('策略缺席 / 未开启 / 空清单都拒绝显式指定', async () => {
  const cases: Array<{ readonly label: string; readonly accessor: () => SubagentModelSelection | undefined }> = [
    { label: 'absent', accessor: () => undefined },
    { label: 'disabled', accessor: selectionOf([ROUTE], false) },
    { label: 'empty', accessor: selectionOf([]) },
  ]
  for (const { label, accessor } of cases) {
    const fake = scriptedSubagents(() => runOf({ output: [{ type: 'text', text: 'ok' }], stopReason: 'completed' }))
    const failure = await failureOf(
      bindingsFor({ subagents: fake.runtime, modelSelection: accessor }),
      'p',
      { provider: ROUTE.provider, model: ROUTE.model },
    )
    assert.match(failure.message, /available routes: \(none\)/, `${label}: the deployment authorized no route`)
    assert.equal(fake.starts.length, 0, `${label}: no child may start`)
  }
})

/** 策略是每次调用现读的访问器：run 期间的策略变化立刻生效（phase8-plan §9 R2 的差异）。 */
test('策略每次调用现读，改掉之后同一次 run 内的下一次派发按新策略判', async () => {
  const fake = scriptedSubagents(() => runOf({ output: [{ type: 'text', text: 'ok' }], stopReason: 'completed' }))
  let selection: SubagentModelSelection | undefined = { enabled: true, allowedModels: [ROUTE] }
  const bindings = bindingsFor({ subagents: fake.runtime, modelSelection: () => selection })
  await dispatch(bindings, 'p', { provider: ROUTE.provider, model: ROUTE.model })
  selection = { enabled: true, allowedModels: [] }
  const failure = await failureOf(bindings, 'p', { provider: ROUTE.provider, model: ROUTE.model })
  assert.match(failure.message, /available routes: \(none\)/)
  assert.equal(fake.starts.length, 1, 'only the call made while the route was allowed may start')
})

/** 可用清单有界：超出上界的部分折成省略号，消息不会随部署配置无限长（phase8-plan §9 R6）。 */
test('可用 route 列表有界，超出部分折成省略号', async () => {
  const many = Array.from({ length: 20 }, (_, index) => ({ provider: 'p', model: `m${String(index)}` }))
  const fake = scriptedSubagents(() => runOf({ output: [{ type: 'text', text: 'ok' }], stopReason: 'completed' }))
  const failure = await failureOf(
    bindingsFor({ subagents: fake.runtime, modelSelection: selectionOf(many) }),
    'p',
    { provider: 'nope', model: 'nope' },
  )
  assert.match(failure.message, /available routes: p\/m0, p\/m1, .*p\/m11, …/)
  assert.ok(!failure.message.includes('p/m12'), 'the list must stop at its bound')
})

/** 路由字段的坏值同样是解析边界：非字符串与空串分开报，措辞照发现工具的两条（`:56`、`:69`）。 */
test('路由字段非字符串或空串都拒绝，且不产生 start', async () => {
  const fake = scriptedSubagents(() => runOf({ output: [{ type: 'text', text: 'ok' }], stopReason: 'completed' }))
  const bindings = bindingsFor({ subagents: fake.runtime, modelSelection: selectionOf([ROUTE]) })
  assert.match((await failureOf(bindings, 'p', { provider: 42, model: 'm' })).message, /`provider` must be a string/)
  assert.match((await failureOf(bindings, 'p', { provider: 'p', model: 42 })).message, /`model` must be a string/)
  assert.match((await failureOf(bindings, 'p', { provider: '', model: 'm' })).message, /`provider` must be non-empty/)
  assert.match((await failureOf(bindings, 'p', { provider: 'p', model: '' })).message, /`model` must be non-empty/)
  assert.equal(fake.starts.length, 0)
})

/** 已经中止的 run：坏路由也不该改变化——取消检查先于参数分支，一次 start 都不产生。 */
test('信号已中止时给了路由仍然不调用 start', async () => {
  const fake = scriptedSubagents(() => runOf({ output: [{ type: 'text', text: 'ok' }], stopReason: 'completed' }))
  const controller = new AbortController()
  controller.abort(new Error('run cancelled'))
  await assert.rejects(
    () => dispatch(
      bindingsFor({ subagents: fake.runtime, signal: controller.signal, modelSelection: selectionOf([ROUTE]) }),
      'p',
      { provider: ROUTE.provider, model: ROUTE.model },
    ),
    /run cancelled/,
  )
  assert.equal(fake.starts.length, 0)
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
