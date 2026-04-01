# Claude Context Monitor

Real-time context window usage and token statistics for [Claude Code](https://claude.ai/code) sessions in VS Code.

## Features

- **Status Bar** — Live display: `Claude 125.5K / 1M updated 3m ago`
- **Dashboard Panel** — Click status bar to open detailed Webview with:
  - Context window progress bar (purple/yellow/red)
  - Cumulative token breakdown (Input / Output / Cache Create / Cache Read)
  - Main session vs. subagent split
  - Session ID and message count
- **Auto-Discovery** — Automatically finds active Claude Code sessions matching your workspace
- **Real-time Updates** — Triple-layer monitoring: `fs.watch` + `fs.watchFile` + polling
- **Configurable** — Context window size, poll interval, thresholds, status bar position

## How It Works

Claude Code writes session logs to `~/.claude/projects/<slug>/<sessionId>.jsonl`. This extension:

1. Scans `~/.claude/sessions/*.json` to find the active session for your workspace
2. Tails the JSONL log file incrementally, parsing `message.usage` from assistant messages
3. Displays current context usage (last message's `input_tokens + cache_read + cache_creation`) and cumulative totals

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `claudeContextMonitor.contextWindowSize` | `1000000` | Context window size in tokens |
| `claudeContextMonitor.pollInterval` | `1500` | Poll interval in ms |
| `claudeContextMonitor.statusBarPosition` | `right` | Status bar position (`left` / `right`) |
| `claudeContextMonitor.warningThreshold` | `0.5` | Warning color threshold (50%) |
| `claudeContextMonitor.errorThreshold` | `0.8` | Error color threshold (80%) |

## Install from VSIX

```bash
code --install-extension claude-context-monitor-1.0.0.vsix
```

## Build from Source

```bash
npm install
npm run compile
npm run package
```

## License

MIT
