豆瓣全品类（电影、剧集、图书、音乐、游戏、播客）评分聚合 — IMDB、烂番茄、Letterboxd、Trakt、Goodreads 等 17 个平台。**v1.1.0 起新增：在 title 上方显示外部权威榜单胶囊**（电影/剧集：IMDb Top 250、CC 标准收藏、AFI 百年百大、BFI 影史百大、Letterboxd 人气 250、BBC 21 世纪百大剧集、滚石 100 最伟大电视剧、TSPDT 等；音乐：Grammy 年度专辑），视觉与豆瓣原生一致。

## 支持的平台

**电影/剧集**
IMDB · 烂番茄（专业+观众）· Metacritic · Letterboxd · TMDB · Trakt · NeoDB

**动画**（自动检测）
Bangumi · MAL

**图书**
Goodreads · Amazon · 微信读书 · NeoDB

**音乐**
Discogs · NeoDB

**游戏**
Steam · Metacritic · NeoDB

**舞台剧**
NeoDB

**播客**
苹果播客 · 小宇宙（中文播客榜排名+播放量）· NeoDB

## 特性

- **开箱即用** — 绝大多数评分源无需配置，安装即可使用（TMDB 和 Trakt 需要可选的 API Key）
- **智能匹配** — 自动提取 IMDB ID、ISBN、英文标题等进行跨平台精准匹配
- **模糊匹配视觉提示**（v1.1.4+）— 通过文本搜索（非硬 ID）命中的评分会显示淡色 `~` 标记，hover 看 tooltip。让你对潜在错配有视觉警觉，不被错的分数误导
- **两层缓存**（v1.1.5+）— 评分结果短 TTL（7 天）+ 跨平台身份映射长 TTL（90 天），下次访问跳过搜索直接拿分
- **限频保护** — 自动检测平台限流并跨页冷却；连续失败自动屏蔽避免 hammer 失效 API
- **已包含 NeoDB** — 无需另外安装「豆瓣条目 NeoDB 评分增强」，本脚本已覆盖 NeoDB 评分
- **隐私默认** — 所有跨站请求匿名（不带浏览器 cookie），不污染你的 Amazon/Goodreads 等账号搜索历史；Amazon 中文书无 ISBN 自动跳过
- **平台图标** — 每个评分源显示对应平台的小图标
- **榜单胶囊**（v1.1.0+）— title 上方显示外部权威榜单。电影/剧集：IMDb Top 250、CC 标准收藏、AFI 百年百大、BFI 影史百大、Letterboxd、BBC 21 世纪百大剧集、滚石 100 最伟大电视剧等。音乐：Grammy 等。数据来自 `rank.douban.zhili.dev` 静态 JSON，客户端缓存 24 小时，断网静默降级
- **可配置** — Tampermonkey 菜单中可设置 API Key、开关各评分源与榜单；"🗑 清除当前条目评分缓存" 一键重置当前条目所有缓存

## 配置

点击 Tampermonkey 菜单 → **⚙ 评分汇设置**：
- **TMDB API Key**（可选，[申请地址](https://www.themoviedb.org/settings/api)）
- **Trakt Client ID**（可选，[注册 app](https://trakt.tv/oauth/applications/new) 获取；无需 OAuth，不暴露个人信息）
- 开关各评分源

## 更新日志

完整更新历史见 [GitHub Releases](https://github.com/lzblack/userscripts/releases?q=rating-hub) · [CHANGELOG](https://github.com/lzblack/userscripts/blob/main/douban-rating-hub/CHANGELOG.md)

## 反馈

遇到问题或有建议？[提交 Issue](https://github.com/lzblack/userscripts/issues)

---

## 同作者的其他豆瓣增强脚本

- [豆瓣书名号转搜索链接](https://greasyfork.org/zh-CN/scripts/558844) — 《书名号》转可点击的豆瓣搜索链接
- [豆瓣读书版本标记提示](https://greasyfork.org/zh-CN/scripts/572604) — 提示你标记过同一本书的其他版本
- [豆瓣广播标记助手](https://greasyfork.org/zh-CN/scripts/572857) — 在首页广播流中显示你的书影音游标记状态和评分
- [豆瓣一键添书](https://greasyfork.org/zh-CN/scripts/582130) — 在 Amazon 图书页一键把书加进豆瓣（查重 + 自动回填 + 封面）
- [豆瓣一键添游戏](https://greasyfork.org/zh-CN/scripts/591798) — 在 Steam 商店页一键把游戏加进豆瓣（查重 + 自动回填 + 封面）
