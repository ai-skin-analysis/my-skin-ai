"""Process-level checks for the publishable no-health-data release mode."""

import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]


class TestProductionPublicInformationMode(unittest.TestCase):
    def test_public_information_mode_starts_without_private_service_dependencies(self):
        """A public educational release must not create health-data storage."""
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            database_path = root / 'should-not-exist' / 'users.db'
            upload_path = root / 'should-not-exist' / 'private-uploads'
            environment = os.environ.copy()
            for name in (
                'SMART_SKIN_MFA_ENCRYPTION_KEY',
                'SMART_SKIN_PUBLIC_BASE_URL',
                'SMART_SKIN_SMTP_HOST',
                'SMART_SKIN_SMTP_PORT',
                'SMART_SKIN_SMTP_USERNAME',
                'SMART_SKIN_SMTP_PASSWORD',
                'SMART_SKIN_SMTP_FROM',
                'SMART_SKIN_SMTP_STARTTLS',
                'SMART_SKIN_RETENTION_DAYS',
                'SMART_SKIN_LOCATION_CONTEXT_RETENTION_HOURS',
                'SMART_SKIN_DATA_ENCRYPTION_AT_REST_CONFIRMED',
                'SMART_SKIN_BACKUPS_ENCRYPTED_CONFIRMED',
                'SMART_SKIN_RETENTION_SCHEDULER_CONFIRMED',
                'SMART_SKIN_ALLOW_ADMIN_TRAINING',
                'SMART_SKIN_ADMIN_EMAIL',
                'SMART_SKIN_ADMIN_PASSWORD',
            ):
                environment.pop(name, None)
            environment.update({
                'SMART_SKIN_ENV': 'production',
                'FLASK_HTTPS': '1',
                'FLASK_SECRET_KEY': 'test-only-process-secret-not-for-deployment',
                'SMART_SKIN_ALLOWED_HOSTS': 'skin.example.test',
                'SMART_SKIN_TRUSTED_PROXY_HOPS': '1',
                'SMART_SKIN_DATA_CONTROLLER_NAME': 'Test Controller',
                'SMART_SKIN_PRIVACY_CONTACT': 'privacy@example.test',
                'SMART_SKIN_PRIVACY_PROCESSORS_REVIEWED': '1',
                'SMART_SKIN_INCIDENT_RESPONSE_CONFIRMED': '1',
                'SMART_SKIN_PUBLIC_INFORMATION_MODE': '1',
                # These intentionally point to absent paths.  Public mode may
                # receive them from a shared deployment environment but must
                # neither create nor initialise either private store.
                'SMART_SKIN_DATABASE': str(database_path),
                'SMART_SKIN_UPLOAD_FOLDER': str(upload_path),
            })
            result = subprocess.run(
                [
                    sys.executable,
                    '-c',
                    'import app; print("public=" + str(app.PUBLIC_INFORMATION_MODE).lower())',
                ],
                cwd=PROJECT_ROOT,
                env=environment,
                text=True,
                capture_output=True,
                timeout=90,
                check=False,
            )

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn('public=true', result.stdout)
            self.assertFalse(database_path.exists())
            self.assertFalse(upload_path.exists())


if __name__ == '__main__':
    unittest.main()
