/**
 * `JobKindMap` 的声明合并入口（design.md §4.1；phase3-plan §2）。
 *
 * job 的 kind 由生产方自己登记：注册表把每个值当作不透明的 id 命名空间，id 形如 `<kind>-N`
 * （`packages/jobs/jobs/src/types.ts:19-29`）。本插件的程序用 `execution-engine` 这个 kind，
 * 于是 id 是 `execution-engine-1` 一类，与 `bash-1` / `subagent-1` 不会撞号。
 *
 * 单独一个文件而不是写在 `job-runner.ts` 里：合并入口是**程序可见契约的一部分**（id 前缀会进
 * 单例拒绝的错误文本与工具返回值），与提交逻辑分开更好找。
 *
 * 本模块只有类型，运行时是空模块。先例 `packages/shell/tool-pwsh/src/index.ts:29,41`：
 * 同一个 `declare module` 与 `import type {}` 并存的写法。
 * @module dsh-execution-engine/jobs-types
 */

import type {} from '@deepseek-ai/dsh-jobs'

declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap {
    'execution-engine': 'execution-engine'
  }
}
