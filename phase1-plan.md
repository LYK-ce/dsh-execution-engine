# ExecutionEngine 阶段 1 实施方案（跑起一段程序·前台）

范围：`Workspace/ExecutionEngine/` 下把「主 agent 交一段程序、引擎按程序执行」这条链跑通。**不移动进 `packages/`，不改仓库任何其他文件。**

依据：[design.md](./design.md) §12「阶段 1 — 跑起一段程序（前台）」。

**本阶段不做**：后台 job、单例、取消工具、`report`、`dispatchsubagent`、UI。`run_program` 先做成**前台阻塞**调用。

> 说明：本文档由负责人撰写。原定由规划 subagent 产出，但该 agent 连续五轮未能落盘，已打断；执行与独立评审仍由 subagent 承担。

---

## 0. 结论摘要

| # | 问题 | 结论 |
|---|---|---|
| A | 程序在哪里求值 | **在 vm context 里**，能力显式注入（照 `packages/workflow/workflow-ptc/src/runtime.ts` 的 `vm.createContext` + `vm.Script` + `runInContext`） |
| B | vm 算什么 | **引导，不是安全边界**。实测可逃逸（见 §3），照 `workflow-ptc` README 的定性，**不为堵逃逸投入** |
| C | `child_process` 怎么处理 | 靠 vm 扣留全局——程序体`process`/`require`/动态`import` 全不可达。**不写"已封死"** |
| D | `process` 的底座 | `ctx.subprocess`：`spawn({argv,cwd,stdio,graceMs,signal,env})` → `handle.done` / `handle.collected` / `terminate()` / `waitForExit()`；`argv` 不经 shell |
| E | 「杀整个进程树」怎么保证 | `terminate()` 之后 `await handle.waitForExit()`——「直接命令结束不掩盖存活的子孙进程」 |
| F | 超时 | `process.defaultTimeoutMs` = 300000、`process.maxTimeoutMs` = 900000；**超出上限在解析阶段拒绝**，不截断 |
| G | 非零退出码 | `process` **正常返回**；`processOrThrow` 非零或超时则抛 |
| H | run 级截止 | `timeoutMs: null`（无整体截止，design.md §9） |
| I | `.d.ts` 怎么进提示 | `ctx.systemPrompt.section({ name, order, text })`，返回 disposer |
| J | `run_program` | 前台阻塞，返回程序的结构化结果 |

---

## 1. 动手前的现状

`Workspace/ExecutionEngine/` 是独立 git 仓库，阶段 0 已提交 `c0fcc31`，工作区干净。已落盘：`host/index.ts`（命名导出 `name`/`inject`/`Config`/`apply`，注册占位工具）、`host/tool.ts`、`client/index.ts`、`build/build-client.mjs`、`execution-engine.cordis.yml`、`tests/`（两个 spec + `loader-driver.ts` + fixture）、双 tsconfig、`package.json`、`pnpm-lock.yaml`。

`pnpm run typecheck` / `test`（7 pass）/ `build` 全绿；B1（`--dump-config` 锚定）、B2（真实 Loader 组合 `LOADER_SMOKE_OK`）、C（`dsh web` 挂载无 `required startup failure`）均已由负责人跑通。

本机：`C:\Python314\python.exe`（Python 3.14.7），可用于 e2e。

---

## 2. 程序怎么交给 `ctx.ptcRuntime`

```ts
const spec = ctx.ptcRuntime.resolve({
  program: guestSource(userProgram),      // 见 §3：外壳 + 用户程序
  bindings: [{ global: 'flow', functions: { process, processOrThrow } }],
  cwd: sessionCwd,                        // §5.2：从发起会话快照
  sandboxPolicy: resolvedPolicy,          // §5.2：同上（provider 支持时）
  signal,
  timeoutMs: null,                        // §9：整段程序无截止
})
const result = await ctx.ptcRuntime.run(spec)
```

`PtcRunRequest`（`packages/ptc-runtime/ptc-runtime/src/types.ts:73-98`）的确切字段：`program` / `bindings` / `cwd?` / `timeoutMs?: number | null` / `sandboxPolicy?: SandboxExecutionPolicy` / `signal?`；`PtcRunSpec` 把 `cwd` 与 `timeoutMs` 变成必填。**注意字段名是 `sandboxPolicy`，不是 `policy`。**

**cwd 与文件策略的快照**：本插件是 host 侧插件，`run_program` 由主 agent 调用，因此调用点能拿到发起会话。阶段 1 先取 `cwd`；文件策略按 provider 能力传（`ctx.ptcRuntime.sandboxMode` 存在才传，否则不传——provider 会自行拒绝不支持的选项）。

**结果映射**：`result.value` / `result.logs` / `result.error`（`kind`：`exception` / `timeout` / `abort` / `worker-exit` / `invalid-output` / `output-limit` / `protocol` / `sandbox-unavailable`）。`run_program` 把它们渲染成模型可读文本；失败不是异常。

---

## 3. 执行形态：vm context 与能力面

### 3.1 为什么是 vm

`ptc-runtime-node` 的 README 明说 "Direct filesystem, network and subprocess operations remain Node operations"，并且 "These native paths keep nested process creation ... functional"。程序体经 `AsyncFunction` 构造求值（`packages/ptc-runtime/ptc-runtime-node/src/bootstrap.ts:401-404`），因此看得见真实全局。**实测（Node v24.19.0）三条路都可达 `child_process`**：

```
process.getBuiltinModule("node:child_process")   -> 可达
await import("node:child_process")               -> 可达
globalThis.process.getBuiltinModule(...)         -> 可达
```

所以在进程内靠拦截 `require` / 覆盖全局来封是 facade，仓库规矩明确反对 facade。

### 3.2 vm 扣留的实测边界

照 `workflow-ptc` 的做法（`vm.createContext({}, ...)` + `vm.Script` + `runInContext`），实测：

| 探针 | 结果 |
|---|---|
| `typeof process` / `typeof require` / `typeof globalThis.process` | 全 `undefined` |
| 注入的宿主函数 | 可用 |
| 语言内建 `JSON` / `Promise` / `Math` | 可用 |
| `await import("node:child_process")` | 抛 `TypeError: A dynamic import callback was not specified` |
| `this.constructor.constructor("return process")()` | **逃逸成功** |
| 注入函数 `.constructor("return process")()` | **逃逸成功** |
| 加 `codeGeneration: { strings: false, wasm: false }` | **仍然逃逸** |

结论：**扣留能达到"引导作者"的目的，但不是安全边界，且堵不住逃逸。** 与 `workflow-ptc` README 同一句话：*The VM is not a security boundary — withheld globals guide script authors; OS policy governs code that reaches Node.*

**据此：写进 README 与 `.d.ts` 的措辞必须是"引导"而非"已封死"；不设计任何堵逃逸的机制。**

### 3.3 待裁决：能力面（见 §14 Q1）

vm context 里默认什么都没有（连 `console` 都没有）。三个方案：

- **方案甲（最小）**：只注入 `flow` 命名空间（`process` / `processOrThrow` / `tmpDir`）+ `console`。程序纯做计算与协调。**后果：design.md §3.4 的取值约定（脚本写文件 → 程序读文件）失效。**
- **方案乙（推荐）**：甲 + 一组**收窄的文件助手**（`readTextFile` / `writeTextFile` / `exists`，路径限定在 run 临时目录与会话 cwd 内）+ `fetch`。§3.4 可用；能力面可枚举、可写进 `.d.ts`；丢掉的是 `import`（不能 import 库或项目文件）。
- **方案丙（宽）**：甲 + 完整 `fs` + `fetch`。程序自由度最高，但 `.d.ts` 与文档要覆盖的东西多，且与"能力面可枚举"这个收益相冲突。

**本方案默认按乙实现**；若负责人选甲或丙，改动集中在 §4 的 `capabilities.ts` 与 §9 的 `.d.ts`。

### 3.4 外壳程序

`host/guest-source.ts` 导出 `GUEST_SOURCE`（自包含字符串，风格照 `packages/workflow/workflow-ptc/src/guest-source.ts`）：

1. `import * as vm from 'node:vm'`（PTC 子进程里可用）
2. 建 context：`vm.createContext(surface, { name: 'execution-engine' })`，`surface` 由注入的能力 + 宿主 binding 代理组成
3. 把用户程序编译成 `new vm.Script('(async () => {\n' + userProgram + '\n})()', { filename: 'flow-program.ts' })`
4. `await scriptPromise = script.runInContext(ctx, { timeout: syncTimeoutMs })`
5. 把完成值 materialize 成 lossless JSON 返回

**行号约束（为阶段 5 铺路）**：拼接时**不得对用户源码做任何行变换**（不格式化、不插行），否则阶段 5 的行号映射全错。

---

## 4. 文件清单

```
host/index.ts            改：inject 扩为 ['tools','ptcRuntime','subprocess','systemPrompt']；Config 同名合并；注册 run_program 与 .d.ts section
host/tool.ts             改：新增 run_program，保留占位工具（阶段 3 统一删）
host/engine.ts           新：把程序交给 ctx.ptcRuntime；组装 bindings；结果映射
host/guest-source.ts     新：外壳程序源码（§3.4）
host/capabilities.ts     新：vm 能力面（§3.3 方案乙）+ 用户程序拼接（保持行结构）
host/process-binding.ts  新：process / processOrThrow 的实现（走 ctx.subprocess）
host/tmp-dir.ts          新：run 临时目录的创建与删除
host/sdk.ts              新：生成给主 agent 的 .d.ts 文本
host/config.ts           新：Config 接口（超时字段与解析期校验）
tests/*.spec.ts          改/新：见 §11
tests/loader-driver.ts   改：扩展为真实组合 e2e，见 §10 B2
tests/fixtures/cordis.yml 改：补 ptcRuntime / subprocess 所需的行
```

---

## 5. `process` / `processOrThrow`

### 5.1 契约

```ts
process(argv: string[], opts?: { timeoutMs?: number }): Promise<{
  code: number; stdout: string; stderr: string; timedOut: boolean
}>
processOrThrow(argv: string[], opts?: { timeoutMs?: number }): Promise<{ stdout: string; stderr: string }>
```

- `process`：非零退出码、超时**都正常返回**，由程序判断。
- `processOrThrow`：非零退出码或超时**抛出**。

### 5.2 实现路径

1. **解析可执行文件**：`await ctx.subprocess.resolveExecutable(argv[0])`；未找到抛 `SubprocessExecutableNotFoundError` → 映射成程序可见的错误。
2. **解析超时**：`opts.timeoutMs` 省略取 `config.process.defaultTimeoutMs`；给了数字就用它，但**先用 `config.process.maxTimeoutMs` 校验，超了直接拒绝**（在解析阶段抛，不是运行时截断）。
3. **spawn**：
   ```ts
   const handle = ctx.subprocess.spawn({
     argv: [executable, ...argv.slice(1)],
     cwd,
     stdio: { stdin: 'ignore', stdout: { maxBytes: 1 << 20 }, stderr: { maxBytes: 1 << 20 } },
     graceMs,
     signal,                      // 外层取消 → 同一套终止过程
     env: ...,                    // 先不加显式覆盖，用内建擦洗后的环境
   })
   ```
4. **超时梯子**：起一个定时器，到点调 `handle.terminate()` 并记 `timedOut = true`；随后**无条件** `await handle.waitForExit()`。`waitForExit()` 是"整个受管范围静默"的证明，**这就是"杀整个进程树"**。
5. **收集结果**：`const { exitCode, signal } = await handle.done`；`handle.collected.stdout?.readFrom(0)` / `stderr`。
6. **`processOrThrow`**：调用同一个内部实现，非零或超时则抛出携带 `code`/`stderr` 的错误。

**注意**：`done` 只报直接命令的结局，`waitForExit()` 才报受管范围静默——两者都要等，顺序是先 `done` 再 `waitForExit`（或并发等，但要保证 `waitForExit` 被 await）。

**stdout/stderr 只用于诊断**（design.md §3.4），不承载业务返回值。

### 5.3 abort 时**必须自己收拾**在飞的子进程

`PtcRunRequest.signal` 的文档原话：*"In-flight binding calls are the CALLER's to settle — the runtime only stops asking."* 也就是说 run 被 abort 时，PTC 只是**不再向宿主发新请求**，已经在跑的那个 `process` **不会被自动终止**。

所以 `process` 的实现必须**自己监听同一个 `signal`**，在 abort 时调 `handle.terminate()` 并 `await handle.waitForExit()`。这一条是正确性要求，不是优化；漏了就会留下孤儿进程——而单例之下孤儿是看不见的（design.md §7.3）。

---

## 6. `flow.tmpDir`

- 每个 run 建一个目录。位置：`join(os.tmpdir(), 'execution-engine', runId)`；`runId` 用随机 id（阶段 3 会换成 job id）。
- 通过 `flow.tmpDir` 暴露给程序（只读字符串）。
- run 结束（成功、失败、抛出、取消）时**无条件递归删除**；删除失败只记日志，不影响 run 结果。
- 删除用 `ctx.fs`（若可用）或 `node:fs/promises`——**执行时确认哪个在 host 侧可用并选前者**；不可用则降级到 `rm -rf` 语义的 `fs.rm(..., { recursive: true, force: true })`。

---

## 7. 配置

阶段 0 的 `Config` 是 type-only 空接口。本阶段改成 tool-todo 的同名合并写法（`packages/todo/tool-todo/src/index.ts`）：

```ts
export interface Config {
  process?: { defaultTimeoutMs?: number; maxTimeoutMs?: number }
}
export const Config: z<Config> = z.object({
  process: z.object({
    defaultTimeoutMs: z.number().default(300_000),
    maxTimeoutMs: z.number().default(900_000),
  }).default({}),
})
```

校验（`resolve` 阶段，fail loud）：
- 两个值都必须是正整数
- `defaultTimeoutMs <= maxTimeoutMs`，否则拒绝
- 程序请求的 `timeoutMs > maxTimeoutMs` → 拒绝，错误信息带上上限值

---

## 8. `run_program` 工具

- 名字 `run_program`；参数 `{ code: string }`；输出 `{ output: string, isError?: boolean }`（具体 schema DSL 照 `host/tool.ts` 现有 `execution_engine_ping` 的 `defineTool` 用法）。
- 描述从**模型视角**写：说明它执行一段程序、程序里能调什么、失败怎么表现。不写实现词汇。
- **本阶段占位工具 `execution_engine_ping` 保留**（阶段 3 删），因为它仍是"插件挂上了"的模型可见证据；`run_program` 与它并存。

---

## 9. `.d.ts` 与系统提示

用 `ctx.systemPrompt.section({ name, order, text })`（`packages/core/system-prompt/src/index.ts:455`，返回 disposer；同名重复注册会抛）。因此：

- section 名固定为 `execution-engine-sdk`
- `order`：优先用 `ctx.systemPrompt.getSectionOrder(<合适的位置名>)`；**执行时确认哪个 `PromptSectionOrderName` 合适，确认不了就用一个显式数字并写注释说明**
- `text` 即 §11 of design.md 的 `.d.ts` 草案（按 §3.3 选定的能力面增删）
- 通过 `ctx.effect()` 持有 disposer

`inject` 因此要把 `'systemPrompt'` 加进去。

---

## 10. 验证程序

### A 档（执行 agent 自己跑；纯 Node / tsc，不需要 tsx）

```powershell
cd C:\workspace\Tool\deepseek-harness\Workspace\ExecutionEngine
pnpm run typecheck
pnpm run test
pnpm run build
node --check lib/client.js
```

成功判据：四条全 exit 0；`pnpm run test` 全绿。**另外必须新增一条纯 Node 的 vm 行为 spec**（见 §11），它不需要 tsx 就能证明 §3 的扣留行为。

### B 档（**由负责人跑**；需要 tsx）

**B1 — 真实 Loader 组合**（扩展 `tests/loader-driver.ts`）：

```powershell
cd C:\workspace\Tool\deepseek-harness
node --import tsx/esm Workspace/ExecutionEngine/tests/loader-driver.ts Workspace/ExecutionEngine/tests/fixtures/cordis.yml
```

成功判据：exit 0，stdout 末尾 `LOADER_SMOKE_OK`；且驱动里要真的**执行一次 `run_program`**，程序体是：

```ts
const r = process(['python', '-c', 'print("EE_OK")'])
return { code: r.code, out: r.stdout.trim() }
```

断言 `code === 0` 且 `out === 'EE_OK'`。

**B2 — 非零退出码与超时**（同一个驱动里追加）：

- `process(['python', '-c', 'import sys; sys.exit(3)'])` → `code === 3`，**不抛**
- `process(['python', '-c', 'import time; time.sleep(30)'], { timeoutMs: 1000 })` → `timedOut === true`，且**耗时显著小于 30s**
- `processOrThrow(['python', '-c', 'import sys; sys.exit(3)'])` → 抛出

**B3 — 超上限在解析期被拒**：`process(['python','-c','pass'], { timeoutMs: 10_000_000 })` → 拒绝，且**未启动任何进程**。

**B4 — 进程树清理**：跑一个 fork 出子进程的 python 脚本，超时杀掉后断言**没有残留 python 进程**（用 `waitForExit` 之后的进程查询验证）。判据要写死到命令级。

### C 档（**由负责人跑**；完整 `dsh web`）

```powershell
$env:DSH_HOME = Join-Path $env:TEMP ('ee-p1-' + [guid]::NewGuid().ToString('N').Substring(0,8))
New-Item -ItemType Directory -Force -Path $env:DSH_HOME | Out-Null
pnpm dsh web --patch Workspace/ExecutionEngine/execution-engine.cordis.yml --host 127.0.0.1 --port 3099 --no-open
```

成功判据：服务启动且 **stderr 无 `did not activate` / `required startup failure`**；跑完必须关掉并确认 3099 端口释放。**不要占用 3080。**

> 阶段 0 的教训：B 档走 fixture **不经过 `--patch`**，所以 C 档是唯一能验证真实挂载的。

---

## 11. 测试

`pnpm run test` 是纯 Node（不能有运行期 DSH import），`tests/*.spec.ts` 会被跑，`loader-driver.ts` 不会。

新增/修改：

1. **`tests/vm-surface.spec.ts`（新，纯 Node）** —— 把 §3.2 那张表变成断言：在 vm context 里 `process`/`require`/`globalThis.process` 都是 `undefined`；注入的函数可用；`import()` 抛 `TypeError`。**这条不需要 tsx，是把"扣留行为"钉住的唯一低成本手段。** 它不测逃逸（逃逸是已知且接受的），只测"正常写法拿不到"。
2. **`tests/guest-source.spec.ts`（新，纯 Node）** —— 对 `GUEST_SOURCE` 做文本断言：拼接后**用户源码的行结构未被改变**（行号偏移是常量）；外壳不包含对用户源码的格式化。
3. **`tests/config.spec.ts`（新，纯 Node）** —— `Config` 的解析期校验：`default > max` 被拒；请求超上限被拒；默认值正确。
4. **`tests/overlay.spec.ts` / `tests/host-shape.spec.ts`（改）** —— `inject` 断言从 `['tools']` 扩为四项；导出面仍恰好是 `name`/`inject`/`Config`/`apply` 且无 `default`。

**明确不写**：`process` 的进程行为单测（纯 Node 里跑真进程会与 CI 并发、端口、进程组纠缠）；它由 B 档的真实组合覆盖。

---

## 12. 实施顺序

| # | 做什么 | 怎么验证 |
|---|---|---|
| 1 | `host/config.ts` + `host/index.ts` 的 Config 同名合并 | `pnpm run typecheck` + `tests/config.spec.ts` |
| 2 | `host/process-binding.ts` | `pnpm run typecheck` |
| 3 | `host/tmp-dir.ts` | `pnpm run typecheck` |
| 4 | `host/capabilities.ts` + `host/guest-source.ts` | `tests/vm-surface.spec.ts` + `tests/guest-source.spec.ts` |
| 5 | `host/engine.ts` + `run_program` 工具 | `pnpm run typecheck` + `pnpm run test` |
| 6 | `host/sdk.ts` + systemPrompt section | `pnpm run typecheck` |
| 7 | 扩展 `tests/loader-driver.ts` 与 fixture | **由负责人跑 B 档** |
| 8 | 端到端复验 | **由负责人跑 C 档** |
| 9 | 提交 | `git commit -m "阶段 1：跑起一段程序（前台）"` |

---

## 13. 风险与未验证项

| # | 风险 / 未验证 | 处置 |
|---|---|---|
| R1 | **`ctx.ptcRuntime` 与 `ctx.subprocess` 在最小 fixture 组合里是否可用** | 阶段 0 的 fixture 只有 system-prompt + tools；本阶段要按真实 `inject` 补行。若仍 PENDING，`boot()` 的 startup audit 会打印诊断，按诊断补 |
| R2 | **vm context 里 binding 代理跨 realm 的可用性** | binding 是 guest realm 的函数，注入 vm context 后调用应正常；**未验证**，B1 会暴露 |
| R3 | **`syncTimeoutMs` 对 vm 的同步切片超时** | `workflow-ptc` 用它限制同步初始切片。本阶段是否需要、取值多少**未定**，先不设，只靠 run 级无截止 + `process` 级超时 |
| R4 | **`systemPrompt.section` 的 `order` 取值** | 执行时确认合适的 `PromptSectionOrderName`；确认不了用显式数字并注释 |
| R5 | **`ctx.fs` 是否可用于删除临时目录** | 执行时确认；不可用就降级 `node:fs/promises` 的 `rm(..., {recursive:true, force:true})` |
| R6 | **能力面方案未定**（§14 Q1） | 按方案乙实现；换了只动 `capabilities.ts` 与 `.d.ts` |
| R7 | ~~`policy` 字段名~~ | **已关闭**：字段名是 `sandboxPolicy`（`src/types.ts:91`） |
| R8 | **超时后 `done` 与 `waitForExit` 的时序** | 若 `done` 在 `terminate()` 后长时间不 settle，要有兜底；B2 的耗时断言会暴露 |
| R9 | 逃逸路径 | **已知且接受**，不作为缺陷 |

---

## 14. 开工前需要负责人裁决的问题

**Q1（最重要）：能力面选甲 / 乙 / 丙？** 见 §3.3。默认按**乙**（原语 + `console` + 收窄的文件助手 + `fetch`）实现。

**Q2：取消的传播。** 本阶段还没有取消工具，但 `run` 的 `signal` 从哪来？建议先接 `run_program` 工具执行自带的取消信号（工具调用被取消时同步终止程序）。可以吗？

**Q3：`run_program` 的返回粒度。** 本阶段只有 `output: string`。程序 `return` 的结构化值要不要原样透出（`JSON.stringify` 后进 `output`），还是只给文本？建议前者。

**Q4：`syncTimeoutMs`（vm 同步切片超时）本阶段要不要设？** 建议不设（见 R3），等阶段 3 的后台化一并处理。

### 裁决（负责人）

- **Q1 → 方案乙。** 原语 + `console` + 收窄的文件助手（`readTextFile` / `writeTextFile` / `exists`，路径限定在 run 临时目录与会话 cwd 内）+ `fetch`。理由：§3.4 的取值约定依赖程序能读文件，这是 design.md 已经定下的能力；而 `fs` 全量与 `import` 的能力面太大、写进 `.d.ts` 的东西太多，与"能力面可枚举"这个收益相冲突。**丢掉的 `import` 是明确接受的代价。**
- **Q2 → 是。** `run` 的 `signal` 接 `run_program` 工具执行自带的取消信号；工具调用被取消时同步终止程序与其在飞的子进程（§5.3）。
- **Q3 → 是。** 程序的 `return` 值 `JSON.stringify` 后进 `output`；`undefined`/不可序列化按 PTC 的 `invalid-output` 处理，不自己吞掉。
- **Q4 → 不设。** 本阶段不引入 `syncTimeoutMs`；同步死循环的防护留给阶段 3 与 run 级策略一并处理。

---

## 15. 参考

- `Workspace/ExecutionEngine/design.md` §3 / §5.2 / §7 / §9 / §11 / §12
- `Workspace/ExecutionEngine/phase0-plan.md` —— 上一阶段产物与文档风格
- `packages/workflow/workflow-ptc/src/runtime.ts:75,83,107` —— vm 求值
- `packages/workflow/workflow-ptc/src/guest-source.ts` —— 自包含外壳程序的写法
- `packages/ptc-runtime/ptc-runtime/src/types.ts:73-99` —— `PtcRunRequest` / `PtcRunSpec`
- `packages/ptc-runtime/ptc-runtime-node/README.md` —— provider 配置、失败种类、直接 Node API 仍可用
- `packages/subprocess/subprocess/src/index.ts:132,152`、`src/types.ts:179-195` —— `resolveExecutable` / `spawn` / `SubprocessHandle`
- `packages/core/system-prompt/src/index.ts:455` —— `section()` 注册
- `packages/todo/tool-todo/src/index.ts` —— `Config` 同名合并模板
