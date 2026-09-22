/**
 * 面板的两条 exact Fetch route 的处理函数（phase6-plan §2、§4；形态照 `Workspace/Blackboard/host/routes.ts`）。
 *
 * 两条路由的数据来源是 {@link FlowState}——`flow/*` 事件的宿主侧累加器。**面板不可回放**这条
 * 取舍与"为什么不走 session log"写在 `host/flow-state.ts` 的模块头：`flow/*` 是 Cordis 观察事件，
 * 出不了宿主进程，浏览器只能经路由拿状态。
 *
 * 这里只做**wire 边界**该做的事：查询参数校验（不合法即 400）与响应编码。请求体是空 POST，
 * 没有要解析的 JSON；`sessionId` 在这里从字符串收窄成 `SessionId`，那是它离开 URL 之后的唯一一次
 * 收窄点（`shared/protocol.ts` 的模块头说明了为什么线格式上是裸 `string`）。
 * @module dsh-execution-engine/routes
 */

import type { SessionId } from '@deepseek-ai/dsh-session'
import type { CancelResult, FlowSnapshot } from '../shared/protocol.ts'
import type { FlowState } from './flow-state.ts'
import type { ProgramCancel } from './job-runner.ts'

/**
 * 取消一条会话当前在跑的程序，并在清理真正完成后返回。
 *
 * 由装配方注入（`host/index.ts`），本模块不碰 `ctx`：路由的判据因此不需要一份真装配，
 * 而"取消走的是与 `cancel_program` 完全相同的那条路"这件事由注入的那一个实现保证。
 */
export type CancelProgram = (sessionId: SessionId) => Promise<ProgramCancel>

/**
 * `GET /api/execution-engine.state?sessionId=<id>&since=<n>`。
 *
 * `since` 省略按 `0` 处理（"我什么都没有，给全量"）。
 * @param state - 宿主侧累加器。
 * @param request - 已通过 Connection 信任检查的请求。
 * @returns 状态快照；`sessionId` 缺席或 `since` 不是非负安全整数时 400。
 */
export async function handleState(state: FlowState, request: Request): Promise<Response> {
  const query = new URL(request.url).searchParams
  const sessionId = query.get('sessionId')
  const since = Number(query.get('since') ?? '0')
  if (sessionId === null || sessionId === '' || !Number.isSafeInteger(since) || since < 0) {
    return new Response('Invalid execution-engine state query.', { status: 400 })
  }
  const snapshot: FlowSnapshot = state.read(sessionId as SessionId, since)
  return Response.json(snapshot)
}

/**
 * `POST /api/execution-engine.cancel?sessionId=<id>`。
 *
 * 与工具取消走同一条路径，也就继承了它"等到清理真正完成才返回"的语义（design.md §4.4）：
 * 响应回来时临时目录已经删掉、在飞的外部执行已经静默。
 * @param cancelProgram - 该会话的取消入口。
 * @param request - 已通过 Connection 信任检查的请求。
 * @returns 取消结果（幂等：没有在跑的程序时 `{ cancelled: false }`）；`sessionId` 缺席时 400。
 */
export async function handleCancel(cancelProgram: CancelProgram, request: Request): Promise<Response> {
  const sessionId = new URL(request.url).searchParams.get('sessionId')
  if (sessionId === null || sessionId === '') {
    return new Response('Invalid execution-engine session id.', { status: 400 })
  }
  return Response.json(toCancelResult(await cancelProgram(sessionId as SessionId)))
}

/**
 * 把 `cancel_program` 的结果折成线格式。
 * @param result - 注入的取消入口的返回值。
 * @returns 线上的取消结果；可选字段缺席时不带这个键（`exactOptionalPropertyTypes`）。
 */
function toCancelResult(result: ProgramCancel): CancelResult {
  return {
    cancelled: result.cancelled,
    ...result.jobId === undefined ? {} : { jobId: result.jobId },
    ...result.status === undefined ? {} : { status: result.status },
    ...result.detail === undefined ? {} : { detail: result.detail },
  }
}
