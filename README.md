# AgentTracker

**English** | [简体中文](README.zh-CN.md)

A tiny desktop app that tracks how many tokens your coding agents use each day, broken down by model. It reads the agents' local logs. Nothing leaves your machine. Built with Tauri 2 on the system webview (WKWebView on macOS, WebView2 on Windows, WebKitGTK on Linux), so installers are only a few MB.

- Daily stacked bar chart, grouped by agent or by model
- GitHub-style heatmap of the past year (click a day to focus on it)
- Per-agent model breakdown: input, output, cache read, cache write
- Estimated cost at API prices (editable price table, optional subscription comparison) and how much caching saved
- Per-project usage (sessions are mapped to their git repository, worktrees included)
- When you work (requests by hour of day and day of week), streaks and personal records
- Shareable weekly / monthly / yearly summary cards (PNG)
- Menu bar (macOS) / tray (Windows, Linux) icon with today's and this week's usage; closing the window keeps it running there, quit from its menu
- Preset ranges (today / 7 / 30 / 90 days / all) or a custom date range
- Switchable metric: all tokens, excluding cache reads, input only, output only, …
- Light and dark mode; English and Chinese UI, chosen from the system language
- Updates itself from GitHub Releases (macOS and the Windows installer)

## Download

Get the latest build from [Releases](https://github.com/IzaiahSun/AgentTracker/releases):

- **macOS** (universal, Apple Silicon + Intel): `AgentTracker_<version>_universal.dmg`. Signed and notarized by Apple, so it opens without warnings.
- **Windows x64**: `AgentTracker_<version>_x64-setup.exe` (installer) or `_x64-portable.zip` (no install). Not code-signed yet. If SmartScreen appears, choose "More info → Run anyway".

## Supported agents and data sources

| Agent | Where it reads | How it's identified / notes |
|---|---|---|
| Claude Code Desktop / CLI / SDK | `~/.claude/projects/**/*.jsonl` (`$CLAUDE_CONFIG_DIR`) | `entrypoint` on each line: `claude-desktop` / `cli` / `sdk-*`; deduplicated by `message.id + requestId` |
| Claude Cowork | `<app data>/Claude/local-agent-mode-sessions/**/.claude/projects` | Cowork mode of the Claude desktop app |
| Codex Desktop / CLI / IDE | `~/.codex/{sessions,archived_sessions}/**/rollout-*.jsonl` (`$CODEX_HOME`) | `session_meta.originator`; usage from `token_count` events, model from `turn_context` |
| OpenCode | `~/.local/share/opencode/`: `opencode.db` (`message` and `session_message` tables) plus legacy `storage/message/**.json` | Deduplicated by message id across all three |
| OpenClaw | `~/.openclaw/agents/*/sessions/*.jsonl` and `*/agent/openclaw-agent.sqlite` (`$OPENCLAW_DIR`) | `message.usage {input, output, cacheRead, cacheWrite}` |
| DeepSeek Harness | `~/.dsh/sessions/**/session[.vN].jsonl[.zstd]` (`$DSH_HOME`) | One usage record per turn/step, plus `compaction/summary`; events inherited from a parent session (`seq < seedLength`) are skipped |

Token fields from every agent are normalized to the same meaning:

- **Input**: uncached input only (Codex's `cached_input_tokens` is subtracted)
- **Output**: includes reasoning / thinking tokens (OpenCode's separate `reasoning` count is added)
- **Cache read / cache write**

The OpenClaw and DeepSeek Harness parsers have only been tested against fixtures. If your numbers look off, please open an issue.

## Development

```bash
npm install          # installs only @tauri-apps/cli
npm run dev          # run in development mode
npm run build        # bundle into src-tauri/target/release/bundle/
```

Signed and notarized universal macOS build (needs a Developer ID certificate):

```bash
rustup toolchain install stable --profile minimal --target aarch64-apple-darwin x86_64-apple-darwin
xcrun notarytool store-credentials AgentTracker --apple-id <Apple ID> --team-id <Team ID>
npm run build:mac    # -> dist/AgentTracker_<version>_universal.dmg (SKIP_NOTARIZE=1 to sign only)
```

Cross-compile Windows x64 from macOS (GNU toolchain, no MSVC SDK needed):

```bash
brew install mingw-w64 makensis rustup
rustup toolchain install stable --profile minimal --target x86_64-pc-windows-gnu
npm run build:win    # -> dist/AgentTracker_<version>_x64-setup.exe and _x64-portable.zip
```

### Releasing

Updates are signed with a Tauri updater key (separate from the Apple certificate). The public key is in `src-tauri/tauri.conf.json`; the private key lives outside the repo at `~/.tauri/agenttracker.key` (override with `TAURI_SIGNING_PRIVATE_KEY`). **Back it up**: without it, installed copies can't verify new releases and won't update.

```bash
# bump "version" in src-tauri/tauri.conf.json, then:
scripts/release.sh   # builds macOS + Windows, writes dist/latest.json, publishes v<version>
```

Installed apps check `releases/latest/download/latest.json` a few seconds after launch and every 6 hours. `agent-tracker --update` checks and installs from the command line.

Print the report as JSON without opening the UI:

```bash
src-tauri/target/release/agent-tracker --report
```

## Layout

```
src-tauri/src/
  lib.rs              # aggregation: global dedup, grouped by (local date, agent, model)
  model.rs            # shared Tokens / Event / DailyRow types
  collectors/         # one parser per agent; parsed files cached by mtime + size
ui/                   # plain HTML/CSS/JS, no build step; SVG charts
  i18n.js             # English and Chinese strings, picked from the system language
```

To add an agent: implement `collect(&FileCache) -> (Vec<Event>, SourceStatus)` in `collectors/`, register it in `COLLECTORS` in `lib.rs`, and give it a color slot in `AGENTS` in `ui/app.js`.

## License

[MIT](LICENSE)
