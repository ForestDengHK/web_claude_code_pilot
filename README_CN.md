<img src="docs/icon-readme.png" width="32" height="32" alt="Web Claude Code Pilot" style="vertical-align: middle; margin-right: 8px;" /> Web Claude Code Pilot
===

**Claude Code 与 Codex CLI 的 Web GUI** -- 通过可视化界面进行对话、编码和项目管理，无需在终端中操作。支持在 Claude Code 和 Codex CLI 后端之间随时切换，并自动传递对话上下文。自托管在你自己的机器上，可从任何浏览器访问（包括通过 Tailscale 从手机访问）。

[English](./README.md)

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
- **会话分组** -- 侧边栏中会话按项目目录分组，支持折叠/展开全部。
- **会话内搜索** -- 在对话中搜索消息，高亮匹配并支持导航。
- **图片灯箱** -- 点击聊天中的图片打开全屏查看器，支持多图导航。
- **文档预览** -- 在右侧面板直接预览文件，无需离开聊天。
- **Git 克隆** -- 在文件选择器中直接克隆仓库。可在通用设置中配置克隆目标目录和默认 Git 主机（用于 `user/repo` 简写形式）。
- **任务追踪** -- 查看 Claude 在编码过程中创建的任务。
- **连接状态指示** -- UI 中实时显示服务器连接健康状态。
- **剪贴板兼容** -- 非 HTTPS 环境下的 Clipboard API 兼容方案（通过 Tailscale 从手机访问时）。
- **双后端：Claude Code + Codex CLI** -- 按会话切换 Claude Code（Agent SDK）和 Codex CLI 后端。模型和技能分别从两个后端获取。切换时自动桥接对话上下文（增量式，无额外 LLM 开销）。
- **IM 桥接（Telegram）** -- 通过 Telegram 与 Claude 对话。完整的双向桥接，支持会话管理、权限转发、Markdown 渲染、流式预览和图片附件。详见 [Bridge Architecture](docs/bridge-architecture.md)。
- **多服务商支持** -- 配置多个 API 服务商（Anthropic、OpenRouter 或自定义端点），各自独立的 API Key、Base URL 和模型列表。
- **语音输入（STT）** -- 聊天输入栏中的麦克风按钮，支持语音转文字。可在语音输入设置中配置转录服务商。
- **朗读功能（TTS）** -- 每条助手消息都有朗读按钮，使用 `edge-tts`（微软 Edge TTS，免费，无需 API Key）进行语音合成。支持朗读时同步高亮文字、分块并行合成（低延迟）、客户端缓存（重播即时）、播放/暂停/继续/停止，以及点击跳转（点击任意文字跳到该位置）。可在通用设置中分别配置英文、中文和中英混合内容的语音。
- **虚拟滚动** -- 消息列表使用 react-virtuoso，长对话中滚动流畅。
- **草稿检查点** -- 流式传输中的消息实时保存到数据库，浏览器标签页挂起或重连时可恢复。
- **回到顶部按钮** -- 在对话中快速跳转到顶部。
- **生产构建修复** -- 构建后脚本将 `.next/static` 符号链接到 standalone 输出（CSS/JS 加载所必需）。

---

## 功能特性

- **实时对话编码** -- 流式接收 Claude 的响应，支持完整的 Markdown 渲染、语法高亮代码块和工具调用可视化
- **双后端** -- 在 Claude Code（Agent SDK）和 Codex CLI 之间按会话切换。两个后端共享相同的流式传输、工具调用和权限审批 UI。切换时自动桥接上下文，无额外 LLM 开销
- **会话管理** -- 创建、重命名、归档和恢复聊天会话。会话按项目分组显示，支持折叠/展开。可导入 Claude Code CLI 的对话记录
- **项目感知上下文** -- 为每个会话选择工作目录。右侧面板实时展示文件树，支持展开/折叠全部、文件预览、下载和复制文件名。支持从文件选择器中 Git 克隆，可配置克隆目标目录和默认 Git 主机
- **会话内搜索** -- 在对话中搜索消息，高亮匹配并支持导航
- **图片灯箱** -- 点击聊天中的图片打开全屏查看器，支持多图导航
- **文档预览** -- 在右侧面板直接预览文件，无需离开聊天
- **可调节面板宽度** -- 拖拽聊天列表和右侧面板的边缘调整宽度，偏好设置跨会话保存
- **文件和图片附件** -- 在聊天输入框直接附加文件和图片。图片以多模态视觉内容发送给 Claude 进行分析
- **权限控制** -- 逐项审批、拒绝或自动允许工具使用。输入栏盾牌图标可按会话切换自动批准
- **多种交互模式** -- 在 *Code*、*Plan* 和 *Ask* 模式之间切换，控制 Claude 在每个会话中的行为方式
- **模型切换** -- 在对话中随时切换 Claude 和 Codex 模型。运行时从两个后端动态获取模型列表。Codex 模型支持可配置的推理深度
- **多服务商支持** -- 配置多个 API 服务商（Anthropic、OpenRouter 或自定义端点），各自独立的 API Key、Base URL 和模型列表
- **MCP 服务器管理** -- 在扩展页面添加、配置和移除 Model Context Protocol 服务器。支持 `stdio`、`sse` 和 `http` 传输类型。自动读取项目级 `.mcp.json` 配置
- **自定义技能** -- 定义可复用的提示词技能（全局或项目级别），在聊天中以 `/skill` 命令调用。同时支持 Claude Code CLI 和 Codex CLI 的插件技能
- **设置编辑器** -- 可视化和 JSON 编辑器管理 `~/.claude/settings.json`，包括权限和环境变量配置
- **Token 用量追踪** -- 每次助手回复后查看输入/输出 Token 数量和预估费用
- **深色/浅色主题** -- 导航栏一键切换主题
- **斜杠命令** -- 内置 `/help`、`/clear`、`/cost`、`/compact`、`/doctor`、`/review` 等命令
- **文件夹收藏** -- 收藏常用项目目录以快速访问
- **连接状态指示** -- 实时显示服务器连接是否正常
- **任务追踪** -- 查看和管理 Claude 在编码过程中创建的任务
- **IM 桥接** -- 连接外部 IM 平台（Telegram）到 Web Claude Code Pilot。无需打开浏览器即可通过手机与 Claude 对话。功能包括：会话绑定、项目切换、11 个斜杠命令、权限转发、Markdown 渲染、流式预览、图片附件、聊天清理和限速。在 Bridge 设置页面管理。详见 [Bridge Architecture](docs/bridge-architecture.md)
- **语音输入** -- 聊天输入栏麦克风按钮，支持语音转文字。可在语音输入设置中配置转录服务商（如 OpenAI Whisper）
- **朗读功能（TTS）** -- 每条助手消息都有朗读按钮，使用 `edge-tts`（微软 Edge TTS，免费，无需 API Key）朗读响应内容。朗读时同步高亮当前文字。支持播放/暂停/继续/停止、点击跳转（点击任意文字跳到该位置）、客户端缓存（重播即时）。可在通用设置中分别配置英文、中文和混合内容的语音
- **移动端适配** -- 响应式布局，底部导航栏，触控友好的控件，手机屏幕上的面板覆盖层。非 HTTPS 环境下的剪贴板兼容方案

---

## 环境要求

| 要求 | 最低版本 | 说明 |
|------|---------|------|
| **Node.js** | 20+ | 必需 |
| **npm** | 9+（Node 20 自带） | 必需 |
| **Claude Code CLI** | **v2.1.111+**（`claude --version`） | Claude 后端必需；运行 `claude login` 完成认证。**Opus 4.7 / `xhigh` 推理档位 / 自适应思考需要 v2.1.111 及以上** —— 用 `claude update` 升级。 |
| **Claude Agent SDK** | 0.2.112+（随 `package.json` 管理） | Opus-4.7 时代的能力（`effort: 'xhigh'`、`thinking: { type: 'adaptive' }`、`supportsAdaptiveThinking` 标志）需要此 SDK 版本。`npm install` 自动同步。 |
| **Codex CLI** | 最新版（`codex --version`） | 可选；仅 Codex 后端需要 |
| **edge-tts** | 最新版（`pip install edge-tts`） | 可选；仅朗读（TTS）功能需要 |

> **注意**：Web Claude Code Pilot 支持两个后端 —— Claude Code（Agent SDK）和 Codex CLI。至少需要安装一个。请确保 `claude` 和/或 `codex` 命令在 `PATH` 中可用并已完成认证。

---

## 快速开始

```bash
# 克隆仓库
git clone https://github.com/ForestDengHK/web_claude_code_pilot.git
cd web_claude_code_pilot

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
    <string>/path/to/web_claude_code_pilot/.next/standalone/codepilot-server.js</string>
  </array>
  <key>WorkingDirectory</key>
  <string>/path/to/web_claude_code_pilot</string>
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

> 将 `/path/to/web_claude_code_pilot` 和 `/Users/YOU` 替换为你的实际路径。如果不是使用 Homebrew 安装的 Node，请调整 `node` 路径（`which node`）。

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
cd /path/to/web_claude_code_pilot
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
| AI 集成 | [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) + [Codex CLI](https://github.com/openai/codex)（JSON-RPC） |
| 数据库 | [better-sqlite3](https://github.com/WiseLibs/better-sqlite3)（嵌入式，用户独立） |
| Markdown | react-markdown + remark-gfm + rehype-raw + [Shiki](https://shiki.style/) |
| IM Bridge Markdown | [markdown-it](https://github.com/markdown-it/markdown-it)（服务端 IR → Telegram HTML） |
| 流式传输 | Server-Sent Events (SSE) |
| 图标 | [Hugeicons](https://hugeicons.com/) + [Lucide](https://lucide.dev/) |
| 测试 | [Playwright](https://playwright.dev/) |
| CI/CD | [GitHub Actions](https://github.com/features/actions)（自动构建 + tag 发版） |

---

## 项目结构

```
web_claude_code_pilot/
├── .github/workflows/      # CI/CD：构建和自动发版
├── src/
│   ├── app/                 # Next.js App Router 页面和 API 路由
│   │   ├── chat/            # 新建对话页面和 [id] 会话页面
│   │   ├── bridge/          # IM Bridge 设置页面
│   │   ├── extensions/      # 技能 + MCP 服务器管理
│   │   ├── settings/        # 设置编辑器
│   │   └── api/             # REST + SSE 接口
│   │       ├── chat/        # 会话、消息、流式传输、权限
│   │       ├── claude-sessions/ # CLI 会话导入
│   │       ├── favorites/   # 文件夹收藏增删改查
│   │       ├── files/       # 文件树和预览
│   │       ├── models/      # 从 SDK 获取模型列表
│   │       ├── plugins/     # 插件和 MCP 增删改查
│   │       ├── providers/   # API 服务商管理 + 激活
│   │       ├── bridge/      # IM 桥接：状态、设置、频道
│   │       ├── codex/       # Codex 后端：聊天、模型、权限、技能
│   │       ├── git/         # Git 克隆
│   │       ├── health/      # 服务器健康检查
│   │       ├── settings/    # 设置读写
│   │       ├── skills/      # 技能增删改查
│   │       ├── tasks/       # 任务追踪
│   │       ├── transcribe/  # 语音输入转录
│   │       └── uploads/     # 文件上传处理
│   ├── components/
│   │   ├── ai-elements/     # 消息气泡、代码块、工具调用等
│   │   ├── bridge/          # Bridge 设置 UI（BridgeSection、TelegramBridgeSection）
│   │   ├── chat/            # ChatView、MessageList、MessageInput、流式消息
│   │   ├── layout/          # AppShell、NavRail、BottomNav、RightPanel
│   │   ├── plugins/         # MCP 服务器列表和编辑器
│   │   ├── project/         # FileTree、FilePreview、TaskList
│   │   ├── settings/        # 设置页面组件
│   │   ├── skills/          # SkillsManager、SkillEditor
│   │   └── ui/              # 基于 Radix 的基础组件（button、dialog、tabs...）
│   ├── hooks/               # 自定义 React Hooks（usePanel、useSSEStream 等）
│   ├── lib/                 # 核心逻辑
│   │   ├── bridge/                 # IM 桥接系统（详见 docs/bridge-architecture.md）
│   │   │   ├── types.ts            #   共享类型
│   │   │   ├── bridge-manager.ts   #   生命周期编排和命令处理
│   │   │   ├── channel-adapter.ts  #   抽象适配器基类 + 注册表
│   │   │   ├── channel-router.ts   #   地址→会话映射
│   │   │   ├── conversation-engine.ts # 服务端 SSE 流消费
│   │   │   ├── delivery-layer.ts   #   限速、重试、去重
│   │   │   ├── permission-broker.ts #  权限转发
│   │   │   ├── markdown/           #   Markdown IR → 平台特定渲染
│   │   │   └── adapters/           #   平台适配器（Telegram 等）
│   │   ├── abort-registry.ts       # 流式中断控制器注册表
│   │   ├── claude-client.ts        # Agent SDK 流式封装
│   │   ├── claude-session-parser.ts # CLI 会话导入解析器
│   │   ├── codex-client.ts         # Codex CLI 流式封装（JSON-RPC → SSE）
│   │   ├── codex-jsonrpc.ts        # Codex app-server JSON-RPC 传输层
│   │   ├── codex-process-manager.ts # Codex app-server 子进程生命周期
│   │   ├── codex-approval-registry.ts # Codex 权限待审批队列
│   │   ├── context-bridge.ts       # 跨后端对话上下文桥接
│   │   ├── db.ts                   # SQLite 数据库、迁移、CRUD
│   │   ├── files.ts                # 文件系统工具函数
│   │   ├── permission-registry.ts  # 权限请求/响应桥接
│   │   ├── platform.ts             # 平台检测工具
│   │   └── utils.ts                # 通用工具函数
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
- 聊天数据存储在 `~/.codepilot/codepilot.db`（可通过 `CLAUDE_GUI_DATA_DIR` 环境变量覆盖）
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
