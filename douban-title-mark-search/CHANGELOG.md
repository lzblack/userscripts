# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- (Future features will be listed here)

### Changed
- (Changes in existing functionality will be listed here)

### Fixed
- (Bug fixes will be listed here)

## [1.2.4] - 2026-07-06

### Fixed
- 修复富文本广播中书名号《》被拆到不同 inline 节点（如 `<strong>`）时无法转链的问题。匹配范围由「单个文本节点」改为「块级容器内跨节点拼接」，再把命中内容按文本节点局部区间逐一包成链接，保留原有 `<strong>` 等结构。（复现：`douban.com/topic/492754611`）

### Changed
- 匹配缓冲区按最近块级祖先分段，防止未闭合的「《」跨段落贪婪匹配到下游「》」。
- 幂等性改由「已生成搜索链接内的文本不再参与匹配」保证，移除不再需要的 `WeakSet` 标记。

## [1.2] - 2024-XX-XX

### Fixed
- 修复长评论/书评展开后书名号链接失效的问题
- 修复展开长评论后，新展开内容中的书名号无法转换为链接的问题

### Changed
- 优化点击事件监听，减少不必要的 DOM 查询
- 简化 MutationObserver 配置，只监听必要的属性变化
- 改进展开检测机制，使用 requestAnimationFrame 实现更快的响应

### Performance
- 优化性能，减少不必要的检查
- 改进动态内容检测机制，降低 CPU 占用

## [1.1] - 2024-XX-XX

### Added
- 初始版本发布
- 支持将豆瓣网站上的书名号《》转换为可点击的搜索链接
- 支持动态加载的内容（AJAX）
- 性能优化，避免页面卡顿

[Unreleased]: https://github.com/yourusername/douban-title-mark-search/compare/v1.2.4...HEAD
[1.2.4]: https://github.com/yourusername/douban-title-mark-search/compare/v1.2...v1.2.4
[1.2]: https://github.com/yourusername/douban-title-mark-search/compare/v1.1...v1.2
[1.1]: https://github.com/yourusername/douban-title-mark-search/releases/tag/v1.1
