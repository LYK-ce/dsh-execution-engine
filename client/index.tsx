import type { Context } from '@deepseek-ai/cordis'
// 类型专用：把 locale 服务的 Context 合并拉进程序。
import type {} from '@deepseek-ai/dsh-client-locale/client'
// 类型专用：'conversation.view' 的 SlotMap 行由 ui-conversation 声明。
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { CANCEL_PATH, STATE_PATH } from '../shared/protocol.ts'
import type { FlowRunHeader, FlowSnapshot } from '../shared/protocol.ts'
import { NS, en, zh } from './locale.ts'
import type { ExecutionEngineKey } from './locale.ts'
import { ExecutionEnginePanel } from './panel.tsx'
import type { CancelOutcome, ExecutionEngineInjected, PanelSnapshot, RunSource } from './panel.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** 执行引擎面板的文案。 */
    'execution-engine': ExecutionEngineKey
  }
}

/**
 * 轮询间隔，毫秒（phase6-plan §8 R3）。
 *
 * 单例之下每个会话只有一份状态，一拍就是一次本地回环路由读；间隔取人的反应速度量级，
 * 而 §4.4 的取消是"返回时清理已完成"，所以取消按钮的最终态最多晚这一拍。
 */
const POLL_MS = 1000

/** 需要的服务：槽位与文案。取消走自己的 route，不经 `sessions`。 */
export const inject = ['slots', 'locale']

/**
 * 把任意抛出物折成一行文字。
 * @param error - 捕获到的值，可能是任何东西。
 * @returns `Error` 取它的 message，其余走 `String()`。
 */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 两份头部说的是不是同一个事实。
 *
 * 只比**起了 run 之后还会动**的字段：`runId` 相同就说明其余字段（正文、标签、起始时间）本来就同源。
 * 服务端每一拍都会新建一个头部对象，所以这里比的是字段而不是引用（渲染器按引用比较）。
 * @param left - 本地当前的头部。
 * @param right - 这一拍拿回来的头部。
 * @returns 两者说的是同一件事时为真。
 */
function headerUnchanged(left: FlowRunHeader | null, right: FlowRunHeader | null): boolean {
  if (left === null || right === null) return left === right
  return left.runId === right.runId
    && left.status === right.status
    && left.endedAt === right.endedAt
    && left.detail === right.detail
    && left.discarded === right.discarded
}

/**
 * 建一个按 `since` 增量轮询的 run 源。
 *
 * 拼接规则与它的边界：
 *
 * - 服务端回的是 `seq >= since` 的条目；本地按序追加，游标取 `revision`。
 * - `reset`（`since` 被有界保留挤掉、或比最新还大）时本地条目整份换掉。
 * - **换了一次 run 时本地游标失去意义**：它记的是上一次 run 的条目数，服务端按它算出来的增量说不清
 *   该从哪接起。这时丢掉本地条目、把游标归零并立刻再取一次，那一拍拿到的就是全量。
 * - 一拍什么都没动时**保持快照引用不变**（渲染器的订阅按引用比较，否则面板每拍重渲一次）。
 * - 轮询**串行**：并发请求的响应乱序到达会让游标与本地条目对不上。
 * @param options - 读实现与轮询间隔。
 * @returns 可观察源。
 */
function createRunSource(options: {
  readonly load: (since: number) => Promise<FlowSnapshot>
  readonly pollMs: number
}): RunSource {
  let snapshot: PanelSnapshot = { run: null, entries: [] }
  let cursor = 0
  let timer: ReturnType<typeof setInterval> | undefined
  /** 串行队列；当前这一拍里排进来的下一拍会在它之后跑。 */
  let queue: Promise<void> = Promise.resolve()
  const listeners = new Set<() => void>()

  const publish = (next: PanelSnapshot): void => {
    snapshot = next
    for (const listener of listeners) listener()
  }

  /**
   * 折入一份增量。
   * @param delta - 服务端的响应。
   */
  const apply = (delta: FlowSnapshot): void => {
    const known = snapshot.run?.runId ?? null
    const next = delta.run?.runId ?? null
    if (known !== null && known !== next) {
      publish({ run: delta.run, entries: [] })
      cursor = 0
      void poll()
      return
    }
    const run = headerUnchanged(snapshot.run, delta.run) ? snapshot.run : delta.run
    const entries = delta.reset
      ? [...delta.entries]
      : delta.entries.length === 0 ? snapshot.entries : [...snapshot.entries, ...delta.entries]
    cursor = delta.revision
    if (run === snapshot.run && entries === snapshot.entries) return
    publish({ run, entries })
  }

  /**
   * 取一拍。
   * @returns 这一拍（含它排进来的后续几拍）跑完之后 resolve。
   */
  const poll = (): Promise<void> => {
    queue = queue.then(async () => {
      // 一拍失败（宿主重启、会话消失、路由还没挂上）只该让这一拍没有结果：下一拍会重试，
      // 面板不该炸成一片红。
      const delta = await options.load(cursor).catch(() => undefined)
      if (delta !== undefined) apply(delta)
    })
    return queue
  }

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener)
      if (timer === undefined) {
        void poll()
        timer = setInterval(() => { void poll() }, options.pollMs)
      }
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0 && timer !== undefined) {
          clearInterval(timer)
          timer = undefined
        }
      }
    },
  }
}

/**
 * 注册执行引擎视图：`conversation.view` 面板，数据走 `STATE_PATH` 轮询，取消走 `CANCEL_PATH`
 * （phase6-plan §2、§3）。
 * @param ctx - 客户端根上下文。
 * @returns 无。
 */
export function apply(ctx: Context): void {
  /** 每个会话一份源；同一个 sessionId 重复注入时复用，避免挂出第二个轮询。 */
  const sources = new Map<string, RunSource>()

  const loadState = async (sessionId: SessionId, since: number): Promise<FlowSnapshot> => {
    const response = await fetch(`${STATE_PATH}?sessionId=${encodeURIComponent(sessionId)}&since=${String(since)}`)
    if (!response.ok) throw new Error(`execution-engine: state read failed with ${String(response.status)}`)
    return await response.json() as FlowSnapshot
  }

  /**
   * 取消这个会话当前在跑的程序。
   *
   * `cancelled: false` 不算失败：那表示请求到达时已经结算了（按钮只在 running 时可点，所以这是
   * 两次轮询之间的正常竞态），而面板的"取消中"本来就等轮询回来的状态。真正失败的只有请求本身。
   * @param sessionId - 目标会话。
   * @returns 成功，或面板要显示的原因。
   */
  const cancelRun = async (sessionId: SessionId): Promise<CancelOutcome> => {
    try {
      const response = await fetch(`${CANCEL_PATH}?sessionId=${encodeURIComponent(sessionId)}`, { method: 'POST' })
      return response.ok ? { ok: true } : { ok: false, reason: `HTTP ${String(response.status)}` }
    } catch (error: unknown) {
      return { ok: false, reason: describe(error) }
    }
  }

  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'execution-engine: dictionaries')
  // 视图 tab 的文案是注册期文本，走 thunk 才能跟随语言切换而不重新注册。
  const t = ctx.locale.bind(NS)
  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: 'execution-engine',
    order: 30,
    locale: NS,
    label: () => t('view.panel'),
    inject: (sessionId: SessionId): ExecutionEngineInjected => {
      const existing = sources.get(sessionId)
      const source = existing ?? createRunSource({
        load: (since) => loadState(sessionId, since),
        pollMs: POLL_MS,
      })
      if (existing === undefined) sources.set(sessionId, source)
      return { hooks: { run: source }, cancel: () => cancelRun(sessionId) }
    },
  }, ExecutionEnginePanel))
}
