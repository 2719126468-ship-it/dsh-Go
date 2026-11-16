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
