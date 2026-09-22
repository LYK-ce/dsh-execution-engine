/**
 * 执行引擎面板的文案字典（design.md §8.4：客户端 UI 文案必须走 locale 字典）。
 *
 * 键集的事实来源是 {@link zh}；{@link en} 按它校验完整性，所以漏一个键是编译错误。
 * 模型数据（程序正文、run 标签、原语名、report 正文、错误文本）一律**逐字显示**，不进字典。
 */

/** 命名空间。 */
export const NS = 'execution-engine'

/** 简体中文字典，键集的事实来源。 */
export const zh = {
  'view.panel': '执行引擎',

  'status.running': '运行中',
  'status.completed': '已完成',
  'status.killed': '已取消',
  'status.failed': '失败',
  'status.idle': '当前没有程序在跑。',
  'status.detail': '说明：{detail}',
  'status.discarded': '这次取消作废了 {count} 条还没被读到的汇报。',
  'status.started': '开始于 {time}',
  'status.ended': '结束于 {time}',

  'section.code': '程序源码',
  'code.empty': '（空程序）',
  'code.window': '第 {from}–{to} 行，共 {total} 行',

  'section.trace': '调用轨迹',
  'trace.empty': '还没有调用。',
  'trace.line': '第 {line} 行',
  'trace.noLine': '行号未知',
  'trace.duration': '{ms} ms',
  'trace.synthetic': '宿主补发',
  'trace.open': '进行中',
  'trace.ok': '成功',
  'trace.error': '失败',

  'section.reports': '汇报',
  'reports.empty': '还没有汇报。',

  'action.cancel': '取消程序',
  'action.cancelling': '取消中…',
  'action.cancelFailed': '取消失败：{reason}',
} satisfies Record<string, string>

/** 执行引擎命名空间的键集。 */
export type ExecutionEngineKey = keyof typeof zh

/** 英文字典，按 zh 的键集校验完整性。 */
export const en = {
  'view.panel': 'Execution Engine',

  'status.running': 'Running',
  'status.completed': 'Completed',
  'status.killed': 'Cancelled',
  'status.failed': 'Failed',
  'status.idle': 'No program is running.',
  'status.detail': 'Detail: {detail}',
  'status.discarded': 'The cancellation discarded {count} unread report(s).',
  'status.started': 'Started {time}',
  'status.ended': 'Ended {time}',

  'section.code': 'Program source',
  'code.empty': '(empty program)',
  'code.window': 'Lines {from}–{to} of {total}',

  'section.trace': 'Call trace',
  'trace.empty': 'No calls yet.',
  'trace.line': 'line {line}',
  'trace.noLine': 'line unknown',
  'trace.duration': '{ms} ms',
  'trace.synthetic': 'host-closed',
  'trace.open': 'running',
  'trace.ok': 'ok',
  'trace.error': 'error',

  'section.reports': 'Reports',
  'reports.empty': 'No reports yet.',

  'action.cancel': 'Cancel program',
  'action.cancelling': 'Cancelling…',
  'action.cancelFailed': 'Cancel failed: {reason}',
} satisfies Record<ExecutionEngineKey, string>
