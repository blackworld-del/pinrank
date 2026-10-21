/**
 * ISOLATED-world content script.
 *
 * Draws a badge on every pin card — search results, profiles, boards, the home
 * feed — with rank (search only), saves, and the comment count, plus a detail
 * panel on hover.
 *
 * Counts come from two places:
 *   1. intercepted page responses (free, instant, carries search rank)
 *   2. PinResource, called with this browser's own session, for pins whose
 *      payload has no save count (profiles return stripped tiles) or whose
 *      feed value may be stale
 *
 * Because everything is fetched with the page's own cookies, each person using
 * the extension sees their own Pinterest account. There is no cookie file and
 * nothing to paste.
 */
(function () {
  "use strict";

  const X = globalThis.PinRankExtract;
  if (!X || window.__pinRankContent) return;
  window.__pinRankContent = true;

  /** Bump with manifest.json; the hover panel prints it so a reload is provable. */
  const VERSION = "0.2.0";

  const DETAIL_TTL_MS = 10 * 60 * 1000;
  const ERROR_TTL_MS = 60 * 1000;

  /** Requests a page may spend prefetching stats, and how fast they go out. */
  const PAGE_FETCH_BUDGET = 80;
  const MAX_INFLIGHT = 2;
  const REQUEST_GAP_MS = 120;

  /** id -> slimPin from an intercepted payload, or a placeholder from the DOM */
  const pins = new Map();
  /** id -> { status, data|error, at } */
  const details = new Map();
  const pending = new Map();
  /** id -> the single badge element kept for that pin */
  const badgeById = new Map();
  /** ids whose counts came from PinResource, so they must not be refetched */
  const authoritative = new Set();
  /** id -> saved snapshot; mirrored into chrome.storage.local for the popup */
  const saved = {};
  const SAVED_KEY = "pinrank:saved";

  const fetchQueue = [];
  let inflight = 0;
  let pumpTimer = 0;
  let fetchBudget = PAGE_FETCH_BUDGET;
  let readyAt = 0;
  let emptyStats = 0;
  let statsDisabled = false;
  let rankedSeen = false;

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

  /** The pin whose closeup is open, or "" anywhere else. */
  function closeupId() {
    const match = /^\/pin\/([^/?#]+)\/?$/.exec(location.pathname);
    return match ? decodeURIComponent(match[1]) : "";
  }

  /** The closeup's main image container, which stands in for a pin card. */
  function closeupHolder() {
    return (
      document.querySelector('[data-test-id="closeup-image-main"]') ||
      document.querySelector('[data-test-id="story-pin-image-box"]')
    );
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
        // Pinterest can redirect a merged pin; never paint another pin's counts.
        if (payload && payload.id && String(payload.id) !== String(id)) {
          throw new Error("pin redirected");
        }
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

        if (result.status === "ok") {
          const d = result.data;
          const info = pins.get(id) || blankPin(id);
          pins.set(id, {
            ...info,
            saves: d.saves != null ? d.saves : info.saves,
            comments: d.comments != null ? d.comments : info.comments,
            repins: d.repins != null ? d.repins : info.repins,
            createdAt: d.createdAt || info.createdAt,
            link: d.link || info.link,
            domain: d.domain || info.domain,
            hasLink: d.hasLink || info.hasLink,
            title: info.title || d.title,
            description: info.description || d.description,
            pinner: info.pinner || d.pinner,
            board: info.board || d.board,
          });
          authoritative.add(id);

          // A missing save count usually means the browser is logged out. Stop
          // prefetching rather than spending the page budget on it.
          if (d.saves == null && info.saves == null) {
            emptyStats += 1;
            if (emptyStats >= 3) statsDisabled = true;
          } else {
            emptyStats = 0;
          }

          enrichSaved(id);
        }

        if (panelId === id) renderPanel(id);
        if (result.status === "ok") queueScan(); // badge now has the counts
        return result;
      });

    pending.set(id, task);
    return task;
  }

  /** A pin we know exists (from the DOM) but have no payload for yet. */
  function blankPin(id) {
    return {
      id,
      position: null,
      saves: null,
      comments: null,
      repins: null,
      title: "",
      description: "",
      link: "",
      domain: "",
      hasLink: false,
      pinner: "",
      pinnerName: "",
      followers: null,
      board: "",
      boardPins: null,
      createdAt: "",
      richType: "",
      richSite: "",
      width: null,
      height: null,
      topics: [],
      hashtags: [],
      alt: "",
      promoted: false,
    };
  }

  /* ------------------------------------------------------------------ saved */

  /**
   * Saving is local and snapshot-based: everything the overlay knows about a pin
   * is copied at the moment you click, so later edits on Pinterest cannot change
   * a list you already collected (or exported).
   */
  function storageArea() {
    const api = globalThis.chrome;
    return (api && api.storage && api.storage.local) || null;
  }

  function replaceSaved(next) {
    for (const id of Object.keys(saved)) delete saved[id];
    Object.assign(saved, next || {});
  }

  function recordFor(id) {
    const info = pins.get(id) || blankPin(id);
    const detail = details.get(id);
    const data = detail && detail.status === "ok" ? detail.data : {};

    return {
      ...info,
      seoTitle: data.seoTitle || "",
      category: data.category || "",
      interestTags: data.interestTags || [],
      savedAt: new Date().toISOString(),
      query: currentQuery(),
      sourceUrl: location.href,
    };
  }

  function toggleSaved(id) {
    if (!id) return;

    if (saved[id]) delete saved[id];
    else saved[id] = recordFor(id);

    const area = storageArea();
    if (area) area.set({ [SAVED_KEY]: saved });

    if (panelId === id) renderPanel(id);
    queueScan();
  }

  function loadSaved() {
    const area = storageArea();
    if (!area) return;

    area.get(SAVED_KEY, (result) => {
      replaceSaved(result && result[SAVED_KEY]);
      if (panelId) renderPanel(panelId);
      queueScan();
    });
  }

  /**
   * A pin can be saved the instant the panel appears, before its detail request
   * lands. Fill the blanks once it does, so the CSV carries the SEO fields too —
   * but never overwrite a value the snapshot already captured.
   */
  function enrichSaved(id) {
    const record = saved[id];
    const info = pins.get(id);
    if (!record || !info) return;

    const detail = details.get(id);
    const data = detail && detail.status === "ok" ? detail.data : {};
    const candidates = {
      saves: info.saves,
      comments: data.comments != null ? data.comments : info.comments,
      repins: info.repins,
      title: info.title,
      description: info.description,
      link: info.link,
      domain: info.domain,
      pinner: info.pinner,
      pinnerName: info.pinnerName,
      followers: info.followers,
      board: info.board,
      boardPins: info.boardPins,
      createdAt: info.createdAt,
      width: info.width,
      height: info.height,
      richType: info.richType,
      richSite: info.richSite,
      topics: info.topics,
      hashtags: info.hashtags,
      alt: info.alt,
      seoTitle: data.seoTitle,
      category: data.category,
      interestTags: data.interestTags,
    };

    let changed = false;
    for (const [key, value] of Object.entries(candidates)) {
      const current = record[key];
      const blank = current == null || current === "" || (Array.isArray(current) && current.length === 0);
      const known = value != null && value !== "" && !(Array.isArray(value) && value.length === 0);

      if (blank && known) {
        record[key] = value;
        changed = true;
      }
    }

    if (!changed) return;

    const area = storageArea();
    if (area) area.set({ [SAVED_KEY]: saved });
    if (panelId === id) renderPanel(id);
  }

  /** Keep panels in other tabs in step with a save made here. */
  function watchSaved() {
    const api = globalThis.chrome;
    if (!api || !api.storage || !api.storage.onChanged) return;

    api.storage.onChanged.addListener((changes, namespace) => {
      if (namespace !== "local" || !changes[SAVED_KEY]) return;
      replaceSaved(changes[SAVED_KEY].newValue);
      if (panelId) renderPanel(panelId);
      queueScan();
    });
  }

  /**
   * Prefetch one pin's counts using this browser's own Pinterest session — the
   * same cookies and csrftoken the page itself uses, so every person sees their
   * own account with no cookie file to paste.
   *
   * Called only for pins near the viewport, and only when the intercepted
   * payload did not already supply a trustworthy save count.
   */
  function maybeFetchStats(id) {
    if (statsDisabled || authoritative.has(id)) return;
    if (pending.has(id) || fetchQueue.includes(id)) return;
    if (Date.now() < readyAt) return;
    if (fetchBudget <= 0) return;

    // On a search page the ranked payload (or its fallback) owns the data; do
    // not race it with one request per card.
    if (currentQuery() && !rankedSeen) return;

    // Don't burn budget retrying a request that just failed.
    const known = details.get(id);
    if (known && known.status === "error" && Date.now() - known.at < ERROR_TTL_MS) return;

    const info = pins.get(id);
    // A ranked search pin already has an exact save count in the response.
    if (info && info.position && info.saves != null) return;

    fetchBudget -= 1;
    enqueue(id);
  }

  function enqueue(id) {
    if (pending.has(id) || fetchQueue.includes(id)) return;
    fetchQueue.push(id);
    pump();
  }

  function pump() {
    if (pumpTimer || inflight >= MAX_INFLIGHT || fetchQueue.length === 0) return;

    const id = fetchQueue.shift();
    inflight += 1;
    loadDetails(id).finally(() => {
      inflight -= 1;
      pump(); // fill the free slot
    });

    // Pace new requests; Pinterest rate-limits bursts.
    pumpTimer = setTimeout(() => {
      pumpTimer = 0;
      pump();
    }, REQUEST_GAP_MS);
  }

  /* ------------------------------------------------------------------ badge */

  function badgeTitle(info, comments) {
    const parts = [];
    if (info.position) parts.push("position " + info.position);
    if (info.saves != null) parts.push(info.saves.toLocaleString() + " saves");
    if (comments != null) parts.push(comments.toLocaleString() + " comments");
    const created = X.isoDate(info.createdAt);
    if (created) parts.push("created " + created);
    if (saved[info.id]) parts.push("saved to PinRank");
    if (info.id) parts.push("pin " + info.id);
    return parts.join(" · ");
  }

  function attachBadge(anchor, info) {
    // Nothing to say yet (stats still loading, or logged out on a non-search page).
    if (info.position == null && info.saves == null && info.comments == null) return null;

    let badge = badgeById.get(info.id);

    // The card may have been re-rendered, or a better anchor may have appeared.
    if (badge && (!badge.isConnected || !anchor.contains(badge))) {
      badge.remove();
      badge = null;
    }

    if (!badge) {
      if (getComputedStyle(anchor).position === "static") anchor.style.position = "relative";
      badge = el("div", "pinrank-badge");
      badge.setAttribute("data-pinrank", "1");
      badge.setAttribute("data-pin", info.id);
      badgeById.set(info.id, badge);
      anchor.appendChild(badge);
    }

    // A virtualised grid can hand this anchor to a different pin. Never leave
    // the previous pin's label behind: it would show the wrong counts.
    for (const other of anchor.querySelectorAll(":scope > .pinrank-badge")) {
      if (other === badge) continue;
      other.remove();
      const otherId = other.getAttribute("data-pin");
      if (badgeById.get(otherId) === other) badgeById.delete(otherId);
    }

    const detail = details.get(info.id);
    const comments = detail && detail.status === "ok" ? detail.data.comments : info.comments;
    const age = X.ageLabel(info.createdAt);

    // Scans run on every page mutation plus a 2s sweep; only touch the DOM when
    // the numbers actually changed.
    const signature = [info.position, info.saves, comments, age, saved[info.id] ? "1" : "0"].join("|");
    if (badge.dataset.sig === signature) return badge;
    badge.dataset.sig = signature;

    badge.textContent = "";

    // Words, not emoji: a heart means "likes" everywhere else on the web.
    if (info.position) badge.appendChild(el("span", "pinrank-rank", "#" + info.position));

    if (info.saves != null) {
      badge.appendChild(
        el("span", "pinrank-save", fmt(info.saves) + (info.saves === 1 ? " save" : " saves"))
      );
    }

    if (comments != null) {
      badge.appendChild(
        el("span", "pinrank-comment", fmt(comments) + (comments === 1 ? " comment" : " comments"))
      );
    }

    if (age) badge.appendChild(el("span", "pinrank-age", age));

    // A saved pin stays marked after the pointer leaves, so the list is visible.
    if (saved[info.id]) badge.appendChild(el("span", "pinrank-mark", "✓ saved"));

    badge.title = badgeTitle(info, comments);

    return badge;
  }

  /**
   * Pinterest renders more than one anchor per pin card — the image and the
   * title text are separate links to the same pin. Badging every anchor drew a
   * duplicate label at the top and the bottom of the card, so exactly one is
   * chosen per pin: the biggest visible one, preferring anchors that contain an
   * image.
   *
   * Zero-sized anchors are skipped rather than badged: cards contain hidden
   * links for accessibility and hover overlays, and putting the label on one of
   * those makes the pin look unbranded. If a card has not been laid out yet, the
   * next scan picks it up.
   */
  function scan() {
    // Forget badges whose card Pinterest has removed.
    for (const [id, badge] of badgeById) {
      if (!badge.isConnected) badgeById.delete(id);
    }

    const chosen = new Map();
    const viewportBottom = window.innerHeight + 300;

    // Read phase: measure every anchor before touching the DOM.
    for (const anchor of document.querySelectorAll('a[href*="/pin/"]')) {
      const id = pinIdFromHref(anchor.getAttribute("href"));
      if (!id) continue;

      const rect = anchor.getBoundingClientRect();
      const area = Math.max(0, rect.width) * Math.max(0, rect.height);
      if (area < 25) continue;

      const score = area * (anchor.querySelector("img") ? 1.1 : 1);
      const near = rect.bottom > -300 && rect.top < viewportBottom;

      const best = chosen.get(id);
      if (!best || score > best.score) chosen.set(id, { anchor, score, near });
      else if (near) best.near = true;
    }

    // A pin closeup has no link to itself — Pinterest renders the pin as a big
    // image plus action buttons, so that image is the card to badge.
    const cid = closeupId();
    if (cid) {
      const holder = closeupHolder();
      if (holder && holder.getBoundingClientRect().width > 0) {
        chosen.set(cid, { anchor: holder, score: 0, near: true });
      }
    }

    for (const [id, best] of chosen) {
      // The DOM tells us a pin exists even when the page's payload is stripped
      // (profiles often return tiles without saves). Fill the gap from the API.
      if (!pins.has(id)) pins.set(id, blankPin(id));
      attachBadge(best.anchor, pins.get(id));

      // On a closeup only the pin being viewed is worth a request — the related
      // tiles below it already carry their counts in the page's own payload.
      if (best.near && (!cid || id === cid)) maybeFetchStats(id);
    }

    // Drop badges that are not on the card currently chosen for their pin. A
    // virtualised grid recycles cards, so a badge can outlive the pin it was
    // drawn for; comparing with `chosen` also removes same-pin duplicates.
    for (const node of document.querySelectorAll(".pinrank-badge")) {
      const id = node.getAttribute("data-pin");
      const best = chosen.get(id);
      const tracked = badgeById.get(id);

      if (tracked === node && best && best.anchor === node.parentElement) continue;

      node.remove();
      if (tracked === node) badgeById.delete(id);
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
      panel = el("div", "pinrank-panel");
      panel.setAttribute("data-pinrank", "1");
      (document.body || document.documentElement).appendChild(panel);

      // Event delegation: the panel body is rebuilt on every render, so the
      // listener lives on the panel itself.
      panel.addEventListener("click", (event) => {
        const button =
          event.target && event.target.closest && event.target.closest("[data-pinrank-save]");
        if (!button) return;

        event.preventDefault();
        event.stopPropagation();
        if (panelId) toggleSaved(panelId);
      });

      // The pointer has to travel from the card onto the panel to reach the save
      // button, so the panel keeps itself open while it is hovered.
      panel.addEventListener("mouseenter", () => clearTimeout(hideTimer));
      panel.addEventListener("mouseleave", () => {
        hideTimer = setTimeout(closePanel, 220);
      });
    }
    return panel;
  }

  function renderPanel(id) {
    if (!panel || panelId !== id) return;

    const info = pins.get(id);
    const detail = details.get(id);
    const data = detail && detail.status === "ok" ? detail.data : null;

    panel.textContent = "";

    const head = el("div", "pinrank-head");
    if (info && info.position) head.appendChild(el("span", "pinrank-pos", "#" + info.position));
    head.appendChild(el("span", "pinrank-title", (info && info.title) || "(untitled)"));
    panel.appendChild(head);

    const stats = el("div", "pinrank-stats");
    const stat = (label, value, kind) => {
      const box = el("div", "pinrank-stat pinrank-" + kind);
      box.appendChild(el("b", "", value));
      box.appendChild(el("span", "", label));
      return box;
    };
    stats.appendChild(stat("saves", fmt(data ? data.saves : info && info.saves), "saves"));
    stats.appendChild(stat("comments", data ? fmt(data.comments) : "…", "comments"));
    stats.appendChild(stat("repins", data ? fmt(data.repins) : "…", "repins"));
    panel.appendChild(stats);

    const list = el("dl", "pinrank-rows");
    const row = (key, value) => {
      if (value == null || value === "" || value === "—") return;
      list.appendChild(el("dt", "", key));
      list.appendChild(el("dd", "", String(value)));
    };

    if (info) {
      // "No outbound link" is a claim, so only make it once PinResource replied.
      const linkKnown = Boolean(data) || info.hasLink || Boolean(info.domain);
      row("Domain", info.domain || (linkKnown && !info.hasLink ? "no outbound link" : ""));
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

      const created = X.isoDate(info.createdAt);
      const age = X.ageLabel(info.createdAt);
      row(
        "Created",
        created ? created + (age ? (age === "today" ? " (today)" : " (" + age + " ago)") : "") : ""
      );

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
      // Pinterest's seo_title is the auto-generated "Pin on <board>" fallback it
      // puts in the page <title> when the pin has no title of its own. Showing it
      // beside a real title only repeats the board, so surface it when it is used.
      if (!info.title && data.seoTitle) row("SEO title", data.seoTitle + " (auto)");
      row("Category", data.category);
      if (data.interestTags.length) row("Interest tags", data.interestTags.join("; "));
      if (data.hashtags.length) row("Pin hashtags", data.hashtags.join(" "));
    }

    panel.appendChild(list);

    if (detail && detail.status === "error") {
      panel.appendChild(el("div", "pinrank-note", "Comments unavailable (" + detail.error + ")"));
    } else if (detail && detail.status === "ok" && info && info.saves == null) {
      panel.appendChild(el("div", "pinrank-note", "Log in to Pinterest to see saves and comments."));
    }

    const isSaved = Boolean(saved[id]);
    const action = el("button", "pinrank-act" + (isSaved ? " is-saved" : ""), isSaved ? "Saved — remove" : "Save pin");
    action.type = "button";
    action.setAttribute("data-pinrank-save", "1");
    action.title = isSaved ? "Remove this pin from the CSV list" : "Add this pin to the CSV list";
    panel.appendChild(action);

    panel.appendChild(el("div", "pinrank-foot", "PinRank " + VERSION));
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
    // A panel that is being opened wins over a close scheduled while the pointer
    // crossed from one card to the next.
    clearTimeout(hideTimer);
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

  /**
   * What the pointer is over: a pin card, or — on a closeup — the main image,
   * which has no anchor of its own.
   */
  function hoverTarget(node) {
    if (!node || !node.closest) return null;

    const anchor = node.closest('a[href*="/pin/"]');
    if (anchor) {
      const id = pinIdFromHref(anchor.getAttribute("href"));
      if (id) return { holder: anchor, id };
    }

    const cid = closeupId();
    const holder = cid
      ? node.closest('[data-test-id="closeup-image-main"], [data-test-id="story-pin-image-box"]')
      : null;

    return holder ? { holder, id: cid } : null;
  }

  document.addEventListener(
    "mouseover",
    (event) => {
      const target = hoverTarget(event.target);
      if (!target || target.holder === currentAnchor) return;

      const info = pins.get(target.id);
      if (!info) return;

      currentAnchor = target.holder;
      clearTimeout(hideTimer);
      clearTimeout(hoverTimer);
      hoverTimer = setTimeout(() => {
        if (currentAnchor === target.holder) openPanel(target.holder, info);
      }, 220);
    },
    true
  );

  document.addEventListener(
    "mouseout",
    (event) => {
      if (!currentAnchor) return;
      if (event.relatedTarget && currentAnchor.contains(event.relatedTarget)) return;
      if (event.target !== currentAnchor && !currentAnchor.contains(event.target)) return;

      clearTimeout(hoverTimer);
      currentAnchor = null;
      // Long enough to cross the gap onto the panel; its mouseenter cancels this.
      hideTimer = setTimeout(closePanel, 300);
    },
    true
  );

  window.addEventListener(
    "scroll",
    (event) => {
      // Scrolling inside a tall panel must not dismiss the panel you are using.
      if (panel && event.target && panel.contains(event.target)) return;
      closePanel();
    },
    { capture: true, passive: true }
  );

  /* ------------------------------------------------------------- data intake */

  /**
   * Pins reach us from several resources (search, related modules, previews).
   * A thinner copy must never erase fields we already have, or a card loses its
   * saves — or its badge entirely — when another resource mentions the same pin.
   */
  function mergePin(old, next) {
    if (!old) return next;

    const merged = { ...old };
    for (const [key, value] of Object.entries(next)) {
      if (value == null || value === "") continue;
      if (Array.isArray(value) && value.length === 0) continue;
      merged[key] = value;
    }
    return merged;
  }

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
    if (added) {
      rankedSeen = true;
      queueScan();
    }
    return position;
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.source !== X.TAG) return;

    if (msg.type === "reset") {
      pins.clear();
      badgeById.clear();
      closePanel();
      document.querySelectorAll(".pinrank-badge").forEach((badge) => badge.remove());
      return;
    }

    if (msg.type === "pins" && Array.isArray(msg.pins)) {
      // Ignore a replayed buffer that belongs to a different search.
      const here = currentQuery();
      if (msg.query && here && msg.query !== here) return;

      for (const pin of msg.pins) {
        const old = pins.get(pin.id);
        let merged = mergePin(old, pin);

        // A fetched PinResource value outranks whatever the feed says.
        if (old && authoritative.has(pin.id)) {
          merged = { ...merged, saves: old.saves, comments: old.comments, repins: old.repins };
        }
        if (merged.position) rankedSeen = true;
        pins.set(pin.id, merged);
      }
      queueScan();
    }
  });

  /* -------------------------------------------------------- fallback + routing */

  /**
   * If the fetch hook found nothing (Pinterest moved to a different transport),
   * ask the resource endpoint ourselves. Once per query per tab.
   */
  async function fallbackSearch() {
    // Placeholders created from the DOM are not data: only skip the safety net
    // when a pin actually carries a rank or a save count.
    for (const pin of pins.values()) {
      if (pin.position || pin.saves != null) return;
    }

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
    badgeById.clear();
    authoritative.clear();
    fetchQueue.length = 0;
    fetchBudget = PAGE_FETCH_BUDGET;
    statsDisabled = false;
    emptyStats = 0;
    rankedSeen = false;
    // Give a search page a moment to deliver ranks before paying for requests.
    readyAt = Date.now() + (currentQuery() ? 900 : 0);
    document.querySelectorAll(".pinrank-badge").forEach((badge) => badge.remove());
    // Ask the interceptor to replay what it already holds for this query —
    // going back to a search often does not trigger a fresh request.
    window.postMessage({ source: X.TAG, type: "hello", search: Boolean(currentQuery()) }, "*");
    // Let the hook have a moment; fall back only if it produced nothing.
    setTimeout(fallbackSearch, 2500);
    setTimeout(queueScan, 400);
  }

  setInterval(() => {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    onRouteChange();
  }, 700);

  // React re-renders and virtualised grids drop badges, so re-scan when the page
  // changes. Mutations caused by the overlay itself are ignored — except when one
  // of our badges disappears, which means React rebuilt that card and the badge
  // must be put back.
  const isOverlayNode = (node) =>
    node.nodeType === 1 &&
    node.classList &&
    (node.classList.contains("pinrank-badge") || node.classList.contains("pinrank-panel"));

  const observer = new MutationObserver((records) => {
    for (const record of records) {
      const target = record.target;
      if (target && target.nodeType === 1 && target.closest && target.closest(".pinrank-badge, .pinrank-panel")) {
        continue;
      }

      const added = [...record.addedNodes].filter((node) => node.nodeType === 1);
      const removed = [...record.removedNodes].filter((node) => node.nodeType === 1);

      const addedOnlyOurs = added.length > 0 && added.every(isOverlayNode);
      const lostOurs = removed.some(isOverlayNode);
      if (addedOnlyOurs && !lostOurs) continue;

      queueScan();
      return;
    }
  });

  observer.observe(document.documentElement, { childList: true, subtree: true });

  // Belt and braces: a slow sweep catches cards that rendered while the observer
  // was busy, or anchors that only got their size after the last scan.
  setInterval(() => {
    if (document.hidden || pins.size === 0) return;
    queueScan();
  }, 2000);

  /* ------------------------------------------------------------------ start */

  console.info("[PinRank] overlay " + VERSION);

  loadSaved();
  watchSaved();

  // Search ranks should arrive before we start spending requests on stats.
  readyAt = Date.now() + (currentQuery() ? 900 : 0);

  window.postMessage({ source: X.TAG, type: "hello", search: Boolean(currentQuery()) }, "*");
  setTimeout(fallbackSearch, 3000);
  setTimeout(queueScan, 500);
})();
