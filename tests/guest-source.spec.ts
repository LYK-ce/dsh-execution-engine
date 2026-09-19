import assert from 'node:assert/strict'
import { stripTypeScriptTypes } from 'node:module'
import { test } from 'node:test'
import { guestSource, stripUserProgram } from '../host/capabilities.ts'
import { GUEST_SOURCE } from '../host/guest-source.ts'

/** 组装两个不同的程序，取用户程序字面量所在行之前有多少行。 */
function linesBeforeUserProgram(source: string): number {
  const marker = 'const __dshUserProgram = '
  const index = source.indexOf(marker)
  assert.ok(index >= 0, 'the assembled program must embed the user program')
  return source.slice(0, index).split('\n').length
}

/**
 * 用户源码以 JSON 字符串字面量嵌入：一个字都不动（不缩进、不插行、不格式化）。
 * 这是阶段 5 行号映射的前提（design.md §8.3 的"拼接时不得对用户源码做任何行变换"）。
 */
test('用户源码原样嵌入，行结构未变', () => {
  const program = 'const a = 1\n\n  const b = "x"\nreturn { a, b }'
  const source = guestSource({ program, tmpDir: '/tmp/run-1', cwd: '/tmp' })
  // 纯 JS 过一遍擦除器应当逐字节不变，所以嵌入的仍是程序本身。
  assert.equal(stripUserProgram(program), program)
  assert.ok(
    source.includes(`const __dshUserProgram = ${JSON.stringify(program)};`),
    'the user program must arrive as one JSON string literal',
  )
  assert.ok(!source.includes('\nconst a = 1'), 'the user program must not be inlined as source')
})

/** 类型注解被剥掉，但行数与每一行的内容位置不变。 */
test('剥类型只去掉类型，不动行结构', () => {
  const program = 'const value: number = 1\nconst text: string = "x"\nreturn { value, text }'
  const stripped = stripUserProgram(program)
  assert.equal(stripped.split('\n').length, program.split('\n').length)
  assert.match(stripped, /^const value\s+= 1$/m)
  assert.match(stripped, /^const text\s+= "x"$/m)
  assert.ok(!stripped.includes('number'))
  assert.ok(!stripped.includes('string'))
})

/** 非纯擦除语法在拼接阶段就被拒绝，不会走到执行。 */
test('非纯擦除语法在拼接阶段被拒', () => {
  assert.throws(() => stripUserProgram('enum E { A }'), /enum|erasable|not supported/i)
})

/** 行偏移是常量：换一段程序，用户字面量之前仍然是同样多的外壳行。 */
test('用户程序之前的行偏移与程序内容无关', () => {
  const first = guestSource({ program: 'return 1', tmpDir: '/tmp/run-1', cwd: '/tmp' })
  const second = guestSource({
    program: Array.from({ length: 40 }, (_unused, index) => `const v${String(index)} = ${String(index)}`).join('\n'),
    tmpDir: '/tmp/run-2',
    cwd: '/home/other',
  })
  assert.equal(linesBeforeUserProgram(first), linesBeforeUserProgram(second))
})

/** 固定外壳里没有用户程序；它就是外壳本身。 */
test('GUEST_SOURCE 是固定外壳，不含用户程序', () => {
  const program = 'const sentinel = "USER-PROGRAM-MARKER"'
  const source = guestSource({ program, tmpDir: '/tmp/run-1', cwd: '/tmp' })
  assert.ok(!GUEST_SOURCE.includes('USER-PROGRAM-MARKER'))
  assert.ok(source.startsWith(GUEST_SOURCE))
})

/**
 * 编译包装固定只加一行前缀，`lineOffset: -1` 抵掉它；两处一起决定"用户第 N 行上报为第 N 行"。
 * 行为断言在 tests/vm-surface.spec.ts。
 */
test('编译包装只加固定的一行前缀', () => {
  assert.ok(
    GUEST_SOURCE.includes('"(async () => {\\n" + userProgram + "\\n})()"'),
    'the driver must wrap the user program with exactly the fixed one-line prefix and suffix',
  )
  assert.ok(GUEST_SOURCE.includes('lineOffset: -1'), 'the wrapper line must be offset away')
  assert.ok(GUEST_SOURCE.includes('filename: "flow-program.ts"'))
})

/** 外壳以动态 import 取内建模块：PTC 的程序正文是 async 函数体，静态 import 不合法。 */
test('外壳用动态 import 取内建模块', () => {
  assert.ok(GUEST_SOURCE.includes('await import("node:vm")'))
  for (const source of ['node:fs/promises', 'node:path']) {
    assert.ok(GUEST_SOURCE.includes(`await import(${JSON.stringify(source)})`))
  }
  // 剥类型在宿主完成，外壳里不该再出现擦除器。
  assert.ok(!GUEST_SOURCE.includes('stripTypeScriptTypes'))
  assert.ok(!/^\s*import\s/m.test(GUEST_SOURCE), 'the shell must not contain a static import declaration')
})

/**
 * 真实链路上 PTC 宿主还会给整段程序正文套一层 async 函数再擦除一次类型
 * （`packages/ptc-runtime/ptc-runtime-node/src/index.ts:45,206`）。外壳与已剥类型的用户程序
 * 都必须能过那一关——过不了整个 B1 就跑不起来。
 */
test('组装后的正文能过 PTC 宿主的擦除器', () => {
  const program = 'const r: { code: number } = { code: 0 }\nreturn r.code'
  const source = guestSource({ program, tmpDir: '/tmp/run-1', cwd: '/tmp' })
  const stripped = stripTypeScriptTypes(`async function __dsh_program__() {\n${source}\n}`)
  assert.ok(stripped.includes('const __dshUserProgram ='), 'the shell must survive the PTC strip step')
  assert.ok(stripped.includes('return await __dshRunProgram(flow,'), 'the entry call must survive the strip step')
})
