# FigCraft Skills 长期战略

Skills 是 FigCraft 的核心资产——MCP 工具之上的**知识层**。工具是"手"（能做什么），Skills 是"脑"（怎么做好）。

## 当前资产

### 30 个 Skills

| 分类 | Skill | 覆盖能力 |
|------|-------|---------|
| 设计规则 | ui-ux-fundamentals | 通用设计质量（排版/间距/内容/无障碍） |
| 设计规则 | design-creator | 无库模式设计决策 |
| 设计规则 | design-guardian | 有库模式 Token 优先级 |
| 声明式创建 | figma-create-ui | create_frame + Opinion Engine 全流程 |
| Plugin API | figcraft-use | execute_js 基础规则 |
| Plugin API | figcraft-generate-library | 用 JS 建设计系统 |
| 辅助 | figcraft-implement-design | Figma → Code |
| 辅助 | figcraft-code-connect | 组件-代码映射 |
| 辅助 | figcraft-create-design-system-rules | 生成 IDE 规则 |
| 辅助 | figcraft-create-new-file | 创建空白文件 |
| 质量保障 | design-review | 设计审查，输出结构化违规报告 |
| 质量保障 | design-lint | lint + 自动修复全流程 |
| 质量保障 | component-docs | 组件文档自动化 + 结构健康审计 |
| 质量保障 | prototype-analysis | 原型流程分析 + 流程图生成 |
| 质量保障 | text-replace | 批量文本替换 + 本地化 |
| 质量保障 | spec-compare | DTCG 与 Figma 变量对比 |
| 质量保障 | token-sync | DTCG Token 同步到 Figma |
| 设计模式 | responsive-design | 响应式 Web 设计（断点、自适应布局） |
| 设计模式 | figcraft-html-import | HTML / Web 页面导入为可编辑 Figma 图层 |
| 设计模式 | content-states | 空状态/加载/错误状态设计模式 |
| 设计模式 | iconography | 图标排序、工具链、尺寸、样式一致性 |
| 设计模式 | design-handoff | 设计交付（标注、规范导出） |
| 设计模式 | ux-writing | UI 文案规范（按钮、表单、反馈，中英文规则） |
| 平台规则 | platform-ios | iOS 平台（安全区、SF Pro、HIG 导航） |
| 平台规则 | platform-android | Android 平台（Material 3、Roboto、导航） |
| 高级编排 | design-system-audit | 设计系统健康度审计 |
| 高级编排 | migration-assistant | 设计系统版本迁移 |
| 高级编排 | multi-brand | 多品牌 Token 管理 |

### 未覆盖的能力

所有已规划的能力均已覆盖。

## 维护规范

### 目录约束

- **必须扁平**：`skills/<skill-name>/SKILL.md`，Claude Code / Kiro 只扫描直接子目录（不递归）
- **分类通过 README.md** 文档分组，不用目录层级
- **设计规则 skill** 是 MCP Server 的 source of truth，构建时拷贝到 dist/（去 frontmatter）

### SKILL.md 结构规范

```markdown
---
name: skill-name
description: "一句话描述，含触发关键词"
---

# 标题

[简述用途和适用场景]

## Design Direction（如涉及 UI 创建）
1. Always first → load skill: `ui-ux-fundamentals`
2. Library selected → load skill: `design-guardian`
3. No library → load skill: `design-creator`

## Workflow
[步骤化流程]

## Skill Boundaries
[明确边界：什么该用这个 skill，什么该转到其他 skill]
```

### 更新流程

1. 修改 `skills/<name>/SKILL.md`（source of truth）
2. 如果是设计规则 skill → `npm run build` 自动拷贝到 dist/
3. 如果涉及跨 skill 引用 → 检查所有引用方的 SKILL.md
4. `npm test` 确保合约测试通过

## 拓展路线

### Phase 1：将现有 Prompt 提升为 Skill（低成本高收益）

7 个 MCP prompt 提升为 SKILL.md（另外 2 个 prompt `auto-fix` 和 `generate-element` 已被 `design-lint` 和 `figma-create-ui` 覆盖）：

| 优先级 | Prompt → Skill | 价值 |
|--------|---------------|------|
| ✅ | review-design → **design-review** | 创建后自动审查，形成"创建→审查"闭环 |
| ✅ | lint-page → **design-lint** | lint + 自动修复全流程 |
| ✅ | document-components → **component-docs** | 组件文档自动化 |
| ✅ | prototype-flow → **prototype-analysis** | 原型分析 + 流程图生成 |
| ✅ | text-replacement → **text-replace** | 批量文本/本地化 |
| ✅ | compare-spec → **spec-compare** | DTCG 与 Library 对比 |
| ✅ | sync-tokens → **token-sync** | Token 同步全流程 |

### Phase 2：新能力 Skill（中期）

| Skill | 能力 | 依赖 |
|-------|------|------|
| ✅ **responsive-design** | 响应式设计（Web 断点、多尺寸适配） | get_creation_guide(topic:"responsive") 已有 |
| ✅ **content-states** | 空状态/错误状态/加载状态设计 | get_creation_guide(topic:"content-states") 已有 |
| ✅ **platform-ios** | iOS 平台特定规则（安全区、手势、HIG） | 需新建 |
| ✅ **platform-android** | Android 平台规则（Material、48dp） | 需新建 |
| ✅ **design-handoff** | 设计交付（标注、间距、颜色规范导出） | annotations 工具已有 |

### Phase 3：高级编排 Skill（长期）

| Skill | 能力 | 复杂度 |
|-------|------|--------|
| ✅ **design-system-audit** | 设计系统健康度检查（覆盖率、一致性、过时组件） | 高 |
| ✅ **migration-assistant** | 设计系统版本迁移（Token 映射、组件替换） | 高 |
| ✅ **multi-brand** | 多品牌 Token 切换 + 验证 | 高 |

## Skill 编排模式

### 组合模式（已验证）

```
figma-create-ui
  └── loads: ui-ux-fundamentals + design-guardian/design-creator
```

### 链式模式（已实现）

```
创建 → 审查 → 修复 闭环：
  figma-create-ui → design-review → design-lint
```

### 场景模式（已实现）

```
"为 iOS 创建登录页"：
  figma-create-ui + platform-ios + ui-ux-fundamentals + design-guardian
```

## 质量衡量

| 指标 | 当前 | Phase 1 后 | 目标 |
|------|------|-----------|------|
| Skill 覆盖率 | 29 skills | — | 每个用户工作流都有 skill |
| 创建质量 | — | lint 违规率对比 | 有 skill < 无 skill |
| Token 绑定率 | — | 自动绑定成功率 | >90% |
| 审查通过率 | — | 首次创建通过率 | >70% |
