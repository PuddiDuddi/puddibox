import { runWslc } from '../wslc';
import { SessionInfo, UsageSnapshot, UsageWindow } from '../types';

// With --timestamps: "2026-10-23T18:34:41.455166708Z api-proxy: usage {...}". The proxy repeats
// the line at least every 5 min while requests run, so the timestamp is the age of the value.
const LINE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z) api-proxy: usage (\{.*\})$/;
const WORD = /^[a-z_]{1,32}$/;

function parseWindow(v: unknown): UsageWindow | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  const u = o.utilization;
  const r = o.resets_at;
  if (typeof u !== 'number' || !Number.isFinite(u) || u < 0 || u > 10) return undefined;
  if (typeof r !== 'number' || !Number.isInteger(r) || r <= 0 || r >= 2 ** 33) return undefined;
  return { utilization: u, resetsAt: r };
}

/** Strict parse of the JSON after "api-proxy: usage ". Container output is untrusted. */
export function parseUsageJson(text: string, observedAt: number): UsageSnapshot | undefined {
  let o: unknown;
  try {
    o = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return undefined;
  const rec = o as Record<string, unknown>;
  const fiveHour = parseWindow(rec.five_hour);
  const sevenDay = parseWindow(rec.seven_day);
  if (!fiveHour && !sevenDay) return undefined;
  const snap: UsageSnapshot = { observedAt, source: 'api-proxy' };
  if (fiveHour) snap.fiveHour = fiveHour;
  if (sevenDay) snap.sevenDay = sevenDay;
  if (typeof rec.status === 'string' && WORD.test(rec.status)) snap.status = rec.status;
  return snap;
}

export function lastUsageLine(output: string): UsageSnapshot | undefined {
  let found: RegExpExecArray | undefined;
  for (const line of output.split(/\r?\n/)) {
    const m = LINE.exec(line.trim());
    if (m) found = m;
  }
  if (!found) return undefined;
  // A clock in the future would make old data look live; never trust a time ahead of now.
  const at = Date.parse(found[1]);
  if (!Number.isFinite(at)) return undefined;
  return parseUsageJson(found[2], Math.min(at, Date.now()));
}

/** 'no-session': no running token-mode sandbox; 'no-line': it runs, but its proxy logged no usage yet. */
export type ProxyState = 'no-session' | 'no-line' | 'ok';

export async function readProxyUsage(sessions: readonly SessionInfo[]): Promise<{ state: ProxyState; snapshot?: UsageSnapshot }> {
  const targets = sessions.filter((s) => s.running && s.auth === 'token' && s.apiContainer);
  if (!targets.length) return { state: 'no-session' };
  const snapshot = await newestUsage(targets);
  return snapshot ? { state: 'ok', snapshot } : { state: 'no-line' };
}

/** Newest usage line from the given sessions' API proxies. Never throws. */
async function newestUsage(targets: readonly SessionInfo[]): Promise<UsageSnapshot | undefined> {
  const results = await Promise.all(
    targets.map(async (s) => {
      try {
        const r = await runWslc(['logs', '--timestamps', '--tail', '500', s.apiContainer as string]);
        return lastUsageLine(`${r.stdout}\n${r.stderr}`);
      } catch {
        return undefined;
      }
    })
  );
  let best: UsageSnapshot | undefined;
  for (const snap of results) {
    if (!snap) continue;
    if (!best || snap.observedAt > best.observedAt) best = snap;
  }
  return best;
}
