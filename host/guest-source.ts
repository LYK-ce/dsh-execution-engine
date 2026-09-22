/**
 * 送进 `ctx.ptcRuntime` 的外壳程序源码（phase1-plan §3.4）。
 *
 * 三段固定文本拼成 `GUEST_SOURCE`：
 * 1. `GUEST_IMPORT_SOURCE` —— PTC 子进程里可用的 Node 内建模块句柄。PTC 的程序正文是
 *    一个 async 函数体，静态 `import` 声明不合法，所以只能动态 import。
 * 2. `CAPABILITY_SURFACE_SOURCE` —— vm 能力面（phase1-plan §3.3 方案乙）：原语、`console`、
 *    收窄的文件助手、`fetch`。它同时也是"以引导为目的的全局扣留"：vm context 里没有
 *    Node 的 `process` / `require` / `module`。
 * 3. `GUEST_DRIVER_SOURCE` —— 建 context、编译用户程序、求值、把完成值原样交回 PTC。
 *
 * **行号约束（为阶段 5 铺路）**：用户程序以字符串字面量嵌入（见 `capabilities.ts`），
 * 运行时才拼成 `"(async () => {\n" + 程序 + "\n})()"`，拼接不做任何行变换，
 * `lineOffset: -1` 抵掉外壳那一行。用户源码的第 N 行因此永远上报为第 N 行。
 * @module dsh-execution-engine/guest-source
 */

/** PTC 子进程里取到的 Node 内建模块句柄。 */
export const GUEST_IMPORT_SOURCE = [
  'const vm = await import("node:vm");',
  'const fsPromises = await import("node:fs/promises");',
  'const nodePath = await import("node:path");',
].join('\n')

/**
 * vm 能力面。`__dshMakeSurface(flowNamespace, options)` 返回的对象就是 vm context 的全局：
 * 它的每个属性成为程序可见的全局名。
 *
 * 扣留的是 Node 的运行时全局，不是安全边界——`workflow-ptc` README 的定性同样适用：
 * *The VM is not a security boundary — withheld globals guide script authors.*
 */
export const CAPABILITY_SURFACE_SOURCE = [
  'function __dshRequireString(value, label) {',
  '  if (typeof value !== "string") throw new TypeError(label + " requires a string");',
  '  return value;',
  '}',
  '',
  'function __dshMakeSurface(flowNamespace, options) {',
  '  var tmpDir = options.tmpDir;',
  '  var cwd = options.cwd;',
  '  var roots = [tmpDir, cwd];',
  '',
  '  function resolveInside(value, label) {',
  '    var requested = __dshRequireString(value, label);',
  '    if (requested.length === 0) throw new TypeError(label + " requires a non-empty path");',
  '    var resolved = nodePath.resolve(cwd, requested);',
  '    for (var index = 0; index < roots.length; index++) {',
  '      var relative = nodePath.relative(roots[index], resolved);',
  '      // 只把父目录本身与"上一级 + 分隔符"算作越界：根内合法文件名可以就叫 "..foo"。',
  '      var climbs = relative === ".." || relative.startsWith(".." + nodePath.sep);',
  '      if (relative === "" || (!climbs && !nodePath.isAbsolute(relative))) return resolved;',
  '    }',
  '    throw new Error(label + " path is outside this run\'s temporary directory and the session directory: " + requested);',
  '  }',
  '',
  '  function readArgv(value, label) {',
  '    if (!Array.isArray(value) || value.length === 0) throw new TypeError(label + " requires a non-empty argv array");',
  '    var argv = [];',
  '    for (var index = 0; index < value.length; index++) {',
  '      argv.push(__dshRequireString(value[index], label + " argv[" + index + "]"));',
  '    }',
  '    return argv;',
  '  }',
  '',
  '  function readTimeout(opts, label) {',
  '    if (opts === undefined || opts === null) return undefined;',
  '    if (typeof opts !== "object") throw new TypeError(label + " options must be an object");',
  '    var timeoutMs = opts.timeoutMs;',
  '    if (timeoutMs === undefined) return undefined;',
  '    if (typeof timeoutMs !== "number" || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {',
  '      throw new TypeError(label + " timeoutMs must be a positive integer number of milliseconds");',
  '    }',
  '    return timeoutMs;',
  '  }',
  '',
  '  // 每个程序可见的函数都是 async：参数不合法时返回一个被拒绝的 Promise，而不是同步抛出——',
  '  // 接口声明写的是 Promise，调用点不该需要额外包一层 try。',
  '  // 报错带真实 member 名：processOrThrow 的参数错误不该自称 process。',
  '  async function callProcess(member, argv, opts) {',
  '    var args = { argv: readArgv(argv, member) };',
  '    var timeoutMs = readTimeout(opts, member);',
  '    if (timeoutMs !== undefined) args.timeoutMs = timeoutMs;',
  '    return await flowNamespace[member](args);',
  '  }',
  '',
  '  return {',
  '    flow: Object.freeze({ tmpDir: tmpDir }),',
  '    process: function (argv, opts) { return callProcess("process", argv, opts); },',
  '    processOrThrow: function (argv, opts) { return callProcess("processOrThrow", argv, opts); },',
  '    dispatchsubagent: async function (prompt) {',
  '      return await flowNamespace.dispatchsubagent({ prompt: __dshRequireString(prompt, "dispatchsubagent prompt") });',
  '    },',
  '    readTextFile: async function (path) {',
  '      return await fsPromises.readFile(resolveInside(path, "readTextFile"), "utf8");',
  '    },',
  '    writeTextFile: async function (path, text) {',
  '      return await fsPromises.writeFile(',
  '        resolveInside(path, "writeTextFile"),',
  '        __dshRequireString(text, "writeTextFile text"),',
  '        "utf8",',
  '      );',
  '    },',
  '    exists: async function (path) {',
  '      var resolved = resolveInside(path, "exists");',
  '      return await fsPromises.access(resolved).then(function () { return true; }, function () { return false; });',
  '    },',
  '    fetch: fetch,',
  '    console: console,',
  '  };',
  '}',
].join('\n')

/**
 * 求值驱动。`userProgram` 是**已经剥掉类型**的用户源码字符串，`options.tmpDir` /
 * `options.cwd` 是本次 run 的落点。剥类型由宿主完成（见 `capabilities.ts`
 * 的 `stripUserProgram`）：这里拿到的已经是纯 JS，行结构不变。
 */
export const GUEST_DRIVER_SOURCE = [
  'async function __dshRunProgram(flowNamespace, userProgram, options) {',
  '  var surface = __dshMakeSurface(flowNamespace, options);',
  '  var context = vm.createContext(surface, { name: "execution-engine" });',
  '  var script = new vm.Script("(async () => {\\n" + userProgram + "\\n})()", {',
  '    filename: "flow-program.ts",',
  '    lineOffset: -1,',
  '  });',
  '  return await script.runInContext(context);',
  '}',
].join('\n')

/**
 * 固定外壳：三段拼起来即"自包含"。它引用 PTC 绑定命名空间全局 `flow` 与 PTC 提供的
 * `console`（两者都是程序正文的参数名），用户程序的字面量与调用行由 `capabilities.ts` 追加。
 */
export const GUEST_SOURCE = [GUEST_IMPORT_SOURCE, CAPABILITY_SURFACE_SOURCE, GUEST_DRIVER_SOURCE].join('\n')
