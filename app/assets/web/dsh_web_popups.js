// Popups inside DSH Web: `window.open` and `target="_blank"` clicks go to the
// system browser. Injected by dsh-app's WebView page after every load
// (idempotent). webview_flutter creates no new window, so both would fail
// silently: the plugin settings page calls `window.open` once its own
// `/open-external` round trip fails, and a plain `_blank` link is the other
// half of "open this outside".
//
// Every candidate is resolved against the page and only http(s) is handed
// over, as `{url}` to the `DshAppPopup` channel; the app launches it with
// `LaunchMode.externalApplication`. Anything else (`blob:`, `javascript:`,
// `data:`) is left to the WebView unchanged: the page keeps what it asked for
// and the app never opens a scheme it did not choose.
//
// `window.open` returns null, not a fake Window: there is no window to
// reference, and the plugin path already falls back to posting
// `/open-external` when the popup is null. A same-origin `_blank` link goes
// out too — in-page navigation is not this bridge's job, so anything asking
// for a new window leaves the WebView.
//
// Nothing here may break the page: every step is guarded and a failure
// leaves the browser's own behaviour in place.
(function () {
  if (window.__dshAppPopupsInstalled) return;
  window.__dshAppPopupsInstalled = true;

  var CHANNEL = 'DshAppPopup';

  // The absolute URL to hand to the app, or null when the target is not an
  // http(s) address (unreadable, empty, another scheme).
  function external(url) {
    try {
      if (typeof url !== 'string' || !url) return null;
      var u = new URL(url, location.href);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
      return u.href;
    } catch (e) {
      return null;
    }
  }

  function post(href) {
    try {
      var channel = window[CHANNEL];
      if (!channel || !channel.postMessage) return false;
      channel.postMessage(JSON.stringify({ url: href }));
      return true;
    } catch (e) {
      return false;
    }
  }

  var native = window.open;

  window.open = function (url) {
    var href = external(url);
    if (href) {
      post(href);
      return null;
    }
    // Not http(s), or nothing to resolve: the WebView keeps it, args and all.
    if (typeof native !== 'function') return null;
    try {
      return native.apply(window, arguments);
    } catch (e) {
      return null;
    }
  };

  // Capture phase, ahead of the page's own handlers: a link asking for a new
  // window is answered by the system browser and the click stops there.
  document.addEventListener(
    'click',
    function (e) {
      try {
        var node = e && e.target;
        if (!node || typeof node.closest !== 'function') return;
        var a = node.closest('a[target=_blank]');
        if (!a) return;
        var href = external(a.href);
        if (!href) return;
        e.preventDefault();
        e.stopPropagation();
        post(href);
      } catch (err) {
        // A page we cannot read behaves exactly as before.
      }
    },
    true
  );
})();
