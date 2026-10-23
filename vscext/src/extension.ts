import * as vscode from 'vscode';
import { registerCommands } from './commands';
import { registerSessionIndicator } from './sessionIndicator';
import { createSessionWatcher } from './sessions';
import { registerTree } from './tree';
import { registerUsage } from './usage';

export function activate(context: vscode.ExtensionContext): void {
  const watcher = createSessionWatcher(context);
  context.subscriptions.push(watcher);
  registerSessionIndicator(context, watcher);
  registerUsage(context, watcher);
  registerCommands(context, watcher);
  registerTree(context, watcher);
  void watcher.refresh();
}

export function deactivate(): void {}
