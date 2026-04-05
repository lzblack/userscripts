# 更新日志管理最佳实践指南

## 核心原则

### 1. 使用标准格式
- **文件位置**: 项目根目录的 `CHANGELOG.md`
- **格式标准**: [Keep a Changelog](https://keepachangelog.com/)
- **版本规范**: [Semantic Versioning (SemVer)](https://semver.org/)

### 2. 版本号规范 (SemVer)

格式：`主版本号.次版本号.修订号` (MAJOR.MINOR.PATCH)

- **MAJOR** (主版本号): 不兼容的 API 修改
  - 例如：1.2.0 → 2.0.0
  - 重大功能变更或破坏性更改

- **MINOR** (次版本号): 向下兼容的功能性新增
  - 例如：1.1.0 → 1.2.0
  - 新功能、新特性

- **PATCH** (修订号): 向下兼容的问题修正
  - 例如：1.2.0 → 1.2.1
  - Bug 修复、小改进

### 3. 日志分类

每个版本按以下类别组织：

- **Added**: 新功能
- **Changed**: 对现有功能的变更
- **Deprecated**: 即将移除的功能
- **Removed**: 已移除的功能
- **Fixed**: Bug 修复
- **Security**: 安全相关的修复

### 4. 编写规范

#### ✅ 好的做法

```
### Fixed
- 修复长评论展开后书名号链接失效的问题
- 修复在某些页面书名号重复转换的问题

### Changed
- 优化点击事件监听，减少不必要的 DOM 查询
- 改进 MutationObserver 配置，提升性能
```

#### ❌ 避免的做法

```
- 修复了一些 bug
- 改进了性能
- 更新了代码
```

### 5. 工作流程

#### 开发时
1. 在 `[Unreleased]` 部分记录所有变更
2. 按类别组织（Added, Changed, Fixed 等）

#### 发布时
1. 将 `[Unreleased]` 的内容移到新版本号下
2. 添加发布日期
3. 更新版本链接（如果使用 Git）
4. 创建新的 `[Unreleased]` 部分

#### 示例流程

```markdown
## [Unreleased]
### Fixed
- 修复某个 bug

## [1.2.0] - 2024-01-15
### Fixed
- 修复长评论展开后书名号链接失效的问题
```

## 自动化工具

### 1. 使用 Git Tags

```bash
# 创建版本标签
git tag -a v1.2.0 -m "版本 1.2.0: 修复展开评论问题"

# 推送标签
git push origin v1.2.0
```

### 2. 使用自动化工具（可选）

- **standard-version**: 自动生成 CHANGELOG 和版本号
- **release-it**: 自动化版本发布流程
- **conventional-changelog**: 基于 commit 信息生成 CHANGELOG

## GreasyFork 更新说明

在 GreasyFork 上更新脚本时，可以从 CHANGELOG.md 中提取对应版本的更新内容：

```markdown
版本 1.2 更新内容：

- 修复长评论展开后书名号链接失效的问题
- 优化性能，减少不必要的检查
- 改进动态内容检测机制
```

## 最佳实践检查清单

- [ ] CHANGELOG.md 文件存在且格式正确
- [ ] 版本号遵循 SemVer 规范
- [ ] 每个版本都有明确的日期
- [ ] 变更按类别组织（Added, Changed, Fixed 等）
- [ ] 使用清晰、具体的描述
- [ ] 避免使用技术术语，使用用户友好的语言
- [ ] 每个版本都有对应的 Git tag（如果使用 Git）
- [ ] 保持 CHANGELOG 与代码同步更新

## 参考资源

- [Keep a Changelog](https://keepachangelog.com/)
- [Semantic Versioning](https://semver.org/)
- [Conventional Commits](https://www.conventionalcommits.org/)
