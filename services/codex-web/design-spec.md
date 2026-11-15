# Codex Web 视觉规范（对齐 chatgpt.com/codex）

> 目标：把本地 `public/index.html` 的移动端单栏界面，改造成与 ChatGPT Codex Web 一致的桌面优先三区布局 + 浅/深双主题。
> 本文所有数值按「可直接写进 CSS」的精度给出；来源分三类标注：
> **[实测]** = 从线上 DOM / 泄露的 CSS 变量 / 用户样式表反推；**[推导]** = 由同源设计系统按比例推算；**[工程值]** = 为落地选定的固定值（不追求像素级还原时用这个）。
> 不修改 `public/`、`server.js`；本文只是规范。

---

## 1. 布局结构

### 1.1 总体骨架（≥ 1024px）

```
┌──────┬────────────────┬───────────────────────────────────────────────┐
│ rail │ 会话列表 panel │ header 52px（面包屑/标题 + 右侧动作）          │
│ 52px │ 260px          ├───────────────────────────────────────────────┤
│      │                │                                               │
│ 图标 │ 分组：置顶/    │        内容列 max-width: 768px 居中            │
│ 导航 │ 项目/最近      │        （消息流，可滚动）                       │
│      │                │                                               │
│      │                │  ─────────────────────────────────────────    │
│      │                │  composer dock（渐变遮罩 + 输入卡 768px）      │
│      │                │  footnote 12px 居中                            │
└──────┴────────────────┴───────────────────────────────────────────────┘
```

| 区域 | 尺寸 | 说明 |
|---|---|---|
| 一级图标导航 rail | **52px** 宽，整高 | [实测] 折叠态 51px / 展开态 52px，仅图标 + tooltip；右侧 1px 分隔线 |
| 会话列表 panel | **260px**（可拖拽 220–320） | [实测] 260–280 区间；默认展开，窄屏变 drawer |
| header | **52px** 高 | [实测] 与 rail 顶部对齐；内容列顶部另有 24px 呼吸 |
| 内容列 | **max-width: 768px**，水平居中 | [实测] `--thread-content-max-width: 48rem`，Tailwind `max-w-(--thread-content-max-width)` |
| composer 卡 | 768px 宽，最小高 **52px**，最大 200px 后内部滚动 | [推导] 与内容列同宽同轴 |
| 内容列左右 padding | 24px（桌面）/ 16px（< 768px） | [工程值] |
| 消息垂直间距 | 用户消息 ↔ 助手消息 **24px**；同一轮内工具卡之间 8px | [工程值] |

### 1.2 断点

| 断点 | 行为 |
|---|---|
| ≥ 1280px | rail + panel + 内容列 + 右侧多功能区（320px，可收起） |
| 1024–1279px | rail + panel + 内容列 |
| 768–1023px | rail 折叠为 52px 悬浮按钮，panel 变 overlay drawer（280px） |
| < 768px | 单栏；header 52px；composer 贴底；内容列 padding 16px；圆角从 28px 降到 24px |

### 1.3 空态 hero

- 垂直居中偏上：内容列顶部留 18vh（min 96px / max 200px）。
- 标题：`Codex` 或当前工作区名，**28px / 600 / 1.2**，色 `--text-primary`。
- 副标题：14px / 400 / 1.5，色 `--text-secondary`，与标题间距 8px。
- 建议卡：2×2 网格（< 768px 单列），gap 8px，卡片高 **auto / min 56px**，宽 100%，最大总宽 640px 居中。
- composer 在 hero 下方 32px，hero 与 composer 一起垂直居中（`display:flex; flex-direction:column; justify-content:center`）。

---

## 2. 设计 Token 表

### 2.1 颜色 · Light

| 语义 | CSS 变量 | 值 | 用途 |
|---|---|---|---|
| 画布 | `--bg` | `#ffffff` | 内容区背景 [实测] |
| 侧栏 | `--bg-sidebar` | `#f9f9f9` | rail + 会话列表 [实测] |
| 次级面 | `--bg-elev` | `#f4f4f4` | 用户气泡、hover、菜单底 |
| 三级面 | `--bg-elev-2` | `#ececec` | 选中态、chip 底 |
| 代码面 | `--bg-code` | `#f6f6f6` | 代码块 body |
| 代码头条 | `--bg-code-head` | `#f0f0f0` | 代码块 header |
| 主文字 | `--text` | `#0d0d0d` | 正文/标题 [实测] |
| 次文字 | `--muted` | `#5d5d5d` | 元信息、说明 [实测] |
| 三级文字 | `--muted-2` | `#8f8f8f` | 占位符、disabled [实测] |
| 细线 | `--border` | `rgba(0,0,0,.08)` | 1px 分隔线 [实测 `#0000001a` 附近] |
| 强线 | `--border-strong` | `#e5e5e5` | 卡片轮廓 |
| 主按钮 | `--btn-primary-bg` | `#0d0d0d` | 发送键/主 CTA |
| 主按钮文字 | `--btn-primary-fg` | `#ffffff` | — |
| 品牌强调 | `--accent` | `#0d0d0d` | 该体系无色相强调，链接用墨色下划线 |
| 成功 / 警告 / 危险 | `--ok` `--warn` `--danger` | `#10a37f` `#f5a623` `#ef4146` | 仅状态点、diff 用 |
| diff 增 | `--diff-add-bg` | `#e6ffec` | 行底 |
| diff 删 | `--diff-del-bg` | `#ffebe9` | 行底 |
| 选中文本 | `--selection` | `rgba(13,13,13,.12)` | — |

### 2.2 颜色 · Dark

| 语义 | CSS 变量 | 值 | 用途 |
|---|---|---|---|
| 画布 | `--bg` | `#212121` | [实测] |
| 侧栏 | `--bg-sidebar` | `#171717` | [实测] |
| 次级面 | `--bg-elev` | `#2f2f2f` | 用户气泡 / hover |
| 三级面 | `--bg-elev-2` | `#3a3a3a` | 选中态 |
| 代码面 | `--bg-code` | `#171717` | [实测] |
| 代码头条 | `--bg-code-head` | `#1d1d1d` | [实测] |
| 主文字 | `--text` | `#ececec` | [实测] |
| 次文字 | `--muted` | `#b4b4b4` | [实测] |
| 三级文字 | `--muted-2` | `#8f8f8f` | — |
| 细线 | `--border` | `#3d3d3d` | [实测 `--border-light`] |
| 强线 | `--border-strong` | `#484848` | [实测 `--border-medium`] |
| 主按钮 | `--btn-primary-bg` | `#ffffff` | 深色下发送键为白底黑箭头 |
| 主按钮文字 | `--btn-primary-fg` | `#0d0d0d` | — |
| 强调 | `--accent` | `#ffffff` | — |
| diff 增 | `--diff-add-bg` | `rgba(46,160,67,.15)` | — |
| diff 删 | `--diff-del-bg` | `rgba(248,81,73,.15)` | — |

### 2.3 圆角

| Token | 值 | 用在哪 |
|---|---|---|
| `--r-xs` | 4px | 行内 code、diff 行 |
| `--r-sm` | 8px | 菜单项、小按钮、代码块 |
| `--r-md` | 12px | 卡片、工具卡、下拉菜单容器 |
| `--r-lg` | 16px | 大卡片、图片附件 |
| `--r-composer` | 28px（<768px 24px） | 输入卡 |
| `--r-full` | 9999px | 发送键、模型 pill、chip、头像 |

### 2.4 字体与排版

```css
--font-sans: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI",
             "PingFang SC", "Hiragino Sans GB", "Noto Sans CJK SC",
             "Microsoft YaHei", Roboto, sans-serif;
--font-mono: ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas,
             "Liberation Mono", monospace;
```

| 角色 | 字号 | 行高 | 字重 | 字距 | 备注 |
|---|---|---|---|---|---|
| Hero 标题 | 28px | 1.2 | 600 | -0.01em | 空态唯一大标题 |
| 页面/会话标题 | 16px | 1.4 | 600 | 0 | header 中央 |
| 正文（助手） | 16px | 1.75 | 400 | 0 | 长文可读性优先 [实测 1.65–1.75] |
| 正文（用户气泡） | 16px | 1.6 | 400 | 0 | — |
| UI 文本 | 14px | 1.45 | 500 | 0 | 侧栏行、按钮 |
| 元信息 | 12px | 1.4 | 500 | 0.01em | 时间戳、token 数 |
| 眉标 / section | 12px | 1.3 | 600 | 0.02em | "最近"、"项目" 分组标题 |
| 代码 | 13px | 1.5 | 400 | 0 | 代码块内 |
| 行内 code | 13px | 1.4 | 400 | 0 | padding 1px 5px，圆角 4px |

中文字号不缩放：正文 16px 在移动端保持 16px（避免 iOS 输入聚焦缩放，`font-size >= 16px` 于 textarea）。

### 2.5 间距刻度

4px 基数：`4 / 8 / 12 / 16 / 20 / 24 / 32 / 48 / 64`。
- 侧栏行内 padding：`6px 10px`（行高 32px）
- 卡片 padding：`12px 14px`；大卡片 16px
- 分组间距：24px；行间 2px
- header 内 padding：`0 16px`

### 2.6 阴影

| 层级 | 值 | 用在哪 |
|---|---|---|
| composer | `0 2px 8px rgba(0,0,0,.04), 0 0 0 1px var(--border)`（light）<br>`0 2px 8px rgba(0,0,0,.35), 0 0 0 1px var(--border)`（dark） | 输入卡 |
| menu | `0 8px 24px rgba(0,0,0,.12)` | 下拉、模型菜单 |
| drawer | `0 0 40px rgba(0,0,0,.18)` | 移动端会话抽屉 |
| 无 | 其余一律用 1px 边框表达层级 | 卡片、气泡 |

### 2.7 直接可粘贴的 `:root` 双主题块

```css
:root, [data-theme="light"]{
  --bg:#ffffff; --bg-sidebar:#f9f9f9; --bg-elev:#f4f4f4; --bg-elev-2:#ececec;
  --bg-code:#f6f6f6; --bg-code-head:#f0f0f0;
  --text:#0d0d0d; --muted:#5d5d5d; --muted-2:#8f8f8f;
  --border:rgba(0,0,0,.08); --border-strong:#e5e5e5;
  --btn-primary-bg:#0d0d0d; --btn-primary-fg:#ffffff;
  --accent:#0d0d0d; --ok:#10a37f; --warn:#f5a623; --danger:#ef4146;
  --diff-add-bg:#e6ffec; --diff-del-bg:#ffebe9;
  --r-xs:4px; --r-sm:8px; --r-md:12px; --r-lg:16px; --r-composer:28px;
  --rail-w:52px; --panel-w:260px; --thread-w:768px; --header-h:52px;
  --shadow-composer:0 2px 8px rgba(0,0,0,.04), 0 0 0 1px var(--border);
  --shadow-menu:0 8px 24px rgba(0,0,0,.12);
  --font-sans:ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Noto Sans CJK SC","Microsoft YaHei",Roboto,sans-serif;
  --font-mono:ui-monospace,"SF Mono",SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;
  color-scheme: light;
}
[data-theme="dark"]{
  --bg:#212121; --bg-sidebar:#171717; --bg-elev:#2f2f2f; --bg-elev-2:#3a3a3a;
  --bg-code:#171717; --bg-code-head:#1d1d1d;
  --text:#ececec; --muted:#b4b4b4; --muted-2:#8f8f8f;
  --border:#3d3d3d; --border-strong:#484848;
  --btn-primary-bg:#ffffff; --btn-primary-fg:#0d0d0d;
  --accent:#ffffff; --ok:#3ddc84; --warn:#ffb020; --danger:#ff6b6b;
  --diff-add-bg:rgba(46,160,67,.15); --diff-del-bg:rgba(248,81,73,.15);
  --shadow-composer:0 2px 8px rgba(0,0,0,.35), 0 0 0 1px var(--border);
  --shadow-menu:0 8px 24px rgba(0,0,0,.45);
  color-scheme: dark;
}
```

---

## 3. 组件规格

### 3.1 用户消息

- 右对齐；最大宽度 `min(85%, 640px)`。
- 背景 `--bg-elev`（light #f4f4f4 / dark #2f2f2f），**无边框**。
- 圆角 `20px`，右下角 `6px`（气泡方向感）。
- padding `10px 16px`；字体 16px/1.6；`white-space:pre-wrap; word-break:break-word`。
- 悬停时右上角出现「复制 / 编辑」图标按钮（24px，透明度 0 → 1，120ms）。
- 消息间距：与下一条助手消息 24px。

### 3.2 助手消息

- 左对齐，**无气泡无背景**，宽度 = 内容列 768px。
- 正文 16px/1.75，段间距 16px（`p + p`）。
- 列表：`padding-left: 1.5em`，`li` 间距 6px；有序列表同。
- 引用块：左 2px 实线 `--border-strong`，padding-left 12px，色 `--muted`。
- 链接：同色 + 1px 下划线（`text-decoration: underline; text-underline-offset: 2px`），hover 加粗到 500，不换色。
- 表格：`border-collapse: collapse`，单元格 `6px 12px`，1px `--border`，表头 `--bg-elev`。
- 顶部可选 24px 助手标记（Codex 图标），与首行基线对齐。
- 消息下方动作条（复制 / 重试 / 点赞）：高 28px，图标 16px，色 `--muted-2`，默认 `opacity:0`，消息 hover 或 `:focus-within` 时 `opacity:1`；粗指针设备常驻 `opacity:.6`。

### 3.3 代码块

```
┌────────────────────────────────────────────┐  ← header 34px，bg --bg-code-head
│ python                        [复制] [▾]  │     字号 12px/500，色 --muted
├────────────────────────────────────────────┤
│ def f():                                   │  ← body padding 12px 16px
│     return 1                               │     font 13px/1.5 --font-mono
└────────────────────────────────────────────┘
```

- 容器：`border-radius: 12px`，`border: 1px solid var(--border)`，`overflow: hidden`，外距 `12px 0`。
- header：高 **34px**，左右 padding `12px 10px`，语言名 12px/500 大写首字母，右侧图标按钮 **28×28**，圆角 6px，hover 底 `--bg-elev`。
- body：`overflow-x:auto`，`padding: 12px 16px`，行高 1.5，`tab-size: 2`。
- 语法高亮走低饱和：关键字 `#cf222e`(light)/`#ff7b72`(dark)，字符串 `#0a3069`/`#a5d6ff`，注释 `--muted-2` 斜体。
- 行内 code：`background: var(--bg-elev); border-radius: 4px; padding: 1px 5px; font-size: 13px`。

### 3.4 工具调用卡片

```
┌──────────────────────────────────────────────┐
│ ▸ 🖥  shell · ls -la          ✓ 0.8s   [展开] │  ← 单行 36px
└──────────────────────────────────────────────┘
  展开后 ↓
│ <pre> 输出 12px/1.5，max-height 320px 滚动 </pre>│
```

- 容器：宽 100%，`border:1px solid var(--border)`，`border-radius:12px`，`background:var(--bg)`，hover `--bg-elev`（120ms）。
- 头部行：高 **36px**，padding `0 10px`，gap 8px；图标 14px；标题 13px/500 `--text`；参数用 `--font-mono` 12px `--muted` 单行截断。
- 状态徽标：运行中 = 旋转 12px 环（`border:2px solid var(--border); border-top-color:var(--muted)`，0.8s linear infinite）；成功 = 对勾 12px `--ok`；失败 = `--danger`。
- 展开箭头 12px，展开时 `rotate(90deg)` 150ms。
- 输出区：`--bg-code`，`padding: 10px 14px`，12px/1.5 mono，`max-height: 320px`，上边 1px `--border`。
- 卡片之间间距 8px；一轮多个工具卡垂直堆叠，不缩进。

### 3.5 模型选择器 pill

- 位于 composer **左下角**，高 **28px**，padding `0 10px`，圆角 `9999px`，1px `--border`，背景透明，hover `--bg-elev`。
- 内容：12.5px/500 模型名 + 10px 下箭头（gap 4px），色 `--muted`，hover 变 `--text`。
- 点击弹出菜单：宽 **260px**，从按钮上边缘 8px 处弹出，圆角 12px，`--bg-elev`（dark #2f2f2f）+ 1px 边框 + `--shadow-menu`。
- 菜单项高 **40px**，padding `8px 10px`，两行：名称 14px/500、说明 12px `--muted`；选中项右侧对勾 14px；hover `--bg-elev-2`。
- 动效：`opacity 0→1, translateY(4px)→0, scale(.98)→1`，**140ms** `cubic-bezier(.2,.8,.2,1)`。

### 3.6 「思考中」状态

三档，按后端事件切换：

1. **首 token 前（thinking）**：一行 14px `--muted`，前面 14px 旋转环（0.8s linear），文案 "正在思考…"；下方 8px 处有 shimmer 条（高 2px，宽 120px，渐变扫光 1.6s linear infinite）。
2. **工具执行中（running）**：工具卡自带状态环；composer 上方 activity 行 12px `--muted`，左侧 10px 脉冲点（`opacity 1→.3` 1s ease-in-out infinite alternate）。
3. **流式中（streaming）**：正文末尾插入流式光标。

Shimmer keyframes：

```css
@keyframes shimmer{0%{background-position:-200% 0}100%{background-position:200% 0}}
.thinking-text{
  background:linear-gradient(90deg,var(--muted-2) 0%,var(--text) 45%,var(--muted-2) 90%);
  background-size:200% 100%;
  -webkit-background-clip:text;background-clip:text;color:transparent;
  animation:shimmer 1.6s linear infinite;
}
```

### 3.7 diff 卡片

```
┌──────────────────────────────────────────────┐
│ 📄 src/auth/login.ts        +12 −3   [展开]   │ ← 36px header
├──────────────────────────────────────────────┤
│ @@ -15,3 +15,8 @@                            │ ← hunk 头 12px --muted，bg --bg-elev
│   return jwt.sign(payload, secret);          │
│ + export function verifyToken(t) {           │ ← + 行 bg --diff-add-bg
│ − old line                                   │ ← − 行 bg --diff-del-bg
└──────────────────────────────────────────────┘
```

- 容器同工具卡（12px 圆角、1px 边框）；header 左文件名 13px/500 mono，右侧 `+n` 绿 / `−n` 红 12px。
- 正文 `--font-mono` 12.5px/1.6，行 padding `1px 12px`；行号列宽 40px、右对齐、`--muted-2`、`user-select:none`。
- 增行前缀 `+` 色 `#1a7f37`(light)/`#3fb950`(dark)；删行 `−` 色 `#cf222e`/`#f85149`。
- 折叠阈值：超过 **30 行**折叠，底部按钮 "查看完整 diff"（高 32px、圆角 8px、1px 边框），展开后 `max-height: 50vh` 内部滚动。
- 整块可点击标题栏展开/收起，箭头 150ms 旋转。

### 3.8 会话列表项

- 高 **32px**（两行版 44px），padding `6px 10px`，圆角 **8px**，行内 gap 8px。
- 标题 14px/500 `--text`，单行省略；副标题（时间 / 状态）12px `--muted-2`。
- 默认背景透明；hover `--bg-elev`（120ms）；当前项 `--bg-elev-2` 常驻，无左边框色条。
- 右侧行内动作（置顶 / 归档 / ⋯）：24px 图标，默认 `opacity:0`，行 hover 时出现；**标题截断必须先于动作按钮被挤掉**（`min-width:0` + `text-overflow:ellipsis`）。
- 分组标题："置顶 / 项目 / 最近"，12px/600 `--muted-2`，padding `12px 10px 4px`，可折叠（箭头 12px，展开 150ms）。
- 分组之间 16px 间距；列表区 `overflow-y:auto`，滚动条 6px 宽、`--border-strong` 圆角 9999px。
- 列表顶部渐变遮罩：`linear-gradient(var(--bg-sidebar) calc(100% - 24px), transparent)`，防止内容硬切。

### 3.9 空态建议卡片

- 2 列网格（gap 8px），单卡：`border:1px solid var(--border)`，圆角 **12px**，padding `12px 14px`，背景 `--bg`。
- 标题 14px/500 `--text`；可选说明 12px `--muted`；左上 16px 图标 `--muted`。
- hover：背景 `--bg-elev`，边框 `--border-strong`，`translateY(-1px)`，120ms。
- 高度 min 56px；文案单行截断到 2 行。

### 3.10 按钮

| 类型 | 尺寸 | 样式 |
|---|---|---|
| 发送 / 停止 | **32×32** 圆形 | 底 `--btn-primary-bg`，图标 `--btn-primary-fg`；disabled 时底 `--bg-elev`、图标 `--muted-2` |
| 图标按钮 | 32×32，圆角 8px | 透明底，hover `--bg-elev`；图标 16px，stroke 1.5 |
| 次按钮 | 高 32px，padding `0 12px`，圆角 8px | 透明底 + 1px `--border`，hover `--bg-elev` |
| 主按钮 | 高 32px，padding `0 14px`，圆角 9999px | 底 `--btn-primary-bg`，字 14px/600 |
| chip / pill | 高 28px，padding `0 10px`，圆角 9999px | 1px `--border`，12.5px/500 `--muted` |

### 3.11 composer 细节

- 容器：`display:grid; grid-template-columns: auto 1fr auto`（模型 pill | 输入 | 发送），第二行放附件/工具行。
- padding：`10px 10px 10px 12px`；`border-radius: 28px`；`box-shadow: var(--shadow-composer)`。
- textarea：无边框无背景，16px/1.5，`min-height: 24px`，`max-height: 200px` 后滚动，`padding: 6px 4px`。
- placeholder 色 `--muted-2`。
- 聚焦：外框 `box-shadow` 加 `0 0 0 1px var(--border-strong)`，**不换色相**（体系无色相强调）。
- 底部 dock：`position:sticky; bottom:0`，上方 24px 高渐变 `linear-gradient(transparent, var(--bg))` 覆盖滚动内容。
- 输入框上方若出现附件缩略图：48×48，圆角 12px，右上角 16px 删除按钮。

---

## 4. 动效规格

| 场景 | 时长 | 缓动 | 属性 |
|---|---|---|---|
| hover（行、按钮、卡片） | 120ms | `ease` | background-color, border-color |
| 焦点环出现 | 120ms | `ease-out` | box-shadow |
| 消息进入 | 160ms | `cubic-bezier(.2,.8,.2,1)` | opacity 0→1，translateY(6px)→0 |
| 工具卡展开 | 180ms | `cubic-bezier(.2,.8,.2,1)` | max-height / opacity；箭头 rotate 150ms |
| 下拉菜单 | 140ms | `cubic-bezier(.2,.8,.2,1)` | opacity + translateY(4px) + scale(.98) |
| 会话抽屉 | 220ms | `cubic-bezier(.32,.72,0,1)` | transform translateX(-100%)→0；遮罩 opacity 200ms |
| 侧栏展开/收起 | 260ms | `cubic-bezier(.16,1,.3,1)` | width / transform（不用 layout 抖动：用 transform + 内层 width） |
| 发送 ↔ 停止 morph | 150ms | `cubic-bezier(.4,0,.2,1)` | 图标 crossfade + rotate(90deg)，容器 scale(.92)→1 |
| 复制成功反馈 | 120ms in / 1200ms 停留 / 200ms out | `ease` | 图标替换 + opacity |
| 流式光标 | 1s | `steps(2, start)` infinite | opacity 1→0 |

### 4.1 流式光标

```css
.stream-caret{
  display:inline-block;width:2px;height:1.05em;
  margin-left:2px;vertical-align:-0.15em;
  background:currentColor;border-radius:1px;
  animation:caret 1s steps(2,start) infinite;
}
@keyframes caret{0%,50%{opacity:1}50.01%,100%{opacity:0}}
```

- 流式期间常驻在正文末尾；收到 `done` 后移除（淡出 120ms，避免闪断）。
- 不产生布局抖动：用 `inline-block` + `width:2px`，不要用伪元素撑行高。

### 4.2 发送 → 停止 morph

```
空输入：   [ ↑ ]  disabled，底 --bg-elev，箭头 --muted-2
有输入：   [ ↑ ]  底 --btn-primary-bg，箭头 --btn-primary-fg
流式中：   [ ■ ]  底 --btn-primary-bg（light 墨底白方块 / dark 白底黑方块）
```

- 同一 DOM 节点，切换 `data-state="idle|ready|busy"`。
- 图标 16px，两个 SVG 叠放，busy 时前一个 `opacity:0; transform:rotate(90deg) scale(.8)`，后一个反向入场，150ms。
- 容器在状态切换时 `transform: scale(.92)` → 1，150ms；不做颜色过渡（直接换 token 更利落）。
- 键盘：Enter 发送，Shift+Enter 换行；移动端 Enter 换行、点击发送。

### 4.3 降级

```css
@media (prefers-reduced-motion: reduce){
  *,*::before,*::after{animation-duration:.01ms!important;animation-iteration-count:1!important;transition-duration:.01ms!important}
  .stream-caret{animation:none;opacity:1}
}
```

---

## 5. 与现有 `public/index.html` 的映射（改造清单）

| 现有类 / 元素 | 目标 | 关键改动 |
|---|---|---|
| `:root` 深色单主题 | 双主题 | 换成 §2.7 的 token 块 + `data-theme` 切换 + `prefers-color-scheme` 默认 |
| `header`（10px 14px padding） | 52px header | 固定高 52px，去掉 `border-bottom`，改 1px `--border` 仅在有滚动时出现 |
| `.wrap{max-width:820px}` | 768px | 改 `--thread-w:768px`，`margin:0 auto` |
| `.bubble-user`（accent-soft 蓝底） | 中性气泡 | 去掉 `--accent-soft`/`#2b3d61`，改 `--bg-elev` + 20px 圆角 |
| `.assistant .body{white-space:pre-wrap}` | 富文本 | 需要 markdown 渲染；无渲染时至少保留 16px/1.75 |
| `.assistant pre`（10px 圆角） | 代码块组件 | 加 header 34px + 复制按钮，12px 圆角 |
| `.tool` 卡片 | 工具卡 §3.4 | 36px 头 + 状态徽标 + 输出区 320px 上限 |
| `.composer`（16px 圆角） | 28px 胶囊 | grid 布局，模型 pill 移入卡内左下 |
| `#send`（文字"发送"） | 32px 圆形图标 | 文字换 SVG，morph 停止键 |
| `.drawer`（84vw 抽屉） | 桌面 panel | ≥1024px 常驻 260px；<1024px 保留 drawer |
| `.chip`（单列建议） | 2×2 网格 | 12px 圆角、56px 最小高 |
| `.badge` 模型徽标 | 模型 pill | 移到 composer 内 |
| `.dot` 状态灯 | 保留 | 10px，位置移到 header 左侧或侧栏底部 |

---

## 6. 验收清单（像素级自查）

1. 1920px 视口：rail 52 + panel 260，内容列左边界 = `(1920-52-260-768)/2 + 312`，实际测 `getBoundingClientRect().width === 768`。
2. 切换 `data-theme`，页面无任何遗留蓝色（`#4f8cff`、`#1d2a44`、`#2b3d61` 全部消失）。
3. 深色下 `body` 背景 `rgb(33,33,33)`，侧栏 `rgb(23,23,23)`，代码块 `rgb(23,23,23)`。
4. 发送按钮：空输入 `aria-disabled`，尺寸 32×32，`border-radius:9999px`。
5. 流式输出时末尾光标可见且不引起横向抖动（滚动条宽度不变）。
6. 代码块 header 高 34px，复制按钮 28×28，语言名 12px。
7. 工具卡展开后 `max-height` ≤ 320px 且内部滚动。
8. 会话列表 hover 背景 `--bg-elev`，选中 `--bg-elev-2`，两者可区分。
9. `prefers-reduced-motion` 下无持续动画。
10. 移动端 375px：无横向滚动，textarea 字号 ≥ 16px（防 iOS 缩放）。

---

## 7. 参考链接

**设计 token / 变量（一手与近一手）**
- ChatGPT Neutral Dark + Sharp UI（含大量真实 `--main-surface-*`、`--sidebar-surface-*`、`--color-background-composer-surface`、`--thread-*` 变量名与取值）：https://userstyles.world/style/30388/chatgpt-neutral-dark-sharp-ui
- 该样式表源码：https://userstyles.world/api/style/30388.user.css
- ChatGPT OLED 用户样式（`--main-surface-primary #212121`、`--sidebar-surface-primary #171717` 的极简取值）：https://userstyles.world/api/style/23651.user.css
- Design Atlas · ChatGPT 风格参考（`#f9f9f9` 侧栏、`#0d0d0d` 墨色、`#0000001a` 细线、10px 圆角、24px 显示层级）：https://geoffreymanda.github.io/design-atlas/styles/chatgpt.html
- 受 OpenAI 启发的设计系统（中文，含完整字阶表 12/13/14/16/18/20/28/40/56 与 4px 间距刻度）：https://github.com/nexu-io/open-design/blob/main/design-systems/openai/DESIGN-zh.md
- OpenAI Color Palette（品牌色 `#10a37f` 系）：https://colorarchive.org/brands/openai/

**内容列宽度（768px 的直接证据）**
- ChatGPT Comfortable Reading Width 插件：明确写出 `--thread-content-max-width: 48rem (768px)`，通过 `max-w-(--thread-content-max-width)` 生效：https://github.com/nagi-ovo/gemini-voyager/blob/main/src/features/plugins/catalog/sites/chatgpt/plugins/reading-width/README.md

**Codex 界面结构（三栏 / 任务列表 / diff / 终端）**
- Codex App Interface Guide（三栏布局、任务状态图标、Approve/Reject/Edit、快捷键、设置默认值）：https://web-tutorial.com/codex/app-interface.html
- Codex Web Version（`chatgpt.com/codex` 入口、云沙箱、并行任务）：https://web-tutorial.com/codex/web.html
- Codex Theme Design Playbook（官方原生 token 全表：`bg-primary`、`main-surface-primary`、`side-bar-background`、`text-code-block-background`、`conversation-summary-leading` 等；并列出 Home/Conversation/Sidebar/Header/Settings/Menus/Output-Diff/Terminal 九个必须分别验收的 surface）：https://github.com/codexthemes/skills/blob/main/skills/codex-theme-creator/references/design-playbook.md
- Codex App UI redesign 讨论（2026-09 引入左侧栏版本，含版本号 26.924.22138 与交互回归）：https://community.openai.com/t/the-new-codex-app-ui-redesign-is-insanely-laggy/1401335
- 优设 · 看懂 ChatGPT 改版（一级图标导航 + 内容空间两层信息架构的动因）：https://www.uisdc.com/hunter/0221685294.html
- 优设 · 解析 Codex 多线程工作台设计（`/side` 侧边对话、多线程工作台）：https://www.uisdc.com/hunter/0221668979.html
- Codex Cloud 使用指南（任务生命周期、环境、PR）：https://coding.stormzhang.ai/codex/10-cloud

**composer 解剖**
- Recreating the ChatGPT-Style Composer（圆角胶囊、内嵌模型选择器、麦克风↔发送单按钮 morph 的成因）：http://mems2018.org/recreating-the-chatgpt-style-composer-anatomy-of-a-modern-ai-prompt-box
- Prompt bar 组件规范（模型选择器 176px 菜单、输入上限 136px 后滚动、菜单 180ms/高亮滑动 220ms、圆角 14px↔24px 随换行变化）：https://brunodelorence.com/components/prompt-bar.md
- ChatGPT composer scene（greeting + 建议 chip + voice-to-send morph 的动效参考实现）：https://remotionui.com/docs/components/chat-gpt.md
- Chrome 渲染回归：composer `border-radius` + `overflow:clip` 会裁切输入内容（落地时注意 `overflow` 与圆角组合）：https://community.openai.com/t/chrome-regression-chat-composer-input-clipped-when-container-uses-border-radius-overflow-clip/1372879

**字体**
- OpenAI 字阶与字体栈（Söhne / Inter 回退、Signifier 仅用于编辑型标题、产品 UI 全无衬线）：同 nexus-io DESIGN-zh 与 Design Atlas 两篇
