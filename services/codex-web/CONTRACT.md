# UI 契约（改造后 codex-web 前端）

> 本文件是 CSS / Markdown 渲染器 / 主逻辑三方共用的**唯一**命名契约。
> 任何一方都不许擅自改名。改名前先改本文件。

## 1. 文件划分

| 文件 | 职责 | 谁维护 |
|---|---|---|
| `public/index.html` | DOM 骨架（id 固定）、内联极少量启动脚本、`<link href="/app.css">` + `<script src="/markdown.js">` + `<script src="/app.js">` | lead |
| `public/app.css` | 全部样式（双主题 token、布局、组件、动效） | ui-css |
| `public/markdown.js` | `window.CodexMarkdown.render(text)` 纯函数渲染器 | md-render |
| `public/app.js` | SSE、状态机、渲染装配、菜单、主题切换 | lead |

服务端 `/app.css` `/app.js` `/markdown.js` 走静态白名单，`Cache-Control: no-store`（开发期）。

## 2. 顶层布局

```html
<html data-theme="dark">            <!-- light | dark -->
<body>
<div id="app">
  <nav class="rail" id="rail">…</nav>
  <aside class="panel" id="panel">…</aside>
  <div class="stage">
    <header class="topbar">…</header>
    <main class="scroller" id="scroller">
      <div class="thread" id="thread">…</div>
    </main>
    <div class="dock">
      <div class="activity" id="activity"></div>
      <form class="composer" id="composer">…</form>
      <div class="footnote" id="footnote"></div>
    </div>
  </div>
</div>
```

- `.rail` 52px；`.panel` 260px；`.thread` max-width 768px 居中。
- < 1024px：`.panel` 变成 overlay drawer（`.panel.open`），`.rail` 收成 52px 或隐藏（`.rail.compact`）。
- < 768px：单栏，`.thread` padding 16px，composer 圆角 24px。

## 3. 固定 id（app.js 直接 getElementById，不许改）

rail: `rail`, `rail-new`, `rail-search`, `rail-theme`, `rail-settings`
panel: `panel`, `panel-close`, `panel-new`, `panel-list`, `panel-foot`, `thread-search`, `panel-settings`
topbar: `topbar`, `btn-menu`, `thread-title`, `thread-sub`, `btn-cwd`, `btn-mode`, `btn-share`
thread: `scroller`, `thread`, `hero`, `hero-title`, `hero-sub`, `suggest-grid`
dock: `activity`, `activity-text`, `activity-dot`, `composer`, `input`, `send`, `model-pill`, `model-pill-label`, `mode-pill`, `mode-pill-label`, `cwd-pill`, `cwd-pill-label`, `usage`, `usage-fill`, `usage-text`, `footnote`, `attach`, `attach-file`, `attach-row`, `to-bottom`
menus: `model-menu`, `mode-menu`, `dir-sheet`, `dir-backdrop`, `dir-path`, `dir-body`, `dir-up`, `dir-close`, `dir-choose`, `dir-recent`
overlay: `drawer-backdrop`, `toast`, `updatebar`, `updatereload`, `env-warn`

## 3b. 固定 id —— 第 9 轮补录（app.js 用 `$("id")` 取，同样不许改）

app.js 直接取但 §3 漏记的 23 个：

```
rail:     rail-brand, rail-library, panel-collapse, btn-side
topbar:   conn-pill, conn-label, top-cwd-label, top-mode-label
dock:     queue-pill, queue-label, skill-pill, stop-btn
codeside: codeside, codeside-tabs, codeside-close,
          files-path, files-up, files-body,
          terminal-body, diff-stat, diff-refresh, diff-body, context-body
```

其余 8 个不在上面的枚举里，取值方式不同：

- `pane-files` / `pane-terminal` / `pane-diff` / `pane-context`：app.js 用拼接取
  （`$("pane-" + pane)`；`setCodesideTab()` 的两个分支各一处循环，遍历的就是这四个 pane）。
  **改名必须连拼接前缀 `"pane-"` 一起改**（实测在 app.js:3008 与 app.js:3023）。
- `app`：四列 grid 的容器，只有 CSS 用（`#app{grid-template-columns:…}`）。
- `cg-rail` / `cg-hero` / `tab-chat`：目前只有 index.html 里的锚点，app.js 与 app.css
  都没引用。**留着当定位锚，改名前先确认没有外部脚本依赖它。**

## 3c. `body` 状态类（四个，成套关系是硬约束）

| 类 | 由谁加/减 | 含义 |
|---|---|---|
| `streaming` | `beginTurn()` 加，回合结束减 | 有一轮在跑（composer placeholder 换追入口吻、queue pill 变运行中） |
| `panel-collapsed` | `togglePanelCollapsed()` | 左侧会话栏折叠 |
| `codeside-open` | `setCodesideOpen()` | 右侧多功能区可见（`#codeside` 的 `hidden` 属性与它**必须同步**） |
| `view-main` | `setCodesideTab()`（非 chat）加，`setCodesideOpen(false)` 与切回 chat 减 | 右侧面板铺满主区域，`.stage{display:none}` |

**成套规则（第 9 轮踩过，务必守住）**：出现 `view-main` 必须同时有 `codeside-open`。
`renderCodesideTab()` 第一行是 `if (!codesideVisible()) return;`，
所以 `setCodesideTab()` 在非 chat 分支必须先
`if (!codesideVisible()) setCodesideOpen(true);` 再赋 `codesideTab`，
否则 pane 切成可见却一行内容都不渲染（实测症状：demo 终端 0 行、变更 0 行）。
断言位置：`tools/stream-sim.js` 场景 `[m]`、`tools/e2e-tabs.cjs`。

## 3d. 顶部页签两态（`.codeside-tab[data-tab]`）

| data-tab | 效果 |
|---|---|
| `chat` | 去掉 `view-main`，回到 320px 窄栏；四个 pane 全 `hidden` |
| `files` / `terminal` / `diff` / `context` | 加 `codeside-open view-main`，对应 pane 可见并**真的渲染** |

`body.view-main` 时 `#app` 的 grid 变成 `52px 260px <剩余全宽>`（三列）。
快捷键 `Ctrl+1..4` 走 `setCodesideOpen(true)` + `setCodesideTab()`，与点页签等价。

## 3e. 窄屏专用入口 `.only-narrow`（第 10 轮，手机端）

`#panel-settings`（抽屉头部齿轮）是**手机上唯一的设置/主题入口**：
`rail` 在 <768 是 `display:none`（实测 `#rail-settings` 尺寸 0x0），
原来主题与设置只挂在 rail 上，手机上等于完全进不去。

复用既有类名 `.only-narrow`（<1024 显示、≥1024 隐藏），**没有发明新类名**。
再用 `@media (min-width: 768px) { #panel-settings { display: none } }`
把 768~1023 段收掉 —— 那段 rail 仍可见，两个齿轮会重复（实测扫过 11 个断点确认）。
这里必须用 **ID**：`.icon-btn`(0,1,0) 在前、`.only-narrow`(0,1,0) 在后才压得住，
而媒体查询不加特异性（同 §8 第 7 条那个坑）。

`openSettings()` 的锚点改成"挑一个 rect 宽度 > 0 的"：
`#rail-settings` → `#panel-settings` → `document.body`。
拿 0x0 的锚点会让 `placeMenu()` 把菜单摆到视口外。

**层叠事实（实测自 app.css，别记反）**：`.menu` z-index **60**，
窄屏抽屉 `.panel` z-index **80**。菜单**不**在抽屉之上，
所以 `#panel-settings` 的处理器必须**先 `closePanel()` 再 `openSettings()`**。
断言位置：`tools/e2e-mobile.cjs` 场景 `[5c]`（探针 `tools/page-settings-reach.src.js`）。

## 3f. 顶栏在 <768 收起 `#btn-cwd` / `#btn-mode`

实测 390px：`.topbar-actions` 占 304px（含这两颗 116+120），
标题容器只剩 **24px**，而 "Markdown 转纯文本脚本" 需要 178px → 显示成 "M··"。
这两颗与 composer 的 `#cwd-pill` / `#mode-pill` 是同一入口的重复，收起后标题拿到 268px。
目录入口在 <420 时 composer 那颗也被收（既有规则），但设置菜单里仍有"工作目录"一行，不会失去入口。


## 4. 消息 DOM（app.js 生成）

```html
<!-- 用户 -->
<div class="msg user"><div class="bubble">…</div>
  <div class="msg-actions"><button class="mini">复制</button></div></div>

<!-- 助手：一个 turn = 一个 .msg.assistant，内部按到达顺序 append -->
<div class="msg assistant">
  <div class="think" data-state="run|done">          <!-- 推理摘要，可折叠 -->
    <button class="think-head"><span class="think-dot"></span><span class="think-label">Thinking</span><span class="think-chev">›</span></button>
    <div class="think-body"></div>
  </div>
  <div class="md" data-stream="1">…CodexMarkdown.render() 的输出…</div>
  <div class="tool-group">
    <div class="tool-group-head">…</div>
    <div class="tool-card" data-state="run|ok|fail|stop">
      <button class="tool-head">
        <span class="tool-ico">…</span>
        <span class="tool-title"><b>运行</b><code>npm test</code></span>
        <span class="tool-meta">0.8s</span>
        <span class="tool-status"></span>
        <span class="tool-chev">›</span>
      </button>
      <pre class="tool-body"></pre>
    </div>
  </div>
  <div class="plan-card">…</div>            <!-- 可选 -->
  <div class="diff-card">…</div>            <!-- 可选 -->
  <div class="msg-actions">…</div>
</div>
```

规则：
- `.md[data-stream="1"]` 末尾自动加 `<span class="stream-caret"></span>`（由 app.js 拼）。
- `.tool-card[data-state="run"]` 头部转圈；`ok` 对勾；`fail` 叉；`stop` 方块。
- `.tool-card.open` 展开 `.tool-body`。
- 折叠：运行中自动 open，完成后自动 close（用户手动点过就不再自动）。

## 5. CodexMarkdown 契约

```js
window.CodexMarkdown = {
  /**
   * @param {string} text  原始 markdown（可能是不完整的流式片段）
   * @param {{streaming?:boolean}} [opts]
   * @returns {string} HTML 字符串（已转义，安全）
   */
  render(text, opts),
  /** 可选：把渲染结果里的代码块语言做一次高亮（内部实现，不导出也行） */
};
```

必须支持：围栏代码块（含语言名，未闭合时按"未闭合"渲染且不吞后文）、行内 code、粗体/斜体/删除线、标题 h1-h4、无序/有序列表（含嵌套一层）、引用块、水平线、链接（target=_blank rel=noreferrer）、表格（GFM）、任务列表 `- [x]`。
代码块输出结构固定：

```html
<div class="codeblock">
  <div class="code-head"><span class="code-lang">bash</span>
    <button class="code-copy" data-code="base64…">复制</button></div>
  <pre class="code-body"><code>…</code></pre>
</div>
```

`data-code` 存 **base64(UTF-8)** 原文，app.js 的复制按钮直接 `atob` → `TextDecoder` 还原。若不方便 base64，可改存 HTML 实体并在 app.js 用 `textContent` 读取——两方必须一致，以 base64 为准。

## 5b. 图片附件

composer 里 `.attach-row` 放缩略图：每个附件是
`<div class="attach-thumb"><img src="data:…"><button class="attach-del">×</button></div>`。
`#attach` 是 32×32 图标按钮，点开触发 `#attach-file`（`input[type=file][accept=image/*]`）。
上传走 `POST /api/upload {data:"data:image/...;base64,"}` → `{path}`，
发送时把 paths 放进 `/api/chat` 的 `images` 字段。

## 6. 主题 token（CSS 变量名固定）

`--bg --bg-sidebar --bg-elev --bg-elev-2 --bg-code --bg-code-head --text --muted --muted-2 --border --border-strong --btn-primary-bg --btn-primary-fg --accent --ok --warn --danger --diff-add-bg --diff-del-bg --r-xs --r-sm --r-md --r-lg --r-composer --rail-w --panel-w --thread-w --header-h --shadow-composer --shadow-menu --font-sans --font-mono`

取值见 `design-spec.md` §2.7（light/dark 两块，可整段粘贴）。

## 7. 动效

- hover 120ms ease；消息进入 160ms `cubic-bezier(.2,.8,.2,1)`（opacity+translateY(6px)）；
- 工具卡展开 180ms；菜单 140ms（opacity+translateY(4px)+scale(.98)）；
- 抽屉 220ms `cubic-bezier(.32,.72,0,1)`；
- 发送↔停止 150ms（图标 crossfade + rotate(90deg)，容器 scale(.92)→1）；
- 流式光标 `steps(2,start)` 1s infinite；
- `prefers-reduced-motion` 全关。
