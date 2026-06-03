# FigCraft MCP 工具速查表

> 面向外部用户的精简参考。完整文档见 [user-guide.md](user-guide.md)。

## 工具总览

FigCraft 在 `schema/tools.yaml` 中定义了 116 个工具，加上 3 个元工具（`load_toolset` / `unload_toolset` / `list_toolsets`）和 5 个资源端点（含 42 个方法），共计约 **161 个可调用入口**。

- 39 个核心工具 + 3 个元工具：始终可用
- 77 个扩展工具：分布在 13 个可选工具集中，按需加载
- 5 个资源端点：`nodes`、`text`、`components`、`variables_ep`、`styles_ep`

---

## 核心工具（始终可用）

### 连接 & 模式

| 工具 | 说明 |
|------|------|
| `ping` | 验证插件连接，返回延迟和版本 |
| `get_mode` | 获取当前模式、Token 状态、工作流指令（**每次创建前必调**） |
| `set_mode` | 切换 Library / Spec 模式 |
| `join_channel` | 切换到指定文档的 channel（多文档场景） |
| `get_channel` | 获取当前 channel ID |

### 读取

| 工具 | 说明 |
|------|------|
| `get_current_page` | 获取当前页面节点树（支持 maxDepth 控制深度） |
| `get_document_info` | 获取文档概览和所有页面列表 |
| `get_selection` | 获取当前选中节点的完整数据 |
| `list_fonts` | 列出可用字体，传入 family 获取所有样式 |

### 创建

| 工具 | 说明 |
|------|------|
| `create_frame` | 创建 Frame（支持 auto-layout、GRID 布局、children 嵌套、Opinion Engine 推断、dryRun 预览） |
| `create_text` | 创建文本节点（支持 Token 绑定、文字样式） |
| `create_svg` | 从 SVG 标记创建矢量节点 |
| `create_component` | 从 Frame 创建组件（支持 properties 声明、Opinion Engine） |
| `create_component_set` | 将多个组件合并为变体集（30 变体上限守卫） |
| `create_component_from_node` | 将现有节点转为组件 |
| `layout_component_set` | 对变体集执行自动排列布局 |
| `create_section` | 创建 Section 容器（默认 1920×1080，自动定位） |

### 质量

| 工具 | 说明 |
|------|------|
| `lint_fix_all` | 一键 lint + 自动修复所有可修复项 |
| `verify_design` | lint + 截图，一步完成验证（复合工具） |
| `audit_node` | 对单节点做深度审计（所有规则 + 设计规范） |
| `get_design_guidelines` | 获取设计规则（按 category 过滤） |
| `get_creation_guide` | 获取创建指南（layout / multi-screen / responsive / opinion-engine / ui-patterns 等 12 个 topic） |
| `get_design_context` | 获取节点树 + 变量/样式/组件元数据（面向 design-to-code） |

### 导出 & 版本

| 工具 | 说明 |
|------|------|
| `export_image` | 导出节点为 PNG/SVG/PDF/JPG |
| `save_version_history` | 保存版本快照 |
| `set_current_page` | 切换页面 |
| `set_selection` | 设置选中节点并滚动到视图 |

### 图标 & 图片

| 工具 | 说明 |
|------|------|
| `icon_search` | 搜索 200k+ 开源图标（Iconify） |
| `icon_create` | 从图标名创建矢量节点 |
| `icon_collections` | 列出可用图标集 |
| `image_search` | 搜索 Pexels 图库 |
| `image_preview` | 预览 Pexels 图片 |
| `create_image_frame_from_local` | 从本地 PNG/JPEG/GIF 创建图片 Frame |
| `fill_existing_image_from_local` | 用本地 PNG/JPEG/GIF 替换已有节点图片填充（需要 edit 权限） |

### 搜索 & 扫描

| 工具 | 说明 |
|------|------|
| `search_design_system` | 跨所有订阅库搜索组件、变量、样式 |
| `text_scan` | 扫描子树中所有文本节点 |

### 元工具

| 工具 | 说明 |
|------|------|
| `load_toolset` | 加载可选工具集（支持逗号分隔批量加载） |
| `unload_toolset` | 卸载工具集释放上下文 |
| `list_toolsets` | 查看所有工具集及加载状态 |

---

## 资源端点

每个端点通过 `method` 参数分发多个操作：

| 端点 | 方法 | 说明 |
|------|------|------|
| `nodes` | `get` `get_batch` `list` `update` `delete` `clone` `reparent` | 节点 CRUD + 搜索 |
| `text` | `set_content` `set_range` | 文本内容和范围样式 |
| `components` | `list` `list_library` `get` `list_properties` | 组件查询 |
| `variables_ep` | `list` `get` `list_collections` `get_bindings` `export` (always); `set_binding` `create` `update` `batch_update` `delete` `create_collection` `delete_collection` `batch_create` `set_code_syntax` `batch_bind` `set_values_multi_mode` `extend_collection` `get_overrides` `remove_override` (write — `load_toolset("variables")`) | 变量全生命周期（核心工具，始终可用）。19 个方法，`list` 返回所有字段含 codeSyntax/scopes，`batch_update` 支持批量修改含 codeSyntax |
| `styles_ep` | `list` `get` `create_paint` `update_paint` `update_text` `update_effect` `delete` `sync` | 样式管理（核心工具，始终可用） |

---

## 可选工具集

通过 `load_toolset("名称")` 按需加载，支持逗号分隔批量加载。

| 工具集 | 工具数 | 用途 |
|--------|--------|------|
| `components-advanced` | 16 | 组件变体、属性绑定、审计、代码连接元数据 |
| `tokens` | 11 | DTCG Token 同步、diff、缓存、导出 |
| `shapes-vectors` | 8 | 线段、星形、多边形、矩形、椭圆、布尔运算、Flatten |
| `library-import` | 7 | 浏览 / 导入共享库资源 |
| `variables` | 6 | Variable / Collection / Mode 写操作（rename、alias 等） |
| `prototype` | 6 | 原型交互、流程分析、批量连接屏幕 |
| `lint` | 6 | 细粒度 lint（check / fix / rules / ignore / stats / compliance） |
| `staging` | 4 | 暂存式工作流（stage / commit / discard / list） |
| `annotations` | 4 | 标注的增删查 |
| `auth` | 3 | Figma OAuth 登录 / 登出 / 状态 |
| `pages` | 3 | 页面创建 / 重命名 / 删除 |
| `styles` | 2 | Paint / Text / Effect Style 写操作 |
| `debug` | 1 | `execute_js`（Plugin API 沙箱执行，仅调试用） |

---

## 访问控制

通过 `FIGCRAFT_ACCESS` 环境变量配置：

| 级别 | 允许操作 |
|------|----------|
| `read` | 仅读取（inspect、export、search） |
| `create` | 读取 + 创建新内容 |
| `edit`（默认） | 完全访问 |

---

## 常用工作流速查

| 场景 | 工具链 |
|------|--------|
| UI 创建 | `ping` → `get_mode` → 提出方案 → `create_frame` + children → `verify_design` |
| 设计审查 | `ping` → `lint_fix_all(dryRun:true)` → 确认 → `lint_fix_all` |
| Token 同步 | `load_toolset("tokens")` → `diff_tokens` → `sync_tokens` |
| 节点检查 | `nodes(method:"get", nodeId:"1:23")` |
| 批量更新 | `nodes(method:"update", patches:[...])` |
| 组件审计 | `load_toolset("components-advanced")` → `audit_components` |
| 原型分析 | `load_toolset("prototype")` → `analyze_prototype_flow` |
| 多文档切换 | `join_channel("channel-id")` → `ping` |
