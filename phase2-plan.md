# ExecutionEngine 阶段 2 实施方案（洞与归属）

范围：把 `dispatchsubagent` 接上 `ctx.subagents`，并把子 agent 归属到**发起的主 agent**。**不移动进 `packages/`，不改仓库任何其他文件。**

依据：[design.md](./design.md) §5.1（归属）与 §12「阶段 2」。

**本阶段不做**：后台 job、单例、取消工具、`report`、UI、执行位置上报。

---

## 0. 结论摘要

| # | 问题 | 结论 |
|---|---|---|
| A | 归属从哪来 | `ToolRunContext.agent`（`packages/core/tools/src/index.ts:322,401`）。**缺失就 fail loud**，不静默挂到别人身上 |
| B | 怎么挂 | `ctx.subagents.start(provider, { prompt, parent, signal })` —— `parent` 是它的一个**入参**（`packages/workflow/workflow-ptc/src/host.ts:200-204`），不是事后补的 |
| C | 用哪个 provider | 进 `Config.subagentProvider`，默认 `spawn`（照 `workflow-ptc` 的 `provider` 字段）。**不写死** |
| D | 失败语义 | 子 agent 的 `stopReason` 不是正常完成时**抛出**，消息里带上 reason。程序自己 `try/catch` |
| E | 结果去哪 | 只回**程序**（经 PTC 控制通道回 vm context），**不进主 agent 上下文** |
| F | 生命周期 | 必须 `await run.dispose()`，放在 `finally` 里（漏了会漏子 agent） |
| G | B 档怎么在无 key 下跑 | fixture 里挂一个**脚本化 provider**（自建，见 §5） |

---

## 1. 动手前的现状

`Workspace/ExecutionEngine/` 是独立 git 仓库，HEAD 是阶段 1 的 `86f99de`，工作区干净。

现有 binding 的接法：`host/process-binding.ts` 导出一个 `createProcessBindings(...)` 之类的工厂，`host/engine.ts` 把它组装进 `bindings: [{ global: 'flow', functions: {...} }]`，`host/index.ts` 在 `run_program` 的 `execute` 里把依赖与上下文传进去。

`host/index.ts` 现在从工具执行上下文取 `exec.signal`；**`exec.agent` 是同一处能拿到的另一个字段**。

两个 fixture 分支互斥：`tests/fixtures/cordis.yml`（`danger-full-access`，跑 B1–B4）与 `tests/fixtures/cordis-confined.yml`（`workspace-write`，跑 B5）。**本阶段的用例挂到前者。**

---

## 2. `dispatchsubagent` 的实现

```ts
export interface SubagentBindingOptions {
  /** 发起本 run 的 agent，所有子 agent 都挂在它下面。 */
  readonly parent: Agent
  /** Config 里的 provider 名。 */
  readonly provider: string
  /** run 级取消信号；子 agent 跟着一起取消。 */
  readonly signal: AbortSignal
  readonly subagents: SubagentRuntime
  /** 用于诊断：provider 起动失败时由调用方决定怎么报。 */
  readonly onStart?: (childId: SessionId) => void
}
```

```ts
async function dispatchsubagent(prompt: string): Promise<string> {
  signal.throwIfAborted()
  const run = await subagents.start(provider, {
    prompt: [{ type: 'text', text: prompt }],
    parent,
    signal,
  })
  try {
    const result = await run.result
    if (result.stopReason !== 'completed') {
      throw new Error(`dispatchsubagent: child stopped with ${result.stopReason}`)
    }
    return result.output
  } finally {
    await run.dispose()
  }
}
```

依据（`packages/workflow/workflow-ptc/src/host.ts:197-238`）：

- `start(provider, { prompt: [{type:'text',text}], parent, signal })` —— **`parent` 就是归属的落点**。
- `await run.result` → `{ output, stopReason, structured? }`。
- `run.dispose()` 必须调用；`workflow-ptc` 用 `disposeChild()` 把 dispose 的结果记忆化并只 warn 失败（`:240-244`）。本插件照做：**dispose 失败只记日志，不改变已选定的结果**。

**`stopReason` 的确切取值集合未验证**——`workflow` 侧出现过 `'completed' | 'error' | 'cancelled'`。执行时读 `packages/subagent/subagent/src/types.ts` 定准；定不准就按"只有 `'completed'` 算成功"处理（保守方向是对的）。

---

## 3. `parent` 从哪来

`host/index.ts` 里 `run_program` 的 `execute(args, exec)`：

```ts
const parent = exec.agent
if (parent === undefined) throw new Error('run_program requires an initiating agent')
```

- `ToolRunContext.agent?: Agent` 是可选字段（`packages/core/tools/src/index.ts:322,401`），所以必须显式判空并**大声失败**——静默地换个 parent 会直接破坏 §5.1 的归属承诺。
- 把 `parent` 与 `exec.signal` 一起放进传给 engine 的请求对象，engine 再传给 binding 工厂。

---

## 4. 文件清单

```
host/subagent-binding.ts   新：dispatchsubagent 的实现（§2）
host/engine.ts             改：把 dispatchsubagent 加进 flow 命名空间；请求对象带 parent
host/index.ts              改：inject 加 'subagents'；取 exec.agent 并判空；传 provider 与 parent
host/config.ts             改：加 subagentProvider（默认 'spawn'）
host/sdk.ts                改：.d.ts 加 declare function dispatchsubagent
tests/fixtures/scripted-subagent-provider.ts  新：无 key 的确定性 provider（§5）
tests/fixtures/cordis.yml  改：挂 subagent 服务 + 脚本化 provider + 本插件的 subagentProvider 配置
tests/loader-driver.ts     改：B6 用例（§6）
tests/host-shape.spec.ts   改：inject 断言加 'subagents'
```

---

## 5. 无 key 的 B 档怎么跑：脚本化 provider

`subagent-spawn-in-process` 注册的 `spawn` 是**真的在进程内起一个 agent**，需要模型 route——keyless 的 fixture 跑不起来。

**做法**：在 `tests/fixtures/scripted-subagent-provider.ts` 里自建一个最小 `SubagentProvider`，照 `packages/subagent/tool-subagent/tests/scripted-provider.ts` 的形态：

- `ctx.subagents.registerProvider({ name: 'scripted', ... })`
- 返回的 `SubagentRun`：`result` 是 `{ output: <固定文本>, stopReason: 'completed' }`，`dispose()` 是空操作
- 记录每次 `start` 收到的 `parent`，供断言归属用

在 `tests/fixtures/cordis.yml` 里用**相对路径行**挂它（loader 支持相对路径行名，阶段 0 已验证）。

自建而不是复用 `packages/.../scripted-provider.ts`：那是别的包的测试内部件，跨目录引用既脆又越界。

---

## 6. 验证

### A 档（执行 agent 自己跑，纯 Node / tsc）

```
pnpm run typecheck
pnpm run test
pnpm run build
node --check lib/client.js
```

判据：四条 exit 0；测试全绿。

### B 档（**由负责人跑**，需要 tsx）

```
cd C:\workspace\Tool\deepseek-harness
node --import tsx/esm Workspace/ExecutionEngine/tests/loader-driver.ts Workspace/ExecutionEngine/tests/fixtures/cordis.yml
```

新增 **B6** 用例，判据：

1. 程序里 `const t = dispatchsubagent('...')` **拿回脚本化 provider 的固定文本**，且该文本出现在 `run_program` 的结果里。
2. **归属正确**：脚本化 provider 记录到的 `parent` **就是发起这个 `run_program` 调用的 agent**（用 `SessionId` 比对，不是"非空"这种弱断言）。
3. **子 agent 的输出不进主 agent 上下文**：本阶段还只能间接说明（结果只经 `output` 回到工具结果）——**明确记为未验证**，等阶段 4/6 有了观察面再补。
4. `provider` 取的是 Config 里的值：把 fixture 的 `subagentProvider` 配成 `scripted`，断言脚本化 provider 被调用了恰好一次。
5. 子 agent 失败路径：让脚本化 provider 返回 `stopReason: 'error'`，断言 `dispatchsubagent` **抛出**且消息里有 `error`。

**B1–B5 的判据与命令一字不改。**

### C 档（**由负责人跑**）

```
$env:DSH_HOME = Join-Path $env:TEMP ('ee-p2-' + [guid]::NewGuid().ToString('N').Substring(0,8))
New-Item -ItemType Directory -Force -Path $env:DSH_HOME | Out-Null
pnpm dsh web --patch Workspace/ExecutionEngine/execution-engine.cordis.yml --host 127.0.0.1 --port 3099 --no-open
```

判据：无 `did not activate` / `required startup failure`；跑完关掉、确认 3099 释放。**不要占 3080。**

### 测试（`pnpm run test`，纯 Node）

- **`tests/subagent-binding.spec.ts`（新）**：用假 `subagents` 对象断言——正常完成返回文本；非 `completed` 抛；`run.dispose()` 被调用；`signal` 已中止时**不调用 start**。
- **`tests/config.spec.ts`（改）**：`subagentProvider` 默认 `'spawn'`、可覆盖。
- **`tests/host-shape.spec.ts`（改）**：`inject` 断言加 `'subagents'`。

---

## 7. 实施顺序

| # | 做什么 | 怎么验证 |
|---|---|---|
| 1 | `host/config.ts` 加 `subagentProvider` | `pnpm run test`（config spec） |
| 2 | `host/subagent-binding.ts` + `tests/subagent-binding.spec.ts` | `pnpm run test` |
| 3 | `host/engine.ts`、`host/index.ts` 接线（含 `exec.agent` 判空） | `pnpm run typecheck` |
| 4 | `host/sdk.ts` 扩展 `.d.ts` | `pnpm run typecheck` |
| 5 | `tests/fixtures/scripted-subagent-provider.ts` + fixture 补行 | `pnpm run test` |
| 6 | `tests/loader-driver.ts` 加 B6 | **由负责人跑 B 档** |
| 7 | 端到端复验 | **由负责人跑 C 档** |
| 8 | 提交 | `git commit -m "阶段 2：洞与归属"` |

---

## 8. 风险与未验证项

| # | 风险 / 未验证 | 处置 |
|---|---|---|
| R1 | `stopReason` 的取值集合 | 执行时读 `packages/subagent/subagent/src/types.ts`；定不准就只认 `'completed'` |
| R2 | 脚本化 provider 的接口面（`SubagentProvider` 要哪些方法）未逐一确认 | 执行时读 `packages/subagent/subagent/src/types.ts` 与 `tests/scripted-provider.ts` |
| R3 | `Agent` 与 `SessionId` 的 import 路径（跨包引用） | 照 `workflow-ptc/src/host.ts:2-8` 的 import 形态 |
| R4 | fixture 里挂 `@deepseek-ai/dsh-subagent` 之后是否还需要别的行才能激活 | `boot()` 的 startup audit 会打印缺哪个 inject，按诊断补 |
| R5 | "子 agent 输出不进主 agent 上下文"本阶段只能间接说明 | 明记为未验证，阶段 4/6 补 |
| R6 | 子 agent 与 run 的取消联动（`signal` 透传）真实行为 | A 档用假对象覆盖逻辑；真实联动由 B6 第 5 条部分覆盖，完整覆盖留到阶段 3 |

---

## 9. 开工前需要负责人裁决的问题

**Q1：`dispatchsubagent` 失败时抛还是返回？** 本方案选**抛**（§0 D）。理由：程序需要知道洞失败了才能决定重试或改道，静默返回一段可能是错误信息的文本会让失败伪装成成功。代价是程序要写 `try/catch`。若你希望对齐 `workflow` 的 `agent()`（"ordinary child failure resolves null"），那就是另一种语义。

**Q2：要不要支持 `structured`？** `SubagentRun.result` 有 `structured` 字段（传 `outputSchema` 才有）。design.md §3.2 只写了 `→ Promise<string>`。本方案**不做**，保持原语面最小；要的话是加一个可选参数。

---

## 10. 参考

- `Workspace/ExecutionEngine/design.md` §5.1 / §5.2 / §12
- `Workspace/ExecutionEngine/phase1-plan.md` —— 上一阶段方案与文档风格
- `packages/workflow/workflow-ptc/src/host.ts:197-244` —— `start` / `result` / `dispose` 的现成形态
- `packages/core/tools/src/index.ts:322,401` —— `ToolRunContext.agent`
- `packages/subagent/tool-subagent/tests/scripted-provider.ts` —— 脚本化 provider 的形态参考
- `packages/subagent/subagent-spawn-in-process/src/index.ts:31,69` —— provider 注册与默认名
