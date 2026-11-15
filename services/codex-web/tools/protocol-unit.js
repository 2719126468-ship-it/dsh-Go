/**
 * 协议翻译层的单测：不 spawn 子进程，直接把 JSON-RPC 消息喂给
 * CodexAppServer.handleMessage，检查翻译出来的事件对不对。
 * 第 [6] 节是 cwd 守卫（src/paths.js）的单测：软链逃逸、/etc、不存在的子路径。
 *
 * 起因：手机上一轮对话底部冒出两张 `[object Object]`。根因是 error 通知
 * 里的 error 是 TurnError **对象**，而翻译层用 String() 处理了它。
 * 这个文件就是防止这种事再发生。
 *
 * 用法: node tools/protocol-unit.js
 */
import { CodexAppServer, describe, prettyCommand } from "../src/appserver.js";
import { createCwdGuard } from "../src/paths.js";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let fails = 0;
const check = (label, cond, detail) => {
  if (cond) console.log("  ✓ " + label);
  else { console.log("  ✗ " + label + (detail !== undefined ? "  → " + JSON.stringify(detail) : "")); fails++; }
};

function feed(message) {
  const srv = new CodexAppServer();
  const got = [];
  srv.turns.set("T", { onEvent: (e) => got.push(e) });
  srv.handleMessage(message);
  return got;
}

console.log("\n[1] error 通知：字段是对象，不能 String() 成 [object Object]");
{
  const got = feed({
    method: "error",
    params: {
      threadId: "T", turnId: "U", willRetry: true,
      error: { message: "stream disconnected before completion", codexErrorInfo: "serverOverloaded" },
    },
  });
  check("willRetry=true → retry 事件（不是 error）", got[0]?.type === "retry", got);
  check("message 取到原文", got[0]?.message === "stream disconnected before completion", got[0]?.message);
  check("带上错误码", got[0]?.code === "serverOverloaded", got[0]?.code);
  check("整个事件里没有 [object Object]", !JSON.stringify(got).includes("[object Object]"), got);
}

console.log("\n[2] willRetry=false 才是真错误");
{
  const got = feed({
    method: "error",
    params: { threadId: "T", turnId: "U", willRetry: false, error: { message: "context window exceeded", codexErrorInfo: "contextWindowExceeded" } },
  });
  check("→ error 事件", got[0]?.type === "error", got);
  check("message 正确", got[0]?.message === "context window exceeded", got[0]?.message);
}

console.log("\n[3] 各种畸形 error 都不能炸、不能出 [object Object]");
{
  const cases = [
    ["没有 message 字段的对象", { code: 42, detail: "x" }, "JSON"],
    ["error 是字符串", "plain failure", "plain failure"],
    ["error 是 null", null, "未知错误"],
    ["error 整个缺失", undefined, "未知错误"],
    ["httpConnectionFailed 嵌套对象", { message: "connect failed", codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 502 } } }, "connect failed"],
  ];
  for (const [label, err, expect] of cases) {
    const got = feed({ method: "error", params: { threadId: "T", turnId: "U", willRetry: false, error: err } });
    const msg = String(got[0]?.message);
    check(`${label} → 可读`, !!msg && !msg.includes("[object Object]"), msg);
    if (expect === "JSON") check(`  ${label} → 退化成 JSON`, msg.includes('"code"'), msg);
    else check(`  ${label} → ${JSON.stringify(expect)}`, msg === expect, msg);
  }
  const got = feed({
    method: "error",
    params: { threadId: "T", turnId: "U", willRetry: false, error: { message: "connect failed", codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 502 } } } },
  });
  check("httpConnectionFailed 带上了状态码", got[0]?.code === "httpConnectionFailed(502)", got[0]?.code);
}

console.log("\n[4] describe() 本身");
{
  check("Error 实例取 message", describe(new Error("boom")) === "boom");
  check("字符串原样返回", describe("hi") === "hi");
  check("null → 未知错误", describe(null) === "未知错误");
  check("对象取 message", describe({ message: "m" }) === "m");
  check("无 message 的对象 → JSON", describe({ a: 1 }) === '{"a":1}');
  check("任何输入都不会是 [object Object]", [null, 1, "x", {}, [], { a: 1 }, new Error("e")].every((v) => !describe(v).includes("[object Object]")));
}

console.log("\n[5] tool 事件翻译：字段再怪也不能出 [object Object]");
{
  const srv = new CodexAppServer();
  const got = [];
  srv.turns.set("T", { onEvent: (e) => got.push(e) });

  // 正常 commandExecution
  srv.handleMessage({
    method: "item/started",
    params: { threadId: "T", item: { type: "commandExecution", id: "c1", command: "/usr/bin/bash -lc 'git status'", cwd: "/tmp", status: "inProgress" } },
  });
  check("shell 卡片的 label 剥掉了 bash -lc 外壳", got[0]?.label.includes("git status") && !got[0].label.includes("bash"), got[0]?.label);
  check("input.command 是干净的字符串", got[0]?.input?.command === "git status", got[0]?.input?.command);

  // dynamicToolCall：arguments 形状任意
  srv.handleMessage({
    method: "item/started",
    params: { threadId: "T", item: { type: "dynamicToolCall", id: "d1", tool: "exec_command", arguments: { cmd: ["bash", "-lc", "ls -la"], nested: { a: 1 } }, status: "inProgress" } },
  });
  check("dynamicToolCall 的 name 是工具名", got[1]?.name === "exec_command", got[1]?.name);
  check("任何字段都没变成 [object Object]", !JSON.stringify(got).includes("[object Object]"), got);

  // mcpToolCall
  srv.handleMessage({
    method: "item/started",
    params: { threadId: "T", item: { type: "mcpToolCall", id: "m1", server: "fs", tool: "read_file", arguments: { path: "/a/b" }, status: "inProgress" } },
  });
  check("mcp 工具名拼成 server/tool", got[2]?.name === "fs/read_file", got[2]?.name);
}

console.log("\n[6] cwd 守卫：软链逃逸 / /etc / 不存在的子路径");
{
  // 在临时目录里搭一个"假 $HOME"：里面有正常子目录、指向外面的软链、指向 / 的软链。
  const sandbox = mkdtempSync(join(tmpdir(), "cwdguard-"));
  const home = join(sandbox, "home");
  const outside = join(sandbox, "outside");
  mkdirSync(join(home, "codex", "web"), { recursive: true });
  mkdirSync(join(outside, "secret"), { recursive: true });
  mkdirSync(join(sandbox, "home2"), { recursive: true });          // 名字前缀相同的兄弟目录
  symlinkSync(outside, join(home, "escape"));                      // $HOME 内的软链 → $HOME 外
  symlinkSync("/", join(home, "to-root"));                         // $HOME 内的软链 → /
  symlinkSync(home, join(sandbox, "home-link"));                   // 根本身是个软链
  writeFileSync(join(home, "afile.txt"), "x\n");

  const REAL_HOME = realpathSync(home);
  const guard = createCwdGuard(home);

  const ok = await guard(join(home, "codex"));
  check("$HOME 子目录通过", ok.ok === true && ok.exists === true, ok);
  check("返回的是真实路径", ok.path === join(REAL_HOME, "codex"), ok.path);

  const rootItself = await guard(REAL_HOME);
  check("根本身通过（rel 为空）", rootItself.ok === true && rootItself.path === REAL_HOME, rootItself);

  const linkedRoot = createCwdGuard(join(sandbox, "home-link"));
  const underLinkedRoot = await linkedRoot(join(sandbox, "home-link", "codex"));
  check("根是软链时也按真实根比较", underLinkedRoot.ok === true && underLinkedRoot.path === join(REAL_HOME, "codex"),
    underLinkedRoot);

  const esc = await guard(join(home, "escape"));
  check("$HOME 内软链指向 $HOME 外：拒绝", esc.ok === false, esc);
  const escChild = await guard(join(home, "escape", "secret"));
  check("软链下面的子路径也拒绝", escChild.ok === false, escChild);
  const escMissing = await guard(join(home, "escape", "not-there"));
  check("软链下面不存在的路径同样拒绝", escMissing.ok === false, escMissing);
  const toRoot = await guard(join(home, "to-root"));
  check("指向 / 的软链：拒绝", toRoot.ok === false, toRoot);

  const etc = await guard("/etc");
  check("/etc：拒绝", etc.ok === false, etc);
  const slash = await guard("/");
  check("/：拒绝", slash.ok === false, slash);
  const sibling = await guard(join(sandbox, "home2"));
  check("前缀相同的兄弟目录：拒绝", sibling.ok === false, sibling);
  const dotdot = await guard(`${home}/codex/../..`);
  check("带 .. 的路径：拒绝", dotdot.ok === false && dotdot.error.includes(".."), dotdot);
  const empty = await guard("   ");
  check("空路径：拒绝", empty.ok === false, empty);
  const nul = await guard(join(home, "a\u0000b"));
  check("含 NUL 的路径：拒绝", nul.ok === false, nul);
  const file = await guard(join(home, "afile.txt"));
  check("文件不是目录：拒绝", file.ok === false && file.error === "不是一个目录", file);

  const missing = await guard(join(home, "brand-new"));
  check("不存在的 $HOME 子路径：能选（exists=false）", missing.ok === true && missing.exists === false, missing);
  check("且解析结果仍钉在 $HOME 内", missing.path === join(REAL_HOME, "brand-new"), missing.path);
  const missingDeep = await guard(join(home, "a", "b", "c"));
  check("多级不存在的子路径同样钉在 $HOME 内", missingDeep.ok === true && missingDeep.path === join(REAL_HOME, "a", "b", "c"),
    missingDeep);

  rmSync(sandbox, { recursive: true, force: true });
}

console.log(fails ? `\n❌ ${fails} 项失败` : "\n✅ 全部通过");
process.exit(fails ? 1 : 0);
