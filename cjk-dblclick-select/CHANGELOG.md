# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.1] - 2026-05-29

### Fixed
- 嵌套 block 阻断失效：跨节点遍历此前用 `FILTER_REJECT` 跳过嵌套 block 内的文本，但「跳过」不等于「停止」——遍历会越过 block 继续合并另一侧的同级文本。如 `<div>今天<div>新段落</div>剩余</div>` 双击「余」会错选成 `今天新段落剩余`。改为遇到 block 边界即停止遍历，现在正确只选 `剩余`

## [0.2.0] - 2026-05-29

### Changed
- 覆盖范围从「仅汉字」扩展到完整 CJK：在 Han 之外纳入日文假名（平假名/片假名）、注音符号、谚文，以及连写于 CJK 段内的迭代/长音记号（`々ー〆〇ヶヵ`）。日文「汉字+假名」混排现在视为同一段，假名不再断句；韩文双击选到空格为止（正好一个词）
- 边界判定由硬编码码点区间改为 Unicode `\p{Script=...}` 属性正则。`\p{Script=Han}` 自动覆盖全部表意字平面（基本区、扩展 A–F、兼容区），不再只到扩展 B，且无需手维护区间表

## [0.1.0] - 2026-05-19

### Added
- 初始发布。Firefox 双击 CJK 汉字时恢复"选中连续整段汉字到下一个非汉字边界"的旧行为，修复 Firefox 116+ 切换到 ICU4X 后双击只选单字的回归
- UA 自检：Chrome / Edge / Safari 装上后直接 no-op，保留原生分词
- 支持 `<input>` / `<textarea>` 跳过、contenteditable、跨 inline 节点合并、嵌套 block 阻断
- Shadow DOM best-effort 支持（新版 `caretPositionFromPoint` 的 `shadowRoots` 选项）
- 全 frame 注入（`@all-frames true`）
