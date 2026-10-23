import { spawn, ChildProcess } from 'child_process';
import * as vscode from 'vscode';
import { AuthMode, ContainerRole, SessionInfo, SessionMode, SessionWatcher, WslcContainer } from './types';
import { listContainers, parseLabels, wslcPath } from './wslc';

const ID_RE = /^[a-z0-9][a-z0-9_.-]*$/;
const NAME_PREFIX: Record<ContainerRole, string> = { agent: 'claude-', api: 'claude-api-', egress: 'claude-proxy-' };

interface Classified {
  role: ContainerRole;
  c: WslcContainer;
  labels: Record<string, string>;
}

function roleOf(c: WslcContainer, labels: Record<string, string>): ContainerRole | undefined {
  const l = labels.role;
  if (l === 'agent' || l === 'api' || l === 'egress') return l;
  // Old sessions: the image decides, never the name (a project can be called "api-foo").
  if (/(^|\/)claude-sandbox(:|@|$)/.test(c.Image)) return 'agent';
  if (/(^|\/)claude-api-proxy(:|@|$)/.test(c.Image)) return 'api';
  if (/(^|\/)claude-egress-proxy(:|@|$)/.test(c.Image)) return 'egress';
  return undefined;
}

function idOf(c: WslcContainer, role: ContainerRole, labels: Record<string, string>): string | undefined {
  if (labels.id && ID_RE.test(labels.id)) return labels.id;
  for (const n of c.Networks.split(',')) {
    if (n.startsWith('claude-int-') && ID_RE.test(n.slice(11))) return n.slice(11);
  }
  const prefix = NAME_PREFIX[role];
  if (c.Names.startsWith(prefix) && ID_RE.test(c.Names.slice(prefix.length))) return c.Names.slice(prefix.length);
  return undefined;
}

function modeOf(c: WslcContainer, labels: Record<string, string>): SessionMode {
  const l = labels.mode;
  if (l === 'claude' || l === 'bypass' || l === 'shell') return l;
  if (/ bash"?$/.test(c.Command.trim())) return 'shell';
  if (c.Command.includes('--dangerously-skip-permissions')) return 'bypass';
  return 'claude';
}

/** "2026-10-23 20:19:02 +0200 GMT+2" -> Date, or undefined. */
function parseCreatedAt(s: string): Date | undefined {
  const t = s.replace(/\s+GMT.*$/, '').replace(/^(\S+) (\S+) ([+-]\d{2})(\d{2})$/, '$1T$2$3:$4');
  const d = new Date(t);
  return isNaN(d.getTime()) ? undefined : d;
}

/** HostPath of the /workspace volume from the wslc metadata label. Display only. */
function hostPathOf(labels: string): string | undefined {
  const m = /"ContainerPath":"\/workspace","CreateSourceIfMissing":(?:true|false),"HostPath":"((?:[^"\\]|\\.)*)"/.exec(labels);
  if (!m) return undefined;
  try {
    const p: unknown = JSON.parse(`"${m[1]}"`);
    return typeof p === 'string' && p.length < 1024 ? p : undefined;
  } catch {
    return undefined;
  }
}

export function groupSessions(containers: readonly WslcContainer[]): SessionInfo[] {
  const byId = new Map<string, Classified[]>();
  for (const c of containers) {
    const labels = parseLabels(c.Labels);
    const role = roleOf(c, labels);
    if (!role) continue;
    const id = idOf(c, role, labels);
    if (!id) continue;
    const list = byId.get(id) ?? [];
    list.push({ role, c, labels });
    byId.set(id, list);
  }
  const out: SessionInfo[] = [];
  for (const [id, list] of byId) {
    const agent = list.find((x) => x.role === 'agent');
    if (!agent) continue;
    const api = list.find((x) => x.role === 'api');
    const egress = list.find((x) => x.role === 'egress');
    const auth: AuthMode = agent.labels.auth === 'token' || agent.labels.auth === 'login'
      ? agent.labels.auth : api ? 'token' : 'login';
    out.push({
      id,
      mode: modeOf(agent.c, agent.labels),
      auth,
      projectPath: hostPathOf(agent.c.Labels),
      startedAt: parseCreatedAt(agent.c.CreatedAt),
      agentContainer: agent.c.Names,
      apiContainer: api?.c.Names,
      egressContainer: egress?.c.Names,
      running: agent.c.State === 'running',
    });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

function keyOf(sessions: readonly SessionInfo[]): string {
  return JSON.stringify(sessions.map((s) => ({ ...s, startedAt: s.startedAt?.getTime() })));
}

export function createSessionWatcher(ctx: vscode.ExtensionContext): SessionWatcher {
  const emitter = new vscode.EventEmitter<readonly SessionInfo[]>();
  let sessions: readonly SessionInfo[] = [];
  let key = keyOf(sessions);
  let disposed = false;
  let inFlight: Promise<void> | undefined;
  let again = false;
  let pollTimer: NodeJS.Timeout | undefined;
  let debounceTimer: NodeJS.Timeout | undefined;
  let restartTimer: NodeJS.Timeout | undefined;
  let proc: ChildProcess | undefined;
  let restartMs = 5000;

  async function doRefresh(): Promise<void> {
    try {
      const containers = await listContainers();
      if (disposed || !containers) return; // keep the last list when wslc fails
      const next = groupSessions(containers);
      const nextKey = keyOf(next);
      if (nextKey === key) return;
      sessions = next;
      key = nextKey;
      emitter.fire(sessions);
    } catch { /* never throw from timers */ }
  }

  function refresh(): Promise<void> {
    if (inFlight) {
      again = true;
      return inFlight;
    }
    inFlight = (async () => {
      do {
        again = false;
        await doRefresh();
      } while (again && !disposed);
    })().finally(() => { inFlight = undefined; });
    return inFlight;
  }

  function pollMs(): number {
    const s = vscode.workspace.getConfiguration('puddibox').get<number>('pollIntervalSeconds');
    return Math.max(5, typeof s === 'number' && isFinite(s) ? s : 30) * 1000;
  }

  function schedulePoll(): void {
    if (pollTimer) clearTimeout(pollTimer);
    if (disposed) return;
    pollTimer = setTimeout(() => {
      void refresh().finally(schedulePoll);
    }, pollMs());
  }

  function startEvents(): void {
    if (disposed) return;
    let child: ChildProcess;
    try {
      child = spawn(wslcPath(), ['events', '--format', 'json'], {
        shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      restartTimer = setTimeout(startEvents, restartMs);
      restartMs = Math.min(restartMs * 2, 60000);
      return;
    }
    proc = child;
    const startedAt = Date.now();
    child.stdout?.on('data', () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => { void refresh(); }, 500);
    });
    let done = false;
    const onEnd = (): void => {
      if (done) return;
      done = true;
      if (proc === child) proc = undefined;
      // A process that dies at once (no events support, wslc missing) backs off up to 60 s.
      restartMs = Date.now() - startedAt > 30000 ? 5000 : Math.min(restartMs * 2, 60000);
      if (!disposed) restartTimer = setTimeout(startEvents, restartMs);
    };
    child.on('error', onEnd);
    child.on('close', onEnd);
  }

  const cfg = vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration('puddibox.pollIntervalSeconds')) schedulePoll();
  });

  startEvents();
  schedulePoll();
  void refresh();

  const watcher: SessionWatcher = {
    get sessions() { return sessions; },
    onDidChange: emitter.event,
    refresh,
    dispose() {
      disposed = true;
      if (pollTimer) clearTimeout(pollTimer);
      if (debounceTimer) clearTimeout(debounceTimer);
      if (restartTimer) clearTimeout(restartTimer);
      try { proc?.kill(); } catch { /* already gone */ }
      cfg.dispose();
      emitter.dispose();
    },
  };
  ctx.subscriptions.push(watcher);
  return watcher;
}
