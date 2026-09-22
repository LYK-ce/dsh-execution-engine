import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { JobHooks, JobId, JobStart } from '@deepseek-ai/dsh-jobs'
import type { MessageId } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { RunProgramOutcome, RunProgramRequest } from '../host/engine.ts'
import { createProgramJobs, programLabel } from '../host/job-runner.ts'
import type { ProgramExecute, ProgramRequest } from '../host/job-runner.ts'

/**
 * 用假 `ctx.jobs` 覆盖记账的四条契约（phase3-plan §8、phase4-plan §3–§4）：单例拒绝、`cancel`
 * 同步且幂等、记账在 `done` 之后才清、取消路径作废未投递的 report 并发出 `flow/*`。
 *
 * 本文件是纯 Node 的 `pnpm run test` 直接加载的，所以跨包一律 `import type`：
 * `@deepseek-ai/dsh-jobs` 与 `@deepseek-ai/dsh-session` 在纯 Node 下没有解析路径。
 */

/** 一个只有 id 的发起者：job-runner 只用到 `Agent.id`（会话 id）与对象身份。 */
function agent(id: string): Agent {
  return { id: id as unknown as SessionId } as unknown as Agent
}

/** 一个带收件箱的发起者：`report` 记账的作废只用到 `Inbox.remove`。 */
function inboxOwner(id: string): { owner: Agent; pending: string[] } {
  const pending: string[] = []
  const owner = {
    id: id as unknown as SessionId,
    inbox: {
      remove(messageId: MessageId): boolean {
        const index = pending.indexOf(String(messageId))
        if (index < 0) return false
        pending.splice(index, 1)
        return true
      },
    },
  } as unknown as Agent
  return { owner, pending }
}

/** 一次被假注册表收下的提交。 */
interface FakeSubmit {
  readonly id: JobId
  readonly spec: JobStart
  readonly hooks: JobHooks
}

/** 一次被假宿主收下的 `flow/*` 发射。 */
interface FakeEvent {
  readonly name: string
  readonly args: readonly unknown[]
}

/**
 * 假的宿主：`ctx.jobs` 只需要 `start`，`ctx.emit` 收 `flow/*`，`ctx.effect` 模拟插件卸载。
 * @param throwOn - 让这个事件名的发射抛一次，用来验证监听者的异常被收住。
 * @returns 假上下文、收下的提交与事件、告警，以及跑一遍 effect disposer 的 `unwatch`。
 */
function fakeHost(throwOn?: string) {
  const submissions: FakeSubmit[] = []
  const disposers: Array<() => void | Promise<void>> = []
  const events: FakeEvent[] = []
  const warnings: string[] = []
  const ctx = {
    jobs: {
      start(spec: JobStart): JobId {
        // 注册表契约：`start` 同步调用 `run()` 恰好一次，把返回值当作 hooks。
        const hooks = spec.run()
        const id = `${spec.kind}-${String(submissions.length + 1)}` as unknown as JobId
        submissions.push({ id, spec, hooks })
        return id
      },
    },
    emit(name: string, ...args: unknown[]): void {
      events.push({ name, args })
      if (name === throwOn) throw new Error(`listener for ${name} threw`)
    },
    logger: {
      warn(message: string): void {
        warnings.push(message)
      },
    },
    effect(callback: () => () => void | Promise<void>): () => void {
      const dispose = callback()
      disposers.push(dispose)
      return dispose as () => void
    },
  } as unknown as Context
  return {
    ctx,
    submissions,
    events,
    warnings,
    /** 模拟插件卸载：跑一遍登记在上下文上的 effect disposer，并等它们收尾。 */
    async unwatch(): Promise<void> {
      for (const dispose of disposers.splice(0)) await dispose()
    },
  }
}

/** 一次 run 的请求；权威（cwd）在单测里无关紧要，只要在场。 */
function request(owner: Agent, code: string): ProgramRequest {
  return { code, cwd: process.cwd(), parent: owner }
}

/** 让已排队的微任务跑完。 */
function tick(): Promise<void> {
  return new Promise<void>((resolve) => { setTimeout(resolve, 0) })
}

/**
 * 受控的执行入口：每次调用留一个未结算的 promise，由用例决定它怎么收场。
 *
 * abort 时**不自动结算**——`runProgram` 在取消后还要跑 `finally`（删临时目录、等在飞外部执行
 * 静默），本模块的契约是"等 `done`"，所以结算时机由用例显式控制。
 */
function controllableRun() {
  const signals: AbortSignal[] = []
  const requests: RunProgramRequest[] = []
  const pending: Array<(outcome: RunProgramOutcome) => void> = []
  const run: ProgramExecute = (runRequest) => {
    signals.push(runRequest.signal)
    requests.push(runRequest)
    return new Promise<RunProgramOutcome>((resolve) => { pending.push(resolve) })
  }
  return { run, signals, requests, pending }
}

test('start 同步返回 job id，不等程序跑完', () => {
  const host = fakeHost()
  const control = controllableRun()
  const programs = createProgramJobs(host.ctx, control.run)
  const owner = agent('owner-a')

  const id = programs.start(request(owner, 'return 1'))

  assert.equal(String(id), 'execution-engine-1')
  assert.equal(host.submissions.length, 1, 'submitting must reach the registry exactly once')
  const submission = host.submissions[0]
  assert.ok(submission !== undefined)
  assert.equal(submission.spec.kind, 'execution-engine')
  assert.equal(submission.spec.owner, owner, 'the owner is the initiating agent itself')
  assert.equal(submission.spec.label, 'return 1')
  // 程序已经跑起来了，但还没有结算——提交本身没有 await 它。
  assert.equal(control.pending.length, 1, 'the program must already be running')
})

test('label 是程序首行截出的短摘要', () => {
  assert.equal(programLabel('\n\nconst a = 1\nconst b = 2'), 'const a = 1')
  assert.equal(programLabel('const a  =\t1'), 'const a = 1')
  // 注册表拒绝空标签，所以整段都是空白的程序回落到工具名。
  assert.equal(programLabel('   '), 'run_program')
  assert.equal(programLabel('\t\n  \n'), 'run_program')
  const label = programLabel(`const value = ${'x'.repeat(200)}`)
  assert.equal(label.length, 80, 'the label must be capped')
  assert.ok(label.endsWith('…'), 'a truncated label must say so')
})

test('同一个 owner 已有未结算的程序时拒绝，错误里带上当前 job id', () => {
  const host = fakeHost()
  const control = controllableRun()
  const programs = createProgramJobs(host.ctx, control.run)
  const owner = agent('owner-a')

  const first = programs.start(request(owner, 'return 1'))
  assert.throws(
    () => programs.start(request(owner, 'return 2')),
    (error: Error) => error.message.includes(String(first)) && error.message.includes('已经有一个程序在跑'),
    'a refused start must name the job that is already running',
  )
  assert.equal(host.submissions.length, 1, 'a refused start must not reach the registry')
  // 单例的范围是每个发起 agent 一个，不是全局一个（design.md §4.2）。
  assert.doesNotThrow(() => programs.start(request(agent('owner-b'), 'return 3')))
})

test('取消等 done 结算，返回前仍然占着槽位', async () => {
  const host = fakeHost()
  const control = controllableRun()
  const programs = createProgramJobs(host.ctx, control.run)
  const owner = agent('owner-a')

  const id = programs.start(request(owner, 'return 1'))
  const cancelled = programs.cancel(owner)
  let returned = false
  void cancelled.then(() => { returned = true })
  await tick()
  assert.equal(returned, false, 'cancel must not return before the producer releases its resources')
  assert.throws(
    () => programs.start(request(owner, 'return 2')),
    /已经有一个程序在跑/,
    'the slot must stay taken until done settles, not until cancel is requested',
  )

  // 执行入口按"取消后的收场"结算：abort 已发生，所以终态是 killed，detail 记的是取消原因，
  // 而不是程序在那一刻自己报的 abort 失败（那只是取消的影子）。
  control.pending[0]?.({ output: '程序执行失败（abort）：cancelled', status: 'failed', detail: 'abort: cancelled' })
  const result = await cancelled

  assert.equal(result.cancelled, true)
  assert.equal(String(result.jobId), String(id))
  assert.equal(result.status, 'killed')
  assert.equal(result.detail, 'cancelled by the initiating agent')
  // done 结算之后槽位才放开，所以取消返回后可以立刻启动新的。
  assert.doesNotThrow(() => programs.start(request(owner, 'return 2')))
})

test('执行入口拒绝时收成 failed，并且照样清掉记账（R7）', async () => {
  const host = fakeHost()
  const programs = createProgramJobs(host.ctx, () => Promise.reject(new Error('boom')))
  const owner = agent('owner-a')

  programs.start(request(owner, 'return 1'))
  const submission = host.submissions[0]
  assert.ok(submission !== undefined)
  const outcome = await submission.hooks.done

  assert.equal(outcome.status, 'failed')
  assert.match(String(outcome.detail), /boom/)
  assert.doesNotThrow(
    () => programs.start(request(owner, 'return 2')),
    'a rejected run must not leak the slot',
  )
})

test('cancel 同步且幂等；没有程序在跑时 cancelled:false', async () => {
  const host = fakeHost()
  const control = controllableRun()
  const programs = createProgramJobs(host.ctx, control.run)
  const owner = agent('owner-a')

  assert.deepEqual(await programs.cancel(owner), { cancelled: false })
  assert.deepEqual(await programs.cancel(agent('owner-b')), { cancelled: false })

  const id = programs.start(request(owner, 'return 1'))
  const firstCancel = programs.cancel(owner)
  const secondCancel = programs.cancel(owner)
  control.pending[0]?.({ output: '程序执行失败（abort）：cancelled', status: 'failed' })
  const [first, second] = await Promise.all([firstCancel, secondCancel])

  assert.equal(first.cancelled, true)
  assert.equal(second.cancelled, true, 'a second cancel of the same live program is harmless')
  assert.equal(String(first.jobId), String(id))
  // 已经结算之后再取消：明确的"当前没有正在运行的程序"，不是错误（design.md §4.4）。
  assert.deepEqual(await programs.cancel(owner), { cancelled: false })
})

test('取消打到本次提交自己的信号上，与调用方的信号无关', async () => {
  const host = fakeHost()
  const control = controllableRun()
  const programs = createProgramJobs(host.ctx, control.run)
  const owner = agent('owner-a')

  programs.start(request(owner, 'return 1'))
  const signal = control.signals[0]
  assert.ok(signal !== undefined)
  assert.equal(signal.aborted, false)
  const cancelled = programs.cancel(owner)
  assert.equal(signal.aborted, true, 'cancel must abort the signal this submission handed to the program')
  control.pending[0]?.({ output: 'cancelled', status: 'failed' })
  await cancelled
})

test('插件 dispose 先取消在跑的程序、等它结算，再清记账', async () => {
  const host = fakeHost()
  const control = controllableRun()
  const programs = createProgramJobs(host.ctx, control.run)
  const owner = agent('owner-a')

  programs.start(request(owner, 'return 1'))
  assert.throws(() => programs.start(request(owner, 'return 2')), /已经有一个程序在跑/)

  const signal = control.signals[0]
  assert.ok(signal !== undefined)
  assert.equal(signal.aborted, false, '提交之后、卸载之前不该被中止')

  const unwatched = host.unwatch()
  assert.equal(
    signal.aborted,
    true,
    '插件卸载必须取消在跑的程序——design.md §4.4 把"插件 unload"列为取消入口',
  )
  // 清理尚未完成：记账必须仍然占着槽位，否则另一个 controller 服务的同一 owner
  // 会被放行，单例当场失效。
  assert.throws(
    () => programs.start(request(owner, 'return 2')),
    /已经有一个程序在跑/,
    '结算之前记账不能被释放',
  )

  control.pending[0]?.({ output: 'done', status: 'completed' })
  await unwatched

  assert.doesNotThrow(
    () => programs.start(request(owner, 'return 2')),
    '结算之后记账必须被释放',
  )
})

/** 往一次 run 的记账里放两条 report，并把它们摆成"还挂在发起者队列里"。 */
function deliverReports(control: ReturnType<typeof controllableRun>, owner: { pending: string[] }): void {
  const reports = control.requests[0]?.reports
  assert.ok(reports !== undefined, 'the producer must hand the run its report ledger')
  for (const [index, text] of ['one', 'two'].entries()) {
    const messageId = `report-${String(index)}` as unknown as MessageId
    owner.pending.push(messageId)
    reports.record(messageId, text)
  }
}

test('取消结算时作废仍未投递的 report', async () => {
  const host = fakeHost()
  const control = controllableRun()
  const programs = createProgramJobs(host.ctx, control.run)
  const owner = inboxOwner('owner-a')

  programs.start(request(owner.owner, 'return 1'))
  deliverReports(control, owner)
  assert.equal(owner.pending.length, 2)

  const cancelled = programs.cancel(owner.owner)
  control.pending[0]?.({ output: '程序执行失败（abort）：cancelled', status: 'failed' })
  await cancelled

  // design.md §4.4：程序死了，它没来得及说的话就别说了。取消返回的那一刻队列里就该空了。
  assert.deepEqual(owner.pending, [], '取消返回之后，仍未投递的 report 必须已经被摘掉')
  // 摘掉的条数随 `flow/end` 发出去：观察面靠它把"报出去了"和"真的被读到了"对齐。
  const submission = host.submissions[0]
  assert.ok(submission !== undefined)
  await submission.hooks.done
  assert.deepEqual(host.events.filter(event => event.name === 'flow/end').map(event => event.args[0]), [
    { runId: submission.id, status: 'killed', discarded: 2, detail: 'cancelled by the initiating agent' },
  ])
})

test('作废本身抛（收件箱投影已注销）时收住：flow/end 照发，只记一条警告', async () => {
  const host = fakeHost()
  const control = controllableRun()
  const programs = createProgramJobs(host.ctx, control.run)
  // owner 已被 dispose 的那一侧：收件箱投影随会话注销，`Inbox.remove` 不是返回 `false` 而是**抛**
  // （packages/core/agent-loop/src/inbox.ts:189-197 的 `current()` 显式 throw）。取消入口之一就是
  // owner disposal（design.md §4.4），所以这条路径真实存在。
  const owner = {
    id: 'owner-a' as unknown as SessionId,
    inbox: {
      remove(): boolean {
        throw new Error('agent "owner-a" cannot read inbox state: its projection registration is not active')
      },
    },
  } as unknown as Agent

  programs.start(request(owner, 'return 1'))
  const reports = control.requests[0]?.reports
  assert.ok(reports !== undefined, 'the producer must hand the run its report ledger')
  reports.record('report-0' as unknown as MessageId, 'one')

  const cancelled = programs.cancel(owner)
  control.pending[0]?.({ output: 'cancelled', status: 'failed' })
  await cancelled
  const submission = host.submissions[0]
  assert.ok(submission !== undefined)
  // 结算回调是没有接收者的 `.then` 链：它抛出去就是一个 unhandled rejection，而且跳掉 `flow/end`。
  await submission.hooks.done
  await tick()

  assert.equal(host.warnings.length, 1, '摘失败必须只记一条警告')
  assert.match(host.warnings[0] ?? '', /discarding undelivered reports failed/)
  assert.match(host.warnings[0] ?? '', /projection registration is not active/)
  // start↔end 成对：摘失败不影响这一对里的后半截。
  assert.deepEqual(host.events.filter(event => event.name === 'flow/end').map(event => event.args[0]), [
    { runId: submission.id, status: 'killed', discarded: 0, detail: 'cancelled by the initiating agent' },
  ])
})

test('正常结算不作废仍未投递的 report', async () => {
  const host = fakeHost()
  const control = controllableRun()
  const programs = createProgramJobs(host.ctx, control.run)
  const owner = inboxOwner('owner-a')

  programs.start(request(owner.owner, 'return 1'))
  deliverReports(control, owner)

  control.pending[0]?.({ output: 'done', status: 'completed' })
  const submission = host.submissions[0]
  assert.ok(submission !== undefined)
  await submission.hooks.done

  // `followup` 只是把消息放进 `next-turn` 挂起队列（phase4-plan §10 Q1）：跑完不是取消，
  // 一条还没被读到的正常汇报不作废。
  assert.deepEqual(owner.pending, ['report-0', 'report-1'])
})

test('flow/* 事件：启动、report、结束都以 run 身份关联', async () => {
  const host = fakeHost()
  const control = controllableRun()
  const programs = createProgramJobs(host.ctx, control.run)
  const owner = inboxOwner('owner-a')

  const id = programs.start(request(owner.owner, 'return 1'))
  assert.deepEqual(host.events.map(event => event.name), ['flow/start'])
  assert.deepEqual(host.events[0]?.args, [{ runId: id, label: 'return 1', ownerSession: 'owner-a' }])

  deliverReports(control, owner)
  assert.deepEqual(
    host.events.filter(event => event.name === 'flow/report').map(event => event.args[0]),
    [{ runId: id, text: 'one' }, { runId: id, text: 'two' }],
  )

  control.pending[0]?.({ output: 'done', status: 'completed', detail: 'exit code: 3' })
  const submission = host.submissions[0]
  assert.ok(submission !== undefined)
  await submission.hooks.done

  assert.deepEqual(host.events.filter(event => event.name === 'flow/end').map(event => event.args[0]), [
    // 没被取消，所以一条也没作废——`discarded` 在非取消路径上是 `0`。
    { runId: id, status: 'completed', discarded: 0, detail: 'exit code: 3' },
  ])
})

test('flow/* 是 observe-only：监听者抛异常只记一条警告，不影响 job', async () => {
  const host = fakeHost('flow/start')
  const control = controllableRun()
  const programs = createProgramJobs(host.ctx, control.run)
  const owner = agent('owner-a')

  // 启动路径上抛出去会把一次成功的提交报成失败，所以它必须被收住。
  const id = programs.start(request(owner, 'return 1'))
  assert.equal(String(id), 'execution-engine-1')
  assert.equal(host.warnings.length, 1)
  assert.match(host.warnings[0] ?? '', /flow\/\* listener threw/)
  assert.match(host.warnings[0] ?? '', /listener for flow\/start threw/)
})
