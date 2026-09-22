# ExecutionEngine：把长任务的中段执行变成一段程序

主 agent 写出一段 TypeScript 程序交给它，它按程序执行：**不确定的步骤**（`dispatchsubagent`）派子 agent，
**确定的步骤**（`process` / `processOrThrow`）跑外部程序，**汇报**（`report`）单向发回发起会话。
程序在**后台 job** 里跑，不阻塞主 agent 的回合；每个会话同时只有一个（单例）。

设计依据 [design.md](./design.md)；实施是阶段 0–8，每个阶段的方案与当时跑过的证据在
[phase0-plan.md](./phase0-plan.md) … [phase8-plan.md](./phase8-plan.md)。文档风格照 [../Blackboard/README.md](../Blackboard/README.md)。

本目录是**独立的 git 仓库**，不是仓库根 workspace 的一部分：它自带 `pnpm-workspace.yaml`（自己就是 workspace root），
host 半边靠 `--patch` overlay 挂上，客户端 bundle 由 `build/build-client.mjs` 自己打包。**没有改 `packages/` 的任何文件。**

## 目录

```
host/            DSH 插件（host 半边）；源码启动，tsx 直接跑 .ts，不需要构建
  index.ts       name / inject / Config / apply：工具注册、job controller、两条 route、.d.ts 段
  engine.ts      runProgram：拼程序、挂四个原语 + 内部 trace、跑 PTC、渲染结果、删临时目录
  job-runner.ts  后台 job 的提交 / 单例 / 取消 / report 记账 / flow/* 事件的身份补全与补发
  jobs-types.ts  JobKindMap 的声明合并（kind = execution-engine）
  flow-events.ts flow/* 五个事件的声明合并（只有类型）
  flow-state.ts  flow/* 的宿主侧累加器：每会话「当前这一版 run」+ since 增量快照
  routes.ts      两条 exact Fetch route 的处理与 400 分支
  process-binding.ts      process / processOrThrow：过 ctx.sandbox.confine，超时后等受管范围静默
  subagent-binding.ts     dispatchsubagent：parent = 发起的主 agent，可选 route 过策略校验，dispose 在 finally
  report-binding.ts       report：createUserMessage + followup，记账 MessageId 供取消作废
  guest-source.ts guest 外壳源码：vm context、能力面、原语包装、调用点行号
  capabilities.ts 外壳与用户源码的拼接；剥类型（行结构不变）
  config.ts       Config 的取值与解析期校验（超时、provider），零依赖
  tmp-dir.ts      run 专属临时目录：<会话工作目录>/.execution-engine/<runId>
  sdk.ts          进系统提示的 .d.ts 正文（超时数字取自已解析的配置）
  tool.ts         run_program / cancel_program 两个模型可见工具
client/          浏览器半边，被打包成 lib/client.js
  index.tsx      slots 注册 + locale + 轮询源 + 取消请求
  panel.tsx      conversation.view 面板：状态行、源码（行号/当前行/开窗）、轨迹、汇报、取消按钮
  locale.ts      en / zh 字典
shared/          protocol.ts：两条路由的路径常量与线格式（两侧共用，无 @deepseek-ai/* import）
build/           build-client.mjs：esbuild → lib/client.js（模块表 lazy-CJS 协议）
tests/           12 个 node:test spec + loader-driver.ts（B 档驱动）+ fixtures/（两个 Loader 组合 + 脚本化 provider）
execution-engine.cordis.yml  --patch overlay（只插一条 host 行）
tsconfig.json / tsconfig.client.json   host / client 两个 noEmit program
lib/             构建产物（本目录 .gitignore 覆盖）
```

## 安装与挂载

```powershell
cd Workspace\ExecutionEngine
pnpm install
pnpm run build
```

```powershell
# cwd = 仓库根
pnpm dsh web --patch Workspace/ExecutionEngine/execution-engine.cordis.yml
```

**为什么必须先 `pnpm run build`**：overlay 只有一条行，`@deepseek-ai/dsh-client-modules` 按这一行的**行名**找到最近的
`package.json`，读到 `dsh.client`（`package.json` 的 `dsh.client.platform`）之后会**立刻**去读
`exports["./client"]` 指的 `lib/client.js`；缺了它整个 `dsh web` 启动失败（modules 是 required 行），
不是"面板不出现"这么轻。改成客户端代码之后同样要重新 build 再刷新页面，**没有 HMR**。

host 半边不需要构建：`dsh` 是源码启动（`node --import tsx/esm apps/cli/src/bin.ts`），overlay 的行名直接指 `./host/index.ts`。

## 命令

| 命令 | 作用 |
|---|---|
| `pnpm run typecheck` | `tsc -p tsconfig.json && tsc -p tsconfig.client.json`（host / client 两个 program） |
| `pnpm run test` | `node --test --test-isolation=none "tests/*.spec.ts"`（纯 Node，不需要 tsx） |
| `pnpm run build` | 打客户端 bundle：`lib/client.js` |

host / client 分成两个 program，是因为两半会用不同的服务合并同一个 cordis Context 键，一个 program 里放不下两边。

## 配置

全是引擎的 `Config` 字段，部署可改（`--patch` overlay 的 `config` 段或 profile 配置）。

| 字段 | 默认 | 说明 |
|---|---|---|
| `process.defaultTimeoutMs` | `300000` | 程序没给 `timeoutMs` 时单次 `process` 的超时 |
| `process.maxTimeoutMs` | `900000` | 程序能申请的上限；**超出在解析阶段拒绝**，不是悄悄截断 |
| `subagentProvider` | `'spawn'` | `dispatchsubagent` 用哪个 `ctx.subagents` provider（fixture 里换成 `scripted`） |

两个超时字段必须是不大于上限的正整数，否则**加载期就抛**；`subagentProvider` 空名字或带首尾空白也抛（不静默回落）。
run 级**没有**截止时间：程序天然长跑，加整体截止会误杀正常任务（design.md §9）。

`run_program` 提交的 job 用 kind `execution-engine`，所以 job id 形如 `execution-engine-1`。

## 程序看得见什么

程序体在 PTC 子进程里的 `vm` context 求值，只有被显式注入的东西可见：

```ts
declare const flow: { readonly tmpDir: string }
declare function dispatchsubagent(prompt: string, opts?: { provider?: string; model?: string }): Promise<string>
declare function process(argv: string[], opts?: ProcessOptions): Promise<ProcessResult>
declare function processOrThrow(argv: string[], opts?: ProcessOptions): Promise<ProcessOutput>
declare function report(text: string): Promise<void>
declare function readTextFile(path: string): Promise<string>
declare function writeTextFile(path: string, text: string): Promise<void>
declare function exists(path: string): Promise<boolean>
declare function fetch(input: string, init?: object): Promise<Response>
declare const console: { log(...): void; info(...): void; warn(...): void; error(...): void; debug(...): void }
```

这份声明的**事实来源是 `host/sdk.ts`**（`sdkText`），它进系统提示的 `execution-engine-sdk` 段，
两个超时数字是插进去的已解析值。程序里**没有** `process`、`require`、动态 `import`、`child_process`。

**没有 `import` 是明确接受的取舍**：能力面可枚举（可写进 `.d.ts`）换来的是程序不能 import 库或项目文件。
要一个值就在程序里用 TypeScript 算；值确实在外部脚本里就走 design.md §3.4 的取值约定——脚本写文件、程序读文件。

**vm 扣留是引导，不是安全边界**：实测可逃逸（`this.constructor.constructor('return process')()`，注入函数的
`.constructor` 同样可达，加 `codeGeneration` 也堵不住），所以不为堵逃逸投入。写进 `.d.ts` 的措辞是"应当落在某目录内"，
不是"已封死"。

## 按调用指定子 agent 模型（阶段 8）

```ts
const review = await dispatchsubagent('review this diff', { provider: 'deepseek', model: 'deepseek-reasoner' })
const plain = await dispatchsubagent('and summarize this')   // 沿用当前会话的模型
```

`provider` 与 `model` **必须一起给**：只给一个就在调用时抛出——只给 `model` 的那条**沿用** `list_subagent_models` 的同一句 `` `model` requires `provider` ``，外面加 `dispatchsubagent: ` 标明是哪个原语拒的（整条消息**不是**逐字一样的），而不是回落到"父 provider 下的这个 model"——那种回落会把失败推到程序看不见的下游。两个都不给就是阶段 2 的老语义：子 agent 继承父 agent 的路由（请求里连 `agentOptions` 这个键都不出现）。

第二个参数**只认 `provider` 与 `model` 两个自有键**，出现别的键就在外壳里抛出（消息点名那个键、并说明本原语只接受这两个）。这不是"洁癖"：姊妹工具的模型字段叫 **`reasoning_effort`**（`packages/subagent/tool-subagent/src/model-selection.ts:65-69`），外壳若把它静静丢掉，程序会拿到**成功**、用的却是默认 effort，而绑定那一层根本看不到这个键——没有任何一层能报错，结果是静默的错误结果。

**部署前提**：显式指定只有在部署挂了 `subagent-model-selection` 策略、且这对 route 落在它的 `allowedModels` 里时才成立。引擎读的是**同一份**策略（`ctx.get('subagentModelSelection')`），不自己维护白名单；策略缺席、没开启、清单为空、route 没命中，**一律拒绝显式指定**，错误里列出可用 route（一条都没有时是 `(none)`）。`subagent-model-selection-settings` 由 web-app bundle 挂（`packages/bundle/web-app/cordis.patch.yml:47`），所以这条能力由**部署**决定，不是程序能自己打开的。引擎不把这份策略放进 `inject`：缺席只该让"显式指定"被响亮地拒绝，不该让 headless 部署连 `run_program` 都不注册。

**发现走主 agent 的 `list_subagent_models` 工具**：不带参数列 provider，带 `provider` 列它的 model。`.d.ts` 只指向它，**不抄目录**——目录随部署变化，抄进提示词就是一份迟早说谎的文档。

引擎**不查**别的：不查 `ctx.llm` 的目录（`LlmModelInfo` 的目录成员资格是 advisory，不是请求校验），不查 provider 的能力位（`ctx.subagents.start` 自己会拒），也不查 `ctx.llm.listProviders()`——引擎**不注入 `ctx.llm`**。

**不注入 `ctx.llm` 的代价**：策略里列了一个**没注册**的 provider 时，校验通过、`start` 也成功——`assertCapabilities` 只查能力位（`packages/subagent/subagent/src/index.ts:641-648`），`resolveChildAgentOptions` 只做父子路由合并（`packages/subagent/subagent/src/child-agent.ts:99-119`），都不查注册。子 agent 会话照建，**第一次模型请求**才在 LLM 适配器层炸：仍然响亮，但**晚了一整层**，措辞也是 provider 层的——`AgentOptions.provider` 的契约就是"call time 必须有注册的适配器"（`packages/core/agent/src/runtime-types.ts:26-35`）。真正的兜底在**发现侧**：`list_subagent_models` 的无参清单用 `listProviders()` 过滤（`packages/subagent/tool-subagent/src/list-models.ts:50-51`），未注册的 provider 根本不会出现；照 `.d.ts` 走、只用那份清单里的 id 的模型到不了那次晚失败。这条本身是**部署配置错误**，发现工具在带 `provider` 时会先一步抛出 `LLM provider "X" is not registered; available providers: …`（`packages/subagent/tool-subagent/src/list-models.ts:20-27`）。为这一次晚失败给引擎拉进第三个可选服务不划算，所以这个代价是**接受的**。

与 `tool-subagent` 有一处**有意的差异**：那个工具在会话组合时**快照**策略（`packages/subagent/tool-subagent/src/list-models.ts:84` 的 `policy` 就是组合那一刻捕获的），引擎每次 `dispatchsubagent` 调用现读 `current()`。真原因是**引擎没有每会话组合点**：工具在插件加载时注册一次，而 run 是会话起来之后才有的；快照一份就等于策略改动之后引擎一直按旧的那份判，而校验的对象必须是**这一次调用**的参数。

**后果**：设置在会话中途改动之后，`list_subagent_models` 广告的是它组合时快照的策略、引擎执行的是现读的策略，两者不一致时会出现"**广告了却被拒**"——快照里已经删掉的 route 还在广告，调用它被引擎拒绝；反过来刚加上的 route 能执行却没人广告。两个消费者读的是同一个服务的同一个方法，差的只是读的时刻。

## 模型看得见的两个工具

| 工具 | 参数 | 结果 |
|---|---|---|
| `run_program` | `{ code: string }` | **立刻**返回 `{ jobId, status: 'running' }`；程序在后台跑 |
| `cancel_program` | 无 | `{ cancelled, jobId?, status?, detail? }`；没有程序在跑时 `cancelled: false`，不是错误 |

单例的范围是**每个发起会话一个**：已经有程序在跑时 `run_program` **拒绝**（不自动取消旧的——静默杀掉一个正在
发邮件的程序，主 agent 不会知道），错误文本里带着当前 job id，而这句话本身就是状态查询。

`cancel_program` **返回时清理已经完成**：进程、子 agent、临时目录都收干净了才返回（它等的是 job 的 `done`）。

## 观察面与面板

引擎发五个 observe-only 的 `flow/*` 事件（只带数据，不带活动句柄）：

| 事件 | 何时 | 主要字段 |
|---|---|---|
| `flow/start` | job 注册成功 | `runId` / `label` / `ownerSession` / `code`（程序正文原文） |
| `flow/call-start` | 一次原语调用开始 | `callId` / `member` / `line` / `args` / `argsTruncated` |
| `flow/call-end` | 一次原语调用结算（失败也发） | `callId` / `ms` / `outcome` / `result`\|`error` / `synthetic?` |
| `flow/report` | 一次 `report` 投递成功 | `text` |
| `flow/end` | run 结算 | `status` / `discarded` / `detail?` |

`flow/call-start` 与 `flow/call-end` 按 `(runId, callId)` 成对；程序在调用结算前终止（取消、超时、不 `await` 就 `return`）时，
由宿主补发一条 `synthetic: true` 的 `call-end`，**先于** `flow/end`。

**`flow/*` 出不了宿主进程**（它们是 Cordis 事件，不是会话事件），所以浏览器经两条 exact Fetch route 轮询：

| 路由 | 判据 |
|---|---|
| `GET /api/execution-engine.state?sessionId=<id>&since=<n>` | 返回 `{ run, revision, entries, reset }`；缺 `sessionId` 或 `since` 不是非负安全整数 → 400 |
| `POST /api/execution-engine.cancel?sessionId=<id>` | 走与 `cancel_program` **完全相同**的取消路径；缺 `sessionId` → 400 |

宿主侧的 `flow-state.ts` 按会话累加出"当前这一版 run"：轨迹留最近 200 条调用（`MAX_CALLS`）与 50 条 report
（`MAX_REPORTS`），`since` 接不上时整份重来（`reset: true`）。客户端 `POLL_MS = 1000` 轮询，
面板超过 `CODE_MAX_LINES = 400` 行时只渲染当前行上下 `CODE_WINDOW_RADIUS = 150` 行的一段（不做虚拟滚动）。

## 验证

### A 档（纯 Node / tsc，不需要 tsx；本会话已跑，输出见下方）

```powershell
cd C:\workspace\Tool\deepseek-harness\Workspace\ExecutionEngine
pnpm run typecheck
pnpm run test
pnpm run build
node --check lib/client.js
# 阶段 6 附加：bundle 里必须有模块 id 与 locale 键（lib/ 不进 git，所以要当场验）
Select-String -Path lib\client.js -Pattern 'dsh-execution-engine','view.panel','action.cancel'
```

判据：前四条 exit 0，`pnpm run test` 全绿（当前 104 条），最后一条三个模式都命中。

**本会话的 A 档真实输出**（阶段 8 执行时）：

```
pnpm run typecheck                             exit 0（无诊断）
pnpm run test                                  tests 104 / pass 104 / fail 0 / duration_ms 3759.1
pnpm run build                                 lib\client.js  15.4kb   Done in 5ms
node --check lib/client.js                     exit 0
Select-String -Path lib\client.js -Pattern 'dsh-execution-engine','view.panel','action.cancel'
  client.js:1:  window.__ModuleLoader__.load({ id: "dsh-execution-engine", factory: (require) => {
  client.js:38: "view.panel": "\u6267\u884C\u5F15\u64CE",
  client.js:62: "action.cancel": "\u53D6\u6D88\u7A0B\u5E8F",
```

阶段 7 那一轮的同一条命令是 90 条全绿；阶段 8 加上 14 条（`subagent-binding.spec.ts` 10 条、
`vm-surface.spec.ts` 1 条、`sdk-text.spec.ts` 3 条）。

### B 档（真实 Loader 组合；需要 tsx）

下面的判据在开发过程中**每个阶段都由负责人真跑过并全部通过**（B0–B14b、两份 fixture），可随时复跑。
**B15 是阶段 8 新增的，尚未由负责人跑过**（写它的执行 agent 在会话沙箱里跑不了 tsx）。

**委派 subagent 执行时会撞 EPERM**：被挡的不是 `tsx` 本身（`node --import tsx/esm -e "console.log('TSX_OK')"` 是过的，
仓库根也装了 `node_modules/tsx`），而是它内部 **esbuild service worker 的管道子进程**——subagent 会话的沙箱不允许
管道子进程，负责人这一层有升级通道。所以"subagent 跑不了"是会话沙箱的事实，不是这些判据没被执行过。

```powershell
# cwd = 仓库根
node --import tsx/esm Workspace/ExecutionEngine/tests/loader-driver.ts Workspace/ExecutionEngine/tests/fixtures/cordis.yml
node --import tsx/esm Workspace/ExecutionEngine/tests/loader-driver.ts Workspace/ExecutionEngine/tests/fixtures/cordis-confined.yml
```

判据：两条 exit 0，stdout 末尾 `LOADER_SMOKE_OK`，且每个用例各有一条 `: OK`。用例清单与逐条判据写在
`tests/loader-driver.ts` 的文件头（B0–B15），要点：

| 用例 | 判据 |
|---|---|
| B0 / B8 | 没有发起者的 `run_program` 大声失败；没有程序在跑时取消正常返回 |
| B1 / B1b / B2 / B3 / B4 | 程序真跑起来；工具立刻返回（程序 sleep 4s、工具 < 2s 返回）；非零退出码正常返回、`processOrThrow` 抛出、1s 超时显著早于 30s；超上限请求被拒且**没启动任何进程**；超时后整个进程树清干净 |
| B6 | `dispatchsubagent` 拿回脚本化 provider 的文本；`parent` 逐字等于发起会话的 `SessionId`；失败路径抛出并带 reason 与 diagnostic |
| B7 | 单例拒绝（错误里带 A 的 job id）；取消后立刻能起 B，且取消返回时 A 的临时目录已消失 |
| B9 | 取消**返回的那一刻** fork 出的父/子进程都已消失、临时目录已删，3s 后本该出现的哨兵文件始终没出现 |
| B10 | dispose 发起 agent 的 scope → job 被取消、清理完成、注册表里的记录已删 |
| B11 / B12 | `report` 按程序调用顺序投递、`source.plugin === 'execution-engine'`；取消后本次 run 未投递的三条被摘掉（`flow/end.discarded === 3`），上一次 run 留下的两条原封不动 |
| B13 | `flow/call-start.line` 逐条等于程序里写死的行号（含循环里重复的同一行、失败调用也闭合）、`flow/start.code` 是提交正文，而内部 `trace` 不在程序可见面里 |
| B14a / B14b | 两条 route 真的挂在 `ctx.connection.fetch` 上（含缺 `sessionId`、负 `since` 的 400）；面板状态与 `flow/*` 逐条一致、`since` 增量三种取值、经路由取消且返回时临时目录已删 |
| B15（阶段 8） | 命中 `allowedModels` 的 route **逐字**到脚本化 provider 的 `agentOptions`；不填时请求里没有这个键（继承语义没变）；清单外的 route 抛出且消息里列出可用 route；只给 `model` 抛出且消息里含与 `list_subagent_models` 同一句 `` `model` requires `provider` `` |
| B5（受限 fixture） | `process` 起的外部进程过发起会话的文件策略：写工作目录外被拒、写工作目录内成功（两条互补） |

### C 档（真 `dsh web`）

判据在开发过程中**每个阶段都由负责人真跑过并全部通过**（含第 5 条的三条 curl 路由判据），可随时复跑。
**委派 subagent 执行时同样跑不了**：既要真服务器、又要能驱动浏览器，subagent 会话两样都不具备。

```powershell
$env:DSH_HOME = Join-Path $env:TEMP ('ee-p8-' + [guid]::NewGuid().ToString('N').Substring(0,8))
New-Item -ItemType Directory -Force -Path $env:DSH_HOME | Out-Null
# cwd = 仓库根；端口用 3099，不要占 3080
pnpm dsh web --patch Workspace/ExecutionEngine/execution-engine.cordis.yml --host 127.0.0.1 --port 3099 --no-open
```

判据（1–4 是"挂上了"，5 是路由，6–7 要浏览器，8 是收尾，9 是阶段 8 特有的一条）：

1. stdout 打印监听地址，且 **stderr 没有 `did not activate` / `required startup failure`**。
2. 浏览器打开根 URL 能出 shell，`__DSH_BOOT__` 里有 `dsh-execution-engine`。
3. `/plugins/??dsh-execution-engine/client.js&rev=…` 返回 200。
4. 右侧/视图切换里出现「执行引擎」面板。
5. **路由要先换 cookie**：每个进程 mint 一个随机 launch token，`dsh web` 打印的根 URL 带着 `?token=…`；
   `GET /` 用这个 token 换持久 cookie（303 + `Set-Cookie`），之后 `/api/…` 只认 cookie，裸 token 不算数。
   用 curl 的 cookie jar 走一遍：

   ```powershell
   # $token 取自 dsh web 打印的根 URL
   curl.exe -sS -c "$env:TEMP\ee-cookies.txt" -o NUL "http://127.0.0.1:3099/?token=$token"
   curl.exe -sS -b "$env:TEMP\ee-cookies.txt" "http://127.0.0.1:3099/api/execution-engine.state?sessionId=probe&since=0"
   # → {"run":null,"revision":0,"entries":[],"reset":true}
   curl.exe -sS -b "$env:TEMP\ee-cookies.txt" -X POST "http://127.0.0.1:3099/api/execution-engine.cancel?sessionId=probe"
   # → {"cancelled":false}
   curl.exe -sS -b "$env:TEMP\ee-cookies.txt" -o NUL -w "%{http_code}`n" "http://127.0.0.1:3099/api/execution-engine.state"
   # → 400
   ```

6. 让主 agent 调一次 `run_program`（例如 `await process(['python','-c','print(1)'])`）：工具立刻回 job id，
   面板出现程序正文与轨迹，循环里同一行反复出现。
7. 点面板的「取消程序」→ 与 `cancel_program` 行为一致，run 变「已取消」，按钮回到可点状态。
8. 跑完关掉服务并确认 3099 已释放。
9. **阶段 8 特有**：这个组合里 `subagent-model-selection-settings` 是 web-app bundle 挂的（`packages/bundle/web-app/cordis.patch.yml:47`），但那一行**没有 config**，所以服务在场而策略是关闭的。两段判据：
   - **默认状态**：让主 agent 派一个带 `{ provider, model }` 的子 agent，回来的是"列出可用 route"的错误，且清单是 `(none)`；
   - **打开之后**：在 Plugins 设置页（或设置文档）把这个 namespace 打开并加一条 route，同一段程序再跑一次——命中的那条正常完成，没命中的那条错误里的清单变成刚配的那条。
   这两段合起来才是"引擎读得到真实策略"的实证（B15 用的是 fixture 自己挂的同名服务，证不了真组合的挂载）。

### GIF

**未产出。** design.md §12 阶段 6 要求录一段 GIF，而阶段 6 那台开发机上没有"真服务器 + 浏览器控制"（`pnpm dsh web`
起不来，也没有可驱动的浏览器），**没有拿截图或说明文字冒充**。它必须在能跑 C 档并能驱动浏览器的环境里按
`record-browser-gif` 技能补录，产物放进本目录后随提交入库。

## 已知限制

- **仓库级 keyless 快照没产出（迁移欠账）**：`snapshots/AGENTS.md` 要求每个被测进程经 `dsh` CLI + 一个 shipped profile（+ 可选 scenario patch）启动，而本插件今天是 `--patch` overlay、不在任何 shipped profile 里，录制还要 key、产物要落 `snapshots/`——都在本插件的改动范围之外。本插件因此用**自己的 golden 断言**（`tests/sdk-text.spec.ts` 把 `.d.ts` 渲染文本逐字钉住）顶上，模型可见的三处（两个工具的 schema 与结果文本、`execution-engine-sdk` 段）都还没有仓库级录制会话。这一笔随**迁移**还：迁移后插件进了 shipped profile，那一次 PR 才录得出来（见「搬进 `packages/` 时要做什么」第 11 条）。
- **显式指定子 agent 模型是部署能力，不是程序能力**：`allowedModels` 由用户设置维护、服务由 web-app bundle 挂。策略缺席、没开启或清单为空时，程序的 `dispatchsubagent(p, { provider, model })` 一律被拒（消息里 `available routes: (none)`）——引擎**没有**"没有策略就放行"的回落，那会把"部署授权"重新变成"调用方自己说了算"。
- **`assertAllowedRoute` 把"缺席 / 未开启 / 空清单"归一成同一个空清单是故意的**：三者在引擎这一侧的后果完全相同——没有授权任何可选路由，拒绝消息一律是 `available routes: (none)`。其中 `enabled && allowedModels.length === 0` 这一路在**生产里不可达**：`subagent-model-selection-settings` 在加载与写入两侧都拒这种取值（`packages/subagent/tool-subagent/src/model-selection-settings.ts:92-97`）。保留它是因为引擎读的是 `ctx.get('subagentModelSelection')` 拿到的实现，不代上游断言"这条不会出现"。
- **面板不可回放。** 数据走宿主侧累加器 + 轮询，不是会话事件：刷新页面要等下一拍（最多 1s）才恢复，而且看不到历史 run
  （累加器只留当前那一个）。`flow/*` 要落成 log-only 会话事件才能回放，那是另一量级的改动（要动 `SessionEventMap` 与持久化）。
- **`report` 每条一次模型调用**，额度不由引擎管——报什么、报几次由程序自己掌握（攒到阶段边界再报是程序该有的纪律）。
- **没有续跑**：取消 + 重启 = 全量重跑，取消带走程序全部状态，**已发生的副作用会重来**（`notify.py` 会再发一封邮件）。
- **不给程序清理机会**：主 agent 消失时程序被静默硬杀，副作用可能残缺（半个文件、半封邮件）。
- **`tool-jobs` 在默认部署下会额外唤醒一次**：标准 preset 挂着 `@deepseek-ai/dsh-tool-jobs`，它会给 owner 投递 job
  完成通知、也会把 `job_output` / `job_list` / `job_kill` 暴露给模型。所以「主 agent 只能启动 / 取消 / 看 report」是
  **设计意图，不是默认部署下的事实**；`completionDelivery: 'quiet'` 可关掉唤醒（纯配置）。本插件从生产方一侧抑制不了。
- **Windows fallback owner 下 `waitForExit` 只保证直接子进程**：provider 自己的文档承认逃出去的子孙不保证被终止。
  准确的承诺是"等 provider 能观察到的受管范围静默"，不是"整棵树都没了"。
- **插件卸载会取消在跑的程序**（design.md §4.4 的取消入口之一），所以卸载/重载期间的程序是做不到"跑完再说"的。
- **`.execution-engine/` 会落在会话工作目录里**：`flow.tmpDir` 的位置是 `<会话工作目录>/.execution-engine/<runId>`，
  run 结束时整体删除，硬崩溃时可能残留。**本目录自己的 `.gitignore` 已经忽略它**；**仓库根的 `.gitignore` 按裁决没有加它**
  （改仓库根超出本插件的边界），所以在**仓库根**跑程序时会看到这个目录出现在 `git status` 里——它是运行残留，不是产物。
- **vm 扣留不是安全边界**（上文），程序里的逃逸路径是已知且接受的。
- **`flow/*` 没有额度**：程序里一个千次循环会产生两千个事件。

## 接口边界

| 面 | 导出 | 约束 |
|---|---|---|
| host 插件 | 恰好 `name` / `inject` / `Config` / `apply`，**没有 `default`** | Loader 的 `unwrapExports` 会取 `.default`，加了它会把 `inject` / `name` / `Config` 一起丢掉（postmortem 0001）。`tests/host-shape.spec.ts` 钉住这条 |
| host `inject` | `['tools','jobs','ptcRuntime','subprocess','subagents','sandbox','systemPrompt']` | `sandboxPolicy`、`agents` 与 `subagentModelSelection` 走 `ctx.get` 可选读；`connection` 走 `ctx.inject(['connection'], …)`，所以 headless 部署照样能跑程序 |
| client 插件 | `apply` / `inject`（`['slots','locale']`） | 业务组件、locale 字典、源实现都不导出；`build/build-client.mjs` 的模块表 id 必须等于包名 |

## 回归测试覆盖（§13 第 5 条的审计结论）

逐条去代码/测试里找了证据，不抄 phase7-plan §5 那张表；结论就是下面的行号级引用。

| §13 第 5 条要求 | A 档证据 | B 档证据 |
|---|---|---|
| 单例 | `job-runner.spec.ts`：`同一个 owner 已有未结算的程序时拒绝，错误里带上当前 job id`、`取消等 done 结算，返回前仍然占着槽位` | B7 |
| 取消 | `job-runner.spec.ts`：`cancel 同步且幂等；没有程序在跑时 cancelled:false`、`取消打到本次提交自己的信号上，与调用方的信号无关`、`取消结算时作废仍未投递的 report` | B9、B12 |
| 归属随主 agent 死（job 层） | `job-runner.spec.ts`：`插件 dispose 先取消在跑的程序、等它结算，再清记账` | B10（owner disposal） |
| 归属（子 agent 挂在发起者下） | `subagent-binding.spec.ts`：`provider 名与父 agent 原样透传` | B6（`parentId` 逐字等于发起者的 `SessionId`） |
| 超时封顶 | `config.spec.ts`：`请求超上限被拒`、`缺省超时是 300s / 900s` | B3（且没启动任何进程）、B2c |
| 未投递 report 作废 | `report-binding.spec.ts`：`作废只摘还挂在队列里的那些，已经被领取的不算`；`job-runner.spec.ts`：`取消结算时作废仍未投递的 report`、`正常结算不作废仍未投递的 report` | B12（含"上一次 run 的两条原封不动"） |
| 插件卸载取消在跑的程序 | `job-runner.spec.ts`：`插件 dispose 先取消在跑的程序、等它结算，再清记账` | —（B10 是 owner disposal 那条入口） |

§13 第 5 条**没列、但本次审计认为该有**的覆盖：

| 面 | 结论 |
|---|---|
| `host/routes.ts` 的 400 分支与结果折叠 | **本次补上**：新增 `tests/routes.spec.ts`（7 条）——缺/空 `sessionId`、`since` 的负/小数/NaN/Infinity、`since` 省略按 0、可选字段缺席时不带键、400 发生在调用取消入口**之前** |
| `host/tmp-dir.ts` 的清理失败分支 | **本次补上**：`tests/tmp-dir.spec.ts` 新增 `清理失败只记一条告警，不抛出` |
| `host/flow-state.ts` 的边界 | 已覆盖：`since 的四个边界：最新、增量、比最新还大、刚换过 run`、`有界：调用与 report 各自裁到上限，丢的是最旧的`、`有界挤掉了 start 时，那条迟到的 end 也不会补进来`、`没有 start 的事件被丢掉，没有配对的 call-end 也被丢掉`、`换一次 run 就换掉整份记录，上一次 run 的事件不再改动它`、`两个会话各记各的` |
| `host/config.ts` | 已覆盖（8 条），含 schemastery 缺省常量与解析器同源那条源码级比对 |
| `host/guest-source.ts` / `host/capabilities.ts` | 已覆盖：`guest-source.spec.ts` 8 条 + `vm-surface.spec.ts` 15 条（含包装层行号、trace 不外泄、预览有界、程序给的 `opts` 过外壳、未知自有键被拒） |
| 按调用指定子 agent 模型（阶段 8 新增面） | `subagent-binding.spec.ts` 10 条：合法 route 逐字转发且其余入参不变、不填时 `agentOptions` 这个键**不在场**、只给 model / 只给 provider / 空串 / 非字符串都抛且不产生 `start`、清单外抛且消息列出可用 route、策略缺席·未开启·空清单一律拒、策略每次调用现读、列表有界、已中止时给了路由也不 start。`.d.ts` 另有 `sdk-text.spec.ts` 的整段 golden | B15（命中 / 不填 / 清单外 / 只给 model 四段） |

**只有 B 档能覆盖**，以及**目前哪一档都没有**的：

| 面 | 现状 |
|---|---|
| `host/index.ts` 的 `authorityOf` 找不到工作目录时抛 | **哪一档都没有**：它要求"会话没有 cwd 且没有 sandboxPolicy"，在真装配里造不出来（fixture 的会话总是带 cwd），纯 Node 又加载不了 `host/index.ts`（运行时要 `@deepseek-ai/schemastery`） |
| `host/engine.ts` 的 `renderValue` "程序没有返回值"分支 | **哪一档都没有**。`return` 一个 `undefined` 的程序会走到它（`ptc-runtime-node` 的 `prepareCompletion(undefined)` 返回 `{}`，不是 `invalid-output`），但 `host/engine.ts` 运行时要 `@deepseek-ai/dsh-llm`，纯 Node 加载不了，所以只能由 B 档补：`const b = await runToCompletion("await process(['python','-c','print(1)'])"); assert.ok(b.endsWith('程序没有返回值。'))` |
| `host/engine.ts` 的 `readTraceRecord` 拒绝畸形记录 | **哪一档都没有**：外壳自己发的记录永远合法，这是 wire 边界的防御分支 |
| `host/tool.ts` 的两个 render | B 档间接覆盖：`startProgram` 断言返回文本里带 job id（`程序已在后台运行（…）`），B8 断言 `当前没有正在运行的程序`；`cancelled: true` 那条渲染文本没有断言 |
| `host/process-binding.ts` | B 档：B1–B5（真进程）；B2b 覆盖 `exited with code`。**A 档明确不写**：纯 Node 里跑真进程会与并发、端口、进程组纠缠（phase1-plan §11） |
| `host/process-binding.ts` 的 `processOrThrow` **超时抛错** | **哪一档都没有**：B2b 只覆盖 `exited with code`；B2c 用的是 `process`（超时正常返回），B3 命中的是 spawn **之前**的解析期拒绝（`exceeds the configured maximum`），两条都不经过 `processOrThrow`。**可由 B 档补**，用例见本表之后的代码块 |
| `client/` 全部 | C 档 + `lib/client.js` 的模块 id / locale 键断言。**A 档没有面板的行为测试**（要浏览器），`overlay.spec.ts` 只钉住入口文件名与 `dsh.client` / `exports["./client"]` 的一致性 |
| 归属随主 agent 死的**子 agent** 那一层 | 本插件只负责把 `parent` 与同一个 run 信号递下去（B6 与 `subagent-binding.spec.ts` 的 abort 用例各证一半）；"子 agent 随 parent 被 dispose 而 drain"归 `packages/subagent` 的 lineage teardown，不在本插件里，因此本目录不测 |
| `ctx.get('subagentModelSelection')` 在**真部署**里读得到 | **只有 C 档**（第 9 条）：那条策略由 web-app bundle 挂（`packages/bundle/web-app/cordis.patch.yml:47`，那一行没有 config，默认是关闭的），B15 验的是 fixture 自己挂的同名服务，证不了"真组合里这一行确实在、打开后确实生效" |
| `host/guest-source.ts` 里 `opts` 的形状与自有键那两条拒绝 | A 档：`vm-surface.spec.ts` 的 `dispatchsubagent 的 provider / model 过外壳，未给的键不出现`。程序传 `42` 或数组当第二个参数、或传 `provider` / `model` 之外的自有键（例如 `reasoning_effort`）时外壳抛出，绑定根本收不到调用——这是外壳的边界，不是绑定的 |

补 `processOrThrow` 超时抛错的 B 档用例（可直接粘进 `tests/loader-driver.ts`，接在 B2c 之后）：

```ts
const b2d = await runToCompletion(`
try {
  await processOrThrow(['python', '-c', 'import time; time.sleep(30)'], { timeoutMs: 1000 })
  return { threw: false }
} catch (error) {
  return { threw: true, message: String(error && error.message) }
}
`)
assertProgramSucceeded(b2d, 'B2d')
const timeoutThrown = returned(b2d) as { threw: boolean; message?: string }
assert.equal(timeoutThrown.threw, true, 'processOrThrow must throw when its own timeout expires')
assert.match(String(timeoutThrown.message), /process timed out/)
process.stdout.write('B2d processOrThrow timeout throw: OK\n')
```

## 搬进 `packages/` 时要做什么

**本阶段不执行迁移**，只留方案（负责人已定"集成之后再做"）。下面每条都指名要改哪个文件的什么。

### 目标形态：一个双面包（推荐）

`packages/execution-engine/execution-engine/` → `@deepseek-ai/dsh-execution-engine`。
先例：[`packages/client/file-upload`](../../packages/client/file-upload/package.json)（host + client + `src/protocol.ts` 同一个包）、
[`packages/api/remotes`](../../packages/api/remotes/package.json)。

**为什么不按 phase7-plan §4.1 的三包拆**（`engine` / `tool-execution-engine` / `client-execution-engine`）：
client 半边要用 `STATE_PATH` / `CANCEL_PATH` 这两个**值**，而 [packages/client/AGENTS.md](../../packages/client/AGENTS.md) 的 Export
discipline 第 3 条禁止 feature plugin 之间 runtime value import——拆开就得把 `shared/protocol.ts` 复制两份（两条路径常量迟早分叉）
或破坏那条纪律。那条规则的结尾还留了**第三条路**：共享 runtime 代码放进一个窄的静态所有者（`client/store`、`ui-primitives`，
或一个 browser-safe utility package）。为 `STATE_PATH` / `CANCEL_PATH` 两个字符串新建这样一个包在技术上走得通，但今天
只有这一个消费者，为它单开一个包不划算；结论不变。`jobs/jobs` + `jobs/tool-jobs` 那种拆法要有"引擎服务有第二个消费者"这个现状，而今天没有；
真出现了再把工具面按 `tool-execution-engine` 拆出去，依赖方向是 `tool-execution-engine` → `execution-engine`。

**放哪个 group**：新建 `packages/execution-engine/` 需要一个 group `README.md` 与一篇
`docs/subsystems/execution-engine.md`（+ `.zh.md`，`verify-subsystem-pages` 会查）；想省这一步就放
`packages/workflow/execution-engine/`，借 `docs/subsystems/workflow.md`，代价是把执行引擎挂在编排子系统名下。

### 逐条要改的东西

1. **manifest** —— 新建 `packages/execution-engine/execution-engine/package.json`：`name` 改 `@deepseek-ai/dsh-execution-engine`；
   删 `"private": true`，补 `version` / `description` / `license` / `publishConfig.access` / `repository.directory`（照
   `packages/client/file-upload/package.json:2-12, 53`）；`exports` 改成 `.` → `lib/index.js` + `lib/types/index.d.ts`、
   `./client` → `lib/client.js` + `lib/types/client/index.d.ts`、`./src/*`、`./package.json`；`main` / `types` 补上；
   `files` 重写成产物清单；`dsh.client` 保留 `platform: 'web'`（不需要 `external`——面板只依赖基线的 react / cordis / ui-slots）。
2. **依赖段** —— `@deepseek-ai/cordis` 进 `peerDependencies` + `devDependencies`（仓库硬规矩）；`@deepseek-ai/schemastery` 进
   `dependencies`；host 值依赖（`dsh-agent`、`dsh-jobs`、`dsh-llm`、`dsh-ptc-runtime`、`dsh-sandbox`、`dsh-sandbox-policy`、
   `dsh-session`、`dsh-subagent`、`dsh-subprocess`、`dsh-system-prompt`、`dsh-tools`、`dsh-client-connection`）按
   `scripts/verify-package-dependencies.ts` 的分类填 `dependencies` / `peerDependencies`（`--fix` 能改，但未分类的导出会先报错）。
3. **源码搬迁** —— `host/*.ts` → `src/*.ts`；`client/index.tsx` → `src/client/index.ts`、`client/panel.tsx` → `src/client/panel.tsx`、
   `client/locale.ts` → `src/client/locale.ts`；`shared/protocol.ts` → `src/protocol.ts`。
   **注意 `.tsx` → `.ts` 这一步不是风格问题**：`packages/client/tsdown.client.ts:118` 把客户端入口写死成
   `src/client/index.ts`（`clientBundle()` 不接受覆盖），JSX 留在 `panel.tsx` 里。
   相对 import 只改后缀路径：`../shared/protocol.ts` → `../protocol.ts`，`./host/xxx.ts` 之间的引用同层不变。
4. **tsconfig** —— 删掉现在的 `tsconfig.json` / `tsconfig.client.json`（两个 `noEmit` 检查用 program），换成
   solution-only 根 `tsconfig.json` = `{"files": [], "references": [host, client]}`，加 `tsconfig.host.json`
   与 `tsconfig.client.json` 两个叶（`extends` 仓库的 `tsconfig.base[.client].json`、`rootDir: "src"`、
   `outDir: "lib/types"`、`tsBuildInfoFile`、`files` 逐个列源文件），references 每个 workspace 依赖一条外加
   `{"path": "../../../vendor/cordis"}`（照 `packages/client/file-upload/tsconfig.host.json`）。
   还要在仓库根的**两个聚合**里各加一条 references：`tsconfig.host.json`（host face）与 `tsconfig.client.json`
   （client face，参照它已有的 `./packages/client/file-upload/tsconfig.client.json` 那一行）。
5. **客户端 bundle** —— 删 `build/build-client.mjs`（自己复刻的 esbuild 模块表协议），新建 `tsdown.config.ts`：
   `import { clientBundle } from '../../client/tsdown.client.ts'` + `clientBundle('@deepseek-ai/dsh-execution-engine', ['lib/types/index.js'])`；
   `package.json` 的脚本从 `node build/build-client.mjs` 换成 `tsdown`。**`devDependencies` 里的 `esbuild`（`package.json:30`）
   也要一起删掉换成 `tsdown`**——只是换 script 会留下一个没人引用的打包器依赖。`clientBundle` 会自己按包名找
   `packages/*/*/package.json`，所以包**必须**落在 `packages/<group>/<pkg>/` 这一层。
6. **client 三注册面**（缺任何一条会在不同时刻失败）：根 `tsconfig.client.json` 的 client 聚合 references、
   `packages/bundle/web-app/cordis.patch.yml` 加一行（照 `:193` 的 `file-upload` 行）、
   `packages/bundle/web-app/package.json` 加 `"@deepseek-ai/dsh-execution-engine": "workspace:^"` 依赖。
   **那一行一加，面板就首次随产品出货**，按仓库规矩这次 PR 需要 `record-browser-gif` 产物：阶段 6 欠下的 GIF 债
   随迁移一起还，**由迁移那一次补录**（录的是迁移后 `dsh web` 里的面板，不是现在这个独立仓库里的）。
7. **测试换 runner** —— `tests/*.spec.ts` 现在跑在 `node:test` 上；仓库门吃的是 vitest，要换成
   `import { describe, expect, it } from 'vitest'` 的写法。`tests/loader-driver.ts` 的 B 档驱动保留，但它引用的
   路径（`../host/index.ts` → `../src/index.ts`、fixture 里的行名）全部要改；`tests/overlay.spec.ts` 断言
   `build/build-client.mjs` 与 `client/index.tsx`，迁移后要么改写成断言 `tsdown.config.ts`，要么删掉
   （它的价值被 `verify-client-packages` 与 `clientBundle` 接走）。
8. **README** —— 包 README 要按 [docs/cookbook/adding-a-package.md](../../docs/cookbook/adding-a-package.md) 的结构重写：
   加了 **Model Experience** 段（本插件系统提示里有 `.d.ts` 段、两个工具描述会进请求，必须写清 token / KV-cache 影响），
   并把本文的「已知限制」收进 `## Known Limitations and Deferred Work`（`verify-package-readme-limitations` 会查，
   没有的包要进允许清单）。本文是中文单语，迁进 `packages/` 后按 [docs/AGENTS.md](../../docs/AGENTS.md) 的双语规则拆成
   `README.md` + `README.zh.md` + `README.i18n.yaml`。
9. **覆盖率** —— `pnpm run test:coverage` 是**逐文件 100%**（`packages/*/*/src`）。当前缺口（按文件列）：
   `src/index.ts`（`authorityOf` 的抛错分支）、`src/engine.ts`（`renderValue` 的无返回值分支、`readTraceRecord` 的拒绝分支、
   `renderOutcome` 两条）、`src/tool.ts`（两条 render、schema）、`src/process-binding.ts`（大部分）、
   `src/client/*`（面板与轮询源）。补法只有两条：写 spec（`process-binding` 与 `engine` 的运行时依赖要 mock 或用 v8 ignore 之外
   的真实装配），或者给**真的不可达**的分支写 `/* v8 ignore -- <理由> */`（仓库禁止裸 ignore）。
10. **新受管的门** —— 迁移后这些门会开始管这里：`verify-export-jsdoc`（每个导出要有 JSDoc，含 `@param`/`@returns`）、
    `verify-client-ui-i18n`（面板文案已经全走 `client/locale.ts`，应当直接过）、`verify-cordis-config`、
    `verify-package-dependencies`、`verify-client-packages`、`duplication`（跨文件克隆检测）、`hygiene`（publint）。
11. **keyless 录制会话快照** —— 本插件的模型可见面就是**三处**，快照要逐处对上：`run_program` 与 `cancel_program`
    两个工具的 **schema** 与**结果文本**，以及系统提示里的 **`execution-engine-sdk` 段**（`host/sdk.ts` 的 `sdkText`，
    两个超时数字是插进去的已解析值）。这三处任何一处改了就要有 `snapshots/` 里的 keyless 录制会话，用
    `pnpm run test:snapshot` 回放；阶段 1/2 的 plan 把这条留到了迁移时，迁移时不能再留。
12. **删本目录自带的 workspace 文件** —— `pnpm-workspace.yaml` / `pnpm-lock.yaml` 是它作为独立 git 仓库、自己当 workspace
    root 的产物；迁进 `packages/` 后由仓库根的 pnpm workspace 接管，两个文件都要删。**仓库根的 `pnpm-lock.yaml` 会跟着变**
    （多出一批 workspace 依赖边），那是迁移那次提交的一部分。
13. **Agent Note** —— 迁移是非平凡改动，仓库要求同 PR 有一篇 `.agents/notes/implemented/` 下的记录。

### 迁移时会最疼的

- **覆盖率从"90 条 spec 覆盖到哪里算哪里"变成逐文件 100%**：`src/client/*` 与 `src/engine.ts` 是两块硬骨头，
  面板要浏览器环境（jsdom pragma）或者把折行/开窗/当前行那几条纯函数抽出来单测；`engine.ts` 要在真装配下测。
- **客户端 bundle 的同进同出**：`dsh.client` 声明了就必须有 `lib/client.js`，而迁移把打包器整个换掉（自建 esbuild → 仓库
  `clientBundle`），模块表 id、banner/footer、external 规则全部改由 preset 决定；`lib/` 不进 git，所以"本地能跑、干净树不能跑"
  这类问题只在别人 checkout 时才暴露。
- **测试 runner 与路径的连带改动**：`node:test` → vitest、`tests/loader-driver.ts` 里写死的相对路径与 fixture 行名、
  以及 `overlay.spec.ts` 这类"为绕开仓库门而存在"的 spec，全都是迁移当次必须一起改的东西，改漏一条就是在别人的 CI 上红。
- 次要但会咬人的：`flow.tmpDir` 的 `<会话工作目录>/.execution-engine/` 在迁移后仍会落在被测/被用的工作目录里，
  仓库根的 `.gitignore` 该不该加它，那时要一并决定（本阶段按裁决没有改）。

## 参考

- [design.md](./design.md) —— 设计依据（§12 阶段 7 的交付补记、§13 七项的结论）
- [phase6-plan.md](./phase6-plan.md) / [phase7-plan.md](./phase7-plan.md) —— 上一阶段与本阶段的方案
- [`packages/ptc-runtime/ptc-runtime/README.md`](../../packages/ptc-runtime/ptc-runtime/README.md) —— 执行缝、超时语义、失败种类
- [`packages/workflow/workflow-ptc`](../../packages/workflow/workflow-ptc/README.md) —— host / guest / binding 结构模板
- [`packages/jobs/jobs/README.md`](../../packages/jobs/jobs/README.md) —— 后台 job 契约与 owner 隔离
- [`packages/core/system-prompt/src/index.ts`](../../packages/core/system-prompt/src/index.ts) —— `section()` 注册
