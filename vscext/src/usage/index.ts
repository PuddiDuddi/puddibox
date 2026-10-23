import * as vscode from 'vscode';
import { SessionWatcher, UsageSnapshot } from '../types';
import { FRESH_MS, renderItems } from './display';
import { LoginError, fetchLoginUsage } from './login';
import { ProxyState, readProxyUsage } from './proxy';

const STORE_KEY = 'puddibox.usage.last';
const TICK_MS = 60 * 1000;
const RETRY_AFTER_MAX_MS = 6 * 60 * 60 * 1000;

function isWindow(v: unknown): boolean {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return typeof o.utilization === 'number' && Number.isFinite(o.utilization) && typeof o.resetsAt === 'number' && Number.isFinite(o.resetsAt);
}

function loadStored(ctx: vscode.ExtensionContext): UsageSnapshot | undefined {
  const v = ctx.globalState.get<UsageSnapshot>(STORE_KEY);
  if (!v || typeof v !== 'object' || typeof v.observedAt !== 'number') return undefined;
  if (v.source !== 'api-proxy' && v.source !== 'windows-login') return undefined;
  if ((v.fiveHour && !isWindow(v.fiveHour)) || (v.sevenDay && !isWindow(v.sevenDay))) return undefined;
  return v;
}

export function registerUsage(ctx: vscode.ExtensionContext, watcher: SessionWatcher): void {
  const items: [vscode.StatusBarItem, vscode.StatusBarItem] = [
    vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 200),
    vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 199),
  ];
  items.forEach((i) => (i.command = 'puddibox.usage.refresh'));

  let last = loadStored(ctx);
  let loginError: LoginError | undefined;
  let retryAfterAt = 0;
  let proxyState: ProxyState = 'no-session';
  let busy = false;

  const cfg = (): vscode.WorkspaceConfiguration => vscode.workspace.getConfiguration('puddibox.usage');
  const tokenSessionRunning = (): boolean => watcher.sessions.some((s) => s.running && s.auth === 'token' && s.apiContainer);

  function render(): void {
    try {
      if (!cfg().get<boolean>('enabled', true)) {
        items.forEach((i) => i.hide());
        return;
      }
      const fresh = !!last && Date.now() - last.observedAt < FRESH_MS;
      const live = !!last && fresh && (last.source === 'windows-login' || tokenSessionRunning());
      const wait = Math.ceil((retryAfterAt - Date.now()) / 1000);
      renderItems(items, { snapshot: last, live, loginError, retryInSec: wait > 0 ? wait : undefined, proxyState });
    } catch {
      /* never throw from a timer */
    }
  }

  function store(snap: UsageSnapshot): void {
    // Fresh sandbox data beats a Windows login read, even a slightly newer one.
    const proxyWins = snap.source === 'api-proxy' && last?.source === 'windows-login' && Date.now() - snap.observedAt < FRESH_MS;
    if (last && snap.observedAt < last.observedAt && !proxyWins) return;
    last = snap;
    void ctx.globalState.update(STORE_KEY, snap);
  }

  async function refresh(manual: boolean): Promise<void> {
    if (busy || !cfg().get<boolean>('enabled', true)) return;
    busy = true;
    try {
      const proxy = await readProxyUsage(watcher.sessions);
      proxyState = proxy.state;
      if (proxy.snapshot) store(proxy.snapshot);
      const liveC = !!last && last.source === 'api-proxy' && Date.now() - last.observedAt < FRESH_MS && tokenSessionRunning();
      // Fallback to the Windows login: only on a click, and only without live api-proxy data.
      if (manual && !liveC && Date.now() >= retryAfterAt) {
        const r = await fetchLoginUsage();
        if (r.ok) {
          loginError = undefined;
          store(r.snapshot);
        } else {
          loginError = r.error;
          if (r.error === 'rate-limited') {
            retryAfterAt = Date.now() + Math.min((r.retryAfterSec ?? 300) * 1000, RETRY_AFTER_MAX_MS);
          }
        }
      }
    } catch {
      /* keep the last value */
    } finally {
      busy = false;
      render();
    }
  }

  const timer = setInterval(() => {
    void refresh(false);
    render();
  }, TICK_MS);
  ctx.subscriptions.push(
    ...items,
    { dispose: () => clearInterval(timer) },
    watcher.onDidChange(() => {
      render();
      void refresh(false);
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('puddibox.usage')) return;
      render();
      void refresh(false);
    }),
    vscode.commands.registerCommand('puddibox.usage.refresh', () => refresh(true))
  );

  render();
  void refresh(false);
}
