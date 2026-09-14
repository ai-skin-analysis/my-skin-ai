# Production release checklist for health data

This project starts in a safe, non-production mode. Set `SMART_SKIN_ENV=production`
only after every item below is complete. The application refuses to start unless
HTTPS, an explicit retention period, encrypted data/backups acknowledgement, and
health-data paths outside the project directory are configured.

## Infrastructure

1. Serve through a maintained WSGI server and TLS-terminating reverse proxy.
2. Place `SMART_SKIN_DATABASE` and `SMART_SKIN_UPLOAD_FOLDER` on encrypted,
   access-controlled storage outside the deployed code directory. Keep backups
   encrypted and test restoration.
3. Set a unique `FLASK_SECRET_KEY` and a separately generated
   `SMART_SKIN_MFA_ENCRYPTION_KEY`; never reuse `.env.example` values or commit
   secrets. Use a managed secret store in the deploy environment. The MFA key
   encrypts administrator TOTP seeds and requires a controlled rotation plan.
4. Configure edge/WAF rate limits in addition to the app's persistent limits,
   centralised logs, alerts, vulnerability scans, and regular patching.
5. Assign least-privilege administrator accounts, review `audit_logs`, and
   document incident response and data-subject request processes.
6. Configure `SMART_SKIN_PUBLIC_BASE_URL` and a transactional SMTP account in
   the deployment secret store. Password recovery uses a 30-minute, one-time
   email link; never replace it with a dashboard that exposes user passwords.

## Model release gate

สำหรับ release 50 โรคและเหตุผลที่ไฟล์เดิม 6 คลาสเปิดเป็น 50 โรคไม่ได้ ดู [MODEL_50_CLASS_RELEASE.md](MODEL_50_CLASS_RELEASE.md)

The production app accepts a model only when its metadata has all of the
following, the model file checksum matches it, and a separate
`SMART_SKIN_MODEL_EVALUATION_MANIFEST` passes integrity validation against the
exact model and metadata:

- dataset provenance manifest and input domain (`clinical` or `dermoscopic`);
- independent, patient/lesion-disjoint evaluation with per-class metrics;
- calibration/OOD validation for the abstention thresholds; and
- a recorded intended-use approval by the responsible clinical reviewer; and
- an immutable evidence-file SHA-256 recorded in the metadata, so a reviewed
  evaluation file cannot be silently replaced after review.

The bundled legacy six-class model fails this gate. It must not be used for
patient screening. A catalog label, a training run, or a high softmax score is
not evidence of clinical performance.

## Admin candidate training

The Admin dashboard can start one candidate-training worker after the curated
50-class dataset passes its image-count, provenance, and duplicate-content
checks. Its validation accuracy and lowest per-class recall are development
metrics only, not an independent clinical evaluation. Candidate training is
disabled in production unless `SMART_SKIN_ALLOW_ADMIN_TRAINING=1`; store its
artifacts in the external encrypted `SMART_SKIN_TRAINING_CANDIDATE_FOLDER`.

## Operations

- Health-image retention defaults to 30 days in development and must be set
  explicitly in production. The app purges expired scan records/files during
  normal traffic; schedule a daily health check so cleanup is not delayed when
  the site has no visitors. A scheduler may run:

  ```powershell
  .\.venv\Scripts\python.exe manage.py purge-expired-scans
  ```
  The same command also retries deletion of private profile-avatar files that
  were temporarily locked after replacement, removal, or account deletion.
- Nearby environmental context is opt-in for regular users. In production set
  `SMART_SKIN_LOCATION_CONTEXT_RETENTION_HOURS` explicitly (1–168); the app
  stores only the latest coarse grid location plus public environmental readings
  and deletes it at expiry or when the user deletes it.
- Review any file in `private_uploads` that has no corresponding scan record
  before deleting it. Do not reuse unprovenanced data archives for training.
- Complete a jurisdiction-specific privacy, security, and clinical governance
  review. This technical checklist does not itself confer legal or medical
  certification.
- Enrol MFA for every administrator using an Authenticator app, retain a tested
  two-admin recovery procedure, and review MFA enable/disable/recovery audit
  events. The dashboard never displays passwords or TOTP seeds. Production
  refuses `SMART_SKIN_ADMIN_PASSWORD`; use `manage.py create-admin --enroll-mfa`
  from a controlled console before starting a screening service.
