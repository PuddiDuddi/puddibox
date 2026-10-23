import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { UsageSnapshot, UsageWindow } from '../types';

const CREDS_PATH = path.join(os.homedir(), '.claude', '.credentials.json');
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const TOKEN_CHARS = /^[A-Za-z0-9._~+/=-]{8,4096}$/;

export type LoginError = 'no-credentials' | 'unauthorized' | 'rate-limited' | 'network';

export type LoginResult =
  | { ok: true; snapshot: UsageSnapshot }
  | { ok: false; error: LoginError; retryAfterSec?: number };

interface CurlResult {
  status: number;
  retryAfterSec?: number;
  body: string;
}

function toWindow(v: unknown): UsageWindow | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  const pct = o.utilization;
  const at = typeof o.resets_at === 'string' ? Date.parse(o.resets_at) : NaN;
  if (typeof pct !== 'number' || !Number.isFinite(pct) || pct < 0 || pct > 1000) return undefined;
  if (!Number.isFinite(at)) return undefined;
  const resetsAt = Math.round(at / 1000);
  if (resetsAt <= 0 || resetsAt >= 2 ** 33) return undefined;
  return { utilization: pct / 100, resetsAt };
}

/** The token goes to curl on stdin only, so it never shows up in argv. */
function curlUsage(token: string): Promise<CurlResult | undefined> {
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    const finish = (r: CurlResult | undefined): void => {
      if (!done) {
        done = true;
        resolve(r);
      }
    };
    try {
      const child = spawn(
        process.platform === 'win32' ? 'curl.exe' : 'curl',
        ['--config', '-', '-sS', '--max-time', '15', '-D', '-', '-w', '\n__S__%{http_code}', USAGE_URL],
        { shell: false, windowsHide: true }
      );
      child.stdout.on('data', (d: Buffer) => {
        if (out.length < 1024 * 1024) out += d.toString('utf-8');
      });
      child.stderr.on('data', () => undefined);
      child.on('error', () => finish(undefined));
      child.stdin.on('error', () => undefined);
      child.on('close', () => {
        const m = /^([\s\S]*)\n__S__(\d{3})$/.exec(out);
        if (!m) return finish(undefined);
        let rest = m[1];
        let retryAfterSec: number | undefined;
        while (rest.startsWith('HTTP/')) {
          const end = rest.indexOf('\r\n\r\n');
          const head = end < 0 ? rest : rest.slice(0, end);
          const ra = /^retry-after:\s*(\d{1,9})\s*$/im.exec(head);
          if (ra) retryAfterSec = Number(ra[1]);
          if (end < 0) {
            rest = '';
            break;
          }
          rest = rest.slice(end + 4);
        }
        finish({ status: Number(m[2]), retryAfterSec, body: rest });
      });
      child.stdin.end(`header = "Authorization: Bearer ${token}"\nheader = "anthropic-beta: oauth-2025-04-20"\n`);
    } catch {
      finish(undefined);
    }
  });
}

async function readToken(): Promise<string | undefined> {
  try {
    const creds = JSON.parse(await fs.promises.readFile(CREDS_PATH, 'utf-8'));
    const token = creds?.claudeAiOauth?.accessToken;
    return typeof token === 'string' && TOKEN_CHARS.test(token) ? token : undefined;
  } catch {
    return undefined;
  }
}

/** Reads usage with the Windows Claude Code login. Never throws, never exposes the token. */
export async function fetchLoginUsage(): Promise<LoginResult> {
  const token = await readToken();
  if (!token) return { ok: false, error: 'no-credentials' };
  const r = await curlUsage(token);
  if (!r) return { ok: false, error: 'network' };
  if (r.status === 401 || r.status === 403) return { ok: false, error: 'unauthorized' };
  if (r.status === 429) return { ok: false, error: 'rate-limited', retryAfterSec: r.retryAfterSec };
  if (r.status !== 200) return { ok: false, error: 'network' };
  try {
    const o = JSON.parse(r.body);
    const fiveHour = toWindow(o?.five_hour);
    const sevenDay = toWindow(o?.seven_day);
    if (!fiveHour && !sevenDay) return { ok: false, error: 'network' };
    const snapshot: UsageSnapshot = { observedAt: Date.now(), source: 'windows-login' };
    if (fiveHour) snapshot.fiveHour = fiveHour;
    if (sevenDay) snapshot.sevenDay = sevenDay;
    return { ok: true, snapshot };
  } catch {
    return { ok: false, error: 'network' };
  }
}
