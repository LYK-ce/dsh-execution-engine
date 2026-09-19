import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { test } from 'node:test'
import { createRunTmpDir, removeRunTmpDir } from '../host/tmp-dir.ts'

/**
 * run 临时目录落在**会话工作目录**下面（design.md §3.5），不在 `os.tmpdir()`：
 * 受管期的可写范围就是工作目录，跨 `process` 边界的取值约定要求外部脚本与程序
 * 落在同一个可写位置。
 */
test('run 临时目录建在会话工作目录下', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'ee-tmp-dir-'))
  try {
    const path = await createRunTmpDir(cwd, 'run-1')
    assert.equal(path, join(cwd, '.execution-engine', 'run-1'))
    assert.ok(
      path.startsWith(cwd + sep),
      'the run directory must live inside the session working directory',
    )
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

/** 删除是整体的：run 目录连同它里面的东西一起消失，父目录留在原地。 */
test('run 结束整体删除临时目录', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'ee-tmp-dir-'))
  const warnings: string[] = []
  try {
    const path = await createRunTmpDir(cwd, 'run-1')
    await writeFile(join(path, 'result.txt'), 'value', 'utf8')
    await removeRunTmpDir(path, message => { warnings.push(message) })

    assert.deepEqual(warnings, [], 'a successful cleanup must not warn')
    await assert.rejects(readFile(join(path, 'result.txt'), 'utf8'))
    // 每个 run 一个独立目录：删掉一个不影响另一个。
    const second = await createRunTmpDir(cwd, 'run-2')
    assert.equal(second, join(cwd, '.execution-engine', 'run-2'))
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})
