import * as vscode from 'vscode';
import { SessionStats, ModelUsage } from './types';
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

// Pricing per million tokens (USD)
interface ModelPricing {
  input: number;
  output: number;
  cacheCreation: number;
  cacheRead: number;
}

const MODEL_PRICING: Record<string, ModelPricing> = {
  // Claude Opus 4 / 4.6
  'claude-opus-4': { input: 15, output: 75, cacheCreation: 18.75, cacheRead: 1.5 },
  // Claude Sonnet 4 / 4.6
  'claude-sonnet-4': { input: 3, output: 15, cacheCreation: 3.75, cacheRead: 0.3 },
  // Claude Haiku 4.5
  'claude-haiku-4-5': { input: 0.8, output: 4, cacheCreation: 1, cacheRead: 0.08 },
  // Claude 3.5 Sonnet
  'claude-3-5-sonnet': { input: 3, output: 15, cacheCreation: 3.75, cacheRead: 0.3 },
  // OpenAI GPT-5.2
  'gpt-5.2': { input: 1.75, output: 14, cacheCreation: 1.75, cacheRead: 0.17 },
  // OpenAI GPT-5.1
  'gpt-5.1': { input: 1.25, output: 10, cacheCreation: 1.25, cacheRead: 0.12 },
  // OpenAI GPT-5
  'gpt-5': { input: 1.25, output: 10, cacheCreation: 1.25, cacheRead: 0.12 },
  // OpenAI GPT-5 mini
  'gpt-5-mini': { input: 0.25, output: 2, cacheCreation: 0.25, cacheRead: 0.02 },
  // OpenAI GPT-5 nano
  'gpt-5-nano': { input: 0.05, output: 0.40, cacheCreation: 0.05, cacheRead: 0.01 },
  // OpenAI GPT-4o
  'gpt-4o': { input: 2.5, output: 10, cacheCreation: 2.5, cacheRead: 1.25 },
  // OpenAI GPT-4o-mini
  'gpt-4o-mini': { input: 0.15, output: 0.6, cacheCreation: 0.15, cacheRead: 0.075 },
};

// Default pricing for unknown models (use Opus pricing as conservative estimate)
const DEFAULT_PRICING: ModelPricing = { input: 15, output: 75, cacheCreation: 18.75, cacheRead: 1.5 };

function getPricingForModel(modelName: string): ModelPricing {
  const lower = modelName.toLowerCase();
  // Exact key match first
  for (const [key, pricing] of Object.entries(MODEL_PRICING)) {
    if (lower.includes(key)) {
      return pricing;
    }
  }
  // Fuzzy fallback by family
  if (lower.includes('opus')) { return MODEL_PRICING['claude-opus-4']; }
  if (lower.includes('sonnet')) { return MODEL_PRICING['claude-sonnet-4']; }
  if (lower.includes('haiku')) { return MODEL_PRICING['claude-haiku-4-5']; }
  if (lower.includes('gpt-5.2')) { return MODEL_PRICING['gpt-5.2']; }
  if (lower.includes('gpt-5.1')) { return MODEL_PRICING['gpt-5.1']; }
  if (lower.includes('gpt-5-mini')) { return MODEL_PRICING['gpt-5-mini']; }
  if (lower.includes('gpt-5-nano')) { return MODEL_PRICING['gpt-5-nano']; }
  if (lower.includes('gpt-5')) { return MODEL_PRICING['gpt-5']; }
  if (lower.includes('gpt-4o-mini')) { return MODEL_PRICING['gpt-4o-mini']; }
  if (lower.includes('gpt-4o')) { return MODEL_PRICING['gpt-4o']; }
  return DEFAULT_PRICING;
}

function calculateModelCost(usage: ModelUsage, pricing: ModelPricing): number {
  return (
    (usage.input / 1_000_000) * pricing.input +
    (usage.output / 1_000_000) * pricing.output +
    (usage.cacheCreation / 1_000_000) * pricing.cacheCreation +
    (usage.cacheRead / 1_000_000) * pricing.cacheRead
  );
}

function calculateTotalCost(modelUsage: Record<string, ModelUsage>): number {
  let total = 0;
  for (const [model, usage] of Object.entries(modelUsage)) {
    total += calculateModelCost(usage, getPricingForModel(model));
  }
  return total;
}

function formatCost(cost: number): string {
  if (cost >= 1) { return `$${cost.toFixed(2)}`; }
  if (cost >= 0.01) { return `$${cost.toFixed(3)}`; }
  return `$${cost.toFixed(4)}`;
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

    const cost = calculateTotalCost(stats.modelUsage);
    const costStr = cost > 0 ? `  ${formatCost(cost)}` : '';
    this.item.text = `$(graph) Claude ${formatTokens(currentCtx)} / ${ctxLabel}${costStr}  updated ${ago}`;
    this.item.tooltip = `Context: ${formatTokens(currentCtx)} / ${ctxLabel}${cost > 0 ? `\nEstimated Cost: ${formatCost(cost)}` : ''}\nClick for details`;

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
    const totalCost = calculateTotalCost(stats.modelUsage);

    // Build per-model cost rows
    const modelEntries = Object.entries(stats.modelUsage).sort(
      ([ma, a], [mb, b]) => calculateModelCost(b, getPricingForModel(mb)) - calculateModelCost(a, getPricingForModel(ma))
    );
    let modelCostRows = '';
    for (const [model, usage] of modelEntries) {
      const pricing = getPricingForModel(model);
      const cost = calculateModelCost(usage, pricing);
      const displayName = model.length > 30 ? model.slice(0, 27) + '...' : model;
      modelCostRows += `
        <div class="cost-row">
          <span class="cost-model">${displayName}</span>
          <span class="cost-detail">${formatTokens(usage.input)} in · ${formatTokens(usage.output)} out · ${formatTokens(usage.cacheRead)} cache</span>
          <span class="cost-value">${formatCost(cost)}</span>
        </div>`;
    }

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
  .cost-total {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 12px;
  }
  .cost-total .label { font-size: 15px; color: #ccc; }
  .cost-total .value { font-size: 22px; font-weight: 700; color: #4ec9b0; }
  .cost-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    background: #2d2d4a;
    border-radius: 8px;
    margin-bottom: 6px;
  }
  .cost-model {
    font-size: 13px;
    color: #ccc;
    font-weight: 500;
    min-width: 120px;
  }
  .cost-detail {
    font-size: 11px;
    color: #666;
    flex: 1;
  }
  .cost-value {
    font-size: 14px;
    font-weight: 600;
    color: #4ec9b0;
    min-width: 60px;
    text-align: right;
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

  <!-- Cost -->
  <div class="section-label">Estimated Cost</div>
  <div class="cost-total">
    <span class="label">Total</span>
    <span class="value">${formatCost(totalCost)}</span>
  </div>
  ${modelCostRows}

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
