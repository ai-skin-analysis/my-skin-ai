# Public release runbook

This file is the operational gate for a public health-data deployment. Completing
the infrastructure items does **not** approve the model for patient screening.

## 1. Choose the permitted release mode

- **Public information mode:** publish only the landing page, general
  skin-health information, optional consented environmental information, and
  public health probes. Registration, sign-in, private routes, image upload,
  image analysis, and account data are blocked at the application layer.
- **Research / invite-only mode:** use only under an approved research protocol,
  separate consent and access controls. Do not describe outputs as diagnosis.
- **Public screening mode:** permitted only after the model release gate in
  `MODEL_50_CLASS_RELEASE.md` has passed. The current bundled six-class artifact
  does not pass it.

## 2. Build the permitted service

1. Install the exact dependencies, including Waitress:

   ```powershell
   .\.venv\Scripts\python.exe -m pip install -r requirements.txt
   ```

2. Every public mode uses a patched host, HTTPS and a secret store / service
   account. Never commit these values:

   ```text
    SMART_SKIN_ENV=production
    FLASK_HTTPS=1
    FLASK_SECRET_KEY=<long random secret>
    SMART_SKIN_ALLOWED_HOSTS=skin.example.com,www.skin.example.com
    SMART_SKIN_TRUSTED_PROXY_HOPS=1
    SMART_SKIN_DATA_CONTROLLER_NAME=<legal controller name>
    SMART_SKIN_PRIVACY_CONTACT=<privacy/DPO contact>
    SMART_SKIN_PRIVACY_PROCESSORS_REVIEWED=1
    SMART_SKIN_INCIDENT_RESPONSE_CONFIRMED=1
    SMART_SKIN_PUBLIC_INFORMATION_MODE=1
    ```

   Public-information mode does not initialise a user database or upload
   directory, and therefore does not need SMTP, MFA, retention or health-data
   storage settings. It blocks all account and image routes even if a visitor
   knows an older URL.

3. **Only after a separate screening-release approval** add the private
   data, SMTP and MFA settings below. The current bundled model is not
   approved for this mode:

   ```text
   SMART_SKIN_MFA_ENCRYPTION_KEY=<separate Fernet key in the secret store>
   SMART_SKIN_DATABASE=<absolute encrypted path outside this repository>
   SMART_SKIN_UPLOAD_FOLDER=<absolute encrypted path outside this repository>
   SMART_SKIN_RETENTION_DAYS=30
   SMART_SKIN_LOCATION_CONTEXT_RETENTION_HOURS=24
   SMART_SKIN_DATA_ENCRYPTION_AT_REST_CONFIRMED=1
   SMART_SKIN_BACKUPS_ENCRYPTED_CONFIRMED=1
   SMART_SKIN_RETENTION_SCHEDULER_CONFIRMED=1
   SMART_SKIN_PUBLIC_BASE_URL=https://skin.example.com
   SMART_SKIN_SMTP_HOST=<transactional SMTP host>
   SMART_SKIN_SMTP_PORT=587
   SMART_SKIN_SMTP_USERNAME=<SMTP account>
   SMART_SKIN_SMTP_PASSWORD=<SMTP app password>
   SMART_SKIN_SMTP_FROM=<verified sender address>
   SMART_SKIN_SMTP_STARTTLS=1
   SMART_SKIN_PUBLIC_INFORMATION_MODE=0
   ```

4. Bind Waitress only to loopback, not to `0.0.0.0`:

   ```powershell
   .\.venv\Scripts\waitress-serve.exe --host=127.0.0.1 --port=8080 wsgi:application
   ```

    In a future private-data/screening mode, the current storage adapter is
    SQLite. Run one application service against one protected database file;
    do not scale it to multiple independent app instances. A high-availability
    release requires a reviewed migration to a managed relational database.

5. Place a maintained reverse proxy/WAF in front of it. It must terminate TLS,
   redirect HTTP to HTTPS, overwrite forwarding headers, enforce request limits,
   and be the only network path to Waitress. `deploy/Caddyfile.example` is a
   starting point, not an operational approval.

## 3. Operational controls before DNS is pointed at the service

- For a future private-data/screening service, give admins unique accounts,
  enrol the built-in TOTP MFA with an Authenticator app, and do not use shared
  credentials. Keep the MFA encryption key separate from `FLASK_SECRET_KEY`.
  Do not set `SMART_SKIN_ADMIN_PASSWORD` as a long-lived secret; use
  `manage.py create-admin --email admin@example.com --enroll-mfa` from a
  controlled console instead.
- Configure WAF rate limits for registration, login, uploads and all paths;
  block abusive traffic before it reaches Flask. Validate client-IP forwarding
  with the chosen proxy before go-live. Use the provider-neutral checklist in
  [`deploy/EDGE_WAF_RATE_LIMITS.md`](deploy/EDGE_WAF_RATE_LIMITS.md); the
  Cloudflare example is a template, not a deployed policy.
- Send access/error/audit telemetry to a protected central log service. Alert on
  repeated failed logins, unexpected admin actions, upload failures and storage
  errors. Do not put image content, passwords, exact locations, or model outputs
  into logs.
- Schedule `manage.py purge-expired-scans` daily as the service identity and
  monitor failure. Test an encrypted-backup restore before launch using
  [`deploy/Test-SmartSkinBackupRestore.ps1`](deploy/Test-SmartSkinBackupRestore.ps1)
  and retain its non-sensitive result in the change record.
- Maintain an incident-response owner, a privacy/DPO contact, data-subject
  request handling, vendor/processor agreements, and a process for vulnerability
  patches and dependency scanning.

## 4. Release verification

Run the test suite in the deployed environment, then verify:

1. HTTP redirects to HTTPS; the direct `:8080` port is unreachable externally.
   The public `GET /healthz` must return exactly `200`. `GET /readyz` is a
   loopback/protected monitoring endpoint only and must not be reachable from
   the public proxy.
2. Unapproved Host headers are rejected; `Secure`, `HttpOnly`, and `SameSite`
   session flags appear on HTTPS responses.
3. One user cannot fetch another user's `/scan-images/...` resource.
4. Expired scan images and Grad-CAM images are removed by the scheduler.
5. A user can delete scans and permanently delete their own account; admin
   actions are audited.
6. Password reset email arrives only at the registered address; its link expires
   after 30 minutes, works once, and invalidates existing sessions after a reset.
7. A new production account must confirm the one-time email-verification link
   before an approved account can sign in; test the resend flow as well.
8. After enrolling an administrator in MFA, password-only login must stop at the
   MFA challenge; a valid one-time code must work once, replay must fail, and a
   second administrator must complete the documented recovery test.
9. The public privacy notice correctly names the controller/contact and external
   services. Recheck it whenever a vendor, retention period or purpose changes.
10. The model release gate is still enforced. Do not bypass it by changing labels,
   metadata, or an environment flag. A screening release must configure
   `SMART_SKIN_MODEL_EVALUATION_MANIFEST`, whose file hash is bound to the
   exact candidate metadata and model artifact.

## 5. Model gate that cannot be replaced by infrastructure

Before enabling patient-image screening, collect the approved 50-class dataset
with provenance; perform patient/lesion-disjoint independent evaluation by
image modality and relevant population groups; calibrate thresholds; validate
out-of-distribution rejection; document intended use and limitations; and obtain
recorded approval from the accountable clinical reviewer. Record post-release
monitoring, rollback and user-redress processes as well.
