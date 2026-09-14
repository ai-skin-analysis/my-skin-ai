[CmdletBinding()]
param(
    [string]$ProjectRoot = (Split-Path -Parent $PSScriptRoot),

    [string]$PythonPath,

    [string]$ServiceAccount = 'NT SERVICE\SmartSkinAI',

    # Use only when the operator has separately documented evidence of volume
    # encryption. This switch never makes an unencrypted volume acceptable.
    [switch]$AllowUnverifiedVolumeEncryption,

    # Useful for configuration review when the deployment Python environment
    # has not been installed yet. Normal production use must import WSGI.
    [switch]$SkipApplicationImport,

    # Verify the education-only deployment path. This mode intentionally has
    # no accounts, private data store, image uploads, SMTP, or MFA service.
    [switch]$PublicInformationMode
)

<#
.SYNOPSIS
Checks the production environment without printing secret values.

.DESCRIPTION
The application independently refuses incomplete production configuration.
This script adds deployment checks that Flask cannot prove itself: external
data paths, permissive directory ACLs, a best-effort BitLocker verification,
the local Waitress package, and the WSGI import. With -PublicInformationMode,
it verifies only the safe education-only configuration and deliberately skips
private-data checks that the application does not initialise. Environment
confirmations are attestations, not proof that backup encryption or access
review happened.
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:Failures = New-Object System.Collections.Generic.List[string]
$script:Warnings = New-Object System.Collections.Generic.List[string]

function Add-Failure {
    param([Parameter(Mandatory = $true)][string]$Message)
    $script:Failures.Add($Message) | Out-Null
    Write-Host "FAIL: $Message" -ForegroundColor Red
}

function Add-Warning {
    param([Parameter(Mandatory = $true)][string]$Message)
    $script:Warnings.Add($Message) | Out-Null
    Write-Host "WARN: $Message" -ForegroundColor Yellow
}

function Get-ProcessEnvironmentValue {
    param([Parameter(Mandatory = $true)][string]$Name)
    return [Environment]::GetEnvironmentVariable($Name, [EnvironmentVariableTarget]::Process)
}

function Test-RequiredEnvironmentValue {
    param([Parameter(Mandatory = $true)][string]$Name)
    $value = Get-ProcessEnvironmentValue -Name $Name
    if ([string]::IsNullOrWhiteSpace($value)) {
        Add-Failure "Required environment variable $Name is not set."
        return $null
    }
    return $value.Trim()
}

function Convert-ToAbsolutePath {
    param([Parameter(Mandatory = $true)][string]$PathValue)
    $expanded = [Environment]::ExpandEnvironmentVariables($PathValue)
    if (-not [System.IO.Path]::IsPathRooted($expanded)) {
        return $null
    }
    return [System.IO.Path]::GetFullPath($expanded)
}

function Test-ExternalStoragePath {
    param(
        [Parameter(Mandatory = $true)][string]$Label,
        [Parameter(Mandatory = $true)][string]$PathValue,
        [Parameter(Mandatory = $true)][string]$ResolvedProjectRoot,
        [switch]$PathIsFile
    )

    $absolutePath = Convert-ToAbsolutePath -PathValue $PathValue
    if ($null -eq $absolutePath) {
        Add-Failure "$Label must be an absolute path."
        return $null
    }

    $projectPrefix = $ResolvedProjectRoot.TrimEnd('\') + '\'
    $comparisonPath = $absolutePath.TrimEnd('\')
    if ($comparisonPath.Equals($ResolvedProjectRoot.TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase) -or
        $comparisonPath.StartsWith($projectPrefix, [StringComparison]::OrdinalIgnoreCase)) {
        Add-Failure "$Label must be outside the application project directory."
        return $null
    }

    if ($PathIsFile) {
        $directory = Split-Path -Parent $absolutePath
    }
    else {
        $directory = $absolutePath
    }

    if (-not (Test-Path -LiteralPath $directory -PathType Container)) {
        Add-Failure "$Label parent directory does not exist: $directory"
        return $null
    }

    Write-Host "OK: $Label is external to the project directory."
    return $directory
}

function Test-StorageAcl {
    param(
        [Parameter(Mandatory = $true)][string]$Directory,
        [Parameter(Mandatory = $true)][string]$ExpectedServiceAccount
    )

    try {
        $acl = Get-Acl -LiteralPath $Directory
    }
    catch {
        Add-Failure "Cannot inspect ACL for ${Directory}: $($_.Exception.Message)"
        return
    }

    # Well-known SIDs: Everyone, Authenticated Users, and BUILTIN\Users.
    $unsafeSids = @('S-1-1-0', 'S-1-5-11', 'S-1-5-32-545')
    $writeMask = [System.Security.AccessControl.FileSystemRights]::FullControl -bor
        [System.Security.AccessControl.FileSystemRights]::Modify -bor
        [System.Security.AccessControl.FileSystemRights]::WriteData -bor
        [System.Security.AccessControl.FileSystemRights]::AppendData -bor
        [System.Security.AccessControl.FileSystemRights]::Delete -bor
        [System.Security.AccessControl.FileSystemRights]::ChangePermissions -bor
        [System.Security.AccessControl.FileSystemRights]::TakeOwnership
    $hasExplicitServiceRule = $false

    foreach ($rule in $acl.Access) {
        if ($rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow) {
            continue
        }
        if ($rule.IdentityReference.Value.Equals($ExpectedServiceAccount, [StringComparison]::OrdinalIgnoreCase)) {
            $hasExplicitServiceRule = $true
        }
        try {
            $sid = $rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value
        }
        catch {
            Add-Warning "Could not translate ACL identity '$($rule.IdentityReference.Value)' on $Directory. Review it manually."
            continue
        }
        if ($unsafeSids -contains $sid -and (($rule.FileSystemRights -band $writeMask) -ne 0)) {
            Add-Failure "Directory $Directory grants write-like access to '$($rule.IdentityReference.Value)'. Remove broad write access before launch."
        }
    }

    if (-not $hasExplicitServiceRule) {
        Add-Warning "No explicit ACL rule for $ExpectedServiceAccount on $Directory. Verify the service identity has only the required access through a documented group or explicit rule."
    }
    else {
        Write-Host "OK: An explicit ACL rule exists for $ExpectedServiceAccount on $Directory."
    }
}

function Test-VolumeEncryption {
    param(
        [Parameter(Mandatory = $true)][string]$Directory,
        [switch]$PermitManualEvidence
    )

    $driveRoot = [System.IO.Path]::GetPathRoot([System.IO.Path]::GetFullPath($Directory))
    if ([string]::IsNullOrWhiteSpace($driveRoot)) {
        Add-Failure "Could not determine the volume for $Directory."
        return
    }

    $bitLockerCommand = Get-Command Get-BitLockerVolume -ErrorAction SilentlyContinue
    if ($null -eq $bitLockerCommand) {
        $message = "BitLocker status cannot be checked for $driveRoot because Get-BitLockerVolume is unavailable. Confirm volume encryption and recovery-key controls manually."
        if ($PermitManualEvidence) {
            Add-Warning $message
        }
        else {
            Add-Failure "$message Re-run with -AllowUnverifiedVolumeEncryption only after retaining manual evidence."
        }
        return
    }

    try {
        $volume = Get-BitLockerVolume -MountPoint $driveRoot -ErrorAction Stop
        $protectionStatus = [string]$volume.ProtectionStatus
        $volumeStatus = [string]$volume.VolumeStatus
    }
    catch {
        $message = "Could not inspect BitLocker status for ${driveRoot}: $($_.Exception.Message)"
        if ($PermitManualEvidence) {
            Add-Warning $message
        }
        else {
            Add-Failure "$message Do not launch until encryption can be verified or documented."
        }
        return
    }

    if ($protectionStatus -notmatch '^(On|1)$' -or $volumeStatus -notmatch 'FullyEncrypted') {
        Add-Failure "Volume $driveRoot is not reported as protected and fully encrypted (ProtectionStatus=$protectionStatus, VolumeStatus=$volumeStatus)."
        return
    }
    Write-Host "OK: BitLocker reports $driveRoot as protected and fully encrypted."
}

function Test-AllowedHosts {
    param([Parameter(Mandatory = $true)][string]$Value)
    $hosts = @($Value.Split(',') | ForEach-Object { $_.Trim().ToLowerInvariant() } | Where-Object { $_ })
    if ($hosts.Count -eq 0) {
        Add-Failure 'SMART_SKIN_ALLOWED_HOSTS must contain at least one public domain name.'
        return @()
    }
    foreach ($configuredHost in $hosts) {
        if ($configuredHost -eq 'localhost' -or $configuredHost -match '[:/\\*\s]' -or $configuredHost -notmatch '^[a-z0-9][a-z0-9.-]*[a-z0-9]$') {
            Add-Failure 'SMART_SKIN_ALLOWED_HOSTS contains an invalid public host value.'
            break
        }
    }
    return $hosts
}

Write-Host 'Smart Skin AI production readiness check' -ForegroundColor Cyan

$resolvedProjectRoot = [System.IO.Path]::GetFullPath($ProjectRoot)
if (-not (Test-Path -LiteralPath $resolvedProjectRoot -PathType Container)) {
    Add-Failure "ProjectRoot does not exist: $resolvedProjectRoot"
}

if ([string]::IsNullOrWhiteSpace($PythonPath)) {
    $PythonPath = Join-Path $resolvedProjectRoot '.venv\Scripts\python.exe'
}
$resolvedPythonPath = Convert-ToAbsolutePath -PathValue $PythonPath
if ($null -eq $resolvedPythonPath -or -not (Test-Path -LiteralPath $resolvedPythonPath -PathType Leaf)) {
    Add-Failure 'Configured Python executable does not exist.'
}

if ((Get-ProcessEnvironmentValue -Name 'SMART_SKIN_ENV') -ne 'production') {
    Add-Failure 'SMART_SKIN_ENV must be exactly production.'
}
if ((Get-ProcessEnvironmentValue -Name 'FLASK_HTTPS') -ne '1') {
    Add-Failure 'FLASK_HTTPS must be exactly 1.'
}

$publicInformationConfigured = ([string](Get-ProcessEnvironmentValue -Name 'SMART_SKIN_PUBLIC_INFORMATION_MODE')).Trim().ToLowerInvariant() -in @('1', 'true', 'yes', 'on')
if ($PublicInformationMode -and -not $publicInformationConfigured) {
    Add-Failure 'PublicInformationMode requires SMART_SKIN_PUBLIC_INFORMATION_MODE=1 in the service environment.'
}

foreach ($name in @(
    'FLASK_SECRET_KEY',
    'SMART_SKIN_DATA_CONTROLLER_NAME',
    'SMART_SKIN_PRIVACY_CONTACT'
)) {
    [void](Test-RequiredEnvironmentValue -Name $name)
}

$allowedHostsValue = Test-RequiredEnvironmentValue -Name 'SMART_SKIN_ALLOWED_HOSTS'
$trustedProxyHopsValue = Test-RequiredEnvironmentValue -Name 'SMART_SKIN_TRUSTED_PROXY_HOPS'
$allowedHosts = @()
if ($allowedHostsValue) {
    $allowedHosts = @(Test-AllowedHosts -Value $allowedHostsValue)
}
if ($trustedProxyHopsValue) {
    [int]$trustedProxyHops = 0
    if (-not [int]::TryParse($trustedProxyHopsValue, [ref]$trustedProxyHops) -or $trustedProxyHops -lt 1 -or $trustedProxyHops -gt 3) {
        Add-Failure 'SMART_SKIN_TRUSTED_PROXY_HOPS must be a number from 1 to 3.'
    }
}
foreach ($name in @('SMART_SKIN_PRIVACY_PROCESSORS_REVIEWED', 'SMART_SKIN_INCIDENT_RESPONSE_CONFIRMED')) {
    if ((Get-ProcessEnvironmentValue -Name $name) -ne '1') {
        Add-Failure "$name must be exactly 1."
    }
}

if ($PublicInformationMode) {
    Write-Host 'OK: checking public-information mode without account or health-image storage.'
}
else {
    foreach ($name in @(
        'SMART_SKIN_MFA_ENCRYPTION_KEY',
        'SMART_SKIN_PUBLIC_BASE_URL',
        'SMART_SKIN_SMTP_HOST',
        'SMART_SKIN_SMTP_USERNAME',
        'SMART_SKIN_SMTP_PASSWORD',
        'SMART_SKIN_SMTP_FROM'
    )) {
        [void](Test-RequiredEnvironmentValue -Name $name)
    }

    $databaseValue = Test-RequiredEnvironmentValue -Name 'SMART_SKIN_DATABASE'
    $uploadValue = Test-RequiredEnvironmentValue -Name 'SMART_SKIN_UPLOAD_FOLDER'
    $smtpPortValue = Test-RequiredEnvironmentValue -Name 'SMART_SKIN_SMTP_PORT'
    $retentionDaysValue = Test-RequiredEnvironmentValue -Name 'SMART_SKIN_RETENTION_DAYS'
    $locationRetentionValue = Test-RequiredEnvironmentValue -Name 'SMART_SKIN_LOCATION_CONTEXT_RETENTION_HOURS'
    foreach ($name in @(
        'SMART_SKIN_DATA_ENCRYPTION_AT_REST_CONFIRMED',
        'SMART_SKIN_BACKUPS_ENCRYPTED_CONFIRMED',
        'SMART_SKIN_RETENTION_SCHEDULER_CONFIRMED'
    )) {
        if ((Get-ProcessEnvironmentValue -Name $name) -ne '1') {
            Add-Failure "$name must be exactly 1."
        }
    }

    [int]$smtpPort = 0
    if ($smtpPortValue -and (-not [int]::TryParse($smtpPortValue, [ref]$smtpPort) -or $smtpPort -lt 1 -or $smtpPort -gt 65535)) {
        Add-Failure 'SMART_SKIN_SMTP_PORT must be a number from 1 to 65535.'
    }
    if ($smtpPort -ne 465 -and (Get-ProcessEnvironmentValue -Name 'SMART_SKIN_SMTP_STARTTLS') -ne '1') {
        Add-Failure 'SMART_SKIN_SMTP_STARTTLS must be 1 unless SMART_SKIN_SMTP_PORT is 465.'
    }
    if ($retentionDaysValue) {
        [int]$retentionDays = 0
        if (-not [int]::TryParse($retentionDaysValue, [ref]$retentionDays) -or $retentionDays -lt 1 -or $retentionDays -gt 365) {
            Add-Failure 'SMART_SKIN_RETENTION_DAYS must be a number from 1 to 365.'
        }
    }
    if ($locationRetentionValue) {
        [int]$locationRetentionHours = 0
        if (-not [int]::TryParse($locationRetentionValue, [ref]$locationRetentionHours) -or $locationRetentionHours -lt 1 -or $locationRetentionHours -gt 168) {
            Add-Failure 'SMART_SKIN_LOCATION_CONTEXT_RETENTION_HOURS must be a number from 1 to 168.'
        }
    }

    $publicBaseUrlValue = Get-ProcessEnvironmentValue -Name 'SMART_SKIN_PUBLIC_BASE_URL'
    if ($publicBaseUrlValue) {
        try {
            $publicUri = [System.Uri]$publicBaseUrlValue
            if ($publicUri.Scheme -ne 'https' -or [string]::IsNullOrWhiteSpace($publicUri.Host) -or
                -not [string]::IsNullOrWhiteSpace($publicUri.UserInfo) -or
                -not [string]::IsNullOrWhiteSpace($publicUri.Query) -or
                -not [string]::IsNullOrWhiteSpace($publicUri.Fragment)) {
                Add-Failure 'SMART_SKIN_PUBLIC_BASE_URL must be a clean HTTPS public URL.'
            }
            elseif ($allowedHosts.Count -gt 0 -and $allowedHosts -notcontains $publicUri.DnsSafeHost.ToLowerInvariant()) {
                Add-Failure 'SMART_SKIN_PUBLIC_BASE_URL host must be present in SMART_SKIN_ALLOWED_HOSTS.'
            }
        }
        catch {
            Add-Failure 'SMART_SKIN_PUBLIC_BASE_URL is not a valid HTTPS URL.'
        }
    }

    $storageDirectories = New-Object System.Collections.Generic.List[string]
    if ($databaseValue -and (Test-Path -LiteralPath $resolvedProjectRoot -PathType Container)) {
        $databaseDirectory = Test-ExternalStoragePath -Label 'SMART_SKIN_DATABASE' -PathValue $databaseValue -ResolvedProjectRoot $resolvedProjectRoot -PathIsFile
        if ($databaseDirectory) { $storageDirectories.Add($databaseDirectory) | Out-Null }
    }
    if ($uploadValue -and (Test-Path -LiteralPath $resolvedProjectRoot -PathType Container)) {
        $uploadDirectory = Test-ExternalStoragePath -Label 'SMART_SKIN_UPLOAD_FOLDER' -PathValue $uploadValue -ResolvedProjectRoot $resolvedProjectRoot
        if ($uploadDirectory) { $storageDirectories.Add($uploadDirectory) | Out-Null }
    }
    if ((Get-ProcessEnvironmentValue -Name 'SMART_SKIN_ALLOW_ADMIN_TRAINING') -eq '1') {
        $candidateValue = Test-RequiredEnvironmentValue -Name 'SMART_SKIN_TRAINING_CANDIDATE_FOLDER'
        if ($candidateValue -and (Test-Path -LiteralPath $resolvedProjectRoot -PathType Container)) {
            $candidateDirectory = Test-ExternalStoragePath -Label 'SMART_SKIN_TRAINING_CANDIDATE_FOLDER' -PathValue $candidateValue -ResolvedProjectRoot $resolvedProjectRoot
            if ($candidateDirectory) { $storageDirectories.Add($candidateDirectory) | Out-Null }
        }
    }
    $uniqueDirectories = @($storageDirectories | Sort-Object -Unique)
    foreach ($directory in $uniqueDirectories) {
        Test-StorageAcl -Directory $directory -ExpectedServiceAccount $ServiceAccount
        Test-VolumeEncryption -Directory $directory -PermitManualEvidence:$AllowUnverifiedVolumeEncryption
    }
    Add-Warning 'SMART_SKIN_BACKUPS_ENCRYPTED_CONFIRMED is an operator attestation. This script cannot prove off-host backup encryption, key custody, or a successful restore.'
}

if ($script:Failures.Count -eq 0 -and -not $SkipApplicationImport) {
    try {
        Push-Location $resolvedProjectRoot
        try {
            & $resolvedPythonPath -c 'import waitress; import wsgi; print("Waitress and WSGI import passed.")'
            if ($LASTEXITCODE -ne 0) {
                Add-Failure 'Waitress/WSGI import failed. Review the service log without exposing secrets.'
            }
        }
        finally {
            Pop-Location
        }
    }
    catch {
        Add-Failure "Waitress/WSGI import could not be completed: $($_.Exception.Message)"
    }
}

if ($script:Failures.Count -gt 0) {
    throw "Production readiness failed with $($script:Failures.Count) blocking issue(s)."
}

Write-Host 'READY: production prerequisites passed. This does not certify clinical safety, legal compliance, backup recovery, or model readiness.' -ForegroundColor Green
