## 功能简介

在豆瓣条目页自动显示对应的 [NeoDB.social](https://neodb.social) 评分，并提供跳转链接。目前支持：

- 书籍：`https://book.douban.com/subject/*`
- 电影：`https://movie.douban.com/subject/*`
- 音乐：`https://music.douban.com/subject/*`
- 游戏：
  - `https://game.douban.com/subject/*`
  - `https://www.douban.com/game/*`

效果：在豆瓣自带评分模块下方新增一行 **NeoDB** 评分：

- 有评分时：`NeoDB  8.8  (45 人评价)`（点击 NeoDB 可在新标签打开对应条目）。
- 条目存在但暂无评分（如 “No enough ratings” 或人数为 0）：`NeoDB  暂无评分`（仍可点击跳转）。
- 只有在 NeoDB 上完全找不到对应条目时，才会显示：`暂未查到 NeoDB 评分`。

实现思路部分参考：

- 书籍多站评分脚本 [`doubanReadReviewEnhancer.js`](https://github.com/moyuguy/doubanReadReviewEnhancer/blob/master/doubanReadReviewEnhancer.js)
- 跳转脚本 [「豆瓣条目跳转NeoDB条目」](https://greasyfork.org/zh-CN/scripts/469658-%E8%B1%86%E7%93%A3%E6%9D%A1%E7%9B%AE%E8%B7%B3%E8%BD%ACneodb%E6%9D%A1%E7%9B%AE/code)

---

## 工作原理

### 1. 解析当前豆瓣页面

- 判断当前条目类型：`book | movie | music | game`（包括 `www.douban.com/game/*`）。
- 提取标题、原作名、作者 / 导演 / 表演者等，封装成统一对象 `unifiedEntry`：
  - `type`、`doubanId`、`title`、`isbn`、`originalTitle`、`mainCreator` 等。

### 2. 请求 NeoDB，查找对应条目

- 优先使用「当前豆瓣条目完整 URL」向 NeoDB 搜索：
  - 例如 `https://book.douban.com/subject/2973335/` → `https://neodb.social/search?q=<该URL>&category=book`。
  - 这与现有跳转脚本保持一致，命中率较高。
- 若 URL 搜索未命中，再退回用标题搜索：
  - `https://neodb.social/search?q=<书名/片名/专辑名等>&category=<对应类型>`。
- 如果搜索请求直接重定向到条目页（如 `https://neodb.social/book/...`、`/album/...`、`/game/...`），脚本会直接在该详情页解析评分，不再依赖搜索结果列表结构。

### 3. 解析 NeoDB 评分

脚本尽量兼容 NeoDB 的旧结构和新结构，包括但不限于：

- 旧结构：
  - `.rating-num`、`.rating-people` 等元素。
- 新结构（你提供的 HTML 片段）：
  - `8.8 / 10` 这种形式的 `<h3>`。
  - `45 ratings`、`91 个评分` 等文本。
- 特殊情况处理：
  - 检测 `.undisplay` 区域里的 “No enough ratings” 提示。
  - 如果解析到的评分人数为 0，同样视为“暂无有效评分”。

在这些规则下，脚本会生成统一的结果结构：

- 有评分：`{ site: 'NeoDB', hasRating: true, rating: '8.8', ratingCount: '45', url: '...' }`
- 无评分但有条目：`{ site: 'NeoDB', hasRating: false, url: '...' }`

### 4. 在豆瓣页面展示

- 寻找豆瓣评分区域容器：优先 `#interest_sectl`，退化为 `#wrapper`。
- 注入一行样式友好的评分行：
  - 站点名：`NeoDB`（点击跳转 NeoDB 条目页）。
  - 评分数值：
    - 有评分：显示如 `8.8`。
    - 无评分：显示 `暂无评分`。
  - 评价人数：仅在 `hasRating=true` 且 `ratingCount > 0` 时，以 `(45 人评价)` 形式显示。
- 同时添加 `data-tooltip` 悬浮提示：
  - 有评分：`NeoDB：8.8/10，45 人评价`。
  - 无评分：`NeoDB：暂无评分`。

---

## 已测试示例

- 图书：《微暗的火》  
  - 豆瓣：`https://book.douban.com/subject/2973335/`  
  - NeoDB：`https://neodb.social/book/3mdMMohrlpSduZTeKBBuab`
- 图书：《热爱的代价》  
  - 豆瓣：`https://book.douban.com/subject/37503890`  
  - NeoDB：`https://neodb.social/book/5tpSoAcNOj8lNtKa2koibY`（当前暂无有效评分 → 会显示“NeoDB 暂无评分”）
- 音乐：The Who –《Who's Next》  
  - 豆瓣：`https://music.douban.com/subject/1437579/`  
  - NeoDB（专辑）：`https://neodb.social/album/3nSB6kAyJpEsDfr0zRXLeD`
- 游戏：Nintendo Switch Sports  
  - 豆瓣：`https://www.douban.com/game/35764203/`  
  - NeoDB：`https://neodb.social/game/4da8q9sVesSSx3ZnzZ4O51`

如果你遇到“NeoDB 上明明有条目（甚至有评分），但脚本没有展示或展示不对”的情况，欢迎在 GreasyFork 留言附上：

- 豆瓣链接
- 对应的 NeoDB 链接

方便后续继续优化匹配和解析规则。

---

## 使用说明

1. 安装 Tampermonkey / Violentmonkey 等用户脚本管理器。
2. 安装本脚本（或新建脚本，把源码复制进去）。
3. 打开任意豆瓣条目页（书/电影/音乐/游戏）等待加载完成：
   - 先会看到“NeoDB 评分加载中...”字样。
   - 请求成功后自动替换为 NeoDB 评分或“暂无评分”。
   - 点击 `NeoDB` 文本即可在新标签中打开对应的 NeoDB 条目页。

---

## 权限与隐私

- 仅匹配豆瓣条目页 URL，不会在其它站点注入。
- 通过 `GM_xmlhttpRequest` 调用 `neodb.social` 的公开页面，解析 HTML 中的评分信息。
- 不会对豆瓣或 NeoDB 执行任何写操作，也不会读取你的登录状态或发送你的个人信息。


