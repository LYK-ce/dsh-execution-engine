#!/usr/bin/env node
/**
 * 阶段 1 的真实组合验证：用 app-boot 的 boot() 起一份最小 Loader 组合，断言插件与两个工具
 * 已注册、模型可见 schema 存在、`.d.ts` 系统提示段进了装配结果，并真的跑几段程序。
 *
 * 分支由传入 fixture 解析出的沙箱模式决定（见 sandboxMode），不引入额外开关：
 *
 * 不受限组合（`tests/fixtures/cordis.yml`，danger-full-access）：
 * - B1 程序能跑、`process` 真的执行外部程序（`python -c 'print("EE_OK")'`）；
 * - B2 非零退出码正常返回、`processOrThrow` 抛出、超时生效且显著早于脚本自己的 30s；
 * - B3 超过 `maxTimeoutMs` 的请求在解析期被拒，且**没有启动任何进程**（哨兵文件不出现）；
 * - B4 超时后整个进程树被清干净（脚本 fork 出的子进程不会稍后写出哨兵文件）。
 *
 * 受限组合（`tests/fixtures/cordis-confined.yml`，workspace-write）：
 * - B5 `process` 起的外部进程过发起会话的文件策略：同一个程序里，写工作目录外的路径被
 *   拒绝、写工作目录内 `.execution-engine` 下的路径成功；两条用例互补，见块内注释。
 *
 * 用法（cwd = 仓库根，必须带 tsx，否则裸包名解析不到源码）：
 *   node --import tsx/esm Workspace/ExecutionEngine/tests/loader-driver.ts \
 *     Workspace/ExecutionEngine/tests/fixtures/cordis.yml              # B1–B4
 *   node --import tsx/esm Workspace/ExecutionEngine/tests/loader-driver.ts \
 *     Workspace/ExecutionEngine/tests/fixtures/cordis-confined.yml     # B5
 *
 * 成功判据：exit 0，stdout 末尾 `LOADER_SMOKE_OK`。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { boot, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
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
assert.deepEqual(plugin.inject, ['tools', 'ptcRuntime', 'subprocess', 'sandbox', 'systemPrompt'])
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

/**
 * 调一次 run_program，返回模型可见文本。程序自己失败不是工具失败：结果文本里带
 * `程序执行失败（` 小节，而工具结果本身仍是成功的。
 */
async function callRunProgram(code: string): Promise<string> {
  const result = await ctx.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId(`execution-engine-run-${String(++callSeq)}`),
    name: 'run_program',
    arguments: { code },
  })
  const text = result.content.filter(block => block.type === 'text').map(block => block.text).join('')
  if (result.isError) throw new Error(`run_program itself failed: ${text}`)
  const value = result.value as { output: string }
  // 渲染只有一处（host/engine.ts），模型看到的文本必须就是那个值。
  assert.equal(text, value.output, 'the rendered content must be the canonical output value')
  return value.output
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

/**
 * 传入 fixture 的已解析文件策略，也是本次分支的选择依据（见文件头）。
 * `sandboxPolicy` 不在 `inject` 里，所以用严格的 `ctx.get` 读全局服务（postmortem 0001）。
 */
const policyService = ctx.get('sandboxPolicy')
assert.ok(policyService !== undefined, 'the fixture must mount sandboxPolicy')
const sandboxMode = policyService.resolve().mode

try {
  assert.ok(
    ctx.tools.schemas().some(tool => tool.name === 'execution_engine_ping'),
    'execution_engine_ping is not registered',
  )
  const ping = await ctx.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId('execution-engine-skeleton'),
    name: 'execution_engine_ping',
    arguments: {},
  })
  assert.equal(ping.isError, false)
  const pingText = ping.content.filter(block => block.type === 'text').map(block => block.text).join('')
  assert.equal(pingText, 'ExecutionEngine skeleton is mounted: dsh-execution-engine phase 0.')

  assert.ok(
    ctx.tools.schemas().some(tool => tool.name === 'run_program'),
    'run_program is not registered',
  )

  // `.d.ts` 系统提示段：模型写程序时的唯一依据，必须在装配结果里。
  const assembly = await ctx.systemPrompt.assemble({})
  const sdk = assembly.sections.find(section => section.name === 'execution-engine-sdk')
  assert.ok(sdk !== undefined, 'the execution-engine-sdk prompt section is not registered')
  assert.equal(sdk.interpolate, false, 'the SDK text must not be interpolated')
  for (const declaration of ['declare function process(', 'declare function processOrThrow(', 'flow.tmpDir', 'declare const console']) {
    assert.ok(sdk.text.includes(declaration), `the SDK section must declare ${declaration}`)
  }

  if (sandboxMode === 'danger-full-access') {
    // ---- B1：程序能跑，process 真的执行外部程序 -------------------------------
    const b1 = await callRunProgram(`
const r = await process(['python', '-c', 'print("EE_OK")'])
return { ok: r.code === 0 && r.stdout.trim() === 'EE_OK', code: r.code, out: r.stdout.trim() }
`)
    assertProgramSucceeded(b1, 'B1')
    assert.deepEqual(returned(b1), { ok: true, code: 0, out: 'EE_OK' })
    process.stdout.write('B1 run_program + process: OK\n')

    // ---- B2：非零退出码正常返回、processOrThrow 抛出、超时生效 ----------------
    const b2a = await callRunProgram(`
const r = await process(['python', '-c', 'import sys; sys.exit(3)'])
return { code: r.code, timedOut: r.timedOut, stderr: r.stderr }
`)
    assertProgramSucceeded(b2a, 'B2a')
    assert.equal((returned(b2a) as { code: number }).code, 3, 'a non-zero exit code must be returned normally')

    const b2b = await callRunProgram(`
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
    const b2c = await callRunProgram(`
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
    const b3 = await callRunProgram(`
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
    const b4 = await callRunProgram(`
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
    const preflight = await callRunProgram(`
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

    const b5 = await callRunProgram(`
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
