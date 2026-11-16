import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";

const bridgeRoot = new URL("../bridge/dsh-go-bridge/", import.meta.url);
const packageJson = JSON.parse(readFileSync(new URL("package.json", bridgeRoot), "utf8"));

test("published bridge package includes its session deletion module", () => {
  assert.ok(packageJson.files.includes("lib/session-deletion.js"));
  assert.ok(existsSync(new URL("lib/session-deletion.js", bridgeRoot)));
});
