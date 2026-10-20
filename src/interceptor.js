/**
 * MAIN-world content script.
 *
 * Runs at document_start, before Pinterest's own bundle, so it can wrap fetch
 * and XMLHttpRequest. Every search response Pinterest receives is cloned and
 * mined for pin stats — which means save counts cost zero extra requests, and
 * new pages of results are picked up as you scroll.
 *
 * It never touches the DOM or chrome.* APIs: it only posts messages that the
 * isolated-world content script listens for.
 */
(function () {
  "use strict";

  const X = globalThis.PinRankExtract;
  if (!X) return;

  const MAX_BUFFER = 400;

  let query = "";
  let rank = 0;
  const seen = new Set();
  const buffer = [];

  function reset(nextQuery) {
    query = nextQuery;
    rank = 0;
    seen.clear();
    buffer.length = 0;
    window.postMessage({ source: X.TAG, type: "reset", query }, "*");
  }

  function ingest(body, url) {
    const response = body && body.resource_response;
    const results = response && response.data && response.data.results;
    if (!Array.isArray(results)) return;

    const found = X.queryFromUrl(url);
    if (found && found !== query) reset(found);

    const fresh = [];
    for (const item of results) {
      if (!X.isPin(item)) continue;
      const id = String(item.id);
      if (seen.has(id)) continue;
      seen.add(id);
      rank += 1;
      fresh.push(X.slimPin(item, rank));
    }

    if (fresh.length === 0) return;

    for (const pin of fresh) {
      buffer.push(pin);
      if (buffer.length > MAX_BUFFER) buffer.shift();
    }

    window.postMessage({ source: X.TAG, type: "pins", query: query, pins: fresh }, "*");
  }

  /* ------------------------------------------------------------- fetch hook */

  const originalFetch = window.fetch;
  if (typeof originalFetch === "function") {
    window.fetch = function patchedFetch(...args) {
      const result = originalFetch.apply(this, args);

      try {
        const input = args[0];
        const url = typeof input === "string" ? input : (input && input.url) || "";

        if (url.includes(X.SEARCH_RESOURCE)) {
          result
            .then((res) => {
              // Clone so Pinterest's own consumer still gets a readable body.
              res
                .clone()
                .json()
                .then((body) => ingest(body, url))
                .catch(() => {});
            })
            .catch(() => {});
        }
      } catch {
        /* never let our hook break the page */
      }

      return result;
    };
  }

  /* --------------------------------------------------------------- XHR hook */

  const XHR = window.XMLHttpRequest;
  if (XHR && XHR.prototype) {
    const originalOpen = XHR.prototype.open;
    const originalSend = XHR.prototype.send;

    XHR.prototype.open = function patchedOpen(method, url, ...rest) {
      try {
        this.__pinRankUrl = typeof url === "string" ? url : "";
      } catch {
        /* ignore */
      }
      return originalOpen.call(this, method, url, ...rest);
    };

    XHR.prototype.send = function patchedSend(...args) {
      try {
        const url = this.__pinRankUrl || "";
        if (url.includes(X.SEARCH_RESOURCE)) {
          this.addEventListener("load", () => {
            try {
              ingest(JSON.parse(this.responseText), url);
            } catch {
              /* not JSON, or a partial read */
            }
          });
        }
      } catch {
        /* ignore */
      }
      return originalSend.apply(this, args);
    };
  }

  /* ------------------------------------------------------- replay for late loads */

  // The isolated-world script starts at document_idle and may miss messages sent
  // during initial render. It sends "hello" and gets whatever we already have.
  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.source !== X.TAG || msg.type !== "hello") return;
    if (buffer.length === 0) return;
    window.postMessage({ source: X.TAG, type: "pins", query: query, pins: buffer.slice() }, "*");
  });
})();
