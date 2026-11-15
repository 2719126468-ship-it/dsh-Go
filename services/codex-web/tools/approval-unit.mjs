/**
 * 审批反向请求的单元测试：不起真进程，直接喂 JSON-RPC 消息给 handleMessage。
 *
 * 覆盖：ExecCommandApproval / ApplyPatchApproval / PermissionsRequestApproval 三种方法，
 * approve / session / deny 三种决定，以及"没人理 → 超时按拒绝"这条兜底。
 * 断言写死的是 **jsonrpc 响应的字面形状**，因为那是 Codex 认的契约，改不得。
 */
import { CodexAppServer } from "../src/appserver.js";

let failures = 0;
function check(label, cond, detail) {
  if (cond) console.log("  ✓ " + label);
  else { console.log("  ✗ " + label + (detail ? "  → " + detail : "")); failures++; }
}

const c = new CodexAppServer({ approvalTimeoutMs: 4000 });
const events = [];
c.turns.set("T1", { onEvent: (e) => events.push(e) });
const written = [];
c.child = { stdin: { write: (s) => written.push(s), destroyed: false } };

console.log("\n[a] ExecCommandApproval → approve");
c.handleMessage({ jsonrpc: "2.0", id: 77, method: "ExecCommandApproval", params: {
  threadId: "T1", turnId: "turn1",
  command: "bash -lc 'rm -rf build'", cwd: "/home/u/codex-web", reason: "clean build dir",
}});
check("前端收到 approval 事件", events[0] && events[0].type === "approval");
check("事件带 command", events[0] && events[0].command === "bash -lc 'rm -rf build'");
check("事件带 cwd", events[0] && events[0].cwd === "/home/u/codex-web");
check("pending 里登记了一条", c.approvals.size === 1, String(c.approvals.size));
c.resolveApproval(77, "approve");
check("回给 Codex 的是 decision:approved",
  written[0] && JSON.parse(written[0]).result.decision === "approved", written[0]);
check("同一个 id 不能再回第二次", c.resolveApproval(77, "deny") === false);

console.log("\n[b] ApplyPatchApproval → session");
events.length = 0; written.length = 0;
c.handleMessage({ jsonrpc: "2.0", id: 78, method: "ApplyPatchApproval", params: {
  threadId: "T1", changes: [{ path: "src/a.js" }],
}});
check("changes 被拍平成路径数组",
  Array.isArray(events[0] && events[0].changes) && events[0].changes[0] === "src/a.js");
c.resolveApproval(78, "session");
check("session → decision:approved_for_session",
  written[0] && JSON.parse(written[0]).result.decision === "approved_for_session", written[0]);

console.log("\n[c] PermissionsRequestApproval → deny");
events.length = 0; written.length = 0;
c.handleMessage({ jsonrpc: "2.0", id: 79, method: "PermissionsRequestApproval", params: {
  threadId: "T1", permissions: ["network"],
}});
check("permissions 透传到事件", events[0] && Array.isArray(events[0].permissions));
c.resolveApproval(79, "deny");
check("拒绝权限 → 空 permissions 数组",
  written[0] && Array.isArray(JSON.parse(written[0]).result.permissions)
    && JSON.parse(written[0]).result.permissions.length === 0, written[0]);

console.log("\n[d] 超时兜底 → 按拒绝");
events.length = 0; written.length = 0;
c.handleMessage({ jsonrpc: "2.0", id: 80, method: "ExecCommandApproval", params: { threadId: "T1", command: "ls" } });
await new Promise((r) => setTimeout(r, 4300));
check("超时后回了 decision:denied",
  written[0] && JSON.parse(written[0]).result.decision === "denied", written[0]);
check("只发一条 approval_resolved（带 timeout）",
  events.filter((e) => e.type === "approval_resolved").length === 1,
  String(events.filter((e) => e.type === "approval_resolved").length));
check("那条 resolved 标了 timeout", events.some((e) => e.type === "approval_resolved" && e.timeout === true));
check("超时后 pending 清空", c.approvals.size === 0, String(c.approvals.size));

console.log(failures ? `\n❌ ${failures} 项失败` : "\n✅ 全部通过");
process.exit(failures ? 1 : 0);
