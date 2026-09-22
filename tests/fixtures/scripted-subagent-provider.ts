/**
 * 无 key 的确定性子 agent provider（phase2-plan §5）：`tests/fixtures/cordis.yml` 用它替掉
 * `spawn`（那个真的在进程内起 agent，需要模型 route），让 B6 在 keyless 下也能跑。
 *
 * 它同时是归属断言的落点：每次 `start` 收到的 `parent` 都记下来，驱动拿发起者的
 * `SessionId` 逐字比对——不是"非空"那种弱断言。阶段 8 起同一个记录里还有 `agentOptions`，
 * 那是"程序指定的子 agent 模型真的走到了执行缝上"唯一的观察点（B15）。
 *
 * 自建而不是复用 `packages/subagent/tool-subagent/tests/scripted-provider.ts`：那是别的包的
 * 测试内部件，跨目录引用既脆又越界。
 * @module dsh-execution-engine/tests/fixtures/scripted-subagent-provider
 */

import type { Context } from '@deepseek-ai/cordis'
import type { AgentOptions } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {
  ResolvedSubagentStartRequest,
  SubagentCapabilities,
  SubagentProvider,
  SubagentResult,
  SubagentRun,
} from '@deepseek-ai/dsh-subagent'

export const name = 'scripted-subagent-provider'

export const inject = ['subagents']

/** provider 注册名；fixture 的 `subagentProvider` 配的就是它。 */
export const PROVIDER_NAME = 'scripted'

/** 正常完成时返回的固定文本；驱动按字面比对。 */
export const SCRIPTED_REPLY = 'EE_SCRIPTED_REPLY received the delegated prompt'

/** prompt 里出现这个标记就按失败结束，用来跑 B6 的失败路径。 */
export const FAILURE_MARKER = 'EE_SCRIPTED_FAIL'

/**
 * 失败结果里的 provider 诊断。驱动按这个字面量断言它真的进了 `dispatchsubagent` 的错误消息——
 * provider 写了诊断而没人断言，这条信息通道就是死数据。
 */
export const FAILURE_DIAGNOSTIC = 'scripted subagent failure requested by the prompt'

/**
 * 脚本化 provider 声明的 start 期能力。`agentOptions` 必须为真：阶段 8 起 `dispatchsubagent`
 * 会把程序指定的路由包成 `agentOptions` 转发下来，而 service 的 `assertCapabilities`
 * （`packages/subagent/subagent/src/index.ts:641-643`）会按能力位拒绝——不声明它，B15 连请求都收不到。
 * 其余能力仍然不声明：这个替身不实现输出 schema、深度上限、工具过滤与人设。
 */
const CAPABILITIES: SubagentCapabilities = {
  agentOptions: true,
  outputSchema: false,
  depthLimit: false,
  toolFilter: false,
  persona: false,
}

/** 一次脚本化 `start` 收到的归属、prompt 与路由。 */
export interface ScriptedStart {
  /** 发起这次派发的主 agent id；归属断言比对的就是它。 */
  readonly parentId: SessionId
  /** `start` 收到的 prompt 正文。 */
  readonly prompt: string
  /** `start` 收到的子 agent 选项；程序没显式指定路由时是 `undefined`。 */
  readonly agentOptions: AgentOptions | undefined
  /** 键**是否在场**：省略与显式 `undefined` 是两回事，"继承父 agent"靠的是省略。 */
  readonly hasAgentOptions: boolean
}

/**
 * 记录每次 `start`。驱动与 fixture 是同一条相对路径解析出来的同一个模块实例
 * （fixture 由 Loader 按配置目录加载，驱动按自己的相对路径导入）；驱动先断言
 * `scriptedStarts().length`，实例若不同会当场失败而不是静默放过。
 */
const starts: ScriptedStart[] = []

/** 本次进程里所有脚本化 `start` 的记录，按发生顺序。 */
export function scriptedStarts(): readonly ScriptedStart[] {
  return starts
}

/** 把子 agent 的 prompt 内容块折成文本，用于识别失败标记。 */
function promptText(prompt: readonly ContentBlock[]): string {
  return prompt
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('')
}

/** 只回固定文本、只记归属与路由的 provider；不带任何真实模型调用。 */
class ScriptedSubagentProvider implements SubagentProvider {
  readonly name = PROVIDER_NAME
  readonly capabilities = CAPABILITIES
  readonly inheritsParentContext = false

  start(request: ResolvedSubagentStartRequest): Promise<SubagentRun> {
    request.signal.throwIfAborted()
    const prompt = promptText(request.prompt)
    starts.push({
      parentId: request.parent.id,
      prompt,
      agentOptions: request.agentOptions,
      hasAgentOptions: Object.hasOwn(request, 'agentOptions'),
    })
    const result: SubagentResult = prompt.includes(FAILURE_MARKER)
      ? { output: [], stopReason: 'error', diagnostic: FAILURE_DIAGNOSTIC }
      : { output: [{ type: 'text', text: SCRIPTED_REPLY }], stopReason: 'completed' }
    return Promise.resolve({
      // 本地一-shot run 的 id 惯例上就是子会话 id；这里没有子会话，所以用 parent 派生一个稳定值。
      id: SessionId(`scripted-subagent:${request.parent.id}`),
      localAgent: undefined,
      result: Promise.resolve(result),
      dispose: () => Promise.resolve(),
    })
  }
}

/**
 * 把脚本化 provider 注册进 `ctx.subagents`。注册即效应，随插件 fiber 一起卸载。
 * @param ctx - 承载注册的上下文。
 */
export function apply(ctx: Context): void {
  ctx.subagents.registerProvider(new ScriptedSubagentProvider())
}
