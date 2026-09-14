# Encrypted backup and restore verification

This runbook is for the service owner and backup operator. It does not create a
backup product, encryption key, storage account, or regulatory approval. It
verifies that an operator-restored **non-production** copy of the Smart Skin AI
data is readable without exposing patient-image contents.

## Non-negotiable controls

- Use a backup product approved by the organisation that encrypts data before
  it leaves the protected environment and has separately controlled recovery
  keys. Do not put encryption passwords in this repository, a task argument,
  Event Viewer, or a restore report.
- Back up the SQLite database consistently. A filesystem copy made while
  SQLite is writing is not sufficient. Use the backup product's application
  consistent mode or make a SQLite backup/checkpoint first under an approved
  procedure.
- Include the private uploads folder in the same recoverable scope as the
  database. The database alone cannot restore retained scan artifacts, and the
  folder alone has no ownership/retention records.
- Restore to a quarantined path and never start Waitress or the application
  against that copy. The restore must not reuse the live database path,
  uploads path, service identity, public hostname, or SMTP credentials.
- Retain a change ticket, backup job ID, operator, time, source backup
  identifier, and deletion date for the test evidence. Those records are not
  stored by this repository.

## Backup manifest contract

Have the approved backup workflow write a small JSON file next to the restored
test copy. It contains operational evidence, not secrets or personal data:

```json
{
  "backup_created_at": "2026-09-07T02:15:00Z",
  "encrypted": true,
  "restore_reference": "CHG-1234 / backup-job-20260907-0215"
}
```

`encrypted` must be the JSON boolean `true`; a text value such as `"true"` is
intentionally rejected. Do not include archive passwords, key IDs if they are
sensitive, user records, image paths, raw hashes of health files, locations,
tokens, or email addresses in this manifest.

## Restore-test procedure

1. Create a change record and identify the isolated restore host/path.
2. Use the approved backup product to restore the database, private uploads,
   and the manifest to the isolated path. Do not mount a backup writable.
3. Confirm the restored database and uploads are both outside the live data
   directory. The script also checks for the stable Smart Skin core SQLite
   schema, so an empty or unrelated SQLite file cannot pass as a restore.
4. Run the check using a restricted operator account. Use an unused, dated
   report path outside the restored data itself:

   ```powershell
   .\deploy\Test-SmartSkinBackupRestore.ps1 `
     -LiveDatabasePath 'D:\SmartSkinData\users.db' `
     -RestoredDatabasePath 'E:\RestoreTest\2026-09-07\users.db' `
     -RestoredUploadFolder 'E:\RestoreTest\2026-09-07\private-uploads' `
     -BackupManifestPath 'E:\RestoreTest\2026-09-07\backup-manifest.json' `
     -ReportPath 'E:\RestoreEvidence\2026-09-07.json'
   ```

5. Require exit code `0`, inspect the small JSON report, and attach it to the
   change record. A failure blocks release until it is investigated and the
   restore test is rerun.
6. Have the privacy/security owner decide when to securely remove the restored
   copy and report. Record that deletion in the change record; do not leave
   health images on a test host indefinitely.

## What the verification proves and does not prove

The script opens the restored SQLite file read-only, verifies the stable core
schema (`users`, `scan_logs`, `audit_logs`), performs SQLite `quick_check`,
`integrity_check`, and `foreign_key_check`, and records only a table count plus
upload-file count/bytes. It does **not** open image contents.

A pass does not prove key custody, encrypted transit, off-host replication,
complete retention history, backup-provider configuration, clinical safety, or
legal compliance. The service owner must test this at least before public
launch, after a backup-provider/key/storage change, and on a documented
periodic schedule appropriate to the recovery objectives.
