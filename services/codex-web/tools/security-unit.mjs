import assert from "node:assert/strict";
import { isAllowedNoAuthOrigin } from "../src/security.js";

const cases = [
  ["native client without Origin", undefined, "127.0.0.1:3081", true],
  ["same-origin IPv4", "http://127.0.0.1:3081", "127.0.0.1:3081", true],
  ["same-origin localhost", "http://localhost:3081", "localhost:3081", true],
  ["same-origin IPv6", "http://[::1]:3081", "[::1]:3081", true],
  ["cross-origin website", "https://attacker.example", "127.0.0.1:3081", false],
  ["different loopback alias", "http://localhost:3081", "127.0.0.1:3081", false],
  ["wrong port", "http://127.0.0.1:9999", "127.0.0.1:3081", false],
  ["non-HTTP origin", "https://127.0.0.1:3081", "127.0.0.1:3081", false],
  ["null origin", "null", "127.0.0.1:3081", false],
  ["path-bearing origin", "http://127.0.0.1:3081/evil", "127.0.0.1:3081", false],
  ["malformed origin", "not an origin", "127.0.0.1:3081", false],
  ["invalid host", "http://127.0.0.1:3081", "", false],
];

for (const [label, origin, host, expected] of cases) {
  assert.equal(isAllowedNoAuthOrigin(origin, host), expected, label);
}
console.log(`security-unit: ${cases.length} origin checks passed`);
