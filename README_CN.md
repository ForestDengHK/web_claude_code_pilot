<img src="docs/icon-readme.png" width="32" height="32" alt="Web Claude Code Pilot" style="vertical-align: middle; margin-right: 8px;" /> Web Claude Code Pilot
===

**Claude Code 的 Web GUI** -- 通过可视化界面进行对话、编码和项目管理，无需在终端中操作。自托管在你自己的机器上，可从任何浏览器访问（包括通过 Tailscale 从手机访问）。

[English](./README.md) | [日本語](./README_JA.md)

[![GitHub release](https://img.shields.io/github/v/release/op7418/CodePilot)](https://github.com/op7418/CodePilot/releases)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey)](https://github.com/op7418/CodePilot/releases)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

---

## 功能特性

- **实时对话编码** -- 流式接收 Claude 的响应，支持完整的 Markdown 渲染、语法高亮代码块和工具调用可视化
- **会话管理** -- 创建、重命名和恢复聊天会话。可导入 Claude Code CLI 的对话记录。所有数据本地持久化存储在 SQLite 中
- **项目感知上下文** -- 为每个会话选择工作目录。右侧面板实时展示文件树，支持文件预览、下载和复制文件名
- **可调节面板宽度** -- 拖拽聊天列表和右侧面板的边缘调整宽度，偏好设置跨会话保存
- **文件和图片附件** -- 在聊天输入框直接附加文件和图片。图片以多模态视觉内容发送给 Claude 进行分析
- **权限控制** -- 逐项审批、拒绝或自动允许工具使用，可选择不同的权限模式
- **多种交互模式** -- 在 *Code*、*Plan* 和 *Ask* 模式之间切换，控制 Claude 在每个会话中的行为方式
- **模型切换** -- 在对话中随时切换 Claude 模型（Opus、Sonnet、Haiku）
- **MCP 服务器管理** -- 在扩展页面添加、配置和移除 Model Context Protocol 服务器。支持 `stdio`、`sse` 和 `http` 传输类型。自动读取项目级 `.mcp.json` 配置
- **自定义技能** -- 定义可复用的提示词技能（全局或项目级别），在聊天中以 `/skill` 命令调用。同时支持 Claude Code CLI 的插件技能
- **设置编辑器** -- 可视化和 JSON 编辑器管理 `~/.claude/settings.json`，包括权限和环境变量配置
- **Token 用量追踪** -- 每次助手回复后查看输入/输出 Token 数量和预估费用
- **深色/浅色主题** -- 导航栏一键切换主题
- **斜杠命令** -- 内置 `/help`、`/clear`、`/cost`、`/compact`、`/doctor`、`/review` 等命令
- **移动端适配** -- 响应式布局，底部导航栏，触控友好的控件，手机屏幕上的面板覆盖层

---

## 截图

![Web Claude Code Pilot](docs/screenshot.png)

---

## 环境要求

| 要求 | 最低版本 |
|------|---------|
| **Node.js** | 20+ |
| **Claude Code CLI** | 已安装并完成认证（`claude --version` 可正常运行） |
| **npm** | 9+（Node 20 自带） |

> **注意**：Web Claude Code Pilot 底层调用 Claude Code Agent SDK。请确保 `claude` 命令在 `PATH` 中可用，并且已完成认证（`claude login`）。

---

## 快速开始

```bash
# 克隆仓库
git clone https://github.com/op7418/CodePilot.git
cd CodePilot

# 安装依赖
npm install

# 以开发模式启动
npm run dev
```

然后在浏览器中打开 [http://localhost:3000](http://localhost:3000)。

### 生产部署

```bash
# 构建 Next.js standalone 应用
npm run build

# 启动生产服务器
npm run start
# -- 或者直接 --
node .next/standalone/codepilot-server.js
```

服务器默认绑定 `0.0.0.0:3000`。可通过 `PORT` 和 `HOSTNAME` 环境变量覆盖。

**远程访问（如从手机）：** 使用 [Tailscale](https://tailscale.com/) 或类似工具从其他设备访问服务器。

---

## 技术栈

| 层级 | 技术 |
|------|------|
| 框架 | [Next.js](https://nextjs.org/)（App Router，standalone 输出） |
| UI 组件 | [Radix UI](https://www.radix-ui.com/) + [shadcn/ui](https://ui.shadcn.com/) |
| 样式 | [Tailwind CSS 4](https://tailwindcss.com/) |
| 动画 | [Motion](https://motion.dev/)（Framer Motion） |
| AI 集成 | [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) |
| 数据库 | [better-sqlite3](https://github.com/WiseLibs/better-sqlite3)（嵌入式，用户独立） |
| Markdown | react-markdown + remark-gfm + rehype-raw + [Shiki](https://shiki.style/) |
| 流式传输 | Server-Sent Events (SSE) |
| 图标 | [Hugeicons](https://hugeicons.com/) + [Lucide](https://lucide.dev/) |
| 测试 | [Playwright](https://playwright.dev/) |
| CI/CD | [GitHub Actions](https://github.com/features/actions)（自动构建 + tag 发版） |

---

## 项目结构

```
codepilot/
├── .github/workflows/      # CI/CD：构建和自动发版
├── src/
│   ├── app/                 # Next.js App Router 页面和 API 路由
│   │   ├── chat/            # 新建对话页面和 [id] 会话页面
│   │   ├── extensions/      # 技能 + MCP 服务器管理
│   │   ├── settings/        # 设置编辑器
│   │   └── api/             # REST + SSE 接口
│   │       ├── chat/        # 会话、消息、流式传输、权限
│   │       ├── files/       # 文件树和预览
│   │       ├── plugins/     # 插件和 MCP 增删改查
│   │       ├── settings/    # 设置读写
│   │       ├── skills/      # 技能增删改查
│   │       └── tasks/       # 任务追踪
│   ├── components/
│   │   ├── ai-elements/     # 消息气泡、代码块、工具调用等
│   │   ├── chat/            # ChatView、MessageList、MessageInput、流式消息
│   │   ├── layout/          # AppShell、NavRail、BottomNav、RightPanel
│   │   ├── plugins/         # MCP 服务器列表和编辑器
│   │   ├── project/         # FileTree、FilePreview、TaskList
│   │   ├── skills/          # SkillsManager、SkillEditor
│   │   └── ui/              # 基于 Radix 的基础组件（button、dialog、tabs...）
│   ├── hooks/               # 自定义 React Hooks（usePanel 等）
│   ├── lib/                 # 核心逻辑
│   │   ├── claude-client.ts # Agent SDK 流式封装
│   │   ├── db.ts            # SQLite 数据库、迁移、CRUD
│   │   ├── files.ts         # 文件系统工具函数
│   │   ├── permission-registry.ts  # 权限请求/响应桥接
│   │   └── utils.ts         # 通用工具函数
│   └── types/               # TypeScript 接口和 API 类型定义
├── codepilot-server.js      # standalone 服务器入口（加载 shell 环境）
├── package.json
└── tsconfig.json
```

---

## 开发

```bash
# 运行 Next.js 开发服务器（在浏览器中打开）
npm run dev

# 生产构建（Next.js standalone）
npm run build

# 启动生产服务器
npm run start
```

### CI/CD

项目使用 GitHub Actions 自动构建。推送 `v*` tag 会自动触发构建并创建 GitHub Release：

```bash
git tag v0.8.1
git push origin v0.8.1
# CI 自动构建并发布 Release
```

### 说明

- standalone 服务器（`codepilot-server.js`）会加载用户的 shell 环境以获取 `ANTHROPIC_API_KEY`、`PATH` 等
- 聊天数据存储在 `~/.codepilot/codepilot.db`（开发模式下为 `./data/`）
- 应用使用 SQLite WAL 模式，并发读取性能优秀

---

## 贡献

欢迎贡献代码。开始之前：

1. Fork 本仓库并创建功能分支
2. 使用 `npm install` 安装依赖
3. 运行 `npm run dev` 在本地测试你的更改
4. 确保 `npm run lint` 通过后再提交 Pull Request
5. 向 `main` 分支提交 PR，并附上清晰的变更说明

请保持 PR 聚焦 -- 每个 PR 只包含一个功能或修复。

---

## 许可证

MIT
