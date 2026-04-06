# 豆瓣评分汇 | Douban Rating Hub

在豆瓣条目页聚合显示多平台评分，覆盖电影、剧集、图书、音乐、游戏、舞台剧、播客。

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

## 关于 NeoDB

本脚本已包含 NeoDB 评分，**无需另外安装**「豆瓣条目 NeoDB 评分增强」。
