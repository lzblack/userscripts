# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.1.7] - 2026-05-25

### Fixed
- **烂番茄 / Metacritic 同名片错配年份**（用户报告：[新版《木乃伊》(36929221)](https://movie.douban.com/subject/36929221/) 抓到 1999 版分数）：RT/MC 无 IMDB ID 查询能力，纯按英文标题文本匹配；当豆瓣英文名是通用标题（如 "The Mummy"）时，会命中最知名的经典老片而非当前条目。IMDB/Letterboxd 用豆瓣 IMDB ID 直连，不受影响。
  - **烂番茄**：搜索结果改为读每行的 `release-year` 属性，用豆瓣年份（±1 容差）消歧——先筛标题相关候选，再在年份匹配的候选里取相关度第一（既避开错年份的经典片，也跳过同年无评分的同名垃圾条目）；无年份匹配时回退「精确→子串」，不回归缺年份条目。fast-path 命中缓存 URL 时额外校验详情页年份，自愈被污染的 slugMap（版本 bump 不清 slugMap）。
  - **Metacritic**：slug 主路径拿到 `premiereYear`，与豆瓣年份冲突（>1）则落到下一路径；兜底从失效的 backend finder API（对标题 query 返回无关结果）改为站内搜索页 `?category=2`（电影）/ `?category=1`（剧集），按「标题相关 → 年份 → 相关度」选片，命中后取详情 API 拿分+评论数。例：新版《木乃伊》经典 slug `the-mummy` 指向 1999 版（49 分），年份守卫拒绝后经搜索正确命中 Lee Cronin 版（47 分）。新增 `@connect www.metacritic.com`。
- **同名片标题来源不稳定导致错配**（如 2025《[碟中谍8](https://movie.douban.com/subject/30433456/)》抓到 1996 初代）：豆瓣 `原作名` 缺失时，`又名` 首个英文别名可能是数字形 "Mission: Impossible 8"（漏掉副标题），而 RT/MC 用的是 "Mission: Impossible - The Final Reckoning"——前者只能子串命中初代，年份也救不回（正确条目压根没进候选）。修复：`extractMeta` 额外暴露 `altTitle`（h1 `v:itemreviewed` 拉丁段，常为规范官方名）；RT/MC 改为**多候选标题轮询**——先用主英文名搜，若命中片年份与豆瓣年份对不上、且有备选名，再用备选名搜（RT 重搜一次、MC 多拼一组 slug + 多搜一次），取年份吻合者。反向也成立：外语片（如《海上钢琴师》h1 是意大利语原名）靠 `又名` 英文名命中，主名先成则不会用备选名，**无回归、无额外请求**。仅在有年份可校验时才启用备选名。
- **重映片取错年份导致漏配**（如《[海上钢琴师](https://movie.douban.com/subject/1292001/)》MC 显示未收录）：豆瓣把中国重映日期排在 `v:initialReleaseDate` 最前（2019 重映在前、1998 意大利原版在后），旧逻辑取第一条得到重映年 2019，而 RT/MC/IMDB 按原始年 1998 编目 → 年份消歧把正确条目判为错年份。修复：`extractMeta` 改取所有上映日期里的**最早年**（= 原始上映年）。新增纯函数 `earliestReleaseYear` + 单测。
- 核心匹配逻辑抽为纯函数 `pickByYearThenTitle` 并加 Node 单测（`test/match.test.cjs`，`node --test`），用**真实 RT/MC 搜索 HTML fixture** 坐实「2026 版选 Lee Cronin、1999/2017 版不回归、同年但标题无关的片不误配」；多候选轮询 + 最早年逻辑用真实 live 数据端到端验证（碟中谍走备选名命中 2025、海上钢琴师取 1998 原始年命中、不回归）。

### 健壮性 & 安全
- **请求超时**：`deps.request` 与榜单 `_fetchJson` 加 15s 超时 + `ontimeout` 拒绝，避免外站请求卡死导致评分行永久「加载中」。
- **外链 scheme 白名单**：渲染评分行 / 榜单胶囊链接前用 `safeLinkUrl()` 校验，仅放行 `http(s)`，防止被污染的上游榜单数据注入 `javascript:` 等非法 href。

### 内部重构（行为不变）
- 抽出 `fetchSearchDetail()` 公共流程（搜索页 → 候选详情链接 → 详情页解析），迁移 Letterboxd 标题兜底、Goodreads、Amazon 三个标题搜索源去重；逐行核对行为一致（含 ISBN 直链、`/dp/` 直链、anti-bot 请求头、结果作用域内选链等分支），并为 `fetchSearchDetail` 补全分支单测（搜索失败 / 搜索即详情页 / 无候选链接 / 详情失败 / 详情 reject / 搜索 reject）。

### Cache invalidation
- bump source version：`rottentomatoes` 3→5、`metacritic` 5→8，让本版年份消歧 + 多候选标题 + 最早年逻辑对已缓存条目立即生效。

## [1.1.6] - 2026-05-22

### Added
- **Trakt 数据源**：电影和剧集页新增 Trakt 评分（10 分制 + 投票人数）。Trakt 用户基数 ~2-3M，偏追剧型核心影视迷，给现有 IMDB / Letterboxd / TMDB / RT / Metacritic 之外多一个社区视角，**尤其补足 TV 评分**（Letterboxd 不收 TV）。匹配机制：豆瓣 #info 有 IMDB ID 时走 `/search/imdb/{imdb_id}` 直链（100% 命中、无 fuzzy 匹配）；无 IMDB ID 退回 `search/movie,show?query=` 标题搜索（仅当标题含拉丁字母）。
- **BYOK 配置**：跟 TMDB Key 同模式——用户需到 https://trakt.tv/oauth/applications/new 自行注册一个 app 拿到 Client ID，填到「⚙ 评分汇设置」面板的 "Trakt Client ID" 字段。**不需要 OAuth、不暴露任何个人信息**——Client ID 只是 API 通行证。留空则 Trakt 行不显示（status: disabled）。

### Fixed
- **TMDB 在剧集页"未收录"**（双重 bug，皆已修）：
  1. **主路径 `/find/{imdb_id}` 忽略 `tv_episode_results` / `tv_season_results`**——豆瓣 TV 季页常存 episode-specific IMDB ID（如 [35758798 亢奋 第三季](https://movie.douban.com/subject/35758798/) 的 tt17719220 = Euphoria S3E1）。TMDB /find 在 `tv_episode_results` 里返回该 episode，但旧代码只看 `movie_results` 和 `tv_results` 两个字段 → noMatch。修复：识别 episode/season，提取 `show_id` 二次 fetch `/tv/{show_id}` 拿 show 级评分（跟 Trakt 行为一致；避免显示单集分误导）。
  2. **Fallback 标题搜索用中文 + 季号 + 仅查 movie**——`meta.title`（如"亢奋 第三季"）直接送 `/search/movie` 端点；既不剥季号也不查电视剧。改为 `stripSeason(meta.originalTitle || meta.title)` + `/search/multi` 同时覆盖 movie + tv。
  
  整体效果：豆瓣"亢奋 第三季"现在显示 TMDB 8.3/10（11K+ votes，整剧综合分），之前必败。
- **Trakt 点击链接 404（剧集页）**：豆瓣 TV 季页的 IMDB ID 通常是某一集的 ID（如 tt17719220 = Euphoria S3E1）→ Trakt 返回 `type: 'episode'`。旧代码错误地把响应里的父剧集 slug 拼到 `/movies/` 路径下（`/movies/euphoria-2019`），必然 404。现在按 type 正确分发：episode/season/show 都走 `/shows/{slug}` + show 级评分（与 IMDB 在 TV 上行为一致）；movie 走 `/movies/{slug}`。豆瓣页是季级时仍显示整剧综合分（季级评分需 P2b 季级映射时再加）。

### Changed
- **评分行折叠门槛改为动态判断**：之前固定阈值 "总通道数 > 7 才折叠"，导致 8 通道（含 Trakt 后的典型电影页）折叠 2 行 + 加 1 个 "展开" toggle = 净省 0 行。改为按净省算——隐藏 ≥ 2 条才折叠（净省 ≥ 1 行才有意义）。同时把 Trakt 加入默认可见通道集合（非动画电影/剧集页），避免 Trakt 用户每次都要展开。

### Cache invalidation
- bump source version：`trakt` 1→2（修复 URL bug 必须重拉旧缓存）、`tmdb` 1→2（让 TMDB fallback 修复立即生效，不必等老缓存过期）。

## [1.1.5] - 2026-05-22

### Added
- **`error` 状态负缓存 + 连续失败升级**：之前任何 `error`（HTTP 5xx / 网络异常 / fetch 抛错）都**不缓存**，意味着每次刷新页面失败的 source 都重试，可能 hammer 失效中的外站 API。现在 error 状态也缓存：首次/偶发 30 分钟 TTL；连续 3 次失败后 TTL 升级到 7 天（视为暂时不可用）。任何非 error 响应（含 no_match / no_rating / rate_limited / success）都会**重置失败计数**——证明 channel 仍在响应。orchestrator 的 catch 块也会写 cache（之前 fetch 抛异常时完全不写）。
- **两层缓存重构：slugMap（长 TTL 90 天）+ channel cache（短 TTL 7 天）**：之前 channel cache 把 slug/详情 URL 跟分数绑在一起 7 天后整体作废，每周要重做 fuzzy 搜索找 slug；slug 几乎永不变，分数才会变，这两件事 TTL 不应一样。新增 `rh2:slugmap:{doubanId}` 键，跨 channel 存 `{channelKey → {url, matchedBy, confidence}}`。命中后某 source 跳过搜索/匹配步骤，直接抓详情页拿分；channel cache 过期重拉时只重抓分数，**fuzzy 搜索从每 7 天 1 次降到每 90 天 1 次**。slugMap 也是后续 manual override（P2b）的基础——`source: 'manual'` 字段已预留。
- **当前接入 fast path 的 source**：Letterboxd、Rotten Tomatoes（最高价值——LB title-search 节省一次搜索请求；RT 每次省一次 ~200KB 搜索页下载）。其它 source 继续走原流程，不受影响。后续版本逐步接入 Metacritic / Bangumi / MAL 等。

### Changed
- **"🗑 清除当前条目评分缓存" 菜单扩展清理范围**：之前只清 `rh2:{doubanId}:{channel}:{ver}` 形态的 channel cache；现在同时清 `rh2:slugmap:{doubanId}`（slugMap）和 `rh2:fail:{doubanId}:{channel}`（失败计数）。一次菜单点完全重置当前条目所有缓存状态。

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
