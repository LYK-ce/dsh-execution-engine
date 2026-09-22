# ExecutionEngine — 设计文档

一个独立的执行引擎。主 agent 产出一段程序交给它，它按程序执行；程序里不确定的步骤派子 agent，确定的步骤跑外部程序。

本文档是 ExecutionEngine 插件的设计依据。所有产物先放在 `Workspace/` 下，确认可用后再集成进 DSH 本体。

状态：设计已冻结。实现进度见 §12，阶段 0–7 已全部落地（**尚欠阶段 6 的 GIF**，见 §12 阶段 6 与阶段 7 的补记）；§13 的七项待定已在阶段 7 结清。

## 1. 目标与动机

### 1.1 问题

主 agent 在长任务里**纪律会衰减**。典型场景：要求它"每个阶段完成后给我发一封邮件"，它在第 1 阶段记得，第 5 阶段忘了。

这不是能力问题，是"把常规动作托付给自由发挥"必然带来的问题：待办事项没有位置、没有所有者、没有审计点，忘了就是忘了。

### 1.2 解法

把流程从主 agent 的自由发挥里拿出来，**变成一段程序**。

主 agent 只负责一个不确定动作——**写出这段程序**；写完之后，执行是机械的。"发邮件"从此不是某个 agent 的待办事项，而是程序里的一条语句，不可能被忘掉。

### 1.3 关键认识：确定性在流程上，不在结果上

有些步骤本来就是非确定的——"调研 xxx 会返回什么"没人知道。这不是缺陷，是任务的本质。

所以本设计追求的不是"结果确定"，而是：

- **洞在哪里**（第几步、在什么条件下）
- **洞的输入是什么**（prompt 是程序里的字面量，不是每次现编）
- **洞的输出是什么类型**（文本 / 判定 / 结构化值）
- **拿到输出之后无条件做什么**

每次执行，这四样一个字都不变，变的只有洞里的内容。

由此得到一个副产品：**洞是可记录、可复用的单元**。"第 3 个洞这次返回了什么"是个能回答的问题；"主 agent 第 5 轮为什么没想起来发邮件"根本不是个能回答的问题。这是本设计比"在提示词里加一条纪律"强的地方——不是更可靠，而是**可审计**。

### 1.4 定位：不是修改 agent loop，是在它旁边造一个执行器

本插件不修改 agent loop，而是把长任务的**中段执行**从 loop 里搬出去，让 loop 只剩"写程序"和"看结果"两个动作。

## 2. 与其他能力的位置关系

DSH 里已有两个相邻能力，本插件 ≈ **后台化的、带 `process` 和 `report` 原语的 workflow**。

| | `workflow`（现有） | ExecutionEngine |
|---|---|---|
| 谁写脚本 | 主 agent / 人 | 主 agent（同） |
| 控制流 | JS，有 if / loop | TypeScript，有 if / loop（同） |
| 洞 | `agent()` | `dispatchsubagent`（同） |
| 确定性原语 | **无**（脚本被削得碰不到 fs / 进程） | `process` |
| 汇报给主 agent | 只有最终返回值 | `report`，可多次 |
| 生命周期 | **前台阻塞**，占满父回合 | **后台 job**，不阻塞回合 |
| 并发 | 可多个 | **单例** |

差异集中在四处：**多一个 `process`、多一个 `report`、后台化、单例**。其余机制全部可以复用现有实现（见 §7）。

## 3. 程序可见的 API

### 3.1 语言原生能力（不由本插件提供）

程序是一段 TypeScript。函数、变量、循环、分支、字符串处理、JSON 解析、`Math`——**全都是语言自带的，都有返回值**。

程序体在 `vm` context 里求值（§7.2），因此**它只能看见被显式注入的能力**：`flow` 命名空间、`console`、收窄的文件助手、`fetch`。没有 `import`——**程序不能 import 库或项目文件**，这是选择"能力面可枚举"付出的代价，属于明确接受的取舍。

**这一条直接决定了"返回值"问题的答案：要一个值，就在程序里用 TS 算；`process` 那个位置本来就不该指望返回值。**

### 3.2 三个原语

```ts
/** 派一个子 agent 执行一段工作，返回它的最终文本。非确定。 */
dispatchsubagent(prompt: string, opts?: { provider?: string; model?: string }): Promise<string>

/** 执行一个外部程序。非零退出码与超时都正常返回，由程序自己判断。 */
process(argv: string[], opts?: ProcessOptions): Promise<ProcessResult>

/** 同 process，但非零退出码或超时抛出。用于表达"这一步必须成功"。 */
processOrThrow(argv: string[], opts?: ProcessOptions): Promise<ProcessOutput>

/** 向主 agent 单向汇报一段内容。 */
report(text: string): void
```

`dispatchsubagent` 的第二个参数是阶段 8 加的：程序可以按**这一次调用**指定子 agent 用哪个模型。`provider` 与 `model` 必须成对给出（只给一个就抛，不回落），授权来源是部署挂的 `subagent-model-selection` 策略——引擎读**同一份**清单，不新造第二份白名单，也不查 LLM 目录（那是 advisory）。两个都不给就是沿用当前会话的模型，与阶段 2 的语义一致。发现走主 agent 的 `list_subagent_models` 工具，`.d.ts` 不抄目录（§12 阶段 8）。

分工：

| 原语 | 语义 | 确定性 | 会不会碰主 agent 上下文 |
|---|---|---|---|
| 语言原生 | 计算、变换、判断 | 确定 | 不会 |
| `dispatchsubagent` | 非确定的洞 | **非确定** | 不会 |
| `process` / `processOrThrow` | 副作用通道 | 确定 | 不会 |
| `report` | 单向汇报 | 确定 | **会** ← 唯一一个 |

### 3.3 决策：`process` 为什么非零不抛

`process` 非零退出码**正常返回**，另给 `processOrThrow` 承担严格语义。理由：

- "失败"往往是**业务语义**，引擎没资格判断。`grep` 没匹配到返回 1 是正常的，`diff` 返回 1 表示有差异。
- 抛异常会打断控制流，逼着每个调用都包 `try/catch`，最后没人包了。
- 用异常会诱导"忽略退出码"——那恰恰是邮件没发出去却没人知道的根源。

程序要检查就检查；不检查是它的选择，而这个选择**白纸黑字写在程序里，可审计**。

### 3.4 决策：`process` 不承载业务返回值

跨进程没有 C 那种 `return`。OS 在进程结束时只带回来三样东西：**退出码**（0~255，装不下一个值）、**stdout**、**stderr**。没有第四个通道。

因此 `stdout` / `stderr` 只用于**诊断**（失败时写进 `report` 说清楚原因），**不承载业务返回值**。

**取值约定**：当值确实在外部脚本里（例如一个现成的 Python 库），约定"脚本写文件 → 程序读文件"：

```ts
processOrThrow(["python", "add.py", "1", "2"])   // 非零就抛，不会往下走
const sum = Number(readFile(resultPath))          // 到这一行，脚本一定成功
```

文件系统就是跨进程的取值通道，比 stdout 更明确、更好调试。

配套规矩：

- **先用 `processOrThrow` 确认成功，再读文件**——否则会读到不存在的或写了一半的文件。
- **脚本先写临时文件再原子改名**——否则脚本中途崩溃会留下半个内容的文件。
- 现成脚本若已有自己的输出路径约定，就用它们的，不强行统一。

### 3.5 run 专属临时目录

"写到 xxx"里的 xxx 需要一个确定落点，否则每个程序各选各的路径会乱。

**引擎为每次 run 建一个专属临时目录，run 结束时整体删除**，通过一个已知入口暴露给程序：

```ts
flow.tmpDir: string   // 本次 run 专属；引擎创建，引擎删除
```

**位置：会话工作目录下的 `.execution-engine/<runId>/`，不是 `os.tmpdir()`。**

- 约定的落点确定：写进 `.d.ts`，主 agent 不用猜。
- **必须放在工作目录内**：受管期的可写范围就是工作目录。跨 `process` 边界的取值约定（外部脚本写、程序读）要求两边都能访问同一个可写位置，而 PTC 子进程与宿主 spawn 出的受管子进程各有各的私有临时目录——**工作目录是唯一的交集**（§7.2）。
- 清理归引擎：run 结束时整体删除，失败只记日志、不影响结果。
- 天然"每次 run 独立"，与 §7.3 一致。
- 代价：run 期间工作目录里会出现一个 `.execution-engine/` 目录；硬崩溃时可能残留。

## 4. 执行模型

### 4.1 后台 job

主 agent 调 `run_program(code)` → 引擎**注册为后台 job 并立刻返回**，主 agent 的回合不被阻塞。

复用 `ctx.jobs`（见 §7.4）：它本就是为"工具留下长活、agent 继续"设计的，包含 id、owner 隔离、读取快照、等待、取消、完成通知。

### 4.2 单例

**每个主 agent 同时只能有一个程序在跑。**

好处不止"心智模型简单"：**`report` 的时序天然清楚**。若允许多个程序并存，主 agent 被唤醒时上下文里可能同时躺着两条不同程序的报告，它自己都分不清。单例消除了这个问题。

注意范围是**每个主 agent 一个**，不是全局一个——不同会话各跑各的，互不影响，这与 §5 的归属设计一致。

### 4.3 启动时已有程序在跑 → 拒绝

返回明确错误："已经有一个程序在跑（flow-1），要先取消它。"

**不自动取消旧的。** 自动取消看起来方便，但主 agent 的意图可能是"我再加一个"，结果悄无声息地**杀掉了正在发邮件的程序**，而它自己不知道。拒绝虽然多一步，但让主 agent 的心智模型与现实一致——"同时只有一个，要换就得先停"。错误信息本身就是最好的教学。

### 4.4 取消

三个入口，**收敛到同一个取消操作**：

1. 主 agent 调工具
2. 用户点 UI 按钮
3. 主 agent 被 dispose（会话关闭 / 插件 unload）

取消的语义：

- **幂等**：没有程序在跑时明确返回"当前没有正在运行的程序"。这是主 agent 唯一的知情途径——**不需要主动通知它程序已经结束**（见 §6.4）。
- **等到清理真正完成才返回**。注意这里有个容易混的地方：**"不等程序自己收拾" ≠ "不等清理完成"**。前者指不发取消信号让程序跑 `finally`，直接硬杀；后者指引擎仍要 await 进程真的终止、子 agent 真的 drain 完。后者不能省，否则主 agent 取消后立刻启动新的，旧进程还活着，单例就形同虚设。
- **未投递的 `report` 全部作废**。程序死了，它没来得及说的话就别说了。否则主 agent 会被幽灵报告误导——用户刚点了取消，它却基于过期报告决定"取消并重启"，把用户刚叫停的东西又跑起来。

## 5. 归属、权威与生命周期

### 5.1 归属

**不建常驻 agent。** 所有子 agent 的 `parentAgent` = **发起的主 agent**。

`workflow` 已有先例：`WorkflowStartRequest.parent` 就是"attributes every child to the invoking agent"。

### 5.2 权威

cwd、文件策略、审批上下文**每次 run 从发起的主 agent 现场快照**，不固化在引擎上。

这与归属是两件事，必须分开：归属决定父子关系和取消层级，权威决定"用谁的目录、谁的沙箱策略、谁审批"。`workflow-ptc` 已有先例——它按调用会话的 standing file policy 和 cwd 解析 PTC 执行。

### 5.3 程序不脱离主 agent 存在

三层全部挂在主 agent 上：

| 机制 | 挂在哪 | 主 agent dispose 时 |
|---|---|---|
| background job | 主 agent 的 session | owner disposal 取消活并 **await** producer |
| 子 agent | `parentAgent` = 主 agent | teardown drain children |
| PTC 进程 | run 的 abort signal | abort → 终止进程 + await 清理 |

任意一层没接上就会漏出孤儿；三层都接上，"主 agent 死 → 程序死"就是构造性保证，不需要额外检查逻辑。

**绑的是 agent 实例的生命周期，不是 turn。** "主 agent 挂掉"指 agent 被 dispose，不是一轮 turn 结束——用户取消一轮 turn 不应杀掉后台程序，否则"后台托管"就没有意义了。

### 5.4 静默硬杀

主 agent 消失时程序被静默硬杀，**不给程序清理机会**。副作用可能残缺（半封邮件、半个文件）。这是有意接受的代价。

## 6. 汇报通道

### 6.1 `report` 走 followup

`report(text)` → 投递成主 agent 收件箱里的一条 **followup** → **唤醒主 agent，每条一次模型调用**。

DSH 的投递接口有四种形态，本设计选 followup 而非 inject：

| 方法 | 进上下文 | 唤醒主 agent |
|---|---|---|
| `inject` | 会 | **不会** |
| `followup` | 会 | 会 |
| `steer` | 会 | 会 |

选 followup 意味着**每条 report 都是一次完整的模型调用**，代价已被明确接受。

### 6.2 两个好性质

- **严格有序**：followup 的消息"becomes the sole ordinary message of its own turn"，所以主 agent 看到的顺序**就是**程序 report 的顺序，不会挤在一起、不会乱插。
- **不打断**：它排队。主 agent 正在忙就等它忙完，不会污染它正在进行的活动。

### 6.3 程序不等待主 agent

`report` 投出去程序就继续跑，**不等主 agent 处理完**。所以主 agent 可能刚看到"阶段 3 完成"，程序已经干到阶段 7。

这对目标场景（邮件由程序自己发，`report` 只是知会）没问题——滞后的知会也是知会，主 agent 本来就是旁观者。

`report` 应是 `await` 的（等投递成功，不等处理完成），这样程序里有一个确定的时序点。

### 6.4 单向，无双向调用

`report` 是**单向通知**，主 agent 不能向程序回话。

因此主 agent 能做且只能做三件事：**启动 · 取消 · 看 report**。

这是一个干净的"控制面 / 数据面"划分：程序通过 `report` 单向汇报，主 agent 通过"启动 / 取消"单向控制。**没有任何双向调用，所以结构上不可能死锁。**

**但这三条在默认部署里守不住，如实记账：** 标准 preset 挂着 `@deepseek-ai/dsh-tool-jobs`（`packages/preset/agent-presets/presets/standard/agent.cordis.yml:74-75`），它① 向 owner 投递 job 完成通知，② 把 `job_output` / `job_list` / `job_kill` 三个通用工具暴露给模型。所以主 agent 实际还能**读走程序全文**、还能**杀掉 job**。`JobStart` 没有让生产者退出通知的开关，`reported` 归注册表所有，**本插件从生产方一侧抑制不了**。

缓解手段：

- **唤醒**是部署可配的——`tool-jobs` 的 `completionDelivery: 'quiet' | 'wakeup'`（默认 `wakeup`，`packages/jobs/tool-jobs/src/index.ts:28,50`）。想要 §6.5 的 fire-and-forget 性质，部署侧配成 `quiet` 即可，**纯配置，不动 `packages/`**。
- 三个通用工具属于 preset，本插件删不掉。**"只能做三件事"因此是一条设计意图，不是默认部署下的事实。**
- 生产者侧的退出开关列为阶段 7 的可选项（要动 `packages/`，当前范围之外）。

### 6.5 fire-and-forget

对主 agent 而言程序是 fire-and-forget：**它不需要知道程序何时结束、为什么结束**（跑完 / 失败 / 被用户取消都一样）。

这不影响正确性，因为主 agent 本来就不阻塞在程序上——它只是继续干自己的事，report 来了就处理。但有一条推论必须处理，即 §4.4 的"未投递 report 作废"。

（§6.4 末尾记的 `tool-jobs` 完成通知会额外唤醒一次；它不破坏 fire-and-forget 的正确性，只是让"不需要知道"变成"会知道"。部署可用 `completionDelivery: 'quiet'` 关掉。）

## 7. 语言与运行时

### 7.1 语言：可擦除 TypeScript

- 程序写 **erasable TypeScript**，运行时 `stripTypeScriptTypes` 剥离类型后当 JS 执行。
- **无编译步骤、无类型检查**。类型是装饰性的：给主 agent 表达力，不给编译期保证。
- 只能写纯擦除的 TS：`enum`、带运行时语义的 `namespace`、构造器参数属性等需要生成代码的特性不可用；写了会被拒绝，且报错信息会说明如何改。

给主 agent 的接口文档就是一份**生成的 `.d.ts`**（§11），它照着写。

### 7.2 执行形态、能力面与权威

**程序体在 `vm` context 里求值**（照 `workflow-ptc` 的 `vm.createContext` + `vm.Script`）。它跑在 PTC 的完整 Node 子进程内，但**程序只能看见被显式注入的能力**：`flow` 命名空间（`process` / `processOrThrow` / `tmpDir`）、`console`、收窄的文件助手、`fetch`，以及语言内建。**没有** `process`、`require`、动态 `import`、`child_process`。

**这不是安全边界。** 实测可逃逸——`this.constructor.constructor("return process")()`，以及**任何注入函数的 `.constructor`**；加 `codeGeneration: { strings: false, wasm: false }` 也堵不住。定位与 `workflow-ptc` 一致：*withheld globals guide script authors*。**扣留是为了引导，不为堵逃逸投入。**

**权威来自会话**：PTC 子进程按 §5.2 快照的 `sandboxPolicy` 执行；**`process` 起的外部进程也必须过同一份策略的 `ctx.sandbox.confine`**（先例 `packages/shell/bash-sandbox`）。否则会裂开一道口子——主 agent 自己的 bash 写不了文件，而程序里的 `process` 能写任何地方，§5.2 的"权威一致"就成了空话。

**外部执行一律走 `process`。** 理由不是安全，是**可靠性**：超时一定生效、进程树一定清干净、每一次外部执行都可观测——而单例之下，一个绕过超时的野进程可能永久锁死槽位。

### 7.3 每次 run 一个新进程

每次 run 起一个全新的 Node 进程，跑完即死，**run 之间没有状态**。

这与现有 `ptc-runtime` 的契约一致（"no state survives between runs"），也是为了保持"每次执行都能从日志重建"这条性质。

超时后**杀**的是整个进程树（`ctx.subprocess` 的终止覆盖树），但**等待**只覆盖 provider 能证明的受管范围：POSIX fallback 用进程组探活，Windows fallback **只保证直接子进程**——provider 自己的文档也承认 "descendants that escape ... are not guaranteed to terminate or delay `waitForExit()`"。所以准确的承诺是"**等 provider 能观察到的受管范围静默**"，而不是"等到整棵树都没了"。这个差别要写进已知限制。

### 7.4 复用现有能力

| 需要什么 | 从哪来 |
|---|---|
| 隔离执行 + 双向 binding + 超时 + 取消 | `ctx.ptcRuntime`（Node 后端） |
| host / guest / binding 结构模板 | `packages/workflow/workflow-ptc` |
| 不阻塞回合的后台执行 + owner 隔离 + 完成通知 | `ctx.jobs` |
| 派子 agent | `ctx.subagents` |
| 子 agent 归属 | `WorkflowStartRequest.parent` 那套 |

**不需要发明执行引擎**——照 `workflow-ptc` 的 host/guest/binding 结构改：加 `process` 和 `report` 两个 binding，改成后台化 + 单例。

## 8. 观察面与 UI

### 8.1 事件

引擎发出 observe-only 的 `flow/*` 事件供 UI 消费。照 `workflow/*` 的路子：payload 携带运行身份快照，不携带活动句柄，监听者拿不到取消或清理权限。

UI 需要状态流，不能反过来"查"宿主，所以状态必须走事件。事件至少覆盖：run 启动、程序源码、原语调用开始与结束（位置、参数、结果、耗时）、`report`、run 结束（含结束原因）。

### 8.2 侧边栏面板

像 Blackboard 一样在侧边栏注册一个面板（同一个 `conversation.view` slot），显示当前程序。

**单例让面板变简单**：同时只有一个程序在跑，不需要选择器、不需要多标签，面板的语义就是"当前在跑的那一个"。

面板内容：程序源码（带行号）、当前执行位置、原语调用轨迹、运行状态。

**数据通道**：`flow/*` 出不了宿主进程，所以面板不订阅事件——宿主侧累加（`host/flow-state.ts`）出每个会话当前那一版 run 的状态，浏览器经两条 exact Fetch route 轮询（`GET .../state` 读、`POST .../cancel` 取消）。取消按钮走的是与 `cancel_program` 完全相同的那条路径。**代价是面板不可回放**，见 §10.1。

### 8.3 执行位置指示

**能做到，但不以"逐行跟踪"为目标。**

原因是程序本身是瞬时的：一段协调脚本在两步之间跑完只要微秒级，而一个 `dispatchsubagent` 可能几分钟、一个 `process` 可能几秒。**绝大部分时间花在等洞返回上，而一旦洞开始，程序就停在那一行。**

所以"当前执行到第几条代码"实际等价于"**当前卡在哪个原语上**"——这个粒度既够用又便宜。

**机制**：不改写用户源码，只在 guest 外壳里把各原语包一层。包装里用 `new Error().stack` 取到调用点在拼接后程序里的行号，减去外壳的固定行偏移，得到用户源码行号，连同参数一起发给 host。

不需要 AST 变换，不需要 V8 inspector。由此得到一条约束：**拼接时不得对用户源码做任何行变换**（不格式化、不在其中插行），否则行号全部错位。

代价：每次原语调用多一条 host 消息，量级是每秒几条，可忽略。

**面板应显示轨迹，而不只是高亮一行。** 循环里同一行会反复出现，一个单一高亮无法表达"跑到第几圈了"。轨迹（最近若干次原语调用 + 位置 + 结果 + 耗时，可滚动）才是有用的形态，当前行高亮只是轨迹的末端。

**待验证**：guest 里程序究竟如何被求值（`vm` / `new Function` / 临时文件），这决定 stack 里的行号如何映射回用户源码行。若 stack 方案不可靠，退路是用 TypeScript 自己的 parser 做 AST 变换，把每条语句包一层 `__step(line)`——粒度更细（能覆盖非原语语句），但要处理 source map 与性能，属于 plan B。

### 8.4 分两批实现

- **第一批（Host）**：引擎 + 工具 + `flow/*` 事件。这一套自己就能跑通并验证。
- **第二批（Client）**：侧边栏面板 + **取消按钮**。

面板不是"第二批附带的一个按钮"，而是**核心观察面**：§1.3 主张"洞是可记录、可审计的单元"，这个面板就是那条主张的界面。

客户端 UI 文案必须走 locale 字典。

### 8.5 不再需要的东西

单例让"主 agent 查状态"变轻：**"启动被拒绝"的错误信息本身就是状态查询**。所以不需要单独的状态查询工具，除非以后出现"想看一眼但不想启动"的真实需求。

## 9. 配置项

全部是引擎 Config 字段，部署可改。

| 字段 | 默认 | 说明 |
|---|---|---|
| `process.defaultTimeoutMs` | 300000（300s） | 单次 `process` 的默认超时 |
| `process.maxTimeoutMs` | 900000（15min） | 程序能申请的单次超时上限；超出**在解析阶段拒绝**，不是悄悄截断 |
| run 级截止时间 | **无** | 程序天然长跑（跨阶段、等信号），加整体截止会误杀正常长任务 |

无 run 级截止的先例：`workflow-ptc` 明确"没有整体 elapsed deadline，一个 run 可以一直活着，直到完成、失败或被取消"。

长程序长期占着单例槽位的风险，由**取消**兜底（三个入口）。

程序层**不提供"无限期"选项**：`timeoutMs` 省略即用默认，给数字即经校验使用，不给 `null`。真需要无限期应在部署 Config 层放开，而不是让程序自己写——单例之下那是"锁死槽位"的后门。

## 10. 已知代价与明确不做

### 10.1 有意接受的代价

| 代价 | 说明 |
|---|---|
| **没有续跑** | 取消 + 重启 = 全量重跑。取消会带走程序的全部状态（变量、循环位置、所有洞的结果）。**已发生的副作用会重来**——`notify.py` 会再发一封邮件。 |
| **判断冻结在写程序那一刻** | 主 agent 写程序时还没看到任何结果，洞里返回什么它无法临场应变。换来纪律，付出适应性。 |
| **不给程序清理机会** | 取消是静默硬杀，副作用可能残缺。 |
| **`report` 每条一次模型调用** | 频率由程序自己控制——**额度不由引擎管，程序自己管**（例如攒到阶段边界再报）。 |
| **面板不可回放** | `flow/*` 是 Cordis 观察事件（§8.1），不落 session log。浏览器拿状态只有一条路：宿主侧按会话累加出"当前这一版 run"，再经两条 exact Fetch route（`host/routes.ts`）发给面板轮询。代价有两条：**刷新页面后要等下一次轮询才恢复**，以及**看不到历史 run**（累加器只留当前那一个，§4.2 的单例之下也没有第二个可看）。要回放，就得把 `flow/*` 落成 log-only 会话事件、让累加器改读日志——那是另一量级的改动（要动 `SessionEventMap` 与持久化）。 |

### 10.2 v1 不做

| 不做 | 原因 |
|---|---|
| 程序问、主 agent 答（双向通道） | 会引入循环等待和死锁风险；当前所有场景都是单向知会 |
| 常驻解释器 / 跨 run 状态 | 破坏"每个请求都是日志的纯函数"这条性质 |
| 断点续跑 / 洞结果复用 | 需要"记录并复用非确定步骤结果"的一整套设计，是另一个量级 |
| `processJson` 之类的 stdout 结构化解析 | 值走程序内的函数和文件系统，stdout 不承载业务数据 |
| 主 agent 的中间过程查询工具 | 单例下"启动被拒绝"已能回答这个问题 |

## 11. 与主 agent 的契约（`.d.ts` 草案）

这份声明进系统提示，**就是主 agent 写程序时的 API 文档**。

```ts
/** 本次 run 的上下文。 */
declare const flow: {
  /** 本次 run 专属的临时目录；引擎创建，run 结束时整体删除。 */
  readonly tmpDir: string
}

/** 派一个子 agent 执行一段工作，返回它的最终文本。 */
declare function dispatchsubagent(prompt: string): Promise<string>

/** 执行一个外部程序。非零退出码与超时都正常返回，由程序自己判断。 */
declare function process(argv: string[], opts?: ProcessOptions): Promise<ProcessResult>

/** 同 process，但非零退出码或超时抛出。 */
declare function processOrThrow(argv: string[], opts?: ProcessOptions): Promise<ProcessOutput>

/**
 * 向主 agent 单向汇报一段内容。主 agent 会被唤醒阅读。
 * await 只等投递成功，不等主 agent 处理完（§6.3）：这一行返回时，汇报已经在主 agent 的挂起队列里。
 */
declare function report(text: string): Promise<void>

interface ProcessOptions {
  /** 本次执行的超时（毫秒）。默认 300000，上限 900000。 */
  timeoutMs?: number
}

interface ProcessResult {
  code: number
  stdout: string
  stderr: string
  timedOut: boolean
}

interface ProcessOutput {
  stdout: string
  stderr: string
}
```

## 12. 实施计划

**本目录是独立的 git 仓库**（`Workspace/ExecutionEngine/`）。每完成一个阶段提交一次；没有配置远程仓库，只提交本地。

三条原则：

- **每个阶段结束时仓库处于可运行、可验证的状态**，验证不通过不进入下一阶段。
- **每个阶段自带验证方式**，验证是具体的、能跑出来的证据，不是"看起来对了"。
- **只碰 `Workspace/ExecutionEngine/`**，不改 `packages/`。

### 阶段 0 — 骨架

**做什么**

- `git init`、`.gitignore`（`node_modules/`、`lib/`）
- `package.json`：`type: module`、`dsh.client` 段、脚本（typecheck / build / test）
- `pnpm-workspace.yaml`：本目录自成 workspace root
- `tsconfig.json`（host face）、`tsconfig.client.json`（client face）
- `execution-engine.cordis.yml`：`--patch` overlay，行名用相对路径
- 最小 host 插件：`name` / `inject` / `Config` / `apply`，注册一个占位工具

**验证**：`pnpm dsh web --patch Workspace/ExecutionEngine/execution-engine.cordis.yml` 能挂上，占位工具出现在模型可见的工具列表里。

### 阶段 1 — 跑起一段程序（前台）

**做什么**

- 接 `ctx.ptcRuntime`，把程序文本交给它执行；按 §5.2 从发起会话快照 cwd 与文件策略
- `flow.tmpDir`：每次 run 建目录，run 结束时整体删除（§3.5）
- `process` / `processOrThrow` 两个 binding：以 argv 执行外部程序；超时按 §9；超时后杀**整个进程树**（§7.3）
- 确认程序可见的 API 里没有 `child_process`（§7.2）
- `run_program` 工具（**先做成前台阻塞调用**）
- `.d.ts` 初版，只描述已经存在的原语，塞进系统提示（§11）

**为什么先做前台**：把"程序能跑、外部程序能执行"这件事先单独验证掉，再叠加生命周期复杂度。改成后台的返工很小——只是工具的 `execute` 换实现——但先做后台会让执行期的失败更难定位。

**验证**

- 程序里 `process(["python", "notify.py", "..."])` 真的执行
- 非零退出码正常返回；`processOrThrow` 抛出
- 超时生效，**且进程树被清干净**：脚本 fork 出来的子进程不残留
- 超过 `maxTimeoutMs` 的请求在解析阶段被拒绝，不是悄悄截断

### 阶段 2 — 洞：`dispatchsubagent` 与归属

**做什么**

- binding 接 `ctx.subagents`；`parentAgent` = 发起的主 agent（§5.1）
- 子 agent 的最终文本回传给程序（不进主 agent 上下文）
- 扩展 `.d.ts`

**验证**

- 程序里 `const t = dispatchsubagent("...")` 拿回文本
- 子 agent 归属正确，挂在发起的主 agent 之下

### 阶段 3 — 后台化与单例

**做什么**

- `run_program` 改为注册 `ctx.jobs`，立刻返回 job id，不阻塞回合（§4.1）
- 单例强制：已在跑时启动 → 拒绝，错误信息带上当前 job id（§4.3）
- 取消工具：幂等；**等到清理真正完成才返回**（§4.4）
- 三层生命周期挂钩：job owner / `parentAgent` / abort signal（§5.3）

**验证**

- 主 agent 的回合结束后程序继续跑
- 主 agent 被 dispose 时程序一起死（会话关闭 / 插件 unload 两条路径）
- 取消返回后能立刻启动新程序，不会出现两个并存
- 取消一个并不存在的程序 → 明确返回"当前没有正在运行的程序"

### 阶段 4 — `report` 与 `flow/*` 事件

**做什么**

- `report` binding → 主 agent 收件箱的 `followup`，每条一次模型调用（§6.1）
- **未投递的 `report` 在取消时作废**（§4.4）
- `flow/*` observe-only 事件：**本阶段发三类**——`flow/start`、`flow/report`、`flow/end`（§8.1 列了五类，另两类的去向见阶段 5）
- 扩展 `.d.ts`

**验证**

- `report` 真的唤醒主 agent，且顺序与程序调用顺序一致
- 取消之后，残留的 report 不再被投递
- 主 agent 正在忙时 report 排队，不打断它当前的活动

### 阶段 5 — 执行位置上报（Host / Guest）

**做什么**

- **先确认 guest 里程序如何被求值**（`vm` / `new Function` / 临时文件），据此确定行号映射方案（§8.3）
- guest 外壳包装各原语，用 `new Error().stack` 取调用点行号并上报；拼接时保持用户源码的行结构不变
- `flow/*` 事件带上位置，并补上 §8.1 里推迟的两类：
  - **程序源码**——它要带行号给面板用，所以形态由本阶段的行号映射决定（事件带原文还是带已编号的行）
  - **原语调用起止**——位置上报就是它的前提
- 若 stack 方案不可靠，改走 AST 变换作为 plan B（§8.3）

**验证**

- 事件里的行号与用户源码行号一致，包括循环里重复出现的同一行

### 阶段 6 — 侧边栏面板（Client）

**做什么**

- client 半边 + `conversation.view` slot（§8.2）
- 程序源码带行号、当前行高亮、原语调用轨迹、运行状态
- **取消按钮**，与工具取消走同一个操作
- locale 字典（en / zh）
- 录一段 GIF 作为验证产物

**验证**

- 面板跟随真实执行；循环里轨迹能表达"跑到第几圈"
- 按钮取消与工具取消行为一致

**本阶段的验证落点**（阶段 6 实现时补记）：

- A 档（在开发机上跑通）：两个 face 的 `typecheck`、`pnpm run test`（含 `tests/flow-state.spec.ts` 的累加器/有界/增量折叠）、`pnpm run build` + `node --check lib/client.js`，以及 `lib/client.js` 里的模块 id 与 locale 键断言。
- B 档新增 B14a（两条 route 真的挂在 `ctx.connection.fetch` 上，经 connection 的共享 fetch 处理函数发请求）与 B14b（面板状态与 `flow/*` 逐条一致、`since` 增量、经路由取消且返回时清理已完成）。
- **GIF 未产出**：录制需要"真服务器 + 浏览器控制"，而那台开发机上两样都不具备（`pnpm dsh web` 起不来，也没有可驱动的浏览器）。**不拿截图或说明文字冒充**。它必须在能跑 `dsh web`（真 API key、`--patch` 本插件的 overlay）并能驱动浏览器的环境里按 `record-browser-gif` 技能补录。

### 阶段 7 — 收尾

**做什么**

- README
- 补齐回归测试（§13 第 5 条列的那些）
- 决定是否、以及如何搬进 `packages/`

**验证**：全量测试通过；文档与实现一致。

**本阶段的交付与验收落点（阶段 7 实现时补记）**：

- **交付**：`README.md`（含「回归测试覆盖」与「搬进 `packages/` 时要做什么」两节）；A 档新增
  `tests/routes.spec.ts`（7 条）与 `tests/tmp-dir.spec.ts` 的清理失败用例（补的是 §13 第 5 条没列、
  但审计认为该有的两处）；§13 七项结清（见下）。
- **A 档（本会话跑过）**：`pnpm run typecheck`、`pnpm run test`（90 条全绿）、`pnpm run build`、
  `node --check lib/client.js`，以及 `lib/client.js` 里模块 id 与 locale 键的断言。
- **B/C 档的判据在开发过程中每个阶段都由负责人执行并全部通过**（B0–B14b、两份 fixture、C 档含三条 curl 路由判据）；
  命令与逐条判据写在 README 的「验证」一节，可随时复跑。
- **由委派 subagent 执行时跑不了**：subagent 会话的沙箱挡住的是 `tsx` 内部 **esbuild service worker 的管道子进程**
  （`spawn EPERM`，落在 `startSyncServiceWorker`），**不是 `tsx` 本身**——`node --import tsx/esm -e "console.log('TSX_OK')"`
  在同一个沙箱里通过，仓库根也装了 `node_modules/tsx`；C 档还额外要能驱动浏览器。负责人这一层有升级通道，
  所以这两档不存在"没人跑过"。
- **GIF 仍未产出**：阶段 6 记的原因不变，必须在能跑 C 档并能驱动浏览器的环境里按 `record-browser-gif` 补录。
- **迁移未执行**：本阶段只产出方案，见 §13 第 1 条与 README 的对应一节。
- **§6.4 末尾留的"生产者侧退出开关"本阶段没有做**：它要动 `packages/`（让 `JobStart` 能声明不投递完成通知），
  超出本阶段"只碰 `Workspace/ExecutionEngine/`"的边界。默认部署下的实际行为（`tool-jobs` 仍会唤醒一次、
  模型仍能用三个通用 job 工具）记在 README 的「已知限制」里，作为一条如实的账。

### 阶段 8 — 按调用指定子 agent 模型

**做什么**

- `dispatchsubagent` 加第二个参数 `opts?: { provider?: string; model?: string }`，转发成 `SubagentStartRequest.agentOptions`。
- 校验读**同一份** `ctx.subagentModelSelection` 策略；服务缺席、未开启、清单为空、route 未命中都拒绝显式指定。
- `.d.ts` 指向 `list_subagent_models`，不抄目录。

**验证**：A 档（typecheck / test / build / `node --check`）+ 插件自己的 `.d.ts` golden 断言；B 档新增 B15。

**本阶段的交付与验收落点（阶段 8 实现时补记）**

- **程序可见面**：`dispatchsubagent(prompt, opts?)`。加了 `reasoningEffort` 之外的两个字段，**只加这两个**。
  外壳（`host/guest-source.ts`）拒绝 `provider` / `model` 之外的自有键：静默丢掉它们会得到"成功但用的不是
  它要的东西"——姊妹工具的字段叫 `reasoning_effort`，丢掉了就是默认 effort，而绑定那一层看不到那个键。
- **授权来源是同一份策略**：`ctx.get('subagentModelSelection')`，与 `tool-subagent` 用的是同一个服务；不在
  `inject` 里，理由与 `connection` 同一条（它是 web-app bundle 挂的部署特性，缺席只该让"显式指定"被拒，
  不该让 headless 部署连 `run_program` 都不注册）。
- **与 `tool-subagent` 的一处有意差异**：那个工具在组合时**快照**策略，引擎每次 `dispatchsubagent` 调用现读
  `current()`。真原因是**引擎没有每会话组合点**——工具在插件加载时注册一次，run 是会话起来之后才有的；快照
  一份就等于策略改动后引擎一直按旧的那份判，而校验的对象必须是这一次调用的参数。**后果**：会话中途改动设置
  之后，`list_subagent_models` 广告的是它组合时快照的策略、引擎执行的是现读的策略，不一致时会出现
  "广告了却被拒"（快照里已删掉的 route 还在广告、调用被引擎拒；刚加上的 route 能执行却没人广告）。
- **拒绝的形态**：只给 `model` 抛——**沿用** `packages/subagent/tool-subagent/src/list-models.ts:47` 的同一句
  `` `model` requires `provider` ``，外面加 `dispatchsubagent: ` 标明是哪个原语拒的（整条消息不是逐字一样的）；
  只给 `provider` 同待遇；没命中的 route 抛，消息里列出可用 route（`available routes: …`；一条都没有时是
  `(none)`），让模型能自我纠正。列表有界（12 条 + 省略号）。
- **不查什么**：不查 `capabilities.agentOptions`（`ctx.subagents.start` 自己会拒）、不查 LLM 目录
  （`LlmModelInfo` 的目录成员资格是 advisory）、不查 `ctx.llm.listProviders()`——引擎不注入 `ctx.llm`。
  **不注入 `ctx.llm` 的代价**：策略里列了未注册的 provider 时校验照样通过、`start` 也成功
  （`assertCapabilities` 只查能力位、`resolveChildAgentOptions` 只合并父子路由，都不查注册），子 agent 会话
  建出来之后**第一次模型请求**才在 LLM 适配器层炸——仍然响亮，但晚了一整层、措辞也是 provider 层的
  （`AgentOptions.provider` 的契约是"call time 必须有注册的适配器"，`packages/core/agent/src/runtime-types.ts:26-35`）。
  发现侧先一步兜住：`list_subagent_models` 的无参清单用 `listProviders()` 过滤，未注册的 provider 根本不出现。
- **A 档（本会话跑过）**：`pnpm run typecheck`、`pnpm run test`（104 条全绿）、`pnpm run build`、
  `node --check lib/client.js`，以及 bundle 里模块 id 与 locale 键的断言。
- **B 档新增 B15**（由负责人跑）：命中清单的 route 逐字到脚本化 provider 的 `agentOptions`、不填时那个键
  不在场、清单外的 route 抛出且消息带可用清单、只给 `model` 抛出且消息里含同一句
  `` `model` requires `provider` ``。fixture 为此挂上
  `subagent-model-selection-settings`，脚本化 provider 声明 `agentOptions` 能力位并记录完整请求。
- **C 档多一条判据**：C 档组合里 `subagent-model-selection-settings` 由 web-app bundle 挂
  （`packages/bundle/web-app/cordis.patch.yml:47`，那一行没有 config，所以服务在场、策略关闭）：默认状态下带
  `{ provider, model }` 的调用被拒且清单是 `(none)`；在设置里打开并加一条 route 之后同一段程序跑通——这是
  "引擎读得到**真部署**的策略"唯一看得见的形态（B15 用的是 fixture 自己挂的同名服务）。
- **仓库级 keyless 快照仍未产出（迁移欠账）**：`snapshots/AGENTS.md` 要求每个被测进程经 `dsh` CLI + 一个
  shipped profile 启动，而本插件今天是 `--patch` overlay、不在任何 shipped profile 里。本阶段用插件自己的
  golden 断言（`tests/sdk-text.spec.ts`）把 `.d.ts` 渲染文本逐字钉住；仓库那一份随迁移补。**

## 13. 待定项的结论（阶段 7 结清）

七项逐项结清。结论给在这里，逐条证据与可执行步骤在 `README.md` 里。

1. **包怎么拆** —— 现在保持扁平（`host/` / `client/` / `shared/`）；搬进 `packages/` 时按**一个双面包**
   `@deepseek-ai/dsh-execution-engine`（host 半边 + client 半边 + `src/protocol.ts`）落地，**不**按
   engine / tool / client 三包拆。理由：client 半边要用 `STATE_PATH` / `CANCEL_PATH` 这两个**值**，而仓库禁止
   feature plugin 之间的 runtime value import，拆开就得复制协议模块。先例 `packages/client/file-upload`。
   逐个文件要改什么见 README 的「搬进 `packages/` 时要做什么」。
2. **`flow/*` 事件清单** —— 定五个：`flow/start`（`runId` / `label` / `ownerSession` / `code`）、
   `flow/call-start`（`callId` / `member` / `line` / `args` / `argsTruncated`）、
   `flow/call-end`（`callId` / `ms` / `outcome` / `result` 或 `error` / `synthetic?`）、
   `flow/report`（`text`）、`flow/end`（`status` / `discarded` / `detail?`）。字段的事实来源是
   `host/flow-events.ts`，唯一消费者是 `host/flow-state.ts` + `client/panel.tsx`；成对承诺是 `(runId, callId)`，
   程序在调用结算前终止时由宿主补发一条 `synthetic` 的 `end`（先于 `flow/end`）。
3. **`.d.ts` 与提示词的生成方式** —— 手写固定文本 `sdkText(timeouts)`（`host/sdk.ts`），**不用 `jsonSchemaToTs`**：
   那套生成器描述的是注册表里的工具，而这里程序看到的 API 是函数与一个 `flow` 命名空间，没有 JSON Schema 可依。
   正文里的两个超时数字取自**已解析**的配置，所以部署改了 Config 之后模型看到的文档跟着变。
4. **`flow.tmpDir` 的命名与暴露形态** —— 就是 `flow.tmpDir`（只读字符串），落点是
   `<会话工作目录>/.execution-engine/<runId>`，引擎创建、run 结束时整体删除（`host/tmp-dir.ts`）。
   不在 `os.tmpdir()` 下：受管期的可写范围就是工作目录，`process` 起的子进程与 PTC 子进程各有各的私有临时目录，
   工作目录是唯一的可写交集——§3.4 的取值约定要求"外部脚本写、程序读"落在同一个位置。
5. **测试范围** —— 六条要求逐条找到证据，缺的两处本次补上；另列出 §13 没列但审计认为该有的面，与"只有 B/C 档覆盖"
   的清单。全部在 README 的「回归测试覆盖（§13 第 5 条的审计结论）」一节。
6. **面板形态** —— 定了：轨迹与 report 各自有界保留（`MAX_CALLS` 200 / `MAX_REPORTS` 50）、
   源码超过 `CODE_MAX_LINES` 400 行时只渲染当前行上下 `CODE_WINDOW_RADIUS` 150 行的一段、
   宿主补发的闭合显式标记（`trace.synthetic`「宿主补发」）、当前行是轨迹里**最后一条**还开着的调用所在行。
   `report` 与轨迹分区展示（是）。**未做**：虚拟滚动；用开窗代替了"源码滚动跟随当前行"。
7. **行号映射的可靠性** —— 定了：`new Error().stack` + `lineOffset: -1`。用户源码以 JSON 字面量嵌入、拼接时
   一行都不动（`host/capabilities.ts` 的 `stripUserProgram` 只删类型），所以栈里的行号就是用户源码行号，
   循环里同一行重复出现也照发不去重。**AST 变换（plan B）未启用**。

## 14. 参考

- `packages/workflow/workflow/README.md` — 编排能力缝与脚本契约
- `packages/workflow/workflow-ptc/README.md` — 执行引擎与 host/guest/binding 模板
- `packages/ptc-runtime/ptc-runtime/README.md` — 执行缝、超时语义、Python fd-3 协议
- `packages/jobs/jobs/README.md` — 后台 job 契约与 owner 隔离
- `packages/subagent/tool-subagent/src/list-models.ts` — `list_subagent_models` 的形态与错误措辞（阶段 8 对齐它）
- `packages/subagent/tool-subagent/src/model-selection-settings.ts` — `subagentModelSelection` 服务与 `current()`（阶段 8 的授权来源）
- `packages/subagent/subagent/src/types.ts` / `child-agent.ts` — `agentOptions` 与父路由的合并语义
- `packages/core/agent-loop/README.md` — agent 创建、turn/step、取消
- `packages/core/agent/src/runtime-types.ts` — `send` / `followup` / `steer` / `inject` 投递接口
- `Workspace/design.md` — Blackboard 设计文档（本文档格式参照）
