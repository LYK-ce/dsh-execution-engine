/**
 * 给主 agent 的接口文档（design.md §11；phase1-plan §9）。
 *
 * 这份文本进系统提示，就是主 agent 写程序时唯一的 API 依据。它按阶段列出能力面增删：
 * 这里只描述已经存在的原语——`dispatchsubagent` 属于阶段 2，`report` 属于阶段 4。
 * 阶段 3 改了工具的时序：程序在后台跑，结果不回主 agent（design.md §4.1、§6.5）。
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

\`run_program\` 把一段 TypeScript 程序交给执行引擎，**立刻返回一个 job id**：程序在后台跑，
不阻塞你当前的回合。每个会话同时只能有一个程序在跑；已经有程序在跑时这次启动会被拒绝，
错误里带着那个 job id，要先 \`cancel_program\`。

**程序的结果不会回到你这里**：它跑完、失败或被取消都不会通知你。你在本回合能做的是启动与取消。
所以程序要写成一个能自己跑完的整体：不确定的步骤派子 agent，确定的步骤跑外部程序——
写完之后执行是机械的。

程序唯一的回报通道是它自己调的 \`report\`：每条 report 作为一条独立消息唤醒你，**按程序的调用顺序
到达**，不会和其他消息挤在一起。报什么、报几次由程序决定——攒到阶段边界再报是你的程序该有的纪律。

\`cancel_program\` 在**清理真正完成之后**才返回：进程、子 agent 与临时目录都已经收干净。
程序里**没有 \`await\` 的外部程序也算在清理范围内**，所以取消可能要等到它结束——
这段时间受那一次 \`process\` 自己的超时约束。

程序是**可擦除 TypeScript**：类型只是装饰，运行时被剥掉，没有编译期检查。
\`enum\`、带运行时语义的 \`namespace\`、构造器参数属性一类需要生成代码的写法会被拒绝，报错会说明怎么改。

程序在独立进程里运行，顶层 \`await\` 与 \`return\` 可用。程序里可用的 API：

\`\`\`ts
/** 本次 run 的上下文。 */
declare const flow: {
  /** 本次 run 专属的临时目录；引擎创建，run 结束时整体删除。 */
  readonly tmpDir: string
}

/**
 * 派一个子 agent 执行一段工作，返回它的最终文本。prompt 是程序里的字面量。
 * 正常完成但没有文本块时是空串——那是"子 agent 没产出文本"，不是"答案被丢了"。
 */
declare function dispatchsubagent(prompt: string): Promise<string>

/** 执行一个外部程序。非零退出码与超时都正常返回，由程序自己判断。 */
declare function process(argv: string[], opts?: ProcessOptions): Promise<ProcessResult>

/** 同 process，但非零退出码或超时抛出。用于表达"这一步必须成功"。 */
declare function processOrThrow(argv: string[], opts?: ProcessOptions): Promise<ProcessOutput>

/**
 * 向发起你的会话单向汇报一段内容。它成为那边独立的一轮，按你调用的顺序到达。
 * await 只等投递成功，不等它处理完；程序被取消时已经投出去但还没被读到的汇报会作废。
 */
declare function report(text: string): Promise<void>

/** 读一个文本文件。路径应当落在 flow.tmpDir 或本次 run 的工作目录内——这是给程序的引导，不是安全边界。 */
declare function readTextFile(path: string): Promise<string>

/** 写一个文本文件。路径应当落在 flow.tmpDir 或本次 run 的工作目录内——这是给程序的引导，不是安全边界。 */
declare function writeTextFile(path: string, text: string): Promise<void>

/** 路径是否存在。路径应当落在 flow.tmpDir 或本次 run 的工作目录内——这是给程序的引导，不是安全边界。 */
declare function exists(path: string): Promise<boolean>

/** 标准 fetch。 */
declare function fetch(input: string, init?: object): Promise<Response>

/** 程序自己的输出；它随这次 run 的结果一起被记录。 */
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

\`dispatchsubagent\` 的失败也是异常：子 agent 没有正常完成时它抛出，消息里带结束的类别
（\`error\` / \`refusal\` / \`max-tokens\` 一类），以及 provider 写的诊断与结束前已产生的部分输出。
要用它的返回值就必须自己 \`try/catch\`——静默拿到一段可能是错误描述的文字，会让失败伪装成成功。
`
}
