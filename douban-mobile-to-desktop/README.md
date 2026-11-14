# 豆瓣移动版转桌面版

Google 搜索结果里常出现 `m.douban.com` 移动版链接。本脚本做两件事：

1. **Google 结果页**：把这些链接直接改写成桌面版（含 `/url?q=` 包装的链接，以及滚动加载出来的新结果），点进去就是桌面版，不多跳一次。
2. **移动版页面**：从别处（Bing、聊天里的分享链接）进了服务器不会自动跳转的移动版页面时，跳到对应的桌面版。

## 映射

| 移动版 | 桌面版 | 服务器自己会跳吗 |
|---|---|---|
| `m.douban.com/{movie,book,music}/subject/{id}/…` | `{movie,book,music}.douban.com/subject/{id}/…` | 会 |
| `m.douban.com/game/subject/{id}/…` | `www.douban.com/game/{id}/…` | 会 |
| `m.douban.com/{movie,book,music}/review/{id}/` | `{…}.douban.com/review/{id}/` | 会 |
| `m.douban.com/movie/celebrity/{id}/` | `movie.douban.com/celebrity/{id}/` | 跳到**移动版**人物页 |
| `m.douban.com/personage/{id}/` | `www.douban.com/personage/{id}/` | 不会 |
| `m.douban.com/people/{name}/`（只映射根页） | `www.douban.com/people/{name}/` | 不会 |
| `m.douban.com/search/?query=…` | `www.douban.com/search?q=…`（移动版的 `type` 丢弃） | 不会 |
| `m.douban.com/`、`/movie/`、`/book/`、`/music/` | 对应桌面首页 | 不会 |
| `m.douban.com/{group,note,doulist}/…` | `www.douban.com/` 下同路径 | 小组首页会 |

"服务器自己会跳吗"是 2026-11 用桌面 UA 实测的结果；会跳的那些映射只为在 Google 上省一跳。没有桌面对应物或不认识的路径（如 `subject_collection`、用户主页子页）一律不动，不猜。

不能简单地把 `m.` 换成 `www.` 保留路径：那样条目页能靠 www 的 301 落对，但游戏条目、移动版独有页、用户主页子页都是 404，搜索也会丢掉关键词（移动版用 `query`，桌面版用 `q`）。

## 防循环

如果浏览器用的是手机 UA，桌面版可能又把你送回移动版。脚本在 `sessionStorage` 里记下上一次跳转，10 秒内第二次跳向同一目标就停下，留在移动版。

## 测试

```sh
cd douban-mobile-to-desktop && node --test douban-mobile-to-desktop.test.js
```
