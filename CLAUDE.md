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
| `x-draggable-tweets/` | X.com / Twitter | Makes tweet cards draggable as real `<a>` links for drag extensions (e.g., Glitter Drag). Reads tweet URLs from DOM and React fiber internals. |

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
