Appends **your** local time after any unambiguous absolute time on a web page — non-destructively, inline, on any site.

```
14:42 UTC            ->  14:42 UTC (10:42 AM EDT)
19:00Z               ->  19:00Z (3:00 PM EDT)
May 29, 08:45 UTC    ->  May 29, 08:45 UTC (4:45 AM EDT)
```

The original text is never changed — a small, dimmed ` (…)` is added right after it. No configuration: your timezone is detected automatically.

## What it annotates

- **`<time datetime="…">`** elements (most reliable).
- **In-text time + a zero-ambiguity marker**: `Z` / `UTC` / `GMT` (optionally with a numeric offset like `UTC+8`, `GMT+5:30`) or a bare numeric offset (`±HH:MM` / `±HHMM`). Examples: `14:42 UTC`, `19:00Z`, `2:42 PM GMT`, `09:30 UTC+8`, `15:00 -05:00`.
- **Split timestamps** assembled across inline nodes — e.g. Atlassian Statuspage's `May 29, 08:45 UTC`, where the time and `UTC` live in separate elements.

## How the conversion works

The source offset is parsed, the absolute instant is computed, and that instant is formatted in your local zone via `Intl.DateTimeFormat`. **Daylight saving is resolved per-instant by the browser** — never hand-computed — so spring/fall transitions are correct. If a time is already in your local zone, nothing is added.

## Scope

- ✅ All sites (`*://*/*`), static and dynamically loaded content (a scoped `MutationObserver` catches late-rendered times).
- ✅ Automatic local timezone; English-style output (`10:42 AM EDT`).
- ⚠️ **Named abbreviations** (`EDT`, `CST`, …) are **not** matched — `CST` alone is ambiguous (China / US-Central / Cuba).
- ⚠️ Relative times (`2 hours ago`) and bare ISO strings embedded in prose are skipped.
- ⚠️ `<input>` / `<textarea>` / `<code>` / `<pre>` / `contenteditable` are left alone.

## Performance & safety

A cheap pre-test gates the page scan, formatters are cached, and DOM writes are isolated from the observer, so re-matchable output (like `GMT+8`) never re-annotates itself and there is no CPU spin.

## Feedback

[Open an issue](https://github.com/lzblack/userscripts/issues). Full docs and test cases: [GitHub README](https://github.com/lzblack/userscripts/tree/main/local-time-annotator); changelog: [CHANGELOG](https://github.com/lzblack/userscripts/blob/main/local-time-annotator/CHANGELOG.md).

---

## Other scripts by the same author

- [豆瓣评分汇](https://greasyfork.org/zh-CN/scripts/572796) — all-category rating aggregator for Douban (16 platforms)
- [CJK Double-Click Phrase Select (Firefox)](https://greasyfork.org/zh-CN/scripts/578908) — restore whole-run CJK selection on double-click
