import * as vscode from 'vscode';
import { currentProjectPath, getProjectStatus, launcherPath, onDidRefreshStatus, statusError } from './launcher';
import { ProjectStatus, SessionInfo, SessionWatcher } from './types';

/** Escapes text from containers or paths for a MarkdownString. */
function esc(s: string): string {
  return s.replace(/[\\`*_{}[\]()#+!|<>~&-]/g, '\\$&');
}

export function registerSessionIndicator(ctx: vscode.ExtensionContext, watcher: SessionWatcher): void {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  item.name = 'puddibox sandbox';
  item.command = 'puddibox.sessionIndicatorMenu';
  let status: ProjectStatus | null = null;
  let known = false; // a status lookup has finished at least once
  let seq = 0;
  let current: SessionInfo | undefined;
  let recheck: NodeJS.Timeout[] = [];

  function render(): void {
    if (!known) {
      item.text = '$(vm-outline) sandbox';
      item.backgroundColor = undefined;
      item.tooltip = undefined;
      item.show();
      return;
    }
    const tip = new vscode.MarkdownString(undefined, true);
    tip.isTrusted = false;
    tip.supportThemeIcons = true;
    if (!status) {
      item.text = '$(vm-outline) sandbox ?';
      item.backgroundColor = undefined;
      tip.appendMarkdown(`The launcher could not be run: ${esc(launcherPath())}`);
      const p = currentProjectPath();
      const why = p && statusError(p);
      if (why) tip.appendMarkdown(`\n\n${esc(why)}`);
      item.tooltip = tip;
      item.show();
      return;
    }
    const s = current && current.running ? current : undefined;
    const others = watcher.sessions.filter((x) => x.running && x.id !== status?.id).length;
    let text = '$(vm-outline) sandbox';
    let warn = false;
    if (s) {
      if (s.mode === 'bypass') { text = '$(warning) sandbox: bypass'; warn = true; }
      else if (s.mode === 'shell') text = '$(terminal) sandbox: shell';
      else text = '$(vm-running) sandbox';
    }
    // The launcher keeps the review file while a session runs; it means "not reviewed" only after.
    const review = status.reviewPending && !s;
    if (review) { text += ' $(report)'; warn = true; }
    if (others > 0) text += ` +${others}`;
    item.text = text;
    item.backgroundColor = warn ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;

    tip.appendMarkdown(`**Project** ${esc(status.project)}\n\n`);
    tip.appendMarkdown(s
      ? `Session: ${s.mode}, auth: ${s.auth}, container ${esc(s.agentContainer)}\n\n`
      : 'No running session.\n\n');
    if (review) tip.appendMarkdown('$(report) Files to review from the last session.\n\n');
    if (others > 0) tip.appendMarkdown(`${others} other running sandbox(es).`);
    item.tooltip = tip;
    item.show();
  }

  async function update(force: boolean): Promise<void> {
    const my = ++seq;
    const p = currentProjectPath();
    if (!p) {
      status = null;
      current = undefined;
      known = false;
      item.hide();
      return;
    }
    const st = await getProjectStatus(p, force);
    if (my !== seq) return;
    status = st;
    known = true;
    current = st ? watcher.sessions.find((x) => x.id === st.id) : undefined;
    render();
  }

  async function menu(): Promise<void> {
    const items: (vscode.QuickPickItem & { command: string })[] = [];
    if (current && current.running) {
      items.push({ label: 'Stop sandbox', command: 'puddibox.stop' });
      items.push({ label: 'Open shell', command: 'puddibox.shell' });
    } else {
      items.push({ label: 'Start Claude', command: 'puddibox.start' });
      items.push({ label: 'Start Claude (bypass)', command: 'puddibox.startBypass' });
      items.push({ label: 'Open shell', command: 'puddibox.shell' });
    }
    items.push({ label: 'All sandbox sessions', command: 'puddibox.showSessions' });
    items.push({ label: 'Refresh', command: 'puddibox.refresh' });
    const pick = await vscode.window.showQuickPick(items, { placeHolder: 'puddibox sandbox' });
    if (pick) await vscode.commands.executeCommand(pick.command);
  }

  // Count of all running sandboxes, next to the usage bars (right side, left of priority 200).
  const crab = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 201);
  crab.name = 'puddibox sandbox count';
  crab.command = 'puddibox.showSessions';
  function renderCrab(): void {
    const running = watcher.sessions.filter((x) => x.running);
    crab.text = `$(vm-active) ${running.length}`;
    crab.color = running.length ? undefined : new vscode.ThemeColor('disabledForeground');
    const tip = new vscode.MarkdownString(undefined, true);
    tip.isTrusted = false;
    tip.appendMarkdown(running.length ? `**${running.length} running sandbox(es)**\n\n` : '**No running sandbox**\n\n');
    for (const x of running) tip.appendMarkdown(`- ${esc(x.id)}: ${x.mode}, ${x.auth}\n`);
    tip.appendMarkdown('\n*Click for all sessions*');
    crab.tooltip = tip;
    crab.show();
  }
  renderCrab();

  ctx.subscriptions.push(
    item,
    crab,
    watcher.onDidChange(renderCrab),
    vscode.commands.registerCommand('puddibox.sessionIndicatorMenu', () => menu()),
    // After a session ends the launcher still removes the proxies and runs the review, then
    // deletes the review file. Read the status again a few times so "pending review" clears.
    watcher.onDidChange(() => {
      for (const t of recheck) clearTimeout(t);
      recheck = [5000, 15000, 45000].map((ms) => setTimeout(() => { void update(true); }, ms));
      void update(true);
    }),
    { dispose: () => recheck.forEach(clearTimeout) },
    onDidRefreshStatus(() => { void update(false); }),
    vscode.window.onDidChangeActiveTextEditor(() => { void update(false); }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => { void update(false); }),
  );
  render();
  void update(false);
}
