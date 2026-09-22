import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { test } from 'node:test'
import {
  DEFAULT_PROCESS_TIMEOUT_MS,
  DEFAULT_SUBAGENT_PROVIDER,
  MAX_PROCESS_TIMEOUT_MS,
  resolveProcessTimeouts,
  resolveRequestedTimeout,
  resolveSubagentProvider,
} from '../host/config.ts'

/** 项目根：本 spec 位于 tests/ 下。 */
const ROOT = resolve(import.meta.dirname, '..')

/** 部署缺省值就是 design.md §9 的那两个数。 */
test('缺省超时是 300s / 900s', () => {
  assert.deepEqual(resolveProcessTimeouts({}), { defaultTimeoutMs: 300_000, maxTimeoutMs: 900_000 })
  assert.deepEqual(resolveProcessTimeouts({ process: {} }), { defaultTimeoutMs: 300_000, maxTimeoutMs: 900_000 })
})

/** 部分配置只覆盖给出来的那个字段。 */
test('配置缺项各自回落默认', () => {
  assert.deepEqual(resolveProcessTimeouts({ process: { defaultTimeoutMs: 250, maxTimeoutMs: 1_000 } }), {
    defaultTimeoutMs: 250,
    maxTimeoutMs: 1_000,
  })
  assert.deepEqual(resolveProcessTimeouts({ process: { defaultTimeoutMs: 250 } }), {
    defaultTimeoutMs: 250,
    maxTimeoutMs: 900_000,
  })
  // 只压低上限而不动默认：默认就高于上限，这是装配错误而不是静默截断。
  assert.throws(() => resolveProcessTimeouts({ process: { maxTimeoutMs: 1_000 } }), /must not exceed/)
})

/** 加载期自洽性：默认超时高于上限就是装配错误，直接拒绝。 */
test('default > max 被拒', () => {
  assert.throws(
    () => resolveProcessTimeouts({ process: { defaultTimeoutMs: 2_000, maxTimeoutMs: 1_000 } }),
    /must not exceed/,
  )
})

/** 两个字段都必须是正整数。 */
test('非正整数被拒', () => {
  assert.throws(() => resolveProcessTimeouts({ process: { defaultTimeoutMs: 0 } }), /positive integer/)
  assert.throws(() => resolveProcessTimeouts({ process: { maxTimeoutMs: -1 } }), /positive integer/)
  assert.throws(() => resolveProcessTimeouts({ process: { defaultTimeoutMs: 1.5 } }), /positive integer/)
})

/** 请求超上限在解析阶段被拒绝，且错误信息带上限值；不是悄悄截断。 */
test('请求超上限被拒', () => {
  const timeouts = resolveProcessTimeouts({})
  assert.equal(resolveRequestedTimeout(undefined, timeouts), DEFAULT_PROCESS_TIMEOUT_MS)
  assert.equal(resolveRequestedTimeout(1_500, timeouts), 1_500)
  assert.equal(resolveRequestedTimeout(MAX_PROCESS_TIMEOUT_MS, timeouts), MAX_PROCESS_TIMEOUT_MS)
  assert.throws(() => resolveRequestedTimeout(10_000_000, timeouts), /exceeds the configured maximum of 900000/)
  assert.throws(() => resolveRequestedTimeout(0, timeouts), /positive integer/)
  assert.throws(() => resolveRequestedTimeout(Number.NaN, timeouts), /positive integer/)
})

/**
 * schemastery 模式只引用本模块导出的两个缺省常量：模式的缺省与解析器的回落必须是同一个数，
 * 否则 cordis 套用缺省时会与 `resolveProcessTimeouts` 得出不同的策略。
 * 模式放在 host/index.ts（本模块不引任何包），所以这里做源码级比对。
 */
test('schemastery 模式的缺省与解析器共用同一份常量', () => {
  const source = readFileSync(resolve(ROOT, 'host', 'index.ts'), 'utf8')
  assert.ok(
    source.includes('z.natural().default(DEFAULT_PROCESS_TIMEOUT_MS)'),
    'the schema must default process.defaultTimeoutMs from DEFAULT_PROCESS_TIMEOUT_MS',
  )
  assert.ok(
    source.includes('z.natural().default(MAX_PROCESS_TIMEOUT_MS)'),
    'the schema must default process.maxTimeoutMs from MAX_PROCESS_TIMEOUT_MS',
  )
  assert.ok(
    source.includes('z.string().min(1).default(DEFAULT_SUBAGENT_PROVIDER)'),
    'the schema must reject the empty provider name and default from DEFAULT_SUBAGENT_PROVIDER',
  )
})

/** provider 名默认就是 `spawn`（`subagent-spawn-in-process` 注册的那个），部署可覆盖。 */
test('subagentProvider 缺省 spawn，可覆盖', () => {
  assert.equal(DEFAULT_SUBAGENT_PROVIDER, 'spawn')
  assert.equal(resolveSubagentProvider({}), 'spawn')
  assert.equal(resolveSubagentProvider({ subagentProvider: 'scripted' }), 'scripted')
})

/**
 * 空名字与带首尾空白的名字都是装配错误：静默回落会把子 agent 挂到部署没选的后端上，
 * 带空白的名字在 `ctx.subagents` 里也永远匹配不到 provider（先例
 * packages/workflow/workflow-ptc/src/index.ts:69）。
 */
test('subagentProvider 空名字与未规范化名字被拒', () => {
  assert.throws(() => resolveSubagentProvider({ subagentProvider: '' }), /non-empty provider name/)
  assert.throws(() => resolveSubagentProvider({ subagentProvider: '   ' }), /non-empty provider name/)
  assert.throws(() => resolveSubagentProvider({ subagentProvider: ' scripted ' }), /non-empty provider name/)
  assert.throws(
    () => resolveSubagentProvider({ subagentProvider: 42 as unknown as string }),
    /non-empty provider name/,
  )
})
