import * as path from 'path';
import * as vscode from 'vscode';
import { DOMAIN_RE, getExtraDomains, setExtraDomains } from './allowlist';
import { currentProjectPath, getProjectStatus, launcherPath } from './launcher';
import { buildScriptPath, runLauncher, runScriptInTerminal } from './terminal';
import { SessionInfo, SessionWatcher } from './types';
import { runWslc } from './wslc';

function norm(p: string): string {
  return path.resolve(p).toLowerCase();
}

function isInside(file: string, folder: string): boolean {
  const f = norm(file);
  const d = norm(folder);
  return f === d || f.startsWith(d.endsWith(path.sep) ? d : d + path.sep);
}

function folderName(p: string): string {
  return path.basename(p) || p;
}

async function runningSessionFor(watcher: SessionWatcher, project: string): Promise<SessionInfo | undefined> {
  const st = await getProjectStatus(project);
  if (!st) return undefined;
  return watcher.sessions.find((s) => s.running && s.agentContainer === st.containers.agent);
}

/** Rule 6: the agent can write the launcher if it lives inside a project folder it can reach. */
async function confirmLauncherSafe(watcher: SessionWatcher, project: string): Promise<boolean> {
  const launcher = launcherPath();
  const folders = new Set<string>([project]);
  for (const s of watcher.sessions) if (s.running && s.projectPath) folders.add(s.projectPath);
  const hit = [...folders].find((f) => isInside(launcher, f));
  if (!hit) return true;
  const pick = await vscode.window.showWarningMessage(
    `puddibox.launcherPath is inside a sandbox project folder (${hit}). The agent can modify the launcher, and the next start would run the modified file with your user rights.`,
    { modal: true },
    'Start anyway'
  );
  return pick === 'Start anyway';
}

type Kind = 'claude' | 'bypass' | 'shell';

async function start(ctx: vscode.ExtensionContext, watcher: SessionWatcher, kind: Kind): Promise<void> {
  const project = currentProjectPath();
  if (!project) {
    void vscode.window.showErrorMessage('puddibox: open a local folder first.');
    return;
  }
  const name = folderName(project);
  if (kind === 'bypass') {
    const pick = await vscode.window.showWarningMessage(
      'Start in bypass permissions mode? Claude runs every command without asking.',
      { modal: true },
      'Start in bypass'
    );
    if (pick !== 'Start in bypass') return;
  }
  if (kind !== 'shell') {
    const running = await runningSessionFor(watcher, project);
    if (running) {
      const pick = await vscode.window.showInformationMessage(
        `A sandbox for "${name}" is already running. The launcher allows only one agent per project.`,
        'Open shell'
      );
      if (pick === 'Open shell') await start(ctx, watcher, 'shell');
      return;
    }
  }
  if (!(await confirmLauncherSafe(watcher, project))) return;
  const args = ['-Path', project];
  if (kind === 'bypass') args.push('-Bypass');
  if (kind === 'shell') args.push('-Shell');
  const extra = getExtraDomains(ctx, project);
  if (extra.length) args.push('-AllowDomain', extra.join(','));
  const title = kind === 'bypass' ? `Claude (bypass): ${name}` : kind === 'shell' ? `Sandbox shell: ${name}` : `Claude: ${name}`;
  await runLauncher(args, title);
}

function isSessionInfo(o: unknown): o is SessionInfo {
  const s = o as SessionInfo;
  return !!s && typeof s.id === 'string' && typeof s.agentContainer === 'string' && typeof s.running === 'boolean';
}

async function stopSession(watcher: SessionWatcher, s: SessionInfo): Promise<void> {
  const label = s.projectPath ? `${folderName(s.projectPath)} (${s.id})` : s.id;
  const pick = await vscode.window.showWarningMessage(
    `Stop the sandbox "${label}" (${s.mode})?`,
    {
      modal: true,
      detail: 'Stop: Claude gets SIGTERM and 10 s to exit, then SIGKILL.\n'
        + 'Kill now: SIGKILL at once, for a session that hangs.\n\n'
        + 'In both cases the launcher window removes the proxies and shows the review of changed files. '
        + 'Do not close that window before it finishes, or the review stays pending until the next start.',
    },
    'Stop',
    'Kill now'
  );
  if (pick !== 'Stop' && pick !== 'Kill now') return;
  const args = pick === 'Stop' ? ['stop', '-t', '10', s.agentContainer] : ['kill', s.agentContainer];
  const r = await runWslc(args, { timeoutMs: 30000 });
  if (r.code !== 0) {
    void vscode.window.showErrorMessage(`puddibox: wslc ${args[0]} failed: ${(r.stderr || r.stdout).trim().slice(0, 500)}`);
  }
  await watcher.refresh();
}

async function stop(watcher: SessionWatcher, arg?: unknown): Promise<void> {
  // From the panel the argument is the tree node; its `session` property holds the SessionInfo.
  const inner = (arg as { session?: unknown } | undefined)?.session;
  let target: SessionInfo | undefined = isSessionInfo(inner) ? inner : isSessionInfo(arg) ? arg : undefined;
  // Re-read the live list: the node can be older than the last refresh.
  if (target) {
    const agent = target.agentContainer;
    target = watcher.sessions.find((s) => s.agentContainer === agent) ?? target;
  }
  if (!target) {
    const project = currentProjectPath();
    if (project) target = await runningSessionFor(watcher, project);
  }
  if (!target || !target.running) {
    void vscode.window.showInformationMessage('puddibox: no running sandbox for this project.');
    return;
  }
  await stopSession(watcher, target);
}

async function showSessions(watcher: SessionWatcher): Promise<void> {
  const sessions = watcher.sessions;
  if (!sessions.length) {
    void vscode.window.showInformationMessage('puddibox: no sandbox sessions.');
    return;
  }
  const items = sessions.map((s) => ({
    label: s.id,
    description: `${s.mode} / ${s.auth} / ${s.running ? 'running' : 'stopped'}`,
    detail: [s.startedAt ? `started ${s.startedAt.toLocaleString()}` : '', s.projectPath ?? ''].filter(Boolean).join('  '),
    session: s,
  }));
  const chosen = await vscode.window.showQuickPick(items, { placeHolder: 'Sandbox sessions' });
  if (!chosen) return;
  const actions = [...(chosen.session.running ? ['Stop'] : []), 'Copy container name'];
  const act = await vscode.window.showQuickPick(actions, { placeHolder: chosen.label });
  if (act === 'Stop') await stopSession(watcher, chosen.session);
  else if (act === 'Copy container name') await vscode.env.clipboard.writeText(chosen.session.agentContainer);
}

async function editAllowlist(ctx: vscode.ExtensionContext): Promise<void> {
  const project = currentProjectPath();
  if (!project) {
    void vscode.window.showErrorMessage('puddibox: open a local folder first.');
    return;
  }
  const value = await vscode.window.showInputBox({
    title: `Extra egress domains: ${folderName(project)}`,
    prompt: 'Comma separated, e.g. example.com, .cdn.example.com. Each domain is a new way for data to leave the sandbox. Empty clears the list.',
    value: getExtraDomains(ctx, project).join(', '),
    validateInput: (v) => {
      const bad = v.split(',').map((d) => d.trim().toLowerCase()).filter(Boolean).find((d) => !DOMAIN_RE.test(d));
      return bad ? `Not a valid domain: ${bad}` : undefined;
    },
  });
  if (value === undefined) return;
  await setExtraDomains(ctx, project, value.split(','));
  void vscode.window.showInformationMessage('puddibox: extra domains saved. They apply from the next start.');
}

export function registerCommands(ctx: vscode.ExtensionContext, watcher: SessionWatcher): void {
  const reg = (id: string, fn: (...a: unknown[]) => unknown) => ctx.subscriptions.push(vscode.commands.registerCommand(id, fn));
  reg('puddibox.start', () => start(ctx, watcher, 'claude'));
  reg('puddibox.startBypass', () => start(ctx, watcher, 'bypass'));
  reg('puddibox.shell', () => start(ctx, watcher, 'shell'));
  reg('puddibox.stop', (arg) => stop(watcher, arg));
  reg('puddibox.showSessions', () => showSessions(watcher));
  reg('puddibox.refresh', async () => {
    await watcher.refresh();
    const p = currentProjectPath();
    if (p) await getProjectStatus(p, true);
  });
  reg('puddibox.setToken', () => runLauncher(['-SetToken'], 'puddibox: store token'));
  reg('puddibox.removeToken', async () => {
    const pick = await vscode.window.showWarningMessage(
      'Remove the stored setup-token? Projects fall back to /login.',
      { modal: true },
      'Remove'
    );
    if (pick === 'Remove') await runLauncher(['-RemoveToken'], 'puddibox: remove token');
  });
  reg('puddibox.rebuildImages', async () => {
    const pick = await vscode.window.showWarningMessage(
      'Rebuild the sandbox images? This can take several minutes.',
      { modal: true },
      'Rebuild'
    );
    if (pick === 'Rebuild') await runScriptInTerminal(buildScriptPath(), [], 'puddibox: rebuild images');
  });
  reg('puddibox.editAllowlist', () => editAllowlist(ctx));
}
