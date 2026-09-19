/**
 * 给主 agent 的接口文档（design.md §11；phase1-plan §9）。
 *
 * 这份文本进系统提示，就是主 agent 写程序时唯一的 API 依据。它按 phase1-plan §3.3
 * 方案乙列出的能力面增删：只描述本阶段已经存在的原语——`dispatchsubagent` 与 `report`
 * 属于阶段 2 / 阶段 4，这里不出现。
 *
 * 超时那两个数是部署可配的（design.md §9），所以正文由**已解析的**策略生成：写死数字
 * 会让部署改了 Config 之后，模型看到的是一份假文档。
 * @module dsh-execution-engine/sdk
 */

import type { ProcessTimeouts } from './config.ts'

/** 系统提示里这一段的固定名字；同名重复注册会抛。 */
export const SDK_SECTION_NAME = 'execution-engine-sdk'

/**
 * 生成进系统提示的 `.d.ts` 正文。
 * @param timeouts - 部署已解析的 `process` 超时策略。
 * @returns 描述程序可见 API 的声明文本。
 */
export function sdkText(timeouts: ProcessTimeouts): string {
  return `## run_program

\`run_program\` 执行一段 TypeScript 程序。程序跑在一个独立进程里：顶层 \`await\` 与 \`return\` 可用，
\`return\` 的值会作为结果交回。程序里不确定的步骤派子 agent，确定的步骤跑外部程序——
写完之后执行是机械的。

程序是**可擦除 TypeScript**：类型只是装饰，运行时被剥掉，没有编译期检查。
\`enum\`、带运行时语义的 \`namespace\`、构造器参数属性一类需要生成代码的写法会被拒绝，报错会说明怎么改。

程序里可用的 API：

\`\`\`ts
/** 本次 run 的上下文。 */
declare const flow: {
  /** 本次 run 专属的临时目录；引擎创建，run 结束时整体删除。 */
  readonly tmpDir: string
}

/** 执行一个外部程序。非零退出码与超时都正常返回，由程序自己判断。 */
declare function process(argv: string[], opts?: ProcessOptions): Promise<ProcessResult>

/** 同 process，但非零退出码或超时抛出。用于表达"这一步必须成功"。 */
declare function processOrThrow(argv: string[], opts?: ProcessOptions): Promise<ProcessOutput>

/** 读一个文本文件。路径应当落在 flow.tmpDir 或本次 run 的工作目录内——这是给程序的引导，不是安全边界。 */
declare function readTextFile(path: string): Promise<string>

/** 写一个文本文件。路径应当落在 flow.tmpDir 或本次 run 的工作目录内——这是给程序的引导，不是安全边界。 */
declare function writeTextFile(path: string, text: string): Promise<void>

/** 路径是否存在。路径应当落在 flow.tmpDir 或本次 run 的工作目录内——这是给程序的引导，不是安全边界。 */
declare function exists(path: string): Promise<boolean>

/** 标准 fetch。 */
declare function fetch(input: string, init?: object): Promise<Response>

/** 程序自己的输出；这些内容会随结果一起交回。 */
declare const console: {
  log(...args: unknown[]): void
  info(...args: unknown[]): void
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
  debug(...args: unknown[]): void
}

interface ProcessOptions {
  /** 本次执行的超时（毫秒）。默认 ${String(timeouts.defaultTimeoutMs)}，上限 ${String(timeouts.maxTimeoutMs)}；超上限在执行前被拒绝。 */
  timeoutMs?: number
}

interface ProcessResult {
  /** 退出码；进程被信号杀死（例如超时）时为 -1。 */
  code: number
  /** 诊断用标准输出；不承载业务返回值。 */
  stdout: string
  /** 诊断用标准错误。 */
  stderr: string
  /** 本次执行是否撞上了超时。 */
  timedOut: boolean
}

interface ProcessOutput {
  stdout: string
  stderr: string
}
\`\`\`

取值约定：跨进程没有 \`return\`，\`stdout\` / \`stderr\` 只用于诊断。值确实在外部脚本里时，
让脚本写文件、程序读文件：

\`\`\`ts
await processOrThrow(['python', 'add.py', '1', '2'])   // 非零就抛，不会往下走
const sum = Number(await readTextFile(flow.tmpDir + '/result.txt'))   // 到这一行，脚本一定成功
\`\`\`

先用 \`processOrThrow\` 确认成功再读文件，否则会读到不存在的或写了一半的文件。
`
}
