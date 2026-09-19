import type { Context } from '@deepseek-ai/cordis'

/**
 * 阶段 0 的浏览器半边：不做任何注册。
 *
 * 两个非它不可的理由：
 * 1. tsconfig.client.json 的 include 匹配不到文件时 tsc 报 TS18003；
 * 2. package.json 一旦声明 dsh.client，@deepseek-ai/dsh-client-modules 就会去读
 *    lib/client.js，读不到会让整个 dsh web 启动失败（modules 是 required 行）。
 * 阶段 6 在这里注册 conversation.view 面板。
 * @param _ctx - 客户端根上下文；阶段 0 不使用。
 * @returns 无。
 */
export function apply(_ctx: Context): void {}
