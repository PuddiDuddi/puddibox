import { execFile } from 'child_process';
import * as vscode from 'vscode';
import { WslcContainer } from './types';

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function wslcPath(): string {
  return vscode.workspace.getConfiguration('puddibox').get<string>('wslcPath') || 'wslc';
}

/** Runs wslc without a shell. Never rejects: a failure gives a non-zero code. */
export function runWslc(args: string[], opts: { timeoutMs?: number } = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(
      wslcPath(),
      args,
      { shell: false, windowsHide: true, timeout: opts.timeoutMs ?? 15000, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const code = err ? (typeof (err as NodeJS.ErrnoException).code === 'number' ? Number((err as NodeJS.ErrnoException).code) : 1) : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      }
    );
  });
}

/** All containers (running and stopped). Null when wslc fails. */
export async function listContainers(): Promise<WslcContainer[] | null> {
  const r = await runWslc(['container', 'list', '--all', '--no-trunc', '--format', 'json']);
  if (r.code !== 0) return null;
  const out: WslcContainer[] = [];
  for (const line of r.stdout.split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try {
      const o = JSON.parse(t);
      if (o && typeof o.Names === 'string') {
        out.push({
          ID: String(o.ID ?? ''), Names: o.Names, Image: String(o.Image ?? ''),
          State: String(o.State ?? ''), Status: String(o.Status ?? ''), CreatedAt: String(o.CreatedAt ?? ''),
          Networks: String(o.Networks ?? ''), Command: String(o.Command ?? ''), Labels: String(o.Labels ?? ''),
        });
      }
    } catch { /* skip a malformed line */ }
  }
  return out;
}

/**
 * Reads the puddibox.* labels from the Labels field ("k=v,k2=v2,..."). Other labels can hold
 * commas inside JSON, so only keys that start with "puddibox." and simple values count.
 */
export function parseLabels(labels: string): Record<string, string> {
  const res: Record<string, string> = {};
  const re = /(?:^|,)puddibox\.([a-z]+)=([A-Za-z0-9_.-]*)(?=,|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(labels)) !== null) res[m[1]] = m[2];
  return res;
}
