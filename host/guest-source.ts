/**
 * 送进 `ctx.ptcRuntime` 的外壳程序源码（phase1-plan §3.4）。
 *
 * 三段固定文本拼成 `GUEST_SOURCE`：
 * 1. `GUEST_IMPORT_SOURCE` —— PTC 子进程里可用的 Node 内建模块句柄。PTC 的程序正文是
 *    一个 async 函数体，静态 `import` 声明不合法，所以只能动态 import。
 * 2. `CAPABILITY_SURFACE_SOURCE` —— vm 能力面（phase1-plan §3.3 方案乙）：原语、
 *    收窄的文件助手、`fetch`。它同时也是"以引导为目的的全局扣留"：vm context 里没有
 *    Node 的 `process` / `require` / `module`。阶段 5 起四个原语在这里被包装，每次调用经
 *    `flowNamespace.trace` 向宿主上报调用点行号、实参预览与结果。
 * 3. `GUEST_DRIVER_SOURCE` —— 建 context、编译用户程序、求值、把完成值原样交回 PTC。
 *
 * **行号约束（阶段 5 的实现依据）**：用户程序以字符串字面量嵌入（见 `capabilities.ts`），
 * 运行时才拼成 `"(async () => {\n" + 程序 + "\n})()"`，拼接不做任何行变换，
 * `lineOffset: -1` 抵掉外壳那一行。用户源码的第 N 行因此在栈里就是第 N 行，
 * `callSiteLine` 直接从栈里取它。行为断言在 `tests/vm-surface.spec.ts`。
 * @module dsh-execution-engine/guest-source
 */

/** PTC 子进程里取到的 Node 内建模块句柄。 */
export const GUEST_IMPORT_SOURCE = [
  'const vm = await import("node:vm");',
  'const fsPromises = await import("node:fs/promises");',
  'const nodePath = await import("node:path");',
].join('\n')

/**
 * 事件里参数与结果预览的字符上界。界是硬的：`process` 的 stdout 可能很大，而事件要进 UI 的
 * 状态流，靠调用方自觉不构成上界（phase5-plan §0 E）。
 */
export const PREVIEW_MAX_CHARS = 200

/**
 * 投影里单个字符串的上界。比 {@link PREVIEW_MAX_CHARS} 宽：JSON 的转义会把字符变多，而最终那一刀
 * 切在序列化之后——留出这个余量，投影过的 JSON 仍然超过上界，`truncated` 因此不会报反。
 */
export const PREVIEW_STRING_MAX_CHARS = PREVIEW_MAX_CHARS * 2

/** 投影里数组元素与对象键的上界：再长的数组只留前这么多个。 */
export const PREVIEW_MAX_ITEMS = 64

/** 投影的递归深度上界；超过就回落成类型名。环形引用也在这里收住。 */
export const PREVIEW_MAX_DEPTH = 4

/**
 * vm 能力面。`__dshMakeSurface(flowNamespace, options)` 返回的对象就是 vm context 的全局：
 * 它的每个属性成为程序可见的全局名。
 *
 * 扣留的是 Node 的运行时全局，不是安全边界——`workflow-ptc` README 的定性同样适用：
 * *The VM is not a security boundary — withheld globals guide script authors.*
 *
 * 阶段 5 起四个原语被包装一层：每次调用经 `flowNamespace.trace` 向宿主上报一次
 * （开始与结束各一条，失败路径也闭合）。`trace` 挂在外壳拿到的绑定命名空间上，
 * **不在返回的能力面上**，所以程序看不见它。
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
  '  // ---- 阶段 5：调用点行号、有界预览与内部上报 -------------------------------',
  '',
  `  var PREVIEW_MAX_CHARS = ${String(PREVIEW_MAX_CHARS)};`,
  `  var PREVIEW_STRING_MAX = ${String(PREVIEW_STRING_MAX_CHARS)};`,
  `  var PREVIEW_ITEM_MAX = ${String(PREVIEW_MAX_ITEMS)};`,
  `  var PREVIEW_DEPTH_MAX = ${String(PREVIEW_MAX_DEPTH)};`,
  '  var nextCallId = 0;',
  '',
  '  // 计时用单调时钟：Date.now() 会随墙钟回跳（NTP 校时、手工改表）变小，而负耗时会被宿主那条',
  '  // 解析边界拒掉——那会连带丢掉整条 call-end。performance 是 Node 的全局；缺席时回落成墙钟，',
  '  // 并照样夹到非负。',
  '  var elapsedClock = typeof performance === "object" && performance !== null && typeof performance.now === "function"',
  '    ? function () { return performance.now(); }',
  '    : function () { return Date.now(); };',
  '  function elapsedSince(startedAt) { return Math.max(0, Math.round(elapsedClock() - startedAt)); }',
  '',
  '  // 把值投影成有界的等价物：长字符串截断、超长数组与超多键的对象收窄、超过深度的回落成类型名。',
  '  // 界施加在序列化**之前**：JSON.stringify 会先把整份结果物化出来，然后才轮到这里切 200 个字符——',
  '  // 一次 100MB 的 stdout 会先变成一整个 JSON 字符串，再被丢掉 99.99%。',
  '  // 返回的 dropped 说明投影丢过东西，它与"序列化后超过上界"合成 truncated 布尔。',
  '  function project(value, depth) {',
  '    if (typeof value === "string") {',
  '      return value.length <= PREVIEW_STRING_MAX',
  '        ? { value: value, dropped: false }',
  '        : { value: value.slice(0, PREVIEW_STRING_MAX), dropped: true };',
  '    }',
  '    if (value === null || typeof value !== "object") return { value: value, dropped: false };',
  '    if (depth >= PREVIEW_DEPTH_MAX) return { value: typeof value, dropped: true };',
  '    // 带 toJSON 的对象（Date 一类）交给 JSON.stringify 自己折：换掉它会改变它的序列化结果。',
  '    if (typeof value.toJSON === "function") return { value: value, dropped: false };',
  '    var index;',
  '    var dropped = false;',
  '    var projected;',
  '    if (Array.isArray(value)) {',
  '      projected = [];',
  '      var items = Math.min(value.length, PREVIEW_ITEM_MAX);',
  '      if (items < value.length) dropped = true;',
  '      for (index = 0; index < items; index++) {',
  '        var item = project(value[index], depth + 1);',
  '        projected.push(item.value);',
  '        if (item.dropped) dropped = true;',
  '      }',
  '      return { value: projected, dropped: dropped };',
  '    }',
  '    var keys = Object.keys(value);',
  '    projected = {};',
  '    var kept = Math.min(keys.length, PREVIEW_ITEM_MAX);',
  '    if (kept < keys.length) dropped = true;',
  '    for (index = 0; index < kept; index++) {',
  '      var child = project(value[keys[index]], depth + 1);',
  '      projected[keys[index]] = child.value;',
  '      if (child.dropped) dropped = true;',
  '    }',
  '    return { value: projected, dropped: dropped };',
  '  }',
  '',
  '  // 把任意值折成有界字符串：字符串先截断、不再 JSON 化；其余先投影再序列化；不可序列化回落成',
  '  // 类型名。',
  '  function preview(value) {',
  '    if (typeof value === "string") {',
  '      return value.length <= PREVIEW_MAX_CHARS',
  '        ? { text: value, truncated: false }',
  '        : { text: value.slice(0, PREVIEW_MAX_CHARS), truncated: true };',
  '    }',
  '    var projected = project(value, 0);',
  '    var encoded;',
  '    try {',
  '      encoded = JSON.stringify(projected.value);',
  '    } catch (error) {',
  '      // BigInt 让 JSON.stringify 抛；回落成类型名，调用点仍然有得看。环形引用由投影的深度上界',
  '      // 收住，走不到这里。',
  '      encoded = undefined;',
  '    }',
  '    if (encoded === undefined) return { text: typeof value, truncated: projected.dropped };',
  '    return encoded.length <= PREVIEW_MAX_CHARS',
  '      ? { text: encoded, truncated: projected.dropped }',
  '      : { text: encoded.slice(0, PREVIEW_MAX_CHARS), truncated: true };',
  '  }',
  '',
  '  // 用户程序在 vm 里以 flow-program.ts 为虚拟文件名编译（见下方驱动），所以栈里第一个',
  '  // flow-program.ts 帧就是调用点那一行；包装函数自己那一帧在外壳里，名字不同，正则取不到。',
  '  // 取不到就报 null——瞎猜一个行号会让面板指着错误的行。',
  '  // 这个文件名与 GUEST_DRIVER_SOURCE 的 filename 必须一致；tests/vm-surface.spec.ts 用写死的',
  '  // 期望行号从行为上钉住它。',
  '  function callSiteLine() {',
  '    var stack = new Error().stack;',
  '    if (typeof stack !== "string") return null;',
  '    var match = /flow-program\\.ts:(\\d+):\\d+/.exec(stack);',
  '    if (match === null) return null;',
  '    var line = Number(match[1]);',
  '    return Number.isSafeInteger(line) && line > 0 ? line : null;',
  '  }',
  '',
  '  // 上报尽力而为：绑定缺席或参数被拒时程序照跑，诊断通道不是业务通道。',
  '  function trace(record) {',
  '    try {',
  '      ignoreRejection(flowNamespace.trace(record));',
  '    } catch (error) {',
  '      // 与上面同一条理由：拿不到诊断通道时程序照跑。',
  '    }',
  '  }',
  '',
  '  // 上报不等回执（phase5-plan §10 Q1 的裁决），但回执的拒绝得有人收——没人收的 rejection',
  '  // 会让 guest 进程按 Node 的默认策略崩掉，那才是真的"上报改变了程序的行为"。',
  '  function ignoreRejection(pending) {',
  '    if (pending !== null && typeof pending === "object" && typeof pending.then === "function") {',
  '      pending.then(undefined, function () {});',
  '    }',
  '  }',
  '',
  '  // 包在四个原语的**外层**（参数校验之前）：坏参数也有闭合的一对事件，而 line 永远是程序里那一行。',
  '  function wrap(member, invoke) {',
  '    return function () {',
  '      var args = Array.prototype.slice.call(arguments);',
  '      var callId = nextCallId;',
  '      nextCallId += 1;',
  '      var line = callSiteLine();',
  '      var startedAt = elapsedClock();',
  '      var argsPreview = preview(args);',
  '      trace({',
  '        phase: "start", callId: callId, member: member, line: line,',
  '        args: argsPreview.text, argsTruncated: argsPreview.truncated,',
  '      });',
  '      return invoke.apply(undefined, args).then(function (value) {',
  '        var resultPreview = preview(value);',
  '        trace({',
  '          phase: "end", callId: callId, member: member, line: line, ms: elapsedSince(startedAt),',
  '          outcome: "ok", text: resultPreview.text, textTruncated: resultPreview.truncated,',
  '        });',
  '        return value;',
  '      }, function (error) {',
  '        var errorPreview = preview(String(error));',
  '        trace({',
  '          phase: "end", callId: callId, member: member, line: line, ms: elapsedSince(startedAt),',
  '          outcome: "error", text: errorPreview.text, textTruncated: errorPreview.truncated,',
  '        });',
  '        throw error;',
  '      });',
  '    };',
  '  }',
  '',
  '  // 每个程序可见的函数都是 async：参数不合法时返回一个被拒绝的 Promise，而不是同步抛出——',
  '  // 接口声明写的是 Promise，调用点不该需要额外包一层 try。包装函数原样保留这条：它返回的是',
  '  // 内层 async 函数那条 promise 的派生，自己不是 async。',
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
  '    process: wrap("process", function (argv, opts) { return callProcess("process", argv, opts); }),',
  '    processOrThrow: wrap("processOrThrow", function (argv, opts) { return callProcess("processOrThrow", argv, opts); }),',
  '    dispatchsubagent: wrap("dispatchsubagent", async function (prompt, opts) {',
  '      var args = { prompt: __dshRequireString(prompt, "dispatchsubagent prompt") };',
  '      // 程序侧只声明 provider / model 两个可选字段（见 host/sdk.ts 的 .d.ts），外壳只转发这两个键，',
  '      // 并**拒绝**其余自有键：静默丢掉它们会让程序拿到成功、而用到的不是它要的东西——姊妹工具的',
  '      // 模型字段叫 reasoning_effort（packages/subagent/tool-subagent/src/model-selection.ts:65-69），',
  '      // 过界前丢掉它就等于不指定 effort，而绑定那一层看不到这个键，没有任何一层能报错。',
  '      // 判空与配对校验留给绑定那一层（它才是参数契约的落点）。',
  '      if (opts !== undefined && opts !== null) {',
  '        if (typeof opts !== "object" || Array.isArray(opts)) {',
  '          throw new TypeError("dispatchsubagent options must be an object with at most `provider` and `model`");',
  '        }',
  '        var keys = Object.keys(opts);',
  '        for (var index = 0; index < keys.length; index++) {',
  '          if (keys[index] !== "provider" && keys[index] !== "model") {',
  '            throw new TypeError("dispatchsubagent options accept only `provider` and `model`; unknown key: " + keys[index]);',
  '          }',
  '        }',
  '        if (opts.provider !== undefined) args.provider = opts.provider;',
  '        if (opts.model !== undefined) args.model = opts.model;',
  '      }',
  '      return await flowNamespace.dispatchsubagent(args);',
  '    }),',
  '    report: wrap("report", async function (text) {',
  '      await flowNamespace.report({ text: __dshRequireString(text, "report text") });',
  '    }),',
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
  '  // vm 的 realm 自带一个 console（Node 在 contextify 时装的），它**不是**我们的能力面：输出不进',
  '  // 本次 run 的日志、也不回主 agent。留着它，"用了不存在的名字"就退化成静默的空操作；删掉它，',
  '  // 能力面才与 `.d.ts` 一致——程序里的 console.log 会响亮地以 ReferenceError 失败。',
  '  vm.runInContext("delete globalThis.console", context);',
  '  var script = new vm.Script("(async () => {\\n" + userProgram + "\\n})()", {',
  '    filename: "flow-program.ts",',
  '    lineOffset: -1,',
  '  });',
  '  return await script.runInContext(context);',
  '}',
].join('\n')

/**
 * 固定外壳：三段拼起来即"自包含"。它引用 PTC 绑定命名空间全局 `flow`（程序正文的形参之一），
 * 用户程序的字面量与调用行由 `capabilities.ts` 追加。PTC 另外注入的 `console` 与错误类
 * **不进程序可见面**：本插件不读程序的 console 输出（`host/engine.ts` 的 `classifyOutcome`）。
 */
export const GUEST_SOURCE = [GUEST_IMPORT_SOURCE, CAPABILITY_SURFACE_SOURCE, GUEST_DRIVER_SOURCE].join('\n')
