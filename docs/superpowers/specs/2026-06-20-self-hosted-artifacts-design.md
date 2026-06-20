# CodePilot 自建 Artifacts — 设计 Spec (v1)

- 日期: 2026-06-20
- 状态: 待实现 (设计已与用户逐段确认)
- 作者: Forest Deng + Claude

## 背景

2026-06-18 Anthropic 给 Claude Code 上线了官方 **Artifacts**:把一次会话产出发布成托管在 Anthropic、可实时更新的私有网页,发链接给同事看。

调研结论(已核实):
- 官方 `Artifact` 是个**内置工具**,已随 CLI 2.1.x / Agent SDK 0.3.x ship(本地 0.3.177 的 `sdk-tools.d.ts` 里有 `ArtifactInput/ArtifactOutput`,`sdk.mjs` 有 `disableArtifact` 开关,默认开)。机制:模型先把一个独立 `.html`/`.md` 写到磁盘,再调工具发布。
- 但发布步骤是**服务端按 Team/Enterprise entitlement gate** 的。本项目是**单人 Max 订阅**,发布会被拒。
- 即使能用,页面托管在 Anthropic、走 org SSO,**不会渲染进 CodePilot**,且与"CodePilot 本身就是 web GUI"功能重叠。

决策:**自建**,不依赖官方工具、不受套餐限制、托管在自己机器上。

## 目的与价值(为什么做)

⚠️ 官方头号卖点是**团队协作 / 合规治理**(org SSO、compliance API、admin 保留策略)。CodePilot 是**单人自托管**,这套企业价值对本项目为 0,**不照搬**。

对本项目真正的价值,一句话:**把会话里有价值的产出,从"困在聊天滚动条里的一次性线性文字",变成一个持久、可导航、可交互的页面。**

四个具体目的,按优先级:

1. **【首要】中等海拔的 agent 工作脉络 (run digest)**
   趋势是 agent / subagent / 后台 Task 埋头自干、干完只甩最终结果。用户卡在两个极端中间:只看结果太少(改了啥/为什么/试过什么/遗留问题全黑盒)、翻原始 transcript 太多(几百条工具调用淹死人,尤其手机)。需要正中间那层——**脉络**:关键决策、改动要素、原因、尝试、遗留问题,大局一眼抓住、**想细看再展开**。
   这种"默认给脉络、按需展开细节" = **渐进披露 (progressive disclosure)**,**只有交互式 HTML 做得到**(可折叠分区、点开看细节)。这是"必须 interactive"的硬需求,不是镀金。
   与 CodePilot 走向契合:subagent / 后台 Task / workflow 天生丢失中间过程,artifact 把脉络捞回来。

2. **手机消费体验** — 用户主力是 Tailscale 手机访问。长会话在手机上只能线性滚,极难看。artifact = 自包含页面,可 pinch-zoom、分区/分 tab/可筛选,比翻聊天记录强一个量级。

3. **产出会"死"在会话里** — `/compact`、`/clear`、`/branch` 之后精华丢失或被压缩。artifact 是脱离会话存活的**持久、带版本**的记录。

4. **交互 > 静态总结** — 可筛选看板、带进度 checklist、可点开的 diff,信息密度高于死文字。

(对外第三方分享是目标,但属 **v2 公开链接**;对单人自托管排在上述之后。)

## 已确认的核心决策

| 维度 | 决策 |
|---|---|
| 创建方式 | **CodePilot 原生触发**(不拦截官方工具) |
| 分享范围 | **两阶段**:v1 = 在 CodePilot 面板内渲染;v2 = 独立公开 URL |
| 刷新模式 | **v1 快照 + 重新触发**;live 自刷新放 v2 |
| HTML 交接 | **自建 `publish_artifact` MCP 工具**(确定性、带元数据、天然版本) |
| 触发落点 | 新建 = `/artifact` slash 命令(进现有命令菜单,零新增常驻按钮);更新 = Artifact 面板头部按钮 |
| 首要类型 | agent/会话运行脉络(渐进披露) |

## 架构 (v1)

5 个组件:

### 1. `publish_artifact` MCP 工具(新增)
- 新文件,如 `scripts/artifacts-mcp-server.mjs`(参照现有 `scripts/channels-mcp-server.mjs`)。
- 工具签名:`publish_artifact({ file_path, title, favicon?, label?, artifact_id? })`。
- 行为:读取 `file_path` 的 HTML → 复制进版本化存储 → 写 DB 元数据 → 返回 `{ artifact_id, version, internal_url }`。
- 通过现有 `loadMergedMcpServers`(`claude-config-loader.ts`)注入到**主聊天 (SDK) 会话**的 MCP 配置。

### 2. 触发 UI(前端,`MessageInput.tsx`)
- 新建:`/artifact [可选描述]` 加入 `COMMAND_DEFINITIONS`,给图标(如 `Target02Icon`)。走已有的 **expansion-prompt 模式**(同 `/img` 等),展开成模板指令发给模型:
  > "把这次工作做成一个**自包含、可交互**的单文件 HTML 页面(内联所有 CSS/JS,数据嵌死,**禁止任何外部网络请求/CDN**)。默认呈现**中等粒度的脉络**——关键决策、改动要素、原因、尝试与遗留问题,大局默认展开、细节用可折叠区块收起(渐进披露)。完成后调用 `publish_artifact`。"
- 更新/重触发:按钮放在 **Artifact 面板头部**(DocPreview artifact 视图),指令带上已有 `artifact_id`,模型重建并发布 → 追加新版本。

### 3. Artifact 存储(文件 + SQLite,均现成)
文件(数据目录,持久、不进 repo、尊重 `CLAUDE_GUI_DATA_DIR`):
```
~/.codepilot/artifacts/<artifactId>/v1.html
                                    /v2.html
                                    /meta.json   # 冗余备份;DB 为权威
```
DB(better-sqlite3,新增两表):
- `artifacts`: `id`(slug,如 `incident-2026-06-20`) · `project_id` · `title` · `favicon` · `current_version` · `created_at` · `updated_at`
- `artifact_versions`: `artifact_id` · `version`(递增整数) · `path` · `label` · `byte_size` · `created_at`

版本逻辑:无 `artifact_id` → 新建 + v1;带已有 `artifact_id` → 追加 `v(N+1)`、更新 `current_version`。**只追加不覆盖**,旧版永留,下拉可切。v1 不做自动清理。

### 4. SSE 接线(`claude-client.ts`)
识别 `publish_artifact` 的 tool_use/tool_result,发 `artifact_published` SSE 事件(复用现有工具事件管线),前端据此打开/刷新面板。

### 5. Artifact 面板(前端)
复用 DocPreview 的 iframe 渲染,但走**独立的硬化渲染器**;带版本下拉 + 「更新此 Artifact」按钮 + 本项目 artifact 列表。

## 数据流(一次触发)

```
用户输入 /artifact [描述]
  → expansion prompt 进会话
  → 模型在工作目录写 report.html,调 publish_artifact(file_path, title, favicon)
  → MCP 工具:复制到 ~/.codepilot/artifacts/<id>/vN.html、写 DB、返回 {id, version, internal_url}
  → claude-client 抛 artifact_published SSE
  → 前端在 Artifact 面板用硬化沙箱 iframe 渲染该版本
```
重触发 = 带 `artifact_id` 再来一遍 → 追加新版本,下拉保留旧版。

## 安全(v1 不可延后)

模型生成的 HTML 是**不可信代码**,即使只在 app 内渲染也必须隔离:

1. **渲染只走** `<iframe srcDoc={html} sandbox="allow-scripts">` —— **绝不加 `allow-same-origin`**。不透明源,脚本能跑(支持 filter/sort/折叠交互)但碰不到 CodePilot 的源/cookie/localStorage。范例:`DocPreview.tsx:1253` 的 draw.io 查看器。
2. **注入 CSP**(srcDoc 内 `<meta http-equiv="Content-Security-Policy">`):`default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:` —— 掐死一切外部网络,防 exfiltration。先严后宽。
3. **不动现有通用 `.html` 预览**(`DocPreview.tsx:924` 的 `allow-same-origin` 路径是给可信用户文件的)。artifact 走独立硬化路径,两条分开。

权衡:CSP 掐外部网络 ⇒ artifact 不能引 CDN 资源 ⇒ 模板指令必须强制**完全自包含单文件 HTML**。这也是 artifact 可分享、不依赖环境的前提。

## v1 / v2 边界

**v1(本次):** `/artifact` 命令 + expansion prompt · `publish_artifact` MCP · 版本化存储 · `artifact_published` SSE · 硬化沙箱渲染 · 版本下拉 + 更新按钮 · 本项目列表 · 首要类型=运行脉络 · 快照 · **仅主聊天 (SDK) 会话**。

**v2(以后,明确不在 v1):** 独立公开链接 `/a/<slug>`(无需登录 CodePilot,对外分享) · live 自刷新(file-watch / SSE 推送到已开页面) · 跨项目 gallery · 保留/清理 · channels (T1) 支持。

**完全不做(单人自托管用不上):** org SSO、compliance API、admin 治理、保留策略。

## 测试策略

- **单元**(vitest):`publish_artifact`(文件复制 / 版本递增 / 新建 vs 追加 / DB 写入) · `artifact_published` 的 SSE 映射 · slug 生成。
- **组件**:断言 artifact 渲染器有 `allow-scripts` 且 **无 `allow-same-origin`**、CSP meta 存在;现有 `.html` 预览路径未被改动。
- **手动**(agent-browser,Pixel 真机):`/artifact` → 面板渲染 → pinch-zoom → 重触发 → 下拉出现 v1/v2 → 重开项目能在列表里找到。

## 待实现时确认的开放点

- `internal_url` 的具体形态(指向 app 内 artifact 路由 vs 仅前端内存引用)——v1 倾向前端直接拿 HTML 渲染,`internal_url` 可留作 v2 公开链接的占位。
- slug 生成规则(模型给 title → 规范化 + 去重)。
- artifact 列表入口放哪(DocPreview 侧栏 / 项目级入口)——实现时按现有布局定。
