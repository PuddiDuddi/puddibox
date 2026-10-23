import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { launcherPath } from './launcher';

const PS_BASE = ['-NoProfile', '-ExecutionPolicy', 'Bypass'];

function useWindowsTerminal(): boolean {
  return vscode.workspace.getConfiguration('puddibox').get<string>('terminal') !== 'integrated';
}

export function buildScriptPath(): string {
  return path.join(path.dirname(launcherPath()), 'Build-ClaudeSandbox.ps1');
}

async function ensureExists(file: string, what: string): Promise<boolean> {
  if (fs.existsSync(file)) return true;
  const open = 'Open Settings';
  const pick = await vscode.window.showErrorMessage(`puddibox: ${what} not found: ${file}`, open);
  if (pick === open) {
    await vscode.commands.executeCommand('workbench.action.openSettings', 'puddibox.launcherPath');
  }
  return false;
}

function launch(psArgs: string[], title: string, pause: boolean): void {
  if (useWindowsTerminal()) {
    // wt.exe reads ';' in argv as a command separator.
    if (psArgs.some((a) => a.includes(';')) || title.includes(';')) {
      void vscode.window.showErrorMessage('puddibox: paths and arguments containing ";" are not supported.');
      return;
    }
    const child = spawn('wt.exe', ['-w', 'new', '--title', title, 'powershell.exe', ...psArgs, ...(pause ? ['-Pause'] : [])], {
      shell: false, detached: true, stdio: 'ignore', windowsHide: false,
    });
    child.on('error', (e) => {
      void vscode.window.showErrorMessage(`puddibox: cannot start wt.exe: ${e.message}`);
    });
    child.unref();
    return;
  }
  const term = vscode.window.createTerminal({ name: title, shellPath: 'powershell.exe', shellArgs: psArgs });
  term.show();
}

/** Runs claude-box.ps1 with args in a new Windows Terminal window or the VS Code terminal. */
export async function runLauncher(args: string[], title: string): Promise<void> {
  const launcher = launcherPath();
  if (!(await ensureExists(launcher, 'launcher'))) return;
  launch([...PS_BASE, '-File', launcher, ...args], title, true);
}

/** Runs another script from the puddibox folder (Build-ClaudeSandbox.ps1). It has no -Pause. */
export async function runScriptInTerminal(scriptPath: string, args: string[], title: string): Promise<void> {
  if (!(await ensureExists(launcherPath(), 'launcher'))) return;
  if (!(await ensureExists(scriptPath, 'script'))) return;
  const noExit = useWindowsTerminal() ? ['-NoExit'] : [];
  launch([...PS_BASE, ...noExit, '-File', scriptPath, ...args], title, false);
}
