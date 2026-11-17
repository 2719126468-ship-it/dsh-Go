/**
 * Request-target helpers for logs. Query strings are never safe to log: the
 * local access token is accepted there for copy/paste startup URLs.
 */
export function safeRequestTarget(raw) {
  try {
    const target = new URL(typeof raw === "string" && raw ? raw : "/", "http://127.0.0.1");
    return target.pathname || "/";
  } catch {
    return "/";
  }
}

/** No-auth mode must never expose the local Codex service beyond this device. */
export function isLoopbackBindHost(raw) {
  return typeof raw === "string" && ["127.0.0.1", "::1", "localhost"].includes(raw.trim().toLowerCase());
}


/**
 * In no-auth mode, allow native clients without an Origin header, but require
 * browser requests to be same-origin with the loopback Host header.
 */
export function isAllowedNoAuthOrigin(raw, host) {
  if (raw === undefined || raw === null || raw === "") return true;
  if (typeof raw !== "string" || typeof host !== "string" || !host) return false;
  try {
    const origin = new URL(raw);
    const expected = new URL(`http://${host}`);
    return origin.protocol === "http:"
      && origin.origin === expected.origin
      && origin.pathname === "/"
      && origin.search === ""
      && origin.hash === "";
  } catch {
    return false;
  }
}
