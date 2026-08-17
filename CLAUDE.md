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
| `douban-feed-mark/` | Douban (homepage feed + `/people/*/statuses` + `/doulist/*`) | Shows user's own mark status (想读/在读/已读 etc.) and rating on book/movie/music/game items in the broadcast stream and in doulists. Uses `GM_xmlhttpRequest` with caching; two different interest APIs — book/movie/music use `{subdomain}/j/subject/{id}/interest` (returns `interest_status` + HTML), games use `www.douban.com/j/ilmen/thing/{id}/interest` (returns `action` + `is_modify`; marked requires both). `game.douban.com` does not resolve — games live on `www.douban.com/game/{id}/`, and inside doulists on bare `www.douban.com/subject/{id}/` where the category only shows up in `.abstract` as `类别: 游戏`. Cache keys are `dfm:v3:{category}:{id}` because the two id spaces overlap. Re-entrant `scan()` driven by a debounced MutationObserver picks up lazy-loaded broadcasts. Doulist collection is container-scoped (`.doulist-item` → `.title a`). Pure logic has `node --test` tests. |
| `douban-add-book/` | Amazon (book pages) → Douban (`/new_subject`) | One script spanning two domains. On Amazon: extracts a canonical book payload and checks Douban via `book.douban.com/isbn/{isbn}/` (hit shows rating + link; miss offers "add"). On add: stashes payload (`GM_setValue`, 10-min TTL) and opens Douban's add-book flow, auto-filling ISBN (step 1) and all fillable fields (step 2), then auto-injecting the Amazon cover via `GM_xmlhttpRequest` blob + `DataTransfer` on the upload page. Never auto-submits. Source-agnostic Douban side (payload is the contract) so more sources can be added later. Pure parsing layer has `node --test` tests + `fixture-step1/2/cover.html`. |
| `douban-add-game/` | Steam (store pages) → Douban (`/game/create`) | Same two-domain shape as `douban-add-book/`, payload is the contract. Both sides implemented and used to create real entries. The create form's HTML was never obtainable during development (login wall), so the filler linearizes the form into a token stream and assigns controls to the nearest preceding field label — layout-agnostic, unit-testable without a DOM, and it prints a diagnostic instead of filling when nothing matches. Both create steps share one URL, so the step is detected from content. Order matters and cost a debugging round: Douban re-renders the whole form region once it receives the icon, so the cover is injected **first**, then the script waits for the DOM to go quiet and re-scans before filling — and every value is read back out of the DOM before being reported as 已填, because the banner lives outside the form and would otherwise survive a wipe still claiming success. 开发商/发行商/官网 have no fields on that form at all and are surfaced as a manual-follow-up list. Takes everything from `store.steampowered.com/api/appdetails` and scrapes no Steam DOM, so the mature-content age gate needs no special case — though that gate redirects to `/agecheck/app/`, which the match patterns skip. Fetches the API twice: `l=schinese` for the Chinese name and 简介, `l=english` only for a parseable date (schinese returns `2020 年 9 月 17 日`). Genre mapping keys off Steam's genre **id**, which is stable across locales while `description` is not, and targets the create form's 19 类型 by **name** — `/game/explore`'s filter shows only 15 and its ids do not apply to the create form, so the filler matches checkbox labels, not ids. Steam genres with no Douban target become warnings rather than guesses. Dedup has no ISBN-grade key — it searches `www.douban.com/search?cat=3114` (anonymous-capable) under both names and treats "not found" as a weak signal (`hit`/`maybe`/`none`). Cover is probed down an ordered candidate list because the 600×900 portrait capsule lives under an appid path for some apps, a hashed path for others, and neither for many. Pure layer has `node --test` tests + `fixture-search.html`. |
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
