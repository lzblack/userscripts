# 豆瓣评分汇 | Douban Rating Hub

豆瓣全品类（电影、剧集、图书、音乐、游戏、播客）评分聚合 — IMDB、烂番茄、Letterboxd、Goodreads 等 16 个平台。**v1.1.0 起新增：在 title 上方显示外部权威榜单胶囊**（电影/剧集：IMDb Top 250、CC 标准收藏、AFI 百年百大、BFI 影史百大、Letterboxd 人气 250、BBC 21 世纪百大剧集、滚石 100 最伟大电视剧、TSPDT 等；音乐：Grammy 年度专辑）。

## 支持的平台

### 电影/剧集
- IMDB、烂番茄（专业 + 观众）、Metacritic、Letterboxd、TMDB（需配置 API Key）、NeoDB
- 动画额外显示：Bangumi、MAL

### 图书
- Goodreads、Amazon、微信读书、NeoDB

### 音乐
- Discogs、NeoDB

### 游戏
- Steam、Metacritic、NeoDB

### 舞台剧
- NeoDB

### 播客
- 苹果播客、小宇宙（中文播客榜排名 + 播放量）、NeoDB

## 安装

1. 安装 [Tampermonkey](https://www.tampermonkey.net/) 浏览器扩展
2. 从 [GreasyFork](https://greasyfork.org/zh-CN/scripts/572796) 安装脚本

## 配置

点击 Tampermonkey 菜单 → **⚙ 评分汇设置**：
- 设置 TMDB API Key（可选，[申请地址](https://www.themoviedb.org/settings/api)）
- 开关各评分源

## 特性

- **开箱即用** — 绝大多数评分源无需配置
- **智能匹配** — 自动提取 IMDB ID、ISBN、英文标题，支持 TV 季数处理
- **缓存 7 天** — 不重复请求，版本更新自动清旧缓存
- **限频保护** — 自动检测并跨页冷却
- **平台图标** — 每行显示对应平台小图标
- **豆瓣 IMDb 链接化** — 将页面上的 IMDb ID 纯文本变为可点击链接
- **榜单胶囊**（v1.1.0+）— 在 title 上方显示该条目所在的外部权威榜单：
  - **电影/剧集**：IMDb Top 250、CC 标准收藏、AFI 百年百大、BFI 影史百大（2022）、Letterboxd 人气 250、BBC 21 世纪百大剧集、滚石 100 最伟大电视剧、TSPDT 等
  - **音乐**：Grammy 年度专辑等
  - 视觉与豆瓣原生 `.rank-label-other` 一致

## 榜单数据来源

榜单胶囊的数据由独立项目 [douban-rankings](https://github.com/lzblack/douban-rankings) 每周自动爬取并整理，以静态 JSON 形式发布在 `https://rank.douban.zhili.dev`（hosting-agnostic —— 底层可以是 GitHub Pages / Cloudflare Pages / 其他静态托管，域名稳定）。rating-hub 客户端缓存 24 小时，断网或端点不可达时静默降级，不影响其他评分源。

可在 ⚙ 评分汇设置 → "⭐ 榜单显示" section 管理要展示的榜单，或通过 Tampermonkey 菜单 "🔄 强制刷新榜单数据" 手动刷新缓存。

## 关于 NeoDB

本脚本已包含 NeoDB 评分，**无需另外安装**「豆瓣条目 NeoDB 评分增强」。
