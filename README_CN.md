<img src="docs/icon-readme.png" width="32" height="32" alt="Web Claude Code Pilot" style="vertical-align: middle; margin-right: 8px;" /> Web Claude Code Pilot
===

**Claude Code 的 Web GUI** -- 通过可视化界面进行对话、编码和项目管理，无需在终端中操作。自托管在你自己的机器上，可从任何浏览器访问（包括通过 Tailscale 从手机访问）。

[English](./README.md) | [日本語](./README_JA.md)

[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey)](#)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

> **Fork 声明：** 本项目 fork 自 [op7418/CodePilot](https://github.com/op7418/CodePilot)（MIT 许可证）。原项目是 Electron 桌面应用。本 fork 移除了 Electron，重构为独立的 Next.js Web 服务器，并进行了以下重大改动。

---

## 与上游的主要差异

本 fork 与原版 CodePilot 的主要变更：

- **移除 Electron** -- 从桌面应用转换为独立 Next.js Web 服务器（`codepilot-server.js`），可部署在任何机器上，通过浏览器访问。
- **移动端优先 UI** -- 响应式布局，底部导航栏，触控友好的控件，全屏面板覆盖层，针对手机屏幕优化的输入区域。
- **流式恢复** -- 当浏览器标签页被挂起（手机上常见），应用会自动从数据库恢复响应，而不是显示网络错误。
- **macOS launchd 服务** -- 提供作为持久后台服务运行的文档和构建脚本，支持登录时自动启动。
- **内联技能展开** -- `/skill` 命令以内联方式插入（与 Claude Code CLI 一致），而非使用徽章 UI。技能内容被缓存并在提交时展开。
- **项目级 MCP 配置** -- 从工作目录读取 `.mcp.json`，而不仅是全局设置。MCP 服务器按项目显示在扩展页面。
- **文件树增强** -- 文件预览（眼睛图标）、下载按钮、复制文件名、聊天附件的 +/- 切换、AI 响应后自动刷新。
- **动态模型列表** -- 运行时从 SDK 获取模型，而非硬编码。选择在消息间持久化。
- **会话级权限切换** -- 在输入栏通过盾牌图标按会话自动批准工具使用。
- **文件夹收藏** -- 收藏常用项目目录以快速访问。
- **生产构建修复** -- 构建后脚本将 `.next/static` 符号链接到 standalone 输出（CSS/JS 加载所必需）。

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
PORT=4000 node .next/standalone/codepilot-server.js
```

服务器默认绑定 `0.0.0.0:3000`。可通过 `PORT` 和 `HOSTNAME` 环境变量覆盖。

**远程访问（如从手机）：** 使用 [Tailscale](https://tailscale.com/) 或类似工具从其他设备访问服务器。

### 以 macOS 服务运行（launchd）

将 Web Claude Code Pilot 设置为持久后台服务，登录后自动启动：

**1. 创建 plist 文件**，路径为 `~/Library/LaunchAgents/com.codepilot.web.plist`：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.codepilot.web</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/node</string>
    <string>/path/to/CodePilot/.next/standalone/codepilot-server.js</string>
  </array>
  <key>WorkingDirectory</key>
  <string>/path/to/CodePilot</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PORT</key>
    <string>4000</string>
    <key>HOSTNAME</key>
    <string>0.0.0.0</string>
    <key>NODE_ENV</key>
    <string>production</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/Users/YOU/.codepilot/service.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/YOU/.codepilot/service.error.log</string>
</dict>
</plist>
```

> 将 `/path/to/CodePilot` 和 `/Users/YOU` 替换为你的实际路径。如果不是使用 Homebrew 安装的 Node，请调整 `node` 路径（`which node`）。

**2. 服务管理命令：**

```bash
# 启动服务
launchctl load ~/Library/LaunchAgents/com.codepilot.web.plist

# 停止服务
launchctl unload ~/Library/LaunchAgents/com.codepilot.web.plist

# 重启（先停止再启动）
launchctl unload ~/Library/LaunchAgents/com.codepilot.web.plist
launchctl load ~/Library/LaunchAgents/com.codepilot.web.plist

# 检查是否运行中
launchctl list | grep codepilot

# 查看日志
tail -f ~/.codepilot/service.log
tail -f ~/.codepilot/service.error.log
```

**3. 代码变更后**（更新并重启）：

```bash
cd /path/to/CodePilot
git pull                  # 或进行你的修改
npm install               # 如果依赖有变化
npm run build             # 重新构建生产包
launchctl unload ~/Library/LaunchAgents/com.codepilot.web.plist
launchctl load ~/Library/LaunchAgents/com.codepilot.web.plist
```

**4. 移除服务：**

```bash
launchctl unload ~/Library/LaunchAgents/com.codepilot.web.plist
rm ~/Library/LaunchAgents/com.codepilot.web.plist
```

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

### 故障排除

**生产环境页面无样式 / CSS 丢失：**
Next.js standalone 模式不会将 `.next/static`（CSS/JS 资源）打包到 standalone 输出目录中。构建后脚本（`scripts/prepare-server.mjs`）会自动创建符号链接：`.next/static` → `.next/standalone/.next/static` 和 `public` → `.next/standalone/public`。如果页面无样式，请检查符号链接是否存在：

```bash
ls -la .next/standalone/.next/static   # 应该是符号链接
ls -la .next/standalone/public         # 应该是符号链接
```

如果缺失，重新构建即可：`npm run build`。

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
