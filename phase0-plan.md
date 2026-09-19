# ExecutionEngine 阶段 0 实施方案（骨架）

范围：`Workspace/ExecutionEngine/` 下的骨架代码 + 一份挂在 DSH Web profile 上的 `--patch` overlay。**不移动进 `packages/`，不改仓库任何其他文件。**

依据：[design.md](./design.md) §12「阶段 0 — 骨架」。本文档对 design.md 没有修改建议，只把它落到文件、命令与断言上。

本文档里的每一条结论都来自实读源码，文件路径写在各条结论后。**凡是没读到、或在本会话沙箱里跑不动的，都标了「未验证」。**

---

## 0. 结论摘要（先看这个）

| # | 问题 | 结论 |
|---|---|---|
| A | 插件写成 default export 的 service class，还是命名导出 `name`/`inject`/`Config`/`apply` | **命名导出，且绝不能有 `export default`**。依据：`packages/AGENTS.md:5` + `docs/postmortem/0001-acp-default-export-drops-inject.md`（Loader 的 `unwrapExports` 优先取 `.default`，会把 `inject` 一起丢掉） |
| B | `--patch` overlay 怎么工作 | `dsh web --patch <file>` 把该文件当**一层 patch 列表**，与 bundle/profile/home 各层打平进**一次** `applyEntryPatches`；相对 `name` 被改写成**相对该 patch 文件所在目录**的 `file://` URL |
| C | 要不要依赖 `@deepseek-ai/dsh-*` | **不写进 `dependencies`／`devDependencies`**。类型走 `tsconfig.base.json` 的 `paths` + 项目 `references`；运行时靠 `pnpm dsh` 的 tsx 解析。**照 Blackboard 的做法**（`Workspace/Blackboard/package.json` 里一个 `@deepseek-ai/*` 都没有） |
| D | `dsh.client` 段能不能只声明不产物 | **不能**。声明了 `dsh.client` 而 `lib/client.js` 不存在 → `dsh web` **启动直接失败**（`modules` 是 required 行）。所以阶段 0 必须真产出一个（惰性的）`lib/client.js` |
| E | 阶段 0 的依赖 | 只有 `esbuild`（`devDependencies`，打客户端占位 bundle）。**没有运行期依赖** |
| F | 阶段 0 要 inject 什么 | **只有 `['tools']`**。`ptcRuntime` / `jobs` / `subagents` / `connection` 阶段 1 才用，现在写进去是错的 |
| G | 占位工具叫什么 | `execution_engine_ping`，零参数，返回 `{ plugin: 'dsh-execution-engine', phase: 0 }`，渲染成一句固定文本。**不叫 `run_program`**（理由见 §7） |
| H | 最轻的真实验证 | `tests/loader-driver.ts`：用 `@deepseek-ai/dsh-app-boot` 的 `boot()` 起一份**最小真实 Loader 组合**（`dsh-system-prompt` + `dsh-tools` + 本插件），断言占位工具已注册且可执行，然后 `dispose`。**不起服务、不占端口**。先例：`packages/shell/tool-pwsh/tests/fixtures/loader/driver.ts`、`packages/test-support/loader-smoke` |
| I | 本会话沙箱能跑到哪一步 | 只能跑 `typecheck` / `node --test` / `node --check`。**tsx 在本沙箱被 EPERM 挡住（已实测）**，所以 `pnpm dsh` 与 `loader-driver` 必须由你（或在非受限环境里）跑 |

---

## 1. 开工前的现状（已实测）

`Workspace/ExecutionEngine/` 已经是一个独立 git 仓库（`master` 分支，1 个提交 `2767e45 docs: ExecutionEngine 设计文档与实施计划`），工作区干净。

已存在：`design.md`、`.gitignore`（内容两行：`node_modules/`、`lib/`）、`.gitattributes`（`* text=auto eol=lf`）。**design.md §12「阶段 0」里列出的 `git init` 与 `.gitignore` 已经做完了**，阶段 0 不再重复。

`C:\workspace\Tool\deepseek-harness\pnpm-workspace.yaml` 的 `packages` 列表里**没有** `Workspace/*`，所以本目录不在仓库根的 pnpm workspace 内；本目录自带 `pnpm-workspace.yaml` 后它自己就是 workspace root，`pnpm install` 装的是本目录，不需要 `--ignore-workspace`（先例：`Workspace/Blackboard/pnpm-workspace.yaml`、`Workspace/Blackboard/README.md` §安装）。

根 `node_modules` 里可直接复用的工具（实读根 `package.json` 的 `devDependencies`）：`typescript@^6.0.3`、`tsx@^4.22.4`、`js-yaml@^4.2.0`、`@types/js-yaml@^4.0.9`、`execa@^10.0.0`。`pnpm run <script>` 会把祖先目录的 `node_modules/.bin` 加进 PATH（`Workspace/Blackboard/phase1-plan.md` §2.1 实测），所以本目录**不需要**再装 `typescript`。

本会话沙箱的实测边界（照抄 Blackboard README 的结论并复现）：

| 命令 | 结果 |
|---|---|
| `cd Workspace\Blackboard; pnpm run typecheck` | **exit 0**（host + client 两个 program 都过）。证明「extends `../../tsconfig.base.json` + 继承 `paths` + 项目 `references`」这套在本沙箱可用 |
| `cd Workspace\Blackboard; pnpm run test` | **exit 0，42 pass**。证明 `node --test --test-isolation=none "tests/*.spec.ts"` 直接跑 `.ts` 在 Node v24.19.0 上可用 |
| `cd Workspace\ExecutionEngine; node --import tsx/esm -e "import('@deepseek-ai/dsh-tools')…"` | **EPERM**。tsx 内部用 esbuild 的 JS API，被沙箱的「禁止带管道的子进程」挡住。**任何走 tsx 的验证在本会话都跑不了** |
| 根 `node_modules\@deepseek-ai\` | 只有 12 个已发布的包（`dsh-agent`、`dsh-llm-replay` 等），**没有** `dsh-tools` / `dsh-app-boot` / `dsh-system-prompt`。裸 `import '@deepseek-ai/dsh-tools'` 在纯 Node 下必然 `ERR_MODULE_NOT_FOUND` |

最后一条直接决定了测试的形态：**`pnpm run test` 里的 spec 不能有运行期的 DSH import**，只能碰 `node:*`、`js-yaml`、`typescript`（都是根依赖，能向上解析到）和本目录自己的文件。

---

## 2. 插件形态：为什么是命名导出

**结论：`host/index.ts` 用命名导出 `name` / `inject` / `Config` / `apply`，并且绝对不写 `export default`。**

依据一，仓库规则：`packages/AGENTS.md:5` —— "service packages default-export their service class; function plugins named-export `name` / `inject` / `Config` / `apply` and have no default export. Mixing the forms makes the Loader discard the function plugin's namespace"。

依据二，事故记录：`docs/postmortem/0001-acp-default-export-drops-inject.md:27-54` 记录了真实故障——`packages/acp/acp/src/index.ts` 多写了一行 `export default apply`，Loader 的 `unwrapExports`（`vendor/loader/src/index.ts`）执行 `exports = exports.default ?? exports`，于是拿到的是**裸函数**，`inject` / `name` / `Config` 全部丢失，ACP 服务器一连就崩。同一份 postmortem 的结尾写明：手工 `ctx.plugin({name, inject, apply})` 的测试**永远抓不到这个 bug**，只有真实 Loader 路径能。

依据三，真实先例（本次实读）：`packages/todo/tool-todo/src/index.ts:22-43,128` 是 `export const name` / `export const inject` / `export interface Config` + `export const Config: z<Config>` / `export function apply(ctx, config)`，无 default；`Workspace/Blackboard/host/index.ts:11-12,26` 同样形态。

**本阶段是函数插件，不是 service class**：阶段 0 不发布任何 `ctx.executionEngine` 服务（design.md 也没有这条），只注册一个工具，所以走命名导出这一支。

阶段 0 的 `Config` 采用**仅类型**的形式（和 Blackboard 一致）：

```ts
/** 插件配置。阶段 0 没有可部署项；§9 的 `process` 超时字段在阶段 1 落地。 */
export interface Config {}
```

理由：design.md §9 的两个字段（`process.defaultTimeoutMs`、`process.maxTimeoutMs`）是阶段 1 的产物，阶段 0 一个 tunable 都没有。此时写 `export const Config: z<Config> = z.object({})` 是空 schema 的装饰；**阶段 1 加入第一个字段时必须改成 tool-todo 的写法**（`export interface Config {...}` + `export const Config: z<Config> = z.object({...})` 同名合并，`packages/todo/tool-todo/src/index.ts:29-43`），因为 cordis 只在 `plugin.Config` 存在时才做运行时校验（`vendor/cordis/src/fiber.ts:51-53`）。

---

## 3. `--patch` overlay 到底怎么工作（实读源码）

**命令入口。** `dsh web` 是 `--profile web` 的硬编码别名（`apps/cli/src/args.ts:175-188`）；`--patch <path>` 是 repeatable 单值收集器（`apps/cli/src/args.ts:62-66,147,182`），`resolveBoot` 把它们原样放进 `{ mode: 'profile', patches }`（`apps/cli/src/args.ts:96-101`）。`apps/cli/package.json` 的 `dsh` 脚本是 `node --import tsx/esm apps/cli/src/bin.ts`（根 `package.json:189`），所以 **host 半边直接跑 `.ts` 源码**，不需要构建。

**解析与锚定。** `runProfile` → `composeProfile` 调 `loadOverlayPatches('dsh', resolve(file))`（`apps/cli/src/profile-boot.ts:244`）——注意 `resolve(file)` 是**相对进程 cwd** 解析的，所以命令必须在仓库根执行。`loadOverlayPatches` 读文件后交给 `parsePatchList`，后者在返回前调用 `anchorInsertedPluginNames`（`packages/boot/app-boot/src/index.ts:329-337,364-382`）。

`anchorInsertedPluginNames`（`packages/boot/app-boot/src/index.ts:339-350`）就是「相对行名」的全部机制，逐字是：

```ts
const base = dirname(resolve(file))
const visit = (entry: EntryOptions): void => {
  if (typeof entry.name === 'string' && (isAbsolute(entry.name) || entry.name.startsWith('./') || entry.name.startsWith('../'))) {
    entry.name = pathToFileURL(resolve(base, entry.name)).href
  }
  if (entry.group && Array.isArray(entry.config)) entry.config.forEach(visit)
}
for (const patch of patches) patch.insert?.forEach(visit)
```

三个必须记住的推论：

1. **只有 `insert` 里的行会被锚定**；`- id: xxx` 这种非 insert patch 没有 `name` 字段，不受影响。
2. **锚定基准是 patch 文件所在目录**，不是 cwd、不是仓库根。所以 overlay 里写 `'./host/index.ts'`，换 checkout 位置、换机器都不用改。
3. 裸包名（`@deepseek-ai/dsh-tools`）和 `cordis:*` 内建名**原样保留**，交给 Loader 的常规解析；只有 `./`、`../`、绝对路径会被改写成 `file://` URL。

**合并语义。** 所有层（bundle 层 → profile 的 `cordis.patch.yml` → `$DSH_HOME/cordis.patch.yml` → 各 `--patch` 层 → telemetry 开关）被**打平成一个列表**，交给 `vendor/include` 的 `applyEntryPatches` **一次**执行（`apps/cli/src/profile-boot.ts:212-219,352-353`；`vendor/include/src/index.ts:57-127`）。该函数的规则：

| patch 形态 | 行为 |
|---|---|
| 有 `insert`、无 `id` | 行**追加到顶层 entry 列表** |
| 有 `insert`、有 `id` | 行追加进那个 group 的 `config` 数组；目标不存在或不是 group 就 warn 并跳过 |
| 无 `insert`、有 `id` | 把 overrides 里的键**整值赋给**目标行（`config` 是替换不是深合并）；目标不存在就 warn 并跳过 |
| `name` 与目标行的 `name` 不一致 | warn 并跳过（防止按 id 打错行） |

「跳过」只是 warn，不是 boot 失败（`vendor/include/src/index.ts:76-124`）；但这正是验证时要盯 stderr 的原因。

**Loader 对插件行的约束。** `EntryOptions` 是 `{ id, name, config?, group?, disabled?, inject? }`（`vendor/loader/src/config/entry.ts:9-22`）。`id` 在 YAML 里**可以省略**，`EntryTree.ensureId` 会生成（`vendor/loader/src/config/tree.ts:51`）；`name` 是唯一的模块说明符；`config` 与 `disabled` 是**仅有的两个会被 `!!js` 插值**的字段，其余元数据必须保持字面量（`scripts/verify-cordis-config.ts:503-525`，根 `AGENTS.md` 的 Secrets/.env 条）。`inject` 在行上写的是「本行要求哪些服务」，我们阶段 0 不需要在行上写（插件自己 `export const inject` 就够了）。

**offline 复现同一件事。** `dsh web --patch <file> --dump-config` 会走 `loadOverlayPatches` + 同一套 `applyEntryPatches` 渲染出组合后的 YAML，注释标明每行来自哪个文件（`apps/cli/src/dump-config.ts:31-58`、`packages/boot/app-boot/src/index.ts:392-448`）。它**不起服务**，是本方案能拿到的最强的「真 CLI + 真 patch 算法」证据。副作用是它会重写 `$DSH_HOME/profiles/web/cordis.yml`（内容恒为一个空 entry 列表，见 `apps/cli/src/profile-boot.ts:88-95,191-196`），幂等。

**一条必须先说清的坑（已实读，会直接让 `dsh web` 起不来）。** `@deepseek-ai/dsh-client-modules` 在激活时扫描**每个 active 行的行名**，用 `locatePkgJson` 从行名解析出的模块 URL **向上找最近的 `package.json`**，再读它的 `dsh.client` 与 `exports["./client"]`（`packages/client/modules/src/index.ts:816-851,853-877,768-803`）。我们的行名被锚成 `file:///…/Workspace/ExecutionEngine/host/index.ts`，最近 manifest 就是本目录的 `package.json`——**一旦它声明了 `dsh.client`，扫描就会去读 `lib/client.js`**；读不到时抛 `MissingClientBundleError`（`:93-108,905-917`），在构造函数里被聚合成 `ClientPackageCompositionError` 抛出（`:592-596`）。而 `modules` 这个行 id 在 `requiredStartupEntryIds` 里（`packages/boot/app-boot/src/index.ts:711-719`，行 id 定义在 `packages/bundle/web-app/cordis.patch.yml:176-177`），所以是**required startup failure，整个 `dsh web` 直接失败**，不是警告。

**这条坑决定了 §4 必须包含真客户端产物**，也是 §12 问题 Q1 要你裁决的东西。

---

## 4. 文件清单（逐个文件 + 精确内容）

全部位于 `C:\workspace\Tool\deepseek-harness\Workspace\ExecutionEngine\`。

```
package.json                     新建
pnpm-workspace.yaml              新建
tsconfig.json                    新建（host face）
tsconfig.client.json             新建（client face）
execution-engine.cordis.yml      新建（--patch overlay）
host/index.ts                    新建（插件入口）
host/tool.ts                     新建（占位工具定义）
client/index.ts                  新建（惰性浏览器半边；为 tsconfig.client 提供输入，同时也是 client bundle 的源）
build/build-client.mjs           新建（esbuild → lib/client.js）
tests/overlay.spec.ts            新建（纯 Node 单测）
tests/host-shape.spec.ts         新建（纯 Node 单测，用 typescript 编译器 API）
tests/loader-driver.ts           新建（真实 Loader 组合驱动，非 spec 命名，不进 `pnpm run test`）
tests/fixtures/cordis.yml        新建（最小组合配置）
lib/client.js                    构建产物（.gitignore 已覆盖）
node_modules/                    安装产物（.gitignore 已覆盖）
```

### 4.1 `package.json`

```json
{
  "name": "dsh-execution-engine",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "exports": {
    "./client": "./lib/client.js",
    "./package.json": "./package.json"
  },
  "dsh": {
    "client": {
      "platform": "web"
    }
  },
  "files": [
    "execution-engine.cordis.yml",
    "build",
    "client",
    "host",
    "lib",
    "tests"
  ],
  "scripts": {
    "typecheck": "tsc -p tsconfig.json && tsc -p tsconfig.client.json",
    "build": "node build/build-client.mjs",
    "test": "node --test --test-isolation=none \"tests/*.spec.ts\""
  },
  "devDependencies": {
    "esbuild": "0.25.12"
  }
}
```

逐项理由：

- 包名用**非 scoped** 的 `dsh-execution-engine`，照 Blackboard 的 `dsh-blackboard`。它不在 `packages/` 下、不发布，用 `@deepseek-ai/` 前缀会假装自己是仓库的正式包。**它也必须是客户端模块表里的 id**（`build/build-client.mjs` 的 `ID` 常量），两者不一致会在浏览器里报「未注册的模块」。阶段 7 搬进 `packages/` 时再改成 `@deepseek-ai/dsh-execution-engine`。
- `exports` 里**没有 `"."`**：host 半边由 Loader 按**路径行名** import，不需要包入口（Blackboard 同样如此）。
- `dsh.client.platform` 是必填（`packages/client/modules/src/index.ts:786-793` 要求 `platform === 'web'` 且必须有 `./client` export，否则抛）。
- `files` 只列本项目里真实存在的目录；**不列 `README.md`**（design.md §12 把 README 放在阶段 7）。
- `version: "0.0.0"` + `private: true`，与 Blackboard 一致。
- `esbuild` 版本钉 `0.25.12`，与 Blackboard 完全一致（同一台机器上已被验证可用）。

### 4.2 `pnpm-workspace.yaml`

```yaml
# 本目录不在仓库根的 pnpm workspace 里，自己就是一个 workspace root。
# esbuild 的原生二进制来自 @esbuild/win32-x64 这个 optional dependency，它的 postinstall 只是自检；
# 而这个沙箱禁止带管道的子进程，跑它会 EPERM。所以这里显式关掉构建脚本。
allowBuilds:
  esbuild: false
```

逐字照抄 `Workspace/Blackboard/pnpm-workspace.yaml`（5 行，含注释），只改第一句的指代不需要——它已经写的就是「本目录」。

### 4.3 `tsconfig.json`（host face）

```jsonc
{
  // host 半边（host/tests）。浏览器半边是单独的 program，见 tsconfig.client.json：
  // 两半会用不同的服务合并同一个 cordis Context 键，一个 program 里放不下两边。
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "composite": false,
    "incremental": false,
    // host 由 tsx 直接跑源码，客户端 bundle 由 build/build-client.mjs 产出，所以这里只做类型检查。
    "noEmit": true,
    "lib": ["es2024", "dom", "dom.iterable"]
  },
  "include": [
    "host/**/*.ts",
    "tests/**/*.ts"
  ],
  // vendor 的源码按上游风格写，过不了本仓库的严格开关（noUncheckedIndexedAccess 等）；
  // 仓库自己的包靠 references 引用产物绕开它，本目录照做。
  "references": [
    { "path": "../../vendor/cordis" },
    { "path": "../../vendor/cosmokit" },
    { "path": "../../vendor/schemastery" }
  ]
}
```

与 Blackboard 的差异只有 `include`：去掉 `core/`、`shared/`、`dev/`（阶段 0 没有），**加上 `tests/`**（`loader-driver.ts` 与两个 spec 都要被类型检查）。

`paths` 不在这里写——它由 `../../tsconfig.base.json` 继承（`tsconfig.base.json:30-492`，`@deepseek-ai/dsh-tools` 在 `:470`、`@deepseek-ai/dsh-app-boot` 在 `:292`）。**这是「不依赖 DSH 包也能拿到类型」的全部机制**，见 §5。

### 4.4 `tsconfig.client.json`（client face）

```jsonc
{
  // 浏览器半边单独一个 program：host 与 client 两半会用不同的服务合并同一个 cordis Context 键，
  // 一个 program 里放不下两边——这也是仓库把 tsconfig.host.json 与 tsconfig.client.json 分开的原因。
  //
  // 引入 vendor/cordis 让 TS 走它的产物；client/index.ts 目前只 import type { Context }。
  "extends": "../../tsconfig.base.client.json",
  "compilerOptions": {
    "composite": false,
    "incremental": false,
    "noEmit": true,
    "lib": ["es2024", "dom", "dom.iterable"]
  },
  "include": [
    "client/**/*.ts",
    "client/**/*.tsx"
  ],
  "references": [
    { "path": "../../vendor/cordis" }
  ]
}
```

**这里有一个必须避开的陷阱：`include` 匹配不到任何文件时 `tsc` 报 TS18003（No inputs were found），`typecheck` 会红。** 阶段 0 没有面板，所以必须有一个真实的 `client/index.ts` 当输入——这正是 §4.8 存在的第一个理由（第二个理由是 §3 的客户端 bundle 坑）。

### 4.5 `execution-engine.cordis.yml`

```yaml
# ExecutionEngine 阶段 0 的 overlay：只插一条 host 行。
#
# 一条行就够：@deepseek-ai/dsh-client-modules 按**行名**解析出最近的 package.json，
# 读它的 dsh.client 与 exports["./client"]，再把 lib/client.js 作为动态客户端 bundle
# serve 出去。所以同一个包不需要第二条行。
#
# 行名写相对路径：app-boot 的 anchorInsertedPluginNames 会把它锚成本文件所在目录的
# file:// URL，换机器、换 checkout 位置都不用改。
#
# 用法（源码启动的 dsh，host 半边直接跑 .ts）：
#   pnpm dsh web --patch Workspace/ExecutionEngine/execution-engine.cordis.yml
- insert:
    - id: execution-engine-host
      name: './host/index.ts'
```

行 id `execution-engine-host` 与 Blackboard 的 `blackboard-host` 同构。**注意这个文件会被仓库的 `verify-cordis-config` 扫到**（`scripts/cordis-config-files.ts:13-17` 从仓库根 glob `**/*cordis*.yml`，只排除 `.claude`/`node_modules`/`vendor`），但不会报错：该门对 patch 行只做「`!!js` 不得出现在元数据字段」的检查（`scripts/verify-cordis-config.ts:190-225,488-525`），而依赖解析检查的覆盖面是 `apps/cli/config/examples/**`、`apps/cli/tests/**`、`packages/*/*/tests/**` 与 bundle 的 patch 文件（`:227-285`），本路径不在其中。相对行名在 `validateSourcePlaneResolution` 里也会被跳过（`packageNameFromSpecifier('./host/index.ts')` 返回 `undefined`，`:426-432`）。

### 4.6 `host/index.ts`

```ts
import type { Context } from '@deepseek-ai/cordis'
import { createSkeletonTool } from './tool.ts'

export const name = 'execution-engine'
export const inject = ['tools']

/** 插件配置。阶段 0 没有可部署项；design.md §9 的 `process` 超时字段在阶段 1 落地。 */
export interface Config {}

/**
 * 注册阶段 0 的占位工具。工具本身是注册即效应（先例 packages/todo/tool-todo/src/index.ts:146），
 * 这里不重复包一层 ctx.effect。
 * @param ctx - 宿主上下文。
 * @returns 无。
 */
export function apply(ctx: Context): void {
  ctx.tools.register(createSkeletonTool())
}
```

- **没有 `export default`**（§2）。
- `name` 是 Loader 的插件名，取 `'execution-engine'`（Blackboard 取 `'blackboard'`，不是包名）。
- **`Config` 是 type-only**，所以 cordis 不做运行时校验，`apply` 也就不需要 `config` 形参。阶段 1 加字段时改成同名 `interface` + `const` 对（见 §2）。
- `inject` 只有 `['tools']`（§6）。

### 4.7 `host/tool.ts`

```ts
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

/** 占位工具的固定返回，测试与驱动按字面比对。 */
const PLUGIN_ID = 'dsh-execution-engine'

/**
 * 阶段 0 的占位工具：证明插件挂上了、工具注册进 ctx.tools 了、模型能看到它。
 * 它不做任何工作，阶段 3 的 run_program 落地的同一次改动里删掉它。
 * @returns 可注册进 `ctx.tools` 的定义。
 */
export function createSkeletonTool(): ToolDefinition {
  return defineTool({
    name: 'execution_engine_ping',
    description:
      'Diagnostic placeholder for the ExecutionEngine plugin skeleton. '
      + 'It performs no work and exists only to confirm the plugin is mounted; do not call it.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          plugin: { type: 'string', required: true },
          phase: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `ExecutionEngine skeleton is mounted: ${value.plugin} phase ${String(value.phase)}.`,
      }],
    },
    execute() {
      return Promise.resolve({ plugin: PLUGIN_ID, phase: 0 })
    },
  })
}
```

- schema DSL 是 `@deepseek-ai/dsh-tools` **自带的**，不是从 TS 类型推导；零参数就是 `parameters: {}`（`parameters` 是必填字段，`packages/core/tools/src/schema.ts:483-499`）。
- `output.schema` + `output.render` 都是必填（同上）。`render` 拿到的 `value` 已经过 schema 校验。
- 描述显式写「do not call it」：packages/AGENTS.md 要求模型可见的文本从模型视角写，且不能让模型误以为这是产品 API。
- 固定的渲染文本同时是驱动与（将来的）快照的锚点。

### 4.8 `client/index.ts`

```ts
import type { Context } from '@deepseek-ai/cordis'

/**
 * 阶段 0 的浏览器半边：不做任何注册。
 *
 * 两个非它不可的理由：
 * 1. tsconfig.client.json 的 include 匹配不到文件时 tsc 报 TS18003；
 * 2. package.json 一旦声明 dsh.client，@deepseek-ai/dsh-client-modules 就会去读
 *    lib/client.js，读不到会让整个 dsh web 启动失败（modules 是 required 行）。
 * 阶段 6 在这里注册 conversation.view 面板。
 * @param _ctx - 客户端根上下文；阶段 0 不使用。
 * @returns 无。
 */
export function apply(_ctx: Context): void {}
```

`_ctx` 的下划线前缀是给 `noUnusedParameters`（`tsconfig.base.json:25`）留的豁免位。

### 4.9 `build/build-client.mjs`

逐字照抄 `Workspace/Blackboard/build/build-client.mjs`，只改一处：`const ID = 'dsh-execution-engine'`（必须等于 `package.json.name`），并把顶部注释改成 ExecutionEngine 的措辞；`BASELINE` 数组原样保留（阶段 0 的占位 bundle 一个基线模块都不 import，多写几个 external 无害，且阶段 6 一上来就能用）。

该脚本的形态是：`spawnSync(process.execPath, [esbuild CLI, 'client/index.ts', '--bundle', '--format=cjs', '--platform=browser', '--target=es2022', '--jsx=automatic', --outfile=lib/client.js, ...externals, --banner, --footer], { stdio: 'inherit' })`。**必须用 CLI + 继承 stdio**：沙箱禁止带管道的子进程，而 esbuild 的 JS API 正是用管道拉起 service（`Workspace/Blackboard/build/build-client.mjs:51-53` 的原注释）。Banner/Footer 是客户端模块表协议：

```
window.__ModuleLoader__.load({ id: "dsh-execution-engine", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
…
return module.exports; } });
```

**未在本会话重跑**：跑它会在 `Workspace/Blackboard/` 下写 `lib/client.js`，越出我的改动范围。它的可行性由 Blackboard 已产出的 `lib/` 与 README 作证。

### 4.10 `tests/` 下四个文件

见 §9。

---

## 5. 依赖：要不要依赖 DSH 类型

**结论：`package.json` 里一个 `@deepseek-ai/*` 都不写，运行期依赖为零。**

Blackboard 的做法（实读 `Workspace/Blackboard/package.json`）：`dependencies` 只有 `perfect-freehand`，`devDependencies` 只有 `@types/react` + `esbuild`；`host/index.ts` 里照样 `import { defineTool } from '@deepseek-ai/dsh-tools'`。它能跑起来靠的是两件事：

1. **类型**走 `tsconfig.base.json` 的 `paths`。`Workspace/Blackboard/tsconfig.json` 只是 `extends: "../../tsconfig.base.json"`，而 `paths` 里的目标（`tsconfig.base.json:471` 的 `"@deepseek-ai/dsh-tools": ["./packages/core/tools/src"]`）是相对**声明它的那个 tsconfig** 解析的，所以 `Workspace/` 下的子项目继承后依然指回 `packages/`。`references` 里的 `vendor/*` 只解决 vendor 源码过不了本仓库严格开关的问题（Blackboard `tsconfig.json:19-25` 的原注释）。**已实测**：`cd Workspace\Blackboard; pnpm run typecheck` exit 0。
2. **运行时**解析靠 tsx。`pnpm dsh` = `node --import tsx/esm apps/cli/src/bin.ts`，tsx 的 ESM hook 按 cwd 找到仓库根 `tsconfig.json` 并把 `paths` 映射应用到**任何** import，所以 `Workspace/ExecutionEngine/host/index.ts` 里 `import '@deepseek-ai/dsh-tools'` 能解析到 `packages/core/tools/src/index.ts`（源码，不是 `lib/`）。先例与论证见 `Workspace/Blackboard/phase2-plan.md` §A.6。

**纯 Node 下这条路不成立**（已实测：根 `node_modules\@deepseek-ai\` 里没有 `dsh-tools`），这也是 §8/§9 把验证分成「纯 Node 能跑」和「必须 tsx」两档的根据。

**阶段 0 唯一的新依赖是 `esbuild`（devDependency）**，只为打客户端占位 bundle。不需要 `typescript`、`tsx`、`js-yaml`、`@types/js-yaml`——它们都在根 `node_modules` 里，`pnpm run` 会从祖先 `node_modules/.bin` 解析到 `tsc`，而 `import 'js-yaml'` / `import ts from 'typescript'` 会沿目录向上命中根 `node_modules`。

**明确不引**：`vitest`（用 `node:test`，Blackboard 先例且本沙箱实测可跑）、`@types/node`（根已有）、任何 DSH 包。

---

## 6. 依赖注入：只 inject 阶段 0 真正用得到的服务

`export const inject = ['tools']`，**就这一个**。

- `tools` 是唯一被触碰的服务（`ctx.tools.register`）。
- **不 inject `ptcRuntime`**：design.md §7.4 说执行走 `ctx.ptcRuntime`，但那是阶段 1 的事；现在 inject 它会让本插件在没挂 PTC 的组合里永远 PENDING，而阶段 0 的组合恰恰不需要 PTC。
- **不 inject `jobs`**（阶段 3）、**不 inject `subagents`**（阶段 2）、**不 inject `connection`**（只有客户端 fetch route 才要；阶段 0 没有 route）。
- **不 inject `systemPrompt`**：阶段 0 不往系统提示里塞 `.d.ts`（design.md §12 把 `.d.ts` 放在阶段 1）。旁证：`packages/plan/plan-mode/src/index.ts:172` 之所以 inject `systemPrompt`，是因为它真的注册了一个 section。
- 将来读取可选服务时用 `ctx.get(name)` 而不是 `ctx.<name>`（`packages/AGENTS.md:6` 与 postmortem 0001 的 root cause #2）；阶段 0 还没有这种情况。

---

## 7. 占位工具的确切契约

| 项 | 值 |
|---|---|
| 名字 | `execution_engine_ping` |
| description | `Diagnostic placeholder for the ExecutionEngine plugin skeleton. It performs no work and exists only to confirm the plugin is mounted; do not call it.` |
| parameters | `{}`（零属性 object 根） |
| output schema | `{ type: 'object', additionalProperties: false, properties: { plugin: {type:'string',required:true}, phase: {type:'integer',required:true} } }` |
| 返回 | `{ plugin: 'dsh-execution-engine', phase: 0 }` |
| 渲染文本 | `ExecutionEngine skeleton is mounted: dsh-execution-engine phase 0.` |

**为什么不叫 `run_program`：** design.md §12 的验证是「占位工具出现在模型可见的工具列表里」，而阶段 0 的组合会**真的挂在 Web GUI 上**。如果占位工具用真实的工具名，模型会看到一个名字像产品 API、实际什么都不做的工具，并按 §11 的 `.d.ts` 契约去调用它——那是在教模型一个假契约，比「工具不存在」更坏。用一个一眼是诊断件的名字（`ping`）能保证：模型看到它的唯一后果是忽略它，阶段 3 删掉它时也不会有任何已写的程序依赖它。

**为什么不直接不注册工具：** design.md §12 明确要求「注册一个占位工具」，且这是唯一能证明「插件挂载成功」的模型可见证据（否则插件挂没挂只能靠日志判断）。

**放置平面与风险：** 注册在 host 平面（`ctx.tools.register`），会被**所有 preset 继承**，包括 `minimal`——`ctx.tools` 的 `view()` 把 `this.layers.global.tools` 作为最远祖先合并（`packages/core/tools/src/index.ts:1158-1171`）。这正是 Blackboard phase2-plan 的 R5，阶段 0 接受并记录，阶段 3 改成 preset 内注册时一并解决。

---

## 8. 验证程序（逐条命令 + 什么输出算成功）

分成三档。**A 档在本会话沙箱里可跑；B/C 档需要 tsx，本沙箱实测 EPERM，必须由你跑。**

### A 档：纯 Node / tsc，不需要 tsx，不需要服务（本会话可跑）

**A1 类型检查**

```powershell
cd C:\workspace\Tool\deepseek-harness\Workspace\ExecutionEngine
pnpm run typecheck
```

成功证据：进程 exit 0，**输出里没有 error**。它会跑两个 program（`tsc -p tsconfig.json` 再 `tsc -p tsconfig.client.json`）。失败模式对照：`TS18003 No inputs were found` = 某个 face 的 `include` 空了（阶段 0 靠 `client/index.ts` 避开）；`Cannot find type definition file for 'client-build-environment'` = `tsconfig.base.client.json` 的 `typeRoots` 没被正确继承（Blackboard 同款配置已实测 exit 0，所以出现即为本目录配置写错）。

**A2 单元测试**

```powershell
pnpm run test
```

成功证据：`node --test` 汇总行 `pass N / fail 0`，exit 0。Blackboard 同款命令在本机实测 `tests 42 / pass 42 / fail 0`。

**A3 客户端 bundle**

```powershell
pnpm run build
node --check lib/client.js
Test-Path lib/client.js
```

成功证据：`node --check` exit 0（语法合法），`Test-Path` 输出 `True`。另外确认模块表 id：

```powershell
Select-String -Path lib/client.js -Pattern 'dsh-execution-engine' -SimpleMatch | Select-Object -First 1
```

必须匹配到 banner 里的 `id: "dsh-execution-engine"`；它和 `package.json.name` 不一致时，浏览器会报「未注册的模块」。

### B 档：真实 CLI / 真实 Loader 组合，不需要服务，需要 tsx（**本会话跑不了**）

**B1 用真 CLI 走完整的 patch 组合（不起服务）**

```powershell
cd C:\workspace\Tool\deepseek-harness
pnpm dsh web --patch Workspace/ExecutionEngine/execution-engine.cordis.yml --dump-config
```

成功证据，三条都要满足：

1. stdout 里出现新行，且 `name` 已被锚成绝对 `file://` URL：
   ```
   - id: execution-engine-host
     name: file:///C:/workspace/Tool/deepseek-harness/Workspace/ExecutionEngine/host/index.ts
   ```
2. **stderr 里没有任何 `patch: entry ... not found` / `patch insert: entry ... not found`**（出现了说明 overlay 打错了目标行；这种情况只会 warn 不会失败，必须主动看）。
3. exit 0。

注意：`--dump-config` 会重写 `$DSH_HOME/profiles/web/cordis.yml`（恒为空 entry 列表，幂等，见 §3），这是唯一副作用，不启动任何服务、不占端口。

**B2 真实 Loader 组合，断言工具已注册（本方案的主验证）**

```powershell
cd C:\workspace\Tool\deepseek-harness
node --import tsx/esm Workspace/ExecutionEngine/tests/loader-driver.ts Workspace/ExecutionEngine/tests/fixtures/cordis.yml
```

成功证据：exit 0，stdout 最后一行是 `LOADER_SMOKE_OK`。失败时进程非零退出并打印断言消息（`execution_engine_ping is not registered` / 导出面不符 / 渲染文本不符）。

**为什么这条算「真实验证」而不是单测：** 它走 `@deepseek-ai/dsh-app-boot` 的 `boot()`（`packages/boot/app-boot/src/index.ts:867-897`），即真实 Cordis Loader + 真实 Include + 真实模块导入路径，然后从 `ctx.tools` 读**模型可见的 schema**并真的执行一次工具。先例是 `packages/shell/tool-pwsh/tests/fixtures/loader/driver.ts:16-28`（同一套 `boot()` + `ctx.tools.schemas()` + `ctx.tools.execute`），以及 `packages/test-support/loader-smoke`。它**不监听端口、不写磁盘、跑完即退**。

**必须在仓库根执行**：`boot()` 的 fixture 里 `@deepseek-ai/dsh-tools` 是裸包名，靠 tsx 按 cwd 找到的根 `tsconfig.json` 的 `paths` 解析（§5）；cwd 换成 `Workspace/ExecutionEngine` 时 tsx 会去找本目录的 `tsconfig.json`，继承来的 `paths` 能否被 tsx 正确解析**未验证**，所以本方案不依赖那条路。

### C 档：完整 Web 挂载（可选，起服务，**本会话跑不了**）

只有想亲眼看「工具出现在模型可见列表里」时才做。

```powershell
cd C:\workspace\Tool\deepseek-harness
pnpm dsh web --patch Workspace/ExecutionEngine/execution-engine.cordis.yml --host 127.0.0.1 --port 3099 --no-open
```

**端口用 3099**，避开本会话正在跑的 GUI（3080）。成功证据：stdout 打印监听地址且**没有** `required startup failure`；浏览器打开 `http://127.0.0.1:3099/` 能出 shell；向模型提问后它列出的工具里有 `execution_engine_ping`。

**怎么关**：在拥有这个前台进程的终端按一次 `Ctrl+C`。launcher 在 SIGINT 上先 `fiber.dispose()` 再退出（`apps/cli/src/profile-boot.ts:325-326`，退出码 130）；如果它是在后台起的，用 `Stop-Process -Id <pid>`，先 `Get-NetTCPConnection -LocalPort 3099` 找 pid。**不要**用第二个 server 顶替现在这个 GUI。

---

## 9. 测试

`pnpm run test` 的 glob 是 `tests/*.spec.ts`，所以两个 spec 会被跑，`tests/loader-driver.ts` 与 `tests/fixtures/cordis.yml` 不会（后者要在 tsx 下才跑得动，见 §8 B2）。

### 9.1 `tests/overlay.spec.ts`（纯 Node，`js-yaml` + `typescript`）

断言清单：

1. `execution-engine.cordis.yml` 用 `js-yaml` 解析后是**非空数组**，每项是 mapping（对应 `scripts/verify-cordis-config.ts:64-71` 对同一个文件的要求：根必须是 entry 数组）。
2. 数组长度为 1，且该 patch **只有 `insert`、没有 `id`**（有 `id` 就变成往 group 里插，语义不同，见 §3 的合并表）。
3. `insert` 至少一行；行有 `id: 'execution-engine-host'`，`name: './host/index.ts'`。
4. `name` 以 `./` 或 `../` 开头——**这是「换机器不用改」这条性质的机器可检形式**，因为只有这种名字会被 `anchorInsertedPluginNames` 锚定（`packages/boot/app-boot/src/index.ts:343`）。
5. `resolve(dirname(overlayPath), name)` 指向一个真实存在的文件。这条模仿 `anchorInsertedPluginNames` 的解析，保证锚定之后 Loader 一定 import 得到。
6. `package.json`：`name === 'dsh-execution-engine'`（**非 scoped**）、`private === true`、`type === 'module'`、`scripts.typecheck`/`scripts.build`/`scripts.test` 都是非空字符串、`dsh.client.platform === 'web'`、`exports['./client'] === './lib/client.js'`。
7. `build/build-client.mjs` 的源码文本里含 `'dsh-execution-engine'`——模块表 id 必须等于包名，这是跨文件的真不变量，写错只会到浏览器里才炸。
8. 用 `ts.readConfigFile` + `ts.parseJsonConfigFileContent` 解析 `tsconfig.json` 与 `tsconfig.client.json`（**不能 `JSON.parse`：两个文件都带注释**），断言两者的 `errors` 都为空，且 `fileNames` 都**非空**——后者正是 TS18003 的机器可检形式，也是「`client/index.ts` 必须存在」这条约束的守卫。

### 9.2 `tests/host-shape.spec.ts`（纯 Node，`typescript` 编译器 API）

用 `ts.createProgram(['host/index.ts'], <tsconfig.json 的 compilerOptions>)` 建 program，从 type checker 读模块的导出面，断言：

1. `checker.getExportsOfModule(...)` 的名字排序后**恰好**是 `['Config', 'apply', 'inject', 'name']`。
2. **不存在 `default` 导出**。这是 postmortem 0001（`docs/postmortem/0001-acp-default-export-drops-inject.md`）那个故障的静态守卫：一旦有人加了 `export default`，Loader 就会丢掉整个命名空间。
3. `name` 的推断类型是字面量 `"execution-engine"`（`const` 声明）——顺带证明它是全小写连字符的 Loader 名，不是包名。
4. `inject` 的初始化表达式是数组字面量，元素文本恰为 `['tools']`（从 AST 的 `ArrayLiteralExpression` 读，不看类型）。这条守的是「不要 inject 现在还不用的服务」。
5. program 的 `getPreEmitDiagnostics()` 里属于本目录的文件**没有 error**。

**为什么这两条要静态测、而不是等 B2：** B2 需要 tsx，本沙箱跑不了；而「导出面」与「inject 集合」正是那些**只在真实 Loader 路径上才暴露**的性质。静态断言不能替代 B2（postmortem 的教训是「手工构造的插件测不出加载路径」），但它能在没有 tsx 的环境里把最贵的那类错误挡在前面，两者互补。

**明确不写的测试：** 不给 `host/tool.ts` 的 schema 写单测——它的正确性由 B2 的 `ctx.tools.schemas()` + `ctx.tools.execute()` 端到端覆盖，在纯 Node 里复制一份 schema 断言只是把实现抄第二遍。

### 9.3 `tests/loader-driver.ts`（真实组合驱动，不在 `pnpm run test` 里）

```ts
#!/usr/bin/env node
/**
 * 阶段 0 的真实组合验证：用 app-boot 的 boot() 起一份最小 Loader 组合，断言占位工具
 * 已注册、模型可见 schema 存在、执行一次返回约定值；并断言插件模块的导出面。
 * 用法（cwd = 仓库根，必须带 tsx，否则裸包名解析不到源码）：
 *   node --import tsx/esm Workspace/ExecutionEngine/tests/loader-driver.ts \
 *     Workspace/ExecutionEngine/tests/fixtures/cordis.yml
 */
import assert from 'node:assert/strict'
import { boot, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import * as plugin from '../host/index.ts'

const configPath = process.argv[2]
if (configPath === undefined) throw new Error('loader-driver requires a config path')

assert.equal(plugin.name, 'execution-engine')
assert.deepEqual(plugin.inject, ['tools'])
assert.equal(typeof plugin.apply, 'function')
assert.ok(!('default' in plugin), 'the plugin module must not export default (postmortem 0001)')

const ctx = await boot('execution-engine-loader-smoke', resolveConfigPath(configPath, undefined))
try {
  assert.ok(
    ctx.tools.schemas().some(tool => tool.name === 'execution_engine_ping'),
    'execution_engine_ping is not registered',
  )
  const result = await ctx.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId('execution-engine-skeleton'),
    name: 'execution_engine_ping',
    arguments: {},
  })
  assert.equal(result.isError, false)
  const text = result.content.filter(block => block.type === 'text').map(block => block.text).join('')
  assert.equal(text, 'ExecutionEngine skeleton is mounted: dsh-execution-engine phase 0.')
} finally {
  await ctx.fiber.dispose()
}
process.stdout.write('LOADER_SMOKE_OK\n')
```

`assert.ok(!('default' in plugin))` 需要 `import * as plugin`（module namespace），所以导入形式必须写 `* as`，不能写具名导入。

### 9.4 `tests/fixtures/cordis.yml`

```yaml
# 阶段 0 的最小真实组合：只有系统提示与工具注册表，加本插件的 host 半边。
# 相对行名以本文件所在目录为基准（Include 把 baseUrl 设成配置目录，
# vendor/include/src/index.ts:188），所以 ../../host/index.ts 就是插件的入口。
- id: system-prompt
  name: '@deepseek-ai/dsh-system-prompt'

- id: tools
  name: '@deepseek-ai/dsh-tools'

- id: execution-engine-host
  name: '../../host/index.ts'
```

三行的依据：`@deepseek-ai/dsh-tools` 的 `static inject = ['systemPrompt']`（`packages/core/tools/src/index.ts:790`），所以必须同时挂 `@deepseek-ai/dsh-system-prompt`；而 `SystemPrompt` 自己没有 `inject`（`packages/core/system-prompt/src/index.ts:406-407` 只有 `static Config`），不再往下拖依赖。这个最小组合与 `packages/context/session-reference/tests/fixtures/cordis.yml:1-3` 的前三行**逐字相同**。

这个文件也会被 `verify-cordis-config` 扫到（名字含 `cordis`），但它不在任何被做依赖检查的路径集合里，只会走元数据检查并通过（§4.5）。

---

## 10. 实施顺序（每步怎么验证）

| # | 做什么 | 怎么验证 |
|---|---|---|
| 1 | `package.json`、`pnpm-workspace.yaml` | `pnpm install` 在 `Workspace/ExecutionEngine` 下装出本地 `node_modules` 与 `pnpm-lock.yaml`（esbuild 的 postinstall 被 `allowBuilds: false` 关掉，这是预期） |
| 2 | `tsconfig.json`、`tsconfig.client.json`、`client/index.ts` | `pnpm run typecheck` exit 0（A1）。这一步先做，因为它把「类型不依赖 DSH 包」这条核心假设立刻验证掉 |
| 3 | `host/tool.ts`、`host/index.ts` | `pnpm run typecheck` 仍然 exit 0 |
| 4 | `execution-engine.cordis.yml` | 肉眼 + §9.1 的 spec（此时可以先写 spec） |
| 5 | `tests/overlay.spec.ts`、`tests/host-shape.spec.ts` | `pnpm run test` 全绿（A2） |
| 6 | `build/build-client.mjs` | `pnpm run build` 产出 `lib/client.js`；`node --check` 通过（A3） |
| 7 | `tests/fixtures/cordis.yml`、`tests/loader-driver.ts` | **由你跑** §8 B2 → `LOADER_SMOKE_OK` |
| 8 | 端到端复验 | **由你跑** §8 B1（dump 里出现锚定后的行、stderr 无 not-found），想看得更实就跑 §8 C |
| 9 | 提交 | `git add -A; git commit -m "阶段 0：骨架"`。`node_modules/` 与 `lib/` 已被 `.gitignore` 覆盖，`pnpm-lock.yaml` 会被提交（Blackboard 也提交了，`Workspace/Blackboard/phase1-plan.md` §2.3 记录了理由） |

第 7、8 步需要 tsx，**本会话沙箱跑不了**（§1 实测 EPERM）。第 1 步的 `pnpm install` 按你的硬约束本节也不执行。

---

## 11. 风险与未验证项

| # | 风险 / 未验证 | 影响 | 处置 |
|---|---|---|---|
| R1 | **声明 `dsh.client` 但没有 `lib/client.js` 会让 `dsh web` 启动失败**（`modules` 是 required 行）。已实读源码确认，见 §3 | 阶段 0 若只写 `dsh.client` 不产 bundle，「阶段 0 结束时仓库可运行」这条原则就破了 | 本方案按字面补齐 `client/index.ts` + `build/build-client.mjs`。**若你不接受新增 esbuild 依赖，替代方案见 §12 Q1** |
| R2 | `tsc` 能否把 `@deepseek-ai/dsh-tools` 解析到源码 | 解析不了则整个「不写 DSH 依赖」的方案不成立 | Blackboard 同款配置已实测 `pnpm run typecheck` exit 0；本目录首次 `typecheck` 时必须再看一遍 |
| R3 | tsx 在 cwd = `Workspace/ExecutionEngine` 时能否正确解析继承来的 `paths` | 影响「`pnpm run test` 也用 tsx」这条路 | **未验证**，本方案不依赖它：`pnpm run test` 纯 Node，B2 从仓库根跑 |
| R4 | `esbuild` 在本机装得上、CLI 形态在沙箱里能跑 | `pnpm run build` 失败 | Blackboard 已成功产出 `lib/client.js` 并有 README 记录 `allowBuilds: esbuild: false` 的处理；本会话未重跑（会写 Blackboard 的 `lib/`） |
| R5 | `boot()` 起的最小组合里 `ctx.tools` 是否真的激活 | B2 会在 `ctx.tools` 处抛 `cannot get property "tools" without inject`；这本身就是清晰的失败信号 | 最小组合照抄 `packages/context/session-reference/tests/fixtures/cordis.yml` 的前三行。若仍 PENDING，`boot()` 的 startup audit 会打印 inactive entry 的诊断，按诊断补行 |
| R6 | 占位工具注册在 host 平面会被**所有** preset 继承，`minimal` 也会看到 | 模型多看到一个诊断工具 | 描述里写明 do not call it；阶段 3 改成 preset 内注册时一并解决（同 Blackboard phase2-plan R5） |
| R7 | 本目录不在仓库 lint / 覆盖率 / verify 门的完整覆盖内 | 风格靠自觉 | 照 Blackboard 的先例执行；但**不要**以为完全没覆盖：`verify-cordis-config` 会扫到 `execution-engine.cordis.yml` 与 `tests/fixtures/cordis.yml`（`scripts/cordis-config-files.ts:13-17`），本方案已按它的规则设计（§4.5、§9.4） |
| R8 | `typescript` 编译器 API 在两个 spec 里的用法（`readConfigFile` / `createProgram` / `getExportsOfModule`） | spec 写不通 | 报错即改；退路是把 `host-shape.spec.ts` 降级成对 `host/index.ts` 源码文本的断言（弱，但能在无 tsx 环境兜底） |

---

## 12. 开工前需要你回答的问题

**Q1（最重要）：客户端半边怎么处理？** 已实测：`package.json` 一旦声明 `dsh.client`，`@deepseek-ai/dsh-client-modules` 就会在启动时读 `lib/client.js`，读不到会让 `dsh web` **整体启动失败**（§3）。两条路：

- **方案甲（本方案，照 design.md §12 字面）**：阶段 0 就写 `client/index.ts` + `build/build-client.mjs`，`devDependencies` 加 `esbuild@0.25.12`，需要在 `Workspace/ExecutionEngine` 下跑一次 `pnpm install`。好处：骨架完整，阶段 6 只填 `client/index.ts`，`dsh web --patch` 从阶段 0 起就能挂。
- **方案乙（零依赖）**：阶段 0 **不写 `dsh.client` 段也不写 `exports["./client"]`**，只保留 `client/index.ts`（给 `tsconfig.client.json` 当输入）与一个有实际内容的 `build` 脚本之外的占位。好处：不装任何包、不碰网络。代价：偏离 design.md §12 的「`package.json` 有 `dsh.client` 段」，且阶段 6 要回头补 `exports` / `dsh.client` / `build` 三处。

我推荐**方案甲**：design.md 是冻结依据，且阶段 0 的产物会一直挂在你正在用的 GUI 上，从第一天就应该是完整可运行的形态。**请确认是否允许在该目录执行 `pnpm install`（装 esbuild）。**

**Q2：验证由谁跑？** §8 的 B 档与 C 档都需要 tsx，而本会话沙箱实测 EPERM（`node --import tsx/esm …` 直接失败）。是否接受这个分工：A 档（typecheck / test / build / `node --check`）由我跑，B 档（`--dump-config`、`loader-driver`）与可选的 C 档由你跑？

**Q3：占位工具的名字确认。** 用 `execution_engine_ping`（一眼是诊断件、阶段 3 删掉、不会被模型误当产品 API），而不是直接用 `run_program` 占位（理由见 §7）。可以吗？

**Q4：包名确认。** 用非 scoped 的 `dsh-execution-engine`（照 Blackboard 的 `dsh-blackboard`，也必须是客户端模块表 id），阶段 7 搬进 `packages/` 时改成 `@deepseek-ai/dsh-execution-engine`。可以吗？

**Q5：`--dump-config` 的副作用确认。** B1 会重写 `$DSH_HOME/profiles/web/cordis.yml`（内容恒为空 entry 列表，幂等，见 §3）。它不动你的 `cordis.patch.yml` 与本目录之外的其他文件。可以接受吗？

---

## 附：本次调研读过的关键文件

| 主题 | 文件 |
|---|---|
| 设计依据 | `Workspace/ExecutionEngine/design.md`（§12 阶段 0、§9 配置、§7.4 复用能力） |
| 模板插件 | `Workspace/Blackboard/` 下 `README.md`、`package.json`、`pnpm-workspace.yaml`、`tsconfig.json`、`tsconfig.client.json`、`blackboard.cordis.yml`、`host/index.ts`、`host/tool.ts`、`host/store.ts`、`client/index.tsx`、`build/build-client.mjs`、`dev/server.ts`、`tests/store.spec.ts`、`phase1-plan.md`、`phase2-plan.md`（§A.2/A.4/A.6、R1/R5） |
| patch / overlay | `apps/cli/src/args.ts`、`apps/cli/src/profile-boot.ts`、`apps/cli/src/dump-config.ts`、`packages/boot/app-boot/src/index.ts`（`loadOverlayPatches`/`anchorInsertedPluginNames`/`parsePatchList`/`boot`/`auditStartupEntries`/`renderConfigDump`/`requiredStartupEntryIds`）、`vendor/include/src/index.ts`（`applyEntryPatches`）、`vendor/loader/src/index.ts`（`unwrapExports`）、`vendor/loader/src/config/entry.ts`、`vendor/loader/src/config/tree.ts` |
| 门与发现逻辑 | `scripts/verify-cordis-config.ts`、`scripts/cordis-config-files.ts` |
| 客户端模块系统 | `packages/client/modules/src/index.ts`（`resolveMeta`/`locatePkgJson`/`nearestPackage`/`initialBundleSnapshot`/`MissingClientBundleError`/`bootInjections`）、`packages/bundle/web-app/cordis.patch.yml` |
| 插件形态与工具 | `packages/AGENTS.md`、`docs/postmortem/0001-acp-default-export-drops-inject.md`、`packages/todo/tool-todo/src/index.ts`、`packages/jobs/tool-jobs/src/index.ts`、`packages/plan/plan-mode/src/index.ts`、`packages/core/tools/src/schema.ts`、`packages/core/tools/src/index.ts`（`static inject`、`register`、`schemas`、`view`）、`packages/core/system-prompt/src/index.ts` |
| 真实组合驱动 | `packages/shell/tool-pwsh/tests/fixtures/loader/{cordis.yml,driver.ts}`、`packages/context/session-reference/tests/{fixtures/cordis.yml,loader-composition.spec.ts}`、`packages/test-support/loader-smoke/src/index.ts`、`apps/web/tests/shipped-composition.e2e.ts` |
| 配置与工作区 | 根 `package.json`、`pnpm-workspace.yaml`、`tsconfig.base.json`、`tsconfig.base.client.json`、`apps/cli/reference/README.md` |

---

## 13. 开工前问题的裁决

由负责人裁决，**执行时以本节为准**。

- **Q1 → 方案甲。** 阶段 0 就写 `client/index.ts` + `build/build-client.mjs`，`devDependencies` 加 `esbuild@0.25.12`，并允许在 `Workspace/ExecutionEngine` 下执行 `pnpm install`。
  - 理由一：`dsh.client` 与 `lib/client.js` 必须同进同出（§3 已实读确认，声明了却读不到会让整个 `dsh web` 启动失败），design.md §12 又明确要求 `dsh.client` 段——两条合起来只有"同时产出 bundle"一个解。
  - 理由二：客户端管线是本项目里**最没被验证过**的一段。把它压到阶段 0 验证掉，比留到阶段 6 再发现要便宜得多。
- **Q2 → 不把 B 档推给人。** 执行 agent 自己跑 A 档与 B 档。若 `node --import tsx/esm …` 在本会话沙箱被 EPERM 拒绝（§1 已记录过），**原样重试一次并附 sandbox 升级申请**；升级被拒才停下回报，不得换写法绕过。
- **Q3 → 同意** `execution_engine_ping`，理由照 §7。
- **Q4 → 同意** `dsh-execution-engine`（非 scoped；它同时必须是客户端模块表 id）。
- **Q5 → 有条件接受。** 跑 B1 之前，若 `$DSH_HOME/profiles/web/cordis.yml` 存在且非空，**先备份，跑完恢复**。
- **C 档从"可选"升为"条件必做"。** 理由：B2 走的是 `tests/fixtures/cordis.yml`，**完全不经过 `--patch`**；B1 只证明组合后的配置文本正确，不证明插件真的启动成功。二者合起来仍然没有验证"通过 overlay + 客户端 bundle 真的挂上"。所以：把 `dsh web --patch …` 作为**受管后台任务**起在 **3099** 端口，从日志确认启动成功且没有 `required startup failure`，然后**关掉**它、确认端口释放。
  - 先在源码里确认 `DSH_HOME` 环境变量被尊重；能确认就把 `DSH_HOME` 指到临时目录再跑，避免碰到正在使用的 profile 与 session 存储。
  - 确认不了就不跑 C 档，**回报**，不要改去动用户的 `$DSH_HOME`。

### 评审与提交协议

执行 agent **只暂存不提交**（`git add -A`），由独立的评审 agent 审 `git diff --cached`；评审通过后由负责人提交。
