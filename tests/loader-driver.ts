#!/usr/bin/env node
/**
 * 阶段 0 的真实组合验证：用 app-boot 的 boot() 起一份最小 Loader 组合，断言占位工具
 * 已注册、模型可见 schema 存在、执行一次返回约定值；并断言插件模块的导出面。
 * 用法（cwd = 仓库根，必须带 tsx，否则裸包名解析不到源码）：
 *   node --import tsx/esm Workspace/ExecutionEngine/tests/loader-driver.ts \
 *     Workspace/ExecutionEngine/tests/fixtures/cordis.yml
 */
import assert from 'node:assert/strict'
import { boot, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import * as plugin from '../host/index.ts'

const configPath = process.argv[2]
if (configPath === undefined) throw new Error('loader-driver requires a config path')

assert.equal(plugin.name, 'execution-engine')
assert.deepEqual(plugin.inject, ['tools'])
assert.equal(typeof plugin.apply, 'function')
assert.ok(!('default' in plugin), 'the plugin module must not export default (postmortem 0001)')

const ctx = await boot('execution-engine-loader-smoke', resolveConfigPath(configPath, undefined))
try {
  assert.ok(
    ctx.tools.schemas().some(tool => tool.name === 'execution_engine_ping'),
    'execution_engine_ping is not registered',
  )
  const result = await ctx.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId('execution-engine-skeleton'),
    name: 'execution_engine_ping',
    arguments: {},
  })
  assert.equal(result.isError, false)
  const text = result.content.filter(block => block.type === 'text').map(block => block.text).join('')
  assert.equal(text, 'ExecutionEngine skeleton is mounted: dsh-execution-engine phase 0.')
} finally {
  await ctx.fiber.dispose()
}
process.stdout.write('LOADER_SMOKE_OK\n')
