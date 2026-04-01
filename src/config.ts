import * as vscode from 'vscode';

export interface MonitorConfig {
  contextWindowSize: number;
  pollInterval: number;
  statusBarPosition: 'left' | 'right';
  warningThreshold: number;
  errorThreshold: number;
}

export function getConfig(): MonitorConfig {
  const cfg = vscode.workspace.getConfiguration('claudeContextMonitor');
  return {
    contextWindowSize: cfg.get('contextWindowSize', 1_000_000),
    pollInterval: cfg.get('pollInterval', 1500),
    statusBarPosition: cfg.get('statusBarPosition', 'right') as 'left' | 'right',
    warningThreshold: cfg.get('warningThreshold', 0.5),
    errorThreshold: cfg.get('errorThreshold', 0.8),
  };
}
