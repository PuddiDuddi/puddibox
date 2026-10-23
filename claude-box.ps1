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
  - Token mode: with a token from "claude setup-token" in Windows Credential Manager (-SetToken),
    the agent gets only a placeholder. An API proxy container holds the real token and adds it
    to each request. api.anthropic.com is then closed for the agent, so a request with an
    attacker's API key cannot carry data out. Without a stored token, the agent logs in with
    /login and keeps the login in its config volume.
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
  .\claude-box.ps1 -SetToken             # store a "claude setup-token" token, used by all projects
  .\claude-box.ps1 -RemoveToken          # delete the stored token (back to /login per project)
  .\claude-box.ps1 -NoToken              # this session only: ignore the stored token, use /login
  .\claude-box.ps1 -Path D:\projoo -Status -Json   # project id, names and state; changes nothing
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
    [string]$ApiProxyImage = "claude-api-proxy:local",
    [string]$ConfigVolume = "",
    [switch]$Resume,
    [switch]$Continue,
    [string]$ClaudeArgs = "",
    [switch]$Pause,
    [switch]$SetToken,
    [switch]$RemoveToken,
    [switch]$NoToken,
    [switch]$Status,
    [switch]$Json
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

# Windows Credential Manager (generic credential, this user on this machine). Same store as
# gh, glab and Git Credential Manager; Windows encrypts it with DPAPI for the current user.
$TokenTarget = 'puddibox:claude-oauth-token'
$TokenPlaceholder = 'sk-ant-oat01-puddibox-placeholder'

function Initialize-CredApi {
    if ('PuddiboxCred' -as [type]) { return }
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class PuddiboxCred {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct CREDENTIAL {
        public int Flags; public int Type; public string TargetName; public string Comment;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
        public int CredentialBlobSize; public IntPtr CredentialBlob; public int Persist;
        public int AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName;
    }
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool CredReadW(string target, int type, int flags, out IntPtr cred);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool CredWriteW(ref CREDENTIAL cred, int flags);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool CredDeleteW(string target, int type, int flags);
    [DllImport("advapi32.dll")]
    static extern void CredFree(IntPtr cred);
    const int GENERIC = 1, PERSIST_LOCAL_MACHINE = 2;

    public static string Read(string target) {
        IntPtr p;
        if (!CredReadW(target, GENERIC, 0, out p)) return null;
        try {
            var c = (CREDENTIAL)Marshal.PtrToStructure(p, typeof(CREDENTIAL));
            var bytes = new byte[c.CredentialBlobSize];
            Marshal.Copy(c.CredentialBlob, bytes, 0, bytes.Length);
            return Encoding.Unicode.GetString(bytes);
        } finally { CredFree(p); }
    }
    public static void Write(string target, string user, string secret) {
        // UTF-16, like the Credential Manager panel and cmdkey, so a token added there works too.
        var bytes = Encoding.Unicode.GetBytes(secret);
        var c = new CREDENTIAL { Type = GENERIC, TargetName = target, UserName = user,
            Persist = PERSIST_LOCAL_MACHINE, CredentialBlobSize = bytes.Length,
            CredentialBlob = Marshal.AllocHGlobal(bytes.Length) };
        try {
            Marshal.Copy(bytes, 0, c.CredentialBlob, bytes.Length);
            if (!CredWriteW(ref c, 0)) throw new Exception("CredWrite failed, error " + Marshal.GetLastWin32Error());
        } finally { Marshal.FreeHGlobal(c.CredentialBlob); }
    }
    public static bool Delete(string target) { return CredDeleteW(target, GENERIC, 0); }
}
'@
}

# Prints the report and returns the changes as objects (change, path, detail); none = no output.
function Show-ReviewReport([hashtable]$Before, [hashtable]$After, [string]$Title) {
    $changes = @(foreach ($k in (@($Before.Keys) + @($After.Keys) | Sort-Object -Unique)) {
        if (-not $Before.ContainsKey($k)) {
            [pscustomobject]@{ change = 'added'; path = $k; detail = $(if ($After[$k] -like 'link*') { $After[$k] } else { '' }) }
        } elseif (-not $After.ContainsKey($k)) {
            [pscustomobject]@{ change = 'removed'; path = $k; detail = '' }
        } elseif ($Before[$k] -ne $After[$k]) {
            [pscustomobject]@{ change = 'changed'; path = $k; detail = '' }
        }
    })
    $mark = @{ added = '+ added  '; removed = '- removed'; changed = '~ changed' }
    $lines = $changes | ForEach-Object { ("  $($mark[$_.change])  $($_.path)  $($_.detail)").TrimEnd() }
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
    return $changes
}

# The last review stays in a file, so the VS Code extension can show it after the window closes.
function Save-LastReview([string]$File, [string]$Kind, [object[]]$Changes, [int]$ExitCode) {
    [ordered]@{
        schema   = 1
        at       = (Get-Date).ToUniversalTime().ToString('o')
        kind     = $Kind
        exitCode = $ExitCode
        changes  = @($Changes)
    } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $File -Encoding UTF8
}

# ---- Token management (no sandbox) ----------------------------------------------------------

if ($SetToken -and $RemoveToken) { throw "Use -SetToken or -RemoveToken, not both." }
if ($SetToken) {
    Initialize-CredApi
    Write-Host "Run 'claude setup-token' on Windows (or in any terminal with a browser) and paste the token."
    $secure = Read-Host -AsSecureString "Token"
    $token = ([Net.NetworkCredential]::new('', $secure).Password).Trim()
    if ($token -notmatch '^sk-ant-oat[0-9A-Za-z_-]+$') { throw "This is not a token from 'claude setup-token' (sk-ant-oat...)." }
    [PuddiboxCred]::Write($TokenTarget, 'claude-setup-token', $token)
    $token = $null
    Write-Host "Token stored in Windows Credential Manager as '$TokenTarget'. All projects use it from the next start."
    exit 0
}
if ($RemoveToken) {
    Initialize-CredApi
    if ([PuddiboxCred]::Delete($TokenTarget)) { Write-Host "Token removed." } else { Write-Host "No stored token." }
    Write-Host "Also revoke it on claude.ai if it may have leaked."
    exit 0
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
$ApiName    = "claude-api-$Id"
$NetName    = "claude-int-$Id"
$VenvVol    = "claude-venv-$Id"
# Per project: a shared volume would let one project plant hooks, commands or poisoned
# packages for all others, and read their conversation history.
$UvCacheVol = "claude-uv-cache-$Id"
if (-not $ConfigVolume) { $ConfigVolume = "claude-config-$Id" }

$StateDir = Join-Path $env:USERPROFILE 'puddibox\state'
# Earlier versions kept the state in %LOCALAPPDATA%\claude-sandbox. Move this project's files once.
$OldStateDir = Join-Path $env:LOCALAPPDATA 'claude-sandbox'
if (-not $Status -and (Test-Path -LiteralPath $OldStateDir)) {
    New-Item -ItemType Directory -Force -Path $StateDir | Out-Null
    Get-ChildItem -LiteralPath $OldStateDir -Filter "$Id.*.json" -File | ForEach-Object {
        $dest = Join-Path $StateDir $_.Name
        if (-not (Test-Path -LiteralPath $dest)) { Move-Item -LiteralPath $_.FullName -Destination $dest }
    }
}
$PendingReview = Join-Path $StateDir "$Id.review.json"
$LastReview = Join-Path $StateDir "$Id.last-review.json"

# ---- Status (no side effects: no wslc, no images, no files written) ------------------------

if ($Status) {
    Initialize-CredApi
    $stored = $null -ne [PuddiboxCred]::Read($TokenTarget)
    $last = $null
    if (Test-Path -LiteralPath $LastReview) {
        try { $last = Get-Content -Raw -LiteralPath $LastReview | ConvertFrom-Json } catch { $last = $null }
    }
    $info = [ordered]@{
        schema        = 1
        project       = $Project
        id            = $Id
        containers    = [ordered]@{ agent = $AgentName; apiProxy = $ApiName; egressProxy = $ProxyName }
        network       = $NetName
        volumes       = [ordered]@{ config = $ConfigVolume; venv = $VenvVol; uvCache = $UvCacheVol }
        tokenStored   = $stored
        reviewPending = [bool]((Test-Path -LiteralPath $PendingReview) -or
                               (Test-Path -LiteralPath (Join-Path $OldStateDir "$Id.review.json")))
        images        = [ordered]@{ agent = $Image; egressProxy = $ProxyImage; apiProxy = $ApiProxyImage }
        lastReview    = $last
    }
    if ($Json) {
        $info | ConvertTo-Json -Compress -Depth 6
    } else {
        Write-Host "Project:        $Project"
        Write-Host "Id:             $Id"
        Write-Host "Agent:          $AgentName"
        Write-Host "API proxy:      $ApiName"
        Write-Host "Egress proxy:   $ProxyName"
        Write-Host "Network:        $NetName"
        Write-Host "Volumes:        $ConfigVolume, $VenvVol, $UvCacheVol"
        Write-Host "Token stored:   $stored"
        Write-Host "Review pending: $($info.reviewPending)"
        if ($last) { Write-Host "Last review:    $($last.at), $(@($last.changes).Count) change(s)" }
        Write-Host "Images:         $Image, $ProxyImage, $ApiProxyImage"
    }
    exit 0
}

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

$token = $null
if (-not $NoToken) {
    Initialize-CredApi
    $token = [PuddiboxCred]::Read($TokenTarget)
    if ($token) {
        $token = $token.Trim()
        if ($token -notmatch '^sk-ant-oat[0-9A-Za-z_-]+$') {
            throw "The stored '$TokenTarget' is not a token from 'claude setup-token'. Run -SetToken again, or -NoToken."
        }
    }
}
$TokenMode = [bool]$token
$LabelMode = if ($Shell) { 'shell' } elseif ($Bypass) { 'bypass' } else { 'claude' }
$LabelAuth = if ($TokenMode) { 'token' } else { 'login' }
$images = @($Image, $ProxyImage)
if ($TokenMode) { $images += $ApiProxyImage }

$imageList = Get-WslcOutput image list
foreach ($img in $images) {
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

# Token mode: the agent reaches the Claude API only through the API proxy.
$baseDomains = if ($TokenMode) { $DefaultDomains | Where-Object { $_ -ne 'api.anthropic.com' } } else { $DefaultDomains }
$domains = @($baseDomains + ($AllowDomain | ForEach-Object { $_ -split ',' }) |
    ForEach-Object { $_.Trim().ToLowerInvariant() } | Where-Object { $_ } | Select-Object -Unique)
if ($TokenMode -and ($domains -contains 'api.anthropic.com' -or $domains -contains '.anthropic.com')) {
    throw "Token mode closes api.anthropic.com for the agent. Remove it from -AllowDomain, or use -NoToken."
}
$ProxyUrl = "http://${ProxyName}:3128"
$ApiUrl = "http://${ApiName}:8080"
$NoProxy = "localhost,127.0.0.1"
if ($TokenMode) { $NoProxy += ",$ApiName" }

# ---- Review left over from a session that was killed without teardown ---------------------

New-Item -ItemType Directory -Force -Path $StateDir | Out-Null
$leftoverChanges = @()
if (Test-Path -LiteralPath $PendingReview) {
    $leftoverChanges = @(Show-ReviewReport (Read-ReviewSnapshot $PendingReview) (Get-ReviewSnapshot $Project) `
        "The previous session ended without a review. Changes since its start (your own edits included):")
    Save-LastReview $LastReview 'leftover' $leftoverChanges -1
}

# ---- Clean up leftovers from a session that was killed without teardown --------------------

Remove-WslcContainer $ProxyName
Remove-WslcContainer $ApiName
$null = Invoke-WslcQuiet network rm $NetName

# Labels that the VS Code extension reads to find sandboxes.
function Get-PuddiboxLabel([string]$Role) {
    return @('--label', "puddibox.id=$Id", '--label', "puddibox.role=$Role",
             '--label', "puddibox.mode=$LabelMode", '--label', "puddibox.auth=$LabelAuth")
}

# ---- Start -------------------------------------------------------------------------------

$before = Get-ReviewSnapshot $Project
$before | ConvertTo-Json -Depth 2 | Set-Content -LiteralPath $PendingReview -Encoding UTF8

$exitCode = 1
try {
    Write-Host "Sandbox for $Project"
    wslc network create --internal $NetName | Out-Null; Assert-Wslc "network create"

    # Proxy: starts on the default (internet) network, then joins the internal one.
    $egressLabels = Get-PuddiboxLabel egress
    wslc run -d --name $ProxyName @egressLabels -e "PROXY_ALLOW_DOMAINS=$($domains -join ' ')" $ProxyImage | Out-Null
    Assert-Wslc "proxy run"
    wslc network connect $NetName $ProxyName; Assert-Wslc "proxy network connect"
    Wait-ContainerLog $ProxyName 'Accepting HTTP Socket connections' 'proxy: rejected|FATAL' 30
    Write-Host "Egress allowlist: $($domains -join ', ')"

    if ($TokenMode) {
        # The token goes to wslc by variable name only, never on a command line. The variable
        # is set for this process only for the run command, then the earlier value comes back.
        $savedToken = $env:CLAUDE_CODE_OAUTH_TOKEN
        try {
            $env:CLAUDE_CODE_OAUTH_TOKEN = $token
            $apiLabels = Get-PuddiboxLabel api
            wslc run -d --name $ApiName @apiLabels -e CLAUDE_CODE_OAUTH_TOKEN $ApiProxyImage | Out-Null
            Assert-Wslc "API proxy run"
        } finally {
            $env:CLAUDE_CODE_OAUTH_TOKEN = $savedToken
            $token = $null
        }
        wslc network connect $NetName $ApiName; Assert-Wslc "API proxy network connect"
        Wait-ContainerLog $ApiName 'api-proxy: listening' 'api-proxy: FATAL|Traceback' 30
        Write-Host "Claude API: token mode, through $ApiUrl (the agent has no token)"
    } else {
        Write-Host "Claude API: /login mode (no stored token; see -SetToken)"
    }

    $agentArgs = @(
        '--rm', '-it',
        '--name', $AgentName,
        '--label', "puddibox.id=$Id", '--label', 'puddibox.role=agent',
        '--label', "puddibox.mode=$LabelMode", '--label', "puddibox.auth=$LabelAuth",
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
    if ($TokenMode) {
        # The placeholder makes Claude Code use the subscription; the API proxy replaces it.
        # check-egress.sh tests the egress proxy with claude.ai, as api.anthropic.com is closed.
        $agentArgs += @(
            '-e', "ANTHROPIC_BASE_URL=$ApiUrl",
            '-e', "CLAUDE_CODE_OAUTH_TOKEN=$TokenPlaceholder",
            '-e', 'EGRESS_ALLOWED_TEST_HOST=claude.ai'
        )
    }
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
    Remove-WslcContainer $ApiName
    $null = Invoke-WslcQuiet network rm $NetName
    $reviewChanges = @()
    $reviewFailed = $false
    try {
        $reviewChanges = @(Show-ReviewReport $before (Get-ReviewSnapshot $Project) "This session changed files that Windows tools execute or trust:")
        Save-LastReview $LastReview 'session' $reviewChanges $exitCode
        Remove-Item -LiteralPath $PendingReview -Force
    } catch {
        $reviewFailed = $true
        Write-Warning "Review failed: $_. It runs again at the next start for this project."
    }
}
# -Pause waits only when there is something to read: review changes, a failed review, or an
# unusual exit. 0 = Claude exited, 130 = Ctrl+C, 137/143 = stopped (SIGKILL/SIGTERM).
# Errors before this point stop at the trap above.
if ($Pause) {
    if ($reviewChanges.Count -or $leftoverChanges.Count -or $reviewFailed -or $exitCode -notin 0, 130, 137, 143) {
        [void](Read-Host "Session ended (exit code $exitCode). Press Enter to close")
    } else {
        Write-Host "Session ended (exit code $exitCode). No review findings; this window closes in 5 s."
        Start-Sleep -Seconds 5
    }
}
exit $exitCode
