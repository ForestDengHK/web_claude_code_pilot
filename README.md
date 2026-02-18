<img src="docs/icon-readme.png" width="32" height="32" alt="Web Claude Code Pilot" style="vertical-align: middle; margin-right: 8px;" /> Web Claude Code Pilot
===

**A web GUI for Claude Code** -- chat, code, and manage projects through a polished visual interface instead of the terminal. Self-hosted on your own machine, accessible from any browser (including mobile via Tailscale).

[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey)](#)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

[中文文档](./README_CN.md) | [日本語](./README_JA.md)

> **Fork notice:** This project is forked from [op7418/CodePilot](https://github.com/op7418/CodePilot) (MIT License). The original project is a desktop Electron app. This fork removes Electron and rebuilds it as a standalone Next.js web server, with significant changes listed below.

---

## Changes from upstream

This fork diverges from the original CodePilot with the following major changes:

- **Removed Electron** -- Converted from a desktop app to a standalone Next.js web server (`codepilot-server.js`), deployable on any machine and accessible from any browser.
- **Mobile-first UI** -- Responsive layout with bottom navigation, touch-friendly controls, full-screen panel overlays, and optimized input targets for phone-sized screens.
- **Stream recovery** -- When the browser tab is suspended (common on mobile), the app automatically recovers the response from the database instead of showing a network error.
- **macOS launchd service** -- Documentation and build scripts for running as a persistent background service with auto-start on login.
- **Inline skill expansion** -- `/skill` commands insert inline (like Claude Code CLI) instead of using a badge UI. Skill content is cached and expanded at submit time.
- **Project-level MCP config** -- Reads `.mcp.json` from the working directory, not just global settings. MCP servers appear on the Extensions page per-project.
- **File tree enhancements** -- File preview (eye icon), download button, copy filename, +/- toggle for chat attachments, and auto-refresh after AI responses.
- **Dynamic model list** -- Models fetched from the SDK at runtime instead of hardcoded. Selection persists across messages.
- **Per-session permission toggle** -- Auto-approve tool use on a per-session basis with a shield icon in the input bar.
- **Folder favorites** -- Star frequently used project directories for quick access.
- **Production build fix** -- Post-build script symlinks `.next/static` into standalone output (required for CSS/JS to load).

---

## Features

- **Conversational coding** -- Stream responses from Claude in real time with full Markdown rendering, syntax-highlighted code blocks, and tool-call visualization.
- **Session management** -- Create, rename, and resume chat sessions. Import conversations from the Claude Code CLI. Conversations are persisted locally in SQLite.
- **Project-aware context** -- Pick a working directory per session. The right panel shows a live file tree with file previews, downloads, and copy-to-clipboard.
- **Resizable panels** -- Drag the edges of the chat list and right panel to adjust their width. Preferred sizes are saved across sessions.
- **File & image attachments** -- Attach files and images directly in the chat input. Images are sent as multimodal vision content for Claude to analyze.
- **Permission controls** -- Approve, deny, or auto-allow tool use on a per-action basis. Choose between permission modes to match your comfort level.
- **Multiple interaction modes** -- Switch between *Code*, *Plan*, and *Ask* modes to control how Claude behaves in each session.
- **Model selector** -- Switch between Claude models (Opus, Sonnet, Haiku) mid-conversation.
- **MCP server management** -- Add, configure, and remove Model Context Protocol servers from the Extensions page. Supports `stdio`, `sse`, and `http` transport types. Reads project-level `.mcp.json` files automatically.
- **Custom skills** -- Define reusable prompt-based skills (global or per-project) invoked as `/skill` commands in chat. Plugin skills from Claude Code CLI are also supported.
- **Settings editor** -- Visual and JSON editors for your `~/.claude/settings.json`, including permissions and environment variables.
- **Token usage tracking** -- See input/output token counts and estimated cost after every assistant response.
- **Dark / Light theme** -- One-click theme toggle in the navigation rail.
- **Slash commands** -- Built-in commands like `/help`, `/clear`, `/cost`, `/compact`, `/doctor`, `/review`, and more.
- **Mobile-friendly** -- Responsive layout with bottom navigation, touch-friendly controls, and panel overlays for phone-sized screens.

---

## Prerequisites

> **Important**: Web Claude Code Pilot calls the Claude Code Agent SDK under the hood. Make sure `claude` is available on your `PATH` and that you have authenticated (`claude login`) before starting the server.

| Requirement | Minimum version |
|---|---|
| **Node.js** | 20+ |
| **Claude Code CLI** | Installed and authenticated (`claude --version` should work) |
| **npm** | 9+ (ships with Node 20) |

---

## Quick Start

```bash
# Clone the repository
git clone https://github.com/op7418/CodePilot.git
cd CodePilot

# Install dependencies
npm install

# Start in development mode
npm run dev
```

Then open [http://localhost:3000](http://localhost:3000) in your browser.

### Production Deployment

```bash
# Build the standalone Next.js app
npm run build

# Start the production server
npm run start
# -- or directly --
PORT=4000 node .next/standalone/codepilot-server.js
```

The server binds to `0.0.0.0:3000` by default. Override with `PORT` and `HOSTNAME` environment variables.

**Remote access (e.g. from phone):** Use [Tailscale](https://tailscale.com/) or a similar tool to access the server from other devices on your network.

### Run as macOS Service (launchd)

To run Web Claude Code Pilot as a persistent background service that auto-starts on login:

**1. Create the plist file** at `~/Library/LaunchAgents/com.codepilot.web.plist`:

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

> Replace `/path/to/CodePilot` and `/Users/YOU` with your actual paths. Adjust the `node` path if not using Homebrew (`which node`).

**2. Service management commands:**

```bash
# Start the service
launchctl load ~/Library/LaunchAgents/com.codepilot.web.plist

# Stop the service
launchctl unload ~/Library/LaunchAgents/com.codepilot.web.plist

# Restart (stop + start)
launchctl unload ~/Library/LaunchAgents/com.codepilot.web.plist
launchctl load ~/Library/LaunchAgents/com.codepilot.web.plist

# Check if running
launchctl list | grep codepilot

# View logs
tail -f ~/.codepilot/service.log
tail -f ~/.codepilot/service.error.log
```

**3. After code changes** (update & restart):

```bash
cd /path/to/CodePilot
git pull                  # or make your changes
npm install               # if dependencies changed
npm run build             # rebuild production bundle
launchctl unload ~/Library/LaunchAgents/com.codepilot.web.plist
launchctl load ~/Library/LaunchAgents/com.codepilot.web.plist
```

**4. Remove the service:**

```bash
launchctl unload ~/Library/LaunchAgents/com.codepilot.web.plist
rm ~/Library/LaunchAgents/com.codepilot.web.plist
```

---

## Tech Stack

| Layer | Technology |
|---|---|
| Framework | [Next.js](https://nextjs.org/) (App Router, standalone output) |
| UI components | [Radix UI](https://www.radix-ui.com/) + [shadcn/ui](https://ui.shadcn.com/) |
| Styling | [Tailwind CSS 4](https://tailwindcss.com/) |
| Animation | [Motion](https://motion.dev/) (Framer Motion) |
| AI integration | [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) |
| Database | [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) (embedded, per-user) |
| Markdown | react-markdown + remark-gfm + rehype-raw + [Shiki](https://shiki.style/) |
| Streaming | Server-Sent Events (SSE) |
| Icons | [Hugeicons](https://hugeicons.com/) + [Lucide](https://lucide.dev/) |
| Testing | [Playwright](https://playwright.dev/) |
| CI/CD | [GitHub Actions](https://github.com/features/actions) (auto-build + release on tag) |

---

## Project Structure

```
codepilot/
├── .github/workflows/      # CI/CD: build & auto-release
├── src/
│   ├── app/                 # Next.js App Router pages & API routes
│   │   ├── chat/            # New-chat page & [id] session page
│   │   ├── extensions/      # Skills + MCP server management
│   │   ├── settings/        # Settings editor
│   │   └── api/             # REST + SSE endpoints
│   │       ├── chat/        # Sessions, messages, streaming, permissions
│   │       ├── files/       # File tree & preview
│   │       ├── plugins/     # Plugin & MCP CRUD
│   │       ├── settings/    # Settings read/write
│   │       ├── skills/      # Skill CRUD
│   │       └── tasks/       # Task tracking
│   ├── components/
│   │   ├── ai-elements/     # Message bubbles, code blocks, tool calls, etc.
│   │   ├── chat/            # ChatView, MessageList, MessageInput, streaming
│   │   ├── layout/          # AppShell, NavRail, BottomNav, RightPanel
│   │   ├── plugins/         # MCP server list & editor
│   │   ├── project/         # FileTree, FilePreview, TaskList
│   │   ├── skills/          # SkillsManager, SkillEditor
│   │   └── ui/              # Radix-based primitives (button, dialog, tabs, ...)
│   ├── hooks/               # Custom React hooks (usePanel, ...)
│   ├── lib/                 # Core logic
│   │   ├── claude-client.ts # Agent SDK streaming wrapper
│   │   ├── db.ts            # SQLite schema, migrations, CRUD
│   │   ├── files.ts         # File system helpers
│   │   ├── permission-registry.ts  # Permission request/response bridge
│   │   └── utils.ts         # Shared utilities
│   └── types/               # TypeScript interfaces & API contracts
├── codepilot-server.js      # Standalone server entry (loads shell env)
├── package.json
└── tsconfig.json
```

---

## Development

```bash
# Run Next.js dev server (opens in browser)
npm run dev

# Production build (Next.js standalone)
npm run build

# Start the production server
npm run start
```

### CI/CD

The project uses GitHub Actions for automated builds. Pushing a `v*` tag triggers a build and automatically creates a GitHub Release:

```bash
git tag v0.8.1
git push origin v0.8.1
# CI builds and publishes the release
```

### Notes

- The standalone server (`codepilot-server.js`) loads the user's shell environment to pick up `ANTHROPIC_API_KEY`, `PATH`, etc.
- Chat data is stored in `~/.codepilot/codepilot.db` (or `./data/codepilot.db` in dev mode).
- The app uses WAL mode for SQLite, so concurrent reads are fast.

### Troubleshooting

**Unstyled page / no CSS in production:**
Next.js standalone mode does not bundle `.next/static` (CSS/JS assets) into the standalone output directory. The post-build script (`scripts/prepare-server.mjs`) creates symlinks automatically: `.next/static` → `.next/standalone/.next/static` and `public` → `.next/standalone/public`. If you see an unstyled page, verify the symlinks exist:

```bash
ls -la .next/standalone/.next/static   # should be a symlink
ls -la .next/standalone/public         # should be a symlink
```

If missing, re-run the build: `npm run build`.

---

## Contributing

Contributions are welcome. To get started:

1. Fork the repository and create a feature branch.
2. Install dependencies with `npm install`.
3. Run `npm run dev` to test your changes locally.
4. Make sure `npm run lint` passes before opening a pull request.
5. Open a PR against `main` with a clear description of what changed and why.

Please keep PRs focused -- one feature or fix per pull request.

---

## License

MIT
