/**
 * 模型可见的工具：阶段 0 的占位工具与阶段 1 的 `run_program`。
 * 工具本身是注册即效应，这里只产出定义（先例 packages/todo/tool-todo/src/index.ts:146）。
 * @module dsh-execution-engine/tool
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { RunProgramOutcome } from './engine.ts'

/** 占位工具的固定返回，测试与驱动按字面比对。 */
const PLUGIN_ID = 'dsh-execution-engine'

/** `run_program` 的参数。 */
export interface RunProgramArgs {
  /** 要执行的程序源码（可擦除 TypeScript）。 */
  readonly code: string
}

/** `run_program` 的实现签名：装配方（index.ts）负责解析本次调用的工作目录与文件策略。 */
export type RunProgramExecute = (args: RunProgramArgs, exec: ToolRunContext) => Promise<RunProgramOutcome>

/**
 * 阶段 0 的占位工具：证明插件挂上了、工具注册进 ctx.tools 了、模型能看到它。
 * 它不做任何工作，阶段 3 的 run_program 落地的同一次改动里删掉它。
 * @returns 可注册进 `ctx.tools` 的定义。
 */
export function createSkeletonTool(): ToolDefinition {
  return defineTool({
    name: 'execution_engine_ping',
    description:
      'Diagnostic placeholder for the ExecutionEngine plugin skeleton. '
      + 'It performs no work and exists only to confirm the plugin is mounted; do not call it.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          plugin: { type: 'string', required: true },
          phase: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `ExecutionEngine skeleton is mounted: ${value.plugin} phase ${String(value.phase)}.`,
      }],
    },
    execute() {
      return Promise.resolve({ plugin: PLUGIN_ID, phase: 0 })
    },
  })
}

/**
 * 执行一段程序并返回它的结果。
 *
 * 失败同样正常返回：程序跑了一半失败、超时、被取消，都在结果文本里说清楚是什么、
 * 为什么。传输层的契约误用（例如执行缝被卸载）才抛成工具失败。
 * @param run - 由装配方提供的执行实现。
 * @returns 可注册进 `ctx.tools` 的定义。
 */
export function createRunProgramTool(run: RunProgramExecute): ToolDefinition {
  return defineTool({
    name: 'run_program',
    description:
      '执行一段 TypeScript 程序并返回它的结果。程序在独立进程里运行，顶层 await 与 return 可用；'
      + '用 process 执行外部程序，用 flow.tmpDir 读写中间文件，用 console 输出诊断文本。'
      + '所有外部执行都交给 process，超时与进程树清理由引擎负责。'
      + '程序失败不是工具失败：失败原因会同结果文本一起返回。',
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
          output: { type: 'string', required: true },
        },
      },
      // 失败是结果文本的一部分：这里原样透出，不额外加工。
      render: (_args, value) => [{ type: 'text', text: value.output }],
    },
    execute(args, exec) {
      return run(args, exec)
    },
  })
}
