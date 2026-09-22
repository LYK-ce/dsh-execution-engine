import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { JobHooks, JobId, JobStart } from '@deepseek-ai/dsh-jobs'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { RunProgramOutcome } from '../host/engine.ts'
import { createProgramJobs, programLabel } from '../host/job-runner.ts'
import type { ProgramExecute, ProgramRequest } from '../host/job-runner.ts'

/**
 * 用假 `ctx.jobs` 覆盖记账的三条契约（phase3-plan §8）：单例拒绝、`cancel` 同步且幂等、
 * 记账在 `done` 之后才清。
 *
 * 本文件是纯 Node 的 `pnpm run test` 直接加载的，所以跨包一律 `import type`：
 * `@deepseek-ai/dsh-jobs` 与 `@deepseek-ai/dsh-session` 在纯 Node 下没有解析路径。
 */

/** 一个只有 id 的发起者：job-runner 只用到 `Agent.id`（会话 id）与对象身份。 */
function agent(id: string): Agent {
  return { id: id as unknown as SessionId } as unknown as Agent
}

/** 一次被假注册表收下的提交。 */
interface FakeSubmit {
  readonly id: JobId
  readonly spec: JobStart
  readonly hooks: JobHooks
}

/**
 * 假的宿主：`ctx.jobs` 只需要 `start`，`ctx.effect` 用来模拟插件卸载。
 * @returns 假上下文、收下的提交，以及跑一遍 effect disposer 的 `unwatch`。
 */
function fakeHost() {
  const submissions: FakeSubmit[] = []
  const disposers: Array<() => void | Promise<void>> = []
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
    effect(callback: () => () => void | Promise<void>): () => void {
      const dispose = callback()
      disposers.push(dispose)
      return dispose as () => void
    },
  } as unknown as Context
  return {
    ctx,
    submissions,
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
  const pending: Array<(outcome: RunProgramOutcome) => void> = []
  const run: ProgramExecute = (runRequest) => {
    signals.push(runRequest.signal)
    return new Promise<RunProgramOutcome>((resolve) => { pending.push(resolve) })
  }
  return { run, signals, pending }
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
