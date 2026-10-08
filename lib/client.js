window.__ModuleLoader__.load({ id: "dsh-execution-engine", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;

"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// client/index.tsx
var index_exports = {};
__export(index_exports, {
  apply: () => apply,
  inject: () => inject
});
module.exports = __toCommonJS(index_exports);

// shared/protocol.ts
var STATE_PATH = "/api/execution-engine.state";
var CANCEL_PATH = "/api/execution-engine.cancel";

// client/locale.ts
var NS = "execution-engine";
var zh = {
  "view.panel": "\u6267\u884C\u5F15\u64CE",
  "status.running": "\u8FD0\u884C\u4E2D",
  "status.completed": "\u5DF2\u5B8C\u6210",
  "status.killed": "\u5DF2\u53D6\u6D88",
  "status.failed": "\u5931\u8D25",
  "status.idle": "\u5F53\u524D\u6CA1\u6709\u7A0B\u5E8F\u5728\u8DD1\u3002",
  "status.detail": "\u8BF4\u660E\uFF1A{detail}",
  "status.discarded": "\u8FD9\u6B21\u53D6\u6D88\u4F5C\u5E9F\u4E86 {count} \u6761\u8FD8\u6CA1\u88AB\u8BFB\u5230\u7684\u6C47\u62A5\u3002",
  "status.started": "\u5F00\u59CB\u4E8E {time}",
  "status.ended": "\u7ED3\u675F\u4E8E {time}",
  "section.code": "\u7A0B\u5E8F\u6E90\u7801",
  "code.empty": "\uFF08\u7A7A\u7A0B\u5E8F\uFF09",
  "code.window": "\u7B2C {from}\u2013{to} \u884C\uFF0C\u5171 {total} \u884C",
  "section.trace": "\u8C03\u7528\u8F68\u8FF9",
  "trace.empty": "\u8FD8\u6CA1\u6709\u8C03\u7528\u3002",
  "trace.line": "\u7B2C {line} \u884C",
  "trace.noLine": "\u884C\u53F7\u672A\u77E5",
  "trace.duration": "{ms} ms",
  "trace.synthetic": "\u5BBF\u4E3B\u8865\u53D1",
  "trace.open": "\u8FDB\u884C\u4E2D",
  "trace.ok": "\u6210\u529F",
  "trace.error": "\u5931\u8D25",
  "section.reports": "\u6C47\u62A5",
  "reports.empty": "\u8FD8\u6CA1\u6709\u6C47\u62A5\u3002",
  "action.cancel": "\u53D6\u6D88\u7A0B\u5E8F",
  "action.cancelling": "\u53D6\u6D88\u4E2D\u2026",
  "action.cancelFailed": "\u53D6\u6D88\u5931\u8D25\uFF1A{reason}"
};
var en = {
  "view.panel": "Execution Engine",
  "status.running": "Running",
  "status.completed": "Completed",
  "status.killed": "Cancelled",
  "status.failed": "Failed",
  "status.idle": "No program is running.",
  "status.detail": "Detail: {detail}",
  "status.discarded": "The cancellation discarded {count} unread report(s).",
  "status.started": "Started {time}",
  "status.ended": "Ended {time}",
  "section.code": "Program source",
  "code.empty": "(empty program)",
  "code.window": "Lines {from}\u2013{to} of {total}",
  "section.trace": "Call trace",
  "trace.empty": "No calls yet.",
  "trace.line": "line {line}",
  "trace.noLine": "line unknown",
  "trace.duration": "{ms} ms",
  "trace.synthetic": "host-closed",
  "trace.open": "running",
  "trace.ok": "ok",
  "trace.error": "error",
  "section.reports": "Reports",
  "reports.empty": "No reports yet.",
  "action.cancel": "Cancel program",
  "action.cancelling": "Cancelling\u2026",
  "action.cancelFailed": "Cancel failed: {reason}"
};

// client/panel.tsx
var import_react = require("react");
var import_jsx_runtime = require("react/jsx-runtime");
var CODE_MAX_LINES = 400;
var CODE_WINDOW_RADIUS = 150;
var STATUS_KEYS = {
  running: "status.running",
  completed: "status.completed",
  killed: "status.killed",
  failed: "status.failed"
};
var CALL_KEYS = {
  open: "trace.open",
  ok: "trace.ok",
  error: "trace.error"
};
var ROOT = {
  display: "flex",
  flexDirection: "column",
  height: "100%",
  minHeight: 0,
  background: "var(--dsw-alias-bg-base, #ffffff)",
  color: "var(--dsw-alias-label-primary, #1e1e1e)",
  font: "inherit"
};
var TOOLBAR = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "6px 8px",
  borderBottom: "1px solid var(--dsw-alias-border-l1, #e5e5e5)"
};
var BODY = { flex: "1 1 auto", minHeight: 0, overflow: "auto", padding: "6px 8px" };
var BUTTON = {
  marginLeft: "auto",
  height: 26,
  padding: "0 10px",
  cursor: "pointer",
  border: "1px solid var(--dsw-alias-border-l2, #d0d0d0)",
  borderRadius: 6,
  background: "var(--dsw-alias-bg-layer-2, #f7f7f7)",
  color: "inherit",
  font: "inherit"
};
var HEADING = { margin: "8px 0 4px", opacity: 0.7, fontWeight: 600 };
var NOTE = { padding: "2px 0", opacity: 0.8 };
var LABEL = { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };
var CODE = {
  margin: 0,
  padding: "4px 0",
  border: "1px solid var(--dsw-alias-border-l1, #e5e5e5)",
  borderRadius: 6,
  overflowX: "auto",
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
  fontSize: 12,
  lineHeight: 1.5
};
var LINE = { display: "flex", gap: 8, whiteSpace: "pre" };
var LINE_CURRENT = {
  ...LINE,
  background: "var(--dsw-alias-bg-layer-2, #f0f0f0)"
};
var LINE_NUMBER = {
  flex: "0 0 auto",
  minWidth: 36,
  padding: "0 6px",
  textAlign: "right",
  opacity: 0.5,
  userSelect: "none"
};
var ROW = {
  display: "flex",
  flexWrap: "wrap",
  gap: 8,
  alignItems: "baseline",
  padding: "2px 0",
  borderBottom: "1px solid var(--dsw-alias-border-l1, #f2f2f2)"
};
var MUTED = { opacity: 0.65 };
var PREVIEW = {
  flexBasis: "100%",
  opacity: 0.75,
  whiteSpace: "pre-wrap",
  wordBreak: "break-all",
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
  fontSize: 12
};
var REPORT = {
  margin: "2px 0",
  padding: "4px 6px",
  borderLeft: "3px solid var(--dsw-alias-border-l2, #d0d0d0)",
  whiteSpace: "pre-wrap",
  wordBreak: "break-word"
};
function describe(error) {
  return error instanceof Error ? error.message : String(error);
}
function timeOf(at) {
  return new Date(at).toLocaleTimeString();
}
function currentLine(entries) {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry !== void 0 && entry.kind === "call" && entry.state === "open") return entry.line;
  }
  return null;
}
function lineWindow(total, current) {
  if (total <= CODE_MAX_LINES) return { from: 1, to: total };
  const anchor = current ?? 1;
  return {
    from: Math.max(1, anchor - CODE_WINDOW_RADIUS),
    to: Math.min(total, anchor + CODE_WINDOW_RADIUS)
  };
}
function ExecutionEnginePanel({ t, useRun, cancel }) {
  const snapshot = useRun((value) => value);
  const [cancelling, setCancelling] = (0, import_react.useState)(false);
  const [failure, setFailure] = (0, import_react.useState)(void 0);
  const run = snapshot.run;
  const running = run?.status === "running";
  (0, import_react.useEffect)(() => {
    if (!running) setCancelling(false);
  }, [running]);
  const requestCancel = () => {
    setCancelling(true);
    setFailure(void 0);
    void cancel().then(
      (outcome) => {
        if (outcome.ok) return;
        setCancelling(false);
        setFailure(t("action.cancelFailed", { reason: outcome.reason }));
      },
      (error) => {
        setCancelling(false);
        setFailure(t("action.cancelFailed", { reason: describe(error) }));
      }
    );
  };
  const trace = snapshot.entries.filter((entry) => entry.kind === "call");
  const reports = snapshot.entries.filter((entry) => entry.kind === "report");
  const current = currentLine(snapshot.entries);
  const lines = run === null || run.code === "" ? [] : run.code.split("\n");
  const window = lineWindow(lines.length, current);
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: ROOT, children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: TOOLBAR, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { ...LABEL, flex: "1 1 auto" }, children: run === null ? t("status.idle") : run.label }),
      run === null ? null : /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: MUTED, children: t(STATUS_KEYS[run.status]) }),
      run === null ? null : /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
        "button",
        {
          type: "button",
          disabled: !running || cancelling,
          onClick: requestCancel,
          style: BUTTON,
          children: cancelling ? t("action.cancelling") : t("action.cancel")
        }
      )
    ] }),
    failure === void 0 ? null : /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: { ...NOTE, padding: "4px 8px" }, children: failure }),
    run === null ? null : /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: BODY, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: NOTE, children: [
        t("status.started", { time: timeOf(run.startedAt) }),
        run.endedAt === void 0 ? "" : ` \xB7 ${t("status.ended", { time: timeOf(run.endedAt) })}`
      ] }),
      run.detail === void 0 ? null : /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: NOTE, children: t("status.detail", { detail: run.detail }) }),
      run.discarded === 0 ? null : /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: NOTE, children: t("status.discarded", { count: run.discarded }) }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: HEADING, children: t("section.code") }),
      lines.length === 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: NOTE, children: t("code.empty") }) : /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [
        window.from === 1 && window.to === lines.length ? null : /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: NOTE, children: t("code.window", { from: window.from, to: window.to, total: lines.length }) }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: CODE, children: lines.slice(window.from - 1, window.to).map((text, offset) => {
          const number = window.from + offset;
          return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: number === current ? LINE_CURRENT : LINE, children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: LINE_NUMBER, children: String(number) }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: text === "" ? " " : text })
          ] }, number);
        }) })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: HEADING, children: t("section.trace") }),
      trace.length === 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: NOTE, children: t("trace.empty") }) : [...trace].reverse().map((entry) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: ROW, children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: MUTED, children: entry.line === null ? t("trace.noLine") : t("trace.line", { line: entry.line }) }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: entry.member }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: t(CALL_KEYS[entry.state]) }),
        entry.ms === void 0 ? null : /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: MUTED, children: t("trace.duration", { ms: entry.ms }) }),
        entry.synthetic === true ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: MUTED, children: t("trace.synthetic") }) : null,
        entry.preview === void 0 ? null : /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: PREVIEW, children: entry.preview })
      ] }, entry.seq)),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: HEADING, children: t("section.reports") }),
      reports.length === 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: NOTE, children: t("reports.empty") }) : reports.map((entry) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: REPORT, children: entry.text }, entry.seq))
    ] })
  ] });
}

// client/index.tsx
var POLL_MS = 1e3;
var inject = ["slots", "locale"];
function describe2(error) {
  return error instanceof Error ? error.message : String(error);
}
function headerUnchanged(left, right) {
  if (left === null || right === null) return left === right;
  return left.runId === right.runId && left.status === right.status && left.endedAt === right.endedAt && left.detail === right.detail && left.discarded === right.discarded;
}
function createRunSource(options) {
  let snapshot = { run: null, entries: [] };
  let cursor = 0;
  let timer;
  let queue = Promise.resolve();
  const listeners = /* @__PURE__ */ new Set();
  const publish = (next) => {
    snapshot = next;
    for (const listener of listeners) listener();
  };
  const apply2 = (delta) => {
    const known = snapshot.run?.runId ?? null;
    const next = delta.run?.runId ?? null;
    if (known !== null && known !== next) {
      publish({ run: delta.run, entries: [] });
      cursor = 0;
      void poll();
      return;
    }
    const run = headerUnchanged(snapshot.run, delta.run) ? snapshot.run : delta.run;
    const entries = delta.reset ? [...delta.entries] : delta.entries.length === 0 ? snapshot.entries : [...snapshot.entries, ...delta.entries];
    cursor = delta.revision;
    if (run === snapshot.run && entries === snapshot.entries) return;
    publish({ run, entries });
  };
  const poll = () => {
    queue = queue.then(async () => {
      const delta = await options.load(cursor).catch(() => void 0);
      if (delta !== void 0) apply2(delta);
    });
    return queue;
  };
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      if (timer === void 0) {
        void poll();
        timer = setInterval(() => {
          void poll();
        }, options.pollMs);
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && timer !== void 0) {
          clearInterval(timer);
          timer = void 0;
        }
      };
    }
  };
}
function apply(ctx) {
  const sources = /* @__PURE__ */ new Map();
  const loadState = async (sessionId, since) => {
    const response = await fetch(`${STATE_PATH}?sessionId=${encodeURIComponent(sessionId)}&since=${String(since)}`);
    if (!response.ok) throw new Error(`execution-engine: state read failed with ${String(response.status)}`);
    return await response.json();
  };
  const cancelRun = async (sessionId) => {
    try {
      const response = await fetch(`${CANCEL_PATH}?sessionId=${encodeURIComponent(sessionId)}`, { method: "POST" });
      return response.ok ? { ok: true } : { ok: false, reason: `HTTP ${String(response.status)}` };
    } catch (error) {
      return { ok: false, reason: describe2(error) };
    }
  };
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), "execution-engine: dictionaries");
  const t = ctx.locale.bind(NS);
  ctx.slots.inject("conversation.view", () => ctx.slots.register({
    name: "conversation.view",
    id: "execution-engine",
    order: 30,
    locale: NS,
    label: () => t("view.panel"),
    inject: (sessionId) => {
      const existing = sources.get(sessionId);
      const source = existing ?? createRunSource({
        load: (since) => loadState(sessionId, since),
        pollMs: POLL_MS
      });
      if (existing === void 0) sources.set(sessionId, source);
      return { hooks: { run: source }, cancel: () => cancelRun(sessionId) };
    }
  }, ExecutionEnginePanel));
}

return module.exports; } });

