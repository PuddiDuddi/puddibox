<#
.SYNOPSIS
  Builds the three images used by claude-box.ps1. Run again to update Claude Code.

.EXAMPLE
  .\Build-ClaudeSandbox.ps1
  .\Build-ClaudeSandbox.ps1 -PythonVersions "3.11 3.12 3.13"
  .\Build-ClaudeSandbox.ps1 -PythonVersions "3.12 3.12.5 3.13" -DefaultPython 3.12
#>
[CmdletBinding()]
param(
    [string]$PythonVersions = "3.12 3.13",
    # Gets the plain "python" and "python3" commands; must be one of PythonVersions.
    [string]$DefaultPython = "3.12"
)
$ErrorActionPreference = 'Stop'
Push-Location $PSScriptRoot
try {
    wslc build -t claude-egress-proxy:local proxy
    if ($LASTEXITCODE -ne 0) { throw "proxy image build failed" }

    wslc build -t claude-api-proxy:local api-proxy
    if ($LASTEXITCODE -ne 0) { throw "API proxy image build failed" }

    wslc build -t claude-sandbox:local `
        --build-arg "PYTHON_VERSIONS=$PythonVersions" `
        --build-arg "DEFAULT_PYTHON=$DefaultPython" `
        agent
    if ($LASTEXITCODE -ne 0) { throw "agent image build failed" }

    Write-Host "Done. Images: claude-sandbox:local, claude-egress-proxy:local, claude-api-proxy:local"
}
finally {
    Pop-Location
}
