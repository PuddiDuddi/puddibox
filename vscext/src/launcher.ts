import { execFile } from 'child_process';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { ProjectStatus } from './types';

/** Path to claude-box.ps1 from user settings, or %USERPROFILE%\puddibox\claude-box.ps1. */
export function launcherPath(): string {
  const p = vscode.workspace.getConfiguration('puddibox').get<string>('launcherPath');
  return p && p.trim() ? p.trim() : path.join(os.homedir(), 'puddibox', 'claude-box.ps1');
}

/** Folder of the active editor, else the first workspace folder. Local folders only. */
export function currentProjectPath(): string | undefined {
  const uri = vscode.window.activeTextEditor?.document.uri;
  const folder = (uri && vscode.workspace.getWorkspaceFolder(uri)) ?? vscode.workspace.workspaceFolders?.[0];
  return folder && folder.uri.scheme === 'file' ? folder.uri.fsPath : undefined;
}

const STATUS_TTL_MS = 30_000;
const cache = new Map<string, { at: number; value: ProjectStatus | null; error?: string }>();

/** Why the last status read for this project failed, for display. */
export function statusError(projectPath: string): string | undefined {
  return cache.get(projectPath.toLowerCase())?.error;
}
const statusEmitter = new vscode.EventEmitter<string>();
/** Fires with the project path after a forced status read. Listeners must not force again. */
export const onDidRefreshStatus = statusEmitter.event;

function isStatus(o: unknown): o is ProjectStatus {
  const s = o as ProjectStatus;
  return !!s && s.schema === 1 && typeof s.id === 'string' && typeof s.project === 'string'
    && !!s.containers && typeof s.containers.agent === 'string'
    && !!s.volumes && typeof s.volumes.config === 'string'
    && typeof s.tokenStored === 'boolean' && typeof s.reviewPending === 'boolean';
}

/** Runs `claude-box.ps1 -Path <p> -Status -Json`. Cached for 30 s; null on any failure. */
export function getProjectStatus(projectPath: string, force = false): Promise<ProjectStatus | null> {
  const key = projectPath.toLowerCase();
  const hit = cache.get(key);
  if (!force && hit && Date.now() - hit.at < STATUS_TTL_MS) return Promise.resolve(hit.value);
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', launcherPath(),
        '-Path', projectPath, '-Status', '-Json'],
      { shell: false, windowsHide: true, timeout: 20000 },
      (err, stdout, stderr) => {
        let value: ProjectStatus | null = null;
        let error: string | undefined;
        if (!err) {
          try {
            const o = JSON.parse(String(stdout).trim());
            if (isStatus(o)) value = o;
          } catch { /* invalid output */ }
          if (!value) error = 'The launcher printed no valid -Status -Json output. It may be an older version.';
        } else {
          const first = String(stderr).split(/\r?\n/).map((l) => l.trim()).find(Boolean);
          error = (first || err.message).slice(0, 300);
          if (/parameter name 'Status'/.test(error)) error = `This launcher is too old (no -Status): ${error}`;
        }
        cache.set(key, { at: Date.now(), value, error });
        resolve(value);
        if (force) statusEmitter.fire(projectPath);
      }
    );
  });
}
