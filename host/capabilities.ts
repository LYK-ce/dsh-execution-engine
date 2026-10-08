/**
 * 用户程序与外壳的拼接（phase1-plan §3.3 方案乙 / §3.4）。
 *
 * 用户源码以 **JSON 字符串字面量**嵌入，而不是直接拼进外壳源码：这样它一行都不被动过
 * （不缩进、不插行、不格式化），运行时才由驱动拼成 `"(async () => {\n" + 程序 + "\n})()"`。
 * 拼接后的行偏移是常量——阶段 5 的行号映射依赖这一条。
 *
 * 剥类型在**宿主**完成，不在 guest：PTC 宿主只擦除整段程序正文，而用户程序是以字面量嵌进去的，
 * 擦除得自己做；放在宿主还让非纯擦除语法在启动任何进程之前就报错，且不会把 Node 的
 * "stripTypeScriptTypes is experimental" 警告写进程序自己的输出。
 * @module dsh-execution-engine/capabilities
 */

import { stripTypeScriptTypes } from 'node:module'
import { GUEST_SOURCE } from './guest-source.ts'

/** vm 内编译用户程序时使用的虚拟文件名；栈里的行号以它为准。 */
export const GUEST_PROGRAM_FILENAME = 'flow-program.ts'

/**
 * 剥类型前给用户程序套的包装，取自 PTC 宿主自己的做法
 * （`packages/ptc-runtime/ptc-runtime-node/src/index.ts:45,206`）。两个常量各含一个换行，
 * 按长度切回来即可，行号一字不动。
 */
const STRIP_PREFIX = 'async function __dsh_flow_program__() {\n'
const STRIP_SUFFIX = '\n}'

/** 组装一次 run 的程序正文所需的三个常量。 */
export interface GuestProgramRequest {
  /** 用户写的程序源码；行结构原样保留。 */
  readonly program: string
  /** 本次 run 的专属临时目录；程序中以 `flow.tmpDir` 可见。 */
  readonly tmpDir: string
  /** 本次 run 的工作目录；文件助手的包含边界之一。 */
  readonly cwd: string
}

/**
 * 把用户程序剥成纯 JS，行结构不变。
 *
 * 程序允许顶层 `return`，所以必须先套进一个 async 函数体再交给擦除器——擦除器按整份源码解析，
 * 裸的顶层 `return` 会被判成语法错误。`mode: "strip"` 让 `enum` 一类非纯擦除语法直接报错，
 * 报错信息说明如何改（design.md §7.1）。
 * @param program - 用户写的可擦除 TypeScript。
 * @returns 类型被剥掉的等价 JS，行号与列号不变。
 * @throws 程序含非纯擦除语法时。
 */
export function stripUserProgram(program: string): string {
  const stripped = stripTypeScriptTypes(STRIP_PREFIX + program + STRIP_SUFFIX, { mode: 'strip' })
  return stripped.slice(STRIP_PREFIX.length, stripped.length - STRIP_SUFFIX.length)
}

/**
 * 把固定外壳、run 常量与用户程序拼成交给 `ctx.ptcRuntime` 的程序正文。
 *
 * 正文末尾引用 PTC 绑定命名空间 `flow`（见 `engine.ts` 的 `bindings`）。PTC 的 async 函数构造器
 * 还注入 `console` 与错误类，但它们**不进程序的能力面**：程序侧没有 console（`host/guest-source.ts`）。
 * @param request - 用户程序与本次 run 的两个常量。
 * @returns 完整的程序正文。
 */
export function guestSource(request: GuestProgramRequest): string {
  return [
    GUEST_SOURCE,
    `const __dshTmpDir = ${JSON.stringify(request.tmpDir)};`,
    `const __dshCwd = ${JSON.stringify(request.cwd)};`,
    `const __dshUserProgram = ${JSON.stringify(stripUserProgram(request.program))};`,
    'return await __dshRunProgram(flow, __dshUserProgram, { tmpDir: __dshTmpDir, cwd: __dshCwd });',
    '',
  ].join('\n')
}
