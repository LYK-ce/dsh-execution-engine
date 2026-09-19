import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

/** 占位工具的固定返回，测试与驱动按字面比对。 */
const PLUGIN_ID = 'dsh-execution-engine'

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
