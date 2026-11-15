// 手机上「设置 / 主题」入口的可达性（页内探针，由 tools/e2e-mobile.cjs 包 IIFE 执行）
// 背景：rail 在 <768 是 display:none，而主题与设置原来只挂在 rail 上 ——
// 实测 #rail-settings 尺寸 0x0、祖先 display:none:rail，手机上根本进不去。
//
// 探针顺序 = 真实操作顺序：先点 ☰ 开抽屉（齿轮在抽屉头部，抽屉关着时它
// 在 translateX(-280) 之外，elementFromPoint 必然拿不到 —— 上一版断言就
// 错在这里，把"抽屉没开"当成了"入口不可达"）。
//
// 层叠关系（从 app.css 实测出来的，不是猜的）：
//   .menu          z-index 60     （4139 行）
//   .panel 窄屏抽屉 z-index 80    （4589 行，@media max-width:1023）
// 所以菜单**并不**浮在抽屉之上。它能点到的唯一原因是 #panel-settings 的
// 处理器先调了 closePanel()。下面用 zMenu/zPanel 把这条依赖显式量出来，
// 万一有人以后把 closePanel 删了，这条断言会指出真正的原因。
var out = {};
var menuBtn = document.getElementById("btn-menu");
menuBtn.click();
await new Promise(function (res) { setTimeout(res, 500); });
out.drawerOpen = document.getElementById("panel").classList.contains("open");

var g = document.getElementById("panel-settings");
if (!g) return JSON.stringify({ missing: "没有 #panel-settings" });
var r = g.getBoundingClientRect();
var cs = getComputedStyle(g);
out.gear = [Math.round(r.width), Math.round(r.height), cs.display];
out.gearVisible = cs.display !== "none" && r.width > 0;

var hit = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
out.gearHit = !!hit && (hit === g || g.contains(hit));

var rr = document.getElementById("rail-settings").getBoundingClientRect();
out.railAlsoVisible = rr.width > 0;   // <768 应为 false：否则是重复入口

// 先量一次"抽屉开着 + 菜单开着"的层级关系，证明 closePanel 是必需的
var menu = document.getElementById("mode-menu");
out.zMenu = getComputedStyle(menu).zIndex;
out.zPanel = getComputedStyle(document.getElementById("panel")).zIndex;
out.menuBelowPanel = Number(out.zMenu) < Number(out.zPanel);

g.click();
await new Promise(function (res) { setTimeout(res, 450); });

var mr = menu.getBoundingClientRect();
out.menuDisplay = getComputedStyle(menu).display;
out.menuRect = [Math.round(mr.left), Math.round(mr.top), Math.round(mr.width), Math.round(mr.height)];
out.menuInViewport = mr.left >= 0 && mr.top >= 0 && mr.right <= innerWidth + 1 && mr.bottom <= innerHeight + 1;
out.drawerClosedFirst = !document.getElementById("panel").classList.contains("open");
var topAt = document.elementFromPoint(Math.round(mr.left + mr.width / 2), Math.round(mr.top + 20));
out.menuClickable = !!topAt && menu.contains(topAt);

var items = [].slice.call(menu.querySelectorAll(".menu-item"));
out.itemCount = items.length;
out.headText = (menu.textContent || "").trim().slice(0, 12);

var themeItem = items.filter(function (x) { return (x.textContent || "").indexOf("主题") >= 0; })[0];
out.hasThemeRow = !!themeItem;
if (themeItem) {
  var before = document.documentElement.getAttribute("data-theme");
  themeItem.click();
  await new Promise(function (res) { setTimeout(res, 350); });
  out.themeFrom = before;
  out.themeTo = document.documentElement.getAttribute("data-theme");
  out.themeSwitched = out.themeFrom !== out.themeTo;
  try { out.themeStored = localStorage.getItem("codexweb.theme"); } catch (e) { out.themeStored = "?"; }
  var again = [].slice.call(document.querySelectorAll("#mode-menu .menu-item"))
    .filter(function (x) { return (x.textContent || "").indexOf("主题") >= 0; })[0];
  if (again) again.click();
  await new Promise(function (res) { setTimeout(res, 250); });
}
return JSON.stringify(out);
