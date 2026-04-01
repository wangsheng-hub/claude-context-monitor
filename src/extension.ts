import * as vscode from 'vscode';
import { SessionWatcher } from './sessionWatcher';
import { StatusBarManager } from './statusBar';
import { getConfig } from './config';

let watcher: SessionWatcher | undefined;
let statusBar: StatusBarManager | undefined;

function createWatcher(): SessionWatcher {
  const cfg = getConfig();
  const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
  const w = new SessionWatcher(workspacePath, cfg.pollInterval);
  w.on('update', (stats) => { statusBar?.update(stats); });
  w.start();
  return w;
}

export function activate(context: vscode.ExtensionContext): void {
  statusBar = new StatusBarManager();
  watcher = createWatcher();

  context.subscriptions.push(
    vscode.commands.registerCommand('claude-context-monitor.showDetails', () => {
      statusBar?.showDetails(watcher?.getStats() ?? null);
    }),
    vscode.commands.registerCommand('claude-context-monitor.refresh', () => {
      watcher?.stop();
      watcher = createWatcher();
      vscode.window.showInformationMessage('Claude Context Monitor: refreshed');
    }),
    // Restart watcher when config changes
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('claudeContextMonitor')) {
        watcher?.stop();
        watcher = createWatcher();
        statusBar?.setIdle();
      }
    }),
    { dispose: () => { watcher?.stop(); statusBar?.dispose(); } }
  );
}

export function deactivate(): void {
  watcher?.stop();
  statusBar?.dispose();
}
