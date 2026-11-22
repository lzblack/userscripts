## 功能说明

用电脑搜豆瓣时，Google 常给出 `m.douban.com` 移动版链接。本脚本把它们换成桌面版：

- **Google 结果页**：移动版链接直接改写成桌面版，悬停看到的就是桌面地址，点进去不多跳一次。下拉加载出来的结果同样改写。
- **移动版页面**：从 Bing、聊天里的分享链接等其他地方打开了移动版页面，脚本会跳到对应的桌面版。

## 支持的页面

| 移动版 | 桌面版 |
|------|------|
| 书、影、音条目及其短评、长评页 | `book` / `movie` / `music.douban.com/subject/…` |
| 游戏条目 | `www.douban.com/game/…` |
| 影评、书评、乐评 | `…douban.com/review/…` |
| 人物页（含旧的影人链接） | `www.douban.com/personage/…` |
| 用户主页 | `www.douban.com/people/…` |
| 搜索 | `www.douban.com/search?q=…` |
| 首页、电影 / 读书 / 音乐首页 | 对应的桌面首页 |
| 小组、日记、豆列 | `www.douban.com` 下的同一路径 |
| 豆瓣电影 / 读书 Top250 榜单 | `movie` / `book.douban.com/top250` |

没有桌面版对应的页面（如移动版独有的其他榜单、用户主页的子页）保持不动，不会把你送到 404。

其中人物页、用户主页、搜索、Top250 榜单和各首页，豆瓣服务器不会把电脑浏览器送回桌面版；`m.douban.com/movie/celebrity/…` 甚至会被跳到移动版人物页。条目页等其他页面服务器自己会跳，脚本在 Google 上直接改链接，省掉这一跳。

## 权限与隐私

- 只在 Google 搜索结果页和 `m.douban.com` 上运行。
- 不发任何网络请求，不读写任何存储（除了当前标签页的 `sessionStorage` 里一条防循环记录：如果桌面版又把你送回同一个移动版页面，10 秒内不再重复跳转）。

---

## 同作者的其他豆瓣增强脚本

- [豆瓣评分汇](https://greasyfork.org/zh-CN/scripts/572796) — 聚合 IMDB、烂番茄、Letterboxd、Goodreads 等 16 个平台的评分
- [豆瓣条目 NeoDB 评分增强](https://greasyfork.org/zh-CN/scripts/559133) — 在豆瓣条目页加 NeoDB.social 的评分展示
- [豆瓣书名号转搜索链接](https://greasyfork.org/zh-CN/scripts/558844) — 《书名号》转可点击的豆瓣搜索链接
- [豆瓣读书版本标记提示](https://greasyfork.org/zh-CN/scripts/572604) — 提示你标记过同一本书的其他版本
- [豆瓣广播：这个我标过](https://greasyfork.org/zh-CN/scripts/572857) — 首页广播流和豆列里显示你对条目的标记状态和评分
- [豆瓣一键添书](https://greasyfork.org/zh-CN/scripts/582130) — 在 Amazon / O'Reilly 图书页一键把书加进豆瓣（查重 + 自动回填 + 封面）
- [豆瓣一键添游戏](https://greasyfork.org/zh-CN/scripts/591798) — 在 Steam 商店页一键把游戏加进豆瓣（查重 + 自动回填 + 封面）
- [豆仓：豆瓣书影音标记备份](https://greasyfork.org/zh-CN/scripts/602023) — 一次导出全部书影音游戏舞台剧标记（含私密），可导入 NeoDB
