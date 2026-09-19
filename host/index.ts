import type { Context } from '@deepseek-ai/cordis'
import { createSkeletonTool } from './tool.ts'

export const name = 'execution-engine'
export const inject = ['tools']

/** 插件配置。阶段 0 没有可部署项；design.md §9 的 `process` 超时字段在阶段 1 落地。 */
export interface Config {}

/**
 * 注册阶段 0 的占位工具。工具本身是注册即效应（先例 packages/todo/tool-todo/src/index.ts:146），
 * 这里不重复包一层 ctx.effect。
 * @param ctx - 宿主上下文。
 * @returns 无。
 */
export function apply(ctx: Context): void {
  ctx.tools.register(createSkeletonTool())
}
