# Local Time Annotator

Appends **your** local time after any unambiguous absolute time on a web page — non-destructively, inline, on any site.

```
14:42 UTC            ->  14:42 UTC (10:42 AM EDT)
19:00Z               ->  19:00Z (3:00 PM EDT)
May 29, 08:45 UTC    ->  May 29, 08:45 UTC (4:45 AM EDT)
```

The original text is never altered; a small, dimmed ` (…)` is added right after it.

## What it annotates

| Tier | Source | Example |
|---|---|---|
| 1 | `<time datetime="…">` elements | `<time datetime="2026-05-28T14:42:00+00:00">` |
| 2 | In-text time + a **zero-ambiguity** offset marker | `14:42 UTC`, `19:00Z`, `2:42 PM GMT`, `09:30 UTC+8`, `15:00 -05:00`, `11:00 GMT+5:30` |
| 2b | Timestamps **split across inline nodes** (e.g. Atlassian Statuspage) | `<small>May <var>29</var>, <var>08:45</var> UTC</small>` |

A "zero-ambiguity" marker is `Z` / `UTC` / `GMT` (optionally with a numeric offset like `UTC+8` or `GMT+5:30`) or a bare numeric offset (`±HH:MM` / `±HHMM`). The script never guesses named abbreviations.

## How it works

1. Parse the time components and the source offset (offsets are bounded to the real-world `UTC-12 … UTC+14`).
2. Build the absolute instant: `Date.UTC(...) − srcOffset`.
3. Format that instant in your local zone with `Intl.DateTimeFormat`. **DST is resolved per-instant by `Intl`** — never computed by hand.

Your local zone comes from `Intl.DateTimeFormat().resolvedOptions().timeZone` (automatic — no configuration). If the source time is already in your local zone, nothing is appended.

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/) or [Violentmonkey](https://violentmonkey.github.io/).
2. Install the script from [GreasyFork](https://greasyfork.org/) *(pending publication)* or directly from [the raw file](https://raw.githubusercontent.com/lzblack/userscripts/main/local-time-annotator/local-time-annotator.user.js).
3. Browse any page — no configuration.

## What it does *not* do (by design)

- **Named abbreviations** (`EDT`, `CST`, `PST`, …) — `CST` alone means China / US-Central / Cuba time; statically ambiguous, so never matched.
- **Relative times** (`2 hours ago`).
- **Bare ISO in plain prose** (`…T14:42:00Z` mid-sentence) — Tier 1 covers the common machine-readable `<time>` case; a raw ISO string embedded in text is intentionally skipped.
- **Missing date** → falls back to today; this can only be off by one hour across a DST transition (time-of-day output is otherwise correct).
- Skips `<script>` / `<style>` / `<noscript>` / `<textarea>` / `<code>` / `<pre>` and `contenteditable` regions.

## Performance

- A cheap regex pre-test gates the DOM walk — pages with no time marker do one test and bail.
- A **scoped, debounced** `MutationObserver` re-scans only added subtrees (idle-callback batched), never the whole page.
- `Intl` formatters are created once and reused.
- DOM writes are isolated: the observer is disconnected during writes, so annotations can never re-trigger the observer (verified: re-matchable output like `GMT+8` does not self-annotate).

## Testing

- Pure logic (offset parsing, free-text scanning, date extraction, conversion, container assembly) has headless unit tests — run `node --test local-time-annotator.test.js` (forced timezones make them machine-independent).
- [`fixture.html`](fixture.html) is a "format zoo" acceptance page. Open it and inspect; `?zone=Asia/Shanghai` forces a zone whose short name (`GMT+8`) is itself re-matchable, exercising the no-self-annotation path.

## Feedback

[Open an issue](https://github.com/lzblack/userscripts/issues).

## License

MIT
