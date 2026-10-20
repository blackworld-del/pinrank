/**
 * MAIN-world content script.
 *
 * Runs at document_start, before Pinterest's own bundle, so it can wrap fetch
 * and XMLHttpRequest. Every resource response Pinterest receives is cloned and
 * mined for pins — which means save counts cost zero extra requests, and new
 * pages of results are picked up as you scroll.
 *
 * Two kinds of surface are handled differently:
 *
 *   search  (BaseSearchResource)  -> pins get a real ranking position, and the
 *                                    `type:"story"` module wrappers are skipped
 *   anything else (profile, board, home feed, related pins) -> pins are
 *                                    collected from whatever shape the payload
 *                                    has, with no position, because there is no
 *                                    ranking to report there
 *
 * It never touches the DOM or chrome.* APIs: it only posts messages that the
 * isolated-world content script listens for.
 */
(function () {
  "use strict";

  const X = globalThis.PinRankExtract;
  if (!X) return;

  const MAX_BUFFER = 400;
  const MAX_SEEN = 5000;

  let query = "";
  let rank = 0;
  const seenSearch = new Set();
  const seenFeed = new Set();
  const buffer = [];

  function reset(nextQuery) {
    query = nextQuery;
    rank = 0;
    seenSearch.clear();
    seenFeed.clear();
    buffer.length = 0;
    window.postMessage({ source: X.TAG, type: "reset", query }, "*");
  }

  /** Keep a Set bounded without losing the most recent ids. */
  function remember(set, id) {
    set.add(id);
    if (set.size <= MAX_SEEN) return;
    const keep = [...set].slice(Math.floor(MAX_SEEN / 2));
    set.clear();
    for (const value of keep) set.add(value);
  }

  function publish(pins, q) {
    if (pins.length === 0) return;

    for (const pin of pins) {
      buffer.push(pin);
      if (buffer.length > MAX_BUFFER) buffer.shift();
    }

    window.postMessage({ source: X.TAG, type: "pins", query: q || "", pins }, "*");
  }

  /** Search results: assign a position, skip module wrappers. */
  function ingestSearch(results, url) {
    const found = X.queryFromUrl(url);
    if (found && found !== query) reset(found);

    const fresh = [];
    for (const item of results) {
      if (!X.isPin(item)) continue;
      const id = String(item.id);
      if (seenSearch.has(id)) continue;
      remember(seenSearch, id);
      rank += 1;
      fresh.push(X.slimPin(item, rank));
    }

    publish(fresh, query);
  }

  /**
   * Every other surface returns pins from resources with different names and
   * shapes, so walk the payload for pin-shaped objects instead of hard-coding a
   * resource name.
   */
  function ingestFeed(data) {
    const fresh = [];
    for (const item of X.findPins(data)) {
      const id = String(item.id);
      if (seenFeed.has(id)) continue;
      remember(seenFeed, id);
      fresh.push(X.slimPin(item, null)); // no ranking outside search
    }

    publish(fresh, "");
  }

  function ingest(body, url) {
    const data = body && body.resource_response && body.resource_response.data;
    if (!data || typeof data !== "object") return;

    if (url.includes(X.SEARCH_RESOURCE)) {
      if (Array.isArray(data.results)) ingestSearch(data.results, url);
      return;
    }

    ingestFeed(data);
  }

  /* ------------------------------------------------------------- fetch hook */

  const originalFetch = window.fetch;
  if (typeof originalFetch === "function") {
    window.fetch = function patchedFetch(...args) {
      const result = originalFetch.apply(this, args);

      try {
        const input = args[0];
        const url = typeof input === "string" ? input : (input && input.url) || "";

        if (url.includes("/resource/")) {
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
        if (url.includes("/resource/")) {
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

    // A profile or board has no ranking, so never replay search positions there.
    const pins = msg.search
      ? buffer.slice()
      : buffer.map((pin) => ({ ...pin, position: null }));

    window.postMessage({ source: X.TAG, type: "pins", query: query, pins }, "*");
  });
})();
