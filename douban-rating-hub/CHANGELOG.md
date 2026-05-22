# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.1.4] - 2026-05-22

### Added
- **模糊匹配视觉提示**：当某平台的评分通过"按标题搜索"获得（即 `matchConfidence === 'fuzzy'`，可能匹配到错的作品），评分数字会略微变淡（opacity 0.72），并在数字后显示一个浅色 `~` 标记，hover 时 tooltip 提示"此匹配为模糊匹配（按标题搜索），分数可能对应错的作品"。通过 IMDB ID / ISBN 等硬 ID 命中的结果（`exact`）不变。让用户对潜在错配有视觉警觉。

### Changed
- **置信度模型收敛为两档（`exact` / `fuzzy`）**：废弃原 `'high'` 中间档。原 `'high'` 的语义其实是"我们有英文别名可以拿来搜"，**不**代表搜到的结果是对的——例如豆瓣 [36117834](https://movie.douban.com/subject/36117834/) 因别名 normalize 后与 RT 上另一部同名片 `be_yourself` 相等而错配，旧逻辑会把这种错配标成 `'high'` → 不显 `~`。现在 RT / Metacritic / Steam 的所有文本搜索命中都统一为 `fuzzy`，跟 Letterboxd 现有模型对齐。副作用：外片在 RT/MC 行会比 v1.1.3 多很多 `~`——这是诚实的，因为 RT/MC 本就不接受 IMDB ID 查询，所有匹配本质都是 fuzzy。

### Added (utility)
- **Tampermonkey 菜单新增 "🗑 清除当前条目评分缓存"**：在豆瓣条目页（`/subject/`、`/game/`、`/location/drama/`、`/podcast/`）触发，遍历清除所有 `rh2:{doubanId}:*` 缓存键，弹确认后刷新页面。用途：本次置信度模型改动后，老缓存里残留的 `'high'` 不会自动加 `~`；用这个菜单可一键让当前条目重新拉取。也方便日常调试错配。

### Fixed
- **Goodreads 显示"未收录"**（来自 GreasyFork 用户 ikoiii 反馈）：Goodreads 已在搜索端点 `/search?q=` 启用反爬，对无 JS 客户端返回 HTTP 202 + 空 body，导致所有书都搜不到。修复：**有 ISBN 的书改走 `/book/isbn/{isbn}` 直链**（302 自动跳转到详情页，~900 KB HTML），完全跳过被阻断的搜索接口；详情页选择器 `.RatingStatistics__rating` 和 `[data-testid="ratingsCount"]` 已实测仍有效。无 ISBN 的中文书暂无替代搜索接口，行为不变（仍 `no_match`）。
- **Letterboxd 显示"未收录"但实际有分**（来自 GreasyFork 用户 unclexi 反馈，部分修复）：(1) **删除已废弃的 CSI 主路径** `/csi/film/imdb/{id}/ratings-summary/` —— 该端点目前返回 404（"Letterboxd - Not Found"），脚本之前每次查询都要先打一次失败请求再 fallback；现在直接走 `/imdb/{id}/`，每条查询少一次失败往返，移动网络下成功率提升。(2) **豆瓣无 IMDB ID 时不再一刀切**：之前 `meta.imdbId` 缺失时立刻 `no_match`；现在改为 fallback 到 title search（用 originalTitle 在 letterboxd.com/search/films/ 上找）。(3) **修正 title search 结果的置信度**：原代码 `buildSuccess` 把所有命中都标 `matchConfidence: 'exact'`，含 title search 的；现按命中路径区分——`imdb_id` 走 `exact`、title search 走 `fuzzy`（与本版本 `'high'` → `'fuzzy'` 收敛一致，让 `~` 标记正确出现）。
- **RT 显示"未收录"但实际有分**（来自 GreasyFork 用户 unclexi 反馈，部分修复）：搜索结果匹配从"normalize 严格相等"放宽为两阶段——先严格相等，无命中再走子串包含（`nameNorm.includes(queryNorm) || queryNorm.includes(nameNorm)`），仅在 query normalize 后长度 ≥ 4 字符时启用（避免 "Up" / "It" 等短标题误配）。覆盖 RT 上加前后缀的常见情况，如豆瓣 originalTitle "The Avengers" 命中 RT 的 "Marvel's The Avengers" / "The Avengers (2012)"。

- **Amazon 隐私改进 + 搜索词污染防御**：(1) **`creator` 字段提取加 sanitize**——只取前导单一脚本字符串（前导 CJK 或前导 Latin）。防御浏览器侧 DOM 注入（翻译扩展 / 注解类扩展等）污染作者名，例如把 "郑执" 变成 "郑gums" 进而污染 Amazon/Goodreads 等的查询。(2) **Amazon ISBN 改走 `/dp/{ISBN-10}` 直链**——978 前缀 ISBN-13 通过 mod 11 算法转 ISBN-10（豆瓣绝大多数书的 ISBN）。直链命中详情页，**完全跳过 `/s?k=` 搜索**，从而不再把书名以查询字串形式发给 Amazon（不进搜索历史、不进服务端 access log）。少一次请求、隐私性提升。979 前缀 ISBN-13 无 ISBN-10 对应，退回 ISBN 搜索（仍比标题搜索安全）。(3) **CJK-only 无 ISBN 的中文书直接 `no_match`**——Amazon US 几乎不收录纯中文书，跳过避免无谓搜索 + 隐私敏感的书名外泄。如仍嫌请求过多可在「⚙ 评分汇设置」面板里整个禁用 Amazon source（已有功能）。

### Cache invalidation
- 因上述行为变化，bump 受影响 source `version` 强制重拉：`rottentomatoes` 2→3、`metacritic` 4→5、`letterboxd` 1→2、`goodreads` 1→2、`steam` 1→2、`amazon` 1→2。用户升级后这些 channel 的旧缓存自动作废，新值用本版本逻辑重新拉取。

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
