/**
 * 把 client/index.ts 打成 DSH 客户端模块表要的 CJS bundle：lib/client.js。
 *
 * 不能复用仓库的 clientBundle()（packages/client/tsdown.client.ts 的 workspaceManifest 只扫 packages/*\/*），
 * 所以这里自己复刻 bundle 协议的三件事：CJS 输出、模块表 banner/footer、基线模块外部化。
 */
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 本包在模块表里的 id，必须等于 package.json 的 name。 */
const ID = 'dsh-execution-engine'

/** 基线模块：shell 静态播种，动态 bundle 只 require 不内联（packages/client/web/src/platform.ts）。 */
const BASELINE = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
]

/** 模块表注册头；`intro` 那行给出 CJS 的 module/exports 座位。 */
const BANNER = `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {\n`
  + 'var module = { exports: {} }; var exports = module.exports;\n'

/** 工厂返回 exports，模块表再按需 materialize。 */
const FOOTER = '\nreturn module.exports; } });\n'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

const result = spawnSync(process.execPath, [
  createRequire(import.meta.url).resolve('esbuild/bin/esbuild'),
  join(root, 'client', 'index.ts'),
  '--bundle',
  '--format=cjs',
  '--platform=browser',
  '--target=es2022',
  '--jsx=automatic',
  `--outfile=${join(root, 'lib', 'client.js')}`,
  ...BASELINE.map((name) => `--external:${name}`),
  `--banner:js=${BANNER}`,
  `--footer:js=${FOOTER}`,
], { stdio: 'inherit' })

// 这个沙箱禁止带管道的子进程（Node 的 child_process 默认 stdio 会 EPERM），而 esbuild 的 JS API
// 正是用管道拉起它的 service；CLI + 继承 stdio 是这里唯一跑得通的形态，两者产物相同。
if (result.error !== undefined) throw result.error
process.exitCode = result.status ?? 1
