# ExecutionEngine 阶段 8 实施方案（按调用指定子 agent 模型）

范围：给 `dispatchsubagent` 加上"按调用指定 `{ provider, model }`"，让引擎读**同一份** `subagent-model-selection` 策略做校验，`.d.ts` 指向 `list_subagent_models` 而不抄目录。**不移动进 `packages/`，不改仓库任何其他文件。**

依据：[design.md](./design.md) §3.2、§5.1、§12；本轮由负责人裁决的四条见 §0。

> 说明：本文档由负责人撰写。原定由规划 subagent 产出，该 agent 连续两轮未落盘，已打断；执行与独立评审仍由 subagent 承担。

---

## 0. 结论摘要（含负责人已定的裁决）

| # | 问题 | 结论 |
|---|---|---|
| A | 程序可见面 | `dispatchsubagent(prompt, opts?: { provider?, model? })`。**只加这两个**，不加 `reasoningEffort` |
| B | 不填参数 | 继承父 agent 的路由（`agentOptions` 不传）——**现有语义不变** |
| C | 校验来源 | **同一份** `ctx.subagentModelSelection`（`subagent-model-selection` 策略），不新造第二份白名单 |
| D | 怎么读 | `ctx.get('subagentModelSelection')` —— **不进 `inject`**（理由见 §3.1，与 `connection` 同一条） |
| E | 服务缺席时 | **拒绝显式指定**（没有策略就没有授权来源）；不指定照常跑 |
| F | `.d.ts` | **不抄目录**，指向 `list_subagent_models` |
| G | 快照 | 插件自己的 **golden 断言**（把 `.d.ts` 渲染文本逐字钉住）；仓库级 `snapshots/` 记为**迁移欠账**（理由见 §7） |

---

## 1. 动手前的现状

HEAD 是阶段 7 的 `62af92b`，工作区干净。

- `host/subagent-binding.ts:83` 的 `runSubagent` 调 `options.subagents.start(options.provider, { prompt, parent, signal })` —— **没有 `agentOptions`**。
- `readPrompt`（`:164-173`）只认字符串 `prompt`。
- 下一层已就绪：`SubagentStartRequest.agentOptions?: AgentOptions`（`packages/subagent/subagent/src/types.ts:171`）、能力位 `SubagentCapabilities.agentOptions`（`:130-131`）、`subagent-spawn-in-process` 声明 `agentOptions: true`；`resolveChildAgentOptions` 把请求**合并到父 agent 之上**（`packages/subagent/subagent/src/child-agent.ts:99-109`）。
- **能力位由 service 自己校验**：`packages/subagent/subagent/src/index.ts:641-643` 的 `assertCapabilities` 里有 `{ when: request.agentOptions !== undefined, cap: 'agentOptions' }`。**我们不需要再查一遍**。
- `host/sdk.ts` 的 `sdkText(timeouts)` 生成 `.d.ts`；`dispatchsubagent` 的声明在其中。

---

## 2. 参数契约

```ts
dispatchsubagent(prompt: string, opts?: { provider?: string; model?: string }): Promise<string>
```

解析规则（`readRequest` 取代 `readPrompt`）：

| 输入 | 行为 |
|---|---|
| 只有 `prompt` | 继承父 agent（现状） |
| `provider` + `model` 都是非空字符串 | 校验后转发成 `agentOptions: { provider, model }` |
| **只给 `model`** | **抛**：`model` 需要 `provider` —— 措辞对齐 `list_subagent_models`（`packages/subagent/tool-subagent/src/list-models.ts:46-48` 的 "`model` requires `provider`"） |
| **只给 `provider`** | **抛**：要么两个都给，要么都不给。只给 provider 会变成"用这个 provider 配父 agent 的 model"，而那对组合未必存在 |
| 给了空串 / 非字符串 | **抛**（与 `list_subagent_models` 的 `must be non-empty` 同形） |

**为什么只给 model 要抛而不是回落到父 provider**：那会静默地把"我要 X 模型"变成"我要父 provider 下的 X 模型"——如果 X 不在那个 provider 下，失败点就被推到了下游看不见的地方。

---

## 3. 校验

### 3.1 怎么拿到策略

`ctx.get('subagentModelSelection')`，**不进 `inject`**。

理由与 `connection` 完全相同：这份策略是 **web-app bundle** 挂的（`packages/bundle/web-app/cordis.patch.yml:47`），不是 preset 也不是引擎的必需品。进 `inject` 就等于"没有 web-app bundle 的部署连 `run_program` 都不注册"——那正是阶段 6 我们改掉的那类错误。**引擎本体不该被客户端/部署特性绑架。**

### 3.2 校验什么

```ts
const policy = ctx.get('subagentModelSelection')?.current()
// policy = { enabled: boolean, allowedModels: [{ provider, model }] }
```

- 指定了 `{ provider, model }` 时，**必须**满足：策略在场 **且** 该 route 逐字命中 `allowedModels` 里的某一项。
- 否则抛，错误信息要带上：这条 route、以及**当前允许的 route 列表**（照 `list-models.ts:23-27` 的形态——让模型能自我纠正，而不是只被告知"不行"）。
- 策略缺席 / `enabled: false` / `allowedModels` 为空 → 一律拒绝显式指定，错误里说清是部署没有授权任何路由。

**不额外校验 `model` 是否在 LLM 目录里。** `LlmModelInfo` 的文档原话是 "catalog membership is **advisory**, not request validation"，拿 advisory 的东西做 enforcement 是错的；而 route 命中 `allowedModels` 已经**蕴含**了模型是用户允许的。同理**不查 `ctx.llm.listProviders()`**——那会给引擎拉进第三个可选服务，而"策略里列了一个没注册的 provider"是部署配置错误，会在 `start` 处响亮失败。

**也不查 `capabilities.agentOptions`**：service 自己查（§1）。我们加一道只是重复。

### 3.3 校验的时点

**每次 `dispatchsubagent` 被调用时**，在 binding 内。

理由：校验的对象是**这一次调用的参数**，参数只有到调用时才存在；程序是字符串，run 启动时静态分析它的参数不在范围内。失败以异常形式回到程序——这正是"洞"的语义（design.md §3.3：失败不是异常**是给 `process` 退出码的**；而这里 `dispatchsubagent` 本来就以抛表达非正常完成）。

---

## 4. `.d.ts` 措辞（`host/sdk.ts`）

`dispatchsubagent` 的声明改成：

```ts
declare function dispatchsubagent(
  prompt: string,
  opts?: { provider?: string; model?: string },
): Promise<string>
```

正文补三句（**不抄目录**）：

1. `provider` / `model` 一起给，才能指定这一步用哪个模型；两个都不给就是沿用当前会话的模型。
2. **这两个 id 用 `list_subagent_models` 查**（不带参数列 provider，带 `provider` 列它的 model）。查不到就说明这个部署没有开放任何可选路由——**不要猜 id**。
3. 不在部署允许清单里的 route 会在调用时被拒绝，错误里会列出可用的 route。

---

## 5. 文件清单

```
host/subagent-binding.ts   改：readPrompt → readRequest；runSubagent 接受可选 route 并转发 agentOptions；校验
host/engine.ts             改：把策略读取（或一个 policy 访问器）接进 binding 依赖
host/index.ts              改：接线（ctx.get('subagentModelSelection')）
host/sdk.ts                改：.d.ts 声明与正文
README.md                  改：新参数的用法、部署前提（必须配 allowedModels）、以及"发现走 list_subagent_models"
design.md                  改：§3.2 的原语清单与 §12 追加阶段 8；把"模型选择"记进设计
tests/subagent-binding.spec.ts  改：新增用例（见 §6）
tests/sdk-text.spec.ts     新：`.d.ts` 渲染文本的 golden 断言
tests/loader-driver.ts     改：B15
tests/fixtures/*.yml       改：挂 subagent-model-selection-settings 并配 allowedModels
```

---

## 6. 验证

### A 档（执行 agent 自己跑）
`pnpm run typecheck` / `pnpm run test` / `pnpm run build` / `node --check lib/client.js`

新增单测（用假 `subagents` + 假策略）：

- 不填 `opts` → `start` 收到的请求**没有** `agentOptions`（继承语义没变）
- 给了合法 route → `start` 收到 `agentOptions: { provider, model }`，且 `prompt`/`parent`/`signal` 一字不变
- 只给 `model` → 抛，消息含 `requires provider`
- 只给 `provider` → 抛
- route 不在 `allowedModels` → 抛，且**消息里列出可用 route**
- 策略服务缺席 → 抛
- `enabled: false` 或空清单 → 抛
- 空串 / 非字符串 → 抛，且**不产生 `start` 调用**
- 已中止 → 抛，且不产生 `start` 调用

**golden 断言**：给定固定的 `timeouts`，`sdkText(...)` 的整段输出逐字相等。这是模型可见面的 keyless 钉子。

### B 档（**由负责人跑**）
```
cd C:\workspace\Tool\deepseek-harness
node --import tsx/esm Workspace/ExecutionEngine/tests/loader-driver.ts Workspace/ExecutionEngine/tests/fixtures/cordis.yml
node --import tsx/esm Workspace/ExecutionEngine/tests/loader-driver.ts Workspace/ExecutionEngine/tests/fixtures/cordis-confined.yml
```

新增 **B15**：fixture 里挂 `subagent-model-selection-settings`（`config: { enabled: true, allowedModels: [{provider:'scripted-provider', model:'scripted-model'}] }`）并让脚本化 provider 记录每次 `start` 收到的完整请求，然后：

- 程序里 `dispatchsubagent(p, { provider, model })` → 断言脚本化 provider 收到的 `agentOptions` **逐字等于** `{ provider, model }`
- 程序里不填 → 断言收到的请求**没有** `agentOptions`
- 程序里给一条**不在清单**的 route → 断言 `dispatchsubagent` 抛出，且消息里含可用 route
- 程序里**只给 model** → 断言抛出且消息含 `requires provider`

**B0–B14b 的命令与判据一字不改。**

### C 档（**由负责人跑**）
`dsh web --patch … --port 3099` + 临时 `DSH_HOME`，判据照旧：无 `did not activate` / `required startup failure`；三条路由判据（200 / 400 / 200）。
**外加一条本阶段特有的**：C 档的组合里 `subagent-model-selection-settings` 是 web-app bundle 挂的，所以 `ctx.get('subagentModelSelection')` **应该在场**——这是"引擎读得到真实策略"的实证。

---

## 7. 关于 keyless 快照：能做与不能做

`snapshots/AGENTS.md` 第 3 行要求"每个被测进程都经 **`dsh` CLI + 一个 shipped profile**（+ 可选 scenario patch）启动"。而本插件不在任何 shipped profile 里（它是 `--patch` overlay），录制还要 key，产物要落 `snapshots/`——**在我们被授权的改动范围之外**。

所以：

- **本阶段做**：插件自己的 **golden 断言**（§6），把 `.d.ts` 渲染文本逐字钉住。这正对上仓库那句 "pin stable model-visible text verbatim"，且不需要 key、不需要 `dsh` CLI。
- **本阶段不做**：仓库 `snapshots/` 那一份。**记为迁移欠账**——迁移后插件进了 shipped profile（`bundle/web-app/cordis.patch.yml` 加行），那一次 PR 才录得出来。README 与 design.md 都要写清这条。

---

## 8. 实施顺序

| # | 做什么 | 怎么验证 |
|---|---|---|
| 1 | `readRequest` + 单测（先写断言再实现） | `pnpm run test` |
| 2 | 校验（策略读取 + route 命中） | `pnpm run test` |
| 3 | 转发 `agentOptions` | `pnpm run test` |
| 4 | `host/index.ts` 接线 `ctx.get('subagentModelSelection')` | `pnpm run typecheck` |
| 5 | `sdk.ts` `.d.ts` + `tests/sdk-text.spec.ts` golden | `pnpm run test` |
| 6 | fixture 挂策略 + `loader-driver.ts` 加 B15 | **由负责人跑 B 档** |
| 7 | README / design.md 同步 | 人读 |
| 8 | 端到端 | **由负责人跑 C 档** |
| 9 | 提交 `阶段 8：按调用指定子 agent 模型` | |

---

## 9. 风险与未验证项

| # | 风险 / 未验证 | 处置 |
|---|---|---|
| R1 | `ctx.subagentModelSelection` 的**确切服务名与 `current()` 形态** | 已读 `model-selection-settings.ts:45-98` 确认：`super(ctx, 'subagentModelSelection')`、`current(): { enabled, allowedModels }` |
| R2 | 策略在 run 期间变化 | 我们每次都读 `current()`（比 `tool-subagent` 的"组合时快照"更新）；这是差异，要在 design.md 里写明 |
| R3 | 脚本化 provider 是否接受 `agentOptions` | 它是我们自建的 `SubagentProvider`，**必须声明 `capabilities.agentOptions: true` 并记录收到的请求**，否则 service 的 `assertCapabilities` 会拒 |
| R4 | fixture 挂 `subagent-model-selection-settings` 后还要不要别的行 | `boot()` 的 startup audit 会报缺哪个 inject，按诊断补 |
| R5 | 仓库级快照 | 见 §7，**记为迁移欠账**，不硬够 |
| R6 | 错误消息里列出可用 route 会不会太长 | `allowedModels` 是人工维护的小清单；若有风险就截断并加省略号（照 `boundContextSummary` 的做法） |

---

## 10. 开工前需要负责人裁决的问题

**Q1：策略服务缺席时"拒绝显式指定"，对吗？** 备选是"不校验、放行"。我选拒绝：没有策略就没有授权来源，放行会把我们刚要修的那个不一致重新造出来。

**Q2：只给 `provider`（不给 `model`）→ 拒绝，可以吗？** 备选是"用父 agent 的 model"。

**Q3：仓库级 `snapshots/` 记为迁移欠账、本阶段用插件自己的 golden 断言顶上，可以吗？**（见 §7）

---

## 11. 参考

- `packages/subagent/tool-subagent/src/list-models.ts` —— 发现工具的形态、错误措辞、"catalog membership is advisory"
- `packages/subagent/tool-subagent/src/model-selection-settings.ts` —— 策略服务的服务名、`current()`、schema 默认值
- `packages/subagent/subagent/src/types.ts:130-171`、`child-agent.ts:99-109` —— `agentOptions` 与合并语义
- `snapshots/AGENTS.md` —— 仓库级快照为什么本阶段做不了
- `Workspace/ExecutionEngine/phase7-plan.md` —— 上一阶段方案与文档风格
