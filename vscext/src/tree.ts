import * as path from 'path';
import * as vscode from 'vscode';
import { getExtraDomains } from './allowlist';
import { currentProjectPath, getProjectStatus, launcherPath, onDidRefreshStatus, statusError } from './launcher';
import { runWslc } from './wslc';
import { AuthMode, LastReview, ProjectStatus, ReviewChange, SessionInfo, SessionMode, SessionWatcher } from './types';

// Same list as $DefaultDomains in claude-box.ps1. Token mode removes api.anthropic.com there.
const DEFAULT_DOMAINS = ['api.anthropic.com', '.claude.ai', '.claude.com', 'pypi.org', 'files.pythonhosted.org'];

type VolumeKind = 'config' | 'venv' | 'uvCache';

const VOLUME_LABEL: Record<VolumeKind, string> = { config: 'config', venv: 'venv', uvCache: 'uv cache' };
const VOLUME_LOSS: Record<VolumeKind, string> = {
  config: 'the Claude login, settings and conversation history of this project',
  venv: 'the Linux .venv of this project',
  uvCache: 'the uv cache of this project',
};

let refreshFn: () => void = () => {};

export function refreshTree(): void {
  refreshFn();
}

class Node extends vscode.TreeItem {
  constructor(label: string, public readonly children: Node[] = [], expanded = false) {
    super(
      label,
      children.length
        ? (expanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed)
        : vscode.TreeItemCollapsibleState.None
    );
  }
}

function leaf(label: string, icon: string, description?: string, tooltip?: string): Node {
  const n = new Node(label);
  n.iconPath = new vscode.ThemeIcon(icon);
  if (description) n.description = description;
  if (tooltip) n.tooltip = tooltip;
  return n;
}

function section(label: string, icon: string, children: Node[], contextValue?: string, description?: string): Node {
  const n = new Node(label, children, true);
  n.iconPath = new vscode.ThemeIcon(icon);
  if (contextValue) n.contextValue = contextValue;
  if (description) n.description = description;
  return n;
}

function hhmm(d: Date | undefined): string | undefined {
  if (!d || isNaN(d.getTime())) return undefined;
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** Passed to view/item/context commands. `session` holds the SessionInfo; its fields are mirrored. */
export class SessionNode extends Node {
  readonly agentContainer: string;
  readonly apiContainer?: string;
  readonly egressContainer?: string;
  readonly mode: SessionMode;
  readonly auth: AuthMode;
  readonly running: boolean;
  readonly startedAt?: Date;

  constructor(public readonly session: SessionInfo) {
    super(session.mode, sessionContainers(session));
    this.agentContainer = session.agentContainer;
    this.apiContainer = session.apiContainer;
    this.egressContainer = session.egressContainer;
    this.mode = session.mode;
    this.auth = session.auth;
    this.running = session.running;
    this.startedAt = session.startedAt;
    const since = hhmm(session.startedAt);
    this.description = since ? `${session.auth} · since ${since}` : session.auth;
    this.iconPath = new vscode.ThemeIcon(session.mode === 'bypass' ? 'warning' : session.mode === 'shell' ? 'terminal' : 'vm-running');
    this.contextValue = 'session.running';
    this.tooltip = `${session.agentContainer}\nmode: ${session.mode}, auth: ${session.auth}`;
    this.collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
  }
}

function sessionContainers(s: SessionInfo): Node[] {
  const rows: [string, string | undefined][] = [['agent', s.agentContainer], ['api', s.apiContainer], ['egress', s.egressContainer]];
  return rows.filter(([, name]) => !!name).map(([role, name]) => leaf(role, 'package', name));
}

class VolumeNode extends Node {
  constructor(public readonly kind: VolumeKind, public readonly volumeName: string, idle: boolean) {
    super(VOLUME_LABEL[kind]);
    this.description = volumeName;
    this.iconPath = new vscode.ThemeIcon('database');
    this.contextValue = idle ? 'volume.idle' : 'volume.busy';
    this.tooltip = idle ? volumeName : `${volumeName}\nIn use by a running session`;
  }
}

interface ImageInfo {
  created: string;
}

async function listImages(): Promise<Map<string, ImageInfo> | null> {
  const r = await runWslc(['image', 'list', '--format', 'json']);
  if (r.code !== 0) return null;
  const map = new Map<string, ImageInfo>();
  for (const line of r.stdout.split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try {
      const o = JSON.parse(t);
      if (typeof o.Repository === 'string' && typeof o.Tag === 'string' && o.Repository !== '<none>') {
        const m = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.exec(String(o.CreatedAt ?? ''));
        map.set(`${o.Repository}:${o.Tag}`, { created: m ? m[0] : '' });
      }
    } catch { /* skip a malformed line */ }
  }
  return map;
}

async function buildRoots(ctx: vscode.ExtensionContext, watcher: SessionWatcher): Promise<Node[]> {
  const project = currentProjectPath();
  if (!project) return [leaf('No project folder open', 'info')];
  const st = await getProjectStatus(project);
  if (!st) {
    const why = statusError(project) ?? 'unknown error';
    return [
      leaf('Launcher status failed', 'error', why,
        `Could not run ${launcherPath()} -Status -Json.\n${why}\nUpdate the launcher, or check puddibox.launcherPath.`),
      leaf(launcherPath(), 'file-code', 'puddibox.launcherPath'),
    ];
  }
  const running = watcher.sessions.filter((s) => s.running);
  const mine = running.filter((s) => s.id === st.id);
  const others = running.filter((s) => s.id !== st.id);
  const idle = mine.length === 0;
  const roots: Node[] = [];

  const sessionKids: Node[] = mine.map((s) => new SessionNode(s));
  if (!mine.length) sessionKids.push(leaf('No running session', 'circle-slash'));
  if (others.length) sessionKids.push(leaf(`Other sandboxes: ${others.length}`, 'layers'));
  roots.push(section('Sessions', 'vm', sessionKids));

  roots.push(section('Project', 'folder', [
    leaf('id', 'tag', st.id),
    new VolumeNode('config', st.volumes.config, idle),
    new VolumeNode('venv', st.volumes.venv, idle),
    new VolumeNode('uvCache', st.volumes.uvCache, idle),
  ]));

  roots.push(st.tokenStored
    ? leaf('Token: stored', 'key', undefined, 'A setup-token is stored for the launcher.')
    : leaf('Token: not stored - /login mode', 'key', undefined, 'No token stored. The session uses /login.'));
  const tok = roots[roots.length - 1];
  tok.contextValue = st.tokenStored ? 'token.stored' : 'token.missing';

  roots.push(await buildImages(st));

  const dom: Node[] = DEFAULT_DOMAINS.map((d) =>
    d === 'api.anthropic.com' && st.tokenStored ? leaf(`${d} (only via api-proxy)`, 'globe') : leaf(d, 'globe'));
  for (const d of getExtraDomains(ctx, project)) dom.push(leaf(d, 'globe', 'extra'));
  roots.push(section('Egress allowlist', 'shield', dom, 'allowlist'));

  // The launcher keeps the review file while a session runs; it means "not reviewed" only after.
  if (st.reviewPending && idle) {
    roots.push(leaf('Pending review', 'warning', undefined,
      'A previous session ended without a review. The launcher shows the report at the next start of this project.'));
  }
  const review = lastReviewNode(project, st.lastReview);
  if (review) roots.push(review);
  return roots;
}

const CHANGE_ICON: Record<ReviewChange['change'], string> = { added: 'diff-added', removed: 'diff-removed', changed: 'diff-modified' };

function isChange(c: unknown): c is ReviewChange {
  const o = c as ReviewChange;
  return !!o && (o.change === 'added' || o.change === 'removed' || o.change === 'changed')
    && typeof o.path === 'string' && o.path.length > 0 && o.path.length < 1024;
}

/** The review shown in the panel; the full-report document reads it. */
let shownReview: { project: string; review: LastReview; changes: ReviewChange[] } | undefined;

/** Absolute path of a change, or undefined when it points outside the project. */
function changePath(project: string, rel: string): string | undefined {
  const root = path.resolve(project);
  const full = path.resolve(root, rel);
  return full.toLowerCase().startsWith(root.toLowerCase() + path.sep) ? full : undefined;
}

function reviewWhen(r: LastReview): string {
  const at = new Date(r.at);
  return isNaN(at.getTime()) ? r.at : at.toLocaleString();
}

function lastReviewNode(project: string, r: LastReview | null | undefined): Node | undefined {
  shownReview = undefined;
  if (!r || typeof r.at !== 'string') return undefined;
  const changes = (Array.isArray(r.changes) ? r.changes : []).filter(isChange);
  shownReview = { project, review: r, changes };
  const kids = changes.map((c) => {
    // Like the Source Control view: file name as label, folder and change as description.
    const rel = c.path.replace(/\\/g, '/');
    const slash = rel.lastIndexOf('/');
    const dir = slash > 0 ? rel.slice(0, slash) : '';
    const desc = [dir, c.change, c.detail].filter(Boolean).join(' · ');
    const n = leaf(slash >= 0 ? rel.slice(slash + 1) : rel, CHANGE_ICON[c.change], desc);
    n.tooltip = `${c.change}: ${rel}${c.detail ? `\n${c.detail}` : ''}`;
    const full = changePath(project, rel);
    if (full && c.change !== 'removed') {
      n.command = { command: 'puddibox.openReviewChange', title: 'Open', arguments: [full, c.change] };
      n.tooltip += c.change === 'changed' ? '\nClick: diff against git HEAD.' : '\nClick: open the file.';
    }
    return n;
  });
  if (!kids.length) kids.push(leaf('No changes to files that Windows executes or trusts', 'pass'));
  const s = section('Last review', changes.length ? 'warning' : 'pass', kids, 'review',
    `${reviewWhen(r)} · ${changes.length} change(s)${r.kind === 'leftover' ? ' · leftover' : ''}`);
  s.collapsibleState = changes.length ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed;
  s.tooltip = r.kind === 'leftover'
    ? 'Report at the start of a session, for a previous session that ended without a review. It includes your own edits.'
    : `Report at the end of the last session (exit code ${r.exitCode}).`;
  return s;
}

async function buildImages(st: ProjectStatus): Promise<Node> {
  const found = await listImages();
  const kids = [st.images.agent, st.images.egressProxy, st.images.apiProxy].map((name) => {
    if (!found) return leaf(name, 'package');
    const info = found.get(name);
    return info
      ? leaf(name, 'package', info.created || undefined)
      : leaf(name, 'warning', 'missing', `${name} is not built. Use Rebuild sandbox images.`);
  });
  return section('Images', 'package', kids, 'images');
}

export function registerTree(ctx: vscode.ExtensionContext, watcher: SessionWatcher): void {
  const emitter = new vscode.EventEmitter<void>();
  let roots: Node[] = [];
  let seq = 0;

  const provider: vscode.TreeDataProvider<Node> = {
    onDidChangeTreeData: emitter.event,
    getTreeItem: (n) => n,
    getChildren: async (n) => {
      if (n) return n.children;
      const my = ++seq;
      try {
        const built = await buildRoots(ctx, watcher);
        if (my === seq) roots = built;
      } catch (e) {
        if (my === seq) roots = [leaf('Panel failed', 'error', undefined, String(e))];
      }
      return roots;
    },
  };

  refreshFn = () => emitter.fire();
  const fire = () => {
    try { emitter.fire(); } catch { /* ignore */ }
  };

  ctx.subscriptions.push(
    emitter,
    { dispose: () => { refreshFn = () => {}; } },
    vscode.window.createTreeView('puddibox.panel', { treeDataProvider: provider }),
    watcher.onDidChange(fire),
    onDidRefreshStatus(fire),
    vscode.window.onDidChangeActiveTextEditor(fire),
    vscode.workspace.onDidChangeWorkspaceFolders(fire),
    vscode.workspace.registerTextDocumentContentProvider(REVIEW_SCHEME, { provideTextDocumentContent: () => reviewText() }),
    vscode.commands.registerCommand('puddibox.showLastReview', async () => {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(`${REVIEW_SCHEME}:/Last review.txt?${Date.now()}`));
      await vscode.window.showTextDocument(doc, { preview: true });
    }),
    vscode.commands.registerCommand('puddibox.openReviewChange', (full: unknown, change: unknown) => openReviewChange(full, change)),
    vscode.commands.registerCommand('puddibox.removeVolume', async (node?: VolumeNode) => {
      try {
        await removeVolume(node, watcher);
      } catch (e) {
        void vscode.window.showErrorMessage(`puddibox: ${String(e)}`);
      }
    })
  );
}

const REVIEW_SCHEME = 'puddibox-review';

/** Full report as plain text (read-only document). File names come from the agent; plain text only. */
function reviewText(): string {
  const s = shownReview;
  if (!s) return 'No review yet for this project.\n';
  const mark = { added: '+ added  ', removed: '- removed', changed: '~ changed' } as const;
  const lines = [
    `Last review: ${s.project}`,
    `Time:        ${reviewWhen(s.review)}`,
    `Kind:        ${s.review.kind === 'leftover' ? 'leftover (a previous session ended without a review; includes your own edits)' : `end of session (exit code ${s.review.exitCode})`}`,
    `Changes:     ${s.changes.length}`,
    '',
  ];
  for (const c of s.changes) lines.push(`${mark[c.change]}  ${c.path}${c.detail ? `  ${c.detail}` : ''}`);
  if (s.changes.length) {
    lines.push('', 'Check each file in the VS Code diff. A nested .git, a .pth or .pyc file, an executable',
      'or a link is suspicious. Do not run tests, uv sync or scripts on Windows before that.');
  } else {
    lines.push('No changes to files that Windows executes or trusts.');
  }
  return lines.join('\n') + '\n';
}

/** "changed": diff against git HEAD through the built-in git extension; otherwise, or on failure, open the file. */
async function openReviewChange(full: unknown, change: unknown): Promise<void> {
  if (typeof full !== 'string' || !shownReview || !changePath(shownReview.project, path.relative(shownReview.project, full))) return;
  const uri = vscode.Uri.file(full);
  if (change === 'changed') {
    try {
      await vscode.commands.executeCommand('git.openChange', uri);
      return;
    } catch { /* no git repository or no change against HEAD */ }
  }
  try {
    await vscode.commands.executeCommand('vscode.open', uri);
  } catch (e) {
    void vscode.window.showErrorMessage(`puddibox: cannot open ${full}: ${String(e)}`);
  }
}

async function removeVolume(node: VolumeNode | undefined, watcher: SessionWatcher): Promise<void> {
  const project = currentProjectPath();
  if (!node || !(node instanceof VolumeNode) || !project) return;
  await watcher.refresh();
  const st = await getProjectStatus(project, true);
  if (!st) {
    void vscode.window.showErrorMessage('puddibox: could not read project status.');
    return;
  }
  if (st.volumes[node.kind] !== node.volumeName) {
    void vscode.window.showErrorMessage('puddibox: the volume does not belong to this project.');
    return;
  }
  if (watcher.sessions.some((s) => s.running && s.id === st.id)) {
    void vscode.window.showWarningMessage('puddibox: stop the running session of this project first.');
    refreshTree();
    return;
  }
  const ok = await vscode.window.showWarningMessage(
    `Remove volume ${node.volumeName}?`,
    { modal: true, detail: `This deletes ${VOLUME_LOSS[node.kind]}. It cannot be undone.` },
    'Remove'
  );
  if (ok !== 'Remove') return;
  const r = await runWslc(['volume', 'rm', node.volumeName], { timeoutMs: 30000 });
  if (r.code !== 0) {
    void vscode.window.showErrorMessage(`puddibox: wslc volume rm failed: ${(r.stderr || r.stdout).trim()}`);
  }
  refreshTree();
}
