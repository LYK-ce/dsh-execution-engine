/**
 * run 专属临时目录（design.md §3.5）：引擎创建、引擎删除，程序中以 `flow.tmpDir` 只读可见。
 *
 * 位置是 `<会话工作目录>/.execution-engine/<runId>`，每次 run 一个独立目录。
 * **不在 `os.tmpdir()` 下**：受管期的可写范围就是工作目录，而 `process` 起的外部进程与
 * PTC 子进程各有各的私有临时目录——工作目录是两者唯一的可写交集，design.md §3.4 的
 * "脚本写文件、程序读文件"取值约定要求两边落在同一个位置。
 *
 * 删除不经过 `ctx.fs`：`FileSystem` 服务定义里没有删除操作（只有 read/write/edit/stat/list），
 * 所以这里用 `node:fs/promises` 的 `rm({recursive, force})`（phase1-plan R5 的结论）。
 * @module dsh-execution-engine/tmp-dir
 */

import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'

/** 工作目录下本插件独占的一层目录名。 */
const RUN_ROOT = '.execution-engine'

/** 目录权限：只有本次 run 的进程能进。 */
const RUN_DIR_MODE = 0o700

/**
 * 为一次 run 建专属临时目录。
 * @param cwd - 本次 run 的工作目录（发起会话快照）；目录建在它下面。
 * @param runId - 本次 run 的随机标识；调用方生成，便于测试固定落点。
 * @returns 目录的绝对路径，程序中以 `flow.tmpDir` 可见。
 */
export async function createRunTmpDir(cwd: string, runId: string): Promise<string> {
  const path = join(cwd, RUN_ROOT, runId)
  await mkdir(path, { recursive: true, mode: RUN_DIR_MODE })
  return path
}

/**
 * 整体删除一次 run 的临时目录。失败只记日志：run 的结论早已定下，清理失败不该改写它。
 * @param path - `createRunTmpDir` 返回的路径。
 * @param warn - 记录清理失败的告警出口（通常是 `ctx.logger.warn`）。
 */
export async function removeRunTmpDir(path: string, warn: (message: string) => void): Promise<void> {
  try {
    await rm(path, { recursive: true, force: true })
  } catch (error: unknown) {
    // 子进程可能还持有目录里的文件句柄（Windows 尤其如此）；清理失败是残渣，不是 run 的失败。
    warn(`execution-engine: could not remove the run temporary directory ${path}: ${String(error)}`)
  }
}
