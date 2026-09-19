import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { guestSource } from '../host/capabilities.ts'

/**
 * PTC 引导用的同一个 async 函数构造器；外壳正文就是它的 body，形参名必须与
 * PTC 的绑定命名空间（`flow`）和它注入的 `console` 一致。
 */
const AsyncFunction = (async () => {}).constructor as new (...args: string[]) => (...fnArgs: unknown[]) => Promise<unknown>

/** 一次 stub 绑定调用收到的参数。 */
interface StubCall {
  readonly argv: string[]
  readonly timeoutMs?: number
}

/**
 * 记录所有绑定调用的 stub，返回固定的程序结果。
 *
 * 形状照 PTC 的 `makeNamespaces`：null 原型对象加 `defineProperty` 定义的成员
 * （`packages/ptc-runtime/ptc-runtime-node/src/bootstrap.ts:313-356`），这样外壳访问绑定命名空间
 * 的方式与真实链路一致。
 */
function stubFlow(result: { code: number; stdout: string; stderr: string; timedOut: boolean }): {
  namespace: Record<string, unknown>
  calls: StubCall[]
} {
  const calls: StubCall[] = []
  const namespace = Object.create(null) as Record<string, unknown>
  for (const name of ['process', 'processOrThrow']) {
    Object.defineProperty(namespace, name, {
      enumerable: true,
      value: (args: unknown): Promise<unknown> => {
        calls.push(args as StubCall)
        return Promise.resolve(result)
      },
    })
  }
  return { namespace, calls }
}

/** 在测试进程里按 PTC 的方式跑一次外壳 + 用户程序。 */
async function runGuest(options: {
  program: string
  tmpDir: string
  cwd: string
  flow?: Record<string, unknown>
  logs?: string[]
}): Promise<unknown> {
  const logs = options.logs ?? []
  const consoleShim = {
    log: (...args: unknown[]) => { logs.push(args.map(String).join(' ')) },
    info: (...args: unknown[]) => { logs.push(args.map(String).join(' ')) },
    warn: (...args: unknown[]) => { logs.push(args.map(String).join(' ')) },
    error: (...args: unknown[]) => { logs.push(args.map(String).join(' ')) },
    debug: (...args: unknown[]) => { logs.push(args.map(String).join(' ')) },
  }
  const fn = new AsyncFunction('flow', 'console', guestSource({
    program: options.program,
    tmpDir: options.tmpDir,
    cwd: options.cwd,
  }))
  return await fn(options.flow ?? {}, consoleShim)
}

/** 建一个 run 落点：`tmpDir` 是 run 专属目录，`cwd` 是会话目录。 */
async function makeRoots(): Promise<{ root: string; tmpDir: string }> {
  const root = await mkdtemp(join(tmpdir(), 'ee-vm-surface-'))
  const tmpDir = join(root, 'run')
  await mkdir(tmpDir)
  return { root, tmpDir }
}

/**
 * 把 vm realm 的完成值搬回本 realm 的普通 JSON。
 *
 * vm 里造出来的对象与数组带着那个 realm 的原型，`deepStrictEqual` 会因为原型不同而失败。
 * 真实链路上这一步由 PTC 的 `snapshotPtcJsonValue` 承担（它显式接受跨 realm 的普通对象与数组），
 * 这里用 JSON 往返做同一件事，顺带证明完成值确实是 lossless JSON。
 */
function asJson(value: unknown): unknown {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

/**
 * §3.2 的扣留边界：外壳注入的能力面可用，而 Node 的运行时全局在程序里不可达。
 * 探针走真实外壳（`guestSource` + vm 求值）：自建一个 `vm.createContext` 只会证明 Node
 * 自己的行为，删掉本插件它照样过。
 */
test('外壳注入原语，Node 全局仍不可达', async () => {
  const { root, tmpDir } = await makeRoots()
  const logs: string[] = []
  const flow = stubFlow({ code: 3, stdout: 'out\n', stderr: 'err\n', timedOut: false })
  try {
    const value = await runGuest({
      tmpDir,
      cwd: root,
      flow: flow.namespace,
      logs,
      program: `
console.log('hello', 1)
const r = await process(['python', '-c', 'print("x")'], { timeoutMs: 1500 })
const t = await processOrThrow(['python', '-c', 'pass'])
return {
  code: r.code,
  stdout: r.stdout.trim(),
  stderr: r.stderr.trim(),
  timedOut: r.timedOut,
  throwKeepsCode: t.code,
  tmpDir: flow.tmpDir === ${JSON.stringify(tmpDir)},
  injectedProcessIsNode: typeof globalThis.process.getBuiltinModule,
  injectedProcessArgv: typeof globalThis.process.argv,
  requireType: typeof require,
  moduleType: typeof module,
  dynamicImport: await import('node:child_process').then(() => 'reachable', (error) => error.constructor.name),
  jsonUsable: typeof JSON.parse('{"ok":true}') === 'object',
  mathUsable: Math.max(1, 2),
  consoleIsShim: typeof console.log,
}
`,
    }) as Record<string, unknown>

    assert.deepEqual(flow.calls, [
      { argv: ['python', '-c', 'print("x")'], timeoutMs: 1_500 },
      { argv: ['python', '-c', 'pass'] },
    ])
    assert.deepEqual(logs, ['hello 1'])
    assert.deepEqual(asJson(value), {
      code: 3,
      stdout: 'out',
      stderr: 'err',
      timedOut: false,
      throwKeepsCode: 3,
      tmpDir: true,
      injectedProcessIsNode: 'undefined',
      injectedProcessArgv: 'undefined',
      requireType: 'undefined',
      moduleType: 'undefined',
      dynamicImport: 'TypeError',
      jsonUsable: true,
      mathUsable: 2,
      consoleIsShim: 'function',
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

/** 原语的参数校验发生在 vm 与绑定之间：坏 argv 不会变成一次绑定调用，且一律以拒绝表达。 */
test('原语拒绝坏参数且不发出绑定调用', async () => {
  const { root, tmpDir } = await makeRoots()
  const flow = stubFlow({ code: 0, stdout: '', stderr: '', timedOut: false })
  try {
    const value = await runGuest({
      tmpDir,
      cwd: root,
      flow: flow.namespace,
      program: `
const failures = []
for (const call of [
  () => process([]),
  () => process([1]),
  () => process(['python'], { timeoutMs: 0 }),
  () => process(['python'], { timeoutMs: 1.5 }),
  () => processOrThrow([]),
]) {
  try { await call(); failures.push('resolved') } catch (error) { failures.push(error.constructor.name) }
}
// 报错带真实 member 名：processOrThrow 的参数错误不该自称 process。
let label = 'none'
try { await processOrThrow([]) } catch (error) { label = String(error && error.message) }
// 接口声明写的是 Promise：参数不合法也要走拒绝，而不是同步抛出。
let syncThrow = 'none'
try {
  process([]).catch(() => {})
} catch (error) {
  syncThrow = 'threw'
}
return { failures, label, syncThrow }
`,
    })
    assert.deepEqual(asJson(value), {
      failures: ['TypeError', 'TypeError', 'TypeError', 'TypeError', 'TypeError'],
      label: 'processOrThrow requires a non-empty argv array',
      syncThrow: 'none',
    })
    assert.deepEqual(flow.calls, [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

/** 文件助手限定在 run 临时目录与会话目录内；越界读写被拒，而根内以 `..` 开头的文件名不误判。 */
test('文件助手限定在 run 临时目录与会话目录内', async () => {
  const { root, tmpDir } = await makeRoots()
  try {
    const value = await runGuest({
      tmpDir,
      cwd: root,
      program: `
await writeTextFile(flow.tmpDir + '/a.txt', 'hello')
const text = await readTextFile(flow.tmpDir + '/a.txt')
const present = await exists(flow.tmpDir + '/a.txt')
const missing = await exists(flow.tmpDir + '/nope.txt')
// "..foo" 是根内的合法文件名，不是"上一级目录"。
await writeTextFile(flow.tmpDir + '/..foo', 'kept')
const dotted = await readTextFile(flow.tmpDir + '/..foo')
let escaped = 'allowed'
try { await readTextFile('../../../etc/passwd') } catch (error) { escaped = 'blocked' }
let wroteOutside = 'allowed'
try { await writeTextFile('../outside.txt', 'x') } catch (error) { wroteOutside = 'blocked' }
let climbed = 'allowed'
try { await readTextFile('..') } catch (error) { climbed = 'blocked' }
return { text, present, missing, dotted, escaped, wroteOutside, climbed }
`,
    })
    assert.deepEqual(asJson(value), {
      text: 'hello',
      present: true,
      missing: false,
      dotted: 'kept',
      escaped: 'blocked',
      wroteOutside: 'blocked',
      climbed: 'blocked',
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

/**
 * 行号映射（阶段 5 的地基）：用户源码第 N 行在 vm 里就是第 N 行。
 * 外壳给编译包装固定加了一行前缀，`lineOffset: -1` 把它抵掉。
 */
test('用户程序的行号在拼接后不变', async () => {
  const { root, tmpDir } = await makeRoots()
  try {
    await assert.rejects(
      runGuest({ tmpDir, cwd: root, program: ['const a = 1', 'const b = 2', 'throw new Error("boom")'].join('\n') }),
      (error: unknown) => {
        assert.match(String((error as Error).stack), /flow-program\.ts:3/)
        return true
      },
    )
    await assert.rejects(
      runGuest({ tmpDir, cwd: root, program: 'throw new Error("first line")' }),
      (error: unknown) => {
        assert.match(String((error as Error).stack), /flow-program\.ts:1/)
        return true
      },
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

/** 可擦除 TypeScript：类型在 vm 里被剥掉；非纯擦除语法被拒。 */
test('类型被剥掉，非纯擦除语法被拒', async () => {
  const { root, tmpDir } = await makeRoots()
  try {
    const value = await runGuest({
      tmpDir,
      cwd: root,
      program: `
interface Point { readonly x: number }
const point: Point = { x: 2 }
const scale = (value: number): number => value * 3
return { scaled: scale(point.x) }
`,
    })
    assert.deepEqual(asJson(value), { scaled: 6 })

    await assert.rejects(
      runGuest({ tmpDir, cwd: root, program: 'enum E { A }\nreturn E.A' }),
      (error: unknown) => {
        // Node 的擦除器直接报错；这里只钉住"被拒绝"。
        assert.match(String(error), /enum|erasable|not supported/i)
        return true
      },
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

/** 完成值按 lossless JSON 交回；程序没有 return 时就是 undefined。 */
test('完成值原样交回', async () => {
  const { root, tmpDir } = await makeRoots()
  try {
    assert.deepEqual(
      asJson(await runGuest({ tmpDir, cwd: root, program: 'return { list: [1, "two", null], nested: { ok: true } }' })),
      { list: [1, 'two', null], nested: { ok: true } },
    )
    assert.equal(await runGuest({ tmpDir, cwd: root, program: 'const unused = 1' }), undefined)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
