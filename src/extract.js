/**
 * Pure extraction helpers for the PinRank browser extension.
 *
 * Deliberately free of DOM and chrome.* APIs so the Node suite can exercise the
 * same code the extension runs. It is loaded as a plain (non-module) content
 * script, publishes itself on globalThis, and also exposes itself via
 * module.exports when imported from Node.
 */
(function (root) {
  "use strict";

  const TAG = "pinrank-ext";
  const SEARCH_RESOURCE = "/resource/BaseSearchResource/";
  const PIN_RESOURCE = "/resource/PinResource/";

  const str = (v) => (typeof v === "string" ? v : "");
  const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

  /**
   * A real pin — not a `type: "story"` carousel, a board, or a shopping module.
   * Logged-in responses interleave those with the actual ranked pins.
   */
  function isPin(item) {
    if (!item || typeof item !== "object") return false;
    if (item.type && item.type !== "pin") return false;
    return Boolean(item.id && (item.images || item.pinner));
  }

  /**
   * Probe the shapes Pinterest has used for the same statistic over time.
   * `aggregated_stats.saves` is current; `save_count` is the older shape.
   */
  function readStat(pin, names) {
    const sources = [
      pin && pin.aggregated_pin_data && pin.aggregated_pin_data.aggregated_stats,
      pin && pin.aggregated_pin_data,
      pin,
    ];
    for (const src of sources) {
      if (!src || typeof src !== "object") continue;
      for (const name of names) {
        const value = src[name];
        if (typeof value === "number" && Number.isFinite(value)) return value;
      }
    }
    return null;
  }

  /** Pull the search query out of a resource URL (`data` first, then `source_url`). */
  function queryFromUrl(url) {
    try {
      const u = new URL(url, "https://www.pinterest.com");

      const raw = u.searchParams.get("data");
      if (raw) {
        const parsed = JSON.parse(raw);
        const q = parsed && parsed.options && parsed.options.query;
        if (typeof q === "string" && q) return q;
      }

      const source = u.searchParams.get("source_url") || "";
      const match = /[?&]q=([^&]*)/.exec(source);
      if (match) return decodeURIComponent(match[1].replace(/\+/g, " "));
    } catch {
      /* malformed URL — treat as "no query" */
    }
    return "";
  }

  function hostOf(url) {
    try {
      return new URL(url).hostname.replace(/^www\./, "");
    } catch {
      return "";
    }
  }

  /** Pinterest uses these as stand-ins when a pin has no real destination. */
  const PLACEHOLDER_DOMAINS = new Set(["uploaded by user", "unknown", "pinterest"]);

  function cleanDomain(raw, link) {
    const domain = str(raw).trim();
    if (!domain) return hostOf(str(link));
    if (PLACEHOLDER_DOMAINS.has(domain.toLowerCase())) return "";
    return domain.replace(/^www\./, "");
  }

  function bestImage(pin) {
    const images = pin && pin.images;
    if (!images) return {};
    return (
      images.orig ||
      images["736x"] ||
      images["564x"] ||
      images["474x"] ||
      images["236x"] ||
      {}
    );
  }

  function hashtagsOf(pin) {
    if (Array.isArray(pin.hashtags)) {
      return pin.hashtags
        .map((tag) => (str(tag).startsWith("#") ? str(tag) : `#${str(tag)}`))
        .filter((tag) => tag.length > 1);
    }
    const description = str(pin.description);
    return [...new Set(description.match(/#[\w-]+/g) || [])];
  }

  /** Fat pin object -> the small shape the badge/panel needs. */
  function slimPin(pin, position) {
    const image = bestImage(pin);
    const link = str(pin.link) || str(pin.utm_link);
    const pinner = pin.pinner || {};
    const board = pin.board || {};

    return {
      id: String(pin.id),
      position: position,
      saves: readStat(pin, ["saves", "save_count", "saveCount"]),
      comments: readStat(pin, ["comments", "comment_count", "commentCount"]),
      repins: readStat(pin, ["repins", "repin_count", "repinCount"]),
      title: str(pin.title) || str(pin.grid_title),
      description: str(pin.description),
      link: link,
      domain: cleanDomain(pin.domain || pin.link_domain, link),
      hasLink: Boolean(link),
      pinner: str(pinner.username),
      pinnerName: str(pinner.full_name),
      followers: num(pinner.follower_count),
      board: str(board.name),
      boardPins: num(board.pin_count),
      createdAt: str(pin.created_at),
      richType: str(pin.rich_summary && pin.rich_summary.type_name),
      richSite: str(pin.rich_summary && pin.rich_summary.site_name),
      width: num(image.width),
      height: num(image.height),
      topics: Array.isArray(pin.pin_join && pin.pin_join.visual_annotation)
        ? pin.pin_join.visual_annotation.filter((t) => typeof t === "string").slice(0, 8)
        : [],
      hashtags: hashtagsOf(pin).slice(0, 12),
      alt: str(pin.seo_alt_text) || str(pin.auto_alt_text),
      promoted: Boolean(pin.is_promoted),
    };
  }

  /**
   * Walk any resource payload and return the pin-shaped objects in it.
   *
   * Search responses have a predictable `data.results` array, but profile,
   * board, home-feed and related-pin resources nest pins under whatever key they
   * like. Detecting by shape instead of key name covers all of them.
   */
  function findPins(node, out, depth) {
    const found = out || [];
    const level = typeof depth === "number" ? depth : 0;

    if (!node || typeof node !== "object" || level > 5 || found.length >= 500) return found;

    if (Array.isArray(node)) {
      for (const item of node) {
        if (found.length >= 500) break;
        if (isPin(item)) found.push(item);
        else findPins(item, found, level + 1);
      }
      return found;
    }

    for (const value of Object.values(node)) findPins(value, found, level + 1);
    return found;
  }

  /** PinResource payload -> the fields that are not in the search response. */  function slimDetail(data) {
    const d = data || {};
    const stats = (d.aggregated_pin_data && d.aggregated_pin_data.aggregated_stats) || {};

    return {
      saves: num(stats.saves),
      // comment_count lives in one of two places depending on the pin type
      comments: num(
        (d.aggregated_pin_data && d.aggregated_pin_data.comment_count) ?? d.comment_count
      ),
      repins: num(d.repin_count),
      seoTitle: str(d.seo_title),
      category: str(d.category),
      interestTags: Array.isArray(d.manual_interest_tags)
        ? d.manual_interest_tags.filter((tag) => typeof tag === "string")
        : [],
      hashtags: Array.isArray(d.hashtags)
        ? d.hashtags
            .map((tag) => (str(tag).startsWith("#") ? str(tag) : `#${str(tag)}`))
            .filter(Boolean)
        : [],
    };
  }

  const api = {
    TAG,
    SEARCH_RESOURCE,
    PIN_RESOURCE,
    str,
    num,
    isPin,
    readStat,
    queryFromUrl,
    hostOf,
    cleanDomain,
    bestImage,
    hashtagsOf,
    findPins,
    slimPin,
    slimDetail,
  };

  root.PinRankExtract = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
