# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.1.3] - 2026-04-19

### Fixed
- **music / non-standard 页面找不到 anchor 导致胶囊不显示**：`RankingRenderer._findAnchor` 放宽 fallback，从只认 `#content > h1` 扩展到 `#content h1` 和顶层 `h1`。修复 music 条目页（如 Midnights）命中 Grammy 后胶囊静默消失的问题
- **Grammy 胶囊左槽显示"—"**：`_formatRank` 对 Grammy source 从 `externalId`（形如 `grammy-aoty-2024`）提取年份，左槽改显示 `2024` 等，更直观

## [1.1.2] - 2026-04-19

### Changed
- **category 动态发现**：去掉 `rankingMarksMain` 里硬编码的 `supportedCategories = ['movie']`，完全依赖 upstream `manifest.categories` 决定消费哪些品类。副作用：**music 品类立刻生效**（豆瓣音乐条目页自动显示 Grammy 等榜单胶囊）；未来 upstream 加新 category 时 consumer 零改动
- **配置面板"⭐ 榜单显示" section**：汇总所有 category cache 里的 source（之前只读 movie cache），每条 meta 前加 category 标签（`movie · 永久 · 250` / `music · 年度 · 67`）

### Upstream 数据变化（无 schema 变化）
- 新增两个 TV 榜单（在 `movie.json` 下，`subCategory: 'tv'`）：BBC 21 世纪百大剧集、滚石 100 最伟大电视剧。rating-hub **零改动**自动显示
- Criterion 覆盖扩大到 1174 条（+44），Bangumi 扩大到 189 条（+176）
- Grammy 扩大到 67 条（music 品类）
- **book 品类从 manifest 移除**：历史原因——书籍多译本/多版本的 single-dbid 映射覆盖率太低。`book.json` 物理文件可能仍在 CDN 但**不再被 manifest 列出**，consumer 通过 manifest discovery 天然不会拉它

## [1.1.1] - 2026-04-19

### Security / Privacy
- **GM_xmlhttpRequest 改为默认匿名请求**：`deps.request` 默认传 `anonymous: true`，`RankingData._fetchJson` 也匿名
  - 修复：查询 Amazon/Goodreads/微信读书等评分时会带浏览器 cookie，导致返回**个性化**搜索结果（如搜 ISBN 看到自己账号相关内容）。匿名模式拿通用公开数据，更符合"评分聚合"的语义
  - 用户影响：升级后建议点 Tampermonkey 菜单 "🔄 强制刷新榜单数据" 清旧 cache（可能含个性化结果的旧链接）

## [1.1.0] - 2026-04-18

### Added
- **榜单胶囊功能**：豆瓣电影条目页 title 上方显示外部权威榜单标记，视觉与豆瓣原生 `.rank-label-other` 一致
  - IMDb Top 250
  - Criterion Collection（CC 标准收藏，显示 spine 编号如 `#1132`）
  - AFI 百年百大电影
  - BFI 影史百大（2022）
  - Letterboxd 人气 250
- **配置面板 "⭐ 榜单显示" section**：总开关 + 每个榜单独立 checkbox + 手动清缓存按钮
- **Tampermonkey 菜单项**："🔄 强制刷新榜单数据"
- **新工具函数**：`escapeHtml`、`normalizeRankingPrefs`、`ConcurrencyGate`（为 v2 多源并发预留）

### Changed
- `@connect` 增加 `rank.douban.zhili.dev`（榜单数据源）
- README 和 GreasyFork description 更新新功能说明

### Technical Notes
- 榜单数据由独立项目 [`douban-rankings`](https://github.com/lzblack/douban-rankings) 维护，以静态 JSON 形式发布在 `https://rank.douban.zhili.dev`（hosting-agnostic）
- 客户端缓存 24 小时，断网或端点不可达时**静默降级**，不影响评分汇核心功能
- CSS 内联豆瓣原生 `.rank-label-other` PNG 纹理（scoped 在 `.rating-hub-rank-marks` 容器内，不污染豆瓣自身样式）
- Schema 契约：`schemaVersion` 不匹配时 consumer 端静默降级而非报错

## [1.0.4] and earlier

Prior version history — see `git log` for details. Highlights:

- 全品类（电影/剧集/图书/音乐/游戏/播客）评分聚合
- 支持 16+ 个评分平台：IMDB、烂番茄、Metacritic、Letterboxd、TMDB、NeoDB、Goodreads、Amazon、微信读书、Bangumi、MAL、Discogs、Steam、苹果播客、小宇宙等
- 智能匹配、缓存、限频保护、豆瓣 IMDb 链接化等基础能力

[Unreleased]: https://github.com/lzblack/userscripts/compare/rating-hub-v1.1.3...HEAD
[1.1.3]: https://github.com/lzblack/userscripts/releases/tag/rating-hub-v1.1.3
[1.1.2]: https://github.com/lzblack/userscripts/releases/tag/rating-hub-v1.1.2
[1.1.1]: https://github.com/lzblack/userscripts/releases/tag/rating-hub-v1.1.1
[1.1.0]: https://github.com/lzblack/userscripts/releases/tag/rating-hub-v1.1.0
