# ExecutionEngine 阶段 3 实施方案（后台化与单例）

范围：把 `run_program` 从**前台阻塞**改成**后台 job**，加**单例**约束与**取消**，并把三层生命周期挂钩接上。**不移动进 `packages/`，不改仓库任何其他文件。**

依据：[design.md](./design.md) §4.1（后台 job）、§4.2（单例）、§4.3（拒绝式启动）、§4.4（取消）、§5.3（三层生命周期）、§12 阶段 3。

**本阶段不做**：`report`、`flow/*` 事件、UI、执行位置上报。

---

## 0. 结论摘要

| # | 问题 | 结论 |
|---|---|---|
| A | 后台化的落点 | `ctx.jobs.start({ kind, label, owner, run })`，立刻返回 job id，不阻塞主 agent 回合 |
| B | 归属从哪来 | `JobStart.owner = 发起的主 agent`。契约原话：**"agent disposal cancels and awaits the job"** —— 归属与生命周期是同一个字段 |
| C | 单例怎么强制 | 引擎自己按 **owner session** 记账；同一 owner 已有 `running`/`stopping` 的 job → **拒绝**，错误信息带上当前 job id |
| D | 取消 | `JobHooks.cancel()`（同步、幂等）+ `await done`（"生产者释放资源之后"才 resolve）→ 恰好就是"等清理真正完成才返回" |
| E | 取消幂等 | 没有在跑的 job 时，取消工具返回明确的"当前没有正在运行的程序"，不是错误 |
| F | 三层生命周期 | job owner（本阶段）· `parentAgent`（阶段 2 已做）· abort signal（阶段 1 已做）；本阶段把**前两层串到同一次运行**上 |
| G | 返回值变化 | 工具不再返回程序结果，而是 `{ jobId, status: 'running' }` |

**`run_program` 的返回形态变了，这是本阶段的破坏性改动**：阶段 1/2 的 B 档用例（B1–B6）全部依赖"工具返回程序结果"，本阶段必须一并改写。见 §6。

---

## 1. 动手前的现状

HEAD 是阶段 2 的 `4f27b98`，工作区干净。`run_program` 现在在前台跑完整个 PTC run 才返回；`host/engine.ts` 的 `runProgram()` 是那条阻塞路径。

`inject` 现在五项：`tools` / `ptcRuntime` / `subprocess` / `sandbox` / `systemPrompt` / `subagents`（六项）。

---

## 2. job 化

```ts
// 引擎侧：单例记账 + 提交
const handle = ctx.jobs.start({
  kind: 'execution-engine',
  label: <程序首行或一句摘要>,
  owner: parent,
  outputLimitBytes: <一个界>，
  run: () => {
    const controller = new AbortController()
    const settled = runProgram({ ...request, signal: controller.signal })
    return {
      cancel: (reason) => { controller.abort(reason) },
      done: settled.then(outcome => ({ status, detail, output })),
    }
  },
})
```

要点：

- **`JobKindMap` 用声明合并扩展**（仓库约定）：在本插件里 `declare module '@deepseek-ai/dsh-jobs' { interface JobKindMap { 'execution-engine': 'execution-engine' } }`。**未验证**该模块的声明合并入口路径，执行时读 `packages/jobs/jobs/src/types.ts` 与同类先例确认。
- `run()` 必须**同步返回** hooks。所以 `runProgram` 是**先启动、后 await**：在 `run()` 里起真异步任务并立刻拿到 promise，不能 `await`。
- `cancel` 必须**同步**且**幂等**：只做 `controller.abort()`；重复调用无害。
- `done` 在**资源释放后** resolve —— 阶段 1 的 `runProgram` 已经在 `finally` 里删临时目录、且 `process` binding 会 `await waitForExit()`，所以"资源释放"是成立的。把它包成 `JobOutcome`。
- **`owner` 缺失怎么办**：`run_program` 在阶段 2 已经强制"必须有发起 agent"（`ToolRunContext.agent` 缺失即大声失败），所以这里 `owner` 一定在。**保持**：没有 owner 就没有单例约束可言。**未验证**：`JobStart.owner` 为 `undefined` 时契约上会变成"任何调用者都能读/停"的 unowned job —— 我们不走那条路。
- **需不需要挂 `dsh-tool-jobs`**：`jobs` README 说"producer 只有在服务于该 owner 的 controller 已挂载时才能 start"。**执行时读 `packages/jobs/jobs-local` 与 `dsh-tool-jobs` 确认**：是用后者（会额外给模型 `job_output`/`job_list`/`job_kill` 三个工具），还是本插件自己 `attachController`。**倾向自己 attach**：那三个工具会把"主 agent 只能取消/启动"这条设计（§6.4）撑开。**这条留作裁决项 Q1。**

---

## 3. 单例

引擎维护 `Map<SessionId, JobId>`：

- `run_program` 进入时查该 owner 有没有**未结算**的 job（`running` / `stopping`）；有 → **拒绝**，错误文本带上那个 job id，并明确"要先取消"。
- job 结算（`done` resolve）时清掉映射。**注意**：清理必须发生在 `done` 之后而不是 `cancel()` 之后，否则"取消返回后立刻启动新的"会撞上一个还在清理的旧 job（§4.4 的"等清理完成"正是为此）。
- 进程内的映射要**随插件 dispose 清空**，用 `ctx.effect()`。

**为什么按 owner 而不是全局**：§4.2 —— 单例的范围是"每个主 agent 一个"。不同会话各跑各的。

---

## 4. 取消

新工具 `cancel_program`，无参数：

- 查当前 owner 的未结算 job；没有 → **正常返回**"当前没有正在运行的程序"（幂等）
- 有 → `hooks.cancel(reason)`，然后** `await` 该 job 的 `done`** —— 这就是"等清理真正完成才返回"
- 返回里带上最终 `status`

**为什么不等价于 `ctx.jobs.kill`**：`kill` 也是"先调 producer 取消再改状态"，但本阶段我们要的是"**返回时清理已完成**"。用 `done` 直接表达这个语义，不依赖 `kill`/`wait` 的时序细节。执行时若发现 `ctx.jobs` 的 `kill` + `wait` 更贴契约定，可以换，但**判据不变**：工具返回后，旧 job 的进程与临时目录必须都已消失。

---

## 5. 三层生命周期

| 层 | 机制 | 状态 |
|---|---|---|
| job owner | `JobStart.owner = 发起的主 agent` → 契约保证 "agent disposal cancels and awaits the job" | **本阶段** |
| 子 agent 归属 | `ctx.subagents.start(..., { parent })` | 阶段 2 已做 |
| abort signal | run 的 `signal` 连 `exec.signal`，`process` 与 `subagents` 都透传 | 阶段 1/2 已做 |

**本阶段要把三者串到同一次运行上**：取消（无论来自工具、还是 job owner 被 dispose）→ abort `controller` → PTC run 停 → 在飞的 `process`/`subagents` 跟着停 → `runProgram` 的 `finally` 删临时目录 → `done` resolve。**这条链的每一跳都要在报告里指出来**，不能只说"应该会"。

---

## 6. 文件清单与破坏性改动

```
host/job-runner.ts     新：ctx.jobs.start 的封装 + 单例记账 + 取消（§2/§3/§4）
host/jobs-types.ts     新：JobKindMap 的声明合并（若需要单独文件）
host/engine.ts         改：runProgram 拆成"启动"与"等待"两半，供 job 使用
host/index.ts          改：run_program 返回 {jobId,status}；新增 cancel_program；inject 加 'jobs'
host/tool.ts           改：两个工具的 schema 与渲染
host/sdk.ts            改：.d.ts 说明新的返回形态与 cancel_program
tests/*.spec.ts        改/新
tests/loader-driver.ts 改：**B1–B6 全部改写**（见下）
tests/fixtures/*.yml   改：加 jobs 相关行
```

### B1–B6 的改写（本阶段最大的一块）

阶段 1/2 的 B 档用例都假设"工具返回程序结果"。改成后台后，判据变成**两段**：

1. `run_program` 立刻返回 `{ jobId, status: 'running' }`（**断言它不等程序跑完** —— 用一个会 sleep 的程序，断言工具在显著短于 sleep 的时间内返回）
2. 然后用 `job_output` 等价的读取路径拿到最终结果（本阶段引擎自己暴露读取，还是复用 `job_output`，取决于 Q1）——**判据不变**：原来对程序结果的断言（B1 的 `EE_OK`、B2 的退出码/超时、B6 的文本与归属）原样保留，只是改从 job 输出里取。

新增用例：

- **B7 单例**：程序 A 在跑时再启动 → 拒绝，错误含 A 的 job id；取消 A 之后能立即启动 B（**且断言 B 启动成功时 A 的临时目录已消失**）。
- **B8 取消幂等**：没有在跑的 job 时 `cancel_program` → 正常返回、不报错。
- **B9 取消等清理**：启动一个会 fork 子进程并 sleep 的程序，取消它；断言 `cancel_program` **返回时**（不是之后）进程树已消失、临时目录已删除。
- **B10 job owner 生命周期**：dispose 发起 agent → job 被取消且清理完成。（**未验证**如何在 driver 里干净地 dispose 一个 agent；执行时确认，做不到就用 `ctx.jobs` 的 owner 语义做替代断言。）

---

## 7. 验证

### A 档（执行 agent 自己跑）
`pnpm run typecheck` / `pnpm run test` / `pnpm run build` / `node --check lib/client.js`

### B 档（**由负责人跑**）
```
cd C:\workspace\Tool\deepseek-harness
node --import tsx/esm Workspace/ExecutionEngine/tests/loader-driver.ts Workspace/ExecutionEngine/tests/fixtures/cordis.yml
node --import tsx/esm Workspace/ExecutionEngine/tests/loader-driver.ts Workspace/ExecutionEngine/tests/fixtures/cordis-confined.yml
```
判据：两条 exit 0、末尾 `LOADER_SMOKE_OK`，且 B0–B10 各有一条 `: OK`。

### C 档（**由负责人跑**）
`dsh web --patch … --port 3099` + 临时 `DSH_HOME`，判据：无 `did not activate` / `required startup failure`。

---

## 8. 测试（`pnpm run test`，纯 Node）

- **`tests/job-runner.spec.ts`（新）**：用假 `jobs` 对象断言——单例拒绝；`cancel` 同步且幂等；`done` resolve 后才清映射；插件 dispose 清空映射。
- **`tests/config.spec.ts`（改）**：若新增配置项（如 `outputLimitBytes`）一并覆盖。
- **`tests/host-shape.spec.ts`（改）**：`inject` 断言加 `'jobs'`。

---

## 9. 实施顺序

| # | 做什么 | 怎么验证 |
|---|---|---|
| 1 | 读源码定准 `JobKindMap` 声明合并入口、controller 挂载方式（Q1） | — |
| 2 | `host/job-runner.ts` + `tests/job-runner.spec.ts` | `pnpm run test` |
| 3 | `host/engine.ts` 拆启动/等待 | `pnpm run typecheck` |
| 4 | `host/index.ts` / `host/tool.ts` 两个工具 | `pnpm run typecheck` |
| 5 | `host/sdk.ts` `.d.ts` | `pnpm run typecheck` |
| 6 | fixture 补行 + `loader-driver.ts` 改写 B1–B6、新增 B7–B10 | **由负责人跑 B 档** |
| 7 | 端到端 | **由负责人跑 C 档** |
| 8 | 提交 `阶段 3：后台化与单例` | |

---

## 10. 风险与未验证项

| # | 风险 / 未验证 | 处置 |
|---|---|---|
| R1 | `JobKindMap` 声明合并的入口模块路径 | 执行时读源码与同类先例 |
| R2 | controller 挂载：`dsh-tool-jobs` vs 自己 attach | **Q1 裁决**；前者会多给模型三个工具，撑开 §6.4 |
| R3 | `run()` 必须同步返回 hooks —— `runProgram` 的启动语义要真的"启动即返回" | 执行时必须保证没有 `await` 在 `run()` 内 |
| R4 | 如何用 `job_output` 读最终结果（本插件暴露 vs 复用 `dsh-tool-jobs`） | 依赖 Q1 |
| R5 | driver 里能否干净 dispose 发起 agent（B10） | 执行时确认；做不到就用替代断言并说明 |
| R6 | "工具立刻返回"的时序断言在慢机器上的稳定性 | 用足够大的 sleep 差值（如程序 sleep 5s、断言工具 < 2s 返回），避免 flaky |
| R7 | 单例映射在 job 异常结算路径上会不会泄漏 | `done` 的 `finally` 里清；spec 覆盖"done 拒绝也清" |

---

## 11. 开工前需要负责人裁决的问题

**Q1（最重要）：controller 挂载与结果读取走哪条路？**
- **(甲) 挂 `dsh-tool-jobs`**：省事、复用它的 `job_output`/`job_kill`，但模型会多看到三个通用 job 工具，`job_kill` 与我们的 `cancel_program` 语义重叠，§6.4"主 agent 只能做三件事"被撑开。
- **(乙) 本插件自己 `attachController` + 自己暴露一个读取工具**（例如 `read_program_output`）：模型面保持受控，代价是要自己写 controller 与读取工具。
- **(丙) 自己 attach controller，但本阶段先不给读取工具**：B 档改用引擎内部读取路径验证；模型面最小，但 `run_program` 之后模型拿不到结果——**不推荐**，那等于把"fire and forget"提前实现了。

**建议 (乙)**：模型面受控，且读取能力是 B 档判据的必需。**但这条会新增一个工具，请确认。**

**Q2：`cancel_program` 的名字。** 与 `run_program` 对称。可以吗？

**Q3：`run_program` 的返回里要不要带程序源码的摘要？** 单例之下"当前在跑的是哪一个"需要一个可读标识（UI 与错误信息都要）。建议带一个从首行截取的短标签进 `JobStart.label`，返回值里也带 `jobId`。可以吗？

---

## 12. 参考

- `Workspace/ExecutionEngine/design.md` §4.1–§4.4、§5.3、§6.4、§12
- `packages/jobs/jobs/src/types.ts` —— `JobStart` / `JobHooks` / `JobOutcome` / `JobSnapshot`（本方案的核心依据）
- `packages/jobs/jobs/README.md`、`packages/jobs/jobs-local/README.md`、`packages/jobs/tool-jobs/README.md`
- `Workspace/ExecutionEngine/phase1-plan.md`、`phase2-plan.md` —— 前两阶段方案与文档风格
