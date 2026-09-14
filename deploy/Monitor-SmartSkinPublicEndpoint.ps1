[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [uri]$PublicBaseUrl,

    # Optional HTTP URL used to confirm that public HTTP redirects to HTTPS.
    [uri]$HttpUrl,

    [ValidateRange(1, 120)]
    [int]$TimeoutSeconds = 15,

    # Use the public /healthz endpoint by default in the scheduled task. A
    # redirect or a generic landing-page response is not proof of liveness.
    [ValidateRange(100, 599)]
    [int]$ExpectedStatusCode = 200,

    # Optional protected destination for a compact monitoring result. No
    # response body, cookie values, query string, image, token, or location is
    # written to this report.
    [string]$ReportPath,

    [switch]$OverwriteReport,

    # Enable when the checked response is expected to create a Flask session.
    # It verifies attributes without retaining the cookie value.
    [switch]$RequireSessionCookieFlags
)

<#!
.SYNOPSIS
Runs a privacy-minimised synthetic HTTPS probe for Smart Skin AI.

.DESCRIPTION
Use this from a separate monitoring host or scheduled task. It tests a public
GET response and optional HTTP-to-HTTPS redirect without uploading an image,
signing in, sending a form, following a password-reset URL, or recording the
response body. Exit code 0 means the configured checks passed; non-zero is
suitable for a monitoring agent to alert on.
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Assert-CleanUri {
    param(
        [Parameter(Mandatory = $true)][uri]$Uri,
        [Parameter(Mandatory = $true)][string]$ExpectedScheme,
        [Parameter(Mandatory = $true)][string]$Label
    )
    if ($Uri.Scheme -ne $ExpectedScheme -or [string]::IsNullOrWhiteSpace($Uri.Host) -or
        -not [string]::IsNullOrWhiteSpace($Uri.UserInfo) -or
        -not [string]::IsNullOrWhiteSpace($Uri.Query) -or
        -not [string]::IsNullOrWhiteSpace($Uri.Fragment)) {
        throw "$Label must be a clean $ExpectedScheme URL without credentials, query parameters, or fragments."
    }
}

function Invoke-HeadlessGet {
    param(
        [Parameter(Mandatory = $true)][uri]$Uri,
        [Parameter(Mandatory = $true)][int]$TimeoutInSeconds
    )

    $request = [System.Net.HttpWebRequest]::Create($Uri)
    $request.Method = 'GET'
    $request.AllowAutoRedirect = $false
    $request.Timeout = $TimeoutInSeconds * 1000
    $request.ReadWriteTimeout = $TimeoutInSeconds * 1000
    $request.UserAgent = 'SmartSkinSyntheticMonitor/1.0'
    $stopwatch = [Diagnostics.Stopwatch]::StartNew()
    try {
        $response = [System.Net.HttpWebResponse]$request.GetResponse()
    }
    catch [System.Net.WebException] {
        if ($_.Exception.Response) {
            $response = [System.Net.HttpWebResponse]$_.Exception.Response
        }
        else {
            throw "Could not reach public endpoint: $($_.Exception.Status)"
        }
    }
    finally {
        $stopwatch.Stop()
    }

    try {
        return [ordered]@{
            status_code = [int]$response.StatusCode
            elapsed_ms = [Math]::Round($stopwatch.Elapsed.TotalMilliseconds, 0)
            headers = $response.Headers
        }
    }
    finally {
        $response.Close()
    }
}

function Write-MonitorReport {
    param(
        [Parameter(Mandatory = $true)][string]$DestinationPath,
        [Parameter(Mandatory = $true)][hashtable]$Payload,
        [switch]$PermitOverwrite
    )
    if (-not [System.IO.Path]::IsPathRooted($DestinationPath)) {
        throw 'ReportPath must be an absolute path.'
    }
    $destination = [System.IO.Path]::GetFullPath($DestinationPath)
    if ((Test-Path -LiteralPath $destination) -and -not $PermitOverwrite) {
        throw 'ReportPath already exists. Use a timestamped path or -OverwriteReport.'
    }
    $directory = Split-Path -Parent $destination
    if (-not (Test-Path -LiteralPath $directory -PathType Container)) {
        [void](New-Item -ItemType Directory -Path $directory -Force)
    }
    [System.IO.File]::WriteAllText($destination, ($Payload | ConvertTo-Json -Depth 5) + [Environment]::NewLine, [System.Text.UTF8Encoding]::new($false))
    return $destination
}

Assert-CleanUri -Uri $PublicBaseUrl -ExpectedScheme 'https' -Label 'PublicBaseUrl'
if ($PSBoundParameters.ContainsKey('HttpUrl')) {
    Assert-CleanUri -Uri $HttpUrl -ExpectedScheme 'http' -Label 'HttpUrl'
    if ($HttpUrl.Host -ne $PublicBaseUrl.Host) {
        throw 'HttpUrl and PublicBaseUrl must use the same host.'
    }
}

$failures = New-Object System.Collections.Generic.List[string]
$warnings = New-Object System.Collections.Generic.List[string]
$httpsResult = Invoke-HeadlessGet -Uri $PublicBaseUrl -TimeoutInSeconds $TimeoutSeconds
$httpsHeaders = $httpsResult.headers
$httpsStatusOk = $httpsResult.status_code -eq $ExpectedStatusCode
if (-not $httpsStatusOk) {
    $failures.Add("HTTPS endpoint returned HTTP $($httpsResult.status_code); expected $ExpectedStatusCode.") | Out-Null
}

$hsts = [string]$httpsHeaders['Strict-Transport-Security']
if ($hsts -notmatch 'max-age=') {
    $failures.Add('HTTPS response is missing Strict-Transport-Security.') | Out-Null
}
if ([string]$httpsHeaders['X-Content-Type-Options'] -notmatch '(?i)^nosniff$') {
    $failures.Add('HTTPS response is missing X-Content-Type-Options: nosniff.') | Out-Null
}
if ([string]::IsNullOrWhiteSpace([string]$httpsHeaders['Content-Security-Policy'])) {
    $failures.Add('HTTPS response is missing Content-Security-Policy.') | Out-Null
}
if ([string]::IsNullOrWhiteSpace([string]$httpsHeaders['Referrer-Policy'])) {
    $failures.Add('HTTPS response is missing Referrer-Policy.') | Out-Null
}
if (-not [string]::IsNullOrWhiteSpace([string]$httpsHeaders['Server'])) {
    $warnings.Add('HTTPS response exposes a Server header; confirm the proxy removes unnecessary server identification.') | Out-Null
}

$setCookieValues = @($httpsHeaders.GetValues('Set-Cookie'))
$cookieFlagsOk = $true
if ($RequireSessionCookieFlags) {
    if ($setCookieValues.Count -eq 0) {
        $failures.Add('A session cookie was expected but no Set-Cookie header was returned.') | Out-Null
        $cookieFlagsOk = $false
    }
    else {
        $cookieFlagsOk = ($setCookieValues | Where-Object {
            $_ -match '(?i);\s*secure(?:;|$)' -and
            $_ -match '(?i);\s*httponly(?:;|$)' -and
            $_ -match '(?i);\s*samesite=strict(?:;|$)'
        }).Count -gt 0
        if (-not $cookieFlagsOk) {
            $failures.Add('A returned session cookie is missing Secure, HttpOnly, or SameSite=Strict.') | Out-Null
        }
    }
}

$httpRedirectResult = $null
if ($PSBoundParameters.ContainsKey('HttpUrl')) {
    $httpRedirectResult = Invoke-HeadlessGet -Uri $HttpUrl -TimeoutInSeconds $TimeoutSeconds
    $location = [string]$httpRedirectResult.headers['Location']
    $redirectStatusOk = $httpRedirectResult.status_code -in @(301, 302, 307, 308)
    $redirectTargetOk = $false
    try {
        if (-not [string]::IsNullOrWhiteSpace($location)) {
            $redirectUri = [uri]::new($HttpUrl, $location)
            $redirectTargetOk = $redirectUri.Scheme -eq 'https' -and $redirectUri.Host -eq $PublicBaseUrl.Host
        }
    }
    catch {
        $redirectTargetOk = $false
    }
    if (-not $redirectStatusOk -or -not $redirectTargetOk) {
        $failures.Add('HTTP endpoint does not redirect cleanly to the configured HTTPS host.') | Out-Null
    }
}

$report = [ordered]@{
    report_type = 'smart-skin-public-endpoint-synthetic-check'
    checked_at_utc = [DateTimeOffset]::UtcNow.ToString('o')
    passed = ($failures.Count -eq 0)
    public_host = $PublicBaseUrl.Host
    https = [ordered]@{
        status_code = $httpsResult.status_code
        expected_status_code = $ExpectedStatusCode
        elapsed_ms = $httpsResult.elapsed_ms
        hsts_present = -not [string]::IsNullOrWhiteSpace($hsts)
        csp_present = -not [string]::IsNullOrWhiteSpace([string]$httpsHeaders['Content-Security-Policy'])
        nosniff_present = ([string]$httpsHeaders['X-Content-Type-Options'] -match '(?i)^nosniff$')
        referrer_policy_present = -not [string]::IsNullOrWhiteSpace([string]$httpsHeaders['Referrer-Policy'])
        session_cookie_flags_checked = [bool]$RequireSessionCookieFlags
        session_cookie_flags_ok = $cookieFlagsOk
    }
    http_redirect = if ($httpRedirectResult) {
        [ordered]@{ status_code = $httpRedirectResult.status_code; elapsed_ms = $httpRedirectResult.elapsed_ms }
    } else { $null }
    warnings = @($warnings)
    failures = @($failures)
    privacy_note = 'No response body, cookie value, token, query string, image, location, or account identifier is stored.'
}

if ($ReportPath) {
    $writtenReport = Write-MonitorReport -DestinationPath $ReportPath -Payload $report -PermitOverwrite:$OverwriteReport
    Write-Host "Synthetic check report written to $writtenReport"
}

if ($failures.Count -gt 0) {
    throw "Public endpoint check failed: $($failures -join ' ' )"
}

Write-Host "PASS: HTTPS endpoint returned $($httpsResult.status_code) in $($httpsResult.elapsed_ms) ms." -ForegroundColor Green
