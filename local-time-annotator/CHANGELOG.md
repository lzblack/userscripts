# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-05-29

### Added
- Initial release. Appends local time after unambiguous absolute times on any page, non-destructively.
- Tier 1: `<time datetime>` elements.
- Tier 2: in-text time + zero-ambiguity offset marker (`Z` / `UTC` / `GMT` with optional numeric offset, or bare `±HH:MM` / `±HHMM`). Named abbreviations are never matched.
- Tier 2b: timestamps split across inline nodes (e.g. Atlassian Statuspage `<small>May <var>29</var>, <var>08:45</var> UTC</small>`) — annotation appended at the inline container's end.
- DST resolved per-instant by `Intl`; automatic local timezone detection.
- Scoped, debounced `MutationObserver` with a cheap pre-test gate; cached formatters; observer-isolated DOM writes (re-matchable output like `GMT+8` cannot self-annotate).
