import * as vscode from 'vscode';

export type SessionMode = 'claude' | 'bypass' | 'shell';
export type AuthMode = 'token' | 'login';
export type ContainerRole = 'agent' | 'api' | 'egress';

/** Output of `claude-box.ps1 -Path <p> -Status -Json` (schema 1). */
export interface ProjectStatus {
  schema: 1;
  project: string;
  id: string;
  containers: { agent: string; apiProxy: string; egressProxy: string };
  network: string;
  volumes: { config: string; venv: string; uvCache: string };
  tokenStored: boolean;
  reviewPending: boolean;
  images: { agent: string; egressProxy: string; apiProxy: string };
  /** Last finished review, from %USERPROFILE%\puddibox\state\<id>.last-review.json. */
  lastReview?: LastReview | null;
}

export interface ReviewChange {
  change: 'added' | 'removed' | 'changed';
  /** Relative to the project, "/" separated. Written by the launcher, names come from the agent. */
  path: string;
  detail: string;
}

export interface LastReview {
  schema: 1;
  /** ISO time (UTC). */
  at: string;
  /** "session": at the end of a session; "leftover": at the start, for a session killed earlier. */
  kind: 'session' | 'leftover';
  exitCode: number;
  changes: ReviewChange[];
}

/** One line of `wslc container list --format json`, only the fields we use. */
export interface WslcContainer {
  ID: string;
  Names: string;
  Image: string;
  State: string;
  Status: string;
  CreatedAt: string;
  Networks: string;
  Command: string;
  Labels: string;
}

/** One sandbox (agent container plus its proxies), running or not. */
export interface SessionInfo {
  id: string;
  mode: SessionMode;
  auth: AuthMode;
  /** Host path of /workspace, if wslc reports it. Display only, not trusted for decisions. */
  projectPath?: string;
  startedAt?: Date;
  agentContainer: string;
  apiContainer?: string;
  egressContainer?: string;
  running: boolean;
}

export interface SessionWatcher extends vscode.Disposable {
  readonly sessions: readonly SessionInfo[];
  readonly onDidChange: vscode.Event<readonly SessionInfo[]>;
  refresh(): Promise<void>;
}

export interface UsageWindow {
  /** Fraction 0..1. */
  utilization: number;
  /** Unix time in seconds. */
  resetsAt: number;
}

export type UsageSource = 'api-proxy' | 'windows-login';

export interface UsageSnapshot {
  fiveHour?: UsageWindow;
  sevenDay?: UsageWindow;
  status?: string;
  /** Unix time in milliseconds when the extension read the value. */
  observedAt: number;
  source: UsageSource;
}
