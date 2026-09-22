// 本目录不自足：`@deepseek-ai/*` 的声明靠父仓库 tsconfig 的 paths，运行时不解析它们
// （`host/routes.ts` 跨包一律 `import type`），所以纯 Node 就能跑这个 spec。
//
// 这两条路由此前只有 B 档（`loader-driver.ts` 的 B14a/B14b）覆盖：那里的价值是"真的挂在
// `ctx.connection.fetch` 上"，代价是每一轮回归都要 tsx 与一份真装配。这一份补的是**处理函数
// 自己的判据**——查询参数的 400 分支、`since` 的省略、取消结果到线格式的折叠——它们在纯 Node 下
// 就能钉住，不需要任何服务。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { JobId } from '@deepseek-ai/dsh-jobs'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { FlowCallEndEvent, FlowCallStartEvent, FlowStartEvent } from '../host/flow-events.ts'
import { FlowState } from '../host/flow-state.ts'
import type { ProgramCancel } from '../host/job-runner.ts'
import { handleCancel, handleState } from '../host/routes.ts'
import type { CancelProgram } from '../host/routes.ts'
import { CANCEL_PATH, STATE_PATH } from '../shared/protocol.ts'

/** 本 spec 用的那个会话。 */
const SESSION = 'session-1' as SessionId

/** 收窄一个裸字符串成 job id；线格式上是裸 string（`shared/protocol.ts` 的模块头）。 */
function run(id: string): JobId {
  return id as JobId
}

/** 造一条 `flow/start`。 */
function startEvent(id: string): FlowStartEvent {
  return { runId: run(id), label: "await report('a')", ownerSession: SESSION, code: "await report('a')" }
}

/**
 * 一个已经跑过一次 run 的累加器：一条闭合的调用 + 一条 report，`revision` 是 2。
 * @returns 累加器。
 */
function stateWithRun(): FlowState {
  const state = new FlowState()
  const start: FlowCallStartEvent = {
    runId: run('run-1'),
    callId: 0,
    member: 'process',
    line: 1,
    args: '[["python"]]',
    argsTruncated: false,
  }
  const end: FlowCallEndEvent = { runId: run('run-1'), callId: 0, member: 'process', line: 1, ms: 5, outcome: 'ok', result: '0' }
  state.start(startEvent('run-1'))
  state.callStart(start)
  state.report({ runId: run('run-1'), text: 'hello' })
  state.callEnd(end)
  return state
}

/**
 * 发一条 state 读取请求。
 * @param query - `?` 之后的查询串（含 `?`）。
 * @returns 处理函数收到的请求。
 */
function stateRequest(query: string): Request {
  return new Request(`http://dsh.invalid${STATE_PATH}${query}`)
}

/**
 * 发一条取消请求。
 * @param query - `?` 之后的查询串（含 `?`）。
 * @returns 处理函数收到的请求。
 */
function cancelRequest(query: string): Request {
  return new Request(`http://dsh.invalid${CANCEL_PATH}${query}`, { method: 'POST' })
}

/**
 * 造一个记录调用的取消入口。
 * @param result - 它每次都回的结果。
 * @returns 入口本身与它收到的会话 id 列表。
 */
function recordingCancel(result: ProgramCancel): { cancel: CancelProgram; sessions: SessionId[] } {
  const sessions: SessionId[] = []
  return {
    sessions,
    cancel: async (sessionId) => {
      sessions.push(sessionId)
      return result
    },
  }
}

/** 一次全新的读取回的是一份空的、`reset` 的状态；这条是下面几条的对照面。 */
test('没有跑过程序的会话读回一份空状态', async () => {
  const response = await handleState(new FlowState(), stateRequest(`?sessionId=${SESSION}`))
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { run: null, revision: 0, entries: [], reset: true })
})

/** 状态里的头部、轨迹与游标逐字来自累加器，路由只做编码。 */
test('state 把累加器的状态原样编成 JSON', async () => {
  const state = stateWithRun()
  const response = await handleState(state, stateRequest(`?sessionId=${SESSION}&since=0`))
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type') ?? '', /^application\/json/)
  assert.deepEqual(await response.json(), state.read(SESSION, 0))
})

/** `since` 省略等于"我什么都没有"，不是 400。 */
test('since 省略按 0 处理，给了就按它取增量', async () => {
  const state = stateWithRun()
  const full = await handleState(state, stateRequest(`?sessionId=${SESSION}`))
  const body = await full.json()
  assert.deepEqual(body, state.read(SESSION, 0))
  assert.equal((body as { reset: boolean }).reset, false, 'since=0 是第一条，不是回退')

  const delta = await handleState(state, stateRequest(`?sessionId=${SESSION}&since=1`))
  const increment = await delta.json() as { entries: { seq: number }[]; revision: number }
  assert.deepEqual(increment.entries.map(entry => entry.seq), [1])
  assert.equal(increment.revision, 2)
})

/** 不合法即 400，且不带任何状态出去。 */
test('state 的查询参数不合法时 400', async () => {
  const state = stateWithRun()
  const invalid = [
    '', // 连 sessionId 都没有
    '?sessionId=', // 空 sessionId
    `?sessionId=${SESSION}&since=-1`,
    `?sessionId=${SESSION}&since=1.5`,
    `?sessionId=${SESSION}&since=abc`,
    `?sessionId=${SESSION}&since=Infinity`,
  ]
  for (const query of invalid) {
    const response = await handleState(state, stateRequest(query))
    assert.equal(response.status, 400, `?${query.replace(/^\?/u, '')} must be a 400`)
    assert.equal(await response.text(), 'Invalid execution-engine state query.')
  }
})

/** `cancel_program` 的结果折成线格式：取消掉的那次带全四个字段。 */
test('cancel 把取消结果折成线格式', async () => {
  const { cancel, sessions } = recordingCancel({
    cancelled: true,
    jobId: run('execution-engine-7'),
    status: 'killed',
    detail: 'cancelled by the initiating agent',
  })
  const response = await handleCancel(cancel, cancelRequest(`?sessionId=${SESSION}`))
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), {
    cancelled: true,
    jobId: 'execution-engine-7',
    status: 'killed',
    detail: 'cancelled by the initiating agent',
  })
  // URL 里的 sessionId 是它离开 wire 之后唯一一次收窄，必须逐字交给取消入口。
  assert.deepEqual(sessions, [SESSION])
})

/**
 * 没有程序在跑时四个可选字段全部缺席——`exactOptionalPropertyTypes` 下"不给"与"给 undefined"
 * 是两件事，而这条也是 §4.4 幂等语义在 wire 上的形态。
 */
test('cancel 结果里没有的可选字段不带这个键', async () => {
  const { cancel } = recordingCancel({ cancelled: false })
  const response = await handleCancel(cancel, cancelRequest(`?sessionId=${SESSION}`))
  assert.deepEqual(await response.json(), { cancelled: false })
})

/** 400 在**调用取消入口之前**发生：不给会话 id 不该去碰任何人的槽位。 */
test('cancel 的 sessionId 不合法时 400，且不调用取消入口', async () => {
  const { cancel, sessions } = recordingCancel({ cancelled: false })
  for (const query of ['', '?sessionId=']) {
    const response = await handleCancel(cancel, cancelRequest(query))
    assert.equal(response.status, 400)
    assert.equal(await response.text(), 'Invalid execution-engine session id.')
  }
  assert.deepEqual(sessions, [], 'a malformed request must not reach the cancel entry')
})
