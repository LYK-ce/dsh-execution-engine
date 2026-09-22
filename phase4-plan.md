# ExecutionEngine 阶段 4 实施方案（report 与 flow/* 事件）

范围：加 `report` 原语（单向汇报、走 `followup`）、实现"未投递的 report 作废"、发 `flow/*` observe-only 事件。**不移动进 `packages/`，不改仓库任何其他文件。**

依据：[design.md](./design.md) §6.1–§6.3、§4.4、§8.1、§12 阶段 4。

**本阶段不做**：UI、执行位置上报。

---

## 0. 结论摘要

| # | 问题 | 结论 |
|---|---|---|
| A | `report` 怎么投递 | 构造带 `source` 的 `UserMessage`，调 `owner.followup(message)`（§6.1）。形态照 `packages/jobs/tool-jobs/src/index.ts:278-299` |
| B | 为什么是 followup 不是 inject | §6.1 裁决过了：每条 report 独立成为一个 turn，**严格有序、不打断**，代价是每条一次模型调用 |
| C | "未投递作废"怎么实现 | 记录每次投递的 `MessageId`；取消/结算时对仍挂起的那些调 `owner.inbox.remove(id)`（`packages/core/agent/src/runtime-types.ts:81-84`） |
| D | `report` 是否 await | 是——等**投递成功**，不等主 agent 处理完（§6.3） |
| E | 额度 | **不由引擎管**（§10.1）：程序自己决定报什么、报多少 |
| F | 事件 | `flow/*` observe-only，payload 只带运行身份快照，不带活动句柄（§8.1，照 `workflow/*`） |

---

## 1. 动手前的现状

HEAD 是阶段 3 的 `a5548a8`，工作区干净。`flow` 命名空间现在有 `process` / `processOrThrow` / `tmpDir`（+ 文件助手 + `console` + `fetch`）。

`host/engine.ts` 的 `runProgram` 负责组装 bindings；`host/job-runner.ts` 掌握提交与取消，是"作废"钩子的天然落点。

---

## 2. `report` 的投递

```ts
// host/report-binding.ts
const message = createUserMessage({
  content: [{ type: 'text', text }],
  source: { kind: 'plugin', plugin: 'execution-engine', form: 'notice', summary: reportSummary(text) },
})
owner.followup(message)
delivered.push(message.id)
```

依据（`packages/jobs/tool-jobs/src/index.ts:278-299`）：那里是同一个形状——`createUserMessage` + `source: { kind:'plugin', plugin, form:'notice', summary }`，然后 `owner.followup(message)`。

**待确认（执行时读源码定准）**：

- `createUserMessage` 的 import 路径与它是否自动生成 `id`（`MessageId`）。
- `form: 'notice'` 是仓库既有的呈现形式（`tool-jobs` 用了），我们照用。
- `summary` 是折叠行用的一行摘要，要截断，不能把整段 report 塞进去。

**失败语义**：`report` 是 `async` 的，但只等投递。程序已经中止时（`signal.aborted`）**抛**——程序本来就在被拆掉，静默吞掉会让"报过了"变成假的。

---

## 3. "未投递的 report 作废"

引擎持有本次 run 投递过的 `MessageId` 列表；在**取消**与**结算**两条路径上，对每一个 id 调：

```ts
owner.inbox.remove(messageId)   // Inbox.remove(messageId): boolean
```

- 返回 `true` = 从挂起队列里摘掉了（未投递的那部分）。
- 返回 `false` = 已经被某个 turn 领取（进了主 agent 的上下文），**撤不回来**——这正是 §4.4 说的"已投递的撤不回"，能作废的只有"尚未投递"的。
- 依据：`packages/core/agent/src/runtime-types.ts:81-84`（`remove(messageId): boolean`，"identity of the pending message to remove"）；`Agent.inbox` 在 `:170` 是公开字段。

**为什么这条必须做**：§4.4——用户点了取消之后，排队里的 report 还会把主 agent 叫醒，它可能基于过期信息决定"取消并重启"，把用户刚叫停的东西又跑起来。

**放在哪**：`host/job-runner.ts` 的取消路径与 `done` 结算路径都要挂钩（结算也要，因为正常跑完时可能仍有排队的 report 属于"已经没意义的中间汇报"——**这一条要执行时判断**：正常完成时是否也该作废未投递的？建议**作废**，理由是程序已经结束，它的中间汇报不再有后续语境）。

---

## 4. `flow/*` 事件

照 `workflow/*` 的形态（`packages/workflow/workflow/src/index.ts`）：**声明合并**到 `@deepseek-ai/cordis` 的 `Events`，JSDoc 必须有 `@mode` 与 `@param`。

最小集合（§8.1）：

| 事件 | 何时 | payload |
|---|---|---|
| `flow/start` | job 注册成功 | `{ runId, label, ownerSession }` |
| `flow/report` | 每次 `report` 投递成功 | `{ runId, text }` |
| `flow/end` | job 结算 | `{ runId, status, discarded, detail? }`（`discarded` = 本次真的被作废的未读 report 条数，非取消路径为 `0`） |

**observe-only 纪律**（§8.1）：payload 携带运行身份快照，**不携带活动句柄**——监听者不能借此拿到取消或清理权限。§8.1 是这么要求的，`workflow/*` 也是这么做的。

**注意**：本阶段只发事件，**没有任何消费者**（UI 在阶段 6）。这不违反"要当前消费者"的规矩吗？——不违反：`flow/*` 是**发布给未来的观察面**的，而 §12 阶段 4 明确把它列为本阶段交付物，阶段 6 就是它的消费者。**执行时在代码注释里点明这一点**，免得评审再问一遍。

---

## 5. 文件清单

```
host/report-binding.ts  新：report 的投递与 MessageId 记账
host/flow-events.ts     新：flow/* 的声明合并
host/engine.ts          改：把 report 加进 flow 命名空间；发 flow/start、flow/end
host/job-runner.ts      改：持有投递记账；取消与结算时作废未投递的 report
host/index.ts           改：接线
host/sdk.ts             改：.d.ts 加 report
tests/report-binding.spec.ts 新
tests/loader-driver.ts  改：B11（report 唤醒 + 顺序）、B12（取消后未投递的不再投递）
tests/fixtures/*.yml    改：若需要（`report` 不需要新服务，大概率不用）
```

---

## 6. 验证

### A 档（执行 agent 自己跑）
`pnpm run typecheck` / `pnpm run test` / `pnpm run build` / `node --check lib/client.js`

### B 档（**由负责人跑**）
```
cd C:\workspace\Tool\deepseek-harness
node --import tsx/esm Workspace/ExecutionEngine/tests/loader-driver.ts Workspace/ExecutionEngine/tests/fixtures/cordis.yml
node --import tsx/esm Workspace/ExecutionEngine/tests/loader-driver.ts Workspace/ExecutionEngine/tests/fixtures/cordis-confined.yml
```

新增用例：

- **B11 `report` 真的投递给发起 agent，且顺序与程序调用顺序一致**：程序里 `report('one'); report('two')`，断言发起 agent 的收件箱/inbox 里按序出现这两条，且 `source.plugin === 'execution-engine'`。
  - **怎么观察**：driver 持有发起 agent 实例，可以读它的 inbox 或监听 `agent/inbox/inserted`。执行时定准用哪条路。
- **B12 取消后未投递的 report 不再投递**：让主 agent 处于 busy 状态（或用一个不立即领取的场景），程序投递若干 report 后取消，断言**取消返回之后**那些仍挂起的 report 已经从挂起队列里消失。
  - 这条比较难构造，**执行时若发现构造不出确定性的场景，就如实降级为"逻辑由 A 档的假对象覆盖、真实场景未验证"**，不要造一个必绿的假用例。

### C 档（**由负责人跑**）
`dsh web --patch … --port 3099` + 临时 `DSH_HOME`，判据：无 `did not activate` / `required startup failure`。

---

## 7. 测试（`pnpm run test`，纯 Node）

- **`tests/report-binding.spec.ts`（新）**：用假 `owner`（有 `followup` / `inbox.remove` / `status`）断言——`report` 构造的 message 带正确的 `source`；投递后记住 `MessageId`；已中止时抛；`summary` 来自注入的截断助手（**不是**断言截断本身：`createUserMessage` 与 `boundContextSummary` 在这里都是替身，真实装配与那条 ≤120 上界只由 B 档的 B11 覆盖）。
- **`tests/host-shape.spec.ts`（改）**：若 `inject` 有变化一并改（本阶段预计不变）。

---

## 8. 实施顺序

| # | 做什么 | 怎么验证 |
|---|---|---|
| 1 | 读源码定准 `createUserMessage` 路径与 `MessageId` 生成；定准事件声明合并形态 | — |
| 2 | `host/flow-events.ts` + `host/report-binding.ts` + spec | `pnpm run test` |
| 3 | `host/engine.ts` 接线 + 发 `flow/start` / `flow/end` | `pnpm run typecheck` |
| 4 | `host/job-runner.ts` 作废挂钩 | `pnpm run test` |
| 5 | `host/sdk.ts` `.d.ts` 加 `report` | `pnpm run typecheck` |
| 6 | `loader-driver.ts` 加 B11/B12 | **由负责人跑 B 档** |
| 7 | 端到端 | **由负责人跑 C 档** |
| 8 | 提交 `阶段 4：report 与 flow 事件` | |

---

## 9. 风险与未验证项

| # | 风险 / 未验证 | 处置 |
|---|---|---|
| R1 | `createUserMessage` 的 import 路径与 `id` 生成方式 | 执行时读源码 |
| R2 | `form: 'notice'` 之外还有哪些 form、我们该用哪个 | 读 `source` 的类型定义 |
| R3 | driver 怎么观察"report 已投递"且不把它消费掉 | 执行时定准；必要时监听 `agent/inbox/inserted` |
| R4 | B12 的确定性构造 | 构造不出就如实降级，**不造必绿的假用例** |
| R5 | 事件声明合并的确切模块入口 | 照 `workflow/src/index.ts` 与 `packages/AGENTS.md` 的事件 JSDoc 要求 |
| R6 | 正常结束时是否也作废未投递的 report | 见 §3，建议作废；执行时确认 `inbox.remove` 在结算时仍可用 |
| R7 | 与 `tool-jobs` 完成通知的关系 | **已记账**：design.md §6.4 末尾。本阶段不处理 |

---

## 10. 开工前需要负责人裁决的问题

**Q1：正常完成时要不要也作废未投递的 report？** 建议**要**（程序已结束，中间汇报失去后续语境）。但这会让"最后一条 report 刚投出去、程序立刻结束"这种时序下丢掉末条汇报——**执行时确认 `followup` 投递的消息是"已投递"还是仍算"未投递"**。如果 `followup` 投出后仍在挂起队列里（等主 agent 领取），那"结算即作废"会把正常汇报也吃掉，**那就只在该 report 属于"取消"路径时作废**。**这条请执行时读源码定准后再定，别照搬本方案。**

**Q2：`flow/*` 事件名。** 用 `flow/start` / `flow/report` / `flow/end`。可以吗？

---

## 11. 参考

- `Workspace/ExecutionEngine/design.md` §4.4、§6.1–§6.3、§8.1、§10.1、§12
- `packages/jobs/tool-jobs/src/index.ts:278-299` —— 完成通知的投递形态（本方案 §2 的模板）
- `packages/core/agent/src/runtime-types.ts:81-84,170` —— `Inbox.remove` 与 `Agent.inbox`
- `packages/workflow/workflow/src/index.ts` —— `workflow/*` 事件声明合并的形态
- `Workspace/ExecutionEngine/phase3-plan.md` —— 上一阶段方案与文档风格
