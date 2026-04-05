# douban-book-version-marker Design Spec

## Overview

A Tampermonkey userscript that displays a tip near the "想读/在读/已读" buttons on a Douban book page when the user has marked another edition of the same work.

## Problem

Douban treats each edition of a book as a separate subject. A user may mark one edition as "已读" and later visit a different edition without realizing they already tracked this work. The Douban App shows an "已读另一版本" hint, but the web version does not.

## Solution

On each book subject page, query all other editions of the same work for the user's interest status. If any other edition is marked, display a compact tip below the collect buttons.

## Data Flow

1. On page load, find the `/works/{works_id}` link in the sidebar "其他版本" section.
2. Fetch the works page (`/works/{works_id}`), extract all edition subject IDs. Exclude the current subject ID.
3. For each edition, concurrently `fetch('/j/subject/{id}/interest')` (same-domain, carries session cookie).
4. Parse the returned HTML fragment: look for `<input type="radio" value="wish|do|collect" name="interest"` with `checked="checked"`. If found, that edition has a user interest.
5. Collect the edition name (from works page or sidebar) and link for each marked edition.
6. Render the tip below `#interest_sect_level`.

No throttling needed — each request is ~4KB, and all are same-domain same-session requests.

## API Detail

**Endpoint:** `GET /j/subject/{subject_id}/interest`

**Auth:** Session cookie (same-domain fetch, automatic).

**Response (JSON):**
```json
{
  "my_tags": [...],
  "html": "<form>...<input type=\"radio\" value=\"wish\" name=\"interest\" checked=\"checked\" />...</form>",
  "popular_tags": [...],
  "tags": [...]
}
```

**Status detection:** Parse `html` field. The radio button with `checked="checked"` indicates the user's current status:
- `value="wish"` → 想读
- `value="do"` → 在读
- `value="collect"` → 已读
- No `checked` attribute on any radio → not marked.

## UI

**Position:** Immediately below `#interest_sect_level`.

**Status labels:** wish → 想读, do → 在读, collect → 已读.

**Display rules:**
- Other editions marked → show tips (one line per marked edition).
- No other edition marked → show nothing.
- Not logged in → all radios unchecked → show nothing, no error.

**Format (single):**
```
已读另一版本：上海译文出版社（2019）
```

**Format (multiple, ordered 已读 > 在读 > 想读):**
```
已读另一版本：上海译文出版社（2019）
想读另一版本：Vintage International（1989）
```

**Style:**
- Font size: 12px
- Text color: `#999`
- Link color: `#37a` (Douban default)
- Loading state: "正在检查其他版本..." in `#999`

**Edition name is a clickable link** to the corresponding subject page.

## Edge Cases

- **No "其他版本" section or no works link:** Script exits silently.
- **Works page fetch fails:** Script exits silently.
- **Individual edition interest fetch fails:** Skip that edition, display results for the rest.
- **Page is not a book subject page:** `@match` restricts to `https://book.douban.com/subject/*`.

## File Structure

```
douban-book-version-marker/
  douban-book-version-marker.user.js
```

Single-file IIFE, `@grant none`, same-domain `fetch` only.

## Key Functions

- `getWorksUrl()` — extract `/works/{id}` link from sidebar
- `fetchVersionIds(worksUrl)` — fetch works page, parse all subject IDs
- `checkInterest(subjectId)` — fetch `/j/subject/{id}/interest`, return `{ status, name, url }` or null
- `checkAllVersions(ids)` — concurrent checkInterest calls, collect results
- `renderTip(results)` — insert tip DOM below `#interest_sect_level`
- `init()` — entry point, orchestrates the above

Styles injected via `<style>` element (same pattern as douban-neodb-ratings).
