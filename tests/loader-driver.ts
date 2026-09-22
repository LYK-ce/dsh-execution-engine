#!/usr/bin/env node
/**
 * 阶段 1/2/3 的真实组合验证：用 app-boot 的 boot() 起一份最小 Loader 组合，断言插件与工具已注册、
 * 模型可见 schema 存在、`.d.ts` 系统提示段进了装配结果，并真的跑几段程序。
 *
 * 阶段 3 起 `run_program` 是**后台 job**：工具立刻返回 `{ jobId, status: 'running' }`，程序在
 * 后台继续跑。所以每个用例都是两段——(1) 断言工具立刻返回，(2) 等 job 结算后从 job 输出里取回
 * 程序结果。阶段 1/2 对程序结果的断言（B1 的 `EE_OK`、B2 的退出码/超时、B6 的文本与归属）原样保留。
 *
 * 读取路径（phase3-plan §11 Q1 裁决丙）：本阶段**不给模型任何读取工具**，所以驱动走的是
 * `ctx.jobs` 自己的契约——`wait` 等终态、`read` 取输出，`caller` 就是发起本次 run 的那个 agent
 * 实例（注册表按 owner 的会话 id 授权）。
 *
 * 分支由传入 fixture 解析出的沙箱模式决定（见 sandboxMode），不引入额外开关：
 *
 * 两个组合共有：
 * - B0 不给发起者的 `run_program` 调用大声失败——这一层判空在 `host/index.ts`，是生产上唯一
 *   会触发它的地方（`SubagentBindingOptions.parent` 是必填，binding 里没有这一支）。
 * - B8 没有程序在跑时 `cancel_program` 正常返回（幂等，不是错误）。
 * - B14a 两条面板 route 真的挂在 `ctx.connection.fetch` 上（经 connection 的共享 fetch 处理函数发
 *   请求，所以走的是真的注册结果），以及查询参数的边界（缺 sessionId、负的 `since` 都是 400）。
 *   这一段不跑程序，所以它在两个组合里都跑得到。
 *
 * 不受限组合（`tests/fixtures/cordis.yml`，danger-full-access）：
 * - B1 程序能跑、`process` 真的执行外部程序（`python -c 'print("EE_OK")'`）；
 * - B1b `run_program` **立刻**返回：程序 sleep 4s，工具显著更早返回且 status 是 running；
 * - B2 非零退出码正常返回、`processOrThrow` 抛出、超时生效且显著早于脚本自己的 30s；
 * - B3 超过 `maxTimeoutMs` 的请求在解析期被拒，且**没有启动任何进程**（哨兵文件不出现）；
 * - B4 超时后整个进程树被清干净（脚本 fork 出的子进程不会稍后写出哨兵文件）；
 * - B6 洞与归属：`dispatchsubagent` 拿回脚本化 provider 的固定文本；provider 记到的 `parent`
 *   逐字是发起本次调用的 agent；provider 取的是 Config 里的 `subagentProvider`；
 *   子 agent 非正常完成时 `dispatchsubagent` 抛出，消息里带上 reason 与 provider 写的诊断。
 * - B7 单例：程序 A 在跑时再启动被拒（错误里带 A 的 job id）；取消 A 之后能立刻启动 B，
 *   且取消返回时 A 的临时目录已经消失；
 * - B9 取消等清理：给一个 fork 了子进程并 sleep 的程序发取消，**返回的那一刻**两个进程都已消失、
 *   临时目录已删除，3s 后本该出现的哨兵文件始终没有出现；
 * - B10 job owner 生命周期：dispose 发起 agent 的 scope → job 被取消、清理完成、记录被删除。
 * - B11 `report` 真的投递给发起 agent（顺序、`source`、摘要上界），且 `flow/start` / `flow/report` /
 *   `flow/end` 三个 observe-only 事件以同一个 run 身份发全；
 * - B12 取消后未投递的 `report` 不再投递：程序报三条然后去等一个长跑进程，取消返回时那三条已经从
 *   发起者的挂起队列里消失，而**上一次 run** 留下的两条原封不动（作废的范围是本次 run）；这一次的
 *   `flow/end` 因此带上 `discarded: 3`，上一次（正常跑完）是 `0`。
 * - B13 执行位置上报（阶段 5）：`flow/call-start` 的 `line` 逐条等于程序里写死的行号（含循环里重复
 *   出现的同一行）、`flow/call-start` 与 `flow/call-end` 按 `callId` 成对、失败调用也闭合且
 *   `outcome === 'error'`、`flow/start.code` 是提交的正文原文，而内部 `trace` 通道不在程序可见面里。
 *   取消一个正在 `await process(sleep)` 的程序时，那条再也没人能闭合的调用由宿主补发一条
 *   `synthetic` 的 `flow/call-end`——而且它先于 `flow/end` 到达。
 * - B14b 面板状态与 `flow/*` 一致（程序正文逐字、轨迹的 callId/行号/耗时/结局逐条等于事件、
 *   report 同序、没有还开着的调用）、`since` 增量的三种取值（最新/中间/比最新还大）、以及
 *   **经路由取消**：与工具取消同一条路径，响应回来时临时目录已经删掉（与 B9 同一判据形态）、
 *   run 的终态在面板状态里是 `killed`，再取消一次幂等地回 `cancelled: false`。
 *
 * 受限组合（`tests/fixtures/cordis-confined.yml`，workspace-write）：
 * - B5 `process` 起的外部进程过发起会话的文件策略：同一个程序里，写工作目录外的路径被
 *   拒绝、写工作目录内 `.execution-engine` 下的路径成功；两条用例互补，见块内注释。
 *
 * 用法（cwd = 仓库根，必须带 tsx，否则裸包名解析不到源码）：
 *   node --import tsx/esm Workspace/ExecutionEngine/tests/loader-driver.ts \
 *     Workspace/ExecutionEngine/tests/fixtures/cordis.yml              # B0–B4、B6–B12
 *   node --import tsx/esm Workspace/ExecutionEngine/tests/loader-driver.ts \
 *     Workspace/ExecutionEngine/tests/fixtures/cordis-confined.yml     # B0、B5、B8
 *
 * 成功判据：exit 0，stdout 末尾 `LOADER_SMOKE_OK`。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { boot, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'
import type { JobId } from '@deepseek-ai/dsh-jobs'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { MessageId, UserMessage } from '@deepseek-ai/dsh-llm'
import type { FlowCallEndEvent, FlowCallStartEvent, FlowStartEvent } from '../host/flow-events.ts'
import { CANCEL_PATH, STATE_PATH } from '../shared/protocol.ts'
import type { FlowCallEntry, FlowReportEntry, FlowSnapshot } from '../shared/protocol.ts'
import { FAILURE_DIAGNOSTIC, FAILURE_MARKER, SCRIPTED_REPLY, scriptedStarts } from './fixtures/scripted-subagent-provider.ts'
import * as plugin from '../host/index.ts'

/** run_program 结果里返回值小节的固定前缀（host/engine.ts 的渲染）。 */
const VALUE_MARKER = '程序返回值：\n'

/** run_program 结果里失败小节的固定前缀（host/engine.ts 的渲染）。 */
const PROGRAM_FAILURE_MARKER = '程序执行失败（'

/** 每次调用一个不同的 id，便于在日志里对上。 */
let callSeq = 0

const configPath = process.argv[2]
if (configPath === undefined) throw new Error('loader-driver requires a config path')

assert.equal(plugin.name, 'execution-engine')
assert.deepEqual(
  plugin.inject,
  ['tools', 'jobs', 'ptcRuntime', 'subprocess', 'subagents', 'sandbox', 'systemPrompt'],
)
assert.equal(typeof plugin.apply, 'function')
assert.ok(!('default' in plugin), 'the plugin module must not export default (postmortem 0001)')

const scratch = mkdtempSync(join(tmpdir(), 'ee-loader-driver-'))

/** B5 建在工作目录外/内的落点；只有受限分支会填，finally 统一清理。 */
const b5Paths: string[] = []

const ctx = await boot('execution-engine-loader-smoke', resolveConfigPath(configPath, undefined))

/**
 * `path` 是否在 `root` 之内（含 `root` 本身）。B5 的互补性前提就靠这一条钉住：
 * 两条用例必须分处边界两侧。
 * @param root - 工作目录根，绝对路径。
 * @param path - 待判定的绝对路径。
 * @returns `path` 等于 `root` 或在 `root` 之下。
 */
function isInside(root: string, path: string): boolean {
  return path === root || path.startsWith(root + sep)
}

/** 工具结果里的文本块拼起来——模型看到的就是这些。 */
function textOf(result: { content: readonly { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

/** 调一次工具，返回工具结果本身（不做 isError 断言：好几条用例看的正是失败文本）。 */
function callTool(name: string, args: unknown, owner?: Agent) {
  return ctx.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId(`execution-engine-${name}-${String(++callSeq)}`),
    name,
    arguments: args,
    ...owner === undefined ? {} : { agent: owner },
  })
}

/**
 * 装配前提：fixture 必须挂上这个服务。返回非可选类型，好让下面的闭包也拿得到收窄结果。
 * @param service - `ctx.get` 的结果。
 * @param label - 缺了它时的错误说明。
 * @returns 同一个服务，类型里没有 `undefined`。
 */
function requireService<T>(service: T | undefined, label: string): T {
  if (service === undefined) throw new Error(`the fixture must mount ${label}`)
  return service
}

/**
 * 传入 fixture 的已解析文件策略，也是本次分支的选择依据（见文件头）。
 * `sandboxPolicy` 不在 `inject` 里，所以用严格的 `ctx.get` 读全局服务（postmortem 0001）。
 */
const policyService = requireService(ctx.get('sandboxPolicy'), 'sandboxPolicy')
const sandboxMode = policyService.resolve().mode

const sessions = requireService(ctx.get('sessions'), 'the session store')
const agents = requireService(ctx.get('agents'), 'the agent registry')

/**
 * 面板两条 route 的驱动面：**经真实 connection 服务**发请求。
 *
 * `createSharedFetchHandler` 是 connection 的公开面（packages/client/connection/src/rpc-host.ts:117）：
 * 它按 exact path 分派到各插件注册的 Fetch route，所以驱动走的是真的注册结果，而不是绕过注册直接调
 * 处理函数——"路由挂上了没有"因此也在判据里。信任检查与浏览器鉴权在物理载体那一层
 * （`requestRejection`），本驱动不经过它。
 */
const connection = requireService(ctx.get('connection'), 'the client-connection service')
const panelApi = connection.createSharedFetchHandler('/api')

/**
 * 取一次面板状态。
 * @param sessionId - 目标会话。
 * @param since - 增量游标；不给就是"全量"。
 * @returns 路由的原始响应。
 */
async function readPanelState(sessionId: string, since?: number): Promise<Response> {
  const query = `sessionId=${encodeURIComponent(sessionId)}${since === undefined ? '' : `&since=${String(since)}`}`
  return await panelApi.fetch(new Request(`http://dsh.invalid${STATE_PATH}?${query}`))
}

/**
 * 经路由取消一次。
 * @param sessionId - 目标会话。
 * @returns 路由的原始响应。
 */
async function cancelPanel(sessionId: string): Promise<Response> {
  return await panelApi.fetch(
    new Request(`http://dsh.invalid${CANCEL_PATH}?sessionId=${encodeURIComponent(sessionId)}`, { method: 'POST' }),
  )
}

/**
 * 读一份面板状态并断言它是 200。
 * @param sessionId - 目标会话。
 * @param since - 增量游标；不给就是"全量"。
 * @returns 解析后的状态快照。
 */
async function panelState(sessionId: string, since?: number): Promise<FlowSnapshot> {
  const response = await readPanelState(sessionId, since)
  assert.equal(response.status, 200, `reading the panel state failed with ${String(response.status)}`)
  return await response.json() as FlowSnapshot
}

/** 工作目录下本插件专属的 run 临时目录根（host/tmp-dir.ts 的 RUN_ROOT）。 */
const runRoot = join(policyService.resolve().workspaceRoot, '.execution-engine')

/**
 * 当前还在的 run 临时目录。每个 run 一个独立子目录，run 结束（含取消）整体删除，根目录自己
 * 留在原地——所以"清理完成"的观察就是这里为空。
 * @returns 子目录名列表。
 */
function liveRunDirs(): string[] {
  return existsSync(runRoot) ? readdirSync(runRoot) : []
}

/**
 * 建一个真的发起 agent：真 Session + 自己的 scope fiber + 注册进 `ctx.agents`。
 *
 * 阶段 3 起发起者同时是 job 的 owner，而 owner 必须是**注册表里活着的那个实例**——
 * jobs-local 的 `ensureOwnerCleanup` 比对 `agents.get(id) === owner`，不等就拒绝
 * （packages/jobs/jobs-local/src/index.ts:448-456）。所以不能再用一个只有 id 的替身。
 *
 * 注册表 disposal 与 scope disposal 是两件事：前者摘掉注册记录，后者才是"会话关闭"，
 * job 的 drain 挂在后者上（先例 packages/jobs/tool-jobs/tests/tool-jobs.spec.ts:44-71）。
 *
 * 阶段 4 起这个替身还带一个**收件箱**：`report` 需要 `followup`，作废需要 `inbox.remove`
 * （`host/report-binding.ts`）。真身是 agent-loop 的 `ReactLoopInbox`，但本驱动不挂
 * `dsh-agent-loop`（它要模型 route、会话持久化一整套），所以这里按契约做最小实现：投进来的消息
 * **一直挂着、不被领取**——那正是"主 agent 正忙、还没走到下一个 turn"的那一段，也是 B12 要的形态。
 * @param label - 会话 id 用的前缀，便于在日志里区分。
 * @returns 发起者、它自己的 scope fiber，以及收件箱里挂着的消息（按投递顺序）。
 */
async function makeAgent(label: string) {
  const scope = ctx.plugin(() => {})
  const session = sessions.create(undefined, { meta: { cwd: policyService.resolve().workspaceRoot } })
  const pending: UserMessage[] = []
  const agent = {
    id: session.id,
    session,
    options: {},
    status: 'running',
    ctx: scope.ctx,
    followup(message: UserMessage) { pending.push(message) },
    inbox: {
      remove(messageId: MessageId): boolean {
        const index = pending.findIndex(message => message.id === messageId)
        if (index < 0) return false
        pending.splice(index, 1)
        return true
      },
    },
  } as unknown as Agent
  await agents.register(agent)
  assert.equal(agents.get(session.id), agent, `${label}: the owner must be the registered instance`)
  return { agent, scope, pending }
}

const initiator = (await makeAgent('initiator')).agent

/**
 * 调一次 `run_program` 并立刻返回工具结果。
 * @param code - 程序源码。
 * @param owner - 发起者；省略即不给发起者（B0 用）。
 * @returns 工具结果。
 */
function callRunProgram(code: string, owner?: Agent) {
  return callTool('run_program', { code }, owner)
}

/** 调一次 `cancel_program`。 */
function callCancelProgram(owner?: Agent) {
  return callTool('cancel_program', {}, owner)
}

/** 一次 run_program 调用：job id、返回时的状态、模型可见文本与调用耗时。 */
interface ProgramStart {
  readonly jobId: string
  readonly status: string
  readonly text: string
  readonly elapsedMs: number
}

/**
 * 提交一段程序并断言工具**立刻**返回。
 *
 * 返回时程序还在跑：`status` 必须是 `running`，文本里必须带上 job id（渲染只有一处，
 * 见 `host/tool.ts` 的 `render`）。
 * @param code - 程序源码。
 * @param owner - 发起者；缺省用 `initiator`。
 * @returns job id、状态、文本与耗时。
 */
async function startProgram(code: string, owner: Agent = initiator): Promise<ProgramStart> {
  const startedAt = Date.now()
  const result = await callRunProgram(code, owner)
  const elapsedMs = Date.now() - startedAt
  const text = textOf(result)
  if (result.isError) throw new Error(`run_program itself failed: ${text}`)
  const value = result.value as { jobId: string; status: string }
  assert.equal(value.status, 'running', `run_program must return a live job:\n${text}`)
  assert.ok(text.includes(value.jobId), `the rendered content must name the job:\n${text}`)
  return { jobId: value.jobId, status: value.status, text, elapsedMs }
}

/**
 * 等一个 job 结算，并从它的输出里取回程序结果（阶段 3 的读取路径，见文件头）。
 *
 * `caller` 必须是发起本次 run 的那个 agent 实例：注册表按 owner 的会话 id 授权，换一个 caller
 * 会直接抛 "belongs to another session"（packages/jobs/jobs-local/src/index.ts:356-360）。
 * @param jobId - `run_program` 交回的 id。
 * @param owner - 发起者。
 * @param timeoutMs - 等待上界；超了就是判据没跑成，不是判据失败。
 * @returns 程序结果的渲染文本。
 */
async function jobOutput(jobId: string, owner: Agent = initiator, timeoutMs = 120_000): Promise<string> {
  const id = jobId as unknown as JobId
  const snapshot = await ctx.jobs.wait(id, timeoutMs, owner)
  assert.ok(
    snapshot.status !== 'running' && snapshot.status !== 'stopping',
    `job ${jobId} did not settle within ${String(timeoutMs)}ms (status ${snapshot.status})`,
  )
  return ctx.jobs.read(id, owner).text
}

/** 跑完一段程序并取回渲染结果——B1–B6 的判据原样保留，只是改从 job 输出里取。 */
async function runToCompletion(code: string, owner?: Agent): Promise<string> {
  const started = await startProgram(code, owner)
  return await jobOutput(started.jobId, owner ?? initiator)
}

/** 程序失败只体现在文本里（工具结果不带 isError 字段）。 */
function assertProgramSucceeded(output: string, label: string): void {
  assert.ok(!output.includes(PROGRAM_FAILURE_MARKER), `${label}: the program failed:\n${output}`)
}

/** 从渲染文本的尾部取回程序返回值。 */
function returned(output: string): unknown {
  const index = output.lastIndexOf(VALUE_MARKER)
  assert.ok(index >= 0, `run_program output has no return-value section:\n${output}`)
  return JSON.parse(output.slice(index + VALUE_MARKER.length))
}

/** 进程是否还活着：0 号信号只探存在性，不投递。 */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * 轮询等到这些文件都存在（脚本自己写 pid 文件，比"猜它起了没有"可靠）。
 * @param paths - 待出现的绝对路径。
 * @param timeoutMs - 等待上界。
 */
async function waitForFiles(paths: readonly string[], timeoutMs: number): Promise<void> {
  const deadlineAt = Date.now() + timeoutMs
  while (paths.some(path => !existsSync(path))) {
    if (Date.now() > deadlineAt) throw new Error(`timed out waiting for ${paths.join(', ')}`)
    await delay(50)
  }
}

try {
  assert.ok(
    ctx.tools.schemas().some(tool => tool.name === 'run_program'),
    'run_program is not registered',
  )
  assert.ok(
    ctx.tools.schemas().some(tool => tool.name === 'cancel_program'),
    'cancel_program is not registered',
  )
  // 阶段 3 的模型面就是这两个：不给任何读取工具（phase3-plan §11 Q1 裁决丙）。
  assert.deepEqual(
    ctx.tools.schemas().map(tool => tool.name).filter(name => name === 'job_output' || name === 'job_list' || name === 'job_kill'),
    [],
    'the generic job tools must not be mounted: they would widen the model surface past design.md §6.4',
  )

  // `.d.ts` 系统提示段：模型写程序时的唯一依据，必须在装配结果里。
  const assembly = await ctx.systemPrompt.assemble({})
  const sdk = assembly.sections.find(section => section.name === 'execution-engine-sdk')
  assert.ok(sdk !== undefined, 'the execution-engine-sdk prompt section is not registered')
  assert.equal(sdk.interpolate, false, 'the SDK text must not be interpolated')
  for (const declaration of ['declare function dispatchsubagent(', 'declare function report(', 'declare function process(', 'declare function processOrThrow(', 'flow.tmpDir', 'declare const console', 'cancel_program']) {
    assert.ok(sdk.text.includes(declaration), `the SDK section must declare ${declaration}`)
  }

  // ---- B14a：两条面板 route 真的挂在 connection 上（两个组合共有，不需要跑程序） ------
  // 阶段 6 的面板只能经路由拿到状态（`flow/*` 是 Cordis 事件，出不了宿主进程），所以"路由挂上了
  // 没有"本身就是判据。这一段不跑程序，纯粹看注册结果与查询参数边界。
  const neverRan = 'session-that-never-ran'
  assert.deepEqual(
    await panelState(neverRan),
    { run: null, revision: 0, entries: [], reset: true },
    'a session that never ran a program must read as an empty panel',
  )
  const missingSession = await panelApi.fetch(new Request(`http://dsh.invalid${STATE_PATH}`))
  assert.equal(missingSession.status, 400, 'a state read without sessionId must be a 400')
  assert.equal((await readPanelState(neverRan, -1)).status, 400, 'since must be a non-negative safe integer')
  assert.equal(
    (await panelApi.fetch(new Request(`http://dsh.invalid${CANCEL_PATH}`, { method: 'POST' }))).status,
    400,
    'a cancel without sessionId must be a 400',
  )
  process.stdout.write('B14a the panel routes are mounted on ctx.connection.fetch: OK\n')

  // ---- B0：没有发起者的调用大声失败（两个组合共有） ---------------------------
  // `ToolRunContext.agent` 是可选字段，所以 `host/index.ts` 自己判空；它是生产上唯一会触发那句
  // 错误的地方（binding 的 `parent` 是必填，缺席在类型层不可表达），只有真装配跑得出来。
  const noAgent = textOf(await callRunProgram('return 1'))
  assert.match(
    noAgent,
    /requires an initiating agent/,
    `a run_program call without an initiating agent must fail loud:\n${noAgent}`,
  )
  process.stdout.write('B0 run_program without an initiating agent fails loud: OK\n')

  // ---- B8：没有程序在跑时取消是正常返回（两个组合共有，且必须在别的用例之前） --------
  const idleCancel = await callCancelProgram(initiator)
  assert.equal(idleCancel.isError, false, 'cancelling with nothing running must not be a tool failure')
  const idleCancelValue = idleCancel.value as { cancelled: boolean }
  assert.equal(idleCancelValue.cancelled, false)
  assert.match(textOf(idleCancel), /当前没有正在运行的程序/)
  process.stdout.write('B8 cancel_program with nothing running returns normally: OK\n')

  if (sandboxMode === 'danger-full-access') {
    // ---- B1：程序能跑，process 真的执行外部程序 -------------------------------
    const b1 = await runToCompletion(`
const r = await process(['python', '-c', 'print("EE_OK")'])
return { ok: r.code === 0 && r.stdout.trim() === 'EE_OK', code: r.code, out: r.stdout.trim() }
`)
    assertProgramSucceeded(b1, 'B1')
    assert.deepEqual(returned(b1), { ok: true, code: 0, out: 'EE_OK' })
    process.stdout.write('B1 run_program + process: OK\n')

    // ---- B1b：工具立刻返回，不等程序跑完 --------------------------------------
    // 程序自己 sleep 4s；工具必须显著更早返回。差值取得足够大，慢机器上也不会 flaky
    // （phase3-plan R6）。
    const b1b = await startProgram(`
await process(['python', '-c', 'import time; time.sleep(4)'])
return 'EE_SLOW_DONE'
`)
    assert.ok(
      b1b.elapsedMs < 2_000,
      `B1b: run_program took ${String(b1b.elapsedMs)}ms — it waited for the program instead of returning`,
    )
    const b1bOutput = await jobOutput(b1b.jobId)
    assertProgramSucceeded(b1bOutput, 'B1b')
    assert.equal(returned(b1bOutput), 'EE_SLOW_DONE', 'the background program must still have run to completion')
    process.stdout.write(`B1b run_program returns immediately: OK (returned in ${String(b1b.elapsedMs)}ms)\n`)

    // ---- B2：非零退出码正常返回、processOrThrow 抛出、超时生效 ----------------
    const b2a = await runToCompletion(`
const r = await process(['python', '-c', 'import sys; sys.exit(3)'])
return { code: r.code, timedOut: r.timedOut, stderr: r.stderr }
`)
    assertProgramSucceeded(b2a, 'B2a')
    assert.equal((returned(b2a) as { code: number }).code, 3, 'a non-zero exit code must be returned normally')

    const b2b = await runToCompletion(`
try {
  await processOrThrow(['python', '-c', 'import sys; sys.exit(3)'])
  return { threw: false }
} catch (error) {
  return { threw: true, message: String(error && error.message) }
}
`)
    assertProgramSucceeded(b2b, 'B2b')
    const thrown = returned(b2b) as { threw: boolean; message?: string }
    assert.equal(thrown.threw, true, 'processOrThrow must throw on a non-zero exit code')
    assert.match(String(thrown.message), /exited with code 3/)

    const timeoutStart = Date.now()
    const b2c = await runToCompletion(`
const r = await process(['python', '-c', 'import time; time.sleep(30)'], { timeoutMs: 1000 })
return { timedOut: r.timedOut, code: r.code }
`)
    const timeoutElapsedMs = Date.now() - timeoutStart
    assertProgramSucceeded(b2c, 'B2c')
    assert.equal((returned(b2c) as { timedOut: boolean }).timedOut, true, 'the 1s budget must expire')
    assert.ok(
      timeoutElapsedMs < 15_000,
      `B2c: a 1s timeout took ${String(timeoutElapsedMs)}ms — the 30s sleep was not cut short`,
    )
    process.stdout.write(`B2 exit codes, processOrThrow and timeout: OK (timeout case ${String(timeoutElapsedMs)}ms)\n`)

    // ---- B3：超上限在解析期被拒，且没有启动任何进程 ---------------------------
    const b3Sentinel = join(scratch, 'b3-started.txt')
    const b3 = await runToCompletion(`
try {
  await process(
    ['python', '-c', 'import pathlib,sys; pathlib.Path(sys.argv[1]).write_text("started")', ${JSON.stringify(b3Sentinel)}],
    { timeoutMs: 10000000 },
  )
  return { rejected: false }
} catch (error) {
  return { rejected: true, message: String(error && error.message) }
}
`)
    assertProgramSucceeded(b3, 'B3')
    const b3Result = returned(b3) as { rejected: boolean; message?: string }
    assert.equal(b3Result.rejected, true, 'a request over maxTimeoutMs must be rejected before execution')
    assert.match(String(b3Result.message), /exceeds the configured maximum of 900000/)
    assert.equal(existsSync(b3Sentinel), false, 'B3: the rejected request must not have started a process')
    process.stdout.write('B3 over-max request rejected before spawn: OK\n')

    // ---- B4：超时后整个进程树被清干净 -----------------------------------------
    const b4Sentinel = join(scratch, 'b4-orphan.txt')
    const orphanScript = join(scratch, 'orphan.py')
    const forkerScript = join(scratch, 'forker.py')
    writeFileSync(orphanScript, [
      'import pathlib, sys, time',
      'time.sleep(3)',
      'pathlib.Path(sys.argv[1]).write_text("alive")',
      '',
    ].join('\n'))
    writeFileSync(forkerScript, [
      'import subprocess, sys, time',
      '# sys.argv[1] = sentinel, sys.argv[2] = orphan script',
      'subprocess.Popen([sys.executable, sys.argv[2], sys.argv[1]])',
      'time.sleep(30)',
      '',
    ].join('\n'))

    const b4Start = Date.now()
    const b4 = await runToCompletion(`
const r = await process(
  ['python', ${JSON.stringify(forkerScript)}, ${JSON.stringify(b4Sentinel)}, ${JSON.stringify(orphanScript)}],
  { timeoutMs: 1000 },
)
return { timedOut: r.timedOut }
`)
    const b4ElapsedMs = Date.now() - b4Start
    assertProgramSucceeded(b4, 'B4')
    assert.equal((returned(b4) as { timedOut: boolean }).timedOut, true, 'B4: the 1s budget must expire')
    assert.ok(b4ElapsedMs < 15_000, `B4: the 30s parent was not cut short (${String(b4ElapsedMs)}ms)`)
    // 子进程 3s 后才写哨兵；等够时间再看它还在不在。
    await delay(6_000)
    assert.equal(
      existsSync(b4Sentinel),
      false,
      'B4: the forked descendant survived the timeout — the managed range was not cleared',
    )
    process.stdout.write('B4 process tree cleared after timeout: OK\n')

    // ---- B6：洞与归属 ---------------------------------------------------------
    // 判据 1 + 4：程序里两次 `dispatchsubagent` 各拿回脚本化 provider 的固定文本，而该 provider
    // 之所以被调用，是因为 fixture 把 `subagentProvider` 配成了 `scripted`——配错成没注册的名字时
    // `ctx.subagents.start` 会直接拒绝，这段程序会以失败小节收场，下面第一条断言就会拦住。
    const b6 = await runToCompletion(`
const first = await dispatchsubagent('scripted one')
const second = await dispatchsubagent('scripted two')
return { first, second }
`)
    assertProgramSucceeded(b6, 'B6')
    assert.deepEqual(returned(b6), { first: SCRIPTED_REPLY, second: SCRIPTED_REPLY })

    // 判据 2：归属用 SessionId 逐字比对，不是"非空"这种弱断言。
    const recorded = scriptedStarts()
    assert.equal(
      recorded.length,
      2,
      'the scripted provider recorded no start — the fixture and the driver resolved different module instances, '
      + 'or the configured provider was not the scripted one',
    )
    assert.deepEqual(
      recorded.map(entry => entry.parentId),
      [initiator.id, initiator.id],
      'every child must be attributed to the agent that initiated this run_program call',
    )
    assert.deepEqual(recorded.map(entry => entry.prompt), ['scripted one', 'scripted two'])
    process.stdout.write('B6 dispatchsubagent text and ownership: OK\n')

    // 判据 5：子 agent 非正常完成时抛出，且消息里带上 reason 与 provider 写的诊断
    // （phase2-plan §9 Q1；诊断是有意的信息通道，见 packages/subagent/subagent/src/types.ts:288-294）。
    const b6Failure = await runToCompletion(`
try {
  await dispatchsubagent(${JSON.stringify(`${FAILURE_MARKER} this one must fail`)})
  return { threw: false }
} catch (error) {
  return { threw: true, message: String(error && error.message) }
}
`)
    assertProgramSucceeded(b6Failure, 'B6-failure')
    const failedChild = returned(b6Failure) as { threw: boolean; message?: string }
    assert.equal(failedChild.threw, true, 'a non-completed child must make dispatchsubagent throw')
    const failureMessage = String(failedChild.message)
    assert.match(failureMessage, /error/)
    assert.ok(
      failureMessage.includes(FAILURE_DIAGNOSTIC),
      `the failure message must carry the provider diagnostic:\n${failureMessage}`,
    )
    assert.equal(scriptedStarts().length, 3, 'the failing dispatch must still have reached the provider')
    process.stdout.write('B6 non-completed child throws with its reason and diagnostic: OK\n')

    // ---- B7：单例 -------------------------------------------------------------
    // A 会睡 60s，只有在"真的后台跑"的前提下才可能撞上单例。
    const b7a = await startProgram(`
await process(['python', '-c', 'import time; time.sleep(60)'])
return 'A_FINISHED'
`)
    const b7Refusal = await callRunProgram('return "B"', initiator)
    assert.equal(b7Refusal.isError, true, 'a second program must be refused while one is running')
    const refusalText = textOf(b7Refusal)
    assert.match(refusalText, /已经有一个程序在跑/, `the refusal must explain the singleton:\n${refusalText}`)
    assert.ok(
      refusalText.includes(b7a.jobId),
      `the refusal must name the job that is already running:\n${refusalText}`,
    )

    // 取消 A：返回的那一刻，A 的临时目录已经删掉。
    const b7Cancel = await callCancelProgram(initiator)
    assert.equal(b7Cancel.isError, false, `cancelling A failed: ${textOf(b7Cancel)}`)
    const b7CancelValue = b7Cancel.value as { cancelled: boolean; jobId?: string; status?: string }
    assert.equal(b7CancelValue.cancelled, true)
    assert.equal(b7CancelValue.jobId, b7a.jobId)
    assert.deepEqual(liveRunDirs(), [], 'B7: cancelling A must have removed its run temporary directory')

    // A 结算之后可以立刻启动 B，不会出现两个并存。
    const b7b = await startProgram('return "B_OK"')
    const b7bOutput = await jobOutput(b7b.jobId)
    assertProgramSucceeded(b7bOutput, 'B7-b')
    assert.equal(returned(b7bOutput), 'B_OK')
    assert.deepEqual(liveRunDirs(), [], 'B7: B must have cleaned up after itself too')
    process.stdout.write('B7 singleton refusal, cancel, and immediate restart: OK\n')

    // ---- B9：取消等清理真正完成 -----------------------------------------------
    // 程序 await 一个 fork 了子进程并睡 30s 的 process；取消它，然后在**返回的那一刻**看两个进程。
    // 这是 design.md §4.4 "等到清理真正完成才返回"唯一能被观察到的形态：等的是 job 的 `done`，
    // 而 `done` 在 runProgram 的 finally（先 drain 在飞的外部执行、再删临时目录）之后才 resolve。
    const b9Sentinel = join(scratch, 'b9-orphan.txt')
    const b9ParentPid = join(scratch, 'b9-parent.pid')
    const b9ChildPid = join(scratch, 'b9-child.pid')
    const b9OrphanScript = join(scratch, 'b9-orphan.py')
    const b9ForkerScript = join(scratch, 'b9-forker.py')
    // argv: sentinel=1, 自己的 pid 文件=2
    writeFileSync(b9OrphanScript, [
      'import os, pathlib, sys, time',
      'pathlib.Path(sys.argv[2]).write_text(str(os.getpid()))',
      'time.sleep(3)',
      'pathlib.Path(sys.argv[1]).write_text("alive")',
      '',
    ].join('\n'))
    // argv: sentinel=1, orphan 脚本=2, 自己的 pid 文件=3, 子进程 pid 文件=4
    writeFileSync(b9ForkerScript, [
      'import os, pathlib, subprocess, sys, time',
      'pathlib.Path(sys.argv[3]).write_text(str(os.getpid()))',
      'subprocess.Popen([sys.executable, sys.argv[2], sys.argv[1], sys.argv[4]])',
      'time.sleep(30)',
      '',
    ].join('\n'))

    const b9 = await startProgram(`
const r = await process([
  'python', ${JSON.stringify(b9ForkerScript)}, ${JSON.stringify(b9Sentinel)},
  ${JSON.stringify(b9OrphanScript)}, ${JSON.stringify(b9ParentPid)}, ${JSON.stringify(b9ChildPid)},
])
return r.code
`)
    assert.equal(b9.status, 'running')
    await waitForFiles([b9ParentPid, b9ChildPid], 20_000)
    const b9Parent = Number(readFileSync(b9ParentPid, 'utf8'))
    const b9Child = Number(readFileSync(b9ChildPid, 'utf8'))
    assert.ok(processAlive(b9Parent) && processAlive(b9Child), 'B9: the process tree must be alive before the cancel')

    const b9Cancel = await callCancelProgram(initiator)
    assert.equal(b9Cancel.isError, false, `cancelling the B9 program failed: ${textOf(b9Cancel)}`)

    // 返回的**这一刻**：两个进程都不在了，临时目录也删了。
    assert.equal(processAlive(b9Parent), false, 'B9: the forked parent outlived the cancel return')
    assert.equal(processAlive(b9Child), false, 'B9: the forked descendant outlived the cancel return')
    assert.deepEqual(liveRunDirs(), [], 'B9: the cancel return must come after the temporary directory is gone')
    // 后备：3s 后本该写出的哨兵始终没有出现（进程树真的被清了，而不是只剩一个空壳 pid）。
    await delay(5_000)
    assert.equal(existsSync(b9Sentinel), false, 'B9: the forked descendant survived the cancel')
    process.stdout.write('B9 cancel waits for the process tree and temporary directory: OK\n')

    // ---- B10：job owner 生命周期 ----------------------------------------------
    // 用一个单独的发起者，免得把 initiator 用掉之后后面的用例没法跑。
    const retiring = await makeAgent('retiring')
    const b10 = await startProgram(`
await process(['python', '-c', 'import time; time.sleep(60)'])
return 'never'
`, retiring.agent)
    assert.equal(b10.status, 'running')

    // 用户关掉会话 = 发起 agent 的 scope 被 dispose。注册表的契约是"owner disposal 取消并 await
    // 这个 job"（packages/jobs/jobs/src/types.ts:56-62），所以 dispose 返回时清理已经完成。
    await retiring.scope.dispose()

    assert.deepEqual(liveRunDirs(), [], 'B10: disposing the owner must leave no run temporary directory')
    assert.throws(
      () => ctx.jobs.get(b10.jobId as unknown as JobId, retiring.agent),
      /unknown job/,
      'B10: the owner disposal must have removed the job record',
    )
    process.stdout.write('B10 job owner disposal cancels and awaits the program: OK\n')

    // ---- B11：report 真的投递给发起 agent，顺序与程序调用顺序一致 -----------------
    // ---- B12：取消后未投递的 report 不再投递 -------------------------------------
    // 两条共用一个单独的发起者：它的收件箱替身不领取任何东西，所以"挂起"就是它的全部状态。
    const reporter = await makeAgent('reporter')

    /**
     * `flow/*` 的观察面。驱动从 boot 拿到的根上下文就收得到：Cordis 的 events 服务是根上下文那一个
     * 实例，子上下文按原型链共用它（`vendor/cordis/src/context.ts:80`），dispatcher 也不做作用域
     * 过滤（本插件的发射不带 `this`）。监听器不消费任何东西——observe-only 就是"看着"。
     *
     * 判据一律**按 run 身份筛**，不按下标：这些事件从别的 promise 链上发出来，别的用例的事件什么
     * 时候落地不该影响这里的结论。
     */
    const flowStart: unknown[] = []
    const flowReport: unknown[] = []
    const flowEnd: unknown[] = []
    const callStart: unknown[] = []
    const callEnd: unknown[] = []
    /**
     * `flow/*` 的到达顺序（事件名 + run 身份）。B13 的"宿主补发的合成 `call-end` 先于 `flow/end`"
     * 是**跨事件**的顺序判据，几个分开的数组表达不了它。
     */
    const flowOrder: Array<{ readonly name: string; readonly runId: string }> = []
    ctx.on('flow/start', payload => { flowStart.push(payload); flowOrder.push({ name: 'flow/start', runId: String(payload.runId) }) })
    ctx.on('flow/report', payload => { flowReport.push(payload); flowOrder.push({ name: 'flow/report', runId: String(payload.runId) }) })
    ctx.on('flow/end', payload => { flowEnd.push(payload); flowOrder.push({ name: 'flow/end', runId: String(payload.runId) }) })
    ctx.on('flow/call-start', payload => { callStart.push(payload); flowOrder.push({ name: 'flow/call-start', runId: String(payload.runId) }) })
    ctx.on('flow/call-end', payload => { callEnd.push(payload); flowOrder.push({ name: 'flow/call-end', runId: String(payload.runId) }) })

    /**
     * 某一次 run 的事件。
     * @param events - 已经收到的事件。
     * @param runId - 要挑出来的那次 run。
     * @returns 属于这次 run 的事件，按到达顺序。
     */
    function eventsOf(events: readonly unknown[], runId: string): unknown[] {
      return events.filter(event => (event as { runId: string }).runId === runId)
    }

    /**
     * 一条 report 消息的正文，顺带钉住投递形态（`host/report-binding.ts` 的 source 契约）。
     * @param message - 发起者收件箱里的一条消息。
     * @param label - 断言失败时的用例名。
     * @returns 消息的文本正文。
     */
    function reportText(message: UserMessage, label: string): string {
      const source = message.source
      if (source.kind !== 'plugin') {
        throw new Error(`${label}: a report must be plugin-sourced, got ${source.kind}`)
      }
      assert.equal(source.plugin, 'execution-engine', `${label}: the report must name this plugin`)
      assert.equal(source.form, 'notice', `${label}: a report is a notice`)
      if (source.form !== 'notice') throw new Error(`${label}: unreachable`)
      // 一行折叠摘要：既不能是空串，也不能把整段 report 塞进去（CONTEXT_SUMMARY_MAX_CHARS = 120）。
      assert.ok(source.summary.length > 0, `${label}: the summary must not be empty`)
      assert.ok(
        source.summary.length <= 120,
        `${label}: the summary must be bounded, got ${String(source.summary.length)} chars`,
      )
      const block = message.content[0]
      if (block === undefined || block.type !== 'text') throw new Error(`${label}: a report carries one text block`)
      return block.text
    }

    /**
     * 等一个条件成立。
     *
     * `flow/end` 是在 job 的 `done` 回调里发的，而 `ctx.jobs.wait` 也在同一个 promise 上——两边的
     * 微任务顺序不是驱动该去猜的东西。等它真的到了，比"猜它已经到"可靠（与 `waitForFiles` 同一个
     * 理由，也避免慢机器上的偶发失败）。
     * @param condition - 要等的条件，每次轮询重新求值。
     * @param timeoutMs - 等待上界；超了就是判据没跑成，不是判据失败。
     * @param label - 超时信息里的用例名。
     */
    async function waitFor(condition: () => boolean, timeoutMs: number, label: string): Promise<void> {
      const deadlineAt = Date.now() + timeoutMs
      while (!condition()) {
        if (Date.now() > deadlineAt) {
          throw new Error(`${label}: timed out after ${String(timeoutMs)}ms waiting for its precondition`)
        }
        await delay(20)
      }
    }

    const b11Program = `
await report('one')
await report('two')
return 'B11_DONE'
`
    const b11 = await startProgram(b11Program, reporter.agent)
    const b11Output = await jobOutput(b11.jobId, reporter.agent)
    assertProgramSucceeded(b11Output, 'B11')
    assert.equal(returned(b11Output), 'B11_DONE')
    await waitFor(() => eventsOf(flowEnd, b11.jobId).length >= 1, 20_000, 'B11')

    // 判据 1：两条 report 都进了发起者的收件箱，顺序**就是**程序调用的顺序（design.md §6.2）。
    assert.deepEqual(
      reporter.pending.map(message => reportText(message, 'B11')),
      ['one', 'two'],
      'every report must reach the initiating agent, in call order',
    )
    const b11PendingIds = reporter.pending.map(message => message.id)

    // 判据 2：三个 observe-only 事件都发全了，而且带的是同一个 run 身份。程序正文随启动事件一起发
    // （阶段 5），逐字就是提交的那一份。
    assert.deepEqual(eventsOf(flowStart, b11.jobId), [
      { runId: b11.jobId, label: "await report('one')", ownerSession: reporter.agent.id, code: b11Program },
    ])
    assert.deepEqual(eventsOf(flowReport, b11.jobId), [
      { runId: b11.jobId, text: 'one' },
      { runId: b11.jobId, text: 'two' },
    ])
    assert.deepEqual(eventsOf(flowEnd, b11.jobId), [{ runId: b11.jobId, status: 'completed', discarded: 0 }])
    process.stdout.write('B11 report delivery, order, source and flow/* events: OK\n')

    // B12：程序报三条，然后去等一个长跑进程——三条都还挂在队列里（这一侧的收件箱不领取）。
    const b12 = await startProgram(`
await report('one')
await report('two')
await report('three')
await process(['python', '-c', 'import time; time.sleep(60)'])
return 'B12_DONE'
`, reporter.agent)
    assert.equal(b12.status, 'running')
    await waitFor(() => reporter.pending.length >= b11PendingIds.length + 3, 20_000, 'B12')
    assert.deepEqual(
      reporter.pending.slice(b11PendingIds.length).map(message => reportText(message, 'B12')),
      ['one', 'two', 'three'],
    )

    const b12Cancel = await callCancelProgram(reporter.agent)
    assert.equal(b12Cancel.isError, false, `cancelling the B12 program failed: ${textOf(b12Cancel)}`)
    const b12CancelValue = b12Cancel.value as { cancelled: boolean; status?: string }
    assert.equal(b12CancelValue.cancelled, true)
    assert.equal(b12CancelValue.status, 'killed')

    // 判据：取消返回的那一刻，本次 run 还没被读到的三条已经不在队列里；上一次 run（正常跑完）
    // 留下的两条原封不动——作废的范围是**被取消的那一次 run**，不是这个发起者的整个收件箱。
    assert.deepEqual(
      reporter.pending.map(message => message.id),
      b11PendingIds,
      'a cancelled run must discard its own undelivered reports and nothing else',
    )
    await waitFor(() => eventsOf(flowEnd, b12.jobId).length >= 1, 20_000, 'B12')
    // 三条都投递成功了、一条都没被领取，所以这次取消把三条全摘了——条数随 `flow/end` 报出来。
    assert.deepEqual(eventsOf(flowEnd, b12.jobId), [{
      runId: b12.jobId,
      status: 'killed',
      discarded: 3,
      detail: 'cancelled by the initiating agent',
    }])
    process.stdout.write('B12 undelivered reports are discarded on cancel: OK\n')

    // ---- B13：执行位置上报（阶段 5） -------------------------------------------
    // 行号判据写死，不用"大于 0"：下面的数组就是行号表，每条原语调用对照它在数组里的位置
    // （1-based）。`lineOffset: -1` 抵掉编译包装那一行前缀，所以栈里的行号就是这里的行号。
    const b13Program = [
      "const ok = await process(['python', '-c', 'print(1)'])",                  // 1
      "await report('b13')",                                                     // 2
      'for (let index = 0; index < 3; index++) {',                               // 3
      "  await process(['python', '-c', 'print(2)'])",                           // 4
      '}',                                                                       // 5
      'let failed = "none"',                                                     // 6
      'try {',                                                                   // 7
      "  await processOrThrow(['python', '-c', 'import sys; sys.exit(3)'])",     // 8
      '} catch (error) {',                                                       // 9
      '  failed = String(error && error.message)',                               // 10
      '}',                                                                       // 11
      'return {',                                                                // 12
      '  code: ok.code,',                                                        // 13
      '  failed,',                                                               // 14
      '  visible: Object.getOwnPropertyNames(globalThis),',                      // 15
      '  flowKeys: Object.getOwnPropertyNames(flow).join(","),',                 // 16
      '}',                                                                       // 17
    ].join('\n')
    const traced = await makeAgent('traced')
    const b13 = await startProgram(b13Program, traced.agent)
    const b13Output = await jobOutput(b13.jobId, traced.agent)
    assertProgramSucceeded(b13Output, 'B13')
    const b13Value = returned(b13Output) as {
      code: number
      failed: string
      visible: string[]
      flowKeys: string
    }
    assert.equal(b13Value.code, 0, 'B13: the first process must have run')
    assert.match(b13Value.failed, /exited with code 3/, 'B13: the failing processOrThrow must have thrown')

    // 判据 6：程序可见面没变——内部 `trace` 通道不在里面，`flow` 上仍然只有 `tmpDir`。
    assert.equal(
      b13Value.visible.includes('trace'),
      false,
      'B13: the internal trace channel must not be program-visible',
    )
    assert.equal(b13Value.flowKeys, 'tmpDir', 'B13: the visible flow namespace must still only carry tmpDir')

    // 判据 1：行号写死比对。循环里同一行出现三次，所以 process 在源码第 4 行上出现三次——
    // 重复是正常的，不去重（design.md §8.3 的"轨迹"要的就是这个）。
    await waitFor(
      () => eventsOf(callStart, b13.jobId).length >= 6 && eventsOf(callEnd, b13.jobId).length >= 6,
      20_000,
      'B13',
    )
    const b13Starts = eventsOf(callStart, b13.jobId) as FlowCallStartEvent[]
    const b13Ends = eventsOf(callEnd, b13.jobId) as FlowCallEndEvent[]
    assert.deepEqual(
      b13Starts.map(event => [event.member, event.line]),
      [
        ['process', 1],
        ['report', 2],
        ['process', 4],
        ['process', 4],
        ['process', 4],
        ['processOrThrow', 8],
      ],
      'B13: every reported line must equal its line in the submitted program',
    )

    // 判据 2：成对——数量相等、(member, line) 序列一致、callId 一一对应且互不相同。
    assert.equal(b13Ends.length, b13Starts.length, 'B13: every call-start must be closed by exactly one call-end')
    assert.deepEqual(
      b13Ends.map(event => [event.member, event.line]),
      b13Starts.map(event => [event.member, event.line]),
      'B13: call-end must report the same member and line as its call-start',
    )
    assert.deepEqual(
      b13Ends.map(event => event.callId),
      b13Starts.map(event => event.callId),
      'B13: call-end must close its own call-start (same callId), not just any open one',
    )
    assert.equal(
      new Set(b13Starts.map(event => event.callId)).size,
      b13Starts.length,
      'B13: call ids must be unique inside one run',
    )

    // 判据 4：失败路径也闭合，且分类是 error（`processOrThrow` 的非零退出码）。
    assert.deepEqual(
      b13Ends.map(event => event.outcome),
      ['ok', 'ok', 'ok', 'ok', 'ok', 'error'],
      'B13: only the failing processOrThrow may end as an error',
    )
    assert.match(String(b13Ends[5]?.error), /exited with code 3/)
    assert.equal(b13Ends[5]?.result, undefined, 'B13: a failed call must not carry a result')

    // 判据 3（预览面）：参数与结果都在事件里，且有界标记在场。
    assert.deepEqual(b13Starts.map(event => event.argsTruncated), [false, false, false, false, false, false])
    assert.match(String(b13Starts[0]?.args), /\[\["python","-c","print\(1\)"\]\]/)
    assert.match(String(b13Ends[0]?.result), /"code":0/)
    for (const event of b13Ends) assert.ok(event.ms >= 0, 'B13: every call-end must report a non-negative duration')

    // 判据 5：程序源码是提交的正文原文。
    const b13StartsOfRun = eventsOf(flowStart, b13.jobId) as FlowStartEvent[]
    assert.equal(b13StartsOfRun.length, 1, 'B13: the run must announce exactly one start')
    assert.equal(b13StartsOfRun[0]?.code, b13Program, 'B13: flow/start must carry the submitted program verbatim')
    process.stdout.write(
      `B13 primitive call lines, pairing and code on flow/start: OK (${String(b13Starts.length)} calls traced)\n`,
    )

    // 判据 7（阶段 5 修复，应修 A）：取消一个**正在 await process** 的程序。取消在 PTC 里是"先关
    // channel、再杀 guest"，在飞调用那条 `.then` 再也跑不到——那条 start 的 end 只能由宿主补发，
    // 否则阶段 6 的面板上会留下一条永远在转的调用。
    const b13PendingProgram = `
const r = await process(['python', '-c', 'import time; time.sleep(60)'])
return r.code
`
    const b13Pending = await startProgram(b13PendingProgram, traced.agent)
    await waitFor(() => eventsOf(callStart, b13Pending.jobId).length >= 1, 20_000, 'B13-cancel')
    const b13PendingCancel = await callCancelProgram(traced.agent)
    assert.equal(
      b13PendingCancel.isError,
      false,
      `B13: cancelling the pending program failed: ${textOf(b13PendingCancel)}`,
    )
    assert.equal((b13PendingCancel.value as { status?: string }).status, 'killed', 'B13: the pending program must be killed')
    await waitFor(
      () => eventsOf(callEnd, b13Pending.jobId).length >= 1 && eventsOf(flowEnd, b13Pending.jobId).length >= 1,
      20_000,
      'B13-cancel',
    )

    const pendingStarts = eventsOf(callStart, b13Pending.jobId) as FlowCallStartEvent[]
    const pendingEnds = eventsOf(callEnd, b13Pending.jobId) as FlowCallEndEvent[]
    assert.equal(pendingStarts.length, 1, 'B13: the cancelled program must have traced exactly one call')
    assert.equal(pendingEnds.length, 1, 'B13: the host must close the call the guest could not')
    assert.equal(
      pendingEnds[0]?.callId,
      pendingStarts[0]?.callId,
      'B13: the synthetic end must close that call (same callId), not just any open one',
    )
    assert.equal(pendingEnds[0]?.outcome, 'error', 'B13: a call the host had to close reports an error outcome')
    assert.equal(pendingEnds[0]?.synthetic, true, 'B13: the host-synthesized closure must say so')
    assert.match(
      String(pendingEnds[0]?.error),
      /the program ended before this call settled/,
      'B13: the synthetic end must explain why it exists',
    )
    // 面板要先看到所有调用闭合，再看到 run 结束：合成 end 必须发在 `flow/end` 之前。
    const pendingOrder = flowOrder.filter(entry => entry.runId === b13Pending.jobId).map(entry => entry.name)
    assert.ok(
      pendingOrder.indexOf('flow/call-end') < pendingOrder.indexOf('flow/end'),
      `B13: the synthetic end must arrive before flow/end, got ${JSON.stringify(pendingOrder)}`,
    )
    process.stdout.write('B13 cancel closes an in-flight call with a synthetic end: OK\n')

    // ---- B14b：面板状态与事件一致、since 增量、经路由取消 ------------------------
    // 一行一条，行号就是数组下标 + 1：轨迹里的 `line` 与 `flow/call-*` 逐条对照。
    const b14Program = [
      "await report('b14 first')",                                  // 1
      "const one = await process(['python', '-c', 'print(1)'])",     // 2
      'for (let index = 0; index < 2; index++) {',                   // 3
      "  await process(['python', '-c', 'print(2)'])",               // 4
      '}',                                                           // 5
      "await report('b14 second')",                                  // 6
      'return one.code',                                             // 7
    ].join('\n')
    const routed = await makeAgent('routed')
    const b14 = await startProgram(b14Program, routed.agent)
    const b14Output = await jobOutput(b14.jobId, routed.agent)
    assertProgramSucceeded(b14Output, 'B14')
    await waitFor(() => eventsOf(flowEnd, b14.jobId).length >= 1, 20_000, 'B14')

    const first = await panelState(routed.agent.id)
    assert.equal(first.run?.runId, b14.jobId)
    assert.equal(first.run?.code, b14Program, 'B14: the panel must show the submitted program verbatim')
    assert.equal(first.run?.lineCount, 7)
    assert.equal(first.run?.status, 'completed')
    assert.equal(first.run?.discarded, 0)
    assert.equal(first.reset, false)

    const panelCalls = first.entries.filter((entry): entry is FlowCallEntry => entry.kind === 'call')
    const panelReports = first.entries.filter((entry): entry is FlowReportEntry => entry.kind === 'report')
    const b14Starts = eventsOf(callStart, b14.jobId) as FlowCallStartEvent[]
    const b14Ends = eventsOf(callEnd, b14.jobId) as FlowCallEndEvent[]
    // 轨迹就是 `flow/call-*` 那一串：按 callId 成对、行号与耗时逐条相等、没有还开着的调用。
    assert.deepEqual(
      panelCalls.map(entry => [entry.member, entry.line]),
      b14Starts.map(event => [event.member, event.line]),
      'B14: every traced call must match its flow/call-start',
    )
    assert.deepEqual(panelCalls.map(entry => entry.callId), b14Starts.map(event => event.callId))
    assert.deepEqual(panelCalls.map(entry => entry.callId), b14Ends.map(event => event.callId))
    assert.deepEqual(panelCalls.map(entry => entry.state), b14Ends.map(event => event.outcome))
    assert.deepEqual(panelCalls.map(entry => entry.ms), b14Ends.map(event => event.ms))
    assert.equal(panelCalls.some(entry => entry.state === 'open'), false, 'B14: every call must be closed')
    // 条目按发生顺序，序号连续——增量拼接的前提。
    assert.deepEqual(first.entries.map(entry => entry.seq), first.entries.map((_, index) => index))
    // report 有序，且与 `flow/report` 同序。
    assert.deepEqual(panelReports.map(entry => entry.text), ['b14 first', 'b14 second'])
    assert.deepEqual(
      panelReports.map(entry => entry.text),
      (eventsOf(flowReport, b14.jobId) as { text: string }[]).map(event => event.text),
    )

    // since 的三种取值：等于最新（空增量）、中间（只回新增）、比最新还大（整份重来）。
    const caughtUp = await panelState(routed.agent.id, first.revision)
    assert.equal(caughtUp.reset, false)
    assert.deepEqual(caughtUp.entries, [])
    assert.equal(caughtUp.revision, first.revision)
    const partial = await panelState(routed.agent.id, 1)
    assert.equal(partial.reset, false)
    assert.deepEqual(partial.entries, first.entries.slice(1))
    const beyond = await panelState(routed.agent.id, first.revision + 5)
    assert.equal(beyond.reset, true)
    assert.deepEqual(beyond.entries, first.entries)

    // 经路由取消：与工具取消同一条路径。
    const b14LiveProgram = `
const r = await process(['python', '-c', 'import time; time.sleep(60)'])
return r.code
`
    const b14Live = await startProgram(b14LiveProgram, routed.agent)
    await waitFor(() => eventsOf(callStart, b14Live.jobId).length >= 1, 20_000, 'B14-cancel')
    const cancelResponse = await cancelPanel(routed.agent.id)
    assert.equal(
      cancelResponse.status,
      200,
      `cancelling through the route failed with ${String(cancelResponse.status)}`,
    )
    const cancelled = await cancelResponse.json() as { cancelled: boolean; jobId?: string; status?: string }
    assert.equal(cancelled.cancelled, true)
    assert.equal(cancelled.jobId, b14Live.jobId)
    assert.equal(cancelled.status, 'killed')
    // 与 B9 同一个判据形态：响应回来时 run 的临时目录已经删掉。
    assert.deepEqual(liveRunDirs(), [], 'B14: the route cancel must return after the run temporary directory is gone')
    await waitFor(() => eventsOf(flowEnd, b14Live.jobId).length >= 1, 20_000, 'B14-cancel-end')
    const killedState = await panelState(routed.agent.id)
    assert.equal(killedState.run?.runId, b14Live.jobId)
    assert.equal(killedState.run?.status, 'killed')
    assert.equal(killedState.run?.detail, 'cancelled by the initiating agent')
    // 幂等：没有在跑的程序时回 cancelled: false（design.md §4.4）。
    const idleCancel = await cancelPanel(routed.agent.id)
    assert.equal(idleCancel.status, 200)
    assert.deepEqual(await idleCancel.json(), { cancelled: false })
    process.stdout.write('B14b panel state matches flow/*, since deltas, and route cancel: OK\n')
  } else {
    // ---- B5：受限组合——工作目录外的写被策略拒绝，工作目录内的写成功 -----------
    // 两条用例在同一个程序、同一个 `process` 绑定、同一份策略下跑同一段 python 脚本，
    // 唯一变量是目标路径。只有两条结论互补，差异才能归给文件策略边界（判据见下方注释）。
    const workspaceRoot = policyService.resolve().workspaceRoot
    const policy = { mode: sandboxMode, workspaceRoot }

    /**
     * 当前后端自己的拒绝方言。判据不能写死一份跨后端并集：`ConfinedArgv.denialSignatures`
     * 的契约就是"本后端真的会产生的拒绝文本"（packages/sandbox/sandbox/src/index.ts:100-108）。
     * 程序看不到 `ConfinedArgv`，所以驱动向活的 provider 要一次；这段 argv 只用于取方言，
     * 从不 spawn。
     */
    const sandbox = ctx.get('sandbox')
    assert.ok(sandbox !== undefined, 'the fixture must mount the sandbox provider')
    let denialSignatures: readonly string[]
    try {
      denialSignatures = (await sandbox.confine(
        [process.execPath, '--version'],
        policy,
        new AbortController().signal,
      )).denialSignatures
    } catch (error: unknown) {
      throw new Error(`B5: this host has no usable sandbox backend, so the policy boundary cannot be observed: ${String(error)}`)
    }

    // 前提：受限组合下 `process` 能起外部程序。边界断言在"这条路根本走不通"时没有意义，
    // 这一条先把"受限组合跑不起来"和"边界没生效"分开。
    const preflight = await runToCompletion(`
const r = await process(['python', '-c', 'print("EE_OK")'])
return { code: r.code, out: r.stdout.trim(), stderr: r.stderr.slice(-200) }
`)
    assertProgramSucceeded(preflight, 'B5-pre')
    const pre = returned(preflight) as { code: number; out: string; stderr: string }
    assert.equal(pre.code, 0, `B5-pre: a confined process must run: ${pre.stderr}`)
    assert.equal(pre.out, 'EE_OK')
    process.stdout.write('B5-pre confined process runs an external program: OK\n')

    // 工作目录外的落点：家目录下，与工作目录、平台临时目录都不重叠（后两者在
    // workspace-write 下本来就是可写的，拿它们当"外面"没有区分力）。它必须由**宿主**
    // 建出来并能写：这条对照写正是"拒绝来自策略"与"路径本来就不能写"的分水岭——
    // 后端之间的拒绝文本会撞车（Landlock 的策略拒绝与普通 DAC 拒绝都是 Permission denied）。
    let outsideRoot: string
    try {
      outsideRoot = mkdtempSync(join(homedir(), 'ee-confined-b5-'))
    } catch (error: unknown) {
      throw new Error(
        'B5 needs a host-writable directory outside the workspace for its unconfined control write; '
        + `creating one under ${homedir()} failed: ${String(error)}. Run B5 where the driving process is `
        + 'not itself confined by another DSH file sandbox (then its writable roots are only that '
        + "sandbox's workspace and private temp area).",
      )
    }
    b5Paths.push(outsideRoot)
    const outsideTarget = join(outsideRoot, 'denied.txt')
    const controlTarget = join(outsideRoot, 'control.txt')
    writeFileSync(controlTarget, 'unconfined control write')
    assert.equal(readFileSync(controlTarget, 'utf8'), 'unconfined control write')

    const insideTarget = join(workspaceRoot, '.execution-engine', 'b5-inside.txt')
    b5Paths.push(insideTarget)
    assert.equal(
      isInside(workspaceRoot, outsideTarget),
      false,
      `B5: the outside target ${outsideTarget} is inside the workspace ${workspaceRoot} — the two cases must differ only by the boundary`,
    )
    assert.equal(
      isInside(workspaceRoot, insideTarget),
      true,
      `B5: ${insideTarget} must be inside the workspace ${workspaceRoot}`,
    )

    /**
     * 两条用例共用的脚本：同一个解释器、同一段代码，唯一变量是 argv[1]。
     * 三个退出码把"失败发生在哪一步"说清楚：3 = 父目录不在（不是策略拒绝），
     * 4 = 写本身抛了 OSError，0 = 写成功。
     *
     * `SystemExit` 不打印回溯，所以拒绝那一条的 stderr 里**只有脚本自己写的两行**。
     * 第二行是 `str(exc)` 原文——操作系统和解释器真正的拒绝文本就在这里，方言匹配
     * 认的就是它；只打异常类型名和 errno 会让方言无从匹配（这就是它原来的错）。
     */
    const python = [
      'import pathlib, sys',
      'target = pathlib.Path(sys.argv[1])',
      'print("EE_B5_ATTEMPT", flush=True)',
      'if not target.parent.is_dir():',
      '    print("EE_B5_NO_PARENT", str(target.parent), file=sys.stderr, flush=True)',
      '    raise SystemExit(3)',
      'try:',
      '    target.write_text("EE_B5")',
      'except OSError as exc:',
      '    print("EE_B5_DENIED", type(exc).__name__, "errno=" + repr(getattr(exc, "errno", None)), file=sys.stderr, flush=True)',
      '    print(str(exc), file=sys.stderr, flush=True)',
      '    raise SystemExit(4)',
      'print("EE_B5_WROTE", flush=True)',
    ].join('\n')

    const b5 = await runToCompletion(`
const python = ${JSON.stringify(python)}
const targets = ${JSON.stringify({ outside: outsideTarget, inside: insideTarget })}
async function attempt(path) {
  const result = await process(['python', '-c', python, path])
  return { code: result.code, timedOut: result.timedOut, stdout: result.stdout, stderr: result.stderr.slice(-800) }
}
return { outside: await attempt(targets.outside), inside: await attempt(targets.inside) }
`)
    assertProgramSucceeded(b5, 'B5')
    const attempts = returned(b5) as Record<'outside' | 'inside', {
      code: number
      timedOut: boolean
      stdout: string
      stderr: string
    }>
    const denied = attempts.outside
    const allowed = attempts.inside

    // 应当成功的一条：写工作目录内 `.execution-engine` 下的路径。它同时证明这条路
    // （python 起得来、argv 没被改写、策略没有把一切都拒掉）是通的。
    assert.equal(allowed.timedOut, false, 'B5: the in-workspace write timed out')
    assert.equal(allowed.code, 0, `B5: the in-workspace write must be allowed:\n${allowed.stderr}`)
    assert.ok(allowed.stdout.includes('EE_B5_WROTE'), `B5: the in-workspace script did not report its own write:\n${allowed.stdout}`)
    assert.equal(existsSync(insideTarget), true, 'B5: the allowed write did not land on disk')
    assert.equal(readFileSync(insideTarget, 'utf8'), 'EE_B5')

    // 应当被拒的一条。"被策略拒绝"= 解释器在我们的代码里走到了写这一句（stdout 有
    // EE_B5_ATTEMPT）、写自己抛了 OSError（exit 4，不是 3 的"父目录不在"，也不是被杀或
    // 启动失败）、而且抛出来的文本是本后端自己的拒绝方言。四条缺一，失败就可能来自别的原因
    // （runner 起不来、python 找不到、路径不存在），而它们都不会同时满足这四条。
    assert.equal(denied.timedOut, false, 'B5: the out-of-workspace write timed out instead of being denied')
    assert.ok(
      denied.stdout.includes('EE_B5_ATTEMPT'),
      `B5: the confined interpreter never reached the write, so this failure is not a policy denial:\n${denied.stderr}`,
    )
    assert.ok(!denied.stdout.includes('EE_B5_WROTE'), 'B5: the out-of-workspace write reported success')
    assert.equal(
      denied.code,
      4,
      `B5: the out-of-workspace write must fail inside the script's own OSError branch (exit 4); exit ${String(denied.code)} means something else failed first:\n${denied.stderr}`,
    )
    const matched = denialSignatures.filter(signature => denied.stderr.toLowerCase().includes(signature.toLowerCase()))
    assert.ok(
      matched.length > 0,
      `B5: the out-of-workspace failure does not speak this backend's denial dialect ${JSON.stringify(denialSignatures)}:\n${denied.stderr}`,
    )
    assert.equal(existsSync(outsideTarget), false, 'B5: the denied write landed on disk anyway')
    process.stdout.write(
      `B5 confined workspace-write boundary: OK (denial dialect ${JSON.stringify(matched)}; `
      + `unconfined control write to ${controlTarget} succeeded)\n`,
    )
  }
} finally {
  await ctx.fiber.dispose()
  rmSync(scratch, { recursive: true, force: true })
  for (const path of b5Paths.splice(0)) rmSync(path, { recursive: true, force: true })
}
process.stdout.write('LOADER_SMOKE_OK\n')
