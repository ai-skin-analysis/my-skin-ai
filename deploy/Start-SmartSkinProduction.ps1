[CmdletBinding()]
param(
    [ValidateRange(1, 65535)]
    [int]$Port = 8080,

    [ValidateRange(1, 64)]
    [int]$Threads = 8,

    [string]$ProjectRoot = (Split-Path -Parent $PSScriptRoot),

    [string]$PythonPath,

    [string]$ServiceAccount = 'NT SERVICE\SmartSkinAI',

    [switch]$AllowUnverifiedVolumeEncryption,

    # Pass only when the service environment also sets
    # SMART_SKIN_PUBLIC_INFORMATION_MODE=1. This prevents a public education
    # release from needlessly requiring private data infrastructure.
    [switch]$PublicInformationMode
)

<#
.SYNOPSIS
Starts the Smart Skin AI WSGI process for a Windows production service.

.DESCRIPTION
This runner deliberately has no public host parameter: Waitress always binds
to 127.0.0.1. A TLS reverse proxy (for example Caddy) must be the only public
entry point. It runs the production readiness gate before starting Waitress.

It is intended to be called in the foreground by a Windows service wrapper
such as WinSW; do not use Start-Process here because a service manager then
cannot reliably observe or stop the WSGI child process.
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$resolvedProjectRoot = [System.IO.Path]::GetFullPath($ProjectRoot)
if (-not (Test-Path -LiteralPath $resolvedProjectRoot -PathType Container)) {
    throw "ProjectRoot does not exist: $resolvedProjectRoot"
}

if ([string]::IsNullOrWhiteSpace($PythonPath)) {
    $PythonPath = Join-Path $resolvedProjectRoot '.venv\Scripts\python.exe'
}
$resolvedPythonPath = [System.IO.Path]::GetFullPath($PythonPath)
if (-not (Test-Path -LiteralPath $resolvedPythonPath -PathType Leaf)) {
    throw "Python executable was not found: $resolvedPythonPath"
}

$waitressServe = Join-Path (Split-Path -Parent $resolvedPythonPath) 'waitress-serve.exe'
if (-not (Test-Path -LiteralPath $waitressServe -PathType Leaf)) {
    throw "waitress-serve.exe was not found next to the configured Python. Install requirements.txt into this environment."
}

$existingListeners = @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)
if ($existingListeners.Count -gt 0) {
    $listenerDetails = $existingListeners | ForEach-Object { "$($_.LocalAddress):$($_.LocalPort) (PID $($_.OwningProcess))" }
    throw "Port $Port is already listening: $($listenerDetails -join ', ')"
}

$preflight = Join-Path $PSScriptRoot 'Test-SmartSkinProductionReadiness.ps1'
if (-not (Test-Path -LiteralPath $preflight -PathType Leaf)) {
    throw "Production preflight script is missing: $preflight"
}

# Force production-safe values for this process. Other required values remain
# in the service environment / secret store and are checked by the preflight.
$env:SMART_SKIN_ENV = 'production'
$env:FLASK_HTTPS = '1'
$env:FLASK_DEBUG = '0'
$env:FLASK_RUN_FROM_CLI = 'false'

$preflightArguments = @(
    '-ProjectRoot', $resolvedProjectRoot,
    '-PythonPath', $resolvedPythonPath,
    '-ServiceAccount', $ServiceAccount
)
if ($AllowUnverifiedVolumeEncryption) {
    $preflightArguments += '-AllowUnverifiedVolumeEncryption'
}
if ($PublicInformationMode) {
    $preflightArguments += '-PublicInformationMode'
}

& $preflight @preflightArguments

Write-Host "Starting Waitress on 127.0.0.1:$Port with $Threads worker threads."
Write-Host 'Use the TLS reverse proxy for all external traffic; do not publish this port.'

Push-Location $resolvedProjectRoot
try {
    # Invoke in the foreground so the Windows service wrapper owns the WSGI
    # lifetime and can restart it after a failure.
    & $waitressServe "--host=127.0.0.1" "--port=$Port" "--threads=$Threads" 'wsgi:application'
    $waitressExitCode = $LASTEXITCODE
}
finally {
    Pop-Location
}

if ($waitressExitCode -ne 0) {
    throw "Waitress exited unexpectedly with code $waitressExitCode."
}
