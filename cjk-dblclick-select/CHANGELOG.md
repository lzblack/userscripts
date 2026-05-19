# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-05-19

### Added
- 初始发布。Firefox 双击 CJK 汉字时恢复"选中连续整段汉字到下一个非汉字边界"的旧行为，修复 Firefox 116+ 切换到 ICU4X 后双击只选单字的回归
- UA 自检：Chrome / Edge / Safari 装上后直接 no-op，保留原生分词
- 支持 `<input>` / `<textarea>` 跳过、contenteditable、跨 inline 节点合并、嵌套 block 阻断
- Shadow DOM best-effort 支持（新版 `caretPositionFromPoint` 的 `shadowRoots` 选项）
- 全 frame 注入（`@all-frames true`）
