/**
 * The `codex` SubagentProvider.
 *
 * Bridges one DSH subagent run onto one Codex `turn`, reusing the resident
 * `CodexAppServer` owned by index.js. Nothing here manages the process: the
 * server owns spawn, handshake, idle shutdown and process-group teardown, so a
 * subagent run costs a `thread/start` + `turn/start` rather than a cold start.
 *
 * Deliberately imports nothing from `@deepseek-ai/dsh-subagent`, even though it
 * exports the very helper this run handle imitates (`subprocessRunHandle`). The
 * bundle is installed as a `link:` package, so Node resolves its imports from
 * the real workspace path where no node_modules exists; that import would fail
 * with ERR_MODULE_NOT_FOUND and the whole plugin would stop activating. The
 * handle is 12 lines, so the shape is reproduced rather than imported.
 *
 * The provider declares the MINIMUM capability set. Every capability it omits is
 * one DSH would have to enforce inside Codex, which it cannot:
 *
 *   agentOptions  - Codex owns the child's model/route; we cannot retarget it
 *   outputSchema  - no structured-output plumbing on this path
 *   depthLimit    - we cannot cap Codex's own sub-delegation
 *   toolFilter    - the child is not a DSH agent with a tool registry
 *   persona       - same
 *
 * `inheritsParentContext: false` is accurate (a fresh Codex thread sees none of
 * the parent conversation) and only affects the tool's wording.
 *
 * `prepareContinuable` is intentionally NOT implemented. Continuable children
 * are DSH-local Agents: the service calls `activations.materialize(...)` and
 * then reads `activation.handle.agent.session.header`, so it needs a Session we
 * would not own. Declaring the method would claim a capability we cannot honor.
 *
 * `dispose()` follows the documented out-of-process contract as far as this
 * architecture allows: it is idempotent, drops the parent abort listener,
 * settles local cancellation WITHOUT assuming Codex cooperates, and awaits the
 * run's settlement under a cap. What it does NOT do by default is take the
 * shared child process to actual exit — see `residentProcess` below.
 *
 * @module src/provider.js
 */
import { randomUUID } from "node:crypto";
import { accessSync, constants, statSync } from "node:fs";

export const PROVIDER_NAME = "codex";

/** Upper bound on how long dispose waits for the turn to settle. */
const SETTLE_CAP_MS = 3000;

const delay = (ms) => new Promise((resolve) => { const t = setTimeout(resolve, ms); t.unref?.(); });

/** Render any thrown value as one short line. */
function describe(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** Flatten a subagent prompt into plain text; note what cannot be carried. */
function flatten(content, notes) {
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const block of content) {
    if (block?.type === "text" && typeof block.text === "string") { parts.push(block.text); continue; }
    notes.push(`[unsupported: ${block?.type ?? "unknown"}]`);
  }
  return parts.join("\n").trim();
}

/** The child runs where the delegating agent runs, unless told otherwise. */
function resolveCwd(request, options) {
  const fromParent = request?.parent?.session?.header?.cwd;
  if (typeof fromParent === "string" && fromParent !== "") return fromParent;
  if (typeof options.defaultCwd === "string" && options.defaultCwd !== "") return options.defaultCwd;
  return process.cwd();
}

const textBlock = (text) => (text ? [{ type: "text", text }] : []);

/** Assemble a SubagentResult, keeping provider notes and detail in `diagnostic`. */
function result(output, stopReason, notes, detail) {
  const diagnostic = [...notes, detail].filter((part) => typeof part === "string" && part !== "").join("; ");
  return { output, stopReason, ...(diagnostic === "" ? {} : { diagnostic }) };
}

/**
 * @param {object} deps
 * @param {{runTurn: Function, maybeKill: Function}} deps.server - the resident app-server owner
 * @param {object} deps.options - resolved plugin options
 * @returns {object} a SubagentProvider
 */
export function createCodexProvider({ server, options }) {
  const resident = options.residentProcess !== false;

  return {
    name: PROVIDER_NAME,
    capabilities: {
      agentOptions: false,
      outputSchema: false,
      depthLimit: false,
      toolFilter: false,
      persona: false,
    },
    inheritsParentContext: false,

    async start(request) {
      const id = randomUUID();
      const notes = [];
      const prompt = flatten(request?.prompt, notes);
      if (prompt === "") throw new Error("codex subagent: the prompt carried no text content");

      const cwd = resolveCwd(request, options);
      try {
        accessSync(options.codexPath, constants.X_OK);
      } catch {
        throw new Error(`codex subagent: codex is not executable at ${options.codexPath}`);
      }
      try {
        accessSync(cwd, constants.F_OK);
        if (!statSync(cwd).isDirectory()) {
          throw new Error(`codex subagent: not a directory: ${cwd}`);
        }
      } catch (error) {
        if (/not a directory/.test(error?.message || "")) throw error;
        throw new Error(`codex subagent: working directory does not exist: ${cwd}`);
      }

      const local = new AbortController();
      let aborted = false;
      let disposed = false;
      let disposal;

      // Cancellation reaches us as an AbortSignal, not through
      // ctx.subagents.interrupt(): that service targets durable continuable
      // child sessions, which a one-shot remote run is not.
      const onParentAbort = () => { aborted = true; local.abort(); };
      if (request.signal) {
        if (request.signal.aborted) onParentAbort();
        else request.signal.addEventListener("abort", onParentAbort, { once: true });
      }

      const resultPromise = (async () => {
        try {
          const outcome = await server.runTurn({
            prompt,
            cwd,
            timeoutMs: options.timeoutMs,
            signal: local.signal,
          });
          const output = textBlock(outcome.output?.trim?.() ?? outcome.output ?? "");
          if (aborted) return result(output, "aborted", notes);
          if (outcome.ok) {
            // A turn that completes with no text is not an error — Codex did
            // finish — but a bare empty result is indistinguishable from a
            // silent failure at the orchestration layer, so label it.
            return output.length === 0
              ? result(output, "completed", notes, "turn completed with no text output")
              : result(output, "completed", notes);
          }
          // Use the server's structured `reason`, never a placeholder: the
          // orchestrator's `diagnostic` is where "what actually went wrong"
          // belongs, and a generic string there is worse than useless.
          if (outcome.timedOut) {
            return result(output, "error", notes, outcome.reason
              ?? `codex turn exceeded ${Math.round(options.timeoutMs / 1000)}s and was interrupted`);
          }
          return result(output, "error", notes, outcome.reason ?? "codex turn did not complete");
        } catch (error) {
          const detail = describe(error);
          if (aborted) return result([], "aborted", notes, detail);
          return result([], "error", notes, detail);
        }
      })();

      /**
       * 1+2. Settle local cancellation and await settlement under a cap.
       *      There is no explicit `turn/interrupt` here on purpose: the server's
       *      abort path already issues one and settles the turn, so duplicating
       *      it would need a threadId this layer never sees.
       *   3. Release the run. `maybeKill` — not `kill` — because the server's
       *      `activeTurns` counter spans BOTH entry points: with
       *      `residentProcess: false` a concurrent `codex_delegate` turn must not
       *      have its process pulled out from under it. When turns are still in
       *      flight the request is deferred and drained by `runTurn`'s finally.
       */
      async function teardown() {
        aborted = true;
        local.abort();
        await Promise.race([resultPromise.catch(() => undefined), delay(SETTLE_CAP_MS)]);
        if (!resident) server.maybeKill("subagent run disposed (residentProcess=false)");
      }

      return {
        id,
        // The service distinguishes local from remote on exactly this field.
        localAgent: undefined,
        result: resultPromise,
        dispose() {
          if (disposed) return disposal;
          disposed = true;
          if (request.signal) request.signal.removeEventListener("abort", onParentAbort);
          disposal = teardown();
          return disposal;
        },
      };
    },
  };
}
