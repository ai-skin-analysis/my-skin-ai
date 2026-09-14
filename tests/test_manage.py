import sqlite3
import tempfile
import unittest
import os
from pathlib import Path
from unittest.mock import patch

from cryptography.fernet import Fernet

import manage


class TestRetentionScheduler(unittest.TestCase):
    def test_scheduler_retries_only_queued_application_profile_avatars(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            database_path = root / 'users.db'
            upload_path = root / 'private-uploads'
            upload_path.mkdir()
            avatar_name = 'profile_' + ('b' * 32) + '.jpg'
            avatar_path = upload_path / avatar_name
            avatar_path.write_bytes(b'normalized-profile-avatar')

            conn = sqlite3.connect(database_path)
            conn.execute(
                '''CREATE TABLE scan_logs (
                    id INTEGER PRIMARY KEY,
                    image_path TEXT,
                    gradcam_path TEXT,
                    retention_expires_at TEXT
                )'''
            )
            conn.execute(
                '''CREATE TABLE profile_avatar_deletion_queue (
                    image_path TEXT PRIMARY KEY,
                    queued_at TEXT NOT NULL
                )'''
            )
            conn.execute(
                'INSERT INTO profile_avatar_deletion_queue (image_path, queued_at) VALUES (?, ?)',
                (avatar_name, '2026-09-04T00:00:00+00:00'),
            )
            conn.commit()
            conn.close()

            with patch.object(manage, 'DATABASE_PATH', database_path), patch.object(manage, 'UPLOAD_PATH', upload_path):
                manage.purge_expired_scans()

            self.assertFalse(avatar_path.exists())
            conn = sqlite3.connect(database_path)
            self.assertEqual(conn.execute('SELECT COUNT(*) FROM profile_avatar_deletion_queue').fetchone()[0], 0)
            conn.close()

    def test_scheduler_does_not_touch_non_avatar_queue_names(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            database_path = root / 'users.db'
            upload_path = root / 'private-uploads'
            upload_path.mkdir()
            unrelated_name = 'scan-private-image.png'
            unrelated_path = upload_path / unrelated_name
            unrelated_path.write_bytes(b'private-scan-image')

            conn = sqlite3.connect(database_path)
            conn.execute(
                '''CREATE TABLE scan_logs (
                    id INTEGER PRIMARY KEY,
                    image_path TEXT,
                    gradcam_path TEXT,
                    retention_expires_at TEXT
                )'''
            )
            conn.execute(
                '''CREATE TABLE profile_avatar_deletion_queue (
                    image_path TEXT PRIMARY KEY,
                    queued_at TEXT NOT NULL
                )'''
            )
            conn.execute(
                'INSERT INTO profile_avatar_deletion_queue (image_path, queued_at) VALUES (?, ?)',
                (unrelated_name, '2026-09-04T00:00:00+00:00'),
            )
            conn.commit()
            conn.close()

            with patch.object(manage, 'DATABASE_PATH', database_path), patch.object(manage, 'UPLOAD_PATH', upload_path):
                manage.purge_expired_scans()

            self.assertTrue(unrelated_path.exists())
            conn = sqlite3.connect(database_path)
            self.assertEqual(conn.execute('SELECT COUNT(*) FROM profile_avatar_deletion_queue').fetchone()[0], 1)
            conn.close()

    def test_verify_model_release_writes_an_integrity_report_without_activation(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            report_path = root / 'evidence-report.json'
            with patch(
                'validate_model_evaluation.validate_paths',
                return_value={'evidence_format_valid': True, 'human_review_required': True},
            ):
                manage.verify_model_release(
                    root / 'candidate.h5',
                    root / 'candidate.metadata.json',
                    root / 'candidate.evidence.json',
                    root / 'catalog.json',
                    report_path,
                )
            report = report_path.read_text(encoding='utf-8')
            self.assertIn('evidence_format_valid', report)
            self.assertIn('human_review_required', report)


class TestControlledAdminProvisioning(unittest.TestCase):
    def _create_admin_schema(self, database_path):
        conn = sqlite3.connect(database_path)
        conn.execute(
            '''CREATE TABLE users (
                id INTEGER PRIMARY KEY,
                name TEXT NOT NULL,
                email TEXT NOT NULL UNIQUE,
                password TEXT NOT NULL,
                role TEXT NOT NULL,
                is_approved INTEGER NOT NULL,
                auth_epoch INTEGER NOT NULL DEFAULT 0
            )'''
        )
        conn.execute(
            '''CREATE TABLE admin_mfa_credentials (
                user_id INTEGER PRIMARY KEY,
                secret_ciphertext TEXT NOT NULL,
                enabled_at TEXT NOT NULL,
                last_used_counter INTEGER,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )'''
        )
        conn.execute('CREATE TABLE admin_mfa_enrollments (user_id INTEGER PRIMARY KEY)')
        conn.execute('CREATE TABLE admin_mfa_login_challenges (user_id INTEGER PRIMARY KEY)')
        conn.commit()
        conn.close()

    def test_production_admin_mfa_enrollment_is_confirmed_and_encrypted(self):
        with tempfile.TemporaryDirectory() as directory:
            database_path = Path(directory) / 'users.db'
            self._create_admin_schema(database_path)
            key = Fernet.generate_key().decode('ascii')

            with (
                patch.object(manage, 'DATABASE_PATH', database_path),
                patch.object(manage, 'getpass', side_effect=['Password12345', 'Password12345', '123456']),
                patch.object(manage, 'generate_admin_totp_secret', return_value='JBSWY3DPEHPK3PXP'),
                patch.object(manage, 'verify_admin_totp_secret', return_value=123456),
                patch('builtins.print'),
                patch.dict(os.environ, {
                    'SMART_SKIN_ENV': 'production',
                    'SMART_SKIN_MFA_ENCRYPTION_KEY': key,
                }, clear=False),
            ):
                manage.create_admin('security-admin@example.com', enroll_mfa=True)

            conn = sqlite3.connect(database_path)
            row = conn.execute(
                '''SELECT users.role, users.is_approved, credentials.secret_ciphertext, credentials.last_used_counter
                   FROM users JOIN admin_mfa_credentials AS credentials ON credentials.user_id = users.id
                   WHERE users.email = ?''',
                ('security-admin@example.com',),
            ).fetchone()
            conn.close()
            self.assertEqual(row[0], 'admin')
            self.assertEqual(row[1], 1)
            self.assertNotEqual(row[2], 'JBSWY3DPEHPK3PXP')
            self.assertEqual(Fernet(key.encode('ascii')).decrypt(row[2].encode('ascii')).decode('ascii'), 'JBSWY3DPEHPK3PXP')
            self.assertEqual(row[3], 123456)

    def test_production_admin_provisioning_refuses_password_only_before_prompting(self):
        with patch.object(manage, 'getpass') as prompt, patch.dict(
            os.environ, {'SMART_SKIN_ENV': 'production'}, clear=False,
        ):
            with self.assertRaisesRegex(ValueError, 'requires --enroll-mfa'):
                manage.create_admin('security-admin@example.com')
        prompt.assert_not_called()


if __name__ == '__main__':
    unittest.main()
