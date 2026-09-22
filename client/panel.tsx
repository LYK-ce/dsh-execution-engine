import { useEffect, useState } from 'react'
import type { CSSProperties } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// 类型专用：'conversation.view' 的 SlotMap 行与会话作用域标准位必须在程序里。
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type { FlowCallEntry, FlowEntry, FlowRunHeader } from '../shared/protocol.ts'
import type { ExecutionEngineKey } from './locale.ts'

/** 面板看到的状态快照：run 头部 + 已经积累的轨迹条目。 */
export interface PanelSnapshot {
  /** 这个会话当前那一版 run；从来没有跑过时是 `null`。 */
  readonly run: FlowRunHeader | null
  /** 按发生顺序的轨迹条目；增量拼接见 `client/index.tsx` 的源。 */
  readonly entries: readonly FlowEntry[]
}

/**
 * 面板私有的可观察 run 源。渲染器把它绑成 `useRun`（`InjectFace` 的 `hooks` 舱）。
 *
 * 它是"裸可观察源"而不是 hook：订阅机制归渲染器，业务组件只拿到绑定好的 hook
 * （packages/client/AGENTS.md 的 reactive read 纪律）。
 */
export interface RunSource {
  /**
   * 当前快照。
   * @returns 事实没动时返回同一个对象引用（渲染器的订阅靠引用比较）。
   */
  getSnapshot(): PanelSnapshot
  /**
   * 订阅变化；第一个订阅者启动轮询，最后一个走了就停。
   * @param listener - 快照变化时调用。
   * @returns 退订。
   */
  subscribe(listener: () => void): () => void
}

/** 面板发出的取消结果；原因是给用户看的一句话，不是异常。 */
export type CancelOutcome = { readonly ok: true } | { readonly ok: false; readonly reason: string }

/** 执行引擎视图的注入面：面板私有的可观察源，加一个取消动作。 */
export interface ExecutionEngineInjected {
  /** 面板私有的 run 源；框架把它绑成 `useRun`。 */
  hooks: { run: RunSource }
  /**
   * 取消这个会话当前在跑的程序（与 `cancel_program` 同一条路径）。
   * @returns 成功，或面板要显示的原因。
   */
  cancel: () => Promise<CancelOutcome>
}

/** 执行引擎视图的完整 props：运行时份额 + 注入面 + 文案位。 */
export type ExecutionEnginePanelProps = PropsRuntime<'conversation.view'>
  & InjectFace<ExecutionEngineInjected>
  & PropsLocale<'execution-engine'>

/** 超过这个行数才开窗渲染（phase6-plan §8 R8：本阶段不做虚拟滚动）。 */
const CODE_MAX_LINES = 400

/** 开窗时当前行上下各渲染多少行。 */
const CODE_WINDOW_RADIUS = 150

/** 每个终态的中文键。 */
const STATUS_KEYS: Record<FlowRunHeader['status'], ExecutionEngineKey> = {
  running: 'status.running',
  completed: 'status.completed',
  killed: 'status.killed',
  failed: 'status.failed',
}

/** 每条调用状态的中文键。 */
const CALL_KEYS: Record<FlowCallEntry['state'], ExecutionEngineKey> = {
  open: 'trace.open',
  ok: 'trace.ok',
  error: 'trace.error',
}

const ROOT: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  height: '100%',
  minHeight: 0,
  background: 'var(--dsw-alias-bg-base, #ffffff)',
  color: 'var(--dsw-alias-label-primary, #1e1e1e)',
  font: 'inherit',
}

const TOOLBAR: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '6px 8px',
  borderBottom: '1px solid var(--dsw-alias-border-l1, #e5e5e5)',
}

const BODY: CSSProperties = { flex: '1 1 auto', minHeight: 0, overflow: 'auto', padding: '6px 8px' }

const BUTTON: CSSProperties = {
  marginLeft: 'auto',
  height: 26,
  padding: '0 10px',
  cursor: 'pointer',
  border: '1px solid var(--dsw-alias-border-l2, #d0d0d0)',
  borderRadius: 6,
  background: 'var(--dsw-alias-bg-layer-2, #f7f7f7)',
  color: 'inherit',
  font: 'inherit',
}

const HEADING: CSSProperties = { margin: '8px 0 4px', opacity: 0.7, fontWeight: 600 }

const NOTE: CSSProperties = { padding: '2px 0', opacity: 0.8 }

const LABEL: CSSProperties = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }

const CODE: CSSProperties = {
  margin: 0,
  padding: '4px 0',
  border: '1px solid var(--dsw-alias-border-l1, #e5e5e5)',
  borderRadius: 6,
  overflowX: 'auto',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  fontSize: 12,
  lineHeight: 1.5,
}

const LINE: CSSProperties = { display: 'flex', gap: 8, whiteSpace: 'pre' }

/** 当前行：整行加底色，而不是只标记行号——§8.3 的"当前执行位置"就是这个粒度。 */
const LINE_CURRENT: CSSProperties = {
  ...LINE,
  background: 'var(--dsw-alias-bg-layer-2, #f0f0f0)',
}

const LINE_NUMBER: CSSProperties = {
  flex: '0 0 auto',
  minWidth: 36,
  padding: '0 6px',
  textAlign: 'right',
  opacity: 0.5,
  userSelect: 'none',
}

const ROW: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 8,
  alignItems: 'baseline',
  padding: '2px 0',
  borderBottom: '1px solid var(--dsw-alias-border-l1, #f2f2f2)',
}

const MUTED: CSSProperties = { opacity: 0.65 }

const PREVIEW: CSSProperties = {
  flexBasis: '100%',
  opacity: 0.75,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-all',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  fontSize: 12,
}

const REPORT: CSSProperties = {
  margin: '2px 0',
  padding: '4px 6px',
  borderLeft: '3px solid var(--dsw-alias-border-l2, #d0d0d0)',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
}

/**
 * 把任意抛出物折成一行文字。
 * @param error - 捕获到的值，可能是任何东西。
 * @returns `Error` 取它的 message，其余走 `String()`。
 */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 折一个墙钟毫秒数为本机时间。
 * @param at - 毫秒时间戳。
 * @returns 本机时间文本。
 */
function timeOf(at: number): string {
  return new Date(at).toLocaleTimeString()
}

/**
 * 当前执行位置：轨迹里**最后一条**还开着的调用所在的行。
 *
 * 没有开着的调用（或它拿不到行号）时返回 `null`——不高亮任何一行。§8.3 说当前行只是轨迹的末端，
 * 所以这里不去猜一个"大概在哪"。
 * @param entries - 已经积累的轨迹条目。
 * @returns 1-based 行号；没有可高亮的行时是 `null`。
 */
function currentLine(entries: readonly FlowEntry[]): number | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]
    if (entry !== undefined && entry.kind === 'call' && entry.state === 'open') return entry.line
  }
  return null
}

/** 实际渲染的行区间（1-based，含两端）。 */
interface LineWindow {
  readonly from: number
  readonly to: number
}

/**
 * 算要渲染的行区间。
 *
 * 程序正文可能几十 KB（phase6-plan §8 R8），整段渲染会把面板卡住；超过 {@link CODE_MAX_LINES}
 * 就只渲染当前行附近的一段，窗口边界在面板上明说（`code.window`）。不做虚拟滚动。
 * @param total - 总行数。
 * @param current - 当前执行位置；没有时从第 1 行开窗。
 * @returns 闭区间边界。
 */
function lineWindow(total: number, current: number | null): LineWindow {
  if (total <= CODE_MAX_LINES) return { from: 1, to: total }
  const anchor = current ?? 1
  return {
    from: Math.max(1, anchor - CODE_WINDOW_RADIUS),
    to: Math.min(total, anchor + CODE_WINDOW_RADIUS),
  }
}

/**
 * 会话作用域的执行引擎面板：状态行 + 源码（带行号、当前行高亮）+ 调用轨迹 + 汇报 + 取消按钮。
 * @param props - 框架给的运行时份额、注入面与 `t`。
 * @returns 面板元素。
 */
export function ExecutionEnginePanel({ t, useRun, cancel }: ExecutionEnginePanelProps): JSX.Element {
  const snapshot = useRun(value => value)
  const [cancelling, setCancelling] = useState(false)
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const run = snapshot.run
  const running = run?.status === 'running'

  // Q2 的裁决：点下之后按钮 disabled + "取消中"，直到 run 结算。判据是**轮询回来的状态**，不是
  // 那个 POST 的返回：§4.4 的取消在返回时清理已完成，但 job 的终态还要等宿主发出 `flow/end`。
  useEffect(() => {
    if (!running) setCancelling(false)
  }, [running])

  /**
   * 发一次取消请求。
   *
   * POST 自己失败时立刻把按钮放回去：run 还在跑，用户得能重试；这不是"取消中"该覆盖的状态。
   * @returns 无。
   */
  const requestCancel = (): void => {
    setCancelling(true)
    setFailure(undefined)
    void cancel().then(
      (outcome) => {
        if (outcome.ok) return
        setCancelling(false)
        setFailure(t('action.cancelFailed', { reason: outcome.reason }))
      },
      (error: unknown) => {
        setCancelling(false)
        setFailure(t('action.cancelFailed', { reason: describe(error) }))
      },
    )
  }

  const trace = snapshot.entries.filter((entry): entry is FlowCallEntry => entry.kind === 'call')
  const reports = snapshot.entries.filter(entry => entry.kind === 'report')
  const current = currentLine(snapshot.entries)
  const lines = run === null || run.code === '' ? [] : run.code.split('\n')
  const window = lineWindow(lines.length, current)

  return (
    <div style={ROOT}>
      <div style={TOOLBAR}>
        <span style={{ ...LABEL, flex: '1 1 auto' }}>
          {run === null ? t('status.idle') : run.label}
        </span>
        {run === null ? null : <span style={MUTED}>{t(STATUS_KEYS[run.status])}</span>}
        {run === null ? null : (
          <button
            type="button"
            disabled={!running || cancelling}
            onClick={requestCancel}
            style={BUTTON}
          >
            {cancelling ? t('action.cancelling') : t('action.cancel')}
          </button>
        )}
      </div>
      {failure === undefined ? null : <div style={{ ...NOTE, padding: '4px 8px' }}>{failure}</div>}
      {run === null ? null : (
        <div style={BODY}>
          <div style={NOTE}>
            {t('status.started', { time: timeOf(run.startedAt) })}
            {run.endedAt === undefined ? '' : ` · ${t('status.ended', { time: timeOf(run.endedAt) })}`}
          </div>
          {run.detail === undefined ? null : <div style={NOTE}>{t('status.detail', { detail: run.detail })}</div>}
          {run.discarded === 0 ? null : (
            <div style={NOTE}>{t('status.discarded', { count: run.discarded })}</div>
          )}

          <div style={HEADING}>{t('section.code')}</div>
          {lines.length === 0
            ? <div style={NOTE}>{t('code.empty')}</div>
            : (
              <>
                {window.from === 1 && window.to === lines.length
                  ? null
                  : (
                    <div style={NOTE}>
                      {t('code.window', { from: window.from, to: window.to, total: lines.length })}
                    </div>
                  )}
                <div style={CODE}>
                  {lines.slice(window.from - 1, window.to).map((text, offset) => {
                    const number = window.from + offset
                    return (
                      <div key={number} style={number === current ? LINE_CURRENT : LINE}>
                        <span style={LINE_NUMBER}>{String(number)}</span>
                        <span>{text === '' ? ' ' : text}</span>
                      </div>
                    )
                  })}
                </div>
              </>
            )}

          <div style={HEADING}>{t('section.trace')}</div>
          {trace.length === 0
            ? <div style={NOTE}>{t('trace.empty')}</div>
            : [...trace].reverse().map(entry => (
              <div key={entry.seq} style={ROW}>
                <span style={MUTED}>
                  {entry.line === null ? t('trace.noLine') : t('trace.line', { line: entry.line })}
                </span>
                <span>{entry.member}</span>
                <span>{t(CALL_KEYS[entry.state])}</span>
                {entry.ms === undefined ? null : <span style={MUTED}>{t('trace.duration', { ms: entry.ms })}</span>}
                {entry.synthetic === true ? <span style={MUTED}>{t('trace.synthetic')}</span> : null}
                {entry.preview === undefined ? null : <div style={PREVIEW}>{entry.preview}</div>}
              </div>
            ))}

          <div style={HEADING}>{t('section.reports')}</div>
          {reports.length === 0
            ? <div style={NOTE}>{t('reports.empty')}</div>
            : reports.map(entry => <div key={entry.seq} style={REPORT}>{entry.text}</div>)}
        </div>
      )}
    </div>
  )
}
