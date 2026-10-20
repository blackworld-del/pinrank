# Pin Bus — browser extension

Shows **saves, comments and SEO detail on every pin** while you search Pinterest,
so you can judge a keyword without exporting a CSV first.

It runs inside your own logged-in browser, so there is no cookie to paste and no
API key — Pinterest's own session is already there.

## Install

1. Open `chrome://extensions` (or `edge://extensions`).
2. Turn on **Developer mode**.
3. Click **Load unpacked** and pick this `extension/` folder.
4. Open any Pinterest search, e.g.
   <https://www.pinterest.com/search/pins/?q=crochet%20coasters%20flower>.

Reload a tab that was already open. The extension needs Chrome/Edge 111+.

## What you get

**On every card** — a small pill in the top-left:

```
#6  ♥ 21.8k  💬 51
```

- `#6` — its position in the search results (modules and ads are not counted)
- `♥ 21.8k` — saves
- `💬 51` — comments, added once that pin has been inspected

**On hover** — a panel with saves / comments / repins, domain, pinner and
followers, board size, pin age, image size and ratio, rich-pin type, Pinterest's
topic annotations, hashtags, alt text, and the description length.

## How it works

```
Pinterest search request
        │
        ├─ interceptor.js (MAIN world, document_start)
        │     wraps fetch + XMLHttpRequest, clones each
        │     BaseSearchResource response, skips `type:"story"`
        │     modules, numbers the real pins 1..N
        │     └─ postMessage ──►
        │
        └─ content.js (ISOLATED world)
              draws badges, and on hover fetches
              PinResource for comments/repins/SEO fields
```

**Saves are free.** They ride along on the search responses Pinterest already
makes, so the badge costs zero extra requests and updates as you scroll.

**Comments are lazy.** `comment_count` is *not* in the search payload at all —
it only exists on the per-pin endpoint. Fetching it for 100 pins on page load
would be 100 requests, so it is fetched on hover, one pin at a time, and cached
for 10 minutes. That is also why the `💬` number appears only after you have
hovered a pin.

If Pinterest ever changes transport and nothing is intercepted, the content
script falls back to calling `BaseSearchResource` itself (once per query).

## Privacy

- All traffic goes to `www.pinterest.com`. Nothing is sent anywhere else.
- No analytics, no third-party code, no dependencies.
- Nothing is stored on disk: just an in-memory cache for the lifetime of the tab.

## Limitations

- **You must be logged in** for saves and comments. Logged out, Pinterest does
  not send them and the badge shows the rank only.
- **Comments only appear on hovered pins**, by design (see above).
- Pinterest's pin grid is a moving target. If badges stop appearing, the
  selector `a[href*="/pin/"]` or the `type:"pin"` filter likely needs updating.
- Logged-in results are personalised, so positions here can differ from another
  account's view and from the CLI's logged-out scrape.

## Relationship to the CLI

The extension is for browsing. The CLI (`node src/cli.js "<keyword>"`) is for
bulk research: many keywords, full CSV export, position history and a
competitor-domain view. They use the same extraction rules.
