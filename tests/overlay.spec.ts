import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { test } from 'node:test'
import yaml from 'js-yaml'
import ts from 'typescript'

/** 项目根：本 spec 位于 tests/ 下。 */
const ROOT = resolve(import.meta.dirname, '..')

/** 挂在 DSH Web profile 上的 `--patch` overlay。 */
const OVERLAY = resolve(ROOT, 'execution-engine.cordis.yml')

/** 客户端 bundle 的构建脚本；模块表 id 必须等于包名。 */
const BUILD_SCRIPT = resolve(ROOT, 'build', 'build-client.mjs')

/** 两个 face 各自的类型检查 program。 */
const FACE_CONFIGS = ['tsconfig.json', 'tsconfig.client.json'] as const

/** patch 行里本 spec 读的字段。 */
interface PatchRow {
  id?: unknown
  name?: unknown
}

/** 一层 patch 里本 spec 读的字段。 */
interface PatchEntry {
  id?: unknown
  insert?: unknown
}

/** package.json 里本 spec 读的字段。 */
interface Manifest {
  name?: unknown
  private?: unknown
  type?: unknown
  scripts?: Record<string, unknown>
  exports?: Record<string, unknown>
  dsh?: { client?: { platform?: unknown } }
}

/** 把 overlay 解析成 entry 数组。 */
function readOverlay(): PatchEntry[] {
  const parsed: unknown = yaml.load(readFileSync(OVERLAY, 'utf8'))
  assert.ok(Array.isArray(parsed), 'execution-engine.cordis.yml must parse to a JSON array of patch entries')
  return parsed as PatchEntry[]
}

/** 解析一个 tsconfig（两个文件都带注释，所以只能走 TS 自己的解析器）。 */
function parseFaceConfig(name: string): ts.ParsedCommandLine {
  const path = resolve(ROOT, name)
  const read = ts.readConfigFile(path, file => ts.sys.readFile(file))
  assert.equal(
    read.error,
    undefined,
    `${name}: ${read.error === undefined ? '' : ts.flattenDiagnosticMessageText(read.error.messageText, '\n')}`,
  )
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, ROOT, undefined, path)
  assert.deepEqual(
    parsed.errors.map(error => ts.flattenDiagnosticMessageText(error.messageText, '\n')),
    [],
    `${name} must parse without config errors`,
  )
  return parsed
}

test('overlay 是一层只有 insert 的 patch，带一条锚定得住的相对行名', () => {
  const patches = readOverlay()

  assert.equal(patches.length, 1)
  const patch = patches[0]
  assert.ok(patch !== undefined && typeof patch === 'object' && !Array.isArray(patch), 'each entry must be a mapping')
  // 有 id 就变成"往那个 group 的 config 里插"，与顶层追加是两种语义（app-boot 的合并表）。
  assert.deepEqual(Object.keys(patch), ['insert'])

  const rows: unknown = patch.insert
  // 恰好一行：本 spec 的价值就是守住"只插一条锚定得住的相对行名"。
  // 只校验 rows[0] 时，多出来的坏行（例如指向一个不存在的文件）会无声通过。
  assert.ok(Array.isArray(rows), 'insert must carry a row array')
  assert.equal(rows.length, 1, 'the overlay must insert exactly one row')
  const row = rows[0] as PatchRow
  assert.equal(row.id, 'execution-engine-host')
  assert.equal(row.name, './host/index.ts')

  // 只有 ./ 与 ../ 开头的行名会被 anchorInsertedPluginNames 改写成 patch 文件所在目录的 file:// URL。
  assert.ok(
    typeof row.name === 'string' && (row.name.startsWith('./') || row.name.startsWith('../')),
    'the row name must be relative so the overlay survives a different checkout location',
  )
  assert.ok(existsSync(resolve(dirname(OVERLAY), row.name)), 'the anchored row name must resolve to a real file')
})

test('package.json 声明了客户端半边，且包名就是模块表 id', () => {
  const manifest = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')) as Manifest

  assert.equal(manifest.name, 'dsh-execution-engine')
  assert.equal(manifest.private, true)
  assert.equal(manifest.type, 'module')
  for (const script of ['typecheck', 'build', 'test']) {
    const value = manifest.scripts?.[script]
    assert.ok(typeof value === 'string' && value.length > 0, `scripts.${script} must be a non-empty string`)
  }
  assert.equal(manifest.dsh?.client?.platform, 'web')
  assert.equal(manifest.exports?.['./client'], './lib/client.js')

  // dsh.client 与 lib/client.js 同进同出：声明了却读不到会让整个 dsh web 启动失败（modules 是 required 行）。
  assert.ok(
    readFileSync(BUILD_SCRIPT, 'utf8').includes(manifest.name as string),
    'build/build-client.mjs must register the bundle under the package name',
  )
})

test('两个 face 的 program 都能解析出输入文件', () => {
  for (const name of FACE_CONFIGS) {
    // include 匹配不到文件时 tsc 报 TS18003；fileNames 非空就是它的机器可检形式。
    assert.ok(parseFaceConfig(name).fileNames.length > 0, `${name} must include at least one file`)
  }
})
