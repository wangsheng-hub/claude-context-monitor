import * as vscode from 'vscode';
import { SessionStats } from './types';
import { getConfig, MonitorConfig } from './config';

function formatTokens(n: number): string {
  if (n >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(2)}M`;
  }
  if (n >= 1_000) {
    return `${(n / 1_000).toFixed(1)}K`;
  }
  return String(n);
}

function timeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) { return `${seconds}s ago`; }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) { return `${minutes}m ago`; }
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

function getContextSize(stats: SessionStats): number {
  return stats.lastInputTokens + stats.lastCacheReadTokens + stats.lastCacheCreationTokens;
}

export class StatusBarManager {
  private item: vscode.StatusBarItem;
  private panel: vscode.WebviewPanel | undefined;
  private lastStats: SessionStats | null = null;
  private updateTimer: NodeJS.Timeout | null = null;

  constructor() {
    const cfg = getConfig();
    const align = cfg.statusBarPosition === 'left'
      ? vscode.StatusBarAlignment.Left : vscode.StatusBarAlignment.Right;
    this.item = vscode.window.createStatusBarItem(align, 0);
    this.item.command = 'claude-context-monitor.showDetails';
    this.setIdle();
    this.item.show();
    this.updateTimer = setInterval(() => {
      if (this.lastStats) { this.updateText(this.lastStats); }
    }, 30_000);
  }

  setIdle(): void {
    const ctxLabel = formatTokens(getConfig().contextWindowSize);
    this.item.text = `$(graph) Claude -- / ${ctxLabel}`;
    this.item.tooltip = 'Claude Context Monitor';
    this.item.color = undefined;
    this.item.backgroundColor = undefined;
  }

  update(stats: SessionStats): void {
    this.lastStats = stats;
    this.updateText(stats);
    // If panel is open, refresh it
    if (this.panel) {
      this.panel.webview.html = this.buildPanelHtml(stats);
    }
  }

  private updateText(stats: SessionStats): void {
    const cfg = getConfig();
    const ctxWin = cfg.contextWindowSize;
    const currentCtx = getContextSize(stats);
    const ago = timeAgo(stats.lastUpdated);
    const ctxLabel = formatTokens(ctxWin);

    this.item.text = `$(graph) Claude ${formatTokens(currentCtx)} / ${ctxLabel}  updated ${ago}`;
    this.item.tooltip = `Context: ${formatTokens(currentCtx)} / ${ctxLabel}\nClick for details`;

    const ratio = currentCtx / ctxWin;
    if (ratio > cfg.errorThreshold) {
      this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    } else if (ratio > cfg.warningThreshold) {
      this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    } else {
      this.item.backgroundColor = undefined;
    }
  }

  showDetails(stats: SessionStats | null): void {
    if (!stats) {
      vscode.window.showInformationMessage('No active Claude Code session found.');
      return;
    }

    if (this.panel) {
      this.panel.webview.html = this.buildPanelHtml(stats);
      this.panel.reveal(vscode.ViewColumn.Active);
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      'claudeContextMonitor',
      'Claude Context Monitor',
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: true },
      { enableScripts: false }
    );

    this.panel.webview.html = this.buildPanelHtml(stats);
    this.panel.onDidDispose(() => { this.panel = undefined; });
  }

  private buildPanelHtml(stats: SessionStats): string {
    const cfg = getConfig();
    const ctxWin = cfg.contextWindowSize;
    const currentCtx = getContextSize(stats);
    const ctxRatio = Math.min(currentCtx / ctxWin, 1);
    const ctxPct = (ctxRatio * 100).toFixed(1);
    const ctxLabel = formatTokens(ctxWin);

    const totalIn = stats.totalInput + stats.subagentInput;
    const totalOut = stats.totalOutput + stats.subagentOutput;
    const totalCacheCreate = stats.totalCacheCreation + stats.subagentCacheCreation;
    const totalCacheRead = stats.totalCacheRead + stats.subagentCacheRead;
    const totalMessages = stats.messageCount + stats.subagentMessageCount;

    // Progress bar color
    let barColor = '#7c6bff';
    if (ctxRatio > cfg.errorThreshold) { barColor = '#f44747'; }
    else if (ctxRatio > cfg.warningThreshold) { barColor = '#cca700'; }

    return /* html */ `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: #1a1a2e;
    color: #e0e0e0;
    padding: 24px;
    display: flex;
    justify-content: center;
  }
  .card {
    background: #25253e;
    border-radius: 16px;
    padding: 28px 32px;
    max-width: 480px;
    width: 100%;
    box-shadow: 0 4px 24px rgba(0,0,0,0.3);
  }
  .header {
    display: flex;
    align-items: center;
    gap: 14px;
    margin-bottom: 24px;
  }
  .avatar {
    width: 48px; height: 48px;
    background: linear-gradient(135deg, #d4a574, #c4956a);
    border-radius: 12px;
    display: flex; align-items: center; justify-content: center;
    font-size: 24px;
  }
  .header-text h2 {
    font-size: 18px; font-weight: 600; color: #fff;
  }
  .header-text .session-id {
    font-size: 12px; color: #888; margin-top: 2px;
  }
  .badge {
    margin-left: auto;
    background: #7c6bff;
    color: #fff;
    padding: 4px 12px;
    border-radius: 6px;
    font-size: 13px;
    font-weight: 600;
  }
  .divider {
    border: none;
    border-top: 1px solid #3a3a5c;
    margin: 20px 0;
  }
  .section-label {
    font-size: 13px;
    color: #999;
    margin-bottom: 8px;
  }
  .usage-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 4px;
  }
  .usage-label { font-size: 15px; color: #ccc; }
  .usage-value { font-size: 15px; color: #fff; font-weight: 500; }
  .progress-bar {
    width: 100%;
    height: 8px;
    background: #3a3a5c;
    border-radius: 4px;
    margin: 12px 0 6px;
    overflow: hidden;
  }
  .progress-fill {
    height: 100%;
    border-radius: 4px;
    transition: width 0.3s;
    background: ${barColor};
    width: ${ctxPct}%;
  }
  .progress-text {
    font-size: 12px;
    color: #888;
    text-align: right;
  }
  .stats-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 16px;
    margin-top: 8px;
  }
  .stat-box {
    background: #2d2d4a;
    border-radius: 10px;
    padding: 14px;
  }
  .stat-box .label {
    font-size: 12px;
    color: #888;
    margin-bottom: 4px;
  }
  .stat-box .value {
    font-size: 20px;
    font-weight: 600;
    color: #fff;
  }
  .stat-box .sub {
    font-size: 11px;
    color: #666;
    margin-top: 2px;
  }
  .footer {
    margin-top: 20px;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .footer .dot {
    width: 8px; height: 8px;
    background: #4ec9b0;
    border-radius: 50%;
  }
  .footer .text {
    font-size: 12px;
    color: #888;
  }
</style>
</head>
<body>
<div class="card">
  <!-- Header -->
  <div class="header">
    <div class="avatar">&#x1F9E0;</div>
    <div class="header-text">
      <h2>Claude Code</h2>
      <div class="session-id">${stats.sessionId}</div>
    </div>
    <div class="badge">Opus 4.6</div>
  </div>

  <hr class="divider">

  <!-- Context Usage -->
  <div class="section-label">Estimated Context Usage</div>
  <div class="usage-row">
    <span class="usage-label">Context Window</span>
    <span class="usage-value">${formatTokens(currentCtx)} / ${ctxLabel}</span>
  </div>
  <div class="progress-bar"><div class="progress-fill"></div></div>
  <div class="progress-text">${ctxPct}% used</div>

  <hr class="divider">

  <!-- Token Stats -->
  <div class="section-label">Cumulative Token Usage</div>
  <div class="stats-grid">
    <div class="stat-box">
      <div class="label">Input Tokens</div>
      <div class="value">${formatTokens(totalIn)}</div>
      <div class="sub">main ${formatTokens(stats.totalInput)} · agent ${formatTokens(stats.subagentInput)}</div>
    </div>
    <div class="stat-box">
      <div class="label">Output Tokens</div>
      <div class="value">${formatTokens(totalOut)}</div>
      <div class="sub">main ${formatTokens(stats.totalOutput)} · agent ${formatTokens(stats.subagentOutput)}</div>
    </div>
    <div class="stat-box">
      <div class="label">Cache Create</div>
      <div class="value">${formatTokens(totalCacheCreate)}</div>
      <div class="sub">main ${formatTokens(stats.totalCacheCreation)} · agent ${formatTokens(stats.subagentCacheCreation)}</div>
    </div>
    <div class="stat-box">
      <div class="label">Cache Read</div>
      <div class="value">${formatTokens(totalCacheRead)}</div>
      <div class="sub">main ${formatTokens(stats.totalCacheRead)} · agent ${formatTokens(stats.subagentCacheRead)}</div>
    </div>
  </div>

  <hr class="divider">

  <!-- Messages -->
  <div class="usage-row">
    <span class="usage-label">Messages</span>
    <span class="usage-value">${totalMessages} <span style="color:#888;font-size:12px">(main ${stats.messageCount} · agent ${stats.subagentMessageCount})</span></span>
  </div>

  <!-- Footer -->
  <div class="footer">
    <div class="dot"></div>
    <div class="text">Active session · updated ${timeAgo(stats.lastUpdated)}</div>
  </div>
</div>
</body>
</html>`;
  }

  dispose(): void {
    this.item.dispose();
    this.panel?.dispose();
    if (this.updateTimer) {
      clearInterval(this.updateTimer);
    }
  }
}
