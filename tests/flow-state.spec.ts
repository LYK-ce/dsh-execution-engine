// 本目录不自足：`@deepseek-ai/*` 的声明靠父仓库 tsconfig 的 paths，运行时不解析它们
// （`host/flow-state.ts` 跨包一律 `import type`），所以纯 Node 就能跑这个 spec。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { JobId } from '@deepseek-ai/dsh-jobs'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { FlowState, MAX_CALLS, MAX_REPORTS } from '../host/flow-state.ts'
import type { FlowCallEndEvent, FlowCallStartEvent, FlowStartEvent } from '../host/flow-events.ts'
import type { FlowCallEntry, FlowEntry, FlowReportEntry } from '../shared/protocol.ts'

/** 本 spec 用的那个会话。 */
const SESSION = 'session-1' as SessionId

/** 程序正文用一段两行的源码，好让 `lineCount` 有可断言的值。 */
const CODE = "await report('a')\nreturn 1"

/** 收窄一个裸字符串成 job id；线格式上是裸 string（`shared/protocol.ts` 的模块头）。 */
function run(id: string): JobId {
  return id as JobId
}

/**
 * 造一条 `flow/start`。
 * @param id - run 身份。
 * @param code - 程序正文；缺省用 {@link CODE}。
 * @returns 事件 payload。
 */
function startEvent(id: string, code: string = CODE): FlowStartEvent {
  return { runId: run(id), label: "await report('a')", ownerSession: SESSION, code }
}

/**
 * 造一条 `flow/call-start`。
 * @param id - run 身份。
 * @param callId - 调用序号。
 * @param line - 调用点行号。
 * @returns 事件 payload。
 */
function callStartEvent(id: string, callId: number, line: number | null = 1): FlowCallStartEvent {
  return { runId: run(id), callId, member: 'process', line, args: '[["python"]]', argsTruncated: false }
}

/**
 * 造一条 `flow/call-end`。
 * @param id - run 身份。
 * @param callId - 调用序号。
 * @param extra - 覆盖缺省的结局字段。
 * @returns 事件 payload。
 */
function callEndEvent(id: string, callId: number, extra: Partial<FlowCallEndEvent> = {}): FlowCallEndEvent {
  return { runId: run(id), callId, member: 'process', line: 1, ms: 7, outcome: 'ok', ...extra }
}

/**
 * 只取调用条目。
 * @param entries - 一份轨迹。
 * @returns 调用条目，按原顺序。
 */
function callsOf(entries: readonly FlowEntry[]): FlowCallEntry[] {
  return entries.filter((entry): entry is FlowCallEntry => entry.kind === 'call')
}

/**
 * 只取 report 条目。
 * @param entries - 一份轨迹。
 * @returns report 条目，按原顺序。
 */
function reportsOf(entries: readonly FlowEntry[]): FlowReportEntry[] {
  return entries.filter((entry): entry is FlowReportEntry => entry.kind === 'report')
}

test('一串事件折成状态：头部、轨迹顺序与终态', () => {
  const state = new FlowState()
  state.start(startEvent('run-1'))
  state.callStart(callStartEvent('run-1', 0, 3))
  state.report({ runId: run('run-1'), text: 'hello' })
  state.callEnd(callEndEvent('run-1', 0, { line: 3, result: '"ok"' }))

  const full = state.read(SESSION, 0)
  assert.equal(full.reset, false, 'a first read with since=0 has nothing to fall back from')
  assert.equal(full.revision, 2)
  assert.deepEqual(full.entries, [
    { kind: 'call', seq: 0, callId: 0, member: 'process', line: 3, state: 'ok', ms: 7, preview: '"ok"' },
    { kind: 'report', seq: 1, text: 'hello' },
  ])
  const header = full.run
  assert.ok(header !== null)
  assert.equal(header.runId, 'run-1')
  assert.equal(header.label, "await report('a')")
  assert.equal(header.code, CODE)
  assert.equal(header.lineCount, 2)
  assert.equal(header.status, 'running')
  assert.equal(header.discarded, 0)
  assert.equal(header.endedAt, undefined, 'a running run must not report an end time')

  state.end({ runId: run('run-1'), status: 'killed', discarded: 2, detail: 'cancelled by the initiating agent' })
  const settled = state.read(SESSION, 2)
  assert.deepEqual(settled.entries, [], 'since === revision must return no entries')
  assert.equal(settled.run?.status, 'killed')
  assert.equal(settled.run?.discarded, 2)
  assert.equal(settled.run?.detail, 'cancelled by the initiating agent')
  assert.ok(
    (settled.run?.endedAt ?? 0) >= (settled.run?.startedAt ?? Number.POSITIVE_INFINITY),
    'the end must not precede the start',
  )
})

test('没有 start 的事件被丢掉，没有配对的 call-end 也被丢掉', () => {
  const state = new FlowState()
  state.callStart(callStartEvent('ghost', 0))
  state.report({ runId: run('ghost'), text: 'nobody hears this' })
  state.end({ runId: run('ghost'), status: 'completed', discarded: 0 })
  assert.deepEqual(state.read(SESSION, 0), { run: null, revision: 0, entries: [], reset: true })

  state.start(startEvent('run-1'))
  // 没有 start 的 end：凭空补一条已经结束的调用会把没发生过的调用画到轨迹上。
  state.callEnd(callEndEvent('run-1', 9, { outcome: 'error', error: 'boom' }))
  assert.deepEqual(state.read(SESSION, 0).entries, [])
})

test('synthetic 与失败路径逐字透传，拿不到行号时原样带 null', () => {
  const state = new FlowState()
  state.start(startEvent('run-1'))
  state.callStart(callStartEvent('run-1', 0, null))
  state.callEnd(callEndEvent('run-1', 0, {
    line: null,
    outcome: 'error',
    ms: 1234,
    error: 'the program ended before this call settled (killed)',
    errorTruncated: false,
    synthetic: true,
  }))
  assert.deepEqual(state.read(SESSION, 0).entries, [
    {
      kind: 'call',
      seq: 0,
      callId: 0,
      member: 'process',
      line: null,
      state: 'error',
      ms: 1234,
      preview: 'the program ended before this call settled (killed)',
      synthetic: true,
    },
  ])
})

test('since 的四个边界：最新、增量、比最新还大、刚换过 run', () => {
  const state = new FlowState()
  state.start(startEvent('run-1'))
  state.report({ runId: run('run-1'), text: 'one' })
  state.report({ runId: run('run-1'), text: 'two' })
  state.report({ runId: run('run-1'), text: 'three' })

  const none = state.read(SESSION, 3)
  assert.equal(none.reset, false)
  assert.deepEqual(none.entries, [])

  const delta = state.read(SESSION, 1)
  assert.equal(delta.reset, false)
  assert.deepEqual(delta.entries.map(entry => entry.seq), [1, 2])

  // 比最新还大：客户端拿着另一次 run / 另一个宿主的游标，只回退不成错。
  const ahead = state.read(SESSION, 4)
  assert.equal(ahead.reset, true)
  assert.deepEqual(ahead.entries.map(entry => entry.seq), [0, 1, 2])

  // 刚换过 run、还没有条目：上一次 run 的游标同样接不上，回一份空的。
  state.start(startEvent('run-2'))
  const fresh = state.read(SESSION, 3)
  assert.equal(fresh.run?.runId, 'run-2')
  assert.equal(fresh.revision, 0)
  assert.equal(fresh.reset, true)
  assert.deepEqual(fresh.entries, [])
})

test('有界：调用与 report 各自裁到上限，丢的是最旧的', () => {
  const state = new FlowState()
  state.start(startEvent('run-1'))
  for (let index = 0; index < MAX_CALLS + 5; index += 1) {
    state.callStart(callStartEvent('run-1', index, index))
    state.callEnd(callEndEvent('run-1', index, { line: index, result: String(index) }))
  }
  for (let index = 0; index < MAX_REPORTS + 3; index += 1) {
    state.report({ runId: run('run-1'), text: `r${String(index)}` })
  }

  const full = state.read(SESSION, 0)
  const calls = callsOf(full.entries)
  const reports = reportsOf(full.entries)
  assert.equal(calls.length, MAX_CALLS)
  assert.equal(reports.length, MAX_REPORTS)
  // 两类各自的上限，而不是"总数被裁到某个上限"。
  assert.equal(full.revision, MAX_CALLS + 5 + MAX_REPORTS + 3)
  assert.equal(full.entries.length, MAX_CALLS + MAX_REPORTS)
  // 两条流各自从最旧的开始丢，所以剩下的都是连续后缀。
  assert.equal(calls[0]?.callId, 5)
  assert.equal(calls[calls.length - 1]?.callId, MAX_CALLS + 4)
  assert.equal(reports[0]?.text, 'r3')
  // 条目按发生顺序（`seq` 升序）排——增量拼接的前提。
  const seqs = full.entries.map(entry => entry.seq)
  assert.deepEqual(seqs, [...seqs].sort((left, right) => left - right))
  // 被挤掉之后的 `since` 接不上：整份重来，而不是回一段有洞的增量。
  const late = state.read(SESSION, 3)
  assert.equal(late.reset, true)
  assert.deepEqual(late.entries, full.entries)
})

test('有界挤掉了 start 时，那条迟到的 end 也不会补进来', () => {
  const state = new FlowState()
  state.start(startEvent('run-1'))
  state.callStart(callStartEvent('run-1', 0, 1))
  for (let index = 1; index <= MAX_CALLS; index += 1) state.callStart(callStartEvent('run-1', index, index))
  const open = callsOf(state.read(SESSION, 0).entries)
  assert.equal(open.length, MAX_CALLS)
  assert.equal(open[0]?.callId, 1, 'the first call is the one that got evicted')

  state.callEnd(callEndEvent('run-1', 0, { result: 'late' }))
  assert.equal(
    callsOf(state.read(SESSION, 0).entries).length,
    MAX_CALLS,
    'a late end must not mint a call that is no longer in the trace',
  )
})

test('换一次 run 就换掉整份记录，上一次 run 的事件不再改动它', () => {
  const state = new FlowState()
  state.start(startEvent('run-1'))
  state.report({ runId: run('run-1'), text: 'first' })
  state.start(startEvent('run-2', ''))
  state.report({ runId: run('run-1'), text: 'late from the old run' })

  const current = state.read(SESSION, 0)
  assert.equal(current.run?.runId, 'run-2')
  assert.equal(current.run?.lineCount, 0, 'an empty program has no lines')
  assert.deepEqual(current.entries, [])
})

test('两个会话各记各的', () => {
  const other = 'session-2' as SessionId
  const state = new FlowState()
  state.start({ runId: run('run-1'), label: 'a', ownerSession: SESSION, code: 'a' })
  state.start({ runId: run('run-2'), label: 'b', ownerSession: other, code: 'b' })
  state.report({ runId: run('run-2'), text: 'for the other session' })

  assert.equal(state.read(SESSION, 0).run?.runId, 'run-1')
  assert.deepEqual(state.read(SESSION, 0).entries, [])
  assert.deepEqual(reportsOf(state.read(other, 0).entries).map(entry => entry.text), ['for the other session'])
})
