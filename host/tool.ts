/**
 * 模型可见的两个工具：`run_program` 与 `cancel_program`（design.md §4.1、§4.4、§6.4）。
 * 工具本身是注册即效应，这里只产出定义（先例 packages/todo/tool-todo/src/index.ts:146）。
 *
 * 返回形态是阶段 3 的破坏性改动：`run_program` 不再交回程序结果，而是**立刻**交回 job id——
 * 程序在后台跑，不阻塞主 agent 的回合。
 * @module dsh-execution-engine/tool
 */

import type { JobId } from '@deepseek-ai/dsh-jobs'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { ProgramCancel } from './job-runner.ts'

/** `run_program` 的参数。 */
export interface RunProgramArgs {
  /** 要执行的程序源码（可擦除 TypeScript）。 */
  readonly code: string
}

/**
 * `run_program` 的实现签名：装配方负责解析本次调用的权威（cwd 与文件策略）、判空发起者，
 * 然后把执行提交成后台 job。**必须是同步的**——返回值就是 job id，工具要立刻返回。
 */
export type RunProgramExecute = (args: RunProgramArgs, exec: ToolRunContext) => JobId

/** `cancel_program` 的实现签名。 */
export type CancelProgramExecute = (exec: ToolRunContext) => Promise<ProgramCancel>

/**
 * 把一段程序交给执行引擎在后台跑，立刻返回 job id。
 *
 * 描述里写清楚三件事，它们都是设计里明确的模型可见契约：不阻塞回合（§4.1）、每个会话只有一个
 * （§4.2）、结束不通知（§6.5——主 agent 是旁观者，唯一的汇报通道是阶段 4 的 `report`）。
 * @param run - 由装配方提供的提交实现。
 * @returns 可注册进 `ctx.tools` 的定义。
 */
export function createRunProgramTool(run: RunProgramExecute): ToolDefinition {
  return defineTool({
    name: 'run_program',
    description:
      '把一段 TypeScript 程序交给执行引擎在后台运行，立刻返回它的 job id，不阻塞你当前的回合。'
      + '每个会话同时只能有一个程序在跑：已经有程序在跑时这次启动会被拒绝，错误里带着那个 job id。'
      + '程序跑完、失败或被取消都不会通知你；要让它停下来用 cancel_program。'
      + '程序在独立进程里运行，顶层 await 与 return 可用；return 的值不会回到你这里，程序里也没有 console。'
      + '用 process 执行外部程序，用 flow.tmpDir 读写中间文件，用 report 把进展发回发起会话。'
      + '所有外部执行都交给 process，超时与进程树清理由引擎负责。',
    parameters: {
      code: {
        type: 'string',
        required: true,
        description: '要执行的程序源码（可擦除 TypeScript）。可用 API 见系统提示中的执行引擎一节。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          jobId: { type: 'string', required: true },
          status: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `程序已在后台运行（${value.jobId}）。用 cancel_program 停止它。`,
      }],
    },
    async execute(args, exec) {
      return { jobId: run(args, exec), status: 'running' }
    },
  })
}

/**
 * 停止当前在跑的程序。
 *
 * 描述里的"返回时已经停下"不是修辞：`cancel_program` 等的就是 job 的 `done`，而 `done` 在临时
 * 目录删掉、外部进程与子 agent 静默之后才 resolve（design.md §4.4；实现见 `host/engine.ts` 的
 * `runProgram` 与 `host/job-runner.ts` 的 `cancel`）。
 * @param cancel - 由装配方提供的取消实现。
 * @returns 可注册进 `ctx.tools` 的定义。
 */
export function createCancelProgramTool(cancel: CancelProgramExecute): ToolDefinition {
  return defineTool({
    name: 'cancel_program',
    description:
      '停止你当前在跑的那个程序。返回时它、它起的外部进程与子 agent 都已经停下来，'
      + '本次 run 的临时目录也已经删除。没有程序在跑时也正常返回，不是错误。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          cancelled: { type: 'boolean', required: true },
          jobId: { type: 'string' },
          status: { type: 'string' },
          detail: { type: 'string' },
        },
      },
      render: (_args, value) => {
        if (!value.cancelled) return [{ type: 'text', text: '当前没有正在运行的程序。' }]
        const detail = value.detail === undefined ? '' : `：${value.detail}`
        return [{ type: 'text', text: `程序 ${String(value.jobId)} 已经停止（${String(value.status)}${detail}）。` }]
      },
    },
    execute(_args, exec) {
      return cancel(exec)
    },
  })
}
