# ExecutionEngine 阶段 5 实施方案（执行位置上报）

范围：让每个原语调用带上**调用点行号**，发 `flow/call-start` / `flow/call-end` 事件，并把「程序源码」补进 `flow/start`。**不移动进 `packages/`，不改仓库任何其他文件。**

依据：[design.md](./design.md) §8.1、§8.3、§12 阶段 5。

**本阶段不做**：UI（阶段 6）、AST 变换（只在 stack 方案被证伪时才做）。

---

## 0. 结论摘要

| # | 问题 | 结论 |
|---|---|---|
| A | 行号从哪来 | `new Error().stack`，在 guest 外壳的包装函数里取。**地基已在**：外壳用 `vm.Script` + `filename: 'flow-program.ts'` + `lineOffset: -1`，`tests/vm-surface.spec.ts` 已有真实栈行号断言 |
| B | 包在哪一层 | guest 外壳里包 `process` / `processOrThrow` / `dispatchsubagent` / `report`。**用户源码一个字不改**，所以行结构不变这条约束继续成立 |
| C | 位置怎么回宿主 | 在 `flow` 命名空间里加一个**内部** `trace` 函数，外壳调它；**不作为程序可见的全局暴露**（程序仍然只看到四个原语） |
| D | 事件 | `flow/call-start` / `flow/call-end`（成对，照 `workflow/agent-start`/`agent-end` 的形态）；「程序源码」折进已有的 `flow/start`，不新开事件 |
| E | 参数与结果的体积 | **必须有界**：事件里放截断预览 + `truncated` 布尔。设计 §8.1 要的是"位置、参数、结果、耗时"，不是把 stdout 全文搬进事件 |
| F | plan B | 只有 stack 被证伪才上 AST 变换。**本阶段不预先实现** |

---

## 1. 动手前的现状

HEAD 是阶段 4 的 `40441cc`，工作区干净。已有事件：`flow/start` / `flow/report` / `flow/end`（`host/flow-events.ts`），`flow/end` 带 `discarded`。

guest 外壳（`host/guest-source.ts`）已经把原语包了一层（`syncThrow: 'none'` 的 async 外壳），行号地基在位。

---

## 2. 行号怎么取

在外壳的包装函数里：

```js
function callSiteLine() {
  const stack = new Error().stack ?? ''
  // 第二帧是用户程序（第一帧是包装函数自己）
  const match = /flow-program\.ts:(\d+):\d+/u.exec(stack)
  return match === null ? null : Number(match[1])
}
```

- 取**用户源码行号**（1-based），拿不到就报 `null`——**不要瞎猜一个数**，`null` 让 UI 明确知道"这一条没有位置"。
- `lineOffset: -1` 已经在位，所以栈里的行号**就是**用户源码行号；**执行时先用一个断言把这件事再钉一次**（`tests/vm-surface.spec.ts` 已有类似断言，扩到包装层）。
- **循环里同一行会重复**：行号相同是正常的，事件按发生顺序排列即可，不要去做"去重"。

---

## 3. 包装与上报

外壳里把每个原语换成包装版：

```js
const wrap = (member, fn) => async (...args) => {
  const line = callSiteLine()
  const start = Date.now()
  trace({ phase: 'start', member, line, args: preview(args) })
  try {
    const value = await fn(...args)
    trace({ phase: 'end', member, line, ms: Date.now() - start, result: preview(value) })
    return value
  } catch (error) {
    trace({ phase: 'end', member, line, ms: Date.now() - start, error: preview(String(error)) })
    throw error
  }
}
```

要点：

- **失败路径也要发 `end`**，否则 UI 会留下永远不闭合的调用。
- `trace` 走 `flow` 命名空间的内部函数；**它不能被程序看见**（程序仍然只有四个原语 + `tmpDir` + 助手 + `console` + `fetch`）。
- `trace` 应当是**尽力而为**的：它失败不能改变程序的行为。外壳里 `try { trace(...) } catch {}`——**这个空 catch 要写清为什么**（"诊断通道不该让业务失败"）。
- `preview(x)` 把任意值折成**有界**字符串：字符串截断、对象 `JSON.stringify` 后再截断、不可序列化回落 `typeof`。**界要写成一个具名常量**。

---

## 4. 事件

`host/flow-events.ts` 加：

| 事件 | payload |
|---|---|
| `flow/call-start` | `{ runId, member, line: number \| null, args: string, argsTruncated: boolean }` |
| `flow/call-end` | `{ runId, member, line: number \| null, ms: number, outcome: 'ok' \| 'error', result?: string, resultTruncated?: boolean, error?: string }` |

并把 `code: string` 加进 `flow/start` 的 payload（设计 §8.1 的「程序源码」）。

**observe-only 纪律不变**：payload 只有数据，没有活动句柄。

**成对承诺**：`flow/call-start` ↔ `flow/call-end` 按 `(runId, member, line, 序号)` 配对。**序号由宿主侧发**（外壳只报 `member`/`line`，宿主按到达顺序编号），因为外壳侧的计数器跨不了重启、也拿不到 job 身份。**执行时确认宿主侧能否为"同一 (member,line) 的重复调用"稳定编号**——这是本阶段最容易出错的地方。

---

## 5. 文件清单

```
host/guest-source.ts     改：包装四个原语、callSiteLine、preview、内部 trace 调用
host/flow-events.ts      改：两个新事件 + flow/start 加 code
host/engine.ts           改：flow 命名空间加内部 trace；把 trace 转成事件
host/job-runner.ts       改：给事件补 runId（若 trace 到达时拿不到）
host/sdk.ts              改：若程序可见面有变化则同步（预计无变化）
tests/vm-surface.spec.ts 改：包装层的行号断言、trace 不外泄断言
tests/loader-driver.ts   改：B13
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

新增 **B13**：

- 程序里在**已知行**上调用 `process`，断言 `flow/call-start.line` **等于那一行的行号**（写死期望值，不要"大于 0"这种弱断言）。
- 断言 `flow/call-start` 与 `flow/call-end` **成对**（数量相等、（member,line）序列一致）。
- 断言**循环里同一行重复出现**时产生多条事件、行号相同（证明没有去重）。
- 断言失败路径也有 `flow/call-end` 且 `outcome === 'error'`。
- 断言 `flow/start.code` 是提交的程序正文。
- 断言**程序可见面没变**（`Object.getOwnPropertyNames` 里仍然没有 `trace`）。

**B1–B12 的命令与判据一字不改。**

### C 档（**由负责人跑**）
`dsh web --patch … --port 3099` + 临时 `DSH_HOME`，判据：无 `did not activate` / `required startup failure`。

---

## 7. 测试（`pnpm run test`，纯 Node）

- **`tests/vm-surface.spec.ts`（改）**：包装层的 `callSiteLine` 在真实外壳 + vm 下返回正确行号；`trace` 不在程序可见全局里；`preview` 的截断与 `truncated` 布尔。
- **`tests/flow-events.spec.ts`（新，若需要）**：成对编号的逻辑（用假 trace 序列）。
- **`tests/job-runner.spec.ts`（改）**：事件发射新增两条不破坏既有断言。

---

## 8. 实施顺序

| # | 做什么 | 怎么验证 |
|---|---|---|
| 1 | 在外壳里验证 `callSiteLine` 真的拿到用户行号（先写断言再实现） | `pnpm run test` |
| 2 | `preview` + 界 + 截断布尔 | `pnpm run test` |
| 3 | 包装四个原语 + 内部 trace | `pnpm run test` |
| 4 | `host/flow-events.ts` 两个新事件 + `flow/start.code` | `pnpm run typecheck` |
| 5 | `host/engine.ts` 把 trace 转成事件 | `pnpm run typecheck` |
| 6 | `loader-driver.ts` 加 B13 | **由负责人跑 B 档** |
| 7 | 端到端 | **由负责人跑 C 档** |
| 8 | 提交 `阶段 5：执行位置上报` | |

---

## 9. 风险与未验证项

| # | 风险 / 未验证 | 处置 |
|---|---|---|
| R1 | `new Error().stack` 在 vm context 里是否带 `flow-program.ts` 与正确行号 | **地基已在**（`vm-surface.spec.ts` 有断言），但**要扩到包装层**——包装函数多了一层帧，正则要取对那一帧 |
| R2 | 同一 `(member, line)` 在循环里重复时的编号稳定性 | 宿主侧按到达顺序编号；B13 专门验 |
| R3 | `trace` 的频率：循环里调 1000 次就是 2000 个事件 | 设计没定额度（§10.1 是 report 的额度）。**本阶段先不加额度**，但在报告里给出实际频率量级；要加就是后续决定 |
| R4 | `trace` 失败的影响 | 外壳侧 `try/catch` 吞掉并**写清理由**；宿主侧 `emit` 已有的收住模式照用 |
| R5 | 事件也是 async 的，包装里 `await trace(...)` 会给每次调用加往返延迟 | **建议不 await**（fire-and-forget 上报），代价是事件顺序可能与调用顺序在极端情况下错位。**执行时判断并说明选哪个** |
| R6 | `flow/call-end` 的 `result` 对 `process` 来说可能很大 | 靠 `preview` 的界，不靠调用方自觉 |

---

## 10. 开工前需要负责人裁决的问题

**Q1：`trace` 要不要 `await`？** 见 R5。倾向**不 await**（不拿程序性能换诊断完整性），代价是事件顺序在压力下可能错位——但 B13 的成对断言在正常路径下仍然成立。**若你更看重顺序保真，就 await。**

**Q2：事件的保留上限。** R3：程序里一个千次循环会产生两千个事件。本阶段不加额度，可以吗？

---

## 11. 参考

- `Workspace/ExecutionEngine/design.md` §8.1、§8.3、§12 阶段 5
- `Workspace/ExecutionEngine/host/guest-source.ts` —— 现有外壳与行号地基
- `Workspace/ExecutionEngine/host/flow-events.ts` —— 事件声明合并
- `packages/workflow/workflow-ptc/src/runtime.ts:75` —— `vm.Script` 的 `lineOffset`
- `Workspace/ExecutionEngine/phase4-plan.md` —— 上一阶段方案与文档风格
