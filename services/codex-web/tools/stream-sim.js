#!/usr/bin/env node
/**
 * 新版前端（public/app.js + public/markdown.js）的逻辑级回归测试。
 *
 * 不碰浏览器：用一个最小 DOM 桩把 app.js / markdown.js 原样加载进来跑，
 * 用可控 SSE 流喂事件，断言只看 DOM（class / textContent / dataset）。
 *
 * 覆盖：文本流、推理块、工具卡、工具分组、计划、diff、代码块、中断、
 *       断线重连、模型菜单、会话列表。
 *
 * 用法: node tools/stream-sim.js
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = join(dirname(fileURLToPath(import.meta.url)), "..");
const INDEX_HTML = readFileSync(join(HERE, "public", "index.html"), "utf8");
const APP_JS = readFileSync(join(HERE, "public", "app.js"), "utf8");
const MD_JS = readFileSync(join(HERE, "public", "markdown.js"), "utf8");

// ============================================================ 最小 DOM 桩
const VOID_TAGS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "param", "source", "track", "wbr"]);

const splitClasses = (s) => String(s || "").split(/\s+/).filter(Boolean);
const dashCase = (k) => String(k).replace(/[A-Z]/g, (c) => "-" + c.toLowerCase());
const camelCase = (k) => String(k).replace(/-([a-z])/g, (_, c) => c.toUpperCase());

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0" };
function decodeEntities(s) {
  return String(s).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (m, ent) => {
    if (ent[0] === "#") {
      const code = ent[1] === "x" || ent[1] === "X"
        ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      if (!isFinite(code) || code < 0) return m;
      try { return String.fromCodePoint(code); } catch { return m; }
    }
    return Object.prototype.hasOwnProperty.call(ENTITIES, ent) ? ENTITIES[ent] : m;
  });
}

const escapeText = (s) => String(s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escapeAttr = (s) => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;");

function makeStyle() {
  return {
    setProperty(name, value) { this[name] = String(value); },
    getPropertyValue(name) { return this[name] == null ? "" : String(this[name]); },
    removeProperty(name) { delete this[name]; },
  };
}

let EL_SEQ = 0;

class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.uid = ++EL_SEQ;
    this.attrs = Object.create(null);
    this.children = [];
    this.parentNode = null;
    this.style = makeStyle();
    this.listeners = Object.create(null);
    this.scrollTop = 0;
    this.scrollHeight = 800;
    this.clientHeight = 600;
    this.offsetHeight = 240;
    this.offsetWidth = 300;
    this.disabled = false;
    this.value = "";
    this.title = "";
    this.type = "";
    this.id = "";
    this._text = null;

    const self = this;
    this.classList = {
      add(...names) {
        const cur = splitClasses(self.attrs.class);
        for (const n of names) if (n && !cur.includes(n)) cur.push(n);
        self.attrs.class = cur.join(" ");
      },
      remove(...names) {
        const cur = splitClasses(self.attrs.class).filter((x) => !names.includes(x));
        if (cur.length) self.attrs.class = cur.join(" ");
        else delete self.attrs.class;
      },
      contains(name) { return splitClasses(self.attrs.class).includes(name); },
      toggle(name, force) {
        const want = force === undefined ? !this.contains(name) : !!force;
        if (want) this.add(name); else this.remove(name);
        return want;
      },
      get length() { return splitClasses(self.attrs.class).length; },
    };

    this.dataset = new Proxy({}, {
      get: (_, key) => (typeof key === "string"
        ? (self.attrs["data-" + dashCase(key)] === undefined ? undefined : self.attrs["data-" + dashCase(key)])
        : undefined),
      set: (_, key, value) => { self.attrs["data-" + dashCase(String(key))] = String(value); return true; },
      deleteProperty: (_, key) => { delete self.attrs["data-" + dashCase(String(key))]; return true; },
      has: (_, key) => ("data-" + dashCase(String(key))) in self.attrs,
      ownKeys: () => Object.keys(self.attrs)
        .filter((k) => k.startsWith("data-"))
        .map((k) => camelCase(k.slice(5))),
      getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
    });
  }

  get className() { return this.attrs.class || ""; }
  set className(v) {
    const s = String(v == null ? "" : v).trim();
    if (s) this.attrs.class = s; else delete this.attrs.class;
  }

  getAttribute(name) {
    const k = String(name).toLowerCase();
    return k in this.attrs ? this.attrs[k] : null;
  }
  setAttribute(name, value) { this.attrs[String(name).toLowerCase()] = String(value); }
  removeAttribute(name) { delete this.attrs[String(name).toLowerCase()]; }
  hasAttribute(name) { return String(name).toLowerCase() in this.attrs; }

  get textContent() {
    if (this._text !== null) return this._text;
    return this.children.map((c) => c.textContent).join("");
  }
  set textContent(v) {
    this._text = v == null ? "" : String(v);
    this.children = [];
  }

  get innerHTML() { return this.children.map((c) => c.serialize()).join(""); }
  set innerHTML(v) {
    this.children = [];
    this._text = null;
    parseHtml(String(v == null ? "" : v), this);
  }
  get outerHTML() { return this.serialize(); }

  serialize() {
    if (this.tagName === "#TEXT") return escapeText(this._text || "");
    const tag = this.tagName.toLowerCase();
    let out = "<" + tag;
    for (const k of Object.keys(this.attrs)) out += " " + k + '="' + escapeAttr(this.attrs[k]) + '"';
    out += ">";
    if (VOID_TAGS.has(tag)) return out;
    out += this.children.map((c) => c.serialize()).join("");
    return out + "</" + tag + ">";
  }

  appendChild(node) {
    if (!node) return node;
    if (node.parentNode) node.parentNode.removeChild(node);
    node.parentNode = this;
    this.children.push(node);
    this._text = null;
    return node;
  }
  insertBefore(node, ref) {
    if (!ref) return this.appendChild(node);
    if (node.parentNode) node.parentNode.removeChild(node);
    const i = this.children.indexOf(ref);
    if (i < 0) return this.appendChild(node);
    node.parentNode = this;
    this.children.splice(i, 0, node);
    this._text = null;
    return node;
  }
  removeChild(node) {
    const i = this.children.indexOf(node);
    if (i >= 0) this.children.splice(i, 1);
    if (node) node.parentNode = null;
    return node;
  }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }

  contains(node) {
    let n = node;
    while (n) { if (n === this) return true; n = n.parentNode; }
    return false;
  }

  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  removeEventListener(type, fn) {
    const list = this.listeners[type];
    if (!list) return;
    const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  }
  fire(type, extra) {
    const e = Object.assign({
      type,
      target: this,
      currentTarget: this,
      defaultPrevented: false,
      propagationStopped: false,
      isComposing: false,
      shiftKey: false,
      ctrlKey: false,
      metaKey: false,
      key: "",
    }, extra || {});
    e.preventDefault = () => { e.defaultPrevented = true; };
    e.stopPropagation = () => { e.propagationStopped = true; };

    let node = this;
    while (node) {
      const list = node.listeners && node.listeners[type];
      if (list) for (const fn of list.slice()) fn(e);
      if (e.propagationStopped) return e;
      node = node.parentNode;
    }
    const docList = docListeners[type];
    if (docList) for (const fn of docList.slice()) fn(e);
    return e;
  }

  getBoundingClientRect() {
    return { left: 24, top: 560, right: 144, bottom: 584, width: 120, height: 24, x: 24, y: 560 };
  }
  focus() {}
  blur() {}
  select() {}
  scrollIntoView() {}
  click() { return this.fire("click"); }
  setSelectionRange() {}
  getContext() { return null; }

  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  querySelectorAll(sel) {
    const parts = parseSelector(sel);
    const out = [];
    const seen = new Set();
    const collect = (node, idx) => {
      for (const child of node.children) {
        if (child.tagName === "#TEXT") continue;
        if (matchesSimple(child, parts[idx])) {
          if (idx + 1 === parts.length) {
            if (!seen.has(child)) { seen.add(child); out.push(child); }
          } else {
            collect(child, idx + 1);
          }
        }
        collect(child, idx);
      }
    };
    collect(this, 0);
    return out;
  }
  matches(sel) {
    const parts = parseSelector(sel);
    return matchesSimple(this, parts[parts.length - 1]);
  }
  closest(sel) {
    const parts = parseSelector(sel);
    const target = parts[parts.length - 1];
    let n = this;
    while (n && n.tagName !== "#TEXT") {
      if (matchesSimple(n, target)) return n;
      n = n.parentNode;
    }
    return null;
  }
}

// ------------------------------------------------------------ 选择器解析
function parseSelector(sel) {
  const text = String(sel).trim();
  if (!text) return [{ tag: null, classes: [], attrs: [] }];
  return text.split(/\s+/).map((chunk) => {
    const simple = { tag: null, classes: [], attrs: [] };
    let rest = chunk;
    const tm = /^([a-zA-Z][\w-]*|\*)/.exec(rest);
    if (tm) { simple.tag = tm[1].toLowerCase(); rest = rest.slice(tm[0].length); }
    const re = /(?:\.([\w-]+))|\[([\w-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]]*)))?\]/g;
    let m;
    while ((m = re.exec(rest))) {
      if (m[1]) simple.classes.push(m[1]);
      else {
        const value = m[3] !== undefined ? m[3] : m[4] !== undefined ? m[4] : m[5];
        simple.attrs.push({ name: m[2].toLowerCase(), value: value === undefined ? null : value });
      }
    }
    return simple;
  });
}

function matchesSimple(el, simple) {
  if (!el || el.tagName === "#TEXT") return false;
  if (simple.tag && simple.tag !== "*" && el.tagName.toLowerCase() !== simple.tag) return false;
  if (simple.classes.length) {
    const cls = splitClasses(el.attrs.class);
    for (const c of simple.classes) if (!cls.includes(c)) return false;
  }
  for (const a of simple.attrs) {
    const v = el.attrs[a.name];
    if (v === undefined) return false;
    if (a.value !== null && v !== a.value) return false;
  }
  return true;
}

// ------------------------------------------------------------ HTML 解析
function parseHtml(src, root) {
  const stack = [root];
  let i = 0;
  const n = src.length;
  const pushText = (text) => {
    if (!text) return;
    const node = new El("#text");
    node._text = decodeEntities(text);
    stack[stack.length - 1].appendChild(node);
  };

  while (i < n) {
    const lt = src.indexOf("<", i);
    if (lt < 0) { pushText(src.slice(i)); break; }
    if (lt > i) pushText(src.slice(i, lt));

    if (src.startsWith("<!--", lt)) {
      const end = src.indexOf("-->", lt + 4);
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (src[lt + 1] === "!" || src[lt + 1] === "?") {
      const end = src.indexOf(">", lt);
      i = end < 0 ? n : end + 1;
      continue;
    }
    if (src[lt + 1] === "/") {
      const end = src.indexOf(">", lt);
      const name = src.slice(lt + 2, end < 0 ? n : end).trim().toLowerCase();
      for (let k = stack.length - 1; k >= 1; k--) {
        if (stack[k].tagName.toLowerCase() === name) { stack.length = k; break; }
      }
      i = end < 0 ? n : end + 1;
      continue;
    }

    let j = lt + 1;
    let name = "";
    while (j < n && /[a-zA-Z0-9:_-]/.test(src[j])) { name += src[j]; j++; }
    if (!name) { pushText("<"); i = lt + 1; continue; }

    const attrs = Object.create(null);
    let selfClose = false;
    for (;;) {
      while (j < n && /\s/.test(src[j])) j++;
      if (j >= n) break;
      if (src[j] === ">") { j++; break; }
      if (src[j] === "/" && src[j + 1] === ">") { selfClose = true; j += 2; break; }
      let an = "";
      while (j < n && !/[\s=>]/.test(src[j]) && !(src[j] === "/" && src[j + 1] === ">")) {
        an += src[j]; j++;
      }
      if (!an) { j++; continue; }
      while (j < n && /\s/.test(src[j])) j++;
      let av = "";
      if (src[j] === "=") {
        j++;
        while (j < n && /\s/.test(src[j])) j++;
        const q = src[j];
        if (q === '"' || q === "'") {
          j++;
          const end = src.indexOf(q, j);
          av = src.slice(j, end < 0 ? n : end);
          j = end < 0 ? n : end + 1;
        } else {
          while (j < n && !/[\s>]/.test(src[j])) { av += src[j]; j++; }
        }
      }
      attrs[an.toLowerCase()] = decodeEntities(av);
    }

    const node = new El(name);
    for (const k of Object.keys(attrs)) node.attrs[k] = attrs[k];
    stack[stack.length - 1].appendChild(node);
    if (!selfClose && !VOID_TAGS.has(name.toLowerCase())) stack.push(node);
    i = j;
  }
}

// ------------------------------------------------------------ document / window
const byId = Object.create(null);
const docListeners = Object.create(null);
const docRoot = new El("html");
const bodyEl = new El("body");

const documentStub = {
  getElementById: (id) => byId[id] || null,
  createElement: (tag) => new El(tag),
  createTextNode: (text) => {
    const node = new El("#text");
    node._text = text == null ? "" : String(text);
    return node;
  },
  createDocumentFragment: () => new El("#fragment"),
  documentElement: docRoot,
  body: bodyEl,
  head: new El("head"),
  execCommand: () => false,
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener: (type, fn) => { (docListeners[type] ||= []).push(fn); },
  removeEventListener: (type, fn) => {
    const list = docListeners[type];
    if (!list) return;
    const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  },
  dispatchEvent: () => true,
  visibilityState: "visible",
  hidden: false,
};

// 骨架里所有 id 直接从 index.html 抠，桩永远不会跟骨架脱节。
for (const m of INDEX_HTML.matchAll(/\bid="([^"]+)"/g)) {
  const el = new El("div");
  el.id = m[1];
  byId[m[1]] = el;
}

// ------------------------------------------------------------ rAF / 定时器
const rafQueue = new Map();
let rafSeq = 0;
const rafStub = (cb) => { const id = ++rafSeq; rafQueue.set(id, cb); return id; };
const cafStub = (id) => { rafQueue.delete(id); };
function flushFrames() {
  let guard = 0;
  while (rafQueue.size && guard++ < 500) {
    const batch = [...rafQueue.entries()];
    rafQueue.clear();
    for (const [, cb] of batch) {
      try { cb(Date.now()); } catch (err) { console.log("  ! rAF 回调抛错: " + err.message); }
    }
  }
}

const intervals = new Set();
const setIntervalStub = (fn, ms) => {
  const id = setInterval(fn, ms);
  intervals.add(id);
  return id;
};
const clearIntervalStub = (id) => { intervals.delete(id); clearInterval(id); };

// ------------------------------------------------------------ localStorage / navigator
const store = new Map([["codex-web-token", "sim-token"]]);
const localStorageStub = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); },
  clear: () => store.clear(),
  key: (i) => [...store.keys()][i] ?? null,
  get length() { return store.size; },
};

const navigatorStub = {
  userAgent: "stream-sim",
  clipboard: { writeText: async () => {} },
};

const locationStub = {
  href: "http://127.0.0.1:3081/",
  origin: "http://127.0.0.1:3081",
  protocol: "http:",
  host: "127.0.0.1:3081",
  hostname: "127.0.0.1",
  port: "3081",
  pathname: "/",
  search: "",
  hash: "",
  reload() {},
  assign() {},
  replace() {},
};

const windowStub = {
  fetch: null,               // 下面赋 fakeFetch
  matchMedia: (q) => ({
    matches: false, media: q,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
  }),
  visualViewport: {
    width: 390, height: 780, offsetTop: 0, offsetLeft: 0, scale: 1,
    addEventListener() {}, removeEventListener() {},
  },
  innerWidth: 390,
  innerHeight: 780,
  devicePixelRatio: 2,
  addEventListener() {},
  removeEventListener() {},
  history: { replaceState() {}, pushState() {}, back() {} },
  requestAnimationFrame: rafStub,
  cancelAnimationFrame: cafStub,
  setTimeout,
  clearTimeout,
  setInterval: setIntervalStub,
  clearInterval: clearIntervalStub,
};

// ============================================================ 假服务端
const fetchCalls = [];
let chatStream = null;
let attachStream = null;
let steerFail = false;

const FAKE_HOME = "/data/data/com.termux/files/home";
const FAKE_CWD = FAKE_HOME + "/codex-web";

const MODELS_FIXTURE = [
  {
    id: "gpt-6.1-sol", model: "gpt-6.1-sol", displayName: "GPT-6.1-Sol",
    description: "Latest workhorse model for coding and everyday work.",
    isDefault: true, defaultEffort: "medium",
    efforts: [
      { id: "low", description: "Fast responses with lighter reasoning" },
      { id: "medium", description: "Balances speed and reasoning depth" },
      { id: "high", description: "Greater reasoning depth" },
    ],
  },
  {
    id: "gpt-6.1-mini", model: "gpt-6.1-mini", displayName: "GPT-6.1-Mini",
    description: "Smaller and faster.",
    isDefault: false, defaultEffort: "low",
    efforts: [
      { id: "low", description: "Quick" },
      { id: "medium", description: "Balanced" },
      { id: "high", description: "Deeper" },
    ],
  },
  {
    id: "gpt-5.5", model: "gpt-5.5", displayName: "GPT-5.5",
    description: "Previous generation.",
    isDefault: false, defaultEffort: "medium",
    efforts: [
      { id: "low", description: "Quick" },
      { id: "medium", description: "Balanced" },
    ],
  },
];

// /api/diff/full 返回的真实形状 diff（含 hunk 头，用来验证行号解析与幽灵行）
const DIFF_FIXTURE = [
  "diff --git a/tools/md2txt.mjs b/tools/md2txt.mjs",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/tools/md2txt.mjs",
  "@@ -0,0 +1,4 @@",
  "+import { readFileSync } from \"node:fs\";",
  "+const src = readFileSync(process.argv[2], \"utf8\");",
  "+console.log(src);",
  "",
].join("\n");

const NOW_SEC = Math.floor(Date.now() / 1000);
let threadFixtures = [
  // 侧栏按工作区分组，给 fixture 补 cwd（没有 cwd 的会落到"未指定目录"）
  { id: "T-OLD", title: "上次聊的那个脚本", updatedAt: NOW_SEC - 300, model: "gpt-6.1-sol", cwd: "/home/u/codex-web" },
  { id: "T-OLDER", title: "修一个 bug", updatedAt: NOW_SEC - 900, model: "gpt-6.1-sol", cwd: "/home/u/codex-web" },
  { id: "T-OLDEST", title: "读一下 README", updatedAt: NOW_SEC - 1500, model: "gpt-5.5" },
];

let historyFixture = {
  threadId: "T-OLD",
  cwd: FAKE_CWD,
  mode: "danger-full-access",
  tokens: 1200,
  model: "gpt-6.1-sol",
  effort: "medium",
  messages: [],
};

const jsonRes = (data, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => data,
  text: async () => JSON.stringify(data),
  headers: new Map(),
});

const streamRes = (stream, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  body: { getReader: () => stream.reader() },
  json: async () => ({}),
  text: async () => "",
  headers: new Map(),
});

async function fakeFetch(input, init = {}) {
  const url = String(typeof input === "string" ? input : input && input.url);
  let body = null;
  if (init && typeof init.body === "string") {
    try { body = JSON.parse(init.body); } catch { body = init.body; }
  }
  fetchCalls.push({ url, method: (init && init.method) || "GET", body });

  if (url.indexOf("/api/config") >= 0) {
    return jsonRes({
      home: FAKE_HOME,
      defaultMode: "danger-full-access",
      sandboxAvailable: false,
      sandboxReason: "Android 10 没有 bubblewrap / user namespace / Landlock",
      modes: [
        { id: "read-only", label: "只读", short: "只读", desc: "只读，不修改任何文件", available: false },
        { id: "workspace-write", label: "可写工作区", short: "可写", desc: "可修改工作目录内文件，不联网", available: false },
        { id: "danger-full-access", label: "全权限", short: "全权限", desc: "全权限，可改系统文件、联网", available: true },
      ],
    });
  }
  if (url.indexOf("/api/models") >= 0) return jsonRes({ models: MODELS_FIXTURE });
  if (url.indexOf("/api/threads") >= 0) return jsonRes({ threads: threadFixtures });
  if (url.indexOf("/api/thread/history") >= 0) return jsonRes(historyFixture);
  if (url.indexOf("/api/active") >= 0) return jsonRes({ active: [] });
  if (url.indexOf("/api/version") >= 0) return jsonRes({ build: "sim-build" });
  if (url.indexOf("/api/interrupt") >= 0) return jsonRes({ ok: true });
  if (url.indexOf("/api/diff/full") >= 0) return jsonRes({ diff: DIFF_FIXTURE });
  if (url.indexOf("/api/diff") >= 0) {
    return jsonRes({ isRepo: true, fileCount: 1, insertions: 2, deletions: 1 });
  }
  if (url.indexOf("/api/steer") >= 0) {
    if (steerFail) return jsonRes({ error: "这一轮已经结束了" }, 409);
    return jsonRes({ ok: true });
  }
  if (url.indexOf("/api/dirs") >= 0) {
    return jsonRes({ path: FAKE_HOME, parent: null, home: FAKE_HOME, dirs: [] });
  }
  if (url.indexOf("/api/attach") >= 0) {
    if (!attachStream) return jsonRes({ error: "这一轮已经不在了" }, 404);
    return streamRes(attachStream);
  }
  if (url.indexOf("/api/chat") >= 0) {
    if (!chatStream) return jsonRes({ error: "没有流" }, 500);
    return streamRes(chatStream);
  }
  return jsonRes({});
}
windowStub.fetch = fakeFetch;

// ============================================================ 加载前端代码
new Function("window", "btoa", "TextEncoder", MD_JS)(windowStub, btoa, TextEncoder);

const appFactory = new Function(
  "document", "window", "location", "localStorage", "navigator",
  "requestAnimationFrame", "cancelAnimationFrame",
  "fetch", "AbortController", "TextDecoder", "TextEncoder",
  "setTimeout", "clearTimeout", "setInterval", "clearInterval",
  "console", "Headers", "URL", "atob", "btoa",
  APP_JS,
);
appFactory(
  documentStub, windowStub, locationStub, localStorageStub, navigatorStub,
  rafStub, cafStub,
  fakeFetch, AbortController, TextDecoder, TextEncoder,
  setTimeout, clearTimeout, setIntervalStub, clearIntervalStub,
  console, Headers, URL, atob, btoa,
);

// 骨架里 hero 在 thread 里；桩里手工接上。
const threadEl = byId.thread;
const heroEl = byId.hero;
threadEl.appendChild(heroEl);

// ============================================================ 流 / 工具
function makeStream() {
  const enc = new TextEncoder();
  const queue = [];
  const waiters = [];
  let closed = false;
  let failed = null;

  const deliver = (item) => {
    const w = waiters.shift();
    if (w) w.resolve(item);
    else queue.push(item);
  };

  return {
    push(chunk) { deliver({ done: false, value: enc.encode(String(chunk)) }); },
    fail(message = "Failed to fetch") {
      failed = message;
      const w = waiters.shift();
      if (w) w.reject(new TypeError(message));
    },
    end() { closed = true; deliver({ done: true, value: undefined }); },
    reader() {
      return {
        read() {
          if (queue.length) return Promise.resolve(queue.shift());
          if (failed) return Promise.reject(new TypeError(failed));
          if (closed) return Promise.resolve({ done: true, value: undefined });
          return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
        },
        cancel() { return Promise.resolve(); },
        releaseLock() {},
      };
    },
  };
}

const sse = (event, data, id) =>
  (id === undefined ? "" : "id: " + id + "\n")
  + "event: " + event + "\n"
  + "data: " + JSON.stringify(data === undefined ? {} : data) + "\n\n";

async function settle(rounds = 60) {
  for (let i = 0; i < rounds; i++) {
    await new Promise((resolve) => setImmediate(resolve));
    flushFrames();
  }
}

async function wait(ms) {
  const started = Date.now();
  while (Date.now() - started < ms) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    flushFrames();
  }
}

function clearThread() {
  threadEl.children.length = 0;
  heroEl.classList.remove("gone");
  threadEl.appendChild(heroEl);
}

function lastTurn() {
  const turns = threadEl.querySelectorAll(".msg.assistant");
  return turns[turns.length - 1] || null;
}

async function startTurn(text = "你好") {
  clearThread();
  chatStream = makeStream();
  attachStream = null;
  fetchCalls.length = 0;
  byId.input.value = text;
  byId.send.fire("click");
  await settle(6);
}

// ============================================================ 断言
let passes = 0;
let failures = 0;
const failed = [];

function check(label, cond, detail) {
  if (cond) {
    passes++;
    console.log("  \u2713 " + label);
  } else {
    failures++;
    failed.push(label);
    const extra = detail === undefined ? "" : "  \u2192 " + String(detail).replace(/\s+/g, " ").slice(0, 220);
    console.log("  \u2717 " + label + extra);
  }
}

const section = (title) => console.log("\n" + title);
const textOf = (node) => (node ? node.textContent : "<null>");

// ============================================================ 场景
async function main() {
  await settle(60);   // 启动：loadConfig / loadModels / loadThreads / syncBuild / resumeIfGenerating

  // ---------------------------------------------------------------- a
  section("[a] 纯文本流式：多 delta 拼接 / caret / 按钮复位");
  {
    await startTurn("你好");
    const s = chatStream;
    s.push(sse("status", { state: "starting" }, 1));
    s.push(sse("thread", { threadId: "T-TEXT" }, 2));
    s.push(sse("status", { state: "ready" }, 3));
    s.push(sse("delta", { text: "你好" }, 4));
    await settle(8);
    s.push(sse("delta", { text: "，我是" }, 5));
    s.push(sse("delta", { text: " Codex。" }, 6));
    await settle(8);

    const mdEl = lastTurn() && lastTurn().querySelectorAll(".md")[0];
    check("流式期间生成了 .md", !!mdEl);
    check("流式期间有 .stream-caret", !!mdEl && mdEl.querySelectorAll(".stream-caret").length === 1,
      mdEl && mdEl.innerHTML);
    check("多个 delta 拼接正确", textOf(mdEl) === "你好，我是 Codex。", textOf(mdEl));
    check("流式期间按钮 data-state=busy", byId.send.dataset.state === "busy", byId.send.dataset.state);

    s.push(sse("done", { reason: "completed", text: "你好，我是 Codex。" }, 7));
    s.end();
    await settle(40);

    const mdDone = lastTurn().querySelectorAll(".md")[0];
    check("结束后 .md 里没有 .stream-caret", mdDone.querySelectorAll(".stream-caret").length === 0,
      mdDone.innerHTML);
    check("结束后 .md 去掉 data-stream", mdDone.getAttribute("data-stream") === null,
      mdDone.getAttribute("data-stream"));
    check("结束后正文完整", textOf(mdDone) === "你好，我是 Codex。", textOf(mdDone));
    check("按钮回到 data-state=idle", byId.send.dataset.state === "idle", byId.send.dataset.state);
    check("活动行已清空", byId["activity-text"].textContent === "", byId["activity-text"].textContent);
  }

  // ---------------------------------------------------------------- b
  section("[b] 推理：.think / shimmer / reasoning_done");
  {
    await startTurn("想个方案");
    chatStream.push(sse("thread", { threadId: "T-REASON" }, 1));
    chatStream.push(sse("reasoning", { kind: "summary", text: "先看目录结构。" }, 2));
    await settle(8);

    const turn = lastTurn();
    const think = turn && turn.querySelectorAll(".think")[0];
    check("收到 reasoning 后出现 .think", !!think);
    check("推理中 .think[data-state=run]", !!think && think.dataset.state === "run",
      think && think.dataset.state);
    const label = think && think.querySelectorAll(".think-label")[0];
    check(".think-label 带 shimmer", !!label && label.classList.contains("shimmer"),
      label && label.className);
    check("推理正文进入 .think-body",
      !!think && textOf(think.querySelectorAll(".think-body")[0]).includes("先看目录结构"),
      think && textOf(think.querySelectorAll(".think-body")[0]));

    chatStream.push(sse("reasoning_done", {}, 3));
    await settle(8);
    check("reasoning_done 后 data-state=done", think.dataset.state === "done", think.dataset.state);
    check("label 变成「已思考 N 秒」", /^已思考 \d+ 秒$/.test(label.textContent), label.textContent);
    check("结束后 shimmer 已移除", !label.classList.contains("shimmer"), label.className);

    chatStream.push(sse("delta", { text: "方案如下。" }, 4));
    chatStream.push(sse("done", { reason: "completed", text: "方案如下。" }, 5));
    chatStream.end();
    await settle(30);
  }

  // ---------------------------------------------------------------- c
  section("[c] 工具卡：run → 自动展开 → tool_delta → tool_result 折叠 + 时长");
  {
    await startTurn("跑测试");
    chatStream.push(sse("tool", { id: "c1", name: "shell", input: { command: "npm test" } }, 1));
    await settle(8);

    const turn = lastTurn();
    const card = turn && turn.querySelectorAll(".tool-card")[0];
    check("建卡后 data-state=run", !!card && card.dataset.state === "run", card && card.dataset.state);
    check("运行中自动展开（.open）", !!card && card.classList.contains("open"), card && card.className);
    const title = card && card.querySelectorAll(".tool-title")[0];
    check("标题语义化「正在运行 npm test」",
      !!title && textOf(title).includes("正在运行") && textOf(title).includes("npm test"), textOf(title));
    check("运行中有 .spin-ring", !!card && card.querySelectorAll(".spin-ring").length === 1);

    chatStream.push(sse("tool_delta", { id: "c1", text: "PASS src/a.test.js\n" }, 2));
    await settle(8);
    const bodyEl2 = card.querySelectorAll(".tool-body")[0];
    check("tool_delta 进 .tool-body", textOf(bodyEl2).includes("PASS src/a.test.js"), textOf(bodyEl2));

    chatStream.push(sse("tool_delta", { id: "c1", text: "1 passed\n" }, 3));
    await settle(8);
    check("第二段增量也追加", textOf(bodyEl2).includes("1 passed"), textOf(bodyEl2));

    chatStream.push(sse("tool_result",
      { id: "c1", output: "PASS src/a.test.js\n1 passed\n", status: "completed", durationMs: 820 }, 4));
    await settle(8);
    check("完成后 data-state=ok", card.dataset.state === "ok", card.dataset.state);
    check("完成后自动折叠", !card.classList.contains("open"), card.className);
    check(".tool-meta 显示时长 820ms", textOf(card.querySelectorAll(".tool-meta")[0]) === "820ms",
      textOf(card.querySelectorAll(".tool-meta")[0]));
    check("完成后输出是权威全文",
      textOf(bodyEl2) === "PASS src/a.test.js\n1 passed\n", JSON.stringify(textOf(bodyEl2)));

    chatStream.push(sse("done", { reason: "completed", text: "跑完了。" }, 5));
    chatStream.end();
    await settle(30);
  }

  // ---------------------------------------------------------------- d
  section("[d] 多工具分组：一个 .tool-group + 组头文案");
  {
    await startTurn("三个操作");
    chatStream.push(sse("tool", { id: "a", name: "shell", input: { command: "echo one" } }, 1));
    chatStream.push(sse("tool", { id: "b", name: "apply_patch", input: { changes: ["src/a.js"] } }, 2));
    chatStream.push(sse("tool", { id: "c", name: "web_search", input: { query: "codex" } }, 3));
    await settle(10);

    const turn = lastTurn();
    const groups = turn.querySelectorAll(".tool-group");
    check("连续 3 个 tool 只有 1 个 .tool-group", groups.length === 1, groups.length);
    check("组里 3 张 .tool-card", groups[0] && groups[0].querySelectorAll(".tool-card").length === 3,
      groups[0] && groups[0].querySelectorAll(".tool-card").length);
    const head = groups[0] && groups[0].querySelectorAll(".tool-group-head")[0];
    check("组头文案「3 步 · 进行中」",
      !!head && textOf(head) === "3 步 · 进行中", textOf(head));
    check("组头有转圈", !!head && head.querySelectorAll(".spin-ring").length === 1);

    chatStream.push(sse("tool_result", { id: "a", output: "one", status: "completed", durationMs: 12 }, 4));
    chatStream.push(sse("tool_result", { id: "b", output: "applied", status: "completed", durationMs: 30 }, 5));
    chatStream.push(sse("tool_result", { id: "c", output: "3 results", status: "completed", durationMs: 90 }, 6));
    await settle(10);
    check("全部完成后组头「3 步 · 已完成」",
      textOf(head) === "3 步 · 已完成", textOf(head));
    check("组头转圈已消失", head.querySelectorAll(".spin-ring").length === 0);
    const cards = groups[0].querySelectorAll(".tool-card");
    check("三张卡都是 ok", cards.length === 3 && cards.every((c) => c.dataset.state === "ok"),
      cards.map((c) => c.dataset.state).join(","));

    chatStream.push(sse("done", { reason: "completed" }, 7));
    chatStream.end();
    await settle(30);
  }

  // ---------------------------------------------------------------- e
  section("[e] 计划卡：条目数 + status → data-state");
  {
    await startTurn("给个计划");
    chatStream.push(sse("plan", {
      items: [
        { step: "读项目结构", status: "completed" },
        { step: "实现脚本", status: "inProgress" },
        { step: "跑自测", status: "pending" },
      ],
      explanation: "先读结构再动手。",
    }, 1));
    await settle(8);

    const turn = lastTurn();
    const plan = turn && turn.querySelectorAll(".plan-card")[0];
    check("渲染出 .plan-card", !!plan);
    const steps = plan ? plan.querySelectorAll(".plan-step") : [];
    check("条目数 = 3", steps.length === 3, steps.length);
    check("status 映射到 data-state",
      steps.map((s) => s.dataset.state).join(",") === "completed,inProgress,pending",
      steps.map((s) => s.dataset.state).join(","));
    check("说明文字渲染", !!plan && textOf(plan).includes("先读结构再动手"), plan && textOf(plan));
    check("已完成条目有对勾图标", steps[0] && !!steps[0].querySelectorAll(".plan-mark svg").length,
      steps[0] && steps[0].className);

    chatStream.push(sse("done", { reason: "completed" }, 2));
    chatStream.end();
    await settle(30);
  }

  // ---------------------------------------------------------------- f
  section("[f] diff 卡：+/- 计数 + >30 行折叠按钮");
  {
    const diffText = [
      "diff --git a/src/app.js b/src/app.js",
      "index 1111111..2222222 100644",
      "--- a/src/app.js",
      "+++ b/src/app.js",
      "@@ -1,4 +1,6 @@",
      " const a = 1;",
      "-const old = true;",
      "-const gone = 1;",
      "-const bye = 2;",
      "+const added1 = 1;",
      "+const added2 = 2;",
      "+const added3 = 3;",
      "+const added4 = 4;",
      "+const added5 = 5;",
      ...Array.from({ length: 25 }, (_, i) => " ctx line " + (i + 1)),
    ].join("\n");

    await startTurn("改点东西");
    chatStream.push(sse("turn_diff", { diff: diffText }, 1));
    await settle(8);

    const turn = lastTurn();
    const card = turn && turn.querySelectorAll(".diff-card")[0];
    check("渲染出 .diff-card", !!card);
    check("+ 计数 = +5", !!card && textOf(card.querySelectorAll(".diff-add")[0]) === "+5",
      card && textOf(card.querySelectorAll(".diff-add")[0]));
    check("− 计数 = −3", !!card && textOf(card.querySelectorAll(".diff-del")[0]) === "−3",
      card && textOf(card.querySelectorAll(".diff-del")[0]));
    check("标题带文件名", !!card && textOf(card.querySelectorAll(".diff-title")[0]).includes("src/app.js"),
      card && textOf(card.querySelectorAll(".diff-title")[0]));
    const more = card && card.querySelectorAll(".diff-more")[0];
    check(">30 行出现「查看完整 diff」按钮", !!more && textOf(more).includes("查看完整 diff"), textOf(more));
    const lines = card.querySelectorAll(".diff-line");
    check("折叠后只渲染 30 行", lines.length === 30, lines.length);

    chatStream.push(sse("done", { reason: "completed" }, 2));
    chatStream.end();
    await settle(30);
  }

  // ---------------------------------------------------------------- g
  section("[g] 围栏代码块：.codeblock / .code-head / .code-copy + base64");
  {
    const FENCE = String.fromCharCode(96, 96, 96);
    const code = "const a = 1;\nconsole.log(a);";
    const payload = "先看代码：\n\n" + FENCE + "js\n" + code + "\n" + FENCE + "\n";

    await startTurn("写段代码");
    chatStream.push(sse("delta", { text: payload }, 1));
    chatStream.push(sse("done", { reason: "completed", text: payload }, 2));
    chatStream.end();
    await settle(40);

    const turn = lastTurn();
    const block = turn && turn.querySelectorAll(".codeblock")[0];
    check("渲染出 .codeblock", !!block);
    check("有 .code-head", !!block && block.querySelectorAll(".code-head").length === 1);
    check("语言标签是 js",
      !!block && textOf(block.querySelectorAll(".code-lang")[0]) === "js",
      block && textOf(block.querySelectorAll(".code-lang")[0]));
    const copy = block && block.querySelectorAll(".code-copy")[0];
    check("有 .code-copy", !!copy);
    const b64 = copy ? (copy.getAttribute("data-code") || "") : "";
    let decoded = "";
    try { decoded = Buffer.from(b64, "base64").toString("utf8"); } catch { decoded = ""; }
    check("data-code base64 能还原原文", decoded === code, JSON.stringify(decoded));
    check("代码正文也在 .code-body 里",
      !!block && textOf(block.querySelectorAll(".code-body")[0]).includes("console.log(a);"),
      block && textOf(block.querySelectorAll(".code-body")[0]));
  }

  // ---------------------------------------------------------------- h
  section("[h] 中断：点 #send → /api/interrupt → done{interrupted}");
  {
    await startTurn("跑个长任务");
    chatStream.push(sse("thread", { threadId: "T-INT" }, 1));
    chatStream.push(sse("tool", { id: "z", name: "shell", input: { command: "npm test" } }, 2));
    chatStream.push(sse("tool_delta", { id: "z", text: "running…\n" }, 3));
    await settle(10);

    const card = lastTurn().querySelectorAll(".tool-card")[0];
    check("中断前卡片在跑", card.dataset.state === "run", card.dataset.state);
    check("中断前按钮是 busy", byId.send.dataset.state === "busy", byId.send.dataset.state);

    byId.send.fire("click");            // 用户点停止
    await settle(10);
    const intCall = fetchCalls.find((c) => c.url.indexOf("/api/interrupt") >= 0);
    check("确实调了 /api/interrupt", !!intCall, fetchCalls.map((c) => c.url).join(" | "));
    check("带上正确的 threadId", !!intCall && intCall.body && intCall.body.threadId === "T-INT",
      intCall && JSON.stringify(intCall.body));

    chatStream.push(sse("done", { reason: "interrupted" }, 4));
    chatStream.end();
    await settle(40);

    check("卡片 data-state=stop", card.dataset.state === "stop", card.dataset.state);
    const notice = threadEl.querySelectorAll(".notice-box")[0];
    check("出现「已中断」提示", !!notice && textOf(notice).includes("已中断"), textOf(notice));
    check("按钮回到 idle", byId.send.dataset.state === "idle", byId.send.dataset.state);
  }

  // ---------------------------------------------------------------- i
  section("[i] 断线重连：流 reject → GET /api/attach?since=N → 补发接上");
  {
    await startTurn("跑 20 秒循环");
    chatStream.push(sse("thread", { threadId: "T-NET" }, 1));
    chatStream.push(sse("tool", { id: "n1", name: "shell", input: { command: "for i in 1 2 3; do echo tick$i; done" } }, 2));
    chatStream.push(sse("tool_delta", { id: "n1", text: "tick1\n" }, 3));
    await settle(10);

    const card = lastTurn().querySelectorAll(".tool-card")[0];
    check("断线前收到 tick1", textOf(card.querySelectorAll(".tool-body")[0]).includes("tick1"),
      textOf(card.querySelectorAll(".tool-body")[0]));

    attachStream = makeStream();     // 服务端那侧还在跑，重连能接上
    chatStream.fail("Failed to fetch");
    await settle(10);
    await wait(520);

    const attachCall = fetchCalls.find((c) => c.url.indexOf("/api/attach") >= 0);
    check("断线后自动请求 /api/attach", !!attachCall, fetchCalls.map((c) => c.url).join(" | "));
    check("带上了续传点 since=3", !!attachCall && /since=3(&|$)/.test(attachCall.url),
      attachCall && attachCall.url);
    check("带上了 threadId=T-NET", !!attachCall && attachCall.url.includes("threadId=T-NET"),
      attachCall && attachCall.url);

    attachStream.push(sse("tool_delta", { id: "n1", text: "tick2\n" }, 4));
    attachStream.push(sse("tool_result",
      { id: "n1", output: "tick1\ntick2\ntick3\n", status: "completed", durationMs: 1800 }, 5));
    attachStream.push(sse("done", { reason: "completed", text: "跑完了" }, 6));
    attachStream.end();
    await wait(200);
    await settle(40);

    check("补发的 tool_delta 接上了",
      textOf(card.querySelectorAll(".tool-body")[0]).includes("tick2"),
      textOf(card.querySelectorAll(".tool-body")[0]));
    check("卡片回到 ok", card.dataset.state === "ok", card.dataset.state);
    check("补发的 done 让正文出现", threadEl.textContent.includes("跑完了"));
    check("全程没有 .errbox", threadEl.querySelectorAll(".errbox").length === 0,
      threadEl.querySelectorAll(".errbox").map((e) => e.textContent).join(" | "));
    check("收尾后按钮复位 idle", byId.send.dataset.state === "idle", byId.send.dataset.state);
  }

  // ---------------------------------------------------------------- j
  section("[j] 模型菜单：菜单项数量 / 切换 / 推理强度 chip");
  {
    // pill 文案是「显示名 · 推理档」（Codex 把两者写在同一个 pill 上），
    // 所以这里比前缀而不是全等。
    check("启动后模型 pill 有默认模型名",
      byId["model-pill-label"].textContent.indexOf(MODELS_FIXTURE[0].displayName) === 0,
      byId["model-pill-label"].textContent);

    byId["model-pill"].fire("click");
    await settle(6);

    const menu = byId["model-menu"];
    const items = menu.querySelectorAll(".menu-item");
    check("#model-menu 弹出", menu.style.display === "block", menu.style.display);
    check("菜单项数量 = /api/models 返回数量（3）", items.length === MODELS_FIXTURE.length, items.length);
    check("菜单项文案是 displayName",
      items.map((i) => textOf(i.querySelectorAll(".mi-title")[0])).join("|")
        === MODELS_FIXTURE.map((m) => m.displayName).join("|"),
      items.map((i) => textOf(i.querySelectorAll(".mi-title")[0])).join("|"));

    items[1].fire("click");
    await settle(6);
    check("点第二项后 #model-pill-label 跟着变",
      byId["model-pill-label"].textContent.indexOf(MODELS_FIXTURE[1].displayName) === 0,
      byId["model-pill-label"].textContent);
    check("当前项有勾选标记",
      menu.querySelectorAll(".menu-item")[1].querySelectorAll(".mi-check").length === 1);

    const chips = menu.querySelectorAll(".effort-chip");
    check("推理强度 chip 数量 = 当前模型 efforts 数",
      chips.length === MODELS_FIXTURE[1].efforts.length, chips.length);

    const highChip = chips.find((c) => c.textContent === "高");
    check("存在「高」chip", !!highChip, chips.map((c) => c.textContent).join(","));
    highChip.fire("click");
    await settle(6);

    check("chip 点击后 #thread-sub 副行跟着变",
      byId["thread-sub"].textContent.includes("高") &&
        byId["thread-sub"].textContent.includes(MODELS_FIXTURE[1].displayName),
      byId["thread-sub"].textContent);
    check("#model-pill 的 title 是模型描述",
      byId["model-pill"].title === MODELS_FIXTURE[1].description,
      byId["model-pill"].title);
    check("当前 chip 有 on 样式",
      menu.querySelectorAll(".effort-chip.on").map((c) => c.textContent).join(",") === "高",
      menu.querySelectorAll(".effort-chip.on").map((c) => c.textContent).join(","));

    byId["model-pill"].fire("click");   // 收起
    await settle(4);
  }

  // ---------------------------------------------------------------- k
  section("[k] 会话列表：3 条 .sess + 分组标题 + 点击回填历史");
  {
    byId["rail-search"].fire("click");
    await settle(20);

    const list = byId["panel-list"];
    const sess = list.querySelectorAll(".sess");
    check("panel 打开", byId.panel.classList.contains("open"), byId.panel.className);
    check("#panel-list 里 3 个 .sess", sess.length === 3, sess.length);
    const groupHead = list.querySelectorAll(".panel-group-head")[0];
    // 分组键改成了工作区末段（Codex App 的侧栏就是按工作区分组的）。
    // fixture 里的 cwd 都在 /home/u，所以末段是 "u"。
    check("存在分组标题（按工作区）", !!groupHead && textOf(groupHead).includes("codex-web"), textOf(groupHead));
    check("第一条显示标题", textOf(sess[0]).includes("上次聊的那个脚本"), textOf(sess[0]));

    historyFixture = {
      threadId: "T-OLD",
      cwd: FAKE_CWD,
      mode: "danger-full-access",
      tokens: 1200,
      model: "gpt-6.1-sol",
      effort: "medium",
      messages: [
        { role: "user", text: "帮我看看这个脚本" },
        {
          role: "assistant",
          parts: [
            { type: "reasoning", text: "先看目录。" },
            { type: "tool", id: "h1", name: "shell", input: { command: "ls -la" },
              output: "a.js\nb.js", status: "completed", durationMs: 120 },
            { type: "text", text: "目录里有两个文件。" },
          ],
        },
      ],
    };

    fetchCalls.length = 0;
    sess[0].fire("click");
    await settle(40);

    const histCall = fetchCalls.find((c) => c.url.indexOf("/api/thread/history") >= 0);
    check("点会话触发 /api/thread/history", !!histCall, fetchCalls.map((c) => c.url).join(" | "));
    check("请求带上 threadId", !!histCall && histCall.body && histCall.body.threadId === "T-OLD",
      histCall && JSON.stringify(histCall.body));
    check("抽屉关上", !byId.panel.classList.contains("open"), byId.panel.className);
    check("标题栏跟着变", byId["thread-title"].textContent === "上次聊的那个脚本",
      byId["thread-title"].textContent);
    check("回填用户消息", threadEl.querySelectorAll(".msg.user").length === 1,
      threadEl.querySelectorAll(".msg.user").length);
    check("回填正文", threadEl.textContent.includes("目录里有两个文件"),
      threadEl.textContent.slice(-120));
    const histCard = threadEl.querySelectorAll(".tool-card")[0];
    check("回填工具卡且是完成态", !!histCard && histCard.dataset.state === "ok",
      histCard && histCard.dataset.state);
    check("回填工具卡带输出",
      !!histCard && textOf(histCard.querySelectorAll(".tool-body")[0]).includes("a.js"),
      histCard && textOf(histCard.querySelectorAll(".tool-body")[0]));
    check("回填后没有错误框", threadEl.querySelectorAll(".errbox").length === 0,
      threadEl.querySelectorAll(".errbox").map((e) => e.textContent).join(" | "));
  }

  // ---------------------------------------------------------------- l
  section("[l] steer 的 UI 路径：生成中打字→回车追加到当前轮 / 空回车不新建轮 / 失败回显");
  {
    await startTurn("数到 20");
    chatStream.push(sse("thread", { threadId: "T-STEER" }, 1));
    chatStream.push(sse("status", { state: "ready" }, 2));
    chatStream.push(sse("delta", { text: "1\n2\n3\n" }, 3));
    await settle(12);

    // --- 生成中的 composer 形态
    check("生成中 placeholder 变成「向当前轮次追加输入…」",
      byId.input.placeholder === "向当前轮次追加输入…", byId.input.placeholder);
    check("queue pill 显示 1/1 运行中", byId["queue-label"].textContent === "1/1 运行中",
      byId["queue-label"].textContent);
    check("queue pill data-state=run", byId["queue-pill"].dataset.state === "run",
      byId["queue-pill"].dataset);

    // --- 打字：按钮从「停止」morph 成「追加」
    byId.input.value = "改成只数到 5";
    byId.input.fire("input");
    await settle(6);
    check("生成中有输入时按钮 state=ready", byId.send.dataset.state === "ready",
      byId.send.dataset.state);
    check("按钮 aria-label 变成「追加到当前轮次」",
      byId.send.getAttribute("aria-label") === "追加到当前轮次",
      byId.send.getAttribute("aria-label"));
    check("停止键同时可见", byId["stop-btn"].hidden === false, byId["stop-btn"].hidden);

    const usersBefore = threadEl.querySelectorAll(".msg.user").length;
    const assistsBefore = threadEl.querySelectorAll(".msg.assistant").length;
    fetchCalls.length = 0;

    // --- 按 Enter：走 steer，不走 chat
    byId.input.fire("keydown", { key: "Enter" });
    await settle(30);

    const steerCall = fetchCalls.find((c) => c.url.indexOf("/api/steer") >= 0);
    const chatCall = fetchCalls.find((c) => c.url.indexOf("/api/chat") >= 0);
    check("回车打了 /api/steer", !!steerCall, fetchCalls.map((c) => c.url).join(" | "));
    check("steer 请求带 threadId 与 message",
      !!steerCall && steerCall.body && steerCall.body.threadId === "T-STEER"
        && steerCall.body.message === "改成只数到 5",
      steerCall && JSON.stringify(steerCall.body));
    check("没有另起新一轮（没有新的 /api/chat）", !chatCall,
      fetchCalls.map((c) => c.url).join(" | "));
    check("输入框已清空", byId.input.value === "", JSON.stringify(byId.input.value));
    check("自己说的话立刻显示出来（多一条 .msg.user）",
      threadEl.querySelectorAll(".msg.user").length === usersBefore + 1,
      threadEl.querySelectorAll(".msg.user").length + " vs " + usersBefore);
    const lastUser = threadEl.querySelectorAll(".msg.user");
    check("追加气泡内容是 steer 的文本",
      textOf(lastUser[lastUser.length - 1]).includes("改成只数到 5"),
      textOf(lastUser[lastUser.length - 1]));
    check("助手消息数不变（还是同一轮）",
      threadEl.querySelectorAll(".msg.assistant").length === assistsBefore,
      threadEl.querySelectorAll(".msg.assistant").length + " vs " + assistsBefore);
    check("提示「已追加到当前轮次」", byId.toast.classList.contains("on")
      && textOf(byId.toast).includes("已追加到当前轮次"), textOf(byId.toast));
    check("这一轮还在跑（placeholder 仍是追加口吻）",
      byId.input.placeholder === "向当前轮次追加输入…", byId.input.placeholder);

    // --- 上一段 delta 仍然落在同一个助手气泡里
    chatStream.push(sse("delta", { text: "4\n5\n" }, 4));
    await settle(10);
    check("steer 后新 delta 仍写进同一个助手气泡",
      textOf(lastTurn()).includes("4") && textOf(lastTurn()).includes("5"),
      textOf(lastTurn()).slice(-80));

    // --- 失败路径：后端拒绝 steer 时要报错，不能假装成功
    steerFail = true;
    byId.input.value = "再改一下";
    byId.input.fire("input");
    await settle(4);
    // addError() 把 .errbox 挂在 thread 根上（独立一行），不在助手气泡里
    const errBefore = threadEl.querySelectorAll(".errbox").length;
    byId.toast.textContent = "";
    byId["composer"].fire("submit");
    await settle(30);
    const errAfter = threadEl.querySelectorAll(".errbox");
    check("steer 被拒时出现错误框", errAfter.length === errBefore + 1,
      errAfter.length + " vs " + errBefore);
    check("错误文案带「追加失败」与后端原因",
      !!errAfter[errAfter.length - 1]
        && textOf(errAfter[errAfter.length - 1]).includes("追加失败")
        && textOf(errAfter[errAfter.length - 1]).includes("这一轮已经结束了"),
      errAfter[errAfter.length - 1] && textOf(errAfter[errAfter.length - 1]));
    check("失败时不弹成功 toast", !textOf(byId.toast).includes("已追加到当前轮次"),
      textOf(byId.toast));
    steerFail = false;

    // --- 空输入点发送键 = 停止（不是新建轮次）
    byId.input.value = "";
    byId.input.fire("input");
    await settle(4);
    check("清空后按钮 morph 回 busy（=停止）", byId.send.dataset.state === "busy",
      byId.send.dataset.state);
    fetchCalls.length = 0;
    byId["composer"].fire("submit");
    await settle(20);
    const intCall2 = fetchCalls.find((c) => c.url.indexOf("/api/interrupt") >= 0);
    const steerCall2 = fetchCalls.find((c) => c.url.indexOf("/api/steer") >= 0);
    check("空 submit 触发的是 /api/interrupt", !!intCall2,
      fetchCalls.map((c) => c.url).join(" | "));
    check("空 submit 不会误发 steer", !steerCall2, fetchCalls.map((c) => c.url).join(" | "));
    check("threadId 正确", !!intCall2 && intCall2.body && intCall2.body.threadId === "T-STEER",
      intCall2 && JSON.stringify(intCall2.body));

    // --- 收尾：回合结束后 composer 复位
    chatStream.push(sse("done", { reason: "interrupted" }, 5));
    chatStream.end();
    await settle(40);
    check("回合结束 placeholder 复位", byId.input.placeholder === "给 Codex 发消息…",
      byId.input.placeholder);
    check("queue pill 回到 1/1 就绪", byId["queue-label"].textContent === "1/1 就绪",
      byId["queue-label"].textContent);
    check("queue pill data-state=idle", byId["queue-pill"].dataset.state === "idle",
      byId["queue-pill"].dataset);
    check("停止键隐藏", byId["stop-btn"].hidden === true, byId["stop-btn"].hidden);
  }

  // ---------------------------------------------------------------- m
  section("[m] 右侧面板：收起状态点页签必须真的打开并渲染（codeside-open/view-main 不成套的回归）");
  {
    // 先跑一轮带工具的事件，喂出 terminalLines 与 threadId
    await startTurn("看下列目录");
    chatStream.push(sse("thread", { threadId: "T-SIDE" }, 1));
    chatStream.push(sse("tool", { id: "c1", name: "shell", input: { command: "ls -la" } }, 2));
    chatStream.push(sse("tool_delta", { id: "c1", text: "a.js\nb.js\n" }, 3));
    chatStream.push(sse("tool_result", { id: "c1", output: "a.js\nb.js\n", status: "completed", durationMs: 90 }, 4));
    await settle(14);

    // 页签按钮要真的挂进 codeside-tabs，setCodesideTab 会 querySelectorAll 它们
    const mkTab = (name) => {
      const b = new El("button");
      b.className = "codeside-tab";
      b.dataset.tab = name;
      byId["codeside-tabs"].appendChild(b);
      return b;
    };
    const tabEls = {};
    for (const t of ["chat", "files", "terminal", "diff", "context"]) tabEls[t] = mkTab(t);
    const clickTab = (name) => byId["codeside-tabs"].fire("click", { target: tabEls[name] });

    // 关掉面板
    byId.codeside.hidden = true;
    bodyEl.classList.remove("codeside-open", "view-main");
    byId["codeside-close"].fire("click");
    await settle(6);
    check("关面板后 hidden=true", byId.codeside.hidden === true, byId.codeside.hidden);
    check("关面板后去掉 codeside-open/view-main",
      !bodyEl.classList.contains("codeside-open") && !bodyEl.classList.contains("view-main"),
      bodyEl.className);

    // 收起状态下点「终端」页签 —— 上一轮实测"0 行 / 空白"的那条路径
    byId["terminal-body"].innerHTML = "";
    clickTab("terminal");
    await settle(10);
    check("点页签自动把面板打开", byId.codeside.hidden === false, byId.codeside.hidden);
    check("codeside-open 与 view-main 成套",
      bodyEl.classList.contains("codeside-open") && bodyEl.classList.contains("view-main"),
      bodyEl.className);
    const termLines = byId["terminal-body"].querySelectorAll(".term-line");
    check("终端页签渲染出内容（不再是空白）", termLines.length >= 2, termLines.length);
    check("终端里有一行是命令", [...termLines].some(l => textOf(l).includes("ls -la")),
      [...termLines].map(l => textOf(l)).join(" | "));
    check("终端页签自己带 on", tabEls.terminal.classList.contains("on"), tabEls.terminal.className);
    check("会话页签此时不带 on", !tabEls.chat.classList.contains("on"), tabEls.chat.className);

    // 「变更」页签：有真 threadId → 走 /api/diff + /api/diff/full
    fetchCalls.length = 0;
    clickTab("diff");
    await settle(30);
    check("点变更会拉 /api/diff",
      fetchCalls.some(c => /\/api\/diff\?/.test(c.url)), fetchCalls.map(c => c.url).join(" | "));
    check("还会拉 /api/diff/full",
      fetchCalls.some(c => /\/api\/diff\/full/.test(c.url)), fetchCalls.map(c => c.url).join(" | "));
    const diffLines = byId["diff-body"].querySelectorAll(".diff-line");
    check("变更页签渲染出 8 行", diffLines.length === 8, diffLines.length);
    check("末尾空行没变成幽灵行",
      [...diffLines].every(l => textOf(l).trim().length > 0),
      [...diffLines].map(l => JSON.stringify(textOf(l))).join(" | "));
    check("页签头部统计来自 /api/diff", textOf(byId["diff-stat"]).includes("+2"),
      textOf(byId["diff-stat"]));

    // 「会话」页签：回窄栏，去 view-main，四个 pane 全收起
    clickTab("chat");
    await settle(8);
    check("点会话去掉 view-main", !bodyEl.classList.contains("view-main"), bodyEl.className);
    check("点会话后面板仍开着（窄栏态）", byId.codeside.hidden === false, byId.codeside.hidden);
    check("四个 pane 全部收起",
      ["files", "terminal", "diff", "context"].every(p => byId["pane-" + p].hidden === true),
      ["files", "terminal", "diff", "context"].map(p => p + "=" + byId["pane-" + p].hidden).join(","));
    check("会话页签自己带 on", tabEls.chat.classList.contains("on"), tabEls.chat.className);

    // Ctrl+2 走的是另一条路径（setCodesideOpen + setCodesideTab），也要能渲染
    byId["codeside-close"].fire("click");
    await settle(6);
    byId["terminal-body"].innerHTML = "";
    documentStub.body.fire("keydown", { key: "2", ctrlKey: true });
    await settle(12);
    check("Ctrl+2 打开面板并切到终端",
      byId.codeside.hidden === false && bodyEl.classList.contains("view-main"),
      bodyEl.className + " hidden=" + byId.codeside.hidden);

    chatStream.push(sse("done", { reason: "completed" }, 9));
    chatStream.end();
    await settle(30);
  }

  // ---------------------------------------------------------------- 收尾
  console.log("");
  if (failures) {
    console.log("\u2717 " + failures + " 项失败（通过 " + passes + "）");
    for (const f of failed) console.log("  \u2717 " + f);
    return 1;
  }
  console.log("ALL OK（" + passes + " 项断言全部通过）");
  return 0;
}

let code = 1;
try {
  code = await main();
} catch (err) {
  failures++;
  console.log("\n\u2717 运行时异常: " + (err && err.stack ? err.stack : err));
  code = 1;
} finally {
  for (const id of intervals) clearInterval(id);
}
process.exit(code);
