# ExecutionEngine 阶段 7 实施方案（收尾）

范围：README、结清 §13 的待定项、审计并补齐回归测试、写出"搬进 `packages/`"的决策与步骤（**不执行**）。**不改仓库任何其他文件。**

依据：[design.md](./design.md) §12 阶段 7、§13。

**本阶段明确不做**：真正的 `packages/` 迁移——负责人已定"集成之后再做"。本阶段只产出**迁移方案**。

---

## 0. 结论摘要

| # | 做什么 | 判据 |
|---|---|---|
| A | `Workspace/ExecutionEngine/README.md` | 一个新人照着能跑起来；每条现状都能在代码里指到 |
| B | 结清 design.md §13 的 7 项待定 | 每项要么给结论+依据，要么明确留下并说明为什么还开着 |
| C | 回归测试审计 | 逐条对照 §13 第 5 条的覆盖要求；缺的补上，已有的指出证据 |
| D | `packages/` 迁移方案 | 写成文档，**不动 `packages/`** |

---

## 1. 动手前的现状

HEAD 是阶段 6 的 `07af417`，工作区干净。阶段 0–6 全部提交，A/B/C 三档在所有阶段都跑过。

代码布局（扁平）：

```
host/     index / engine / job-runner / jobs-types / flow-events / flow-state / routes
          process-binding / subagent-binding / report-binding / guest-source / capabilities
          config / tmp-dir / sdk / tool
client/   index.tsx / panel.tsx / locale.ts
shared/   protocol.ts
tests/    8 个 spec + loader-driver.ts（B 档驱动）+ 2 个 fixture
build/    build-client.mjs
```

---

## 2. README 写什么

照 `Workspace/Blackboard/README.md` 的组织方式（中文、目录树、安装、挂载、判据），但**内容按本插件自己的事实写**。至少覆盖：

1. **一句话定位** + 链接 design.md
2. **它是什么**：主 agent 产出一段程序交给独立引擎执行；程序的洞派子 agent、确定步骤跑外部程序
3. **四个原语** + 程序可见的能力面（含"没有 `import`"这条取舍）
4. **目录树**（含每个 `host/` 文件的职责一句话）
5. **怎么挂**：`pnpm install && pnpm run build`，然后 `pnpm dsh web --patch …`；**并写明为什么必须先 build**（`dsh.client` 声明了就必须有 `lib/client.js`，否则整个 `dsh web` 起不来）
6. **配置**：`process.defaultTimeoutMs` / `process.maxTimeoutMs` / `subagentProvider`，以及超上限在解析期拒绝
7. **怎么跑测试**：A 档（纯 Node）/ B 档（需要 tsx，两条 fixture 的命令与判据）/ C 档（`dsh web` + 临时 `DSH_HOME` + 三条路由判据，含 token→cookie 那一步）
8. **已知限制**（本节最重要，逐条都要能指到 design.md 或代码）：
   - vm 扣留是**引导不是安全边界**（可逃逸，实测过）
   - `report` 每条一次模型调用；额度不由引擎管
   - 没有续跑：取消 + 重启 = 全量重跑，副作用会重来
   - **面板不可回放**（走轮询而非会话事件）
   - `tool-jobs` 在本插件的 job 上仍会投递完成通知、模型也能用 `job_output`（design.md §6.4 末尾）
   - Windows fallback owner 下 `waitForExit` 只保证直接子进程
   - 插件卸载会取消在跑的程序（design.md §4.4）
   - GIF 未产出及原因
9. **接口边界**：插件导出面（`name`/`inject`/`Config`/`apply`）、客户端导出面（`apply`/`inject`）

---

## 3. 结清 design.md §13

逐项给出结论，**并说明依据在哪**（文件:行 或测试名）：

| # | 待定项 | 预期结论 |
|---|---|---|
| 1 | 包怎么拆 | 现在是扁平的 `host/`/`client/`/`shared/`；**迁移到 `packages/` 时怎么拆**见 §4 |
| 2 | `flow/*` 事件清单 | 已定：5 个事件 + payload 字段；给出现状 |
| 3 | `.d.ts` 生成方式 | 已定：手写 `sdkText(timeouts)`（**并说明为什么不用 `jsonSchemaToTs`**：我们的"工具"是程序里的函数，不是注册表里的工具） |
| 4 | `flow.tmpDir` 命名与形态 | 已定：`flow.tmpDir`，会话工作目录下的 `.execution-engine/<runId>/` |
| 5 | 测试范围 | 见 §5 的覆盖表 |
| 6 | 面板形态 | 已定：有界保留、开窗渲染、`synthetic` 显式标记；**未做**：虚拟滚动 |
| 7 | 行号映射 | 已定：`new Error().stack` + `lineOffset: -1`；AST 变换是 plan B，**未启用** |

**要求**：不要只写"已完成"——每一项都要写**结论是什么**，否则 13 节就白留了。

---

## 4. `packages/` 迁移方案（写文档，不执行）

写进 README 的一节或 `design.md` 的附录，内容至少包括：

1. **包怎么拆**：建议 `packages/execution-engine/` 下三个包——`engine`（宿主引擎 + guest 外壳）、`tool-execution-engine`（两个模型可见工具 + `.d.ts` 段）、`client-execution-engine`（面板）。给出依赖方向。
2. **必须改的东西**（逐条、可执行）：
   - 包名改成 `@deepseek-ai/dsh-*`；`private: true` 去掉（或按发布策略）
   - `pnpm-workspace.yaml` 的 `packages/*/*` 会自动覆盖；`tsconfig` 改成仓库的 face 规范（`tsconfig.host.json` / `tsconfig.client.json` 叶 + solution-only 根）
   - 客户端包要接三个注册面（`tsconfig.client.json` 聚合 references、`bundle/web-app/cordis.patch.yml` 行、`bundle/web-app/package.json` 依赖）
   - 补 `README.md`（含 Model Experience 段）与 `Known Limitations and Deferred Work`——`verify-package-readme-*` 会查
   - `pnpm run test:coverage` 的**逐文件 100%** 要求：列出当前哪些文件没有覆盖（例如 `host/tmp-dir.ts` 若真没有 spec）
   - `verify-client-ui-i18n`、`verify-export-jsdoc`、`verify-cordis-config`、`duplication` 等门会开始管这里
   - **模型/用户可见的改动要有 keyless 录制会话快照**（`snapshots/`），当前阶段 1/2 的 plan 把它留到了这里
   - 非平凡改动需要一篇 **Agent Note**（仓库硬要求）
3. **哪些东西迁移时会疼**：把已知的硬骨头列出来（快照、覆盖率、client 三注册面、`dsh.client` 与 `lib/client.js` 的同进同出）。

---

## 5. 回归测试审计

逐条对照 §13 第 5 条，给出**证据**（测试名或 B 档判据），缺的补：

| 要求 | 当前证据 | 缺不缺 |
|---|---|---|
| 单例 | `B7` + `tests/job-runner.spec.ts`（拒绝、取消后立刻重启） |  |
| 取消 | `B9` + `B12` + `tests/job-runner.spec.ts` |  |
| **归属随主 agent 死** | `B10` |  |
| 超时封顶 | `B3` + `tests/config.spec.ts` |  |
| 未投递 report 作废 | `B12` + `tests/job-runner.spec.ts` |  |
| 插件卸载取消在跑的程序 | `tests/job-runner.spec.ts` 的 dispose 用例 |  |

**审计要求**：不是抄这张表——**逐条去代码/测试里找到证据**，找不到的标出来并补。同时自己找出**这张表没列但显然该有的**覆盖（例如 `host/tmp-dir.ts`、`host/routes.ts` 的 400 分支、`host/flow-state.ts` 的边界）。

**能补的补，补不了（需要 tsx / 需要浏览器）的如实标"只有 B/C 档覆盖"。**

---

## 6. 验证

- A 档：`pnpm run typecheck` / `pnpm run test` / `pnpm run build` / `node --check lib/client.js`
- **README 里写的每条命令，作者要至少跑一遍能跑的那些**，跑不了的（B/C 档）明确标注"未在本会话执行"
- 文档与实现一致性：README 里提到的每个文件、每个配置项、每个事件名，**都要在代码里真实存在**（用 grep 自查一遍）
- B/C 档由负责人复跑（命令与判据照旧）

---

## 7. 实施顺序

| # | 做什么 | 怎么验证 |
|---|---|---|
| 1 | 回归测试审计（先审计，再补） | `pnpm run test` |
| 2 | 补缺的测试 | `pnpm run test` |
| 3 | `README.md` | 自查：文件/配置/事件名逐个 grep 得到 |
| 4 | 结清 design.md §13 | 人读一遍：每项都有结论 |
| 5 | 迁移方案（写进 README 或 design.md 附录） | 逐条可执行 |
| 6 | 提交 `阶段 7：收尾` | |

---

## 8. 风险与未验证项

| # | 风险 | 处置 |
|---|---|---|
| R1 | README 写成"愿望清单"而不是现状 | 每条都要能在代码里指到；作者自己 grep 一遍 |
| R2 | 覆盖率差距被低估 | 逐文件列，不要只给总数 |
| R3 | 迁移方案写成空话 | 每条都要指出**改哪个文件的什么** |
| R4 | 补测试时为了凑数写弱断言 | 不写"大于 0"这种；宁可标"只有 B 档覆盖" |

---

## 9. 开工前需要负责人裁决的问题

**Q1：迁移方案写进哪里？** 建议写进 `README.md` 的一节（"搬进 `packages/` 时要做什么"），因为它是给下一位动手的人看的；`design.md` 保持"设计依据"的定位。
**Q2：README 用中文还是英文？** 建议中文（与 Blackboard 及本目录其余文档一致）；迁进 `packages/` 时按 `docs/AGENTS.md` 的双语规则再处理。
**Q3：本阶段要不要顺手把 `flow.tmpDir` 的 `.execution-engine/` 加进**仓库根**的 `.gitignore`？** 驱动在仓库根跑时会在那里留目录；但改仓库根的 `.gitignore` 超出"只改 `Workspace/ExecutionEngine/`"的边界。**建议不改**，在 README 里写明。

---

## 10. 参考

- `Workspace/Blackboard/README.md` —— 本目录的文档风格模板
- `Workspace/ExecutionEngine/design.md` §12 阶段 7、§13
- `docs/AGENTS.md`、`packages/AGENTS.md`、`.agents/notes/README.md` —— 迁移会碰到的规矩
- `Workspace/ExecutionEngine/phase1-plan.md` … `phase6-plan.md`
