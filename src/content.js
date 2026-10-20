/**
 * ISOLATED-world content script.
 *
 * Draws a badge on every pin card in the search grid (rank + saves, plus the
 * comment count once it has been fetched) and a detail panel on hover.
 *
 * Save counts arrive free from the intercepted search responses. Comments are
 * not in the search payload at all, so they are fetched from PinResource on
 * hover — one request per pin, cached — rather than blasting 100 requests on
 * page load.
 */
(function () {
  "use strict";

  const X = globalThis.PinBusExtract;
  if (!X || window.__pinBusContent) return;
  window.__pinBusContent = true;

  const DETAIL_TTL_MS = 10 * 60 * 1000;
  const ERROR_TTL_MS = 60 * 1000;

  /** id -> slimPin from the search payload */
  const pins = new Map();
  /** id -> { status, data|error, at } */
  const details = new Map();
  const pending = new Map();

  let panel = null;
  let panelId = "";
  let hoverTimer = 0;
  let hideTimer = 0;
  let currentAnchor = null;
  let scanTimer = 0;
  let lastUrl = location.href;

  /** Queries we already tried the safety-net fetch for (per document). */
  const fallbackTried = new Set();

  /* ------------------------------------------------------------------ utils */

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function fmt(value) {
    if (value == null) return "—";
    if (typeof value !== "number") return String(value);
    if (value < 1000) return String(value);
    if (value < 1000000) {
      const k = value / 1000;
      return (k < 10 ? k.toFixed(1) : String(Math.round(k))) + "k";
    }
    return (value / 1000000).toFixed(1) + "M";
  }

  function ageDays(iso) {
    if (!iso) return null;
    const then = Date.parse(iso);
    if (Number.isNaN(then)) return null;
    return Math.max(0, Math.round((Date.now() - then) / 86400000));
  }

  function currentQuery() {
    try {
      return new URLSearchParams(location.search).get("q") || "";
    } catch {
      return "";
    }
  }

  function pinIdFromHref(href) {
    if (!href) return "";
    try {
      const url = new URL(href, location.origin);
      if (!/(^|\.)pinterest\.[a-z.]+$/.test(url.hostname)) return "";
      const match = /^\/pin\/([^/?#]+)/.exec(url.pathname);
      return match ? decodeURIComponent(match[1]) : "";
    } catch {
      return "";
    }
  }

  function cookie(name) {
    const match = new RegExp("(?:^|;\\s*)" + name + "=([^;]*)").exec(document.cookie);
    return match ? decodeURIComponent(match[1]) : "";
  }

  /** The handshake Pinterest's own client sends. */
  function resourceHeaders(sourceUrl, handler) {
    return {
      accept: "application/json, text/javascript, */*, q=0.01",
      "x-csrftoken": cookie("csrftoken"),
      "x-pinterest-appstate": "active",
      "x-pinterest-source-url": sourceUrl,
      "x-pinterest-pws-handler": handler,
      "x-requested-with": "XMLHttpRequest",
    };
  }

  /* ---------------------------------------------------------------- details */

  async function loadDetails(id) {
    const cached = details.get(id);
    if (cached) {
      if (cached.status === "loading") return pending.get(id) || cached;
      if (cached.status === "ok" && Date.now() - cached.at < DETAIL_TTL_MS) return cached;
      if (cached.status === "error" && Date.now() - cached.at < ERROR_TTL_MS) return cached;
    }

    const sourceUrl = "/pin/" + id + "/";
    const data = encodeURIComponent(
      JSON.stringify({ options: { id: id, field_set_key: "detailed" }, context: {} })
    );
    const url = X.PIN_RESOURCE + "get/?source_url=" + encodeURIComponent(sourceUrl) + "&data=" + data;

    details.set(id, { status: "loading", at: Date.now() });

    const task = fetch(url, {
      credentials: "same-origin",
      headers: resourceHeaders(sourceUrl, "www/pin/[id].js"),
    })
      .then((res) => {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      })
      .then((body) => {
        const payload = body && body.resource_response && body.resource_response.data;
        return { status: "ok", data: X.slimDetail(payload), at: Date.now() };
      })
      .catch((err) => ({
        status: "error",
        error: String((err && err.message) || err),
        at: Date.now(),
      }))
      .then((result) => {
        details.set(id, result);
        pending.delete(id);
        if (panelId === id) renderPanel(id);
        if (result.status === "ok") queueScan(); // badge now has the comment count
        return result;
      });

    pending.set(id, task);
    return task;
  }

  /* ------------------------------------------------------------------ badge */

  function badgeFor(anchor, info) {
    let badge = anchor.querySelector(":scope > .pinbus-badge");
    if (!badge) {
      if (getComputedStyle(anchor).position === "static") anchor.style.position = "relative";
      badge = el("div", "pinbus-badge");
      badge.setAttribute("data-pinbus", "1");
      anchor.appendChild(badge);
    }

    badge.textContent = "";

    if (info.position) badge.appendChild(el("span", "pinbus-rank", "#" + info.position));
    if (info.saves != null) {
      badge.appendChild(el("span", "pinbus-save", "♥ " + fmt(info.saves)));
    }

    const detail = details.get(info.id);
    const comments =
      detail && detail.status === "ok" ? detail.data.comments : info.comments;
    if (comments != null) {
      badge.appendChild(el("span", "pinbus-comment", "💬 " + fmt(comments)));
    }

    return badge;
  }

  function scan() {
    const anchors = document.querySelectorAll('a[href*="/pin/"]');
    for (const anchor of anchors) {
      const id = pinIdFromHref(anchor.getAttribute("href"));
      if (!id) continue;
      const info = pins.get(id);
      if (!info) continue;
      badgeFor(anchor, info);
    }
  }

  function queueScan() {
    if (scanTimer) return;
    scanTimer = setTimeout(() => {
      scanTimer = 0;
      scan();
    }, 250);
  }

  /* ------------------------------------------------------------------ panel */

  function ensurePanel() {
    if (!panel) {
      panel = el("div", "pinbus-panel");
      panel.setAttribute("data-pinbus", "1");
      (document.body || document.documentElement).appendChild(panel);
    }
    return panel;
  }

  function renderPanel(id) {
    if (!panel || panelId !== id) return;

    const info = pins.get(id);
    const detail = details.get(id);
    const data = detail && detail.status === "ok" ? detail.data : null;

    panel.textContent = "";

    const head = el("div", "pinbus-head");
    if (info && info.position) head.appendChild(el("span", "pinbus-pos", "#" + info.position));
    head.appendChild(el("span", "pinbus-title", (info && info.title) || "(untitled)"));
    panel.appendChild(head);

    const stats = el("div", "pinbus-stats");
    const stat = (label, value, kind) => {
      const box = el("div", "pinbus-stat pinbus-" + kind);
      box.appendChild(el("b", "", value));
      box.appendChild(el("span", "", label));
      return box;
    };
    stats.appendChild(stat("saves", fmt(data ? data.saves : info && info.saves), "saves"));
    stats.appendChild(stat("comments", data ? fmt(data.comments) : "…", "comments"));
    stats.appendChild(stat("repins", data ? fmt(data.repins) : "…", "repins"));
    panel.appendChild(stats);

    const list = el("dl", "pinbus-rows");
    const row = (key, value) => {
      if (value == null || value === "" || value === "—") return;
      list.appendChild(el("dt", "", key));
      list.appendChild(el("dd", "", String(value)));
    };

    if (info) {
      row("Domain", info.domain || (info.hasLink ? "" : "no outbound link"));
      row(
        "Pinner",
        info.pinner
          ? "@" + info.pinner + (info.followers != null ? " · " + fmt(info.followers) + " followers" : "")
          : ""
      );
      row(
        "Board",
        info.board
          ? info.board + (info.boardPins != null ? " · " + fmt(info.boardPins) + " pins" : "")
          : ""
      );

      const days = ageDays(info.createdAt);
      row("Published", days != null ? days + "d ago" : "");

      if (info.width && info.height) {
        row("Image", info.width + "×" + info.height + " (" + (info.width / info.height).toFixed(2) + ")");
      }

      row("Rich pin", info.richType || (info.richSite ? "yes" : ""));
      row("Description", info.description ? info.description.length + " chars" : "");
      if (info.topics.length) row("Pinterest topics", info.topics.join("; "));
      if (info.hashtags.length) row("Hashtags", info.hashtags.join(" "));
      if (info.alt) row("Alt text", info.alt);
    }

    if (data) {
      row("SEO title", data.seoTitle);
      row("Category", data.category);
      if (data.interestTags.length) row("Interest tags", data.interestTags.join("; "));
      if (data.hashtags.length) row("Pin hashtags", data.hashtags.join(" "));
    }

    panel.appendChild(list);

    if (detail && detail.status === "error") {
      panel.appendChild(el("div", "pinbus-note", "Comments unavailable (" + detail.error + ")"));
    } else if (!data && info && info.saves == null) {
      panel.appendChild(el("div", "pinbus-note", "Log in to Pinterest to see saves and comments."));
    }
  }

  function positionPanel(anchor) {
    if (!panel) return;

    const rect = anchor.getBoundingClientRect();
    const width = 320;
    const gap = 12;
    const margin = 8;

    let left = rect.right + gap;
    if (left + width > window.innerWidth - margin) left = rect.left - width - gap;
    if (left < margin) left = Math.max(margin, Math.min(window.innerWidth - width - margin, rect.left));

    const height = panel.offsetHeight || 260;
    let top = rect.top;
    if (top + height > window.innerHeight - margin) {
      top = Math.max(margin, window.innerHeight - height - margin);
    }

    panel.style.left = Math.round(left) + "px";
    panel.style.top = Math.round(top) + "px";
  }

  function openPanel(anchor, info) {
    panelId = info.id;
    ensurePanel();
    renderPanel(info.id);
    positionPanel(anchor);
    if (!details.has(info.id) || details.get(info.id).status !== "ok") loadDetails(info.id);
  }

  function closePanel() {
    panelId = "";
    if (panel) {
      panel.remove();
      panel = null;
    }
  }

  /* ------------------------------------------------------------------ hover */

  document.addEventListener(
    "mouseover",
    (event) => {
      const anchor = event.target && event.target.closest && event.target.closest('a[href*="/pin/"]');
      if (!anchor || anchor === currentAnchor) return;

      const id = pinIdFromHref(anchor.getAttribute("href"));
      const info = pins.get(id);
      if (!info) return;

      currentAnchor = anchor;
      clearTimeout(hideTimer);
      clearTimeout(hoverTimer);
      hoverTimer = setTimeout(() => {
        if (currentAnchor === anchor) openPanel(anchor, info);
      }, 220);
    },
    true
  );

  document.addEventListener(
    "mouseout",
    (event) => {
      const anchor = event.target && event.target.closest && event.target.closest('a[href*="/pin/"]');
      if (!anchor || anchor !== currentAnchor) return;
      if (event.relatedTarget && anchor.contains(event.relatedTarget)) return;

      clearTimeout(hoverTimer);
      currentAnchor = null;
      hideTimer = setTimeout(closePanel, 180);
    },
    true
  );

  window.addEventListener("scroll", closePanel, { capture: true, passive: true });

  /* ------------------------------------------------------------- data intake */

  function ingestLocal(pinList, startAt) {
    let position = startAt || 0;
    let added = 0;
    for (const item of pinList) {
      if (!X.isPin(item)) continue;
      position += 1;
      const slim = X.slimPin(item, position);
      if (!pins.has(slim.id)) added += 1;
      pins.set(slim.id, slim);
    }
    if (added) queueScan();
    return position;
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.source !== X.TAG) return;

    if (msg.type === "reset") {
      pins.clear();
      closePanel();
      document.querySelectorAll(".pinbus-badge").forEach((badge) => badge.remove());
      return;
    }

    if (msg.type === "pins" && Array.isArray(msg.pins)) {
      // Ignore a replayed buffer that belongs to a different search.
      const here = currentQuery();
      if (msg.query && here && msg.query !== here) return;

      for (const pin of msg.pins) pins.set(pin.id, pin);
      queueScan();
    }
  });

  /* -------------------------------------------------------- fallback + routing */

  /**
   * If the fetch hook found nothing (Pinterest moved to a different transport),
   * ask the resource endpoint ourselves. Once per query per tab.
   */
  async function fallbackSearch() {
    if (pins.size > 0) return;

    const query = new URLSearchParams(location.search).get("q");
    if (!query) return;

    if (fallbackTried.has(query)) return;
    fallbackTried.add(query);

    const sourceUrl = "/search/pins/?q=" + encodeURIComponent(query);
    const data = encodeURIComponent(
      JSON.stringify({
        options: {
          query: query,
          scope: "pins",
          bookmarks: [""],
          page_size: 25,
          field_set_key: "srp_pin_grid",
        },
        context: {},
      })
    );
    const url = X.SEARCH_RESOURCE + "get/?source_url=" + encodeURIComponent(sourceUrl) + "&data=" + data;

    try {
      const res = await fetch(url, {
        credentials: "same-origin",
        headers: resourceHeaders(sourceUrl, "www/search/pins.js"),
      });
      if (!res.ok) return;
      const body = await res.json();
      const results =
        (body && body.resource_response && body.resource_response.data && body.resource_response.data.results) || [];
      ingestLocal(results, 0);
    } catch {
      /* stay quiet — this is only a safety net */
    }
  }

  function onRouteChange() {
    closePanel();
    pins.clear();
    document.querySelectorAll(".pinbus-badge").forEach((badge) => badge.remove());
    // Ask the interceptor to replay what it already holds for this query —
    // going back to a search often does not trigger a fresh request.
    window.postMessage({ source: X.TAG, type: "hello" }, "*");
    // Let the hook have a moment; fall back only if it produced nothing.
    setTimeout(fallbackSearch, 2500);
    setTimeout(queueScan, 400);
  }

  setInterval(() => {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    onRouteChange();
  }, 700);

  /* ------------------------------------------------------------------ start */

  window.postMessage({ source: X.TAG, type: "hello" }, "*");
  setTimeout(fallbackSearch, 3000);
  setTimeout(queueScan, 500);
})();
