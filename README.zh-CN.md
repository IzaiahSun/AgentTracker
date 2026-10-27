# AgentTracker

[English](README.md) | **简体中文**

本地统计各个 coding agent 每天的 token 用量，按模型分别汇总。基于 Tauri 2（系统原生 WebView：macOS WKWebView / Windows WebView2 / Linux WebKitGTK），安装包只有几 MB。只读本地日志，不联网。

界面支持中英双语，根据系统语言自动选择（系统为中文时显示中文，其余显示英文）。

其他功能：

- 按 API 官方价格估算费用（价格表可自行修改，可填订阅费对比回本倍数），并估算缓存省下的钱
- 按项目统计用量（会话按所在 git 仓库归类，worktree 也会归到主仓库）
- 每周节奏图（星期 × 小时）、连续天数和个人纪录
- 一键生成周 / 月 / 年度总结卡片（PNG），方便分享

支持从 GitHub Releases 自动更新（macOS 和 Windows 安装版；Windows 免安装版需要手动下载）。

## 下载

到 [Releases](https://github.com/IzaiahSun/AgentTracker/releases) 下载：

- **macOS**（Apple Silicon + Intel 通用）：`AgentTracker_<版本>_universal.dmg`，已签名并经过 Apple 公证，可以直接打开。
- **Windows x64**：`AgentTracker_<版本>_x64-setup.exe`（安装包）或 `_x64-portable.zip`（免安装）。暂未做代码签名，SmartScreen 弹窗时点“更多信息 → 仍要运行”。

## 支持的 Agent 与数据来源

| Agent | 数据位置 | 区分方式 / 备注 |
|---|---|---|
| Claude Code Desktop / CLI / SDK | `~/.claude/projects/**/*.jsonl`（`$CLAUDE_CONFIG_DIR`） | 每行的 `entrypoint`：`claude-desktop` / `cli` / `sdk-*`；按 `message.id + requestId` 去重 |
| Claude Cowork | `<应用数据>/Claude/local-agent-mode-sessions/**/.claude/projects` | 桌面版的 Cowork 模式 |
| Codex Desktop / CLI / IDE | `~/.codex/{sessions,archived_sessions}/**/rollout-*.jsonl`（`$CODEX_HOME`） | `session_meta.originator`；用量来自 `token_count` 事件，模型取自 `turn_context` |
| OpenCode | `~/.local/share/opencode/`：`opencode.db`（`message`、`session_message` 表）以及旧版 `storage/message/**.json` | 三处按消息 id 去重 |
| OpenClaw | `~/.openclaw/agents/*/sessions/*.jsonl`，以及 `*/agent/openclaw-agent.sqlite`（`$OPENCLAW_DIR`） | `message.usage {input,output,cacheRead,cacheWrite}` |
| DeepSeek Harness | `~/.dsh/sessions/**/session[.vN].jsonl[.zstd]`（`$DSH_HOME`） | 每个 turn/step 取一次 usage，另计 `compaction/summary`；跳过 `seedLength` 之前从父会话继承的事件 |

各家的 token 字段统一成同一套口径：

- **输入**：未命中缓存的输入（Codex 已扣除 `cached_input_tokens`）
- **输出**：包含推理 / thinking token（OpenCode 单独上报的 `reasoning` 会加进来）
- **缓存读 / 缓存写**

## 开发

```bash
npm install          # 只安装 @tauri-apps/cli
npm run dev          # 开发模式
npm run build        # 打包，产物在 src-tauri/target/release/bundle/
```

签名并公证 macOS 通用版（需要 Developer ID 证书）：

```bash
rustup toolchain install stable --profile minimal --target aarch64-apple-darwin x86_64-apple-darwin
xcrun notarytool store-credentials AgentTracker --apple-id <Apple ID> --team-id <Team ID>
npm run build:mac    # 产物：dist/AgentTracker_<版本>_universal.dmg（加 SKIP_NOTARIZE=1 只签名）
```

在 macOS 上交叉编译 Windows x64（GNU 工具链，不需要 MSVC SDK）：

```bash
brew install mingw-w64 makensis rustup
rustup toolchain install stable --profile minimal --target x86_64-pc-windows-gnu
npm run build:win    # 产物：dist/AgentTracker_<版本>_x64-setup.exe 和 _x64-portable.zip
```

### 发布新版本

更新包用 Tauri 的更新签名密钥签名（和 Apple 证书无关）。公钥写在 `src-tauri/tauri.conf.json` 里；私钥放在仓库外的 `~/.tauri/agenttracker.key`（可用 `TAURI_SIGNING_PRIVATE_KEY` 覆盖）。**务必备份私钥**：丢了之后，已安装的 app 无法验证新版本，也就不能自动更新。

```bash
# 先修改 src-tauri/tauri.conf.json 里的 "version"，然后：
scripts/release.sh   # 打包 macOS 和 Windows，生成 dist/latest.json，发布 v<版本>
```

已安装的 app 启动几秒后、以及之后每 6 小时，会检查 `releases/latest/download/latest.json`。命令行运行 `agent-tracker --update` 也可以检查并安装更新。

不启动界面、直接输出 JSON 报表：

```bash
src-tauri/target/release/agent-tracker --report
```

## 结构

```
src-tauri/src/
  lib.rs              # 汇总：全局去重，按 (本地日期, agent, 模型) 聚合
  model.rs            # 统一的 Tokens / Event / DailyRow
  collectors/         # 每个 agent 一个解析器；按 mtime+size 缓存已解析的文件
ui/                   # 原生 HTML/CSS/JS，无构建步骤；SVG 图表
  i18n.js             # 中英文案；按系统语言选择
```

新增一个 agent：在 `collectors/` 下实现 `collect(&FileCache) -> (Vec<Event>, SourceStatus)`，注册到 `lib.rs` 的 `COLLECTORS`，再在 `ui/app.js` 的 `AGENTS` 里分配一个颜色槽位。
