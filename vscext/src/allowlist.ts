import * as vscode from 'vscode';

// Extra egress domains per project, kept in the extension's globalState (not in the project,
// which the agent can write). The launcher gets them as -AllowDomain.
const KEY = 'puddibox.allowlist';

/** Same rule as the egress proxy: a host name or ".suffix", no IP, no port, no scheme. */
export const DOMAIN_RE = /^\.?(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export function getExtraDomains(ctx: vscode.ExtensionContext, projectPath: string): string[] {
  const all = ctx.globalState.get<Record<string, string[]>>(KEY, {});
  return (all[projectPath.toLowerCase()] ?? []).filter((d) => DOMAIN_RE.test(d));
}

export async function setExtraDomains(ctx: vscode.ExtensionContext, projectPath: string, domains: string[]): Promise<void> {
  const all = { ...ctx.globalState.get<Record<string, string[]>>(KEY, {}) };
  const clean = [...new Set(domains.map((d) => d.trim().toLowerCase()).filter((d) => DOMAIN_RE.test(d)))];
  if (clean.length) all[projectPath.toLowerCase()] = clean;
  else delete all[projectPath.toLowerCase()];
  await ctx.globalState.update(KEY, all);
}
