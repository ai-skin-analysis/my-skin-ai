[CmdletBinding()]
param(
    # Path used by the live service. It is compared with the restored copy so
    # this verification cannot accidentally inspect the production database.
    [Parameter(Mandatory = $true)]
    [string]$LiveDatabasePath,

    # A copy restored by the organisation's approved encrypted-backup product
    # into a quarantined, non-production folder.
    [Parameter(Mandatory = $true)]
    [string]$RestoredDatabasePath,

    [Parameter(Mandatory = $true)]
    [string]$RestoredUploadFolder,

    # A minimal, non-secret JSON manifest emitted by the backup process. See
    # BACKUP_AND_RESTORE_RUNBOOK.md for the required fields.
    [string]$BackupManifestPath,

    [ValidateRange(1, 8760)]
    [int]$MaximumBackupAgeHours = 168,

    [string]$PythonPath = 'python',

    # Write the report outside both the live and restored data roots. Reports
    # intentionally include only counts and pass/fail state, never row data,
    # image filenames, tokens, locations, or secrets.
    [Parameter(Mandatory = $true)]
    [string]$ReportPath,

    [switch]$OverwriteReport,

    # This is deliberately noisy. It is only for a documented, one-off test
    # when an approved backup product cannot emit the required manifest.
    [switch]$AllowMissingManifest
)

<#!
.SYNOPSIS
Verifies a quarantined Smart Skin AI backup restore without starting the app.

.DESCRIPTION
The operator restores encrypted backup material using the organisation's
approved backup product before invoking this script. This script never creates
or decrypts a backup, never touches the live database, and never writes to the
restored data. It opens the restored SQLite database read-only, checks
integrity, checks that the restored uploads directory is readable, and writes a
small non-sensitive verification report. A passing report proves only that the
tested restore was readable and internally consistent; it is not proof of key
custody, encryption configuration, completeness, or clinical readiness.
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

function Resolve-ExistingFile {
    param([Parameter(Mandatory = $true)][string]$PathValue, [Parameter(Mandatory = $true)][string]$Label)
    if (-not [System.IO.Path]::IsPathRooted($PathValue)) {
        Add-Failure "$Label must be an absolute path."
        return $null
    }
    if (-not (Test-Path -LiteralPath $PathValue -PathType Leaf)) {
        Add-Failure "$Label does not exist or is not a file."
        return $null
    }
    return [System.IO.Path]::GetFullPath((Resolve-Path -LiteralPath $PathValue).Path)
}

function Resolve-ExistingDirectory {
    param([Parameter(Mandatory = $true)][string]$PathValue, [Parameter(Mandatory = $true)][string]$Label)
    if (-not [System.IO.Path]::IsPathRooted($PathValue)) {
        Add-Failure "$Label must be an absolute path."
        return $null
    }
    if (-not (Test-Path -LiteralPath $PathValue -PathType Container)) {
        Add-Failure "$Label does not exist or is not a directory."
        return $null
    }
    return [System.IO.Path]::GetFullPath((Resolve-Path -LiteralPath $PathValue).Path)
}

function Test-PathWithinRoot {
    param(
        [Parameter(Mandatory = $true)][string]$CandidatePath,
        [Parameter(Mandatory = $true)][string]$RootPath
    )

    $candidate = [System.IO.Path]::GetFullPath($CandidatePath).TrimEnd([char[]]@('\', '/'))
    $root = [System.IO.Path]::GetFullPath($RootPath).TrimEnd([char[]]@('\', '/'))
    if ($candidate.Equals($root, [StringComparison]::OrdinalIgnoreCase)) {
        return $true
    }
    return $candidate.StartsWith($root + [System.IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)
}

function Resolve-SafeReportPath {
    param(
        [Parameter(Mandatory = $true)][string]$DestinationPath,
        [Parameter(Mandatory = $true)][string[]]$ExcludedRoots
    )

    if (-not [System.IO.Path]::IsPathRooted($DestinationPath)) {
        throw 'ReportPath must be an absolute path.'
    }
    $resolvedDestination = [System.IO.Path]::GetFullPath($DestinationPath)
    foreach ($root in $ExcludedRoots) {
        if (-not [string]::IsNullOrWhiteSpace($root) -and (Test-PathWithinRoot -CandidatePath $resolvedDestination -RootPath $root)) {
            throw 'ReportPath must be outside both live and restored data roots.'
        }
    }
    return $resolvedDestination
}

function Test-SqliteIntegrityReadOnly {
    param(
        [Parameter(Mandatory = $true)][string]$ResolvedPythonPath,
        [Parameter(Mandatory = $true)][string]$DatabasePath
    )

    $pythonCode = @'
import sqlite3
import sys
from pathlib import Path

database = Path(sys.argv[1]).resolve()
uri = database.as_uri() + "?mode=ro"
connection = sqlite3.connect(uri, uri=True)
try:
    quick_check = [row[0] for row in connection.execute("PRAGMA quick_check")]
    integrity_check = [row[0] for row in connection.execute("PRAGMA integrity_check")]
    foreign_key_violations = sum(1 for _ in connection.execute("PRAGMA foreign_key_check"))
    table_names = {
        row[0] for row in connection.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
        )
    }
finally:
    connection.close()

if quick_check != ["ok"] or integrity_check != ["ok"] or foreign_key_violations:
    sys.exit(2)

# These stable core tables distinguish a Smart Skin service backup from an
# empty or unrelated SQLite file, without inspecting personal records.
required_tables = {"users", "scan_logs", "audit_logs"}
missing_tables = sorted(required_tables - table_names)
if missing_tables:
    print("smart_skin_schema=missing")
    sys.exit(3)

print(f"sqlite_integrity=ok smart_skin_schema=ok tables={len(table_names)} foreign_key_violations={foreign_key_violations}")
'@

    $output = & $ResolvedPythonPath -c $pythonCode $DatabasePath 2>&1
    if ($LASTEXITCODE -ne 0) {
        Add-Failure 'Read-only SQLite integrity check failed for the restored database. Do not use this restore.'
        return $null
    }

    $resultText = ($output -join "`n")
    $match = [regex]::Match($resultText, 'tables=(?<tables>\d+)')
    if (-not $match.Success -or $resultText -notmatch 'smart_skin_schema=ok') {
        Add-Failure 'SQLite integrity checker returned an unexpected result.'
        return $null
    }
    return [int]$match.Groups['tables'].Value
}

function Get-RestoredUploadSummary {
    param([Parameter(Mandatory = $true)][string]$UploadFolder)

    try {
        $files = @(Get-ChildItem -LiteralPath $UploadFolder -File -Recurse -Force -ErrorAction Stop)
    }
    catch {
        Add-Failure "Cannot enumerate restored uploads without exposing filenames: $($_.Exception.Message)"
        return $null
    }

    $totalBytes = [Int64]0
    foreach ($file in $files) {
        $totalBytes += [Int64]$file.Length
    }

    return [ordered]@{
        file_count = $files.Count
        total_bytes = $totalBytes
    }
}

function Test-BackupManifest {
    param(
        [string]$PathValue,
        [int]$MaximumAgeHours,
        [switch]$PermitMissingManifest
    )

    if ([string]::IsNullOrWhiteSpace($PathValue)) {
        if ($PermitMissingManifest) {
            Add-Warning 'No backup manifest was supplied. Retain separate evidence that this was an encrypted backup and record why the manifest was unavailable.'
            return $null
        }
        Add-Failure 'BackupManifestPath is required. Use -AllowMissingManifest only with documented operator approval.'
        return $null
    }

    $manifestFile = Resolve-ExistingFile -PathValue $PathValue -Label 'BackupManifestPath'
    if (-not $manifestFile) {
        return $null
    }

    try {
        $manifest = Get-Content -LiteralPath $manifestFile -Raw | ConvertFrom-Json -ErrorAction Stop
    }
    catch {
        Add-Failure 'Backup manifest is not valid JSON.'
        return $null
    }

    $createdAtText = $null
    foreach ($fieldName in @('backup_created_at', 'created_at')) {
        if ($manifest.PSObject.Properties.Name -contains $fieldName) {
            $createdAtText = [string]$manifest.$fieldName
            break
        }
    }
    if ([string]::IsNullOrWhiteSpace($createdAtText)) {
        Add-Failure 'Backup manifest needs backup_created_at in ISO-8601 UTC form.'
    }
    else {
        try {
            $createdAt = [DateTimeOffset]::Parse($createdAtText, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AssumeUniversal)
            $ageHours = (([DateTimeOffset]::UtcNow - $createdAt.ToUniversalTime()).TotalHours)
            if ($ageHours -lt 0 -or $ageHours -gt $MaximumAgeHours) {
                Add-Failure "Backup manifest age ($([Math]::Round($ageHours, 1)) hours) is outside the permitted 0-$MaximumAgeHours hour window."
            }
        }
        catch {
            Add-Failure 'Backup manifest backup_created_at is not a valid ISO-8601 timestamp.'
        }
    }

    $encrypted = $manifest.encrypted
    if ($encrypted -isnot [bool] -or -not $encrypted) {
        Add-Failure 'Backup manifest must set encrypted to the JSON boolean true.'
    }
    if (-not ($manifest.PSObject.Properties.Name -contains 'restore_reference') -or [string]::IsNullOrWhiteSpace([string]$manifest.restore_reference)) {
        Add-Failure 'Backup manifest needs a non-secret restore_reference (for example a change ticket or backup job ID).'
    }

    return [ordered]@{
        manifest_present = $true
        restore_reference = if ($manifest.PSObject.Properties.Name -contains 'restore_reference') { [string]$manifest.restore_reference } else { $null }
    }
}

function Write-VerificationReport {
    param(
        [Parameter(Mandatory = $true)][string]$DestinationPath,
        [Parameter(Mandatory = $true)][hashtable]$Payload,
        [switch]$PermitOverwrite
    )

    if (-not [System.IO.Path]::IsPathRooted($DestinationPath)) {
        throw 'ReportPath must be an absolute path.'
    }
    $resolvedDestination = [System.IO.Path]::GetFullPath($DestinationPath)
    if ((Test-Path -LiteralPath $resolvedDestination) -and -not $PermitOverwrite) {
        throw 'ReportPath already exists. Use a dated filename or -OverwriteReport.'
    }
    $destinationDirectory = Split-Path -Parent $resolvedDestination
    if (-not (Test-Path -LiteralPath $destinationDirectory -PathType Container)) {
        [void](New-Item -ItemType Directory -Path $destinationDirectory -Force)
    }
    $json = $Payload | ConvertTo-Json -Depth 6
    [System.IO.File]::WriteAllText($resolvedDestination, $json + [Environment]::NewLine, [System.Text.UTF8Encoding]::new($false))
    return $resolvedDestination
}

Write-Host 'Smart Skin AI backup restore verification' -ForegroundColor Cyan

$liveDatabase = Resolve-ExistingFile -PathValue $LiveDatabasePath -Label 'LiveDatabasePath'
$restoredDatabase = Resolve-ExistingFile -PathValue $RestoredDatabasePath -Label 'RestoredDatabasePath'
$restoredUploads = Resolve-ExistingDirectory -PathValue $RestoredUploadFolder -Label 'RestoredUploadFolder'

if ($liveDatabase -and $restoredDatabase -and $liveDatabase.Equals($restoredDatabase, [StringComparison]::OrdinalIgnoreCase)) {
    Add-Failure 'RestoredDatabasePath is the live database path. Restore only into an isolated, non-production location.'
}

$liveDataDirectory = if ($liveDatabase) { Split-Path -Parent $liveDatabase } else { $null }
$restoredDatabaseDirectory = if ($restoredDatabase) { Split-Path -Parent $restoredDatabase } else { $null }
if ($liveDataDirectory -and $restoredDatabase -and (Test-PathWithinRoot -CandidatePath $restoredDatabase -RootPath $liveDataDirectory)) {
    Add-Failure 'RestoredDatabasePath is inside the live data directory. Restore only into an isolated, non-production location.'
}
if ($liveDataDirectory -and $restoredUploads -and (Test-PathWithinRoot -CandidatePath $restoredUploads -RootPath $liveDataDirectory)) {
    Add-Failure 'RestoredUploadFolder is inside the live data directory. Use an isolated restore location.'
}

# Fail before writing if a supposedly non-sensitive verification report would
# land beside live or restored health data.
$reportDestination = Resolve-SafeReportPath -DestinationPath $ReportPath -ExcludedRoots @(
    $liveDataDirectory,
    $restoredDatabaseDirectory,
    $restoredUploads
)

$pythonCommand = Get-Command $PythonPath -ErrorAction SilentlyContinue
if ($null -eq $pythonCommand) {
    Add-Failure 'PythonPath does not resolve to a Python executable.'
}

$manifestSummary = Test-BackupManifest -PathValue $BackupManifestPath -MaximumAgeHours $MaximumBackupAgeHours -PermitMissingManifest:$AllowMissingManifest
$sqliteTableCount = $null
$uploadSummary = $null
if ($script:Failures.Count -eq 0 -and $pythonCommand -and $restoredDatabase) {
    $sqliteTableCount = Test-SqliteIntegrityReadOnly -ResolvedPythonPath $pythonCommand.Source -DatabasePath $restoredDatabase
}
if ($script:Failures.Count -eq 0 -and $restoredUploads) {
    $uploadSummary = Get-RestoredUploadSummary -UploadFolder $restoredUploads
}

$walSidecars = @()
if ($restoredDatabase) {
    $walSidecars = @("$restoredDatabase-wal", "$restoredDatabase-shm") | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf }
    if ($walSidecars.Count -gt 0) {
        Add-Warning 'Restored SQLite WAL/SHM sidecar files were found. Confirm the backup product restores SQLite consistently; the read-only integrity check passed only for the resulting copy.'
    }
}

$report = [ordered]@{
    report_type = 'smart-skin-backup-restore-verification'
    checked_at_utc = [DateTimeOffset]::UtcNow.ToString('o')
    passed = ($script:Failures.Count -eq 0)
    restored_database_integrity = if ($null -ne $sqliteTableCount) { 'ok' } else { 'not_verified' }
    restored_database_table_count = $sqliteTableCount
    restored_upload_summary = $uploadSummary
    backup_manifest = $manifestSummary
    wal_sidecars_detected = ($walSidecars.Count -gt 0)
    warnings = @($script:Warnings)
    failures = @($script:Failures)
    limitations = @(
        'This check does not decrypt, create, alter, or start a backup.',
        'A pass does not prove backup key custody, off-host replication, retention, completeness, or encryption at the backup provider.',
        'The report intentionally omits database rows, image filenames, locations, tokens, passwords, and cryptographic material.'
    )
}

$writtenReport = Write-VerificationReport -DestinationPath $reportDestination -Payload $report -PermitOverwrite:$OverwriteReport
Write-Host "Verification report written to $writtenReport"

if ($script:Failures.Count -gt 0) {
    throw "Backup restore verification failed with $($script:Failures.Count) issue(s). Do not treat this restore as launch-ready."
}

Write-Host 'PASS: restored data is readable and SQLite integrity checks passed. Review the report and retain the linked restore evidence.' -ForegroundColor Green
