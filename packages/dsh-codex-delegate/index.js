/**
 * dsh-codex-delegate — exposes the local Codex CLI as the `codex_delegate` tool.
 *
 * This file is the plugin entry: it reads the row config, owns one resident
 * `CodexAppServer`, and registers two things on top of it:
 *
 *   - the `codex_delegate` tool (one-shot, prompt in / text out), and
 *   - the `codex` SubagentProvider (so a `@deepseek-ai/dsh-tool-subagent` row
 *     bound to `provider: codex` can delegate into Codex).
 *
 * Both share the same app-server process. The transport lives in
 * ./src/appserver.js and the provider in ./src/provider.js.
 *
 * Termux/Android specifics worth knowing before editing:
 *
 *  1. It invokes `~/.local/bin/codex`, NOT $PREFIX/bin/codex. Codex ships a
 *     statically linked musl binary that carries musl's own DNS resolver, which
 *     reads /etc/resolv.conf — a file Android does not have. musl then falls
 *     back to `nameserver 127.0.0.1`, where nothing listens, and every request
 *     dies after the full 5s resolver timeout. The wrapper binds Termux's real
 *     resolv.conf over it with proot.
 *
 *  2. Codex is configured for a custom provider whose `env_key` is
 *     SHAREDCHAT_API_KEY; the child gets it from the process environment or,
 *     failing that, from DSH's credential store.
 *
 * This plugin never reads or writes ~/.codex/*; Codex owns that state.
 *
 * Tunables come from the bundle row's `config`; defaults live in DEFAULTS below.
 */
import { accessSync, constants, statSync } from "node:fs";
import { join } from "node:path";
import { CodexAppServer, runOneShot, describe, HOME } from "./src/appserver.js";
import { createCodexProvider, PROVIDER_NAME } from "./src/provider.js";

export const name = "codex-delegate";
export const inject = ["tools"];

const DEFAULTS = {
  /** The wrapper, not $PREFIX/bin/codex — see the note at the top of the file. */
  codexPath: join(HOME, ".local", "bin", "codex"),
  /**
   * Per-call budget for the TURN itself. Thread setup is charged to
   * `handshakeTimeoutMs` instead, so this only bounds the model turn. A cold
   * call measured ~147s end to end (dominated by upstream model latency).
   */
  timeoutMs: 300000,
  /** Close the resident app-server after this long with no calls. */
  idleTimeoutMs: 1800000,
  /** Budget for spawning the child and completing the initialize handshake. */
  handshakeTimeoutMs: 30000,
  /**
   * Codex has no `--full-auto` in 0.159.x; the flag became
   * `--sandbox read-only|workspace-write|danger-full-access`. Any sandbox other
   * than danger-full-access uses bubblewrap/Landlock, neither of which works on
   * Android, so Codex must run unsandboxed here.
   */
  sandboxMode: "danger-full-access",
  /** AskForApproval: untrusted | on-request | never. */
  approvalPolicy: "never",
  /** Working directory used when the caller omits `cwd`. */
  defaultCwd: "",
  /** Hard cap on the text handed back to the model. */
  maxOutputChars: 100000,
  /** Seconds allowed between the group SIGTERM and the group SIGKILL. */
  killGraceMs: 2000,
  /** How much child stderr to keep for diagnostics. */
  stderrTailChars: 4000,
  /**
   * Register the `codex` SubagentProvider as well as the tool. Set false to
   * keep `codex_delegate` only.
   */
  subagentEnabled: true,
  /**
   * true  - one app-server process is shared by every run (fast; the process is
   *         reclaimed by `idleTimeoutMs` and by plugin unload).
   * false - each subagent run stops the process when the last run disposes, so
   *         the child reaches actual exit before `dispose()` resolves. Slower
   *         (a cold start per run) but strictly matches the documented
   *         out-of-process teardown contract. This is the downgrade switch.
   */
  residentProcess: true,
};

export function apply(ctx, config) {
  const setting = (key) => {
    const value = config?.[key];
    return value === undefined || value === null || value === "" ? DEFAULTS[key] : value;
  };
  const num = (key, floor) => {
    const raw = Number(setting(key));
    return Number.isFinite(raw) ? Math.max(floor, raw) : DEFAULTS[key];
  };

  const options = {
    codexPath: String(setting("codexPath")),
    timeoutMs: num("timeoutMs", 1000),
    idleTimeoutMs: num("idleTimeoutMs", 10000),
    handshakeTimeoutMs: num("handshakeTimeoutMs", 5000),
    sandboxMode: String(setting("sandboxMode")),
    approvalPolicy: String(setting("approvalPolicy")),
    killGraceMs: num("killGraceMs", 0),
    stderrTailChars: num("stderrTailChars", 500),
  };
  const defaultCwd = String(setting("defaultCwd"));
  const maxOutputChars = num("maxOutputChars", 1000);
  const seconds = Math.round(options.timeoutMs / 1000);
  const idleMinutes = Math.round(options.idleTimeoutMs / 60000);

  const server = new CodexAppServer(options);
  // Tear the child down with the plugin, not just with the process.
  ctx.effect(() => () => server.dispose());

  ctx.tools.register({
    name: "codex_delegate",
    description: [
      "Run one task on the locally installed Codex CLI and return its complete reply.",
      "Use it to hand a self-contained job to a second coding agent: an independent implementation, a second opinion on a change, or work you want isolated in another directory.",
      "Codex runs autonomously with approvals and sandboxing disabled, because neither the bubblewrap nor the Landlock sandbox works on Android.",
      `Backed by a resident \`codex app-server\` that is reused across calls, so repeat calls are much faster than a cold \`codex exec\`; it shuts down after ${idleMinutes} minutes idle and respawns on demand.`,
      "Codex sees only `prompt` and cannot ask follow-up questions, so the prompt must be self-contained.",
      `If the turn has not finished within ${seconds}s it is interrupted and this returns a timeout message together with whatever text had arrived.`,
    ].join(" "),
    // Leave headroom so our own deadline produces the descriptive message first.
    timeoutMs: options.timeoutMs + options.handshakeTimeoutMs + 20000,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        prompt: {
          type: "string",
          description: "The complete task handed to Codex. It gets no other context, so include every constraint, path, and acceptance criterion it needs.",
        },
        cwd: {
          type: "string",
          description: "Working directory Codex runs in. Defaults to the DSH process working directory.",
        },
      },
      required: ["prompt"],
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean" },
          timedOut: { type: "boolean" },
          output: { type: "string" },
        },
        required: ["ok", "timedOut", "output"],
      },
      render: (args, value) => [{ type: "text", text: value.output }],
    },

    execute: async (args, exec) => {
      const prompt = typeof args?.prompt === "string" ? args.prompt.trim() : "";
      if (!prompt) {
        return { ok: false, timedOut: false, output: "codex_delegate：`prompt` 不能为空。" };
      }

      const cwd = (typeof args?.cwd === "string" && args.cwd.trim() !== "")
        ? args.cwd.trim()
        : (defaultCwd || process.cwd());

      try {
        accessSync(options.codexPath, constants.X_OK);
      } catch {
        return { ok: false, timedOut: false, output: `codex_delegate：找不到可执行的 Codex：${options.codexPath}\n请检查插件 Config 的 codexPath，或重新安装 Codex CLI。` };
      }
      try {
        accessSync(cwd, constants.F_OK);
        if (!statSync(cwd).isDirectory()) {
          return { ok: false, timedOut: false, output: `codex_delegate：不是一个目录：${cwd}` };
        }
      } catch {
        return { ok: false, timedOut: false, output: `codex_delegate：工作目录不存在：${cwd}` };
      }

      let result;
      try {
        result = await server.runTurn({ prompt, cwd, timeoutMs: options.timeoutMs, signal: exec?.signal });
      } catch (error) {
        // The resident server is unusable (spawn or handshake failed). Fall back
        // to the cold one-shot CLI so the tool still works.
        result = await runOneShot({
          codexPath: options.codexPath,
          prompt,
          cwd,
          timeoutMs: options.timeoutMs,
          killGraceMs: options.killGraceMs,
          signal: exec?.signal,
          maxOutputChars,
        });
        if (result.output) {
          result.output = `（codex app-server 不可用，已回退到一次性 codex exec：${describe(error)}）\n\n${result.output}`;
        }
      }

      let text;
      if (result.ok) {
        text = result.output.trim() || "(Codex 未产生输出)";
      } else if (result.timedOut) {
        text = [
          `cwd: ${cwd}`,
          "",
          `❌ 超时：Codex 在 ${seconds} 秒内没有结束，已中断该 turn。`,
          "",
          "--- 超时前已生成的内容 ---",
          result.output.trim() || "(无输出)",
        ].join("\n");
      } else {
        text = [`cwd: ${cwd}`, "", "❌ Codex 执行失败。", "", "--- 输出 ---", result.output.trim() || "(无输出)"].join("\n");
      }

      if (text.length > maxOutputChars) {
        text = `${text.slice(0, maxOutputChars)}\n\n…（输出已截断：共 ${text.length} 字符，上限 ${maxOutputChars}）`;
      }

      return { ok: result.ok, timedOut: result.timedOut, output: text };
    },
  });

  // ── subagent provider ───────────────────────────────────────────────────────
  // Registered AFTER the tool and in its OWN fiber, so that a missing subagent
  // service can never cost us `codex_delegate`: the tool above is registered on
  // the plugin's own context and does not depend on anything below.
  //
  // `ctx.inject(deps, cb)` — NOT a one-shot `ctx.get('subagents')` — is the whole
  // point of this block. `ctx.get` answers `undefined` when a service is merely
  // *not provided yet*, and this plugin loads before the subagent service
  // publishes its provider registry. A one-shot read here silently skipped
  // registration forever, and the `tool-subagent-codex` row sat waiting for a
  // `subagent/provider-added` event that never fired — the tool simply never
  // appeared, with nothing in the logs to say why. `ctx.inject` pends until the
  // service exists and re-runs if it is replaced.
  if (setting("subagentEnabled") !== false) {
    /** Never swallow a registration failure: silence here is the bug, not the fix. */
    const report = (message) => {
      if (typeof ctx.logger?.error === "function") ctx.logger.error(message);
      else if (typeof ctx.logger?.warn === "function") ctx.logger.warn(message);
      else console.error(message);
    };
    try {
      ctx.inject(["subagents"], (scoped) => {
        try {
          const provider = createCodexProvider({
            server,
            options: { ...options, defaultCwd, residentProcess: setting("residentProcess") !== false },
          });
          scoped.effect(() => scoped.subagents.registerProvider(provider), "codex-delegate: subagent provider");
          ctx.logger?.info?.(`codex-delegate: registered subagent provider "${PROVIDER_NAME}"`);
        } catch (error) {
          report(`codex-delegate: subagent provider registration failed: ${describe(error)}`);
        }
      });
    } catch (error) {
      report(`codex-delegate: cannot inject the subagents service: ${describe(error)}`);
    }
  }
}
