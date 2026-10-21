# PinRank — browser extension

Shows **saves, comments and SEO detail on every pin** you browse — search
results, someone's profile, a board, the home feed — so you can judge a keyword
without exporting a CSV first.

It runs inside your own logged-in browser, so there is no cookie to paste and no
API key — Pinterest's own session is already there. Every person who installs it
uses **their own Pinterest account**: requests are made with that browser's
cookies and csrftoken, so a team can install the same folder and each sees the
counts and pinning permissions of their own login.

## Install

1. Open `chrome://extensions` (or `edge://extensions`).
2. Turn on **Developer mode**.
3. Click **Load unpacked** and pick this folder (the one containing `manifest.json`).
4. Open any Pinterest search, e.g.
   <https://www.pinterest.com/search/pins/?q=crochet%20coasters%20flower>.

Reload a tab that was already open. The extension needs Chrome/Edge 111+.

## What you get

**On every card** — a small label in the top-left:

```
#6  21.8k saves  51 comments  3mo
```

- `#6` — its position in the search results (modules and ads are not counted).
  Search pages only: profiles and boards have no ranking to report
- `21.8k saves` — save count
- `51 comments` — comment count
- `3mo` — age of the pin (created date). The tooltip carries the exact date

Counts are read from the pin itself, so they match the number on the pin page
rather than a cached feed snapshot. Labels wrap onto a second line on narrow
cards, and the badge carries the full exact numbers as a tooltip.

**On hover** — a panel with saves / comments / repins, the created date, domain,
pinner and followers, board size, image size and ratio, rich-pin type,
Pinterest's topic annotations, hashtags, alt text, and the description length.

**Save pin** — a button at the bottom of that panel collects the pin. Saved pins
get a `✓ saved` mark on their badge, and the toolbar icon lists how many are
stored and exports them as one CSV.

**On a pin page** — the same label sits on the main image and the panel opens on
hover, so opening a pin keeps its numbers in view.

## Saving pins and exporting

1. Hover a pin and click **Save pin**. The count goes up on the toolbar icon.
2. Repeat on as many pins as you like, on any Pinterest page.
3. Click the PinRank icon → **Export CSV**.

The CSV is a snapshot of what the overlay knew when you clicked, so later edits
on Pinterest cannot change a list you already collected. One row per pin, with:

```
saved_at, position, pin_id, pin_url, title, description, saves, comments,
repins, created_at, domain, outbound_link, pinner, pinner_name, followers,
board, board_pins, image_width, image_height, aspect_ratio, rich_type,
rich_site, pinterest_topics, hashtags, alt_text, seo_title, category,
interest_tags, promoted, search_query, source_url
```

`position` and `search_query` are filled when you save from a search page; on
profiles and boards they are blank. The file is UTF-8 with a BOM, so Excel opens
it correctly, and commas, quotes and line breaks inside descriptions are escaped.

**Clear** empties the list (the CSV you already downloaded is untouched). Saved
pins live in `chrome.storage.local` for this browser profile only — they are not
synced and never leave your machine.

## How it works

```
any Pinterest feed request
        │
        ├─ interceptor.js (MAIN world, document_start)
        │     wraps fetch + XMLHttpRequest, clones every
        │     /resource/ response and mines it for pins
        │       • search  → numbers the real pins 1..N,
        │                  skipping `type:"story"` modules
        │       • profile / board / home feed → collects
        │                  pins as-is, with no position
        │     └─ postMessage ──►
        │
        └─ content.js (ISOLATED world)
              draws one badge per pin; for pins whose payload has
              no save count (profiles return stripped tiles) it calls
              PinResource with the page's own session, two at a time
```

**Two sources, one number.** Search responses already carry exact save counts, so
those badges are free. Profile and board grids often return tiles with no stats
at all — the extension notices the pin in the DOM and asks `PinResource` for it,
using this browser's own cookies. That is also what makes the badge match the
pin page when a feed snapshot is stale.

**Rate-limited.** Only pins near the viewport are fetched, two at a time with a
120 ms gap, up to 80 per page, and every answer is cached for 10 minutes. A page
of 100 pins therefore never becomes 100 simultaneous requests.

If Pinterest ever changes transport and nothing is intercepted, the content
script falls back to calling `BaseSearchResource` itself (once per query).

## Privacy

- All traffic goes to `www.pinterest.com`. Nothing is sent anywhere else.
- No analytics, no third-party code, no dependencies.
- Pin stats are cached in memory for the lifetime of the tab. Saved pins are kept
  in `chrome.storage.local` for this browser profile so the popup can export
  them; they are not synced and are removed when you press **Clear**.

## Limitations

- **You must be logged in** for saves and comments. Logged out, Pinterest does
  not send them and the badge shows whatever is public.
- **No rank outside search.** Profiles, boards and the home feed have no ordering
  to report, so those badges show saves, comments and age only.
- **On search pages**, save counts ride on the ranked payload; comments for a pin
  are fetched on hover. On profiles and boards both counts are fetched up front
  for visible pins.
- Pinterest's pin grid is a moving target. If badges stop appearing, the
  selector `a[href*="/pin/"]` or the `type:"pin"` filter likely needs updating.
- Non-search pages have no feed fallback: if Pinterest moves those feeds to a
  transport the hook cannot see, the extension still badges pins through
  `PinResource` — but it will not know anything the DOM does not show.
- Logged-in results are personalised, so positions here can differ from another
  account's view and from the CLI's logged-out scrape.
- Counts are Pinterest's own numbers. A pin whose tile hides the count can still
  report `saves: 1` in Pinterest's data (the initial save); the overlay shows
  that value rather than guessing at a zero.

## Relationship to the CLI

The extension is for browsing. The CLI is a separate local tool
(`node src/cli.js "<keyword>"`) for bulk research: many keywords, full CSV
export, position history and a competitor-domain view. It is not part of this
repository. Both use the same extraction rules.
