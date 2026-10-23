import * as vscode from 'vscode';
import { UsageSnapshot, UsageWindow } from '../types';
import { LoginError } from './login';
import { ProxyState } from './proxy';

const PROXY_TEXT: Record<ProxyState, string> = {
  'no-session': 'Sandbox: no running session in token mode. Sandbox data appears by itself while one runs.',
  'no-line': 'Sandbox: a session runs, but its api-proxy has logged no usage yet. Send a message. An api-proxy image built before the usage change never logs it: run Rebuild sandbox images.',
  ok: 'Sandbox: api-proxy reports usage.',
};

export const FRESH_MS = 10 * 60 * 1000;

const ERROR_TEXT: Record<LoginError, string> = {
  'no-credentials': 'Windows login: ~/.claude/.credentials.json not found or has no token.',
  unauthorized: 'Windows login: token rejected (HTTP 401/403). Log in to Claude Code on Windows again.',
  'rate-limited': 'Windows login: rate limited (HTTP 429), waiting before the next call.',
  network: 'Windows login: network error or unexpected response.',
};

export function bar(pct: number, width = 8): string {
  const n = Math.round((Math.min(Math.max(pct, 0), 100) / 100) * width);
  return '█'.repeat(n) + '░'.repeat(width - n);
}

function bgColor(pct: number): vscode.ThemeColor | undefined {
  if (pct >= 90) return new vscode.ThemeColor('statusBarItem.errorBackground');
  if (pct >= 70) return new vscode.ThemeColor('statusBarItem.warningBackground');
  return undefined;
}

function fmtTimeLeft(resetsAt: number, mode: 'session' | 'weekly'): string {
  const ms = resetsAt * 1000 - Date.now();
  if (ms <= 0) return 'resets soon';
  const totalMins = Math.floor(ms / 60000);
  const hours = Math.floor(totalMins / 60);
  const mins = totalMins % 60;
  if (mode === 'session') return hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return days > 0 ? `${days}d ${remHours}h` : `${remHours}h ${mins}m`;
}

function fmtDate(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function fmtAge(ms: number): string {
  const mins = Math.max(0, Math.floor(ms / 60000));
  if (mins < 60) return `${mins} min`;
  const hours = Math.floor(mins / 60);
  return hours < 48 ? `${hours} h` : `${Math.floor(hours / 24)} d`;
}

export interface UsageView {
  snapshot?: UsageSnapshot;
  /** Fresh data from a running proxy, or a recent Windows login read. */
  live: boolean;
  loginError?: LoginError;
  /** Seconds until a Windows login read is allowed again after HTTP 429. */
  retryInSec?: number;
  proxyState: ProxyState;
}

const REFRESH_CMD = 'puddibox.usage.refresh';

interface Spec {
  key: 'fiveHour' | 'sevenDay';
  icon: string;
  label: string;
  title: string;
  mode: 'session' | 'weekly';
}

const SPECS: Spec[] = [
  { key: 'fiveHour', icon: '$(zap)', label: '', title: 'Claude 5h session', mode: 'session' },
  { key: 'sevenDay', icon: '$(claude)', label: '7d ', title: 'Claude weekly (7d)', mode: 'weekly' },
];

function tooltip(spec: Spec, w: UsageWindow | undefined, expired: boolean, v: UsageView): vscode.MarkdownString {
  const snap = v.snapshot;
  const lines: string[] = [];
  if (!snap || !w) {
    lines.push('**puddibox usage**: no data.');
    lines.push('Start a sandbox in token mode and send a message.');
  } else {
    const pct = Math.round(w.utilization * 100);
    lines.push(`**${spec.title}**: ${pct}%`);
    lines.push(
      expired
        ? 'The window has reset since this was read.'
        : `Resets in: ${fmtTimeLeft(w.resetsAt, spec.mode)} (${fmtDate(w.resetsAt * 1000)})`
    );
    const src = snap.source === 'api-proxy' ? 'api-proxy' : 'login Windows';
    lines.push(`Source: ${src}${v.live ? '' : ' (historical)'}`);
    lines.push(`Read: ${fmtDate(snap.observedAt)} (${fmtAge(Date.now() - snap.observedAt)} ago)`);
    if (snap.status) lines.push(`Status: ${snap.status}`);
  }
  if (v.loginError && !v.live) lines.push(ERROR_TEXT[v.loginError]);
  lines.push(PROXY_TEXT[v.proxyState]);
  // A click reads the Windows login only when there are no fresh sandbox data.
  if (v.live && snap?.source === 'api-proxy') {
    lines.push('*Click to refresh the sandbox data*');
  } else if (v.retryInSec) {
    lines.push(`*Windows login rate limited, next read in ${fmtAge(v.retryInSec * 1000)}.*`);
  } else {
    // Reading the Windows login token happens only on this explicit click.
    lines.push(`[Read from the Windows Claude Code login](command:${REFRESH_CMD}) (click the item)`);
  }
  const md = new vscode.MarkdownString(lines.join('\n\n'));
  // Only the refresh command may run from a link; all text in the tooltip is validated data.
  md.isTrusted = { enabledCommands: [REFRESH_CMD] };
  return md;
}

function showEmpty(item: vscode.StatusBarItem, spec: Spec, v: UsageView): void {
  item.text = '$(circle-slash) usage';
  item.tooltip = tooltip(spec, undefined, false, v);
  item.color = undefined;
  item.backgroundColor = undefined;
  item.show();
}

export function renderItems(items: [vscode.StatusBarItem, vscode.StatusBarItem], v: UsageView): void {
  const snap = v.snapshot;
  const now = Date.now();
  if (!snap || (!snap.fiveHour && !snap.sevenDay)) {
    showEmpty(items[0], SPECS[0], v);
    items[1].hide();
    return;
  }
  SPECS.forEach((spec, i) => {
    const item = items[i];
    const w = snap[spec.key];
    if (!w) {
      if (i === 0) showEmpty(item, spec, v);
      else item.hide();
      return;
    }
    const pct = Math.round(w.utilization * 100);
    const expired = now / 1000 > w.resetsAt;
    if (expired) {
      item.text = `$(history) ${spec.label}reset`;
      item.color = new vscode.ThemeColor('disabledForeground');
      item.backgroundColor = undefined;
    } else if (v.live) {
      // $(account) marks data from the Windows login; api-proxy data has no mark.
      const src = snap.source === 'windows-login' ? ' $(account)' : '';
      item.text = `${spec.icon} ${bar(pct)} ${pct}%${src}`;
      item.color = undefined;
      item.backgroundColor = bgColor(pct);
    } else {
      const src = snap.source === 'windows-login' ? ' $(account)' : '';
      item.text = `$(history) ${spec.label}${pct}% · ${fmtAge(now - snap.observedAt)}${src}`;
      item.color = new vscode.ThemeColor('disabledForeground');
      item.backgroundColor = undefined;
    }
    item.tooltip = tooltip(spec, w, expired, v);
    item.show();
  });
}
