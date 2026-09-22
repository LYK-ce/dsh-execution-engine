# ExecutionEngine 阶段 6 实施方案（侧边栏面板 · Client）

范围：client 半边 + `conversation.view` 面板（源码带行号、当前行、调用轨迹、运行状态、取消按钮）+ locale 字典。**不移动进 `packages/`，不改仓库任何其他文件。**

依据：[design.md](./design.md) §8.2、§8.4、§12 阶段 6。

---

## 0. 结论摘要

| # | 问题 | 结论 |
|---|---|---|
| A | **`flow/*` 怎么到浏览器**（本阶段必须先解决） | **Cordis 事件出不了宿主进程。** 用 host 的 **fetch route + 客户端轮询**——`flow/*` 的宿主侧累加器作为事件消费者，路由把累加结果发给浏览器。这正是 Blackboard 在同一个 workspace 里跑通的形态 |
| B | slot | `conversation.view`，`ctx.slots.inject(...)` + `ctx.slots.register(...)`（Blackboard 同款） |
| C | 取消按钮 | POST 到本插件自己的路由 → 调**与 `cancel_program` 完全相同**的那条取消路径（§4.4 的"同一个逻辑取消"） |
| D | 面板内容 | 源码（带行号）+ 当前行高亮 + 调用轨迹（最近 N 条）+ 运行状态；数据全部来自 `flow/*` |
| E | 文案 | 走 locale 字典（en / zh），不硬编码 |
| F | 单例的额外好处 | 面板无选择器、无多标签：**当前在跑的那一个**就是它 |

---

## 1. 动手前的现状

HEAD 是阶段 5 的 `38e0719`，工作区干净。`client/index.ts` 目前是一个空的 `apply`（阶段 0 的占位），`lib/client.js` 由 `build/build-client.mjs` 从 `client/index.ts` 打包，`package.json` 已声明 `dsh.client` 与 `exports['./client']`。

宿主侧事件已齐：`flow/start`（含 `code`）、`flow/call-start`、`flow/call-end`（含 `synthetic`）、`flow/report`、`flow/end`（含 `discarded`）。

---

## 2. 数据通道（本阶段的关键）

```
flow/* (Cordis 事件，宿主进程内)
   └─> host 侧「当前 run 累加器」        ← 本阶段给 flow/* 的第一个真实消费者
          └─> GET  /api/execution-engine.state?sessionId=…&since=…
                 └─> 浏览器轮询（增量）
POST /api/execution-engine.cancel?sessionId=…
   └─> 同一条取消路径（与 cancel_program 完全一致）
```

**为什么不用 session log**：`flow/*` 是 Cordis 观察事件，不是会话事件；把它们改成会话事件是一次更大的改动（要动 `SessionEventMap` 与持久化），而本轮的目标是把面板做出来。**这条取舍要写进模块注释**，并把"将来若要面板可回放，可以把 `flow/*` 落成 log-only 会话事件"记进 design.md 的已知限制。

**累加器的状态**（每会话一份，只保留当前那一个 run——单例）：

- `runId` / `label` / `status`
- `code`（源码，逐字）与其行数
- `calls`：按 `callId` 有序的 `{ callId, member, line, state: 'open'|'ok'|'error', ms?, preview?, synthetic? }`
- `reports`：`{ text, discardedAt?: number }[]`
- `endedAt` / `detail` / `discarded`

**有界**：`calls` 与 `reports` 各留最近 N 条（具名常量），`since` 增量化不要求服务端保留全量。

---

## 3. 面板

`conversation.view`，props 用 `PropsRuntime<'conversation.view'>`（Blackboard 的 `panel.tsx` 是模板）。渲染：

1. **状态行**：run 的 `label` + `status`（running / completed / killed / failed）+ 起止时间
2. **源码**：带行号；**当前行高亮** = `calls` 里最后一条 `state === 'open'` 的 `line`；没有开着的调用时不高亮任何行
3. **调用轨迹**：最近 N 条 `calls`，每条显示 `行号 · member · 状态 · 耗时`；`synthetic` 的那条要**显式标记**（它表示"程序在结算前终止"，与程序自己报的结局不同）
4. **report 列表**：最近的 report 文本；`flow/end` 之后被作废的那些要有区分（`discarded` 条数）
5. **取消按钮**：仅在 `running` 时可点；点击后 POST，按钮进入"取消中"直到 run 真的结算（§4.4：取消返回时清理已完成）

**不做**：图表、虚拟滚动、历史 run 列表（单例之下没有多 run）。

---

## 4. 文件清单

```
host/flow-state.ts        新：每会话的 run 累加器（flow/* 的消费者）+ 增量快照
host/routes.ts            新：两条 fetch route 的注册与处理
host/index.ts             改：inject 加 'connection'；注册路由；把 flow/* 接到累加器
client/index.tsx          改：slots.inject + register；两条 fetch；轮询源
client/panel.tsx          新：面板组件
client/locale.ts          新：en / zh 字典
shared/protocol.ts        新：两条路由常量（照 Blackboard 的 shared/protocol.ts）
tests/flow-state.spec.ts  新：累加器的纯逻辑（有界、增量、状态迁移）
tests/loader-driver.ts    改：B14（路由返回的状态与事件一致）
```

**`client/index.ts` → `client/index.tsx`**：面板是 JSX，所以要改扩展名；`tsconfig.client.json` 的 include 已经覆盖 `.tsx`，`build-client.mjs` 的入口要同步改。**执行时确认这两处**。

---

## 5. 验证

### A 档（执行 agent 自己跑）
`pnpm run typecheck` / `pnpm run test` / `pnpm run build` / `node --check lib/client.js`
外加：**`lib/client.js` 里必须出现面板的模块 id 与 locale 键**（用 `Select-String` 断言，`lib/` 不进 git，所以要当场验）。

### B 档（**由负责人跑**）
```
cd C:\workspace\Tool\deepseek-harness
node --import tsx/esm Workspace/ExecutionEngine/tests/loader-driver.ts Workspace/ExecutionEngine/tests/fixtures/cordis.yml
node --import tsx/esm Workspace/ExecutionEngine/tests/loader-driver.ts Workspace/ExecutionEngine/tests/fixtures/cordis-confined.yml
```

新增 **B14**：在真实组合里跑一个含多次调用与一条 report 的程序，然后**直接调路由的处理函数**（或经 driver 的 fetch 桩）断言：

- 状态里的 `code` 与提交的一致；
- `calls` 的行号序列与 `flow/call-*` 事件一致、成对；
- `reports` 有序；
- `since` 增量：第二次取只回新增的部分；`since` 过大时回退成全量（并说明这一点）。
- 取消路由：调一次，断言最终状态是 `killed`，且**返回时** run 的临时目录已清（复用 B9 的判据形态）。

**B1–B13 的命令与判据一字不改。**

### C 档（**由负责人跑**）
`dsh web --patch … --port 3099` + 临时 `DSH_HOME`，判据：无 `did not activate` / `required startup failure`。
**外加一条本阶段特有的**：用 HTTP 取一次 `GET /api/execution-engine.state?sessionId=…`，断言返回 200 且 JSON 结构正确（**这能在没有浏览器的情况下验证路由真的挂上了**）。

### GIF

design.md §12 阶段 6 要求"录一段 GIF 作为验证产物"（仓库对 GUI 变更的硬要求）。**本会话能否驱动浏览器未验证**：

- 若可用：按 `record-browser-gif` 技能产出，放进 `Workspace/ExecutionEngine/` 下并随提交入库。
- **若不可用**：**不要伪造**。如实记为"未产出——本会话没有可用的浏览器控制"，并说明它在什么环境产出（负责人手跑 `dsh web` 时）。**这条要写进报告与 design.md 的已知限制。**

---

## 6. 测试（`pnpm run test`，纯 Node）

- **`tests/flow-state.spec.ts`（新）**：累加器的纯逻辑——事件序列折叠成状态；`calls` 与 `reports` 的有界性（超界丢最旧）；`since` 增量的边界（`since === 最新`、`since` 指向已丢弃的条目、`since` 大于最新）；`synthetic` 标记透传；run 结算后的状态。
- **`tests/host-shape.spec.ts`（改）**：`inject` 断言加 `'connection'`。
- **`tests/overlay.spec.ts`（改）**：`build-client.mjs` 的入口从 `index.ts` 改成 `index.tsx`（若有断言涉及）。

---

## 7. 实施顺序

| # | 做什么 | 怎么验证 |
|---|---|---|
| 1 | `shared/protocol.ts` + `host/flow-state.ts` + spec | `pnpm run test` |
| 2 | `host/routes.ts` + `host/index.ts` 接线（inject 加 `connection`） | `pnpm run typecheck` |
| 3 | `client/locale.ts` | `pnpm run typecheck` |
| 4 | `client/index.tsx` + `client/panel.tsx` | `pnpm run build` + `node --check` + 模块 id 断言 |
| 5 | `build/build-client.mjs` 入口改 `.tsx` | `pnpm run build` |
| 6 | `loader-driver.ts` 加 B14 | **由负责人跑 B 档** |
| 7 | 端到端（含一次 HTTP 取路由） | **由负责人跑 C 档** |
| 8 | GIF | 见 §5；不可用则如实记 |
| 9 | 提交 `阶段 6：侧边栏面板` | |

---

## 8. 风险与未验证项

| # | 风险 / 未验证 | 处置 |
|---|---|---|
| R1 | **`ctx.connection.fetch.register` 的确切契约**（路径前缀、`requestBody`、返回形态） | 照 `Workspace/Blackboard/host/routes.ts` 抄；执行时读源码确认 |
| R2 | **`conversation.view` 的 SlotMap 行与作用域**（会话作用域标准位） | 照 Blackboard 的 `panel.tsx` 与其注释；执行时读 `packages/client/ui-conversation` 确认 |
| R3 | 轮询间隔与取消按钮的响应性 | 给一个具名常量；单例之下只有一份状态，轮询成本低 |
| R4 | 客户端插件导出纪律：只导出 cordis 加载需要的 `apply`/`inject` | `packages/client/AGENTS.md` 明文要求；执行时核对 |
| R5 | locale 文案必须走字典（`verify-client-ui-i18n` 会拒硬编码） | 全部走 `t` |
| R6 | `client/index.ts` → `.tsx` 的连带改动（`build-client.mjs` 入口、spec 断言） | 执行时逐一确认 |
| R7 | **GIF 能否产出** | 见 §5；不可用则如实记，**不伪造** |
| R8 | 面板是否该显示"程序源码"全文（可能几十 KB） | 折叠 + 只渲染可视区域附近；本阶段先简单折叠，不做虚拟滚动 |

---

## 9. 开工前需要负责人裁决的问题

**Q1：数据通道用 fetch route + 轮询（本方案），还是把 `flow/*` 落成 log-only 会话事件？**
- **(甲) fetch route + 轮询**：照 Blackboard 的成熟形态，改动小，`flow/*` 有真实消费者；代价是面板实时性取决于轮询间隔，且**面板不可回放**（刷新后要等下一次轮询才有状态）。
- **(乙) log-only 会话事件**：面板可回放、与既有 `tool/ptc-dispatch` 同类；代价是要动 `SessionEventMap` 与持久化，改动面大得多。

**建议 (甲)**，并把"可回放"记进 design.md 的已知限制。

**Q2：取消按钮点下之后，面板怎么表现？** 建议：按钮进入 disabled + "取消中"，直到 run 结算（因为 §4.4 的取消本来就是"返回时清理已完成"）。等不等这次 POST 返回都行，**执行时选一个并说明**。

**Q3：`flow-state` 的保留条数 N** 建议 200 条调用、50 条 report（具名常量）。可以吗？

---

## 10. 参考

- `Workspace/Blackboard/client/index.tsx`、`client/panel.tsx`、`host/routes.ts`、`host/store.ts`、`shared/protocol.ts` —— **本阶段的主要模板，逐处对照**
- `Workspace/ExecutionEngine/design.md` §8.2、§8.4、§12 阶段 6
- `packages/client/AGENTS.md` —— 客户端插件纪律（导出面、slot、locale）
- `Workspace/ExecutionEngine/host/flow-events.ts` —— 面板的数据来源
