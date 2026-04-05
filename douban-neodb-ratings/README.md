## 豆瓣条目 NeoDB 评分增强

在豆瓣条目页（书籍、电影、音乐、游戏）上添加 [NeoDB.social](https://neodb.social) 的评分展示和跳转链接。脚本只负责 NeoDB，一个脚本完成这一个功能，其他平台以后另写脚本。

- **脚本文件**: `douban-neodb-ratings.user.js`
- **参考脚本**: [`doubanReadReviewEnhancer.js`](https://github.com/moyuguy/doubanReadReviewEnhancer/blob/master/doubanReadReviewEnhancer.js)，[豆瓣条目跳转NeoDB条目](https://greasyfork.org/zh-CN/scripts/469658-%E8%B1%86%E7%93%A3%E6%9D%A1%E7%9B%AE%E8%B7%B3%E8%BD%ACneodb%E6%9D%A1%E7%9B%AE/code)

### 安装

1. 浏览器安装 Tampermonkey 或其他兼容的用户脚本管理器。
2. 在 Tampermonkey 中创建新脚本，将 `douban-neodb-ratings.user.js` 文件的内容完整复制进去并保存。

### 功能说明

- 在以下豆瓣条目页请求并展示 NeoDB 评分（或“暂无评分”）并提供跳转链接：
  - 书籍：`https://book.douban.com/subject/*`
  - 电影：`https://movie.douban.com/subject/*`
  - 音乐：`https://music.douban.com/subject/*`
  - 游戏：
    - `https://game.douban.com/subject/*`
    - `https://www.douban.com/game/*`
- 只要 NeoDB 上存在对应条目：
  - 有评分：显示 `NeoDB  8.8  (45 人评价)`，并可点击跳转到 NeoDB 条目。
  - 无评分（人数为 0 或 “No enough ratings”）：显示 `NeoDB  暂无评分`，仍然可以点击跳转。
  - 完全没找到 NeoDB 条目时，才会显示 `暂未查到 NeoDB 评分`。

### 主要实现思路（简要）

- **解析豆瓣条目信息**
  - 判断条目类型：`book | movie | music | game`（包括 `www.douban.com/game/*`）。
  - 提取标题、原作名、作者 / 导演 / 表演者等统一到 `unifiedEntry`。
- **向 NeoDB 搜索对应条目**
  - 优先使用「当前豆瓣条目完整 URL」作为查询参数（与 GreasyFork 跳转脚本一致）。
  - 若未命中，再退回用标题进行搜索。
  - 如果搜索结果直接重定向到条目页（如 `https://neodb.social/book/...` / `album/...` / `game/...`），直接在该详情页解析评分。
- **解析 NeoDB 评分（含新旧结构）**
  - 兼容 `.rating-num`、`.rating-people` 等旧结构；
  - 支持 `8.8 / 10` + `45 ratings`、`91 个评分` 等新结构；
  - 特别处理：存在 “No enough ratings” 或评分人数为 0 时，视为“条目存在但暂无评分”。
- **在豆瓣页面展示**
  - 在 `#interest_sectl`（或退化为 `#wrapper`）下方插入一行：
    - 站点名：`NeoDB`（点击跳转 NeoDB 条目）。
    - 评分：如 `8.8` 或 `暂无评分`。
    - 评价人数：例如 `(45 人评价)`（仅在有评分且人数大于 0 时展示）。

### 权限说明

- `@match` 仅匹配豆瓣条目页（书、电影、音乐、游戏）。
- `@connect neodb.social` 允许脚本通过 `GM_xmlhttpRequest` 跨域请求 NeoDB，用于抓取评分和条目信息。

脚本不会对豆瓣或 NeoDB 做任何写操作，也不会访问你的登录状态，只是读取公开页面并在本地渲染一条额外的评分信息。


