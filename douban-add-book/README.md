# 豆瓣一键添书 | One-Click Add to Douban

在 Amazon 图书页查豆瓣是否收录；未收录则一键跳转豆瓣「添加书籍」流程、自动回填全部可填字段并注入封面。人工只审核和提交，绝不自动提交任何表单。

## 安装

[GreasyFork 安装页面](https://greasyfork.org/zh-CN/scripts/582130)

## 使用流程

1. 打开 Amazon 图书页，标题下方角标显示豆瓣查重结果：已收录（带评分直达）/ 有其他版本 / 未收录（可添加）/ 查重失败（转手动搜索）。
2. 点「添加到豆瓣」，新标签打开添加页，脚本自动填好 ISBN，你点「下一步」。
3. 第二步表单自动回填书名、副标题、作者（多作者自动加行）、定价、出版社、出版日期、装帧、页数、内容简介、作者简介；顶部摘要条列出已填 / 跳过 / 警告，核对后点「下一步」。
4. 上传封面页自动注入 Amazon 高清封面，你点「上传图片」。

## 特性

- 查重走 `book.douban.com/isbn/{isbn}/`，命中一次请求即带评分。
- 兼容 Amazon 现行 Rich Product Information 卡片与旧版 detail-bullets / 表格布局。
- 内容简介按结构提取，剥除「Read more」、不重复不错序。
- 多作者自动加行（人物实体关联栏按豆瓣规范留空）。
- 跨标签数据走本地存储传递，10 分钟过期、消费即删。
- 不支持 Kindle / 电子版（无 ISBN，会提示切到纸质版）。

## 开发

- 纯函数解析层（ISBN 校验/转换、标题拆分、日期/定价/装帧/页数归一化、回填计划）有 `node --test` 单测：

  ```sh
  node --test douban-add-book.test.js
  ```

- DOM 回填与封面注入用 `fixture-step1.html` / `fixture-step2.html` / `fixture-cover.html` 离线复现验证。
- 无构建步骤，单文件 IIFE；纯函数与运行期共用同一文件，靠 `module.exports` 守卫区分 node 与浏览器。

## 权限与隐私

- `@match` 仅 `www.amazon.com` 与 `book.douban.com/new_subject`；Amazon 上非图书页静默退出。
- `@connect book.douban.com`：用你的登录态查询 ISBN 是否收录（只读，不做任何写操作）。
- `@connect media-amazon.com / ssl-images-amazon.com`：抓取封面图。
- 不上传任何数据、不接入第三方或分析服务。
