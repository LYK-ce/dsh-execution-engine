import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { guestSource } from '../host/capabilities.ts'
import { PREVIEW_MAX_CHARS } from '../host/guest-source.ts'

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

/** 外壳经 `flow.trace` 发来的一条上报记录；字段与 `host/engine.ts` 的解析边界一致。 */
interface StubTrace {
  readonly phase: string
  readonly callId: number
  readonly member: string
  readonly line: number | null
  readonly args?: string
  readonly argsTruncated?: boolean
  readonly ms?: number
  readonly outcome?: string
  readonly text?: string
  readonly textTruncated?: boolean
}

/**
 * `flow.trace` 的转录桩。外壳按 fire-and-forget 调它（不等回执），所以这里同步记录、返回一个
 * 已兑现的 promise——真实链路里它是一条跨进程的绑定调用。
 */
function traceStub(): { namespace: Record<string, unknown>; records: StubTrace[] } {
  const records: StubTrace[] = []
  const namespace = Object.create(null) as Record<string, unknown>
  Object.defineProperty(namespace, 'trace', {
    enumerable: true,
    value: (args: unknown): Promise<null> => {
      records.push(args as StubTrace)
      return Promise.resolve(null)
    },
  })
  return { namespace, records }
}

/**
 * 拼出外壳拿到的那个绑定命名空间。真实链路上 PTC 每个 global 一个对象，本插件只声明 `flow`
 * 一个（`host/engine.ts` 的 `bindings`），所以这里把若干桩合成同一个对象。
 * @param parts - 待合成的命名空间，后面的同名成员覆盖前面的。
 * @returns 合成后的 `flow` 命名空间。
 */
function flowNamespace(...parts: readonly Record<string, unknown>[]): Record<string, unknown> {
  const merged = Object.create(null) as Record<string, unknown>
  for (const part of parts) {
    for (const name of Object.getOwnPropertyNames(part)) {
      Object.defineProperty(merged, name, { enumerable: true, value: part[name] })
    }
  }
  return merged
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

/**
 * `dispatchsubagent` 是阶段 2 加进来的洞：外壳把 `prompt` 字符串包成绑定参数转发出去，
 * 绑定拒绝时程序看到的是拒绝（与 `processOrThrow` 同形）并拿到错误消息。真实 provider
 * 由 loader 驱动（B6）覆盖；这里钉住的是"程序能调到它、参数与结果都过外壳"。
 */
test('dispatchsubagent 经外壳转发并原样交回结果', async () => {
  const { root, tmpDir } = await makeRoots()
  const calls: unknown[] = []
  const namespace = Object.create(null) as Record<string, unknown>
  Object.defineProperty(namespace, 'dispatchsubagent', {
    enumerable: true,
    value: (args: unknown): Promise<string> => {
      calls.push(args)
      const prompt = (args as { prompt: string }).prompt
      return prompt === 'boom'
        ? Promise.reject(new Error('child stopped with error'))
        : Promise.resolve(`child says: ${prompt}`)
    },
  })
  try {
    const value = await runGuest({
      tmpDir,
      cwd: root,
      flow: namespace,
      program: `
const ok = await dispatchsubagent('probe')
let failure = 'none'
try { await dispatchsubagent('boom') } catch (error) { failure = String(error && error.message) }
// 接口声明写的是 Promise：参数不合法也要走拒绝，而不是同步抛出。
let syncThrow = 'none'
try { dispatchsubagent(42).catch(() => {}) } catch (error) { syncThrow = 'threw' }
return { ok, failure, syncThrow }
`,
    })
    assert.deepEqual(asJson(value), {
      ok: 'child says: probe',
      failure: 'child stopped with error',
      syncThrow: 'none',
    })
    assert.deepEqual(calls, [{ prompt: 'probe' }, { prompt: 'boom' }])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

/**
 * `report` 是阶段 4 加进来的单向汇报通道：外壳把 `text` 包成绑定参数转发出去，绑定拒绝时程序看到
 * 拒绝，而**投递结果不回程序**（design.md §6.3：等投递成功，不等主 agent 处理完）。真实的投递与
 * 作废由 loader 驱动（B11/B12）覆盖；这里钉住的是"程序能调到它、参数过外壳、结果是 void"。
 */
test('report 经外壳转发，且不把结果交回程序', async () => {
  const { root, tmpDir } = await makeRoots()
  const calls: unknown[] = []
  const namespace = Object.create(null) as Record<string, unknown>
  Object.defineProperty(namespace, 'report', {
    enumerable: true,
    value: (args: unknown): Promise<null> => {
      calls.push(args)
      const text = (args as { text: string }).text
      return text === 'boom' ? Promise.reject(new Error('the run was cancelled')) : Promise.resolve(null)
    },
  })
  try {
    const value = await runGuest({
      tmpDir,
      cwd: root,
      flow: namespace,
      program: `
const returned = await report('one')
let failure = 'none'
try { await report('boom') } catch (error) { failure = String(error && error.message) }
// 接口声明写的是 Promise：参数不合法也要走拒绝，而不是同步抛出。
let syncThrow = 'none'
try { report(42).catch(() => {}) } catch (error) { syncThrow = 'threw' }
return { returnedIsUndefined: returned === undefined, failure, syncThrow }
`,
    })
    assert.deepEqual(asJson(value), {
      returnedIsUndefined: true,
      failure: 'the run was cancelled',
      syncThrow: 'none',
    })
    assert.deepEqual(calls, [{ text: 'one' }, { text: 'boom' }])
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
 *
 * 第三条是**跨行**类型注解的对照：`host/capabilities.ts` 的 `stripUserProgram` 声称擦除只删类型、
 * 行号与列号不变，而前两条程序里一条跨行注解都没有——只测"单行源码"证明不了这一条。
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
    // 跨行类型注解：擦除删掉的是类型，行结构一个都不许动（第 5 行是 throw 那一行）。
    await assert.rejects(
      runGuest({
        tmpDir,
        cwd: root,
        program: [
          'const config: {',
          '  readonly a: number',
          '  b: string',
          '} = { a: 1, b: "two" }',
          'throw new Error("after a multi-line annotation")',
        ].join('\n'),
      }),
      (error: unknown) => {
        assert.match(String((error as Error).stack), /flow-program\.ts:5/)
        return true
      },
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

/**
 * 阶段 5 的行号映射：包装层取到的是**用户源码**的行号，不是外壳自己的。
 *
 * 包装让栈里多出一层帧（`callSiteLine` → 包装函数 → 用户程序），但正则只认
 * `flow-program.ts`，所以第一个匹配到的一定是用户那一帧。行号在下面**写死**：每一条都对照
 * 它所在数组位置（1-based），弱断言（"大于 0"）证明不了偏移是对的。
 */
test('包装层上报调用点行号，行号等于用户源码行号', async () => {
  const { root, tmpDir } = await makeRoots()
  const trace = traceStub()
  const flow = flowNamespace(
    trace.namespace,
    stubFlow({ code: 0, stdout: '', stderr: '', timedOut: false }).namespace,
    {
      dispatchsubagent: (): Promise<string> => Promise.resolve('child'),
      report: (): Promise<null> => Promise.resolve(null),
    },
  )
  try {
    await runGuest({
      tmpDir,
      cwd: root,
      flow,
      program: [
        "const first = await process(['python', 'one'])",
        "const second = await processOrThrow(['python', 'two'])",
        "await dispatchsubagent('three')",
        "await report('four')",
        'for (let index = 0; index < 2; index++) {',
        "  await process(['python', 'loop'])",
        '}',
        'return first.code',
      ].join('\n'),
    })
    assert.deepEqual(
      trace.records.map(record => [record.phase, record.member, record.line]),
      [
        ['start', 'process', 1],
        ['end', 'process', 1],
        ['start', 'processOrThrow', 2],
        ['end', 'processOrThrow', 2],
        ['start', 'dispatchsubagent', 3],
        ['end', 'dispatchsubagent', 3],
        ['start', 'report', 4],
        ['end', 'report', 4],
        ['start', 'process', 6],
        ['end', 'process', 6],
        ['start', 'process', 6],
        ['end', 'process', 6],
      ],
      '循环里同一行重复出现是正常的：不去重，行号相同、序号不同',
    )
    // 序号按调用发生顺序由外壳发给宿主，start 与它配对的那条 end 同号。
    assert.deepEqual(trace.records.map(record => record.callId), [0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5])
    // 记录就是宿主那条解析边界（`host/engine.ts` 的 `readTraceRecord`）的输入面：字段多一个少一个都会
    // 在那边被拒，所以这里把两相的字段集逐一钉住。
    assert.deepEqual(Object.keys(trace.records[0] ?? {}).sort(), [
      'args', 'argsTruncated', 'callId', 'line', 'member', 'phase',
    ])
    assert.deepEqual(Object.keys(trace.records[1] ?? {}).sort(), [
      'callId', 'line', 'member', 'ms', 'outcome', 'phase', 'text', 'textTruncated',
    ])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

/**
 * 阶段 5 的隔离面：`trace` 是外壳与宿主之间的内部通道，**程序看不见它**。
 * 程序看得见的仍然只有四个原语 + `flow.tmpDir` + 文件助手 + `console` + `fetch`。
 */
test('trace 不在程序可见面上', async () => {
  const { root, tmpDir } = await makeRoots()
  const trace = traceStub()
  try {
    const value = await runGuest({
      tmpDir,
      cwd: root,
      flow: flowNamespace(trace.namespace, stubFlow({ code: 0, stdout: '', stderr: '', timedOut: false }).namespace),
      program: `
const injected = [
  'console', 'dispatchsubagent', 'exists', 'fetch', 'flow',
  'process', 'processOrThrow', 'readTextFile', 'report', 'writeTextFile',
]
return {
  flowKeys: Object.getOwnPropertyNames(flow).sort(),
  traceType: typeof globalThis.trace,
  hasTraceGlobal: Object.getOwnPropertyNames(globalThis).includes('trace'),
  missing: injected.filter(name => typeof globalThis[name] === 'undefined'),
}
`,
    })
    assert.deepEqual(asJson(value), {
      flowKeys: ['tmpDir'],
      traceType: 'undefined',
      hasTraceGlobal: false,
      missing: [],
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

/**
 * 预览有界且带 `truncated` 布尔：字符串截到 `PREVIEW_MAX_CHARS`，其余走 JSON、不可序列化回落成
 * 类型名。界在事件里是硬的——`process` 的 stdout 可能很大，靠调用方自觉不是上界。
 */
test('参数与结果的预览有界并带上截断布尔', async () => {
  const { root, tmpDir } = await makeRoots()
  const trace = traceStub()
  const flow = flowNamespace(
    trace.namespace,
    {
      process: (): Promise<unknown> => Promise.resolve({ code: 0, stdout: 'z'.repeat(PREVIEW_MAX_CHARS * 3), stderr: '', timedOut: false }),
      processOrThrow: (): Promise<unknown> => Promise.resolve({ stdout: '', stderr: '' }),
      dispatchsubagent: (): Promise<undefined> => Promise.resolve(undefined),
      report: (): Promise<null> => Promise.resolve(null),
    },
  )
  try {
    await runGuest({
      tmpDir,
      cwd: root,
      flow,
      program: [
        "await report('short')",
        `await report('y'.repeat(${String(PREVIEW_MAX_CHARS * 3)}))`,
        "await process(['python', 'big'])",
        "await dispatchsubagent('nothing')",
      ].join('\n'),
    })
    const starts = trace.records.filter(record => record.phase === 'start')
    const ends = trace.records.filter(record => record.phase === 'end')

    // 短参数不截断；长参数截到上界并如实报出来。
    assert.deepEqual(starts.map(record => [record.args, record.argsTruncated]), [
      ['["short"]', false],
      [`["${'y'.repeat(PREVIEW_MAX_CHARS - 2)}`, true],
      ['[["python","big"]]', false],
      ['["nothing"]', false],
    ])
    // 结果同理：`process` 的 stdout 很大，事件里只放得下上界那么多。
    assert.deepEqual(ends.map(record => record.outcome), ['ok', 'ok', 'ok', 'ok'])
    assert.equal(ends[2]?.textTruncated, true)
    assert.equal(ends[2]?.text?.length, PREVIEW_MAX_CHARS)
    assert.match(String(ends[2]?.text), /^\{"code":0,"stdout":"z+/)
    // 不可序列化（这里是 `undefined`）回落成类型名，而不是把事件卡死。
    assert.deepEqual([ends[3]?.text, ends[3]?.textTruncated], ['undefined', false])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

/**
 * 界施加在**序列化之前**：`JSON.stringify` 会先把整份结果物化出来，之后才轮得到切 200 个字符——
 * 一次 100MB 的 stdout 会先变成一整个 JSON 字符串，再被丢掉 99.99%。所以外壳先把值投影成有界的
 * 等价物（长字符串截断、超长数组收窄、超过深度回落成类型名），再序列化它。
 */
test('超大结构在序列化之前就被投影收窄', async () => {
  const { root, tmpDir } = await makeRoots()
  const trace = traceStub()
  const flow = flowNamespace(trace.namespace, {
    process: (args: unknown): Promise<unknown> => {
      const argv = (args as { argv: string[] }).argv
      return Promise.resolve(argv[1] === 'wide'
        ? { big: 'z'.repeat(PREVIEW_MAX_CHARS * 500), items: Array.from({ length: 500 }, (_, index) => index) }
        : { a: { b: { c: { d: { beyond: 'x' } } } } })
    },
  })
  try {
    await runGuest({
      tmpDir,
      cwd: root,
      flow,
      program: [
        "await process(['python', 'wide'])",
        "await process(['python', 'deep'])",
      ].join('\n'),
    })
    const ends = trace.records.filter(record => record.phase === 'end')
    // 宽的那一条：长字符串与 500 个元素的数组都被收窄，预览仍然满上界并如实报截断。
    assert.equal(ends[0]?.textTruncated, true)
    assert.equal(ends[0]?.text?.length, PREVIEW_MAX_CHARS)
    assert.match(String(ends[0]?.text), /^\{"big":"z+/)
    // 深的那一条：投影丢过东西就算截断，哪怕投影后的 JSON 短得能整个放下——`truncated` 说的是
    // "这不是原值"，不是"刚好占满 200 个字符"。
    assert.equal(ends[1]?.textTruncated, true)
    assert.match(String(ends[1]?.text), /"d":"object"/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

/**
 * 失败路径也必须闭合：不闭合的话面板上会留下一条永远在转的调用。错误文本同样有界。
 */
test('失败的原语调用也发 end，且带 outcome error', async () => {
  const { root, tmpDir } = await makeRoots()
  const trace = traceStub()
  const flow = flowNamespace(trace.namespace, {
    process: (): Promise<never> => Promise.reject(new Error('the run was cancelled')),
  })
  try {
    let thrown = 'none'
    try {
      await runGuest({
        tmpDir,
        cwd: root,
        flow,
        program: "const r = await process(['python', 'x'])\nreturn r",
      })
    } catch (error: unknown) {
      thrown = String((error as Error).message)
    }
    assert.equal(thrown, 'the run was cancelled')
    assert.deepEqual(trace.records.map(record => [record.phase, record.member, record.line, record.outcome, record.text]), [
      ['start', 'process', 1, undefined, undefined],
      ['end', 'process', 1, 'error', 'Error: the run was cancelled'],
    ])
    assert.equal(trace.records[1]?.textTruncated, false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

/**
 * 并发调用可以**乱序闭合**：同一行上的两次调用，后发的那次先返回。到达顺序因此不足以配对，
 * `callId` 才是判据（phase5-plan §4 的成对承诺，§9 的 R2）。
 *
 * 这条用例同时说明"宿主按到达顺序给 end 编号"为什么不行：两个 start 的 (member, line) 完全一样，
 * 按到达顺序配会把 first 的耗时与结果记到 second 头上。
 *
 * 乱序由 stub 自己持有的 deferred 表达：`second` 立刻兑现，并在**它自己的续延里**放行 `first`。
 * 那次续延先于外壳挂上的 `.then` 注册，所以 `second` 的 end 一定跑在 `first` 的前面——确定性来自
 * promise 的续延顺序，不来自墙钟（`setTimeout(25)` 只是把结论押在机器有多快上）。
 */
test('并发调用乱序闭合时仍按 callId 成对', async () => {
  const { root, tmpDir } = await makeRoots()
  const trace = traceStub()
  const resultOf = (name: string) => ({ code: 0, stdout: name, stderr: '', timedOut: false })
  let releaseFirst: (value: unknown) => void = () => {}
  const firstCall = new Promise<unknown>((resolve) => { releaseFirst = resolve })
  const flow = flowNamespace(trace.namespace, {
    process: (args: unknown): Promise<unknown> => {
      const argv = (args as { argv: string[] }).argv
      if (argv[1] === 'first') return firstCall
      const settled = Promise.resolve(resultOf('second'))
      // 这一条先于外壳注册它的续延，所以 end(second) 一定先于 end(first) 上报。
      void settled.then(() => { releaseFirst(resultOf('first')) })
      return settled
    },
  })
  try {
    await runGuest({
      tmpDir,
      cwd: root,
      flow,
      program: [
        "const [slow, fast] = [process(['python', 'first']), process(['python', 'second'])]",
        'await fast',
        'await slow',
        'return "both"',
      ].join('\n'),
    })
    assert.deepEqual(
      trace.records.map(record => [record.phase, record.callId, record.line]),
      [
        ['start', 0, 1],
        ['start', 1, 1],
        ['end', 1, 1],
        ['end', 0, 1],
      ],
      '乱序闭合是允许的：配对靠 callId，到达顺序表达不了它',
    )
    // 配对是有内容的：每条 end 带回的是它自己那次调用的结果。
    assert.equal(trace.records[2]?.text, '{"code":0,"stdout":"second","stderr":"","timedOut":false}')
    assert.equal(trace.records[3]?.text, '{"code":0,"stdout":"first","stderr":"","timedOut":false}')
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
