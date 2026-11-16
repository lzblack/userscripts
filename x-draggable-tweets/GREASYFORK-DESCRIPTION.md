Makes every tweet card on x.com draggable as a real link to that tweet. Grab a tweet anywhere outside its text, links and buttons, and drop it wherever a link is accepted: [Glitter Drag](https://addons.mozilla.org/en-US/firefox/addon/glitterdrag/) and other drag-gesture extensions, the tab bar, or a bookmarks folder.

## What you can drag

- Tweets in your timeline and in the replies under a tweet.
- Quoted tweets. Dragging the quote card gives the quoted tweet's link, not the outer tweet's.
- On a tweet's own page, the tweet itself is not draggable (its link is already in the address bar), but a tweet it quotes is.

The link is always the plain tweet URL, `https://x.com/{user}/status/{id}`, without `/analytics`, `/photo/1` or query parameters.

## What stays the same

- Tweet text can be selected as usual, and dragging selected text drags the text.
- Links, buttons, photos and videos inside a tweet work as before.
- Clicking a tweet opens it as before. Ctrl+click (⌘+click on macOS), Shift+click and middle-click open it in a new tab or window, as on any link.

## Requirements

You need to be signed in to x.com. The signed-out site uses a different page layout, and the script does nothing there.

## Feedback

[Open an issue](https://github.com/lzblack/userscripts/issues). Source: [x-draggable-tweets on GitHub](https://github.com/lzblack/userscripts/tree/main/x-draggable-tweets).

---

## Other scripts by the same author

- [豆瓣评分汇](https://greasyfork.org/zh-CN/scripts/572796): all-category rating aggregator for Douban (16 platforms)
- [CJK Double-Click Phrase Select (Firefox)](https://greasyfork.org/zh-CN/scripts/578908): restore whole-run CJK selection on double-click
