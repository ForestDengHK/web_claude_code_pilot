<img src="docs/icon-readme.png" width="32" height="32" alt="Web Claude Code Pilot" style="vertical-align: middle; margin-right: 8px;" /> Web Claude Code Pilot
===

**Claude Code の Web GUI** -- ターミナルではなく、洗練されたビジュアルインターフェースを通じてチャット、コーディング、プロジェクト管理を行えます。自分のマシンでセルフホスティングし、任意のブラウザからアクセス可能（Tailscale 経由でモバイルからも利用可能）。

[![GitHub release](https://img.shields.io/github/v/release/op7418/CodePilot)](https://github.com/op7418/CodePilot/releases)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey)](https://github.com/op7418/CodePilot/releases)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

[English](./README.md) | [中文文档](./README_CN.md)

---

## 機能

- **会話型コーディング** -- Claude からのレスポンスをリアルタイムでストリーミング受信。完全な Markdown レンダリング、シンタックスハイライトされたコードブロック、ツール呼び出しの可視化に対応。
- **セッション管理** -- チャットセッションの作成、名前変更、再開が可能。Claude Code CLI からの会話のインポートにも対応。すべてのデータは SQLite にローカル保存。
- **プロジェクト対応コンテキスト** -- セッションごとに作業ディレクトリを指定可能。右パネルにはライブファイルツリーが表示され、ファイルプレビュー、ダウンロード、ファイル名コピーに対応。
- **リサイズ可能なパネル** -- チャットリストと右パネルのエッジをドラッグして幅を調整。設定はセッション間で保存。
- **ファイル & 画像添付** -- チャット入力で直接ファイルや画像を添付。画像はマルチモーダルビジョンコンテンツとして Claude に送信。
- **権限制御** -- ツール使用をアクション単位で承認、拒否、または自動許可。権限モードを選択可能。
- **複数の対話モード** -- *Code*、*Plan*、*Ask* モード間で切り替えて、各セッションで Claude の動作を制御。
- **モデルセレクター** -- 会話中に Claude モデル（Opus、Sonnet、Haiku）を切り替え可能。
- **MCP サーバー管理** -- エクステンションページから Model Context Protocol サーバーを追加、設定、削除。`stdio`、`sse`、`http` トランスポートに対応。プロジェクトレベルの `.mcp.json` ファイルを自動読み込み。
- **カスタムスキル** -- `/skill` コマンドとして呼び出せる再利用可能なプロンプトベースのスキル（グローバルまたはプロジェクト単位）を定義可能。Claude Code CLI のプラグインスキルにも対応。
- **設定エディター** -- `~/.claude/settings.json` のビジュアルエディターと JSON エディター。権限と環境変数の設定に対応。
- **トークン使用量追跡** -- アシスタントのレスポンスごとに入力/出力トークン数と推定コストを表示。
- **ダーク / ライトテーマ** -- ナビゲーションレールのワンクリックでテーマを切り替え。
- **スラッシュコマンド** -- `/help`、`/clear`、`/cost`、`/compact`、`/doctor`、`/review` などの組み込みコマンド。
- **モバイル対応** -- レスポンシブレイアウト、ボトムナビゲーション、タッチフレンドリーなコントロール、スマートフォン画面向けのパネルオーバーレイ。

---

## スクリーンショット

![Web Claude Code Pilot](docs/screenshot.png)

---

## 前提条件

> **重要**: Web Claude Code Pilot は Claude Code Agent SDK を内部で呼び出します。サーバーを起動する前に、`claude` が `PATH` で利用可能であること、認証済み (`claude login`) であることを確認してください。

| 要件 | 最小バージョン |
|---|---|
| **Node.js** | 20+ |
| **Claude Code CLI** | インストール済みおよび認証済み (`claude --version` が動作することを確認) |
| **npm** | 9+ (Node 20 に付属) |

---

## クイックスタート

```bash
# リポジトリのクローン
git clone https://github.com/op7418/CodePilot.git
cd CodePilot

# 依存関係のインストール
npm install

# 開発モードで起動
npm run dev
```

その後、ブラウザで [http://localhost:3000](http://localhost:3000) を開きます。

### 本番環境デプロイ

```bash
# Next.js standalone アプリをビルド
npm run build

# 本番サーバーを起動
npm run start
# -- または直接 --
node .next/standalone/codepilot-server.js
```

サーバーはデフォルトで `0.0.0.0:3000` にバインドします。`PORT` と `HOSTNAME` 環境変数で上書き可能。

**リモートアクセス（例：スマートフォンから）：** [Tailscale](https://tailscale.com/) などのツールを使用して、ネットワーク上の他のデバイスからサーバーにアクセスできます。

---

## テックスタック

| レイヤー | テクノロジー |
|---|---|
| フレームワーク | [Next.js](https://nextjs.org/)（App Router、standalone 出力） |
| UI コンポーネント | [Radix UI](https://www.radix-ui.com/) + [shadcn/ui](https://ui.shadcn.com/) |
| スタイリング | [Tailwind CSS 4](https://tailwindcss.com/) |
| アニメーション | [Motion](https://motion.dev/)（Framer Motion） |
| AI 統合 | [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) |
| データベース | [better-sqlite3](https://github.com/WiseLibs/better-sqlite3)（組み込み、ユーザーごと） |
| Markdown | react-markdown + remark-gfm + rehype-raw + [Shiki](https://shiki.style/) |
| ストリーミング | Server-Sent Events (SSE) |
| アイコン | [Hugeicons](https://hugeicons.com/) + [Lucide](https://lucide.dev/) |
| テスト | [Playwright](https://playwright.dev/) |
| CI/CD | [GitHub Actions](https://github.com/features/actions)（自動ビルド + タグでリリース） |

---

## プロジェクト構成

```
codepilot/
├── .github/workflows/      # CI/CD：ビルドと自動リリース
├── src/
│   ├── app/                 # Next.js App Router ページ & API ルート
│   │   ├── chat/            # 新規チャットページ & [id] セッションページ
│   │   ├── extensions/      # スキル + MCP サーバー管理
│   │   ├── settings/        # 設定エディター
│   │   └── api/             # REST + SSE エンドポイント
│   │       ├── chat/        # セッション、メッセージ、ストリーミング、権限
│   │       ├── files/       # ファイルツリー & プレビュー
│   │       ├── plugins/     # プラグイン & MCP CRUD
│   │       ├── settings/    # 設定の読み書き
│   │       ├── skills/      # スキル CRUD
│   │       └── tasks/       # タスク追跡
│   ├── components/
│   │   ├── ai-elements/     # メッセージバブル、コードブロック、ツール呼び出しなど
│   │   ├── chat/            # ChatView、MessageList、MessageInput、ストリーミング
│   │   ├── layout/          # AppShell、NavRail、BottomNav、RightPanel
│   │   ├── plugins/         # MCP サーバーリスト & エディター
│   │   ├── project/         # FileTree、FilePreview、TaskList
│   │   ├── skills/          # SkillsManager、SkillEditor
│   │   └── ui/              # Radix ベースのプリミティブ（button、dialog、tabs など）
│   ├── hooks/               # カスタム React フック（usePanel など）
│   ├── lib/                 # コアロジック
│   │   ├── claude-client.ts # Agent SDK ストリーミングラッパー
│   │   ├── db.ts            # SQLite スキーマ、マイグレーション、CRUD
│   │   ├── files.ts         # ファイルシステムヘルパー
│   │   ├── permission-registry.ts  # 権限リクエスト/レスポンスブリッジ
│   │   └── utils.ts         # 共有ユーティリティ
│   └── types/               # TypeScript インターフェース & API コントラクト
├── codepilot-server.js      # standalone サーバーエントリ（シェル環境をロード）
├── package.json
└── tsconfig.json
```

---

## 開発

```bash
# Next.js 開発サーバーを実行（ブラウザで開く）
npm run dev

# 本番環境ビルド（Next.js standalone）
npm run build

# 本番サーバーを起動
npm run start
```

### CI/CD

プロジェクトは GitHub Actions を使用して自動ビルドを行います。`v*` タグをプッシュするとビルドが実行され、GitHub Release が自動作成されます：

```bash
git tag v0.8.1
git push origin v0.8.1
# CI が自動ビルドして Release を公開
```

### メモ

- standalone サーバー（`codepilot-server.js`）はユーザーのシェル環境をロードして `ANTHROPIC_API_KEY`、`PATH` などを取得します。
- チャットデータは `~/.codepilot/codepilot.db`（開発モードでは `./data/codepilot.db`）に保存されます。
- アプリは SQLite の WAL モードを使用するため、同時読み込みは高速です。

---

## 貢献

貢献を歓迎します。開始するには：

1. リポジトリをフォークしてフィーチャーブランチを作成します。
2. `npm install` で依存関係をインストールします。
3. `npm run dev` を実行して、変更をローカルでテストします。
4. プルリクエストを開く前に `npm run lint` が成功することを確認します。
5. 変更内容と理由を明確に説明した PR を `main` に対して開きます。

PR はフォーカスを保つようにしてください -- 1 つのフィーチャーまたは修正ごとに 1 つの PR を開いてください。

---

## ライセンス

MIT
