# ExecutionEngine — 设计文档

一个独立的执行引擎。主 agent 产出一段程序交给它，它按程序执行；程序里不确定的步骤派子 agent，确定的步骤跑外部程序。

本文档是 ExecutionEngine 插件的设计依据。所有产物先放在 `Workspace/` 下，确认可用后再集成进 DSH 本体。

状态：设计已冻结，尚未实现。

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

程序跑在**完整 Node 进程**里（见 §7.2），因此还能读写文件、发网络请求、import 模块。

**这一条直接决定了"返回值"问题的答案：要一个值，就在程序里用 TS 算；`process` 那个位置本来就不该指望返回值。**

### 3.2 三个原语

```ts
/** 派一个子 agent 执行一段工作，返回它的最终文本。非确定。 */
dispatchsubagent(prompt: string): Promise<string>

/** 执行一个外部程序。非零退出码与超时都正常返回，由程序自己判断。 */
process(argv: string[], opts?: ProcessOptions): Promise<ProcessResult>

/** 同 process，但非零退出码或超时抛出。用于表达"这一步必须成功"。 */
processOrThrow(argv: string[], opts?: ProcessOptions): Promise<ProcessOutput>

/** 向主 agent 单向汇报一段内容。 */
report(text: string): void
```

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

理由：约定有确定落点（写进 `.d.ts`，主 agent 不用猜）；不污染会话工作目录；清理归引擎；天然"每次 run 独立"，与 §7.3 一致。

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

### 6.5 fire-and-forget

对主 agent 而言程序是 fire-and-forget：**它不需要知道程序何时结束、为什么结束**（跑完 / 失败 / 被用户取消都一样）。

这不影响正确性，因为主 agent 本来就不阻塞在程序上——它只是继续干自己的事，report 来了就处理。但有一条推论必须处理，即 §4.4 的"未投递 report 作废"。

## 7. 语言与运行时

### 7.1 语言：可擦除 TypeScript

- 程序写 **erasable TypeScript**，运行时 `stripTypeScriptTypes` 剥离类型后当 JS 执行。
- **无编译步骤、无类型检查**。类型是装饰性的：给主 agent 表达力，不给编译期保证。
- 只能写纯擦除的 TS：`enum`、带运行时语义的 `namespace`、构造器参数属性等需要生成代码的特性不可用；写了会被拒绝，且报错信息会说明如何改。

给主 agent 的接口文档就是一份**生成的 `.d.ts`**（§11），它照着写。

### 7.2 完整 Node 进程

程序跑在**完整 Node 进程**里，**不削**——这是与 `workflow` 的关键区别。`workflow` 特意把它削成"纯协调者"（无 fs、无网络、无子进程），因为它的定位是把活交给子 agent；本插件的程序**要干确定性的活**，削了就没法干活。

安全上不构成扩大：程序是主 agent 写的，主 agent 本来就有 bash、能读写文件、能发网络请求，**同一信任级**。

**但封掉 `child_process` 一类的直接起进程能力**，强制所有外部执行走 `process`。理由不是安全，是**可靠性**：超时一定生效、进程树一定清干净、每一次外部执行都可观测——而单例之下，一个绕过超时的野进程可能永久锁死槽位。

### 7.3 每次 run 一个新进程

每次 run 起一个全新的 Node 进程，跑完即死，**run 之间没有状态**。

这与现有 `ptc-runtime` 的契约一致（"no state survives between runs"），也是为了保持"每次执行都能从日志重建"这条性质。

超时后杀的是**整个进程树**，不只是直接子进程——否则脚本 fork 出来的孤儿会一直跑，而单例之下你看不见它们。

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

/** 向主 agent 单向汇报一段内容。主 agent 会被唤醒阅读。 */
declare function report(text: string): void

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
- `flow/*` observe-only 事件：启动、程序源码、原语调用起止、`report`、结束（§8.1）
- 扩展 `.d.ts`

**验证**

- `report` 真的唤醒主 agent，且顺序与程序调用顺序一致
- 取消之后，残留的 report 不再被投递
- 主 agent 正在忙时 report 排队，不打断它当前的活动

### 阶段 5 — 执行位置上报（Host / Guest）

**做什么**

- **先确认 guest 里程序如何被求值**（`vm` / `new Function` / 临时文件），据此确定行号映射方案（§8.3）
- guest 外壳包装各原语，用 `new Error().stack` 取调用点行号并上报；拼接时保持用户源码的行结构不变
- `flow/*` 事件带上位置
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

### 阶段 7 — 收尾

**做什么**

- README
- 补齐回归测试（§13 第 5 条列的那些）
- 决定是否、以及如何搬进 `packages/`

**验证**：全量测试通过；文档与实现一致。

## 13. 待定（实现层，非设计决策）

1. **包怎么拆**：工具包 / 引擎包 / 客户端包，依赖方向。
2. **`flow/*` 事件清单**：UI 要从事件推导面板与按钮状态，先定字段。
3. **`.d.ts` 与提示词的生成方式**：手写固定文本，还是照 `jsonSchemaToTs` 那套生成。
4. **`flow.tmpDir` 的最终命名与暴露形态**。
5. **测试范围**：至少覆盖单例、取消、归属随主 agent 死、超时封顶、未投递 report 作废。
6. **面板形态**：源码如何滚动跟随当前行、轨迹保留多少条、`report` 与轨迹是否分区展示。
7. **行号映射的可靠性**：先确认 guest 里程序的求值方式（`vm` / `new Function` / 临时文件），再决定走 stack 取行号还是 AST 变换（§8.3）。

## 14. 参考

- `packages/workflow/workflow/README.md` — 编排能力缝与脚本契约
- `packages/workflow/workflow-ptc/README.md` — 执行引擎与 host/guest/binding 模板
- `packages/ptc-runtime/ptc-runtime/README.md` — 执行缝、超时语义、Python fd-3 协议
- `packages/jobs/jobs/README.md` — 后台 job 契约与 owner 隔离
- `packages/core/agent-loop/README.md` — agent 创建、turn/step、取消
- `packages/core/agent/src/runtime-types.ts` — `send` / `followup` / `steer` / `inject` 投递接口
- `Workspace/design.md` — Blackboard 设计文档（本文档格式参照）
