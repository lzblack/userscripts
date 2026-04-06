在豆瓣条目页聚合显示多平台评分，覆盖电影、剧集、图书、音乐、游戏、舞台剧、播客。

## 支持的平台

**电影/剧集**
IMDB · 烂番茄（专业+观众）· Metacritic · Letterboxd · TMDB · NeoDB

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

- **开箱即用** — 绝大多数评分源无需配置，安装即可使用（仅 TMDB 需要可选的 API Key）
- **智能匹配** — 自动提取 IMDB ID、ISBN、英文标题等进行跨平台精准匹配
- **缓存** — 评分结果缓存 7 天，不重复请求
- **限频保护** — 自动检测平台限流并跨页冷却
- **已包含 NeoDB** — 无需另外安装「豆瓣条目 NeoDB 评分增强」，本脚本已覆盖 NeoDB 评分
- **平台图标** — 每个评分源显示对应平台的小图标
- **可配置** — Tampermonkey 菜单中可设置 API Key、开关各评分源

## 配置

点击 Tampermonkey 菜单 → **⚙ 评分汇设置**：
- 设置 TMDB API Key（可选，[申请地址](https://www.themoviedb.org/settings/api)）
- 开关各评分源

## 反馈

遇到问题或有建议？[提交 Issue](https://github.com/lzblack/userscripts/issues)
