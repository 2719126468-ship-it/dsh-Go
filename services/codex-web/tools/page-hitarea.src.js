// 热区外扩的**对照实验**：同一片坐标，分别在"关掉 ::before 热区"和"打开热区"
// 两种情况下取最近的可交互元素，逐点比对归属差异。
// 没有对照就无法断言"抢没抢邻居" —— 上一版直接拿 elementFromPoint 的父链判断，
// h.contains(el) 对任何祖先都成立，于是外侧全被判成"命中自己"，结论是假的。
//
// 由 tools/e2e-mobile.cjs 读成字符串并包进 IIFE 执行。
var INTERACTIVE = "button, a[href], [role=button], [data-tab], input, select, textarea";

function ownerAt(x, y) {
  var h = document.elementFromPoint(Math.round(x), Math.round(y));
  if (!h) return "viewport外";
  var t = h.closest ? h.closest(INTERACTIVE) : null;
  if (!t) return "无可交互";
  return (t.id || t.getAttribute("data-tab") || t.tagName || "?").slice(0, 20);
}

function probe(sel, name) {
  var el = document.querySelector(sel);
  if (!el || el.getBoundingClientRect().width === 0) return { name: name, skip: true };
  var r = el.getBoundingClientRect();
  var cy = r.top + r.height / 2;
  var ds = [1, 2, 3, 4, 6, 10];
  function sweep() {
    var L = [], R = [];
    ds.forEach(function (d) { L.push(d + ":" + ownerAt(r.left - d, cy)); });
    ds.forEach(function (d) { R.push(d + ":" + ownerAt(r.right + d, cy)); });
    return { L: L, R: R, C: ownerAt(r.left + r.width / 2, cy) };
  }
  var style = document.createElement("style");
  style.textContent = sel + "::before { content: none !important; }";
  document.head.appendChild(style);
  var without = sweep();               // 基线：没有热区
  style.remove();
  var withH = sweep();                  // 现状：有热区

  // 抢点击 = 基线命中"别的交互元素"，打开热区后变成命中自己
  var steals = [];
  for (var i = 0; i < ds.length; i++) {
    var b = without.L[i].split(":")[1], a = withH.L[i].split(":")[1];
    if (a === name && b !== name && b !== "无可交互" && b !== "viewport外") {
      steals.push("左" + without.L[i].split(":")[0] + "px 抢了 " + b);
    }
    b = without.R[i].split(":")[1]; a = withH.R[i].split(":")[1];
    if (a === name && b !== name && b !== "无可交互" && b !== "viewport外") {
      steals.push("右" + without.R[i].split(":")[0] + "px 抢了 " + b);
    }
  }
  // 有效性 = 基线拿不到的格子，现在归自己
  var gained = [];
  for (var j = 0; j < ds.length; j++) {
    if (without.L[j].split(":")[1] !== name && withH.L[j].split(":")[1] === name) gained.push("左" + ds[j] + "px");
    if (without.R[j].split(":")[1] !== name && withH.R[j].split(":")[1] === name) gained.push("右" + ds[j] + "px");
  }
  return {
    name: name, box: [Math.round(r.width), Math.round(r.height)],
    center: withH.C, without: { L: without.L, R: without.R }, withH: { L: withH.L, R: withH.R },
    steals: steals, gained: gained,
  };
}

return JSON.stringify([probe("#codeside-close", "codeside-close"), probe("#files-up", "files-up")]);
