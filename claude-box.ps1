<#
.SYNOPSIS
  Starts Claude Code for a project folder inside an isolated WSL container (wslc).

.DESCRIPTION
  - The project folder is bind-mounted at /workspace.
  - /workspace/.venv is overlaid with a per-project volume: the agent gets its own Linux venv
    and never sees or touches your Windows .venv.
  - .git, .vscode and .claude are mounted read-only (hooks, git config, VS Code tasks and
    Claude hooks run on your host, so the agent must not be able to change them).
    Without a .git folder, or with a .git file (worktree, submodule), the launcher refuses to
    start unless you pass -GitWritable.
  - Network: the agent sits on an internal network with no route out. The only exit is a squid
    proxy that allows HTTPS to an allowlist of domains. The container verifies this at startup
    and refuses to start if it is not true.
  - Claude login, settings and the uv cache are per project (no shared state between projects).
  - After the session the launcher lists every new or changed file that Windows tools execute
    or trust (a nested .git, conftest.py, pyproject.toml, .bat, links, ...). If the session was
    killed, the list is shown at the next start for the same project.

.EXAMPLE
  .\claude-box.ps1                       # current folder, normal permission prompts
  .\claude-box.ps1 -Path D:\proj\foo -Bypass
  .\claude-box.ps1 -Shell                # bash in the same sandbox instead of Claude
  .\claude-box.ps1 -AllowDomain github.com,.githubusercontent.com   # also opens an exfiltration path
  .\claude-box.ps1 -Continue             # continue the last conversation
  .\claude-box.ps1 -Resume               # pick a conversation to resume
  .\claude-box.ps1 -ClaudeArgs '--model opus --append-system-prompt "be brief"'
  .\claude-box.ps1 -ConfigVolume claude-config   # share login and settings between projects
  .\claude-box.ps1 -Pause                # wait for Enter at the end (for a separate window)
#>
[CmdletBinding()]
param(
    [string]$Path = (Get-Location).Path,
    [switch]$Bypass,
    [switch]$Shell,
    [switch]$GitWritable,
    [switch]$ClaudeDirWritable,
    [string[]]$AllowDomain = @(),
    [string]$Image = "claude-sandbox:local",
    [string]$ProxyImage = "claude-egress-proxy:local",
    [string]$ConfigVolume = "",
    [switch]$Resume,
    [switch]$Continue,
    [string]$ClaudeArgs = "",
    [switch]$Pause
)

$ErrorActionPreference = 'Stop'

# In a separate window (-Pause) keep errors and the review readable before the window closes.
trap {
    if ($Pause) {
        Write-Host "ERROR: $_" -ForegroundColor Red
        [void](Read-Host "Press Enter to close")
    }
    break
}

# Domains Claude Code needs (https://code.claude.com/docs/en/network-config) plus PyPI for uv.
# ".x" means x and all subdomains. Never list both "x" and ".x".
$DefaultDomains = @(
    'api.anthropic.com',
    '.claude.ai',            # claude.ai login, downloads.claude.ai
    '.claude.com',           # claude.com, platform.claude.com (OAuth), sso, docs
    'pypi.org',
    'files.pythonhosted.org'
)

# Files that Windows tools execute or trust. The agent can write them in /workspace; the
# launcher records them before the session and lists every difference after it.
# Matched against the path relative to the project, with '/' separators.
$ReviewPattern = '(?ix)
    (^|/)\.(git|vscode|claude|devcontainer|github)(/|$)
  | \.code-workspace$
  | (^|/)\.env[^/]*$
  | (^|/)(conftest|setup|noxfile|sitecustomize|usercustomize)\.py$
  | (^|/)(pyproject\.toml|setup\.cfg|uv\.lock|tox\.ini|mypy\.ini|\.mypy\.ini|pylintrc|\.pylintrc
         |\.pre-commit-config\.yaml|makefile|package\.json|\.npmrc|claude\.md|\.gitattributes|\.gitmodules)$
  | (^|/)requirements[^/]*\.txt$
  | \.(pth|pyc|bat|cmd|com|exe|dll|scr|msi|lnk|ps1|psm1|vbs)$
'

# Windows PowerShell 5.1 turns redirected stderr lines of a native command into errors, and
# 'Stop' then aborts the script. Helpers that redirect wslc output run with 'Continue'
# (the assignment is local to the function).
function Invoke-WslcQuiet {
    $ErrorActionPreference = 'Continue'
    & wslc @args *> $null
    return ($LASTEXITCODE -eq 0)
}

function Get-WslcOutput {
    $ErrorActionPreference = 'Continue'
    return ((& wslc @args 2>&1 | ForEach-Object { "$_" }) -join "`n")
}

function Assert-Wslc([string]$Step) {
    if ($LASTEXITCODE -ne 0) { throw "wslc failed: $Step (exit $LASTEXITCODE)" }
}

function Remove-WslcContainer([string]$Name) {
    # Best effort; errors (e.g. "no such container") are expected and ignored.
    $null = Invoke-WslcQuiet container stop $Name
    $null = Invoke-WslcQuiet container rm $Name
}

function Wait-ContainerLog([string]$Container, [string]$Pattern, [string]$FailPattern, [int]$TimeoutSec) {
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ($true) {
        $log = Get-WslcOutput container logs $Container
        if ($log -match $Pattern) { return }
        if (($log -match $FailPattern) -or ((Get-Date) -gt $deadline)) {
            Write-Host $log
            throw "$Container did not become ready"
        }
        Start-Sleep -Milliseconds 500
    }
}

# .NET instead of Get-FileHash: that cmdlet is missing when powershell.exe inherits the
# module path of pwsh (for example when VS Code or pwsh starts it).
function Get-Sha256([string]$File) {
    try {
        $stream = [IO.File]::OpenRead($File)
        try { return [BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($stream)) }
        finally { $stream.Dispose() }
    } catch {
        return 'unreadable'
    }
}

function Get-ReviewSnapshot([string]$Root) {
    $snap = @{}
    # Root-level folders that are not walked: the host venv (hidden from the agent), the
    # read-only .git (handled below) and node_modules (size).
    $prune = @('.venv', '.git', 'node_modules')
    $stack = New-Object System.Collections.Stack
    $stack.Push('')
    while ($stack.Count -gt 0) {
        $rel = $stack.Pop()
        $dir = if ($rel) { Join-Path $Root $rel } else { $Root }
        foreach ($item in @(Get-ChildItem -LiteralPath $dir -Force -ErrorAction SilentlyContinue)) {
            $r = if ($rel) { "$rel/$($item.Name)" } else { $item.Name }
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
                # Links can point outside the project on Windows; record all of them, do not follow.
                $snap[$r] = "link -> $($item.Target)"
                continue
            }
            if ($item.PSIsContainer) {
                if (-not $rel -and $prune -contains $item.Name) { continue }
                if ($r -match $ReviewPattern) { $snap[$r] = 'dir' }
                $stack.Push($r)
            } elseif ($r -match $ReviewPattern) {
                $snap[$r] = Get-Sha256 $item.FullName
            }
        }
    }
    # Root .git folder: only the parts git executes or trusts. A .git file was handled above.
    $git = Join-Path $Root '.git'
    if (Test-Path -LiteralPath $git -PathType Container) {
        foreach ($sub in @('config', 'commondir', 'hooks', 'info')) {
            $p = Join-Path $git $sub
            if (Test-Path -LiteralPath $p -PathType Leaf) {
                $snap[".git/$sub"] = Get-Sha256 $p
                continue
            }
            foreach ($f in @(Get-ChildItem -LiteralPath $p -File -Force -ErrorAction SilentlyContinue)) {
                $snap[".git/$sub/$($f.Name)"] = Get-Sha256 $f.FullName
            }
        }
    }
    return $snap
}

function Read-ReviewSnapshot([string]$File) {
    $snap = @{}
    $obj = Get-Content -LiteralPath $File -Raw | ConvertFrom-Json
    foreach ($p in $obj.PSObject.Properties) { $snap[$p.Name] = [string]$p.Value }
    return $snap
}

function Show-ReviewReport([hashtable]$Before, [hashtable]$After, [string]$Title) {
    $lines = foreach ($k in (@($Before.Keys) + @($After.Keys) | Sort-Object -Unique)) {
        if (-not $Before.ContainsKey($k))     { ("  + added    $k  " + $(if ($After[$k] -like 'link*') { $After[$k] })).TrimEnd() }
        elseif (-not $After.ContainsKey($k))  { "  - removed  $k" }
        elseif ($Before[$k] -ne $After[$k])   { "  ~ changed  $k" }
    }
    if (-not $lines) {
        Write-Host "Review: no changes to files that the host executes or trusts."
        return
    }
    Write-Host ""
    Write-Host "=== REVIEW BEFORE YOU RUN ANYTHING ON WINDOWS ===" -ForegroundColor Yellow
    Write-Host $Title -ForegroundColor Yellow
    $lines | ForEach-Object { Write-Host $_ -ForegroundColor Yellow }
    Write-Host "Check each file in the VS Code diff. A nested .git, a .pth or .pyc file, an executable" -ForegroundColor Yellow
    Write-Host "or a link is suspicious. Do not run tests, uv sync or scripts on Windows before that." -ForegroundColor Yellow
    Write-Host ""
}

# ---- Arguments ---------------------------------------------------------------------------

if ($Resume -and $Continue) { throw "Use -Resume or -Continue, not both." }

if (-not (Test-Path -LiteralPath $Path -PathType Container)) {
    throw "Project folder not found: $Path"
}
$Project = (Resolve-Path -LiteralPath $Path).Path.TrimEnd('\')

# Stable per-project id: readable folder name + short hash of the full path.
$leaf = (Split-Path $Project -Leaf).ToLowerInvariant() -replace '[^a-z0-9_.-]', '-'
$leaf = ($leaf -replace '^[^a-z0-9]+', '')
if (-not $leaf) { $leaf = 'project' }
if ($leaf.Length -gt 30) { $leaf = $leaf.Substring(0, 30) }
$sha = [System.Security.Cryptography.SHA256]::Create()
$hashBytes = $sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($Project.ToLowerInvariant()))
$hash = (($hashBytes | ForEach-Object { $_.ToString('x2') }) -join '').Substring(0, 8)
$Id = "$leaf-$hash"

$AgentName  = "claude-$Id"
$ProxyName  = "claude-proxy-$Id"
$NetName    = "claude-int-$Id"
$VenvVol    = "claude-venv-$Id"
# Per project: a shared volume would let one project plant hooks, commands or poisoned
# packages for all others, and read their conversation history.
$UvCacheVol = "claude-uv-cache-$Id"
if (-not $ConfigVolume) { $ConfigVolume = "claude-config-$Id" }

$StateDir = Join-Path $env:LOCALAPPDATA 'claude-sandbox'
$PendingReview = Join-Path $StateDir "$Id.review.json"

# One sandbox per project at a time. A stopped leftover can be removed; a running one cannot
# (assumes "wslc container rm" refuses a running container, like docker).
if (Invoke-WslcQuiet container inspect $AgentName) {
    $null = Invoke-WslcQuiet container rm $AgentName
    if (Invoke-WslcQuiet container inspect $AgentName) {
        throw "A sandbox for this project is already running ($AgentName). Close it first, or ask Claude there to run your command."
    }
}

# ---- Prerequisites -----------------------------------------------------------------------

if ((Get-WslcOutput network create '--help') -notmatch '--internal') {
    throw "This wslc has no 'network create --internal'; the agent cannot be isolated. Run 'wsl --update'."
}
$imageList = Get-WslcOutput image list
foreach ($img in @($Image, $ProxyImage)) {
    $repo, $tag = $img -split ':', 2
    if (-not $tag) { $tag = 'latest' }
    $re = "(?m)(^|[\s/])$([regex]::Escape($repo))(\s+|:)$([regex]::Escape($tag))(\s|$)"
    if ($imageList -notmatch $re) {
        throw "Image '$img' not found. Run .\Build-ClaudeSandbox.ps1 first."
    }
}

# Git state. Windows git and VS Code execute settings from .git (for example core.fsmonitor),
# so the agent must not be able to create or change it.
$gitDir = Join-Path $Project '.git'
$gitIsDir = Test-Path -LiteralPath $gitDir -PathType Container
if (-not $gitIsDir -and -not $GitWritable) {
    $why = if (Test-Path -LiteralPath $gitDir -PathType Leaf) {
        '.git is a file (worktree or submodule) and cannot be mounted read-only; the agent could point it at a git folder it controls'
    } else {
        'the project has no .git folder; the agent could create one'
    }
    throw "Refusing to start: $why. Windows git then runs commands from that git config. Pass -GitWritable to accept this risk, and read the review after the session."
}
$gitReadOnly = $gitIsDir -and -not $GitWritable

# Mount points that must exist on the host so they can be overlaid / mounted read-only.
$mountDirs = @('.venv', '.vscode')
if (-not $ClaudeDirWritable) { $mountDirs += '.claude' }
foreach ($d in $mountDirs) {
    $p = Join-Path $Project $d
    if (-not (Test-Path -LiteralPath $p)) {
        New-Item -ItemType Directory -Path $p | Out-Null
        Write-Host "Created empty $d in the project (mount point for the sandbox)."
    }
}

$domains = @($DefaultDomains + ($AllowDomain | ForEach-Object { $_ -split ',' }) |
    ForEach-Object { $_.Trim().ToLowerInvariant() } | Where-Object { $_ } | Select-Object -Unique)
$ProxyUrl = "http://${ProxyName}:3128"
$NoProxy = "localhost,127.0.0.1"

# ---- Review left over from a session that was killed without teardown ---------------------

New-Item -ItemType Directory -Force -Path $StateDir | Out-Null
if (Test-Path -LiteralPath $PendingReview) {
    Show-ReviewReport (Read-ReviewSnapshot $PendingReview) (Get-ReviewSnapshot $Project) `
        "The previous session ended without a review. Changes since its start (your own edits included):"
}

# ---- Clean up leftovers from a session that was killed without teardown --------------------

Remove-WslcContainer $ProxyName
$null = Invoke-WslcQuiet network rm $NetName

# ---- Start -------------------------------------------------------------------------------

$before = Get-ReviewSnapshot $Project
$before | ConvertTo-Json -Depth 2 | Set-Content -LiteralPath $PendingReview -Encoding UTF8

$exitCode = 1
try {
    Write-Host "Sandbox for $Project"
    wslc network create --internal $NetName | Out-Null; Assert-Wslc "network create"

    # Proxy: starts on the default (internet) network, then joins the internal one.
    wslc run -d --name $ProxyName -e "PROXY_ALLOW_DOMAINS=$($domains -join ' ')" $ProxyImage | Out-Null
    Assert-Wslc "proxy run"
    wslc network connect $NetName $ProxyName; Assert-Wslc "proxy network connect"
    Wait-ContainerLog $ProxyName 'Accepting HTTP Socket connections' 'proxy: rejected|FATAL' 30
    Write-Host "Egress allowlist: $($domains -join ', ')"

    $agentArgs = @(
        '--rm', '-it',
        '--name', $AgentName,
        '--network', $NetName,
        '-e', "HTTPS_PROXY=$ProxyUrl", '-e', "HTTP_PROXY=$ProxyUrl", '-e', "NO_PROXY=$NoProxy",
        '-e', "https_proxy=$ProxyUrl", '-e', "http_proxy=$ProxyUrl", '-e', "no_proxy=$NoProxy",
        '-e', 'EGRESS_MODE=proxy',
        '-e', "GIT_READONLY=$(if ($gitReadOnly) { '1' } else { '0' })",
        '-e', 'VSCODE_READONLY=1',
        '-e', "CLAUDE_DIR_READONLY=$(if ($ClaudeDirWritable) { '0' } else { '1' })",
        # Order matters: the project first, then the paths nested inside it.
        '-v', "${Project}:/workspace",
        '-v', "${VenvVol}:/workspace/.venv",
        '-v', "$(Join-Path $Project '.vscode'):/workspace/.vscode:ro"
    )
    if (-not $ClaudeDirWritable) {
        $agentArgs += @('-v', "$(Join-Path $Project '.claude'):/workspace/.claude:ro")
    }
    if ($gitReadOnly) {
        $agentArgs += @('-v', "${gitDir}:/workspace/.git:ro")
    }
    $agentArgs += @(
        '-v', "${ConfigVolume}:/home/claude/.claude",
        '-v', "${UvCacheVol}:/home/claude/.cache/uv",
        '-w', '/workspace',
        $Image
    )

    if ($Shell) {
        $agentArgs += @('bash')
    } else {
        $agentArgs += @('claude')
        if ($Bypass)   { $agentArgs += @('--dangerously-skip-permissions') }
        if ($Resume)   { $agentArgs += @('--resume') }
        if ($Continue) { $agentArgs += @('--continue') }
        # Split on whitespace, but keep "double quoted" parts as one argument.
        foreach ($m in [regex]::Matches($ClaudeArgs, '"([^"]*)"|(\S+)')) {
            $agentArgs += $(if ($m.Groups[1].Success) { $m.Groups[1].Value } else { $m.Groups[2].Value })
        }
    }

    wslc run @agentArgs
    $exitCode = $LASTEXITCODE
}
finally {
    $ErrorActionPreference = 'Continue'
    Remove-WslcContainer $ProxyName
    $null = Invoke-WslcQuiet network rm $NetName
    try {
        Show-ReviewReport $before (Get-ReviewSnapshot $Project) "This session changed files that Windows tools execute or trust:"
        Remove-Item -LiteralPath $PendingReview -Force
    } catch {
        Write-Warning "Review failed: $_. It runs again at the next start for this project."
    }
}
if ($Pause) { [void](Read-Host "Session ended. Press Enter to close") }
exit $exitCode
