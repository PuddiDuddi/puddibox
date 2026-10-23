# puddibox VS Code extension

The extension shows the puddibox sandbox sessions and the subscription usage in the status bar, and
adds a sidebar panel for the project. It starts and stops sessions through `claude-box.ps1`.

## Install

Requirements: Node.js 20 or later (only to build the package), and the puddibox kit in
`%USERPROFILE%\puddibox` (see the main README).

```powershell
cd $env:USERPROFILE\puddibox\vscext
npm install
npm run compile
npm run package
code --install-extension (Get-ChildItem puddibox-*.vsix | Select-Object -Last 1).FullName
```

Then run **Developer: Reload Window**.

- If the kit is in another folder, set `puddibox.launcherPath` in your user settings.
- Remove the task shortcuts for `ctrl+alt+c` and `ctrl+alt+shift+c` from your `keybindings.json`.
  User shortcuts override the shortcuts of the extension.

## Status bar

Left side, for the project of the active editor:

| Item | Meaning |
|---|---|
| `$(vm-outline) sandbox` | no session for this project |
| `$(vm-running) sandbox` | Claude Code runs in the sandbox |
| `$(warning) sandbox: bypass` | Claude Code with `--dangerously-skip-permissions` (warning background) |
| `$(terminal) sandbox: shell` | bash in the sandbox |
| `$(report)` | the last session ended without a review; the launcher shows it at the next start |
| `+N` | N sandboxes of other projects run |
| `sandbox ?` | the launcher did not answer `-Status`; the tooltip shows why |

Click the item for a menu: start, start with bypass, shell, stop, all sessions.

Right side:

| Item | Meaning |
|---|---|
| `$(vm-active) N` | number of running sandboxes (all projects); click for the list |
| `$(zap) ███░░░░░ 34%` | 5-hour usage window, data from the last 10 minutes |
| `$(claude) █░░░░░░░ 12%` | 7-day usage window |
| `$(account)` at the end | the data comes from the Windows Claude Code login, not from the sandbox |
| `$(history) 34% · 40 min` | historical data and its age |
| `$(history) reset` | the window has reset since the last read |
| `$(circle-slash) usage` | no data |

### Usage sources

1. **Sandbox (default).** In token mode, `api-proxy` reads the `anthropic-ratelimit-unified-*`
   response headers and writes `api-proxy: usage {...}` to its log. The extension reads the log every
   60 seconds while a session runs. The token never leaves `api-proxy`. These header names come from
   community reports, not from official documentation, so they can change.
2. **Windows login (on request).** Without fresh sandbox data, a click on the usage item (or the link
   in its tooltip) reads usage one time from `api/oauth/usage` with the token in
   `~/.claude/.credentials.json`. That is a second, full-scope token in a plain file, so the extension
   reads it only after your click, never in the background. After HTTP 429 it waits for `retry-after`.
3. **Last value.** The extension keeps the last value and shows it as historical data.

The token from `claude setup-token` does not work with `api/oauth/usage` (HTTP 403,
`oauth_scope_insufficient`: the token has no `user:profile` scope). The tooltip shows the state of the
sandbox source, so you can see why the data comes from the Windows login.

## Sidebar panel

The puddibox icon in the activity bar opens the panel for the current project:

- **Sessions**: running sessions and their containers. **Stop** sends SIGTERM and waits 10 s;
  **Kill now** sends SIGKILL at once. In both cases the launcher window cleans up and shows the review.
- **Project**: the project id and its volumes. You can remove a volume only when no session runs.
- **Token**: stored or not stored, with buttons for `-SetToken` and `-RemoveToken` (in a terminal;
  the extension never sees the token).
- **Images**: the three images and their build time, with a rebuild button.
- **Egress allowlist**: the default domains and the extra domains of this project. The extra domains
  are kept in the extension storage, not in the project, and go to the launcher as `-AllowDomain`.
- **Last review**: the report of the last session. A changed file opens a diff against git `HEAD`,
  an added file opens in the editor. The `$(open-preview)` button opens the full report as a
  read-only document.

## Commands and shortcuts

- `Ctrl+Alt+C`: start Claude Code in the sandbox.
- `Ctrl+Alt+Shift+C`: start with bypass permissions (after a confirmation).
- Command Palette, category `puddibox`: shell, stop, all sessions, token, rebuild images,
  extra domains, last review.

## Settings

All settings have the `application` scope. A project `.vscode/settings.json` cannot change them.

| Setting | Default | |
|---|---|---|
| `puddibox.launcherPath` | `%USERPROFILE%\puddibox\claude-box.ps1` | keep it outside every sandboxed project |
| `puddibox.wslcPath` | `wslc` | |
| `puddibox.terminal` | `windowsTerminal` | or `integrated` (VS Code terminal) |
| `puddibox.pollIntervalSeconds` | `30` | fallback refresh in addition to `wslc events` |
| `puddibox.usage.enabled` | `true` | |

## Security

- The extension reads no settings and no files from the workspace.
- The extension does not touch the `setup-token` token.
- Processes start without a shell. Logs and names from containers are parsed strictly; tooltips allow
  only the usage refresh command.
- If `puddibox.launcherPath` is inside a project folder with a running sandbox, the start shows a
  warning: the agent could change the launcher that runs with your rights.
