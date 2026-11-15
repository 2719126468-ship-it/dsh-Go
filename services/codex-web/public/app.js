/**
 * codex-web 前端主逻辑（ChatGPT / Codex Web 风格）。
 *
 * 分工：index.html 只给骨架和固定 id；app.css 管全部样式；markdown.js 管
 * 正文渲染。这里只做状态机、SSE、DOM 装配。
 *
 * 命名契约见 CONTRACT.md —— 任何 class/id 改名都要先改那份文件。
 */
(() => {
  "use strict";

  // ------------------------------------------------------------------ 令牌
  const TOKEN_KEY = "codex-web-token";
  const readStoredToken = () => { try { return localStorage.getItem(TOKEN_KEY) || ""; } catch { return ""; } };

  /**
   * 令牌净化。
   *
   * 真实事故：手机上从 Termux 复制访问链接，地址栏多带了中文/全角字符，
   * 那个脏值被写进 localStorage；之后 "X-Auth-Token" 的值含非 ISO-8859-1 字符，
   * `headers.set()` **同步抛 TypeError**，而它正包在 window.fetch 里 ——
   * 于是页面每一个请求都挂掉，界面变成一张空壳（会话列表 0 条、历史 0 条，
   * 而且因为异常发生在 fetch 之前，连错误提示都发不出来）。
   *
   * 服务端令牌恒为 32 位十六进制（server.js: randomBytes(16).toString("hex")），
   * 所以这里：① 先剥掉首尾空白；② 只在「纯 latin1 可见字符」时才用；
   * ③ 脏值里能抠出 32 位 hex 就抠出来用（多数就是多了点尾巴）；
   * ④ 抠不出来就当没有，并且**绝不写进 localStorage**。
   */
  const LATIN1 = /^[\x20-\x7E]*$/;
  function sanitizeToken(raw) {
    const v = String(raw == null ? "" : raw).trim();
    if (!v) return "";
    if (LATIN1.test(v)) return v;                       // 干净值原样通过
    const hex = (v.match(/[0-9a-f]{32}/i) || [])[0] || ""; // 脏值里抠出真正的令牌
    return hex;
  }

  const rawPageToken = new URL(location.href).searchParams.get("token");
  const pageToken = sanitizeToken(rawPageToken);
  // 原始值与净化结果不一致 = 链接被粘脏了。这个标记只用来提示用户，不影响请求。
  const tokenWasDirty = !!rawPageToken && rawPageToken.trim() !== pageToken;
  if (pageToken) {
    // pageToken 已经是净化后的值，存它才安全。脏链接里能抠出真令牌的情况
    // （全选复制带上了中文尾巴，最常见）也要存 —— 否则下次从主屏/直接开网址
    // 进来还是 403，手机上等于每次都要重贴链接。
    try { localStorage.setItem(TOKEN_KEY, pageToken); } catch { /* 隐私模式 */ }
    // 用完即擦：token 是长期凭证，不留在地址栏 / 历史 / 截图里。
    try {
      const u = new URL(location.href);
      u.searchParams.delete("token");
      window.history?.replaceState(null, "", u.pathname + u.search);
    } catch { /* 桩环境没有 history */ }
  }
  const storedToken = sanitizeToken(readStoredToken());
  // localStorage 里存着脏值时，顺手把它清掉，免得下次又踩同一个坑。
  if (storedToken !== readStoredToken()) {
    try {
      if (storedToken) localStorage.setItem(TOKEN_KEY, storedToken);
      else localStorage.removeItem(TOKEN_KEY);
    } catch { /* 隐私模式 */ }
  }
  const authToken = pageToken || storedToken;
  const nativeFetch = window.fetch.bind(window);
  window.fetch = (input, init = {}) => {
    let target;
    try { target = new URL(typeof input === "string" ? input : input.url, location.href); }
    catch { return nativeFetch(input, init); }
    if (!authToken || target.origin !== location.origin) return nativeFetch(input, init);
    try {
      const headers = new Headers(init.headers || (typeof input !== "string" ? input.headers : undefined));
      headers.set("X-Auth-Token", authToken);
      return nativeFetch(input, { ...init, headers });
    } catch (error) {
      // sanitizeToken 已经保证 authToken 是纯 latin1 可见字符，headers.set 不该再抛。
      // 真抛了说明是调用方自己传了畸形的 init.headers（例如 new Headers([["a"]])）。
      // 只在 input 是字符串时才改写 URL 退回 query 认证（服务端两种都认：
      // server.js 里 url.searchParams.get("token") || req.headers["x-auth-token"]）。
      // 绝不能对 Request 对象这么干 —— body 挂在 input 上，换成字符串 URL 会把
      // POST 正文丢掉；那种情况原样抛出，保持原生 fetch 的失败语义，不吞错。
      if (typeof input === "string") {
        try {
          target.searchParams.set("token", authToken);
          return nativeFetch(target.href, init);
        } catch { /* 连 URL 都拼不出来，落到下面原样抛 */ }
      }
      throw error;
    }
  };

  // ------------------------------------------------------------------ 引用
  const $ = (id) => document.getElementById(id);
  const scroller = $("scroller");
  const thread = $("thread");
  const hero = $("hero");
  const heroTitle = $("hero-title");
  const heroSub = $("hero-sub");
  const suggestGrid = $("suggest-grid");
  const input = $("input");
  const sendBtn = $("send");
  // 停止键是独立按钮（Codex 的 composer 右侧同时有"发送/追加"和"停止"）
  const stopBtn = $("stop-btn");
  const queuePill = $("queue-pill");
  const queueLabel = $("queue-label");
  const skillPill = $("skill-pill");
  const composer = $("composer");
  const activity = $("activity");
  const activityText = $("activity-text");
  const activityDot = $("activity-dot");
  const usage = $("usage");
  const usageFill = $("usage-fill");
  const usageText = $("usage-text");
  const threadTitleEl = $("thread-title");
  const threadSub = $("thread-sub");
  const footnote = $("footnote");
  const rail = $("rail");
  const panel = $("panel");
  const panelList = $("panel-list");
  const panelFoot = $("panel-foot");
  const threadSearch = $("thread-search");
  const drawerBackdrop = $("drawer-backdrop");
  const modelPill = $("model-pill");
  const modelPillLabel = $("model-pill-label");
  const modePill = $("mode-pill");
  const modePillLabel = $("mode-pill-label");
  const effortPill = $("effort-pill");
  const effortPillLabel = $("effort-pill-label");
  const cwdPill = $("cwd-pill");
  const cwdPillLabel = $("cwd-pill-label");
  const modelMenu = $("model-menu");
  const modeMenu = $("mode-menu");
  const dirSheet = $("dir-sheet");
  const dirBackdrop = $("dir-backdrop");
  const dirPath = $("dir-path");
  const dirBody = $("dir-body");
  const dirUp = $("dir-up");
  const dirClose = $("dir-close");
  const dirChoose = $("dir-choose");
  const attachBtn = $("attach");
  const attachFile = $("attach-file");
  const attachRow = $("attach-row");
  const toastEl = $("toast");
  const updateBar = $("updatebar");
  const envWarn = $("env-warn");

  // ------------------------------------------------------------------ 状态
  let threadId = null;
  let streaming = false;
  let live = null;                 // 当前回合句柄
  let controller = null;
  let interruptRequested = false;
  let interruptTimer = 0;
  let lastSeq = 0;
  let BUILD = "dev";

  let HOME_DIR = "";
  let cwd = "";
  let mode = "danger-full-access";
  let MODES = [];
  let APPROVALS = [];
  let approval = "auto";
  let DEFAULT_APPROVAL = "auto";
  let DEFAULT_MODE = "danger-full-access";
  let SANDBOX_AVAILABLE = true;
  let SANDBOX_REASON = "";
  let sessionTokens = 0;

  let MODELS = [];
  let modelId = "";
  let effortId = "";
  let MODELS_ERROR = "";

  let recentDirs = [];
  let panelPath = "";
  let panelParent = null;
  let threadRows = [];
  let threadFilter = "";

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ------------------------------------------------------------------ 工具
  const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));

  /** markdown.js 没加载成功时的兜底：至少不丢字、不注入。 */
  function md(text, opts) {
    const R = window.CodexMarkdown && window.CodexMarkdown.render;
    if (typeof R === "function") {
      try { return R(String(text ?? ""), opts || {}); } catch { /* 掉到兜底 */ }
    }
    return "<p>" + escapeHtml(text ?? "").replace(/\n/g, "<br>") + "</p>";
  }

  /**
   * 把流式光标插到**最后一个文本节点**的末尾，而不是挂在 HTML 尾巴上。
   *
   * 直接 `html + '<span class=stream-caret>' 的问题是：markdown 渲染出来的最后一个
   * 元素通常是 `</p>`，光标就成了独占一行的竖线 —— 截图里能明显看到它掉到下一行。
   * ChatGPT 的 caret 是紧贴最后一个字符的，所以这里改成"找到最后一个闭合标签，
   * 把 span 插在它前面"。
   */
  function withCaret(html) {
    const caret = '<span class="stream-caret"></span>';
    const s = String(html || "");
    if (!s) return caret;
    const m = /<\/(p|li|h[1-6]|td|th|blockquote|code)>\s*$/.exec(s);
    if (m) {
      const at = s.lastIndexOf(m[0].trimStart());
      return s.slice(0, at) + caret + s.slice(at);
    }
    return s + caret;
  }

  /** 图标按钮的图形表（跟 ChatGPT 的消息动作同一套：复制 / 编辑 / 重试）。 */
  const ACTION_ICONS = {
    copy: '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><rect x="8.5" y="8.5" width="11" height="11" rx="2.2" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M6 15.5H5.2A1.2 1.2 0 0 1 4 14.3V5.2A1.2 1.2 0 0 1 5.2 4h9.1A1.2 1.2 0 0 1 15.5 5.2V6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
    edit: '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path d="M4.5 19.5h4l9-9-4-4-9 9z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="m13.5 6.5 4 4" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
    retry: '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path d="M4.8 12a7.2 7.2 0 1 1 2.2 5.1" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><path d="M4.5 7.5v4.2h4.2" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  };

  function iconButton(kind, label, onClick) {
    const b = el("button", "act-btn");
    b.type = "button";
    b.title = label;
    b.setAttribute("aria-label", label);
    b.innerHTML = ACTION_ICONS[kind] || "";
    b.addEventListener("click", onClick);
    return b;
  }

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function html(tag, cls, inner) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    n.innerHTML = inner;
    return n;
  }
  function truncate(s, n) {
    let t;
    if (s == null) t = "";
    else if (typeof s === "string") t = s;
    else if (typeof s === "number" || typeof s === "boolean") t = String(s);
    else { try { t = JSON.stringify(s); } catch { t = ""; } }
    t = String(t).replace(/\s+/g, " ").trim();
    return t.length > n ? t.slice(0, n) + "…" : t;
  }
  function asText(v) {
    if (typeof v === "string" && v.trim()) return v;
    if (typeof v === "number") return String(v);
    return null;
  }
  function baseName(p) {
    const s = String(p || "").replace(/\/+$/, "");
    const i = s.lastIndexOf("/");
    return i >= 0 ? s.slice(i + 1) : s;
  }
  function unwrapShell(text) {
    const raw = String(text || "").trim();
    const quoted = /^(?:\S*\/)?(?:bash|sh|zsh|dash|fish)\s+-[a-z]*c\s+(['"])([\s\S]*)\1$/.exec(raw);
    if (quoted) return quoted[2];
    const bare = /^(?:\S*\/)?(?:bash|sh|zsh|dash|fish)\s+-[a-z]*c\s+(\S[\s\S]*)$/.exec(raw);
    return bare ? bare[1] : raw;
  }
  function fmtDur(ms) {
    if (typeof ms !== "number" || !isFinite(ms) || ms < 0) return "";
    if (ms < 1000) return ms + "ms";
    if (ms < 60000) return (ms / 1000).toFixed(1) + "s";
    const m = Math.floor(ms / 60000);
    const s = Math.round((ms % 60000) / 1000);
    return m + "m" + (s ? s + "s" : "");
  }
  function fmtTokens(n) {
    if (n == null || !isFinite(n)) return "?";
    if (n < 1000) return String(n);
    if (n < 10000) return (n / 1000).toFixed(1) + "k";
    return Math.round(n / 1000) + "k";
  }

  function toast(text, ms = 1600) {
    if (!toastEl) return;
    toastEl.textContent = text;
    toastEl.classList.add("on");
    clearTimeout(toast._t);
    toast._t = setTimeout(() => toastEl.classList.remove("on"), ms);
  }

  // ------------------------------------------------------------ 主题 / 视口
  const THEME_KEY = "codexweb.theme";
  function applyTheme(name) {
    const dark = name !== "light";
    document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", dark ? "#212121" : "#ffffff");
    try { localStorage.setItem(THEME_KEY, dark ? "dark" : "light"); } catch { /* 隐私模式 */ }
  }
  (function initTheme() {
    const forced = new URL(location.href).searchParams.get("theme");
    if (forced === "light" || forced === "dark") { applyTheme(forced); return; }
    let saved = "";
    try { saved = localStorage.getItem(THEME_KEY) || ""; } catch { /* 隐私模式 */ }
    if (saved === "light" || saved === "dark") { applyTheme(saved); return; }
    const prefersLight = window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches;
    applyTheme(prefersLight ? "light" : "dark");
  })();

  const vv = window.visualViewport;
  function syncViewport() {
    if (!vv) return;
    document.documentElement.style.setProperty("--app-h", Math.round(vv.height) + "px");
  }
  if (vv) {
    vv.addEventListener("resize", syncViewport);
    vv.addEventListener("scroll", syncViewport);
    syncViewport();
  }

  // ------------------------------------------------------------------ 滚动
  function nearBottom() {
    return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 120;
  }
  function scrollToBottom(force) {
    if (force || nearBottom()) {
      requestAnimationFrame(() => { scroller.scrollTop = scroller.scrollHeight; });
    }
  }
  const toBottom = $("to-bottom");
  scroller.addEventListener("scroll", () => {
    const away = !nearBottom();
    scroller.classList.toggle("away", away);
    if (toBottom) toBottom.hidden = !away;
  });
  if (toBottom) toBottom.addEventListener("click", () => scrollToBottom(true));

  // ------------------------------------------------------------------ 建议
  const SUGGESTIONS = [
    { icon: "folder", title: "看看这个目录里有什么", sub: "列出文件并说明结构" },
    { icon: "terminal", title: "跑 git status 并解释输出", sub: "读懂当前仓库状态" },
    { icon: "code", title: "写一个把 Markdown 转纯文本的脚本", sub: "从零实现 + 自测" },
    { icon: "bug", title: "找出这个项目里最容易崩的地方", sub: "读代码，给结论和补丁" },
  ];
  const SUGGEST_ICONS = {
    folder: '<path d="M3.5 7.5A2 2 0 0 1 5.5 5.5h3.2l1.8 2h7A2 2 0 0 1 19.5 9.5v7a2 2 0 0 1-2 2h-12a2 2 0 0 1-2-2z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>',
    terminal: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="m7.5 10 2.5 2-2.5 2M12.5 14h4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>',
    code: '<path d="m8.5 8-4 4 4 4M15.5 8l4 4-4 4M13.5 5.5l-3 13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>',
    bug: '<circle cx="12" cy="12" r="4.5" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M12 3.5v2M12 18.5v2M4.5 8.5l2 1M17.5 8.5l2 1M4.5 15.5l2-1M17.5 15.5l2-1" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
  };
  function renderSuggestions() {
    if (!suggestGrid) return;
    suggestGrid.innerHTML = "";
    for (const s of SUGGESTIONS) {
      const card = el("button", "suggest-card");
      card.type = "button";
      const ico = html("span", "suggest-ico", '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">' + (SUGGEST_ICONS[s.icon] || "") + "</svg>");
      const body = el("span", "suggest-body");
      body.appendChild(el("span", "suggest-title", s.title));
      body.appendChild(el("span", "suggest-sub", s.sub));
      card.appendChild(ico);
      card.appendChild(body);
      card.addEventListener("click", () => {
        input.value = s.title;
        autosize();
        refreshSend();
        input.focus();
      });
      suggestGrid.appendChild(card);
    }
  }
  renderSuggestions();

  /**
   * 空态 / 对话态。
   *
   * 空态时 ChatGPT 把 hero 和 composer 当成**一组**垂直居中，而不是 hero 在
   * 滚动区居中、composer 死贴底 —— 后者在 1440 高的屏上会留下半屏空白。
   * 这里用 .stage.empty-state 让 flex 容器居中整组（scroller 不再吃满剩余高度）。
   */
  function setEmptyState(on) {
    const stage = document.querySelector(".stage");
    if (stage) stage.classList.toggle("empty-state", on);
  }
  function hideHero() {
    if (hero && hero.parentNode) hero.classList.add("gone");
    setEmptyState(false);
  }
  function showHero() {
    if (!hero) return;
    hero.classList.remove("gone");
    if (thread && hero.parentNode !== thread) thread.appendChild(hero);
    setEmptyState(true);
  }

  // ------------------------------------------------------------- 用户消息
  function addUser(text, images) {
    hideHero();
    const row = el("div", "msg user");
    const bubble = el("div", "bubble");
    for (const im of (images || [])) {
      if (!im || !im.dataUrl) continue;
      const pic = document.createElement("img");
      pic.className = "bubble-img";
      pic.src = im.dataUrl;
      pic.alt = im.name || "图片";
      bubble.appendChild(pic);
    }
    if (text) bubble.appendChild(el("div", "bubble-text", text));
    row.appendChild(bubble);
    const actions = el("div", "msg-actions");
    const copy = iconButton("copy", "复制", async () => {
      const ok = await copyText(text);
      toast(ok ? "已复制" : "复制失败", 1200);
    });
    const edit = iconButton("edit", "编辑，回填到输入框", () => {
      input.value = text;
      autosize();
      refreshSend();
      input.focus();
      try { input.setSelectionRange(input.value.length, input.value.length); } catch { /* 老 WebView */ }
    });
    actions.appendChild(copy);
    actions.appendChild(edit);
    row.appendChild(actions);
    thread.appendChild(row);
    scrollToBottom(true);
  }

  function addNotice(text) {
    hideHero();
    const row = el("div", "msg notice");
    row.appendChild(el("div", "notice-box", text));
    thread.appendChild(row);
    scrollToBottom(true);
  }

  function addError(text) {
    hideHero();
    const row = el("div", "msg");
    row.appendChild(el("div", "errbox", text));
    thread.appendChild(row);
    scrollToBottom(true);
  }

  // ---------------------------------------------------------- 工具语义映射
  const VERBS = {
    shell:   { run: "正在运行", done: "已运行",  fail: "运行失败", stop: "已中断", noun: "命令" },
    read:    { run: "正在读取", done: "已读取",  fail: "读取失败", stop: "已中断", noun: "文件" },
    edit:    { run: "正在修改", done: "已修改",  fail: "修改失败", stop: "已中断", noun: "文件" },
    search:  { run: "正在搜索", done: "已搜索",  fail: "搜索失败", stop: "已中断", noun: "搜索" },
    view:    { run: "正在查看", done: "已查看",  fail: "查看失败", stop: "已中断", noun: "图片" },
    call:    { run: "正在调用", done: "已调用",  fail: "调用失败", stop: "已中断", noun: "工具" },
    gen:     { run: "正在生成", done: "已生成",  fail: "生成失败", stop: "已中断", noun: "图片" },
    plan:    { run: "正在规划", done: "已规划",  fail: "规划失败", stop: "已中断", noun: "计划" },
    generic: { run: "正在执行", done: "已执行",  fail: "执行失败", stop: "已中断", noun: "工具" },
  };
  const TOOL_ICONS = {
    shell: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="m7.5 10 2.5 2-2.5 2M12.5 14h4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>',
    read: '<path d="M6 3.5h7l5 5v12a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-16a1 1 0 0 1 1-1z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M13 3.5V9h5" fill="none" stroke="currentColor" stroke-width="1.6"/>',
    edit: '<path d="M4 20h4l10-10-4-4L4 16z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="m13.5 6.5 4 4" stroke="currentColor" stroke-width="1.6"/>',
    search: '<circle cx="11" cy="11" r="6.2" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="m15.6 15.6 4 4" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>',
    view: '<rect x="3.5" y="5.5" width="17" height="13" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="9" cy="10.5" r="1.6" fill="currentColor"/><path d="m5 17 4.5-4 3 2.5 3-3.5 4 5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>',
    call: '<path d="M14.5 4.5 19 9l-2.2 2.2-1.4-1.4-6.2 6.2 1.4 1.4L8.4 19.5 4 15l2.2-2.2 1.4 1.4 6.2-6.2-1.4-1.4z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>',
    gen: '<path d="M12 4v4M12 16v4M4 12h4M16 12h4M6.5 6.5l2.8 2.8M14.7 14.7l2.8 2.8M17.5 6.5l-2.8 2.8M9.3 14.7l-2.8 2.8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
    plan: '<path d="M5 6.5h14M5 12h9M5 17.5h11" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
    generic: '<circle cx="12" cy="12" r="7.5" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="12" cy="12" r="2" fill="currentColor"/>',
  };

  function kindOf(name) {
    const raw = String(name || "").toLowerCase();
    const n = raw.indexOf("/") >= 0 ? raw.slice(raw.lastIndexOf("/") + 1) : raw;
    if (/^(shell|bash|sh|exec|exec_command|run_command|terminal|command)$/.test(n)) return "shell";
    if (/^(read_file|read|cat|view_file|open_file|read_text_file|get_file)$/.test(n)) return "read";
    if (/^(edit_file|write_file|apply_patch|patch|str_replace|create_file|edit|write|multiedit)$/.test(n)) return "edit";
    if (/^(web_search|search|grep|glob|find|list_dir|ls|search_files)$/.test(n)) return "search";
    if (/^(view_image|image_view|open_image|screenshot)$/.test(n)) return "view";
    if (/^(image_generation|generate_image)$/.test(n)) return "gen";
    if (raw.indexOf("/") >= 0 || raw.startsWith("mcp")) return "call";
    return "generic";
  }

  function targetOf(name, inputObj) {
    const o = (inputObj && typeof inputObj === "object") ? inputObj : {};
    for (const key of ["command", "cmd", "path", "file_path", "query", "pattern", "url", "prompt"]) {
      const text = asText(o[key]);
      if (!text) continue;
      const shown = (key === "command" || key === "cmd") ? unwrapShell(text) : text;
      return truncate(shown, 90);
    }
    if (Array.isArray(o.cmd)) {
      const parts = o.cmd.filter((x) => typeof x === "string");
      if (parts.length) return truncate(parts[parts.length - 1], 90);
    }
    if (Array.isArray(o.changes) && o.changes.length) {
      const names = o.changes.map((c) => asText(c) || asText(c && c.path)).filter(Boolean);
      if (names.length) return truncate(names.join("、"), 90);
    }
    return null;
  }

  function inputPreview(inputObj) {
    const o = (inputObj && typeof inputObj === "object") ? inputObj : { input: inputObj };
    try { return JSON.stringify(o, null, 2); } catch { return String(o); }
  }

  // ------------------------------------------------------------ 工具卡片
  // 三个状态图标：都用 inline SVG，尺寸一致（14px），颜色由 CSS 的 data-state 控制。
  const ICON_TICK = '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="m5 13 4.2 4.2L19 6.8" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const ICON_CROSS = '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="m6.5 6.5 11 11M17.5 6.5l-11 11" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>';
  const ICON_SQUARE = '<svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true"><rect x="6.5" y="6.5" width="11" height="11" rx="2" fill="currentColor"/></svg>';

  function iconTick() {
    const s = el("span", "tool-ico-svg");
    s.innerHTML = ICON_TICK;
    return s;
  }
  function iconCross() {
    const s = el("span", "tool-ico-svg");
    s.innerHTML = ICON_CROSS;
    return s;
  }
  function iconSquare() {
    const s = el("span", "tool-ico-svg");
    s.innerHTML = ICON_SQUARE;
    return s;
  }

  function makeCard(tool) {
    const kind = kindOf(tool.name);
    const verbs = VERBS[kind] || VERBS.generic;
    const semantic = kind === "generic" ? null : targetOf(tool.name, tool.input);
    const target = semantic || String(tool.name || "工具");
    const argPreview = semantic ? null : inputPreview(tool.input);

    const root = el("div", "tool-card");
    root.dataset.state = "run";

    const head = el("button", "tool-head");
    head.type = "button";
    const ico = html("span", "tool-ico", '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">' + (TOOL_ICONS[kind] || TOOL_ICONS.generic) + "</svg>");
    const title = el("span", "tool-title");
    const meta = el("span", "tool-meta");
    const status = el("span", "tool-status");
    const chev = el("span", "tool-chev");
    chev.innerHTML = '<svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true"><path d="m9 6 6 6-6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    head.appendChild(ico);
    head.appendChild(title);
    head.appendChild(meta);
    head.appendChild(status);
    head.appendChild(chev);

    const body = el("pre", "tool-body");
    if (argPreview) body.textContent = argPreview;

    root.appendChild(head);
    root.appendChild(body);

    const card = {
      id: tool.id,
      root, body, head, title, meta, status,
      kind, name: tool.name,
      activity: { kind, target },
      state: "run",
      userToggled: false,
      buffer: "",
      startedAt: Date.now(),

      paint() {
        const verb = (VERBS[card.kind] || VERBS.generic)[card.state === "run" ? "run"
          : card.state === "ok" ? "done"
          : card.state === "fail" ? "fail" : "stop"];
        // Codex 的行是「动词 + 空格 + 目标」，没有冒号；动词是灰的、目标用等宽字。
        title.innerHTML = "";
        title.appendChild(el("b", null, verb));
        title.appendChild(document.createTextNode(" "));
        title.appendChild(el("code", null, target));

        root.dataset.state = card.state;
        status.innerHTML = "";
        // Codex 的状态位是 16px 图标：跑 = 旋转环；完成 = 对勾；失败 = 叉；中断 = 方块。
        if (card.state === "run") {
          status.appendChild(el("span", "spin-ring"));
        } else if (card.state === "ok") {
          status.appendChild(iconTick());
        } else if (card.state === "fail") {
          status.appendChild(iconCross());
        } else {
          status.appendChild(iconSquare());
        }

        if (card.state === "run") {
          if (!card.userToggled) card.setOpen(true);
        } else if (!card.userToggled) {
          card.setOpen(false);
        }
        if (!card.buffer) {
          body.classList.add("hint");
          body.textContent = card.state === "run" ? "（等待输出…）" : (argPreview || "（无输出）");
        }
      },

      setOpen(on) {
        root.classList.toggle("open", on);
      },
      isOpen() { return root.classList.contains("open"); },

      appendDelta(text) {
        if (!text) return;
        if (body.classList.contains("hint")) { body.classList.remove("hint"); body.textContent = ""; }
        card.buffer += text;
        // 运行中在输出末尾挂一个光标，跟正文的流式光标是同一套观感。
        if (card.state === "run") {
          body.innerHTML = "";
          body.appendChild(document.createTextNode(card.buffer));
          body.appendChild(el("span", "stream-caret"));
        } else {
          body.textContent = card.buffer;
        }
        if (body.scrollHeight - body.scrollTop - body.clientHeight < 48) {
          body.scrollTop = body.scrollHeight;
        }
        scrollToBottom(false);
      },

      finish(output, statusText, durationMs, exitCode) {
        card.state = (statusText === "failed" || statusText === "declined" || statusText === "errored") ? "fail" : "ok";
        if (typeof exitCode === "number") card.exitCode = exitCode;
        // 收尾时清掉运行中挂的光标
        if (body.querySelector(".stream-caret")) body.innerHTML = "";
        if (typeof output === "string" && output.length) {
          body.classList.remove("hint");
          card.buffer = output;
          body.textContent = output;
        }
        const bits = [];
        if (typeof card.exitCode === "number" && card.exitCode !== 0) bits.push("退出码 " + card.exitCode);
        if (typeof durationMs === "number" && durationMs >= 0) bits.push(fmtDur(durationMs));
        else if (card.startedAt) bits.push(fmtDur(Date.now() - card.startedAt));
        meta.textContent = bits.join(" · ");
        if (typeof card.exitCode === "number" && card.exitCode !== 0) meta.classList.add("bad");
        else meta.classList.remove("bad");
        card.paint();
      },

      markInterrupted() {
        if (card.state !== "run") return;
        card.state = "stop";
        if (!card.buffer) { body.classList.add("hint"); body.textContent = "（执行到一半被中断）"; }
        if (card.startedAt) meta.textContent = fmtDur(Date.now() - card.startedAt);
        card.paint();
      },
    };

    head.addEventListener("click", () => {
      card.userToggled = true;
      card.setOpen(!card.isOpen());
    });

    card.paint();
    return card;
  }

  /** 一组连续的工具调用：≥2 张卡才出组头。 */
  function makeGroup(turn) {
    const root = el("div", "tool-group");
    const head = el("div", "tool-group-head");
    const body = el("div", "tool-group-body");
    root.appendChild(head);
    root.appendChild(body);
    head.style.display = "none";
    const group = {
      root, head, body, cards: [], running: 0,
      refresh() {
        if (group.cards.length < 2) { head.style.display = "none"; return; }
        head.style.display = "flex";
        head.innerHTML = "";
        if (group.running > 0) {
          head.appendChild(el("span", "spin-ring"));
          head.appendChild(el("span", null, group.cards.length + " 步 · 进行中"));
        } else {
          head.appendChild(el("span", null, group.cards.length + " 步 · 已完成"));
        }
      },
    };
    group.refresh();
    return group;
  }

  // -------------------------------------------------------------- 计划卡片
  function makePlanCard(items, explanation) {
    const root = el("div", "plan-card");
    const head = el("div", "plan-head");
    head.appendChild(el("span", "plan-title", "计划"));
    root.appendChild(head);
    const list = el("ol", "plan-list");
    for (const it of items || []) {
      const li = el("li", "plan-step");
      li.dataset.state = it.status || "pending";
      const mark = el("span", "plan-mark");
      // 三态都用 SVG（跟工具卡状态位同一套观感），不要文字符号。
      if (it.status === "completed") mark.innerHTML = ICON_TICK;
      else if (it.status === "inProgress") mark.innerHTML = '<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><path d="M5 12h11M12 6.5 17.5 12 12 17.5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
      else mark.innerHTML = '<svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true"><circle cx="12" cy="12" r="6.2" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>';
      mark.classList.add("plan-icon");
      li.appendChild(mark);
      li.appendChild(el("span", "plan-text", it.step || ""));
      list.appendChild(li);
    }
    root.appendChild(list);
    if (explanation) root.appendChild(el("div", "plan-note", explanation));
    return root;
  }

  // -------------------------------------------------------------- 审批卡片
  /**
   * 审批卡（Codex App 的 Approve / Reject / Edit）。
   *
   * 后端把 app-server 的 ExecCommandApproval / ApplyPatchApproval 反向请求转成
   * SSE 的 approval 事件，这里画成一张卡，点按钮回 POST /api/approval。
   * 卡片一旦有了结论就锁定（按钮置灰 + 结果文案），跟 Codex 一致。
   */
  function makeApprovalCard(turn, info) {
    const root = el("div", "approval-card");
    root.dataset.state = "pending";

    const head = el("div", "approval-head");
    const ico = el("span", "approval-ico");
    ico.innerHTML = '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path d="M12 3.5 19 6.4v5.2c0 4.3-2.9 7.6-7 9-4.1-1.4-7-4.7-7-9V6.4z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="m9.2 12 2.2 2.2 3.8-3.8" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    head.appendChild(ico);
    head.appendChild(el("span", "approval-title", "需要你确认"));
    if (info.reason) head.appendChild(el("span", "approval-reason", truncate(info.reason, 90)));

    const body = el("div", "approval-body");
    if (info.command) {
      const row = el("div", "approval-row");
      row.appendChild(el("span", "approval-key", "命令"));
      const code = el("code", "approval-code", unwrapShell(info.command));
      row.appendChild(code);
      body.appendChild(row);
    }
    if (Array.isArray(info.changes) && info.changes.length) {
      const row = el("div", "approval-row");
      row.appendChild(el("span", "approval-key", "文件"));
      row.appendChild(el("code", "approval-code", info.changes.join("、")));
      body.appendChild(row);
    }
    if (info.cwd) {
      const row = el("div", "approval-row");
      row.appendChild(el("span", "approval-key", "目录"));
      row.appendChild(el("code", "approval-code", shortCwd(info.cwd)));
      body.appendChild(row);
    }

    const foot = el("div", "approval-foot");
    const approve = el("button", "approval-btn primary", "允许");
    const session = el("button", "approval-btn", "总是允许");
    const reject = el("button", "approval-btn danger", "拒绝");
    for (const b of [approve, session, reject]) b.type = "button";

    const done = (choice, note) => {
      root.dataset.state = choice === "approve" || choice === "session" ? "ok" : "fail";
      approve.disabled = session.disabled = reject.disabled = true;
      foot.innerHTML = "";
      foot.appendChild(el("span", "approval-result", note));
    };

    const send = async (choice) => {
      try {
        const res = await fetch("/api/approval", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: info.id, choice }),
        });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || ("HTTP " + res.status));
        done(choice, choice === "deny" || choice === "abort" ? "已拒绝" : "已允许");
      } catch (error) {
        toast("审批回话失败：" + String((error && error.message) || error), 2600);
      }
    };
    approve.addEventListener("click", () => send("approve"));
    session.addEventListener("click", () => send("session"));
    reject.addEventListener("click", () => send("deny"));

    foot.appendChild(approve);
    foot.appendChild(session);
    foot.appendChild(reject);

    root.appendChild(head);
    root.appendChild(body);
    root.appendChild(foot);

    // 事件流里说这一条已经解决了（别的地方点了 / 超时）→ 同步锁定
    root._resolve = (choice, timeout) => {
      if (root.dataset.state !== "pending") return;
      done(choice, timeout ? "已超时，按拒绝处理" : (choice === "deny" || choice === "abort" ? "已在别处拒绝" : "已在别处允许"));
    };
    turn.approvals = turn.approvals || new Map();
    turn.approvals.set(info.id, root);
    turn.root.insertBefore(root, turn.actions);
    scrollToBottom(true);
  }

  // -------------------------------------------------------------- diff 卡片
  function makeDiffCard(diffText, threadIdForFull) {
    const text = String(diffText || "");
    if (!text.trim()) return null;

    // 末尾的空行是 split 的产物，删掉 —— 否则会渲染出一行 "0  5" 的幽灵行。
    const lines = text.replace(/\n+$/, "").split("\n");
    const added = lines.filter((l) => l.startsWith("+") && !l.startsWith("+++")).length;
    const removed = lines.filter((l) => l.startsWith("-") && !l.startsWith("---")).length;
    const files = new Set();
    for (const l of lines) {
      const m = /^diff --git a\/(\S+) b\//.exec(l) || /^\+\+\+ b\/(\S+)/.exec(l);
      if (m) files.add(m[1]);
    }

    const root = el("div", "diff-card");
    const head = el("button", "diff-head");
    head.type = "button";
    head.appendChild(el("span", "diff-ico", "±"));
    head.appendChild(el("span", "diff-title", files.size ? [...files].join("、") : "本轮改动"));
    const stat = el("span", "diff-stat");
    stat.appendChild(el("span", "diff-add", "+" + added));
    stat.appendChild(el("span", "diff-del", "−" + removed));
    head.appendChild(stat);
    const dchev = el("span", "diff-chev");
    dchev.innerHTML = '<svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true"><path d="m9 6 6 6-6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    head.appendChild(dchev);

    const body = el("div", "diff-body");
    const render = (limit) => {
      body.innerHTML = "";
      const shown = limit ? lines.slice(0, limit) : lines;
      // 行号从 hunk 头里解析（"@@ -15,3 +15,8 @@" → old 15 / new 15），
      // 跟 GitHub / Codex 一样左右两列行号，删行只动左列、增行只动右列。
      let oldLn = 0;
      let newLn = 0;
      for (const line of shown) {
        const row = el("div", "diff-line");
        const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
        if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff --git")
          || line.startsWith("index ") || line.startsWith("new file") || line.startsWith("deleted file")) {
          row.classList.add("meta");
        } else if (hunk) {
          row.classList.add("hunk");
          oldLn = Number(hunk[1]);
          newLn = Number(hunk[2]);
        } else if (line.startsWith("+")) {
          row.classList.add("add");
        } else if (line.startsWith("-")) {
          row.classList.add("del");
        } else {
          row.classList.add("ctx");
        }
        const numOld = el("span", "diff-num");
        const numNew = el("span", "diff-num");
        const sign = el("span", "diff-sign");
        // 符号列单独渲染，所以正文要把开头那个 +/− 去掉，否则会渲染成 "++import"。
        const isAdd = row.classList.contains("add");
        const isDel = row.classList.contains("del");
        const bodyText = (isAdd || isDel) ? line.slice(1) : line;
        const textEl = el("span", "diff-text", bodyText || " ");
        if (row.classList.contains("meta") || row.classList.contains("hunk")) {
          // 元信息行不占行号列，让它们跨两列（CSS 里给 .meta/.hunk 一个 grid-span）
          row.appendChild(textEl);
        } else if (isAdd) {
          numNew.textContent = String(newLn++);
          sign.textContent = "+";
          row.appendChild(numOld);
          row.appendChild(numNew);
          row.appendChild(sign);
          row.appendChild(textEl);
        } else if (isDel) {
          numOld.textContent = String(oldLn++);
          sign.textContent = "−";
          row.appendChild(numOld);
          row.appendChild(numNew);
          row.appendChild(sign);
          row.appendChild(textEl);
        } else {
          numOld.textContent = String(oldLn++);
          numNew.textContent = String(newLn++);
          row.appendChild(numOld);
          row.appendChild(numNew);
          row.appendChild(sign);
          row.appendChild(textEl);
        }
        body.appendChild(row);
      }
      if (limit && lines.length > limit) {
        const more = el("button", "diff-more", "查看完整 diff（还有 " + (lines.length - limit) + " 行）");
        more.type = "button";
        more.addEventListener("click", async (ev) => {
          ev.stopPropagation();
          if (threadIdForFull) {
            try {
              const res = await fetch("/api/diff/full?threadId=" + encodeURIComponent(threadIdForFull));
              const data = await res.json();
              if (data && data.diff) { render(0); body.appendChild(el("div", "diff-line meta", "…完整 diff 已载入")); return; }
            } catch { /* 掉到本地全量 */ }
          }
          render(0);
        });
        body.appendChild(more);
      }
    };
    render(30);

    head.addEventListener("click", () => root.classList.toggle("open"));
    root.appendChild(head);
    root.appendChild(body);
    return root;
  }

  // -------------------------------------------------------------- 思考块
  function makeThink(turn) {
    if (turn.think) return turn.think;
    const root = el("div", "think");
    root.dataset.state = "run";
    const head = el("button", "think-head");
    head.type = "button";
    const dot = el("span", "think-dot");
    dot.innerHTML = '<svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true"><circle cx="12" cy="12" r="5" fill="currentColor" opacity=".55"/></svg>';
    const label = el("span", "think-label", "正在思考…");
    const chev = el("span", "think-chev");
    chev.innerHTML = '<svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true"><path d="m9 6 6 6-6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    head.appendChild(dot);
    head.appendChild(label);
    head.appendChild(chev);
    const body = el("div", "think-body");
    root.appendChild(head);
    root.appendChild(body);

    const started = Date.now();
    const think = {
      root, label, body,
      raw: "",
      done: false,
      finish() {
        if (think.done) return;
        think.done = true;
        root.dataset.state = "done";
        const secs = Math.max(1, Math.round((Date.now() - started) / 1000));
        label.textContent = "已思考 " + secs + " 秒";
        label.classList.remove("shimmer");
      },
      append(text) {
        if (!text) return;
        think.raw += text;
        body.textContent = think.raw;
      },
    };
    label.classList.add("shimmer");
    head.addEventListener("click", () => root.classList.toggle("open"));
    // 插在动作条之前：turn.root 的最后一个子节点永远是 .msg-actions，
    // 用 appendChild 会把思考块挤到动作条后面（顺序错乱）。
    turn.root.insertBefore(root, turn.actions);
    turn.think = think;
    return think;
  }

  // ------------------------------------------------------------ 回合句柄
  function addAssistant() {
    hideHero();
    const row = el("div", "msg assistant");
    const actions = el("div", "msg-actions");
    const copy = iconButton("copy", "复制这条回复", async () => {
      const text = turn.texts.map((t) => t.buffer).join("\n").trim();
      if (!text) return;
      const ok = await copyText(text);
      toast(ok ? "已复制" : "复制失败", 1200);
    });
    actions.appendChild(copy);
    actions.appendChild(iconButton("retry", "重试这一轮", () => retryLast()));
    actions.hidden = true;          // 有内容了在 finish() 里放出来
    row.appendChild(actions);
    thread.appendChild(row);
    scrollToBottom(true);

    const turn = {
      root: row,
      actions,
      cards: new Map(),
      texts: [],
      curText: null,
      group: null,
      lastWasTool: false,
      running: 0,
      raf: 0,
      think: null,
      planCard: null,
      diffCard: null,
      empty: false,

      /** 文本增量。上一个块是工具组就另起一个 .md。 */
      append(delta) {
        if (!delta) return;
        if (!turn.curText || turn.lastWasTool) {
          const node = el("div", "md");
          node.dataset.stream = "1";
          turn.root.insertBefore(node, turn.actions);
          turn.curText = { el: node, buffer: "" };
          turn.texts.push(turn.curText);
        }
        turn.curText.buffer += delta;
        turn.lastWasTool = false;
        if (turn.raf) return;
        turn.raf = requestAnimationFrame(() => {
          turn.raf = 0;
          if (!turn.curText) return;
          turn.curText.el.innerHTML = streaming
            ? withCaret(md(turn.curText.buffer, { streaming: true }))
            : md(turn.curText.buffer, { streaming: false });
          scrollToBottom(false);
        });
      },

      /** 工具开始：连续的就并进同一组。 */
      addTool(tool) {
        if (!turn.group || !turn.lastWasTool) {
          turn.group = makeGroup(turn);
          turn.root.insertBefore(turn.group.root, turn.actions);
        }
        const card = makeCard(tool);
        turn.cards.set(tool.id, card);
        turn.group.cards.push(card);
        turn.group.body.appendChild(card.root);
        turn.running++;
        turn.group.running++;
        turn.group.refresh();
        turn.lastWasTool = true;
        turn.curText = null;
        scrollToBottom(false);
        return card;
      },

      toolDelta(id, text) {
        const card = turn.cards.get(id);
        if (card) card.appendDelta(text);
      },

      toolResult(id, output, statusText, durationMs, exitCode) {
        const card = turn.cards.get(id);
        if (!card || card.state !== "run") return;
        card.finish(output, statusText, durationMs, exitCode);
        turn.running = Math.max(0, turn.running - 1);
        if (turn.group) { turn.group.running = Math.max(0, turn.group.running - 1); turn.group.refresh(); }
        scrollToBottom(false);
      },

      reasoning(text) {
        const think = makeThink(turn);
        think.append(text);
        scrollToBottom(false);
      },
      reasoningDone() {
        if (turn.think) turn.think.finish();
      },

      plan(items, explanation) {
        if (turn.planCard && turn.planCard.parentNode) turn.planCard.remove();
        turn.planCard = makePlanCard(items, explanation);
        turn.root.insertBefore(turn.planCard, turn.actions);
        scrollToBottom(false);
      },

      diff(diffText, tid) {
        const card = makeDiffCard(diffText, tid);
        if (!card) return;
        if (turn.diffCard && turn.diffCard.parentNode) turn.diffCard.remove();
        turn.diffCard = card;
        turn.root.insertBefore(card, turn.actions);
        scrollToBottom(false);
      },

      settle(reason) {
        for (const card of turn.cards.values()) {
          if (card.state !== "run") continue;
          if (reason === "interrupted") card.markInterrupted();
          else card.finish(card.buffer, "completed", null);
        }
        turn.running = 0;
        if (turn.group) { turn.group.running = 0; turn.group.refresh(); }
        if (turn.think) turn.think.finish();
      },

      /** done.text 兜底：只做加法，绝不吞掉已渲染内容。 */
      correct(authoritative) {
        if (typeof authoritative !== "string" || !authoritative) return;
        if (!turn.texts.length) {
          const node = el("div", "md");
          turn.root.insertBefore(node, turn.actions);
          turn.curText = { el: node, buffer: authoritative };
          turn.texts.push(turn.curText);
          return;
        }
        const last = turn.texts[turn.texts.length - 1];
        const joined = turn.texts.map((t) => t.buffer).join("");
        if (authoritative === joined || authoritative === last.buffer) return;
        if (!last.buffer) { last.buffer = authoritative; return; }
        if (authoritative.indexOf(last.buffer) === 0) { last.buffer = authoritative; return; }
        if (authoritative.indexOf(joined) === 0) { last.buffer += authoritative.slice(joined.length); return; }
      },

      /** 回合页脚：Codex 卡片底部那行「输入 / 缓存 / 输出 / 推理」+ 总计。 */
      renderUsageFooter() {
        const u = turn.usage;
        if (!u) return;
        const hasBreakdown = u.input != null || u.output != null;
        const foot = el("div", "turn-usage");
        if (hasBreakdown) {
          const parts = [
            ["输入", u.input],
            ["缓存", u.cached],
            ["输出", u.output],
            ["推理", u.reasoning],
          ].filter(([, v]) => v != null);
          for (const [k, v] of parts) {
            const seg = el("span", "tu-seg");
            seg.appendChild(el("span", "tu-key", k));
            seg.appendChild(el("span", "tu-val", fmtTokens(v)));
            foot.appendChild(seg);
          }
        }
        if (u.used != null) {
          const tot = el("span", "tu-seg tu-total");
          tot.appendChild(el("span", "tu-key", "总计"));
          tot.appendChild(el("span", "tu-val", fmtTokens(u.used)));
          foot.appendChild(tot);
        }
        if (!foot.children.length) return;
        turn.root.insertBefore(foot, turn.actions);
      },

      finish() {
        if (turn.raf) { cancelAnimationFrame(turn.raf); turn.raf = 0; }
        for (const t of turn.texts) {
          t.el.innerHTML = md(t.buffer, { streaming: false });
          t.el.removeAttribute("data-stream");
        }
        if (turn.think) turn.think.finish();
        // 空回合（一个字都没出、也没工具卡）不该留下一条孤零零的「复制 / 重试」。
        // 用 content-visibility 不方便（动作条本身要参与 hover），直接按内容判。
        const hasContent = turn.texts.length > 0 || turn.cards.size > 0
          || (turn.think && turn.think.raw.length > 0) || Boolean(turn.planCard) || Boolean(turn.diffCard);
        turn.actions.hidden = !hasContent;
        if (hasContent) turn.renderUsageFooter();
      },
    };
    return turn;
  }

  /** 最近一条用户消息：重试按钮靠它。 */
  let lastUserText = "";

  /**
   * 重试：把最后一条用户消息原样再发一次。
   * 新开一轮而不是复用旧 turn —— 旧 turn 的卡片状态已经收了，往回改只会更乱。
   */
  function retryLast() {
    if (streaming) { toast("正在生成，先等这一轮结束或点停止"); return; }
    const text = lastUserText;
    if (!text) { toast("没有可重试的消息"); return; }
    addUser(text);
    live = addAssistant();
    lastSeq = 0;
    beginTurn();
    setActivity("正在连接…", true);
    runTurnStream(() => fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Codex-Web-Build": BUILD },
      body: JSON.stringify({ threadId, message: text, cwd, mode, model: modelId, effort: effortId, approval }),
      signal: controller.signal,
    }));
  }

  // -------------------------------------------------------------- 复制
  async function copyText(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch { /* 掉到兜底 */ }
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch { return false; }
  }

  // 代码块复制（事件委托）
  thread.addEventListener("click", async (ev) => {
    const btn = ev.target && ev.target.closest ? ev.target.closest(".code-copy") : null;
    if (!btn) return;
    ev.preventDefault();
    let text = "";
    try {
      const raw = atob(btn.getAttribute("data-code") || "");
      const bytes = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
      text = new TextDecoder().decode(bytes);
    } catch { text = btn.getAttribute("data-code") || ""; }
    const ok = await copyText(text);
    // 按钮里现在有图标 + 文字（见 markdown.js），只换 span 的文字，别把图标覆盖掉。
    const label = btn.querySelector(".code-copy-txt") || btn;
    label.textContent = ok ? "已复制" : "失败";
    setTimeout(() => { label.textContent = "复制"; }, 1200);
  });

  // ---------------------------------------------------------- 活动行 / 用量
  let usageState = { used: null, window: null, input: null, cached: null, output: null, reasoning: null };
  let usageKnown = false;
  let activityShown = false;

  function refreshActivityRow() {
    const show = activityShown || usageKnown;
    activity.style.display = show ? "flex" : "none";
  }
  function setActivity(text, spin) {
    if (!text) {
      activityShown = false;
      activityText.textContent = "";
      activityText.classList.remove("shimmer");
      activityDot.style.display = "none";
      refreshActivityRow();
      return;
    }
    activityShown = true;
    activityText.textContent = text;
    activityText.classList.toggle("shimmer", !!spin);
    activityDot.style.display = spin ? "block" : "none";
    refreshActivityRow();
  }
  function setActivityCommand(prefix, command) {
    activityShown = true;
    activityDot.style.display = "block";
    activityText.classList.remove("shimmer");
    activityText.innerHTML = "";
    activityText.appendChild(document.createTextNode(prefix));
    activityText.appendChild(el("code", null, truncate(command, 60)));
    refreshActivityRow();
  }
  function renderUsage() {
    const { used, window: win } = usageState;
    if (used == null) {
      usageKnown = false;
      usage.style.display = "none";
      refreshActivityRow();
      return;
    }
    usageKnown = true;
    usage.style.display = "flex";
    const pct = (win && win > 0) ? Math.min(100, Math.round((used / win) * 100)) : null;
    usageFill.style.width = (pct == null ? 0 : pct) + "%";
    usage.className = "usage" + (pct == null ? "" : pct >= 90 ? " danger" : pct >= 70 ? " warn" : "");
    usageText.textContent = win ? fmtTokens(used) + "/" + fmtTokens(win) : fmtTokens(used);
    usage.title = pct == null ? ("上下文已用 " + used + " tokens") : ("上下文已用 " + pct + "%（" + used + " / " + win + " tokens）");
    refreshActivityRow();
  }
  function resetUsage() {
    usageState = { used: null, window: null };
    renderUsage();
  }

  // -------------------------------------------------------------- 图片附件
  /**
   * 待发送的图片。
   *
   * 这里存的是**服务端路径**，不是 base64：app-server 的 localImage 只吃绝对路径。
   * dataUrl 留着只是为了在气泡和 composer 里显示缩略图（不必再回读文件）。
   */
  let pendingImages = [];

  function renderAttachments() {
    if (!attachRow) return;
    attachRow.innerHTML = "";
    attachRow.hidden = pendingImages.length === 0;
    composer.classList.toggle("has-attach", pendingImages.length > 0);
    pendingImages.forEach((img, i) => {
      const thumb = el("div", "attach-thumb");
      const pic = document.createElement("img");
      pic.src = img.dataUrl;
      pic.alt = img.name || "图片";
      pic.loading = "lazy";
      thumb.appendChild(pic);
      const del = el("button", "attach-del", "×");
      del.type = "button";
      del.title = "移除这张图";
      del.addEventListener("click", () => {
        pendingImages.splice(i, 1);
        renderAttachments();
        refreshSend();
      });
      thumb.appendChild(del);
      attachRow.appendChild(thumb);
    });
  }

  async function addFiles(files) {
    const list = Array.from(files || []).filter((f) => f && /^image\//.test(f.type));
    if (!list.length) return;
    for (const file of list.slice(0, 8)) {
      if (file.size > 20 * 1024 * 1024) { toast("图片超过 20MB：" + file.name, 2600); continue; }
      const dataUrl = await new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(String(fr.result || ""));
        fr.onerror = () => reject(fr.error || new Error("读文件失败"));
        fr.readAsDataURL(file);
      }).catch(() => "");
      if (!dataUrl) continue;
      try {
        const res = await fetch("/api/upload", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ data: dataUrl, name: file.name }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || ("HTTP " + res.status));
        pendingImages.push({ path: data.path, dataUrl, name: file.name });
        renderAttachments();
        refreshSend();
      } catch (error) {
        toast("上传失败：" + String((error && error.message) || error), 2600);
      }
    }
  }

  if (attachBtn && attachFile) {
    attachBtn.addEventListener("click", () => attachFile.click());
    attachFile.addEventListener("change", async () => {
      await addFiles(attachFile.files);
      attachFile.value = "";
    });
    // 粘贴图片 / 拖文件进来，跟 ChatGPT 一致
    input.addEventListener("paste", (ev) => {
      const items = (ev.clipboardData && ev.clipboardData.files) || [];
      if (items.length) { ev.preventDefault(); addFiles(items); }
    });
    composer.addEventListener("dragover", (ev) => { ev.preventDefault(); composer.classList.add("drag"); });
    composer.addEventListener("dragleave", () => composer.classList.remove("drag"));
    composer.addEventListener("drop", (ev) => {
      ev.preventDefault();
      composer.classList.remove("drag");
      if (ev.dataTransfer && ev.dataTransfer.files) addFiles(ev.dataTransfer.files);
    });
  }

  // -------------------------------------------------------------- 会话列表
  function relTime(sec) {
    if (!sec) return "";
    const d = new Date(sec * 1000);
    const diff = (Date.now() - d.getTime()) / 1000;
    if (diff < 60) return "刚刚";
    if (diff < 3600) return Math.floor(diff / 60) + " 分钟前";
    if (diff < 86400) return Math.floor(diff / 3600) + " 小时前";
    if (diff < 172800) return "昨天";
    if (diff < 604800) return Math.floor(diff / 86400) + " 天前";
    return (d.getMonth() + 1) + "月" + d.getDate() + "日";
  }
  function dayBucket(sec) {
    if (!sec) return "更早";
    const d = new Date(sec * 1000);
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const t = d.getTime();
    if (t >= startOfToday) return "今天";
    if (t >= startOfToday - 86400000) return "昨天";
    if (t >= startOfToday - 7 * 86400000) return "最近 7 天";
    return "更早";
  }

  function renderThreadList() {
    panelList.innerHTML = "";
    const q = threadFilter.trim().toLowerCase();
    const rows = q ? threadRows.filter((t) => String(t.title || "").toLowerCase().includes(q)) : threadRows;
    if (!rows.length) {
      panelList.appendChild(el("div", "panel-hint", q ? "没有匹配的会话" : "还没有会话。"));
      return;
    }
    // Codex App 的侧栏按**工作区**分组（codex-demo / limliu …），不是按日期。
    // 这里照做：先按 cwd 的末段分，同一工作区内的会话排在一起；"未指定目录"兜底。
    const order = [];
    const groups = new Map();
    for (const t of rows) {
      const key = t.cwd ? (t.cwd.replace(/\/+$/, "").split("/").pop() || t.cwd) : "未指定目录";
      if (!groups.has(key)) { groups.set(key, []); order.push(key); }
      groups.get(key).push(t);
    }
    for (const name of order) {
      const list = groups.get(name);
      if (!list || !list.length) continue;
      const g = el("div", "panel-group");
      const gh = el("button", "panel-group-head");
      gh.type = "button";
      const chev = el("span", "pg-chev");
      chev.innerHTML = '<svg viewBox="0 0 24 24" width="11" height="11" aria-hidden="true"><path d="m9 6 6 6-6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
      gh.appendChild(chev);
      gh.appendChild(el("span", "pg-name", name));
      gh.appendChild(el("span", "pg-count", String(list.length)));
      g.appendChild(gh);
      gh.addEventListener("click", () => {
        const collapsed = g.classList.toggle("collapsed");
        try {
          const saved = JSON.parse(localStorage.getItem("codexweb.collapsedGroups") || "{}");
          saved[name] = collapsed;
          localStorage.setItem("codexweb.collapsedGroups", JSON.stringify(saved));
        } catch { /* 隐私模式 */ }
      });
      try {
        const saved = JSON.parse(localStorage.getItem("codexweb.collapsedGroups") || "{}");
        if (saved[name]) g.classList.add("collapsed");
      } catch { /* 隐私模式 */ }
      for (const t of list) {
        const item = el("button", "sess" + (t.id === threadId ? " cur" : ""));
        item.type = "button";
        // ChatGPT 的会话行是**单行**：标题 + hover 才出来的动作，没有第二行 meta。
        // 之前两行（标题 + "时间 · 模型"）把每行撑到 50px，列表一眼看上去又长又吵。
        // 时间与模型改成 title 提示，鼠标悬停就能看到，不占版面。
        const rowTop = el("span", "sess-top");
        rowTop.appendChild(el("span", "sess-title", t.title || "(无标题会话)"));
        if (t.generating) rowTop.appendChild(el("span", "sess-live"));
        item.appendChild(rowTop);
        const metaBits = [relTime(t.updatedAt)];
        if (t.model) metaBits.push(t.model);
        item.title = metaBits.filter(Boolean).join(" · ");

        // hover 出来的行内动作：改名 / 删除（ChatGPT 侧栏同款）
        const acts = el("span", "sess-acts");
        const renameBtn = el("span", "sess-act", "✎");
        renameBtn.title = "重命名";
        renameBtn.setAttribute("role", "button");
        renameBtn.addEventListener("click", async (ev) => {
          ev.stopPropagation();
          const next = window.prompt("会话名称", t.title || "");
          if (next == null) return;
          const name = String(next).trim();
          if (!name) return;
          try {
            const res = await fetch("/api/thread/rename", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ threadId: t.id, name }),
            });
            if (!res.ok) throw new Error((await res.json()).error || ("HTTP " + res.status));
            t.title = name;
            if (t.id === threadId) setTitle(name);
            renderThreadList();
          } catch (error) {
            toast("改名失败：" + String((error && error.message) || error), 2400);
          }
        });
        const delBtn = el("span", "sess-act danger", "🗑");
        delBtn.title = "删除会话";
        delBtn.setAttribute("role", "button");
        delBtn.addEventListener("click", async (ev) => {
          ev.stopPropagation();
          if (!window.confirm("删除这个会话？磁盘上的记录也会一起删掉，不能恢复。")) return;
          try {
            const res = await fetch("/api/thread/delete", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ threadId: t.id }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || ("HTTP " + res.status));
            threadRows = threadRows.filter((x) => x.id !== t.id);
            if (t.id === threadId) newChat();
            renderThreadList();
          } catch (error) {
            toast("删除失败：" + String((error && error.message) || error), 2400);
          }
        });
        acts.appendChild(renameBtn);
        acts.appendChild(delBtn);
        item.appendChild(acts);

        item.addEventListener("click", () => openThread(t.id, t.title));
        g.appendChild(item);
      }
      panelList.appendChild(g);
    }
  }

  async function loadThreads() {
    const now = Date.now();
    if (loadThreads._pending) return loadThreads._pending;
    if (loadThreads._last && now - loadThreads._last < 400) return;
    loadThreads._last = now;
    const job = (async () => {
      try {
        const res = await fetch("/api/threads?limit=80", { cache: "no-store" });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || ("HTTP " + res.status));
        threadRows = Array.isArray(data.threads) ? data.threads : [];
        renderThreadList();
        renderPanelFoot();
      } catch (error) {
        panelList.innerHTML = "";
        panelList.appendChild(el("div", "panel-hint", "读取失败：" + String((error && error.message) || error)));
      }
    })().finally(() => { loadThreads._pending = null; });
    loadThreads._pending = job;
    return job;
  }

  function renderPanelFoot() {
    panelFoot.innerHTML = "";
    const row = el("div", "panel-foot-row");
    row.appendChild(el("span", "panel-foot-label", cwd ? shortCwd(cwd) : "~"));
    panelFoot.appendChild(row);
  }

  /** Ctrl/Cmd+B 与 rail 上的折叠按钮共用这一个动作。 */
  function togglePanelCollapsed() {
    document.body.classList.toggle("panel-collapsed");
    try {
      localStorage.setItem("codexweb.panelCollapsed", document.body.classList.contains("panel-collapsed") ? "1" : "0");
    } catch { /* 隐私模式 */ }
  }

  function openPanel() {
    panel.classList.add("open");
    drawerBackdrop.classList.add("on");
    loadThreads();
  }
  function closePanel() {
    panel.classList.remove("open");
    drawerBackdrop.classList.remove("on");
  }
  drawerBackdrop.addEventListener("click", closePanel);
  $("panel-close").addEventListener("click", closePanel);
  $("btn-menu").addEventListener("click", openPanel);
  $("rail-search").addEventListener("click", () => {
    openPanel();
    setTimeout(() => threadSearch.focus(), 120);
  });
  threadSearch.addEventListener("input", () => {
    threadFilter = threadSearch.value;
    renderThreadList();
  });

  // -------------------------------------------------------------- 打开历史
  async function openThread(id, title) {
    if (streaming) { toast("正在生成，先等这一轮结束或点停止"); return; }
    closePanel();
    thread.innerHTML = "";
    thread.appendChild(hero);
    showHero();
    live = null;
    resetUsage();
    setTitle(title || "会话");
    thread.appendChild(el("div", "panel-hint", "正在载入历史…"));

    try {
      const res = await fetch("/api/thread/history", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ threadId: id }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || ("HTTP " + res.status));
      threadId = id;
      applySession({ cwd: data.cwd, mode: data.mode, tokens: data.tokens, model: data.model, effort: data.effort });
      renderHistory(data.messages || []);
    } catch (error) {
      thread.innerHTML = "";
      thread.appendChild(hero);
      showHero();
      addError("载入这个会话失败：" + String((error && error.message) || error));
    }
  }

  function renderHistory(list) {
    thread.innerHTML = "";
    thread.appendChild(hero);
    showHero();
    for (const m of list) {
      if (m.role === "user") { addUser(m.text || ""); continue; }
      const turn = addAssistant();
      for (const part of m.parts || []) {
        if (part.type === "text") { turn.append(part.text || ""); continue; }
        if (part.type === "reasoning") { turn.reasoning(part.text || ""); turn.reasoningDone(); continue; }
        if (part.type === "plan") {
          turn.plan([{ step: part.text || "", status: "completed" }], null);
          continue;
        }
        if (part.type !== "tool") continue;
        turn.addTool({ id: part.id, name: part.name, input: part.input });
        const card = turn.cards.get(part.id);
        if (part.status === "inProgress") card && card.markInterrupted();
        else turn.toolResult(part.id, part.output || "", part.status, part.durationMs);
      }
      turn.settle("completed");
      turn.finish();
      if (!turn.texts.length && !turn.cards.size && !turn.think) turn.root.remove();
    }
    scrollToBottom(true);
  }

  // -------------------------------------------------------------- 标题/会话
  function setTitle(text) {
    threadTitleEl.textContent = text || "新会话";
    threadTitleEl.title = text || "";
  }
  function renderThreadSub() {
    const bits = [];
    if (cwd) bits.push(shortCwd(cwd));
    const m = MODELS.find((x) => x.id === modelId);
    if (m) bits.push(m.displayName + (effortId ? " · " + effortLabel(effortId) : ""));
    threadSub.textContent = bits.join("  ·  ");
  }

  // ---------------------------------------------------------- 目录 / 权限
  const RECENT_KEY = "codexweb.recentDirs";
  function loadRecents() {
    try {
      const raw = JSON.parse(localStorage.getItem(RECENT_KEY) || "[]");
      recentDirs = Array.isArray(raw) ? raw.filter((x) => typeof x === "string").slice(0, 5) : [];
    } catch { recentDirs = []; }
  }
  function saveRecents() {
    try { localStorage.setItem(RECENT_KEY, JSON.stringify(recentDirs.slice(0, 5))); } catch { /* 隐私模式 */ }
  }
  function pushRecent(p) {
    if (!p) return;
    recentDirs = [p, ...recentDirs.filter((x) => x !== p)].slice(0, 5);
    saveRecents();
  }
  function shortCwd(p) {
    if (!p) return "~";
    if (p === HOME_DIR) return "~";
    if (HOME_DIR && p.startsWith(HOME_DIR + "/")) {
      const rel = p.slice(HOME_DIR.length + 1);
      return rel.length <= 24 ? "~/" + rel : "…/" + rel.slice(-22);
    }
    return p.length <= 28 ? p : "…" + p.slice(-26);
  }
  function modeDef(id) { return MODES.find((m) => m.id === id) || null; }
  function approvalDef(id) { return APPROVALS.find((a) => a.id === id) || null; }
  /** 当前生效的审批策略（auto 时取沙箱档的默认值）—— 只用于显示。 */
  function effectiveApproval() {
    if (approval !== "auto" && approvalDef(approval)) return approval;
    const m = modeDef(mode);
    return (m && m.defaultApproval) || "never";
  }

  function renderPills() {
    cwdPillLabel.textContent = shortCwd(cwd);
    cwdPill.title = cwd || "";
    $("btn-cwd").title = cwd || "";
    const topCwd = $("top-cwd-label");
    if (topCwd) topCwd.textContent = shortCwd(cwd);
    const md0 = modeDef(mode);
    const ap0 = approvalDef(approval);
    // pill 上写「沙箱 · 审批」，因为这两件事共同决定"Codex 会不会停下来问我"。
    const modeText = (md0 ? md0.short : mode) + " · " + (ap0 ? ap0.short : approval);
    modePillLabel.textContent = modeText;
    modePill.title = (md0 ? md0.label + "：" + md0.desc : mode) + "\n"
      + (ap0 ? "审批：" + ap0.label + " —— " + ap0.desc : "");
    const topMode = $("top-mode-label");
    if (topMode) topMode.textContent = modeText;
    modePill.className = "mode-pill" + (mode === "danger-full-access" ? " danger" : "");
    const m = MODELS.find((x) => x.id === modelId);
    // Codex / ChatGPT 把「模型 + 推理档」写在同一个 pill 上（"GPT-6.1-Sol · 低"），
    // 所以这里也拼进去；单独那颗 effort pill 只是为了让这一档更容易被发现。
    modelPillLabel.textContent = m
      ? (effortId ? m.displayName + " · " + effortLabel(effortId) : m.displayName)
      : (MODELS_ERROR ? "模型不可用" : "模型");
    modelPill.title = m ? (m.description || m.displayName) : "选择模型";
    // 推理强度单独一颗 pill：它跟模型是两件独立的事，混在一个菜单里很难发现。
    if (effortPillLabel) {
      effortPillLabel.textContent = effortLabel(effortId || "medium");
      if (effortPill) {
        effortPill.title = "推理强度：" + effortLabel(effortId || "medium");
        effortPill.style.display = m && m.efforts && m.efforts.length ? "inline-flex" : "none";
      }
    }
    renderThreadSub();
    renderPanelFoot();
  }

  function applySession(s) {
    if (!s) return;
    if (typeof s.cwd === "string" && s.cwd) cwd = s.cwd;
    if (typeof s.mode === "string" && s.mode) mode = s.mode;
    if (typeof s.approval === "string" && s.approval) approval = s.approval;
    if (typeof s.tokens === "number") sessionTokens = s.tokens;
    if (typeof s.model === "string" && s.model) modelId = s.model;
    if (typeof s.effort === "string" && s.effort) effortId = s.effort;
    renderPills();
    if (codesideVisible()) {
      if (codesideTab === "files") { codesideDir = ""; renderSideFiles(); }
      else if (codesideTab === "diff") renderSideDiff();
      else if (codesideTab === "context") renderSideContext();
    }
  }
  function resetSessionSettings() {
    cwd = HOME_DIR || "";
    mode = DEFAULT_MODE;
    approval = DEFAULT_APPROVAL;
    sessionTokens = 0;
    const def = MODELS.find((m) => m.isDefault) || MODELS[0];
    if (def) { modelId = def.id; effortId = def.defaultEffort || "medium"; }
    renderPills();
  }

  async function loadConfig() {
    try {
      const res = await fetch("/api/config", { cache: "no-store" });
      const d = await res.json();
      HOME_DIR = d.home || "";
      DEFAULT_MODE = d.defaultMode || "danger-full-access";
      MODES = Array.isArray(d.modes) ? d.modes : [];
      APPROVALS = Array.isArray(d.approvals) ? d.approvals : [];
      DEFAULT_APPROVAL = d.defaultApproval || "auto";
      SANDBOX_AVAILABLE = d.sandboxAvailable !== false;
      SANDBOX_REASON = d.sandboxReason || "";
    } catch { /* 用兜底值，服务端还有一层默认 */ }
    loadRecents();
    renderEnvWarn();
    await loadModels();
    resetSessionSettings();
  }

  function renderEnvWarn() {
    if (!envWarn) return;
    if (SANDBOX_AVAILABLE) { envWarn.style.display = "none"; return; }
    envWarn.style.display = "block";
    // 一行就够：这台设备只有全权限能跑。整段话塞进 title，需要细节再悬停看。
    envWarn.innerHTML = "<b>仅全权限可用</b> · Android 10 没有 bubblewrap / Landlock";
    envWarn.title = "Android 10 没有 bubblewrap / user namespace / Landlock，"
      + "「只读」「可写工作区」这两档的命令会直接失败。默认已选好「全权限」，无需改动。";
  }

  async function loadModels() {
    try {
      const res = await fetch("/api/models", { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || ("HTTP " + res.status));
      MODELS = Array.isArray(data.models) ? data.models : [];
      MODELS_ERROR = "";
    } catch (error) {
      MODELS = [];
      MODELS_ERROR = String((error && error.message) || error);
    }
    const def = MODELS.find((m) => m.isDefault) || MODELS[0];
    if (def) { modelId = def.id; effortId = def.defaultEffort || "medium"; }
    renderPills();
  }

  function effortLabel(id) {
    return ({ low: "低", medium: "中", high: "高", xhigh: "很高", max: "最高", ultra: "极限" })[id] || id;
  }

  // -------------------------------------------------------------- 目录面板
  function openDirSheet() {
    dirBackdrop.classList.add("on");
    dirSheet.classList.add("on");
    panelPath = cwd || HOME_DIR;
    renderDirPanel();
  }
  function closeDirSheet() {
    dirBackdrop.classList.remove("on");
    dirSheet.classList.remove("on");
  }
  function makeDirRow(path, label, exists, isRecent, note) {
    const row = el("button", "dir-item" + (exists ? "" : " gone"));
    row.type = "button";
    const ico = el("span", "dir-ico", exists ? "📁" : "🚫");
    row.appendChild(ico);
    row.appendChild(el("span", "dname", label));
    if (!exists) row.appendChild(el("span", "dnote", note || "目录已删除"));
    row.appendChild(el("span", "dir-grow"));
    if (isRecent) {
      const del = el("span", "dir-del", "×");
      del.title = "从最近使用里移除";
      del.addEventListener("click", (ev) => {
        ev.stopPropagation();
        recentDirs = recentDirs.filter((x) => x !== path);
        saveRecents();
        renderDirPanel();
      });
      row.appendChild(del);
    }
    if (exists) row.addEventListener("click", () => { panelPath = path; renderDirPanel(); });
    else row.disabled = true;
    return row;
  }

  async function renderDirPanel() {
    dirPath.textContent = panelPath;
    dirBody.innerHTML = "";
    dirBody.appendChild(el("div", "sheet-empty", "正在读取…"));
    let data;
    try {
      const res = await fetch("/api/dirs?path=" + encodeURIComponent(panelPath));
      data = await res.json();
      if (!res.ok) throw new Error(data.error || ("HTTP " + res.status));
    } catch (error) {
      dirBody.innerHTML = "";
      dirBody.appendChild(el("div", "sheet-empty", "读不了这个目录：" + String((error && error.message) || error)));
      return;
    }
    panelPath = data.path;
    panelParent = data.parent;
    dirPath.textContent = data.path;
    dirUp.disabled = !data.parent;
    dirBody.innerHTML = "";

    if (recentDirs.length) {
      const group = el("div", "dir-group");
      group.appendChild(el("div", "dir-group-head", "最近使用"));
      const alive = await Promise.all(recentDirs.map(async (p) => {
        try { const r = await fetch("/api/dirs?path=" + encodeURIComponent(p)); return r.ok; }
        catch { return false; }
      }));
      recentDirs.forEach((p, i) => group.appendChild(makeDirRow(p, shortCwd(p), alive[i], true)));
      dirBody.appendChild(group);
    }

    const group2 = el("div", "dir-group");
    group2.appendChild(el("div", "dir-group-head", data.path === HOME_DIR ? "工作目录下的文件夹" : "子目录"));
    if (!data.dirs.length) group2.appendChild(el("div", "sheet-empty", "（没有子目录）"));
    for (const d of data.dirs) {
      group2.appendChild(d.blocked
        ? makeDirRow(d.path, d.name, false, false, "软链指向工作目录外")
        : makeDirRow(d.path, d.name, true, false));
    }
    dirBody.appendChild(group2);
  }

  function chooseCurrentDir() {
    pushRecent(panelPath);
    cwd = panelPath;
    renderPills();
    closeDirSheet();
  }
  dirBackdrop.addEventListener("click", closeDirSheet);
  dirClose.addEventListener("click", closeDirSheet);
  dirChoose.addEventListener("click", chooseCurrentDir);
  dirUp.addEventListener("click", () => { if (panelParent) { panelPath = panelParent; renderDirPanel(); } });
  cwdPill.addEventListener("click", openDirSheet);
  $("btn-cwd").addEventListener("click", openDirSheet);

  // ------------------------------------------------------------ 菜单通用
  /** 当前菜单是由哪个元素打开的：document 的"点外面就关"要放它一马。 */
  let menuOpenedBy = null;

  function placeMenu(menu, anchor, width) {
    menuOpenedBy = anchor;
    const r = anchor.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    menu.style.display = "block";
    menu.style.width = width + "px";
    const mw = Math.min(width, vw - 24);
    let left = Math.min(Math.max(12, r.left), vw - mw - 12);
    menu.style.left = left + "px";
    menu.style.right = "auto";
    const mh = menu.offsetHeight || 240;
    const spaceAbove = r.top - 12;
    const spaceBelow = vh - r.bottom - 12;
    if (spaceAbove >= mh || spaceAbove > spaceBelow) {
      menu.style.top = Math.max(12, r.top - mh - 8) + "px";
      menu.dataset.side = "up";
    } else {
      menu.style.top = Math.min(vh - mh - 12, r.bottom + 8) + "px";
      menu.dataset.side = "down";
    }
  }
  function hideMenus() {
    modelMenu.style.display = "none";
    modeMenu.style.display = "none";
  }
  document.addEventListener("click", (ev) => {
    const t = ev.target;
    if (modelMenu.contains(t) || modeMenu.contains(t)) return;
    if (modelPill.contains(t) || modePill.contains(t) || (effortPill && effortPill.contains(t)) || $("btn-mode").contains(t)) return;
    // 打开菜单的那个按钮本身也要放过 —— 否则 rail 上的齿轮会在同一次点击里
    // 先把菜单打开、再被"点外面"关掉，看起来就是"点了没反应"。
    if (menuOpenedBy && menuOpenedBy.contains && menuOpenedBy.contains(t)) return;
    hideMenus();
  });
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") { hideMenus(); closeDirSheet(); closePanel(); return; }
    const mod = ev.ctrlKey || ev.metaKey;
    if (!mod) return;
    // Ctrl/Cmd+K：会话搜索（ChatGPT 同款快捷键）
    if (ev.key === "k" || ev.key === "K") {
      ev.preventDefault();
      openPanel();
      setTimeout(() => threadSearch.focus(), 120);
      return;
    }
    // Ctrl/Cmd+Shift+O：新会话
    if (ev.shiftKey && (ev.key === "o" || ev.key === "O")) {
      ev.preventDefault();
      newChat();
      return;
    }
    // Ctrl/Cmd+B：折叠/展开侧栏
    if (!ev.shiftKey && (ev.key === "b" || ev.key === "B")) {
      ev.preventDefault();
      togglePanelCollapsed();
      return;
    }
    // Ctrl/Cmd+1..4：切右侧面板（文件 / 终端 / 变更 / 上下文）
    if (!ev.shiftKey && /^[1-4]$/.test(ev.key)) {
      ev.preventDefault();
      const tabs = ["files", "terminal", "diff", "context"];
      setCodesideOpen(true);
      setCodesideTab(tabs[Number(ev.key) - 1]);
      return;
    }
    // Ctrl/Cmd+.（Codex 的中断快捷键）
    if (!ev.shiftKey && (ev.key === "." || ev.key === "。")) {
      ev.preventDefault();
      if (streaming) stop();
      return;
    }
    // Ctrl/Cmd+\：收起/展开右侧面板
    if (!ev.shiftKey && (ev.key === "\\" || ev.key === "|")) {
      ev.preventDefault();
      toggleCodeside();
      return;
    }
  });

  // ------------------------------------------------------------ 模型菜单
  function openModelMenu() {
    if (modeMenu.style.display === "block") hideMenus();
    modelMenu.innerHTML = "";
    if (MODELS_ERROR) {
      modelMenu.appendChild(el("div", "menu-note", "读取模型列表失败：" + MODELS_ERROR));
    }
    if (!MODELS.length) {
      modelMenu.appendChild(el("div", "menu-note", "没有可用模型（检查 Codex 配置）。"));
    }
    // Codex / ChatGPT 的菜单顺序是：先是当前模型的推理强度，再是模型列表。
    // 之前推理强度埋在列表底部，用户根本翻不到 —— 这也是"调推理强度没有"的来源。
    const curModel = MODELS.find((m) => m.id === modelId);
    if (curModel && curModel.efforts && curModel.efforts.length) {
      modelMenu.appendChild(el("div", "menu-head", "推理强度"));
      const row = el("div", "effort-row");
      for (const e of curModel.efforts) {
        const chip = el("button", "effort-chip" + (e.id === effortId ? " on" : ""), effortLabel(e.id));
        chip.type = "button";
        chip.title = e.description || e.id;
        chip.addEventListener("click", () => {
          effortId = e.id;
          renderPills();
          openModelMenu();
        });
        row.appendChild(chip);
      }
      modelMenu.appendChild(row);
      const d = curModel.efforts.find((e) => e.id === effortId);
      if (d && d.description) modelMenu.appendChild(el("div", "menu-note", d.description));
      modelMenu.appendChild(el("div", "menu-sep"));
    }

    modelMenu.appendChild(el("div", "menu-head", "模型"));

    for (const m of MODELS) {
      const row = el("button", "menu-item" + (m.id === modelId ? " on" : ""));
      row.type = "button";
      const main = el("span", "mi-main");
      main.appendChild(el("span", "mi-title", m.displayName));
      if (m.description) main.appendChild(el("span", "mi-desc", m.description));
      row.appendChild(main);
      if (m.id === modelId) row.appendChild(el("span", "mi-check", "✓"));
      row.addEventListener("click", () => {
        modelId = m.id;
        const has = m.efforts.some((e) => e.id === effortId);
        if (!has) effortId = m.defaultEffort || (m.efforts[0] && m.efforts[0].id) || "medium";
        renderPills();
        openModelMenu();     // 重画（推理档要跟着换）
      });
      modelMenu.appendChild(row);
    }

    placeMenu(modelMenu, modelPill, 300);
  }
  modelPill.addEventListener("click", (ev) => {
    ev.stopPropagation();
    if (modelMenu.style.display === "block") { hideMenus(); return; }
    hideMenus();
    openModelMenu();
  });

  /**
   * 推理强度独立菜单。
   *
   * 之前它藏在模型菜单底部，用户根本找不到 —— 而它恰恰是最常改的一档
   * （"把推理强度调高"比换模型频繁得多）。这里给它自己的 pill 与菜单：
   * 每一档一行，带那句英文说明，当前档打勾。
   */
  function openEffortMenu() {
    hideMenus();
    const model = MODELS.find((x) => x.id === modelId);
    modeMenu.innerHTML = "";
    modeMenu.appendChild(el("div", "menu-head", "推理强度"));
    if (!model || !model.efforts || !model.efforts.length) {
      modeMenu.appendChild(el("div", "menu-note", "当前模型没有可选的推理档。"));
      placeMenu(modeMenu, effortPill || modePill, 300);
      return;
    }
    for (const e of model.efforts) {
      const row = el("button", "menu-item" + (e.id === effortId ? " on" : ""));
      row.type = "button";
      const main = el("span", "mi-main");
      const t = el("span", "mi-title", effortLabel(e.id));
      t.appendChild(el("span", "mi-id-badge", e.id));
      main.appendChild(t);
      if (e.description) main.appendChild(el("span", "mi-desc", e.description));
      row.appendChild(main);
      if (e.id === effortId) row.appendChild(el("span", "mi-check", "✓"));
      row.addEventListener("click", () => {
        effortId = e.id;
        renderPills();
        hideMenus();
        toast("推理强度已切到「" + effortLabel(e.id) + "」", 1400);
      });
      modeMenu.appendChild(row);
    }
    modeMenu.appendChild(el("div", "menu-note", "推理强度越高越慢、越贵；" + model.displayName + " 的默认档是「" + effortLabel(model.defaultEffort || "medium") + "」。"));
    placeMenu(modeMenu, effortPill || modePill, 300);
  }

  if (effortPill) {
    effortPill.addEventListener("click", (ev) => {
      ev.stopPropagation();
      if (modeMenu.style.display === "block") { hideMenus(); return; }
      openEffortMenu();
    });
  }

  // ------------------------------------------------------------ 权限菜单
  function openModeMenu() {
    hideMenus();
    modeMenu.innerHTML = "";
    modeMenu.appendChild(el("div", "menu-head", "沙箱"));
    for (const m of MODES) {
      const row = el("button", "menu-item" + (m.id === mode ? " on" : ""));
      row.type = "button";
      const main = el("span", "mi-main");
      const t = el("span", "mi-title");
      t.appendChild(document.createTextNode(m.label));
      if (!m.available) t.appendChild(el("span", "mi-badge", "本机不可用"));
      main.appendChild(t);
      if (m.desc) main.appendChild(el("span", "mi-desc", m.desc));
      row.appendChild(main);
      if (m.id === mode) row.appendChild(el("span", "mi-check", "✓"));
      row.addEventListener("click", () => {
        mode = m.id;
        renderPills();
        hideMenus();
        if (!m.available) toast(SANDBOX_REASON || "这一档在当前设备上用不了", 2600);
      });
      modeMenu.appendChild(row);
    }
    if (!SANDBOX_AVAILABLE) modeMenu.appendChild(el("div", "menu-note", SANDBOX_REASON));

    // 第二段：审批策略
    modeMenu.appendChild(el("div", "menu-sep"));
    modeMenu.appendChild(el("div", "menu-head", "审批"));
    const eff = effectiveApproval();
    for (const a of APPROVALS) {
      const row = el("button", "menu-item" + (a.id === approval ? " on" : ""));
      row.type = "button";
      const main = el("span", "mi-main");
      const t = el("span", "mi-title", a.label);
      if (a.id === "auto" && eff !== "auto") t.appendChild(el("span", "mi-id-badge", "当前 → " + ((approvalDef(eff) || {}).short || eff)));
      main.appendChild(t);
      main.appendChild(el("span", "mi-desc", a.desc));
      row.appendChild(main);
      if (a.id === approval) row.appendChild(el("span", "mi-check", "✓"));
      row.addEventListener("click", () => {
        approval = a.id;
        renderPills();
        hideMenus();
        toast("审批策略：" + a.label, 1400);
      });
      modeMenu.appendChild(row);
    }
    placeMenu(modeMenu, modePill, 300);
  }
  modePill.addEventListener("click", (ev) => {
    ev.stopPropagation();
    if (modeMenu.style.display === "block") { hideMenus(); return; }
    openModeMenu();
  });
  $("btn-mode").addEventListener("click", (ev) => {
    ev.stopPropagation();
    if (modeMenu.style.display === "block") { hideMenus(); return; }
    openModeMenu();
  });

  // -------------------------------------------------------------- 设置菜单
  /**
   * 设置面板。
   *
   * ChatGPT 侧栏底部那个齿轮里其实就三类能改的东西：主题、工作目录、权限模式。
   * 这里不另做一套"设置页"，直接把这三样摊进一个菜单 —— 少一层点击，也不用
   * 维护第二个页面的布局。
   */
  function openSettings() {
    hideMenus();
    modeMenu.innerHTML = "";
    modeMenu.appendChild(el("div", "menu-head", "设置"));

    const theme = document.documentElement.getAttribute("data-theme");
    const themeRow = el("button", "menu-item");
    themeRow.type = "button";
    const themeMain = el("span", "mi-main");
    themeMain.appendChild(el("span", "mi-title", "主题"));
    themeMain.appendChild(el("span", "mi-desc", theme === "dark" ? "深色（当前）" : "浅色（当前）"));
    themeRow.appendChild(themeMain);
    themeRow.appendChild(el("span", "mi-badge", "切换"));
    themeRow.addEventListener("click", () => {
      applyTheme(document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark");
      hideMenus();
    });
    modeMenu.appendChild(themeRow);

    const cwdRow = el("button", "menu-item");
    cwdRow.type = "button";
    const cwdMain = el("span", "mi-main");
    cwdMain.appendChild(el("span", "mi-title", "工作目录"));
    cwdMain.appendChild(el("span", "mi-desc", shortCwd(cwd) || "~"));
    cwdRow.appendChild(cwdMain);
    cwdRow.appendChild(el("span", "mi-badge", "选择"));
    cwdRow.addEventListener("click", () => { hideMenus(); openDirSheet(); });
    modeMenu.appendChild(cwdRow);

    modeMenu.appendChild(el("div", "menu-sep"));
    modeMenu.appendChild(el("div", "menu-head", "沙箱"));
    for (const m of MODES) {
      const row = el("button", "menu-item" + (m.id === mode ? " on" : ""));
      row.type = "button";
      const main = el("span", "mi-main");
      const t = el("span", "mi-title");
      t.appendChild(document.createTextNode(m.label));
      if (!m.available) t.appendChild(el("span", "mi-badge", "本机不可用"));
      main.appendChild(t);
      if (m.desc) main.appendChild(el("span", "mi-desc", m.desc));
      row.appendChild(main);
      if (m.id === mode) row.appendChild(el("span", "mi-check", "✓"));
      row.addEventListener("click", () => {
        mode = m.id;
        renderPills();
        hideMenus();
        if (!m.available) toast(SANDBOX_REASON || "这一档在当前设备上用不了", 2600);
      });
      modeMenu.appendChild(row);
    }

    // 锚点选择：rail 在 <768 是 display:none（实测 #rail-settings 尺寸 0x0），
    // 手机上唯一能进设置/主题的入口是抽屉头部的 #panel-settings。
    // 拿一个 rect 宽为 0 的锚点会让 placeMenu 把菜单摆到左上角外面，所以这里
    // 先挑"真的看得见"的那个；两个都不可见时退回 body（placeMenu 会夹到视口内）。
    const railBtn = $("rail-settings");
    const drawerBtn = $("panel-settings");
    const visible = (n) => n && n.getBoundingClientRect().width > 0;
    const anchor = visible(railBtn) ? railBtn : (visible(drawerBtn) ? drawerBtn : document.body);
    placeMenu(modeMenu, anchor, 300);
  }

  // ------------------------------------------------------------ 主题 / 分享
  $("rail-theme").addEventListener("click", () => {
    const cur = document.documentElement.getAttribute("data-theme");
    applyTheme(cur === "dark" ? "light" : "dark");
  });
  $("btn-share").addEventListener("click", async () => {
    const url = location.origin + "/" + (authToken ? "?token=" + authToken : "");
    const ok = await copyText(url);
    toast(ok ? "链接已复制" : "复制失败", 1600);
  });
  $("rail-brand").addEventListener("click", newChat);
  $("rail-library").addEventListener("click", openDirSheet);
  $("panel-collapse").addEventListener("click", togglePanelCollapsed);
  $("rail-new").addEventListener("click", newChat);
  $("panel-new").addEventListener("click", newChat);
  $("rail-settings").addEventListener("click", () => openSettings());
  // 窄屏专用：rail 隐藏后，抽屉头部这颗齿轮是设置/主题的唯一入口。
  // 它必须先关抽屉再开菜单，否则抽屉(z 80)会盖住菜单(z 60)。
  const panelSettings = $("panel-settings");
  if (panelSettings) {
    panelSettings.addEventListener("click", () => {
      closePanel();
      openSettings();
    });
  }
  const btnSide = $("btn-side");
  if (btnSide) btnSide.addEventListener("click", toggleCodeside);

  // -------------------------------------------------------------- 输入区
  function autosize() {
    input.style.height = "auto";
    const max = Math.min(Math.round(window.innerHeight * 0.34), 200);
    input.style.height = Math.min(input.scrollHeight, max) + "px";
  }

  function refreshSend() {
    if (streaming) {
      // 生成中：有输入 → 按钮是"追加"（可用）；没输入 → 按钮是"停止"。
      const hasText = input.value.trim().length > 0;
      sendBtn.dataset.state = hasText ? "ready" : "busy";
      sendBtn.disabled = interruptRequested;
      sendBtn.setAttribute("aria-label",
        interruptRequested ? "正在停止" : (hasText ? "追加到当前轮次" : "停止"));
      if (stopBtn) stopBtn.hidden = false;
    } else {
      if (stopBtn) stopBtn.hidden = true;
      const has = input.value.trim().length > 0 || pendingImages.length > 0;
      sendBtn.dataset.state = has ? "ready" : "idle";
      sendBtn.disabled = !has;
      sendBtn.setAttribute("aria-label", "发送");
    }
  }

  input.addEventListener("input", () => { autosize(); refreshSend(); });

  // 停止键：独立方块按钮（生成中出现）
  if (stopBtn) stopBtn.addEventListener("click", (e) => { e.preventDefault(); stop(); });

  // 技能 chip：Codex 的技能来自 ~/.codex/skills，这个客户端只做说明
  if (skillPill) {
    skillPill.addEventListener("click", (ev) => {
      ev.stopPropagation();
      hideMenus();
      modeMenu.innerHTML = "";
      modeMenu.appendChild(el("div", "menu-head", "技能"));
      modeMenu.appendChild(el("div", "menu-note", "技能来自 ~/.codex/skills 与当前会话的 AGENTS.md。这个客户端不提供技能开关，需要时直接在输入里点名调用。"));
      placeMenu(modeMenu, skillPill, 300);
    });
  }
  input.addEventListener("focus", () => setTimeout(() => scrollToBottom(true), 220));
  const coarse = window.matchMedia && window.matchMedia("(pointer: coarse)").matches;
  input.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    if (e.isComposing) return;
    if (coarse || e.shiftKey || e.ctrlKey || e.metaKey) return;
    e.preventDefault();
    send();
  });
  composer.addEventListener("submit", (e) => {
    e.preventDefault();
    // 有输入就发送/追加；没输入且在跑 → 停止（跟 Codex 的 composer 一致）
    if (input.value.trim()) send();
    else if (streaming) stop();
  });
  sendBtn.addEventListener("click", (e) => {
    e.preventDefault();
    if (input.value.trim()) send();
    else if (streaming) stop();
  });

  function newChat() {
    if (streaming) { toast("正在生成，先等这一轮结束或点停止"); return; }
    closePanel();
    threadId = null;
    live = null;
    resetUsage();
    resetSessionSettings();
    setTitle("");
    thread.innerHTML = "";
    thread.appendChild(hero);
    showHero();
    input.focus();
    loadThreads();
  }

  // ------------------------------------------------------------ SSE 解析
  function parseFrames(buffer, onEvent) {
    let idx;
    while ((idx = buffer.indexOf("\n\n")) >= 0) {
      const raw = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      let name = "message";
      const dataLines = [];
      for (const line of raw.split("\n")) {
        if (line.startsWith(":")) continue;
        if (line.startsWith("event:")) name = line.slice(6).trim();
        else if (line.startsWith("id:")) {
          const n = Number(line.slice(3).trim());
          if (isFinite(n)) lastSeq = n;
        } else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
      }
      if (!dataLines.length) continue;
      let data = {};
      try { data = JSON.parse(dataLines.join("\n")); } catch { data = { text: dataLines.join("\n") }; }
      onEvent(name, data);
    }
    return buffer;
  }

  // -------------------------------------------------------------- 中断
  async function stop() {
    if (!streaming || interruptRequested) return;
    interruptRequested = true;
    refreshSend();
    setActivity("正在停止…", true);
    try {
      if (threadId) {
        await fetch("/api/interrupt", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ threadId }),
        });
      }
    } catch { /* 中断失败也不能把 UI 卡住 */ }
    clearTimeout(interruptTimer);
    if (!threadId) { try { controller && controller.abort(); } catch { /* 已断 */ } return; }
    interruptTimer = setTimeout(() => { try { controller && controller.abort(); } catch { /* 已断 */ } }, 6000);
  }

  // ---------------------------------------------------------- 一轮的读流
  let gotAny = false;
  let finishReason = "completed";
  let gotDone = false;
  let reconnected = false;
  let streamGen = 0;

  function handleEvent(name, data) {
    switch (name) {
      case "status":
        if (data.state === "starting") {
          setActivity("正在启动 Codex…", true);
        } else if (data.state === "ready") {
          setActivity("正在思考…", true);
        }
        break;

      case "thread":
        threadId = data.threadId || threadId;
        if (data.model) modelId = data.model;
        if (data.effort) effortId = data.effort;
        renderPills();
        if (data.reset) addNotice(data.reason || "会话已重置。");
        break;

      case "delta":
        gotAny = true;
        live.append(data.text || "");
        if (live.running === 0) setActivity("正在思考…", true);
        break;

      case "reasoning":
        live.reasoning(data.text || "");
        break;

      case "reasoning_done":
        // 权威摘要：如果后端给了 summary，用它覆盖流式拼出来的（防丢包）。
        if (live.think && typeof data.summary === "string" && data.summary.trim()
          && data.summary.trim().length > live.think.raw.trim().length) {
          live.think.raw = data.summary.trim();
          live.think.body.textContent = live.think.raw;
        }
        live.reasoningDone();
        break;

      case "plan":
        live.plan(data.items, data.explanation);
        break;

      case "turn_diff":
        live.diff(data.diff, threadId);
        break;

      case "tool": {
        const card = live.addTool({ id: data.id, name: data.name, input: data.input });
        setActivityCommand((VERBS[card.kind] || VERBS.generic).run + "：", card.activity.target);
        // 右侧「终端」面板：把每条命令记下来（跟消息流里的卡片是两份视图）
        const shown = targetOf(data.name, data.input) || data.name || "tool";
        terminalLines.push({ kind: "cmd", text: "$ " + shown });
        if (terminalLines.length > 400) terminalLines = terminalLines.slice(-400);
        if (codesideVisible() && codesideTab === "terminal") renderSideTerminal();
        break;
      }

      case "tool_delta":
        live.toolDelta(data.id, data.text || "");
        if (codesideVisible() && codesideTab === "terminal") {
          const tail = terminalLines[terminalLines.length - 1];
          if (tail && tail.kind === "out") tail.text += (data.text || "");
          else terminalLines.push({ kind: "out", text: (data.text || "") });
          renderSideTerminal();
        }
        break;

      case "tool_result": {
        live.toolResult(data.id, data.output, data.status, data.durationMs, data.exitCode);
        if (typeof data.output === "string" && data.output.trim()) {
          terminalLines.push({ kind: "out", text: data.output });
          if (terminalLines.length > 400) terminalLines = terminalLines.slice(-400);
          if (codesideVisible() && codesideTab === "terminal") renderSideTerminal();
        } else if (codesideVisible() && codesideTab === "terminal") {
          renderSideTerminal();
        }
        const still = [...live.cards.values()].filter((c) => c.state === "run");
        const last = still.length ? still[still.length - 1] : null;
        if (last && last.activity) setActivityCommand((VERBS[last.kind] || VERBS.generic).run + "：", last.activity.target);
        else setActivity("正在思考…", true);
        break;
      }

      case "approval":
        makeApprovalCard(live, data);
        setActivity("等待你的确认…", false);
        break;

      case "approval_resolved": {
        const card = live.approvals && live.approvals.get(data.id);
        if (card && card._resolve) card._resolve(data.choice, data.timeout);
        break;
      }

      case "usage":
        usageState = {
          used: data.used == null ? null : data.used,
          window: data.window == null ? null : data.window,
          input: data.input == null ? null : data.input,
          cached: data.cached == null ? null : data.cached,
          output: data.output == null ? null : data.output,
          reasoning: data.reasoning == null ? null : data.reasoning,
        };
        live.usage = usageState;
        if (typeof data.used === "number") sessionTokens = data.used;
        renderUsage();
        break;

      case "session":
        applySession(data);
        break;

      case "notice":
        addNotice(data.message || "");
        break;

      case "done": {
        gotDone = true;
        finishReason = data.reason || "completed";
        live.correct(data.text);
        if (!gotAny && !live.texts.length && !live.cards.size) live.empty = true;
        // 兜底：本轮改了文件但 app-server 没发 turn/diff/updated 时，用 git diff 补一张卡。
        const tid = threadId;
        if (tid && !live.diffCard) {
          fetch("/api/diff?threadId=" + encodeURIComponent(tid))
            .then((res) => res.json())
            .then((info) => {
              if (!info || !info.isRepo || !(info.fileCount > 0)) return;
              const stat = String(info.stat || "").trim();
              live.diff(stat, tid);
            })
            .catch(() => {});
        }
        break;
      }

      case "retry": {
        const code = data.code ? "（" + data.code + "）" : "";
        setActivity("上游出错，正在重试…" + code, true);
        break;
      }

      case "error":
        addError(data.message || "出错了");
        break;

      default:
        break;
    }
  }

  async function readStream(res) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      buf = parseFrames(buf, handleEvent);
    }
    buf += decoder.decode();
    if (buf.trim()) parseFrames(buf + "\n\n", handleEvent);
  }

  async function reconnect() {
    if (!threadId) return false;
    for (let attempt = 1; attempt <= 4 && !gotDone && !interruptRequested; attempt++) {
      setConn("offline", "重连中");
      setActivity("连接断了，正在重连（" + attempt + "/4）…", true);
      await sleep(attempt === 1 ? 400 : attempt * 900);
      if (gotDone || interruptRequested) return gotDone;
      try {
        const res = await fetch(
          "/api/attach?threadId=" + encodeURIComponent(threadId) + "&since=" + lastSeq,
          { signal: controller.signal, headers: { "X-Codex-Web-Build": BUILD } },
        );
        if (res.status === 404) {
          if (!gotDone) addNotice("连接断开期间这一轮已经结束了。");
          return true;
        }
        if (!res.ok) throw new Error("HTTP " + res.status);
        setActivity("正在思考…", true);
        await readStream(res);
        if (gotDone) return true;
      } catch (error) {
        if (error && error.name === "AbortError") return false;
      }
    }
    return gotDone;
  }

  async function runTurnStream(initialFetch) {
    const gen = ++streamGen;
    const stale = () => gen !== streamGen;
    try {
      const res = await initialFetch();
      if (stale()) return;
      if (!res.ok) {
        let msg = "HTTP " + res.status;
        try { msg = (await res.json()).error || msg; } catch { /* 非 JSON */ }
        throw new Error(msg);
      }
      await readStream(res);
    } catch (error) {
      if (stale()) return;
      if (error && error.name === "AbortError") {
        finishReason = "interrupted";
      } else if (!gotDone && threadId && !interruptRequested) {
        reconnected = await reconnect();
        if (stale()) return;
        if (!reconnected && !gotDone) {
          addError("连接断了，重连也没接上：" + String((error && error.message) || error)
            + "\n（这一轮可能还在后台跑，刷新页面可以看结果）");
        }
      } else {
        addError(String((error && error.message) || error));
      }
    } finally {
      if (stale()) return;
      clearTimeout(interruptTimer);
      const interrupted = interruptRequested || finishReason === "interrupted";
      streaming = false;
      live.settle(interrupted ? "interrupted" : "completed");
      live.finish();
      if (live.empty) addNotice("（没有文字输出）");
      setActivity("");
      setDot("");
      if (interrupted) addNotice("已中断");
      document.body.classList.remove("streaming");
      input.placeholder = "给 Codex 发消息…";
      setConn("connected", "已连接");
      renderQueue();
      refreshSend();
      scrollToBottom(false);
      loadThreads();
      if (codesideVisible()) renderCodesideTab(codesideTab);
    }
  }

  function setDot(state) {
    if (!activityDot) return;
    activityDot.dataset.state = state || "";
  }

  /**
   * 顶栏连接状态胶囊（Codex 的「● 已连接」）。
   *
   * 三态：connected（绿）/ working（黄，正在跑一轮）/ offline（灰，SSE 断了）。
   * 状态来自真实的 SSE 生命周期，不是装饰。
   */
  /** composer 左下角的队列指示（Codex 的「1/1 就绪」）。 */
  function renderQueue() {
    if (!queuePill || !queueLabel) return;
    queuePill.hidden = false;
    const n = streaming ? 1 : 0;
    queueLabel.textContent = streaming ? "1/1 运行中" : "1/1 就绪";
    queuePill.dataset.state = streaming ? "run" : "idle";
    queuePill.title = streaming ? "当前有 1 个轮次在跑" : "队列空闲";
  }

  function setConn(state, text) {
    const pill = $("conn-pill");
    if (!pill) return;
    pill.dataset.state = state;
    const label = $("conn-label");
    if (label) label.textContent = text;
  }

  function beginTurn() {
    controller = new AbortController();
    gotAny = false;
    finishReason = "completed";
    gotDone = false;
    reconnected = false;
    streaming = true;
    interruptRequested = false;
    // 生成中：placeholder 换成"追加"的口吻（Codex App 写「向当前轮次追加输入…」）
    document.body.classList.add("streaming");
    input.placeholder = "向当前轮次追加输入…";
    setConn("working", "运行中");
    renderQueue();
    terminalLines = [];
    refreshSend();
    setDot("busy");
  }

  /**
   * 追加到当前这一轮（Codex 的 steer）。
   *
   * Codex App 的输入框在一轮跑着的时候仍然可用，placeholder 写的就是
   * 「向当前轮次追加输入…」：发出去的是同一轮的补充指令，不是新一轮。
   * app-server 的 turn/steer 就是干这个的。
   */
  async function steer(text) {
    if (!text) return;
    input.value = "";
    autosize();
    refreshSend();
    if (!threadId) return;
    // 本地先把自己说的话显示出来（steer 没有 SSE 回包）
    addUser(text);
    try {
      const res = await fetch("/api/steer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ threadId, message: text }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || ("HTTP " + res.status));
      toast("已追加到当前轮次", 1400);
    } catch (error) {
      addError("追加失败：" + String((error && error.message) || error));
    }
  }

  async function send() {
    const text = input.value.trim();
    const images = pendingImages.slice();
    if (!text && !images.length) return;
    // 生成中：把输入当作"追加指令"发给同一轮，而不是拒绝。
    if (streaming) { steer(text); return; }
    input.value = "";
    autosize();
    if (!threadId && text) setTitle(text.length > 40 ? text.slice(0, 40) + "…" : text);
    lastUserText = text;
    addUser(text, images);
    pendingImages = [];
    renderAttachments();
    live = addAssistant();
    lastSeq = 0;
    beginTurn();
    setActivity("正在连接…", true);

    await runTurnStream(() => fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Codex-Web-Build": BUILD },
      body: JSON.stringify({
        threadId, message: text, cwd, mode, model: modelId, effort: effortId, approval,
        images: images.map((im) => im.path),
      }),
      signal: controller.signal,
    }));
  }

  async function attachActiveTurn(info) {
    if (streaming || !info || !info.threadId) return false;
    threadId = info.threadId;
    if (info.cwd || info.mode || info.model || info.effort) {
      applySession({ cwd: info.cwd, mode: info.mode, model: info.model, effort: info.effort });
    }
    if (info.title) setTitle(info.title);
    thread.innerHTML = "";
    thread.appendChild(hero);
    hideHero();
    live = addAssistant();
    lastSeq = 0;
    beginTurn();
    setActivity("正在接回后台这一轮…", true);
    addNotice("检测到有一轮还在后台生成，已自动接回。");
    await runTurnStream(() => fetch(
      "/api/attach?threadId=" + encodeURIComponent(threadId) + "&since=0",
      { signal: controller.signal, headers: { "X-Codex-Web-Build": BUILD } },
    ));
    return true;
  }

  async function resumeIfGenerating() {
    if (streaming) return false;
    try {
      const res = await fetch("/api/active", { cache: "no-store" });
      if (!res.ok) return false;
      const data = await res.json();
      const list = Array.isArray(data.active) ? data.active : [];
      if (!list.length) return false;
      return await attachActiveTurn(list[0]);
    } catch { return false; }
  }

  async function swapStream() {
    if (!threadId) return false;
    if (!streaming) return await resumeIfGenerating();
    const since = lastSeq;
    const old = controller;
    controller = new AbortController();
    const running = runTurnStream(() => fetch(
      "/api/attach?threadId=" + encodeURIComponent(threadId) + "&since=" + since,
      { signal: controller.signal, headers: { "X-Codex-Web-Build": BUILD } },
    ));
    try { old && old.abort(); } catch { /* 已断 */ }
    await running;
    return true;
  }

  // ---------------------------------------------------------- 版本 / 热更新
  async function syncBuild(initial) {
    try {
      const res = await fetch("/api/version", { cache: "no-store" });
      const data = await res.json();
      if (!data || !data.build) return;
      if (initial) { BUILD = data.build; renderFootnote(); return; }
      if (data.build !== BUILD) updateBar.style.display = "flex";
    } catch { /* 拿不到不影响聊天 */ }
  }
  function renderFootnote() {
    footnote.textContent = "localhost:3081 · 首次启动 Codex 约需 10–30 秒 · 版本 " + BUILD;
  }
  $("updatereload").addEventListener("click", () => location.reload());

  // -------------------------------------------------------------- PWA
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    });
  }

  // ---------------------------------------------------------- 演示数据（?demo=1）
  // 只用于视觉验收：把一段真实形状的对话塞进 DOM，不走网络。
  /** demo 专用：往右侧「终端」页签的数据源塞一行。
   *  真实回合由 SSE 的 tool / tool_result 喂 terminalLines（见 handleEvent），
   *  demo() 直接调 turn.addTool 绕过了 SSE，不塞的话终端页签永远是"还没跑过命令"。 */
  function demoTerminal(line) {
    terminalLines.push(line);
    if (terminalLines.length > 400) terminalLines = terminalLines.slice(-400);
    if (codesideVisible() && codesideTab === "terminal") renderSideTerminal();
  }

  function demo() {
    const BT = String.fromCharCode(96);
    const F = BT + BT + BT;
    // demo 不走 /api/models 与 /api/config，先塞一份最小真值，好让 pill / 副行 / 环境提示有内容。
    MODELS = [{
      id: "gpt-6.1-sol", model: "gpt-6.1-sol", displayName: "GPT-6.1-Sol",
      description: "Latest workhorse model for coding and everyday work.",
      isDefault: true, defaultEffort: "low",
      efforts: [
        { id: "low", description: "Fast responses with lighter reasoning" },
        { id: "medium", description: "Balances speed and reasoning depth" },
        { id: "high", description: "Greater reasoning depth" },
        { id: "xhigh", description: "Extra high reasoning depth" },
      ],
    }];
    MODES = [
      { id: "read-only", label: "只读", short: "只读", desc: "只读，不修改任何文件", available: false },
      { id: "workspace-write", label: "可写工作区", short: "可写", desc: "可修改工作目录内文件，不联网", available: false },
      { id: "danger-full-access", label: "全权限", short: "全权限", desc: "全权限，可改系统文件、联网", available: true },
    ];
    HOME_DIR = HOME_DIR || "/data/data/com.termux/files/home";
    SANDBOX_AVAILABLE = false;
    SANDBOX_REASON = "Android 10 没有 bubblewrap / user namespace / Landlock";
    renderEnvWarn();
    thread.innerHTML = "";
    thread.appendChild(hero);
    hideHero();
    addUser("给这个项目加一个把 Markdown 转纯文本的脚本，然后跑一遍自测。");
    const turn = addAssistant();
    turn.reasoning("先看项目结构，确认脚本放哪儿、用不用第三方依赖。");
    turn.reasoning("目录里已经有 tools/，把脚本放那儿，纯 Node 实现，不引依赖。");
    turn.reasoningDone();
    turn.append("我先看一下项目结构，然后把脚本放到 " + BT + "tools/" + BT + " 下。\n\n");
    turn.addTool({ id: "t1", name: "shell", input: { command: "ls -la && cat package.json" } });
    turn.toolDelta("t1", "total 152\ndrwx------  8 u0_a920 u0_a920 3488 Oct 17 09:15 .\n");
    turn.toolResult("t1", "total 152\n-rw-r--r--  1 u0_a920 u0_a920  333 package.json\ndrwx------  2 u0_a920 u0_a920 3488 Oct 17 09:15 public\ndrwx------  2 u0_a920 u0_a920 3488 Oct 17 09:15 tools\n", "completed", 820);
    demoTerminal({ kind: "cmd", text: "$ ls -la && cat package.json" });
    demoTerminal({ kind: "out", text: "total 152\n-rw-r--r--  1 u0_a920 u0_a920  333 package.json\ndrwx------  2 u0_a920 u0_a920 3488 public\ndrwx------  2 u0_a920 u0_a920 3488 tools" });
    turn.addTool({ id: "t2", name: "apply_patch", input: { changes: ["tools/md2txt.mjs"] } });
    turn.toolResult("t2", "tools/md2txt.mjs: added", "completed", 41);
    demoTerminal({ kind: "cmd", text: "$ apply_patch tools/md2txt.mjs" });
    demoTerminal({ kind: "out", text: "tools/md2txt.mjs: added" });
    turn.addTool({ id: "t3", name: "shell", input: { command: "node tools/md2txt.mjs README.md | head -5" } });
    turn.toolResult("t3", "# codex-web\n\n本地 Web 版 Codex 聊天界面。\n", "completed", 312);
    demoTerminal({ kind: "cmd", text: "$ node tools/md2txt.mjs README.md | head -5" });
    demoTerminal({ kind: "out", text: "# codex-web\n\n本地 Web 版 Codex 聊天界面。" });
    turn.plan([
      { step: "读项目结构，确定脚本位置", status: "completed" },
      { step: "实现 md2txt.mjs（无依赖）", status: "completed" },
      { step: "跑自测并检查输出", status: "inProgress" },
      { step: "更新 README 使用说明", status: "pending" },
    ], "依赖目录已确认，脚本放 tools/ 下与其它工具并列。");
    turn.append("脚本已就位，跑通了。核心就三步：\n\n1. 去掉围栏代码块的标记，保留代码正文；\n2. 行内标记剥掉符号；\n3. 链接压成 文字 (url)。\n\n"
      + F + "bash\n$ node tools/md2txt.mjs README.md | head -3\n# codex-web\n\n本地 Web 版 Codex 聊天界面。\n" + F + "\n\n"
      + "| 输入 | 输出 |\n|:--|:--|\n| " + BT + "**粗**" + BT + " | 粗 |\n| " + BT + "[a](b)" + BT + " | a (b) |\n\n"
      + "> 注意：表格里的管道符要先转义，否则会被当成列分隔。\n");
    demoDiffText = "diff --git a/tools/md2txt.mjs b/tools/md2txt.mjs\nnew file mode 100644\n--- /dev/null\n+++ b/tools/md2txt.mjs\n@@ -0,0 +1,8 @@\n+import { readFileSync } from \"node:fs\";\n+const src = readFileSync(process.argv[2], \"utf8\");\n+const out = src.replace(/\\*\\*(.+?)\\*\\*/g, \"$1\");\n+console.log(out);\n";
    makeApprovalCard(turn, { id: 1001, method: "ExecCommandApproval", command: "/data/data/com.termux/files/usr/bin/bash -lc 'npm run build && rm -rf dist/old'", cwd: "/data/data/com.termux/files/home/codex-web", reason: "构建产物需要清理旧目录" });
    turn.diff("diff --git a/tools/md2txt.mjs b/tools/md2txt.mjs\nnew file mode 100644\n--- /dev/null\n+++ b/tools/md2txt.mjs\n@@ -0,0 +1,8 @@\n+import { readFileSync } from \"node:fs\";\n+const src = readFileSync(process.argv[2], \"utf8\");\n+const out = src.replace(/\\*\\*(.+?)\\*\\*/g, \"$1\");\n+console.log(out);\n", "demo-thread");
    turn.settle("completed");
    turn.finish();
    setTitle("Markdown 转纯文本脚本");
    modelId = "gpt-6.1-sol";
    effortId = "low";
    applySession({ cwd: HOME_DIR + "/codex-web", mode: "danger-full-access", tokens: 18450, model: modelId, effort: effortId });
    usageState = { used: 18180, window: 258400, input: 18174, cached: 4224, output: 6, reasoning: 0 };
    turn.usage = usageState;
    turn.renderUsageFooter();
    renderUsage();
    setActivity("");
    scrollToBottom(true);
  }

  /**
   * 流式演示：走的是和真回合**同一套** DOM 装配函数（append / addTool / toolResult /
   * reasoning），只是数据源是本地定时器。所以这里看到的效果跟真跑一轮完全一致，
   * 用来核对光标、shimmer、卡片自动展开/收起、发送键 morph。
   */
  function demoStream() {
    const BT = String.fromCharCode(96);
    const F = BT + BT + BT;
    MODELS = [{ id: "gpt-6.1-sol", model: "gpt-6.1-sol", displayName: "GPT-6.1-Sol", description: "Latest workhorse model for coding and everyday work.", isDefault: true, defaultEffort: "low", efforts: [{ id: "low", description: "Fast responses with lighter reasoning" }, { id: "medium", description: "Balances speed and reasoning depth" }] }];
    MODES = [{ id: "danger-full-access", label: "全权限", short: "全权限", desc: "全权限，可改系统文件、联网", available: true, defaultApproval: "never" }];
    APPROVALS = [
      { id: "auto", label: "跟随沙箱档", short: "自动", desc: "只读/可写档会停下来问你，全权限档不问" },
      { id: "on-request", label: "按需确认", short: "按需", desc: "Codex 想越界操作时弹卡片等你点" },
      { id: "untrusted", label: "严格", short: "严格", desc: "非受信操作一律先问" },
      { id: "never", label: "从不询问", short: "不问", desc: "全自动，不打断" },
    ];
    approval = "on-request";
    HOME_DIR = HOME_DIR || "/data/data/com.termux/files/home";
    SANDBOX_AVAILABLE = false;
    SANDBOX_REASON = "Android 10 没有 bubblewrap / user namespace / Landlock";
    renderEnvWarn();
    modelId = "gpt-6.1-sol";
    effortId = "low";
    thread.innerHTML = "";
    thread.appendChild(hero);
    setTitle("流式演示");
    applySession({ cwd: HOME_DIR + "/codex-web", mode: "danger-full-access", tokens: 0, model: modelId, effort: effortId });

    addUser("帮我看一下这个项目的目录结构，然后跑一下测试。");
    const turn = addAssistant();
    streaming = true;
    refreshSend();
    setDot("busy");

    const steps = [];
    const push = (fn, delay) => steps.push({ fn, delay });

    push(() => { setActivity("正在启动 Codex…", true); }, 400);
    push(() => { setActivity("正在思考…", true); turn.reasoning("先看目录，确认项目类型和测试命令。"); }, 700);
    push(() => { turn.reasoning("是 Node 项目，用的是 node --test 风格的自测脚本。"); }, 600);
    push(() => { turn.reasoningDone(); setActivity("正在思考…", true); }, 500);

    const line1 = "我先看一下目录结构，然后把测试跑起来。\n\n";
    for (let i = 0; i < line1.length; i += 2) {
      const chunk = line1.slice(i, i + 2);
      push(() => turn.append(chunk), 45);
    }

    push(() => {
      const card = turn.addTool({ id: "s1", name: "shell", input: { command: "ls -la" } });
      setActivityCommand((VERBS[card.kind] || VERBS.generic).run + "：", card.activity.target);
      terminalLines.push({ kind: "cmd", text: "$ ls -la" });
      if (codesideVisible() && codesideTab === "terminal") renderSideTerminal();
    }, 500);
    const out1 = "total 152\ndrwx------  8 u0_a920 u0_a920  3488 public\ndrwx------  2 u0_a920 u0_a920  3488 src\ndrwx------  2 u0_a920 u0_a920  3488 tools\n";
    for (let i = 0; i < out1.length; i += 12) {
      const chunk = out1.slice(i, i + 12);
      push(() => turn.toolDelta("s1", chunk), 60);
    }
    push(() => {
      turn.toolResult("s1", out1, "completed", 640);
      terminalLines.push({ kind: "out", text: out1 });
      if (codesideVisible() && codesideTab === "terminal") renderSideTerminal();
    }, 400);

    push(() => {
      const card = turn.addTool({ id: "s2", name: "shell", input: { command: "npm test" } });
      setActivityCommand((VERBS[card.kind] || VERBS.generic).run + "：", card.activity.target);
      terminalLines.push({ kind: "cmd", text: "$ npm test" });
      if (codesideVisible() && codesideTab === "terminal") renderSideTerminal();
    }, 400);
    push(() => turn.toolDelta("s2", "✓ 协议翻译层 28 项\n"), 300);
    push(() => turn.toolDelta("s2", "✓ 前端流式 90 项\n"), 300);
    push(() => { turn.toolResult("s2", "✓ 协议翻译层 28 项\n✓ 前端流式 90 项\n\nALL OK\n", "completed", 2140); setActivity("正在思考…", true); }, 500);

    const tail = [
      "目录里有 " + BT + "public" + BT + "、" + BT + "src" + BT + " 和 " + BT + "tools" + BT + " 三块，测试都过了。\n\n",
      F + "bash\n$ npm test\n✓ 协议翻译层 28 项\n✓ 前端流式 90 项\nALL OK\n" + F + "\n\n",
      "结论：**结构清晰**，两条测试链都跑通，可以放心改前端。\n",
    ].join("");
    for (let i = 0; i < tail.length; i += 2) {
      const chunk = tail.slice(i, i + 2);
      push(() => turn.append(chunk), 42);
    }

    push(() => {
      turn.settle("completed");
      turn.finish();
      streaming = false;
      refreshSend();
      setDot("");
      setActivity("");
      usageState = { used: 21400, window: 258400 };
      renderUsage();
      scrollToBottom(true);
    }, 600);

    let t = 0;
    steps.forEach((s) => {
      t += s.delay;
      setTimeout(() => {
        if (new URL(location.href).searchParams.get("demo") !== "stream") return;
        s.fn();
        scrollToBottom(false);
      }, t);
    });
  }

  // ============================================================ 右侧多功能区
  /**
   * Codex App 的三栏里，右边那个面板装四样东西：文件树 / 终端 / 变更 / 上下文。
   * 我们用同一份后端能力拼出来：
   *   /api/dirs   → 目录（已经带 home 守卫）
   *   /api/thread/history 与 SSE 里的 tool 事件 → 已跑过的命令（终端）
   *   /api/diff / turn_diff → 变更
   *   usage 事件 + 当前 cwd → 上下文
   */
  const codeside = $("codeside");
  const codesideTabs = $("codeside-tabs");
  const filesPath = $("files-path");
  const filesBody = $("files-body");
  const terminalBody = $("terminal-body");
  const diffStat = $("diff-stat");
  const diffBody = $("diff-body");
  const contextBody = $("context-body");
  const CODESIDE_KEY = "codexweb.codeside";

  let codesideTab = "files";
  let codesideDir = "";
  /** 本轮跑过的命令与输出（终端面板的数据源，来自 tool / tool_delta / tool_result） */
  let terminalLines = [];
  /** demo 模式下展示用的 diff 文本（真实会话走 /api/diff/full） */
  let demoDiffText = "";

  /**
   * 右侧面板在本屏宽下是不是「全屏浮层」形态（<1280 是；≥1280 是 320px 第四列）。
   * 用一个 matchMedia 常量而不是 innerWidth，转屏/分屏时结果跟着变。
   */
  const narrowCodesideMql = window.matchMedia
    ? window.matchMedia("(max-width: 1279px)")
    : { matches: false };
  function narrowCodeside() { return !!narrowCodesideMql.matches; }

  function codesideVisible() {
    if (!codeside) return false;
    return !codeside.hidden;
  }

  function setCodesideOpen(on) {
    if (!codeside) return;
    codeside.hidden = !on;
    document.body.classList.toggle("codeside-open", on);
    if (!on) document.body.classList.remove("view-main");
    try { localStorage.setItem(CODESIDE_KEY, on ? "1" : "0"); } catch { /* 隐私模式 */ }
    if (on) renderCodesideTab(codesideTab);
  }

  function setCodesideTab(tab) {
    // 顶部 tab 栏：会话 / 文件 / 终端 / 变更 / 上下文。
    // 选"会话"时右侧面板回到 320px 窄栏；选其余任何一个时，这块面板铺满主区域
    // （Codex App 的 tab 就是这么切的：会话 | zsh | queue.ts 互斥显示）。
    if (tab === "chat") {
      document.body.classList.remove("view-main");
      // 窄屏（手机）上右侧面板是**全屏浮层**，没有 320px 窄栏这个形态。
      // 所以「会话」在手机上等价于「关掉浮层回到聊天」，否则屏幕上会留下
      // 一层什么都不渲染的整屏遮罩（pane 全 hidden，遮罩又盖住 stage）。
      if (narrowCodeside()) { setCodesideOpen(false); return; }
      codesideTab = codesideTab === "chat" ? "files" : codesideTab;
      for (const b of codesideTabs.querySelectorAll(".codeside-tab")) {
        b.classList.toggle("on", b.dataset.tab === "chat");
      }
      for (const pane of ["files", "terminal", "diff", "context"]) {
        const p = $("pane-" + pane);
        if (p) p.hidden = true;
      }
      return;
    }
    // 非「会话」页签：面板没开就先把面板打开。renderCodesideTab() 在 codeside.hidden
    // 时直接 return，所以以前"面板收起状态点页签"会把 pane 切成可见却一片空白
    // （实测：demo 里终端 0 行、变更 0 行，且 body 出现没有 codeside-open 配套的 view-main）。
    if (!codesideVisible()) setCodesideOpen(true);
    codesideTab = tab;
    document.body.classList.add("view-main");
    for (const b of codesideTabs.querySelectorAll(".codeside-tab")) {
      b.classList.toggle("on", b.dataset.tab === tab);
    }
    for (const pane of ["files", "terminal", "diff", "context"]) {
      const p = $("pane-" + pane);
      if (p) p.hidden = pane !== tab;
    }
    renderCodesideTab(tab);
  }

  function renderCodesideTab(tab) {
    if (!codesideVisible()) return;
    if (tab === "files") renderSideFiles();
    else if (tab === "terminal") renderSideTerminal();
    else if (tab === "diff") renderSideDiff();
    else renderSideContext();
  }

  async function renderSideFiles() {
    if (!filesBody) return;
    const dir = codesideDir || cwd || HOME_DIR;
    filesPath.textContent = shortCwd(dir);
    filesPath.title = dir;
    filesBody.innerHTML = "";
    filesBody.appendChild(el("div", "codeside-hint", "正在读取…"));
    let data;
    try {
      const res = await fetch("/api/dirs?path=" + encodeURIComponent(dir));
      data = await res.json();
      if (!res.ok) throw new Error(data.error || ("HTTP " + res.status));
    } catch (error) {
      filesBody.innerHTML = "";
      filesBody.appendChild(el("div", "codeside-hint", "读不了这个目录：" + String((error && error.message) || error)));
      return;
    }
    codesideDir = data.path;
    filesPath.textContent = shortCwd(data.path);
    filesPath.title = data.path;
    filesBody.innerHTML = "";
    if (data.parent) {
      const up = el("button", "side-row side-up", "..");
      up.type = "button";
      up.addEventListener("click", () => { codesideDir = data.parent; renderSideFiles(); });
      filesBody.appendChild(up);
    }
    const dirs = (data.dirs || []).filter((d) => !d.blocked);
    if (!dirs.length) filesBody.appendChild(el("div", "codeside-hint", "（空）"));
    for (const d of dirs) {
      const row = el("button", "side-row");
      row.type = "button";
      const ico = el("span", "side-ico");
      ico.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M4 6.8A1.8 1.8 0 0 1 5.8 5h3l1.7 2h8.7A1.8 1.8 0 0 1 21 8.8v8.4A1.8 1.8 0 0 1 19.2 19H5.8A1.8 1.8 0 0 1 4 17.2z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>';
      row.appendChild(ico);
      row.appendChild(el("span", "side-name", d.name));
      row.addEventListener("click", () => { codesideDir = d.path; renderSideFiles(); });
      filesBody.appendChild(row);
    }
  }

  function renderSideTerminal() {
    if (!terminalBody) return;
    terminalBody.innerHTML = "";
    if (!terminalLines.length) {
      terminalBody.appendChild(el("div", "codeside-hint", "这一轮还没跑过命令。跑起来后，命令与输出会实时出现在这里。"));
      return;
    }
    for (const line of terminalLines) {
      const node = el("div", "term-line" + (line.kind === "cmd" ? " cmd" : ""));
      node.textContent = line.text;
      terminalBody.appendChild(node);
    }
    terminalBody.scrollTop = terminalBody.scrollHeight;
  }

  async function renderSideDiff() {
    if (!diffBody) return;
    diffBody.innerHTML = "";
    // demo 模式没有真 threadId，用 demo() 塞进去的那段 diff 直接渲染。
    if (!threadId) {
      if (demoDiffText) {
        diffStat.textContent = "本轮改动（演示）";
        const card = makeDiffCard(demoDiffText, "demo-thread");
        if (card) { card.classList.add("open"); diffBody.appendChild(card); }
        return;
      }
      diffStat.textContent = "还没有会话";
      diffBody.appendChild(el("div", "codeside-hint", "先发一条消息，这一轮改动会出现在这里。"));
      return;
    }
    try {
      const res = await fetch("/api/diff?threadId=" + encodeURIComponent(threadId));
      const info = await res.json();
      if (!info || !info.isRepo) {
        diffStat.textContent = "不是 git 仓库";
        diffBody.appendChild(el("div", "codeside-hint", "当前工作目录不在 git 仓库里，没有 diff 可看。"));
        return;
      }
      diffStat.textContent = "本轮改动 · " + (info.fileCount || 0) + " 文件 +" + (info.insertions || 0) + " −" + (info.deletions || 0);
      const full = await fetch("/api/diff/full?threadId=" + encodeURIComponent(threadId));
      const data = await full.json();
      const text = String((data && data.diff) || "");
      if (!text.trim()) {
        diffBody.appendChild(el("div", "codeside-hint", "工作区干净。"));
        return;
      }
      const card = makeDiffCard(text, threadId);
      if (card) {
        card.classList.add("open");
        diffBody.appendChild(card);
      }
    } catch (error) {
      diffBody.appendChild(el("div", "codeside-hint", "读取失败：" + String((error && error.message) || error)));
    }
  }

  function renderSideContext() {
    if (!contextBody) return;
    contextBody.innerHTML = "";
    const rows = [
      ["工作目录", cwd || "~", "/api/dirs（受 $HOME 守卫）"],
      ["模型", (MODELS.find((m) => m.id === modelId) || {}).displayName || modelId || "—", "model/list"],
      ["推理强度", effortLabel(effortId || "medium"), "turn/start.effort"],
      ["权限模式", (modeDef(mode) || {}).label || mode || "—", "sandbox policy"],
      ["上下文用量", usageState.used != null ? fmtTokens(usageState.used) + (usageState.window ? " / " + fmtTokens(usageState.window) : "") : "—", "thread/tokenUsage/updated"],
      ["会话 tokens", sessionTokens ? fmtTokens(sessionTokens) : "—", "/usage"],
      ["会话 ID", threadId || "（新会话）", "thread/start"],
    ];
    const table = el("div", "ctx-table");
    for (const [k, v, src] of rows) {
      const r1 = el("div", "ctx-row");
      r1.appendChild(el("span", "ctx-key", k));
      r1.appendChild(el("span", "ctx-val", v));
      r1.appendChild(el("span", "ctx-src", src));
      table.appendChild(r1);
    }
    contextBody.appendChild(table);
  }

  if (codeside) {
    codesideTabs.addEventListener("click", (ev) => {
      const t = ev.target && ev.target.closest ? ev.target.closest(".codeside-tab") : null;
      if (!t) return;
      setCodesideTab(t.dataset.tab);
    });
    $("codeside-close").addEventListener("click", () => setCodesideOpen(false));
    $("files-up").addEventListener("click", () => { codesideDir = ""; renderSideFiles(); });
    $("diff-refresh").addEventListener("click", renderSideDiff);
  }

  // Ctrl/Cmd+1..4 切右侧面板、Ctrl/Cmd+\ 收起/展开
  function toggleCodeside() { setCodesideOpen(!codesideVisible()); }

  // -------------------------------------------------------------- 启动
  try {
    if (localStorage.getItem("codexweb.panelCollapsed") === "1") document.body.classList.add("panel-collapsed");
    // 右侧面板默认收起；用户开过一次就记住（宽屏下才有意义）
    if (localStorage.getItem(CODESIDE_KEY) === "1" && window.innerWidth >= 1280) {
      setCodesideOpen(true);
      // 打开时停在"会话"窄栏态，免得一进来就把聊天区藏起来
      codesideTab = "files";
      for (const b of codesideTabs.querySelectorAll(".codeside-tab")) {
        b.classList.toggle("on", b.dataset.tab === "chat");
      }
      document.querySelectorAll(".codeside-pane").forEach((p) => { p.hidden = true; });
    }
  } catch { /* 隐私模式 */ }
  refreshSend();
  autosize();
  renderPills();
  renderQueue();
  if (new URL(location.href).searchParams.get("demo") === "1") {
    demo();
    return;
  }

  // ?demo=stream：按真实节奏播一遍流式（用来验收光标、扫光、卡片状态、morph）。
  if (new URL(location.href).searchParams.get("demo") === "stream") {
    demoStream();
    return;
  }
  setEmptyState(true);
  setConn("connected", "已连接");
  if (tokenWasDirty && authToken) {
    // 链接被粘进多余字符（手机上很常见：全选复制时带上了 start.sh 的中文说明）。
    // 已经自动用干净的令牌恢复，这里只做一次告知，别让人以为令牌变了。
    addNotice("访问链接里混入了多余字符，已自动按本机令牌恢复。下次复制只取 http://…:3081/?token=… 那一段就行。");
  }
  if (!authToken) {
    addNotice("请从 Termux 复制完整链接访问（链接里带 ?token=…）");
  } else {
    loadConfig();
    loadThreads();
    syncBuild(true);
    resumeIfGenerating();
  }
  setInterval(() => syncBuild(false), 60000);

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && authToken) swapStream();
  });
})();