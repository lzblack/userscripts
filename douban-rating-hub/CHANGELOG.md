# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.1.0] - 2026-04-19

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

[Unreleased]: https://github.com/lzblack/userscripts/compare/rating-hub-v1.1.0...HEAD
[1.1.0]: https://github.com/lzblack/userscripts/releases/tag/rating-hub-v1.1.0
