# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Monorepo of standalone browser userscripts (Tampermonkey/Violentmonkey). Each script lives in its own directory as a single `*.user.js` file. All scripts are written in plain JavaScript (no build tools, no bundler, no transpiler).

## Scripts

| Directory | Target Site | What it does |
|---|---|---|
| `douban-neodb-ratings/` | Douban (book/movie/music/game pages) | Fetches and displays NeoDB.social ratings alongside Douban's own ratings. Uses `GM_xmlhttpRequest` for cross-origin requests to neodb.social. |
| `douban-title-mark-search/` | Douban (all pages) | Converts Chinese book title marks (`《》`) into clickable Douban search links. Uses MutationObserver for dynamically loaded content. |
| `douban-book-version-marker/` | Douban (book pages) | Shows tips when the user has marked a different edition of the same work (想读/在读/已读). Uses `/j/subject/{id}/interest` AJAX endpoint. |
| `douban-rating-hub/` | Douban (book/movie/music/game pages) | Aggregates ratings from IMDB, Rotten Tomatoes, Metacritic, Letterboxd, TMDB, AniDB, Bangumi, MAL, Goodreads, Amazon, WeChat Reading, and NeoDB. Uses Registry/Strategy pattern with channel-based caching. |
| `douban-feed-mark/` | Douban (homepage feed + `/people/*/statuses` + `/doulist/*`) | Shows user's own mark status (想读/在读/已读 etc.) and rating on book/movie/music items in the broadcast stream and in doulists. Uses `GM_xmlhttpRequest` to query per-category subdomain interest API with caching. Re-entrant `scan()` driven by a debounced MutationObserver picks up lazy-loaded broadcasts. Doulist collection is container-scoped (`.doulist-item` → `.title a`); category comes from the URL subdomain. Games are not supported anywhere in this script — they use a different endpoint (`www.douban.com/j/ilmen/thing/{id}/interest`) and URL form (`www.douban.com/game/{id}/`, plus bare `www.douban.com/subject/{id}/` inside doulists); `game.douban.com` does not resolve. |
| `douban-add-book/` | Amazon (book pages) → Douban (`/new_subject`) | One script spanning two domains. On Amazon: extracts a canonical book payload and checks Douban via `book.douban.com/isbn/{isbn}/` (hit shows rating + link; miss offers "add"). On add: stashes payload (`GM_setValue`, 10-min TTL) and opens Douban's add-book flow, auto-filling ISBN (step 1) and all fillable fields (step 2), then auto-injecting the Amazon cover via `GM_xmlhttpRequest` blob + `DataTransfer` on the upload page. Never auto-submits. Source-agnostic Douban side (payload is the contract) so more sources can be added later. Pure parsing layer has `node --test` tests + `fixture-step1/2/cover.html`. |
| `x-draggable-tweets/` | X.com / Twitter | Makes tweet cards draggable as real `<a>` links for drag extensions (e.g., Glitter Drag). Reads tweet URLs from DOM and React fiber internals. |
| `local-time-annotator/` | All pages | Appends the viewer's local time after unambiguous absolute times (`14:42 UTC` → ` (10:42 AM EDT)`), non-destructively. Tier 1 `<time datetime>`, Tier 2 in-text offset markers, Tier 2b timestamps split across inline nodes (e.g. Atlassian Statuspage). DST resolved per-instant by `Intl`; scoped debounced MutationObserver. Pure logic has `node --test` unit tests + `fixture.html`. English UI (global audience). |

## Development Workflow

There is no build, lint, or test command. Scripts are tested manually:

1. Edit the `.user.js` file locally.
2. Copy the full script content into Tampermonkey's editor and save.
3. Reload the target website and verify behavior.

## Distribution

Scripts are published on [GreasyFork](https://greasyfork.org/). To release an update:

1. Bump `@version` in the `==UserScript==` metadata block.
2. Update `CHANGELOG.md` if the script has one (currently only `douban-title-mark-search/`).
3. Paste the updated script on GreasyFork.

## Conventions

- Each script is a self-contained IIFE (`(function() { 'use strict'; ... })();`).
- The `==UserScript==` metadata block at the top of each file defines match patterns, permissions, and version. Always preserve this block structure.
- Chinese-language UI text and comments are used in the Douban scripts; English in the X.com script. Follow the existing language of each script.
- `GREASYFORK-DESCRIPTION.md` files contain the GreasyFork listing description (separate from `README.md`).
