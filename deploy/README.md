# Windows production service package

These files provide an operational starting point for a **single-instance**
Smart Skin AI deployment on Windows. They do not deploy a domain, obtain a
certificate, configure a secret store, turn on disk encryption, or approve the
clinical model. Complete the root [public release runbook](../PUBLIC_RELEASE_RUNBOOK.md)
and [production checklist](../PRODUCTION_DEPLOYMENT.md) before public DNS is
pointed at the service.

## Files

- `Start-SmartSkinProduction.ps1` runs Waitress in the foreground on
  `127.0.0.1:8080` only. It has no public-bind option by design.
- `Test-SmartSkinProductionReadiness.ps1` validates production environment
  values without printing their secret contents, checks external data paths,
  checks for broad write ACLs, attempts a BitLocker volume check, and imports
  the WSGI application as the service identity.
- `Caddyfile.example` terminates TLS and proxies only to loopback Waitress.
  It strips client-provided forwarding headers before setting the one trusted
  proxy hop expected by the application.
- `SmartSkinAI.Service.xml.example` is a WinSW service-wrapper example. WinSW
  is not bundled; obtain and verify it through the organisation's approved
  software-distribution process.

## Prepare a service account and protected folders

Use a dedicated non-interactive Windows service identity, not an administrator
or `LocalSystem`. Deploy source code read-only for that identity. Create data
folders outside the repository on a volume protected by BitLocker (or another
approved encryption-at-rest control), then grant only the service identity and
named backup operators the minimum rights needed.

Example layout only — choose paths approved by your organisation:

```text
C:\Apps\SmartSkinAI\                         # deployed code, read-only to service
D:\SmartSkinData\users.db                    # encrypted-volume database
D:\SmartSkinData\private-uploads\            # encrypted-volume uploads
D:\SmartSkinData\candidate-models\           # only if candidate training is enabled
C:\ProgramData\SmartSkinAI\logs\             # protected operational logs
```

Do **not** treat `SMART_SKIN_DATA_ENCRYPTION_AT_REST_CONFIRMED=1` or a passing
BitLocker check as proof that all data and backups are secure. The confirmation
is an accountable operator attestation; verify recovery-key custody, backup
encryption, restore tests, and ACL inheritance separately.

## Supply environment values securely

Configure required variables for the service account with an approved secret
manager or deployment system. Do not use a checked-in `.env`, service XML,
task arguments, or logs for passwords, Flask secrets, database contents, or
SMTP credentials. Start from [`.env.example`](../.env.example) only as a field
list.

For the currently permitted **public-information mode**, the service needs
these production values at minimum:

```text
SMART_SKIN_ENV=production
FLASK_HTTPS=1
FLASK_SECRET_KEY=<secret-store value>
SMART_SKIN_ALLOWED_HOSTS=hucksmartskinai.com
SMART_SKIN_TRUSTED_PROXY_HOPS=1
SMART_SKIN_PUBLIC_BASE_URL=https://hucksmartskinai.com
SMART_SKIN_DATA_CONTROLLER_NAME=<legal controller name>
SMART_SKIN_PRIVACY_CONTACT=<privacy/DPO contact>
SMART_SKIN_PRIVACY_PROCESSORS_REVIEWED=1
SMART_SKIN_INCIDENT_RESPONSE_CONFIRMED=1
SMART_SKIN_PUBLIC_INFORMATION_MODE=1
```

Before any future private-data/screening release, add the encrypted database,
upload folder, backup/retention confirmations, SMTP values and a separate
`SMART_SKIN_MFA_ENCRYPTION_KEY` listed in `.env.example`. Generate the MFA key
once with `Fernet.generate_key()`, retain it separately from the Flask session
key, and do not rotate it without an approved re-enrollment plan. The model
release gate and clinical approvals are separately mandatory.

## Validate before starting

Open an elevated deployment console as the intended service identity where
possible, load the production environment values from the secret manager, then
run:

```powershell
Set-Location C:\Apps\SmartSkinAI
.\deploy\Test-SmartSkinProductionReadiness.ps1 -ServiceAccount 'NT SERVICE\SmartSkinAI' -PublicInformationMode
```

For a future private-data/screening mode, omit `-PublicInformationMode`; the
check then verifies external encrypted storage and fails if it cannot verify
BitLocker status. If that host uses an approved encryption mechanism that
PowerShell cannot inspect, retain manual evidence and use the deliberately
explicit exception:

```powershell
.\deploy\Test-SmartSkinProductionReadiness.ps1 -ServiceAccount 'NT SERVICE\SmartSkinAI' -AllowUnverifiedVolumeEncryption
```

That switch creates a warning; it does not assert that storage is encrypted.
Never use it merely to make the check pass.

## Run the service and proxy

1. Install the project requirements into the production Python environment.
2. Put a reviewed Caddy configuration into Caddy's protected configuration
   location. The included configuration is set to `hucksmartskinai.com`.
   Set `CADDY_ACME_EMAIL` to the operations mailbox in the protected Caddy
   service environment, then validate before reloading:

   ```powershell
   caddy validate --config C:\ProgramData\Caddy\Caddyfile --adapter caddyfile
   ```

3. Block inbound access to TCP 8080 at Windows Firewall and every external
   firewall. Permit only HTTPS (and HTTP only where Caddy needs it for the
   certificate redirect/challenge). Caddy must be the only path to Waitress.
4. Use a service wrapper such as WinSW. Copy the XML example next to a verified
   WinSW executable, replace `C:\Apps\SmartSkinAI`, configure the restricted
   service identity, then install/start it using the wrapper's documented
   commands. The runner stays in the foreground so the wrapper can monitor and
   restart it. For the current education-only release, pass
   `-PublicInformationMode` to `Start-SmartSkinProduction.ps1` and set
   `SMART_SKIN_PUBLIC_INFORMATION_MODE=1` in the service environment.
5. Verify externally that `https://hucksmartskinai.com` works and that
   `http://hucksmartskinai.com` redirects to HTTPS. Verify `:8080` is not
   reachable from another machine.

The included Caddy active health probe requests `/healthz`, a fixed
session-free liveness response. Use `/readyz` only from a protected monitoring
path when checking database/storage readiness for the configured release mode;
neither probe exposes model, account, path, or health-record details.

## Ongoing operations

- Run `manage.py purge-expired-scans` daily as the restricted service identity
  and alert if it fails. It also retries deletion of profile-avatar files that
  were temporarily locked after a user replaced, removed, or deleted an account.
- Patch Windows, Caddy, Python and application dependencies on a defined
  cadence. Review access/audit logs without storing image bodies, passwords or
  precise locations.
- Re-run the preflight after changing service identity, storage, proxy, secrets
  or host names; test an encrypted backup restore before every release.
- Do not run multiple independent Waitress instances against the SQLite
  database. A multi-instance release requires a reviewed database migration.
