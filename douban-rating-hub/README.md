# 豆瓣评分汇 | Douban Rating Hub

在豆瓣条目页聚合显示多平台评分。

## 支持的平台

### 电影/剧集
- IMDB、Rotten Tomatoes (专业 + 观众)、Metacritic、Letterboxd、TMDB (需配置 API Key)
- 动画额外显示：AniDB、Bangumi、MAL

### 图书
- Goodreads、Amazon、微信读书

### 全品类
- NeoDB (书/影/音/游)

## 安装

1. 安装 [Tampermonkey](https://www.tampermonkey.net/) 浏览器扩展
2. 从 [GreasyFork](链接待定) 安装脚本

## 配置

点击 Tampermonkey 菜单 → **⚙ 评分汇设置**：
- 设置 TMDB API Key（可选，[申请地址](https://www.themoviedb.org/settings/api)）
- 开关各评分源

## 与 douban-neodb-ratings 共存

如果同时安装了「豆瓣条目 NeoDB 评分增强」，本脚本会自动检测并跳过 NeoDB 评分的重复显示。
