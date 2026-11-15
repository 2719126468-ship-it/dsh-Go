/* 令牌净化回归：脏 token 绝不能让界面全挂。
 *
 * 事故原貌：手机上从 Termux 复制访问链接时带进了中文/全角字符，那个脏值
 * 被写进 localStorage；之后 headers.set("X-Auth-Token", 脏值) 同步抛
 * TypeError（String contains non ISO-8859-1 code point），而它包在
 * window.fetch 里 —— 于是每个请求都挂，界面变成空壳，而且异常发生在
 * fetch 之前，连错误提示都发不出来。
 *
 * 用法: node tools/e2e-token-sanitize.cjs
 *   前置: server.js 在 3081、chromium --headless=new --remote-debugging-port=9222
 *
 * 注意：ev() 收的是**函数体**（可以写 return），内部统一包成 IIFE。
 * Runtime.evaluate 直接喂 "return ..." 会得到 SyntaxError，而且这个错误
 * 是放在 result 里（subtype=error）而不是 exceptionDetails —— 上一版这里
 * 误判成"应用坏了"，实际是探针写错。
 */
const http = require('http');
const fs = require('fs');

const TOK = fs.readFileSync(__dirname + '/../.token', 'utf8').trim();
const BASE = 'http://127.0.0.1:3081';

const get = (u) => new Promise((res, rej) => http.get(u, (r) => {
  let s = ''; r.on('data', (d) => s += d); r.on('end', () => res(s));
}).on('error', rej));

let passes = 0, failures = 0;
function check(label, cond, detail) {
  if (cond) { passes++; console.log('  \u2713 ' + label); }
  else {
    failures++;
    console.log('  \u2717 ' + label + (detail === undefined ? '' : '  \u2192 ' + String(detail).replace(/\s+/g, ' ').slice(0, 200)));
  }
}

(async () => {
  const list = JSON.parse(await get('http://127.0.0.1:9222/json/list'));
  const page = list.find((t) => t.type === 'page');
  if (!page) throw new Error('CDP 没有 page target');

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const errs = [];
  ws.onmessage = (msg) => {
    const m = JSON.parse(msg.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      m.error ? p.rej(new Error(m.error.message)) : p.res(m.result);
      return;
    }
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      errs.push(((d.exception && d.exception.description) || d.text || '').split('\n')[0]);
    }
  };
  await new Promise((r) => { ws.onopen = r; });

  const send = (method, params) => new Promise((res, rej) => {
    const mid = ++id; pending.set(mid, { res, rej });
    ws.send(JSON.stringify({ id: mid, method, params }));
  });

  // 函数体 → IIFE；同时识别 result.subtype==="error"（语法错误走这里）
  const ev = async (body) => {
    // send() 已经把 CDP 的 m.result 解出来了，所以真正的 RemoteObject 在 r.result。
    // （上一版写成 r.value，恒为 undefined，于是 9 项断言全线假红——探针的错，不是应用的。）
    const r = await send('Runtime.evaluate', {
      expression: '(function(){' + body + '})()', returnByValue: true, awaitPromise: true,
    });
    const obj = r.result || {};
    if (r.exceptionDetails) throw new Error('页面表达式异常: ' + (r.exceptionDetails.text || ''));
    if (obj.subtype === 'error') throw new Error('表达式语法错误: ' + (obj.description || '').split('\n')[0]);
    return obj.value;
  };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  await send('Runtime.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });

  const isHex = (v) => typeof v === 'string' && /^[0-9a-f]{32}$/.test(v);

  console.log('[0] 基线：干净令牌');
  await send('Page.navigate', { url: BASE + '/?token=' + TOK });
  await wait(3000);
  check('干净令牌能拉到会话接口', (await ev('return fetch("/api/threads").then(function(r){return r.status})')) === 200);
  check('localStorage 存的是 32 位 hex', isHex(await ev('return localStorage.getItem("codex-web-token")')),
    await ev('return localStorage.getItem("codex-web-token")'));

  // 1a. 可救：脏值里包含完整的 32 位 hex（就是多粘了尾巴，手机上是主流情况）
  console.log('[1a] localStorage 存了「完整 hex + 中文尾巴」→ 应自动恢复');
  await ev('localStorage.setItem("codex-web-token", "' + TOK + '中文残留"); return 1');
  errs.length = 0;
  await send('Page.navigate', { url: BASE + '/' });
  await wait(4000);
  const stored1a = await ev('return localStorage.getItem("codex-web-token")');
  check('没有未捕获异常（旧版在这里整页挂掉）', errs.length === 0, errs.slice(0, 2).join(' | '));
  check('从脏值里抠回完整令牌并写回 localStorage', stored1a === TOK, JSON.stringify(stored1a));
  check('请求恢复可用（/api/threads 回 JSON 数组）',
    await ev('return fetch("/api/threads").then(function(r){return r.json()}).then(function(j){return Array.isArray(j.threads)})'));
  check('会话列表真的渲染出来', (await ev('return document.querySelectorAll("#panel-list .sess").length')) > 0,
    await ev('return document.querySelectorAll("#panel-list .sess").length'));

  // 1b. 不可救：hex 被截断了（少几位），谁也没法凭空补出来
  console.log('[1b] localStorage 存了截断的脏值 → 应降级为未认证并明确提示');
  await ev('localStorage.setItem("codex-web-token", "' + TOK.slice(0, 20) + '中文残留"); return 1');
  errs.length = 0;
  await send('Page.navigate', { url: BASE + '/' });
  await wait(4000);
  const stored1b = await ev('return localStorage.getItem("codex-web-token")');
  check('没有未捕获异常', errs.length === 0, errs.slice(0, 2).join(' | '));
  check('绝不把非 latin1 的值留在 localStorage',
    stored1b === null || /^[\x20-\x7E]*$/.test(stored1b), JSON.stringify(stored1b));
  check('请求仍然发得出去（拿到状态码而不是抛 TypeError）',
    typeof (await ev('return fetch("/api/threads").then(function(r){return r.status})')) === "number",
    await ev('return fetch("/api/threads").then(function(r){return r.status})'));
  check('界面不是空壳，且有可读提示',
    (await ev('return document.querySelectorAll(".notice-box").length')) > 0,
    await ev('return document.body.textContent.slice(0,80)'));
  check('提示里说要带 token 的链接',
    await ev('return Array.prototype.some.call(document.querySelectorAll(".notice-box"), function(n){return n.textContent.indexOf("token")>=0})'));

  console.log('[2] URL 里就带脏 token（全选复制 start.sh 那行，手机上最常见）');
  await ev('localStorage.clear(); return 1');
  errs.length = 0;
  await send('Page.navigate', { url: BASE + '/?token=' + encodeURIComponent(TOK + '（本机的）') });
  await wait(4000);
  check('没有未捕获异常', errs.length === 0, errs.slice(0, 2).join(' | '));
  const stored2 = await ev('return localStorage.getItem("codex-web-token")');
  check('从脏值里抠出的真令牌被持久化（下次从主屏进也不用重贴）', stored2 === TOK, JSON.stringify(stored2));
  check('会话列表真的渲染出来', (await ev('return document.querySelectorAll("#panel-list .sess").length')) > 0,
    await ev('return document.querySelectorAll("#panel-list .sess").length'));
  check('给了一次可读提示而不是静默',
    await ev('return Array.prototype.some.call(document.querySelectorAll(".notice-box"), function(n){return n.textContent.indexOf("混入")>=0})'));

  console.log('[3] 彻底救不回来的脏值（抠不出 hex）');
  await ev('localStorage.clear(); return 1');
  errs.length = 0;
  await send('Page.navigate', { url: BASE + '/?token=' + encodeURIComponent('只有中文') });
  await wait(4000);
  check('不因非法字符抛异常（宁可当作没有令牌）', errs.length === 0, errs.slice(0, 2).join(' | '));
  const stored3 = await ev('return localStorage.getItem("codex-web-token")');
  check('没有把非 latin1 的值写进 localStorage',
    stored3 === null || stored3 === '' || /^[\x20-\x7E]*$/.test(stored3), JSON.stringify(stored3));
  check('提示用户去复制带 token 的链接',
    await ev('return Array.prototype.some.call(document.querySelectorAll(".notice-box"), function(n){return n.textContent.indexOf("token")>=0})'));

  console.log('');
  console.log(failures ? '\u2717 ' + failures + ' 项失败（通过 ' + passes + '）' : 'ALL OK（' + passes + ' 项）');
  await send('Emulation.clearDeviceMetricsOverride');
  ws.close();
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('ERR ' + ((e && e.stack) || e)); process.exit(1); });
