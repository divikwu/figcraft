# FigCraft

[English](README.md) | 中文

AI 驱动的 Figma 设计质量插件。让 AI IDE 与 Figma 双向联动——用自然语言完成 UI 创建、设计审查、Token 同步、规范检查、审计与自动修复。单独使用就很好用，搭配 [Figma 官方 MCP server](https://developers.figma.com/docs/figma-mcp-server/) 一起用更强大。

> **新用户？** 先读 [docs/introduction.md](docs/introduction.md) — 5 分钟快速了解产品定位、三大核心能力、FAQ。本 README 偏向安装与参考。

## 它能做什么？

用自然语言告诉 AI 你想做什么，FigCraft + Figma 官方 MCP 帮你在 Figma 里完成：

> "创建一个登录页面，然后检查整个页面的合规性并自动修复"

> "把 DTCG JSON 里的 Token 同步到 Figma 变量，对比差异后更新"

> "检查当前页面的 WCAG 对比度和点击区域大小，自动修复能修的问题"

## 功能特性

- 🎨 **从创建到交付，全程覆盖** — 直接在 Figma 中创建 UI，116 个 MCP 工具覆盖 Frame、组件、变体、图标。画完即检查，质量问题当场修
- 🧠 **Opinion Engine 智能推断** — 自动推断布局方向、尺寸策略、Token 绑定，在参数冲突到达 Figma 前就拦截。你描述*要什么*，它搞定*怎么做*
- 🔍 **设计规范自动审查** — Token 绑定、颜色对比度、间距规范、组件健康度，一次扫描全覆盖 · [完整指南 →](docs/design-review.md)
- 🔧 **检查+修复一步到位** — 40 条规则覆盖 Token 合规、WCAG、布局结构，一条命令批量自动修复
- 🔄 **Token 双向同步** — DTCG JSON ↔ Figma 变量，Light/Dark 多模式一步到位。改了代码里的 Token？同步过去就行
- 🔀 **双模式适配团队** — 用 Figma 共享库的团队选 Library 模式，用 DTCG JSON 管理规范的团队选 Spec 模式
- 📐 **原型交互→开发文档** — 自动解析页面里的原型跳转，输出 Mermaid 流程图 + 交互说明，设计师不用再手写交互文档
- 🛡️ **Harness Pipeline 行为约束** — 每次创建自动验证质量，出错时给出可执行的修复建议，跨 turn 追踪质量债务

## 快速开始

> 需要 Node.js >= 20。

### 1. 安装 Figma 插件

FigCraft 尚未发布到 Figma 社区，需从源码构建安装：

```bash
git clone https://github.com/DivikWu/figcraft.git
cd figcraft
npm install
npm run build
```

然后在 Figma 桌面版中：
1. **Plugins → Development → Import plugin from manifest**
2. 选择克隆仓库中的 `manifest.json` 文件

### 2. 在 IDE 中添加 MCP Server

FigCraft 本身就能创建 UI 和管理设计质量。如果想获得更多创建能力，可以同时添加 [Figma 官方 MCP server](https://developers.figma.com/docs/figma-mcp-server/)，两个 server 并行运行、互相补充。

> **注意**：`figcraft-design` 尚未发布到 npm，目前需要从源码构建后使用。下面的配置中 `cwd` 需要替换为你本地 clone 的实际绝对路径。

FigCraft 配置（所有 IDE 通用）：

```json
{
  "mcpServers": {
    "figcraft": {
      "command": "node",
      "args": ["dist/mcp-server/index.js"],
      "cwd": "/your/absolute/path/to/figcraft"
    }
  }
}
```

> FigCraft 单独使用就能创建 UI 和管理设计质量。添加 Figma 官方 MCP server 可以获得更丰富的创建能力。

<details>
<summary><strong>添加 Figma 官方 MCP server（获得更多创建能力）</strong></summary>

Figma 提供两种部署方式：

**Desktop server**（本地，运行在 Figma Desktop App 内）：
1. 打开 Figma Desktop → Dev Mode → 在 inspect 面板中启用 MCP server
2. 在 IDE 配置中添加：
```json
{
  "mcpServers": {
    "figma-desktop": {
      "url": "http://127.0.0.1:3845/mcp"
    }
  }
}
```

**Remote server**（云端，功能更全——Figma 推荐）：
参见 [Figma Remote server 设置指南](https://developers.figma.com/docs/figma-mcp-server/remote-server-installation/)。

完整文档见 [Figma 官方 MCP 文档](https://developers.figma.com/docs/figma-mcp-server/)。
</details>

各 IDE 的配置文件路径不同，展开查看：

> 📦 **如果你 fork 了本仓库直接使用**，三份项目级配置已经预先 commit：`.cursor/mcp.json`、`.mcp.json`、`.kiro/settings/mcp.json`，外加 `.claude/settings.json`（Claude Code 的自动批准入口）。**每个 IDE 的自动批准机制不同，不能跨 IDE 复用同一字段** —— 详见下方分 IDE 说明，或参考 [user-guide §6.5](docs/user-guide.md#65-自动批准auto-approve配置) 的完整对照表。

<details>
<summary><strong>Cursor</strong> — <code>.cursor/mcp.json</code></summary>

在项目根目录创建 `.cursor/mcp.json`，写入上面的通用配置即可。

**自动批准**：Cursor **不会**从 `.cursor/mcp.json` 自动批准工具，需要在用户目录创建 `~/.cursor/permissions.json`：

```json
{ "mcpAllowlist": ["figcraft:*", "figma-desktop:*"] }
```

（详见 [Cursor 官方权限文档](https://cursor.com/docs/reference/permissions)。需在 Cursor 设置中开启 Auto-Run 模式才生效。）
</details>

<details>
<summary><strong>Claude Code</strong> — <code>.mcp.json</code></summary>

在项目根目录创建 `.mcp.json`，写入上面的通用配置。

**自动批准**：Claude Code **会忽略** `.mcp.json` 里的 `autoApprove` 字段（该字段是 Cursor/Kiro 的扩展，不是 MCP 标准）。需要用 `.claude/settings.json`：

```json
{
  "permissions": {
    "allow": ["mcp__figcraft__create_frame", "mcp__figcraft__nodes", "..."]
  }
}
```

本仓库预 commit 的 `.claude/settings.json` 已列出全部 119 个 figcraft 工具 + 13 个 figma-desktop 工具。修改 `schema/tools.yaml` 后运行 `npm run schema` 会自动同步。
</details>

<details>
<summary><strong>Kiro</strong> — <code>.kiro/settings/mcp.json</code></summary>

在项目根目录创建 `.kiro/settings/mcp.json`。Kiro 原生支持 `autoApprove`：

```json
{
  "mcpServers": {
    "figcraft": {
      "command": "npx",
      "args": ["tsx", "packages/figcraft-design/src/index.ts"],
      "cwd": "${workspaceFolder}",
      "disabled": false,
      "autoApprove": ["ping", "create_frame", "nodes", "..."]
    }
  }
}
```

本仓库预 commit 的 `.kiro/settings/mcp.json` 已自动批准全部 119 个 figcraft 工具。Kiro 中工具名以 `mcp_figcraft_` 为前缀（如 `mcp_figcraft_ping`、`mcp_figcraft_lint_fix_all`）。

> **提示**：本仓库包含 `.kiro/steering/figcraft.md` 工作流指南，可复制到你的项目 `.kiro/steering/` 目录中使用。
</details>

<details>
<summary><strong>Antigravity (Google)</strong> — MCP Server 管理面板</summary>

打开 Antigravity → Agent 下拉菜单 → **Manage MCP Servers** → **View raw config**，写入上面的通用配置。
</details>

<details>
<summary><strong>Codex CLI (OpenAI)</strong> — <code>~/.codex/config.toml</code></summary>

```toml
[mcp_servers.figcraft]
command = "node"
args = ["dist/mcp-server/index.js"]
cwd = "/your/absolute/path/to/figcraft"
```
</details>

### 3. 连接并验证

在 Figma 中打开 FigCraft 插件，两端通过 WebSocket 中继自动连接。插件 UI 会显示频道 ID 和连接状态。

连接后，在 AI IDE 中运行 `ping` 工具验证连通性。如果返回响应，说明一切就绪。

> **排查连接问题**：如果连接失败，检查端口 3055 是否被其他进程占用。Relay 会自动尝试 3056–3060 作为备用端口。

## 架构

```
AI IDE (Kiro / Cursor / Claude Code / Antigravity / Codex)
    │ MCP (stdio)
    ▼
MCP Server (Node.js)
    │ WebSocket
    ▼
WS Relay (端口 3055)
    │ WebSocket
    ▼
Figma Plugin (code.js 沙箱 + UI iframe)
```

## 双模式

| 模式 | Token 来源 | 检查方式 | 使用场景 |
|------|-----------|---------|---------|
| **Library** | Figma 共享库 | 检查变量/样式绑定 | 日常设计，使用团队库 |
| **Spec** | DTCG JSON 文件 | 检查值是否匹配 Token 规范 | 规范驱动验证 |

通过 `set_mode` 工具或插件 UI 切换模式。

## UI 创建

FigCraft 直接在 Figma 中创建 UI — Frame、文本、SVG、组件、变体、图标和图片。Opinion Engine 自动推断布局、尺寸和 Token 绑定，你只需描述结构，无需操心实现细节。支持 GRID 布局、嵌套子节点树和批量操作。

- `create_frame` 搭配 `children` 一次调用构建完整页面层级
- `create_component` / `create_component_set` 构建可复用组件库，内置变体数量守卫
- 创建后 Harness Pipeline 自动验证质量；也可手动运行 `lint_fix_all`
- `get_design_context` 提取节点树 + 已解析的 Token 元数据，用于 design-to-code 工作流

## 检查规则（40 条）

当前规则集覆盖 Token 合规、WCAG 无障碍、布局结构、命名与内容、组件健康度。

- Token 合规（5）：颜色、字体、圆角、硬编码 token、缺失文字样式
- WCAG 无障碍（5）：对比度、点击区域、字号、行高、非文本对比度
- 布局结构（27）：screen shell 校验、交互元素根节点误分类、嵌套交互 shell、缺失 auto-layout、空容器、Spacer frame、嵌套深度、按钮结构（solid/outline/ghost/text/icon）、独立链接结构、文本溢出、表单一致性、CTA 宽度不一致、子元素溢出父容器、HUG/STRETCH 矛盾、section spacing 塌缩、屏幕底部溢出、social/nav/stats 行拥挤、输入框结构、移动端尺寸、elevation 一致性/层级
- 命名与内容（2）：默认命名检查、占位文本检查
- 组件（1）：组件属性绑定检查

完整规则清单见 [docs/generated/lint-rules.md](docs/generated/lint-rules.md)。

## 环境变量

| 变量 | 说明 | 默认值 |
|------|------|-------|
| `FIGCRAFT_RELAY_PORT` | Relay WebSocket 端口 | `3055` |
| `FIGCRAFT_RELAY_URL` | 完整 WebSocket Relay URL（覆盖端口设置） | `ws://localhost:3055` |
| `FIGCRAFT_CHANNEL` | 频道 ID | `figcraft` |
| `FIGMA_API_TOKEN` | Figma 个人访问令牌（可选，用于 REST API 访问库组件/样式；也可通过插件 UI 配置或使用 OAuth） | — |
| `FIGCRAFT_ACCESS` | 访问控制级别：`read`、`create` 或 `edit` | `edit` |

## 开发

需要 Node.js >= 20。

```bash
npm install
npm run build          # 构建全部（MCP Server + Relay + Plugin）
npm run build:plugin   # 仅构建 Figma 插件
npm run dev:relay      # 启动 WebSocket Relay（调试用）
npm run dev:mcp        # 启动 MCP Server（stdio 传输）
npm run schema         # 从 schema/tools.yaml 重新生成工具注册表
npm run content        # 从 content/ 编译模板、指南和 Prompts
npm run typecheck      # TypeScript 类型检查
npm run test           # 运行单元测试 (vitest)
```

内容资产（模板、指南、Prompts）的详细说明见 [docs/asset-maintenance.md](docs/asset-maintenance.md)。

<details>
<summary><strong>从源码运行 MCP Server（开发用）</strong></summary>

开发时可以不用 `npx figcraft-design`，直接指向本地源码：

```json
{
  "mcpServers": {
    "figcraft": {
      "command": "npx",
      "args": ["tsx", "packages/figcraft-design/src/index.ts"],
      "cwd": "/path/to/figcraft"
    }
  }
}
```
</details>

## Contributing

欢迎贡献！请 fork 本仓库并提交 Pull Request。

提交前请确保：

```bash
npm run typecheck      # 类型检查通过
npm run test           # 测试通过
```

## 许可证

MIT
