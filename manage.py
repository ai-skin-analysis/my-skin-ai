"""Local administration commands for Smart Skin AI."""

import argparse
import base64
import hmac
import json
import os
import re
import sqlite3
import time
from datetime import datetime
from getpass import getpass
from pathlib import Path
from urllib.parse import quote

from cryptography.fernet import Fernet
from werkzeug.security import generate_password_hash
from werkzeug.utils import secure_filename


DATABASE_PATH = Path(os.environ.get('SMART_SKIN_DATABASE', Path(__file__).with_name('users.db')))
UPLOAD_PATH = Path(os.environ.get('SMART_SKIN_UPLOAD_FOLDER', Path(__file__).with_name('private_uploads')))
PROFILE_AVATAR_FILENAME_PATTERN = re.compile(r'^profile_[0-9a-f]{32}\.jpg$')
TOTP_STEP_SECONDS = 30
TOTP_DIGITS = 6


def table_exists(conn, table_name):
    return conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
        (table_name,),
    ).fetchone() is not None


def table_has_column(conn, table_name, column_name):
    if not table_exists(conn, table_name):
        return False
    return any(row[1] == column_name for row in conn.execute(f'PRAGMA table_info({table_name})'))


def is_profile_avatar_filename(filename):
    """Only retry names minted by the profile-avatar writer."""
    return isinstance(filename, str) and bool(PROFILE_AVATAR_FILENAME_PATTERN.fullmatch(filename))


def purge_queued_profile_avatars(queued_filenames, dry_run=False):
    """Remove queued stale avatars without scanning or exposing upload files.

    An old avatar may temporarily remain locked by the operating system after
    its database reference is removed.  Failed deletes deliberately stay in
    the queue for the next scheduler run.
    """
    candidates = [filename for filename in queued_filenames if is_profile_avatar_filename(filename)]
    if dry_run:
        return 0, len(candidates)
    removed = []
    for filename in candidates:
        try:
            (UPLOAD_PATH / filename).unlink()
        except FileNotFoundError:
            removed.append((filename,))
        except OSError:
            continue
        else:
            removed.append((filename,))
    if removed:
        conn = sqlite3.connect(DATABASE_PATH)
        try:
            conn.executemany(
                'DELETE FROM profile_avatar_deletion_queue WHERE image_path = ?',
                removed,
            )
            conn.commit()
        finally:
            conn.close()
    return len(removed), len(candidates)


def generate_admin_totp_secret():
    """Generate a 160-bit TOTP seed for controlled CLI provisioning."""
    return base64.b32encode(os.urandom(20)).decode('ascii').rstrip('=')


def _totp_code_for_secret(secret, counter):
    normalized = str(secret).strip().upper()
    secret_bytes = base64.b32decode(normalized + ('=' * (-len(normalized) % 8)), casefold=True)
    digest = hmac.new(secret_bytes, int(counter).to_bytes(8, 'big'), 'sha1').digest()
    offset = digest[-1] & 0x0F
    truncated = (
        ((digest[offset] & 0x7F) << 24)
        | (digest[offset + 1] << 16)
        | (digest[offset + 2] << 8)
        | digest[offset + 3]
    )
    return f'{truncated % (10 ** TOTP_DIGITS):0{TOTP_DIGITS}d}'


def verify_admin_totp_secret(secret, code):
    """Return the accepted counter or None for an invalid enrollment code."""
    normalized_code = str(code).strip()
    if not re.fullmatch(r'\d{6}', normalized_code):
        return None
    current_counter = int(time.time() // TOTP_STEP_SECONDS)
    for counter in (current_counter - 1, current_counter, current_counter + 1):
        if hmac.compare_digest(_totp_code_for_secret(secret, counter), normalized_code):
            return counter
    return None


def admin_mfa_provisioning_uri(email, secret):
    issuer = 'Smart Skin AI'
    label = quote(f'{issuer}:{email}', safe='')
    return (
        f'otpauth://totp/{label}?secret={secret}&issuer={quote(issuer, safe="")}'
        f'&algorithm=SHA1&digits={TOTP_DIGITS}&period={TOTP_STEP_SECONDS}'
    )


def production_mfa_cipher():
    key = os.environ.get('SMART_SKIN_MFA_ENCRYPTION_KEY', '').strip()
    if not key:
        raise ValueError('SMART_SKIN_MFA_ENCRYPTION_KEY is required for production administrator provisioning.')
    try:
        return Fernet(key.encode('ascii'))
    except (TypeError, ValueError) as error:
        raise ValueError('SMART_SKIN_MFA_ENCRYPTION_KEY is not a valid Fernet key.') from error


def create_admin(email, enroll_mfa=False):
    email = email.strip().lower()
    if not email or '@' not in email:
        raise ValueError('Provide a valid administrator email address.')
    if email == 'admin@dev.com':
        raise ValueError('The legacy bootstrap account is disabled. Use another email address.')

    # Fail before accepting a password when the requested workflow could
    # create a production administrator without a second factor.  This keeps
    # the controlled console from collecting a credential for an operation
    # that must not proceed.
    is_production = os.environ.get('SMART_SKIN_ENV', '').strip().lower() == 'production'
    if is_production and not enroll_mfa:
        raise ValueError('Production administrator provisioning requires --enroll-mfa; password-only administrators are prohibited.')

    password = getpass('New admin password (12 characters minimum): ')
    confirmation = getpass('Confirm password: ')
    if len(password) < 12 or not any(char.isalpha() for char in password) or not any(char.isdigit() for char in password):
        raise ValueError('The password must contain at least 12 characters with both letters and numbers.')
    if password != confirmation:
        raise ValueError('The passwords do not match.')

    mfa_secret = None
    mfa_counter = None
    cipher = None
    if enroll_mfa:
        cipher = production_mfa_cipher() if is_production else None
        mfa_secret = generate_admin_totp_secret()
        print('\nScan or add this TOTP enrolment in an Authenticator app now.')
        print('Do not save this value in a shell history, ticket, chat, or source file.')
        print(admin_mfa_provisioning_uri(email, mfa_secret))
        enrollment_code = getpass('Authenticator six-digit code to confirm enrolment: ')
        mfa_counter = verify_admin_totp_secret(mfa_secret, enrollment_code)
        if mfa_counter is None:
            raise ValueError('The Authenticator code was not accepted; no administrator was changed.')

    conn = sqlite3.connect(DATABASE_PATH)
    try:
        cursor = conn.cursor()
        cursor.execute('BEGIN IMMEDIATE')
        cursor.execute('SELECT id FROM users WHERE email = ?', (email,))
        user = cursor.fetchone()
        if user:
            admin_id = user[0]
            cursor.execute(
                "UPDATE users SET password = ?, role = 'admin', is_approved = 1, auth_epoch = auth_epoch + 1 WHERE id = ?",
                (generate_password_hash(password), admin_id),
            )
            result = 'Administrator password and permissions updated.'
        else:
            cursor.execute(
                "INSERT INTO users (name, email, password, role, is_approved) VALUES (?, ?, ?, 'admin', 1)",
                ('ผู้ดูแลระบบ', email, generate_password_hash(password)),
            )
            admin_id = cursor.lastrowid
            result = 'Administrator account created.'

        if enroll_mfa:
            if not table_exists(conn, 'admin_mfa_credentials'):
                raise ValueError('MFA tables are missing. Initialise the application database in controlled maintenance mode first.')
            now = datetime.now().astimezone().isoformat(timespec='seconds')
            # Development provisioning still uses a Fernet key when one is
            # configured.  Production always requires the independent key.
            if cipher is None:
                key = os.environ.get('SMART_SKIN_MFA_ENCRYPTION_KEY', '').strip()
                if not key:
                    raise ValueError('Set SMART_SKIN_MFA_ENCRYPTION_KEY before enrolling an administrator in MFA.')
                cipher = Fernet(key.encode('ascii'))
            secret_ciphertext = cipher.encrypt(mfa_secret.encode('ascii')).decode('ascii')
            cursor.execute(
                '''INSERT INTO admin_mfa_credentials
                   (user_id, secret_ciphertext, enabled_at, last_used_counter, created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?)
                   ON CONFLICT(user_id) DO UPDATE SET
                       secret_ciphertext = excluded.secret_ciphertext,
                       enabled_at = excluded.enabled_at,
                       last_used_counter = excluded.last_used_counter,
                       updated_at = excluded.updated_at''',
                (admin_id, secret_ciphertext, now, mfa_counter, now, now),
            )
            cursor.execute('DELETE FROM admin_mfa_enrollments WHERE user_id = ?', (admin_id,))
            cursor.execute('DELETE FROM admin_mfa_login_challenges WHERE user_id = ?', (admin_id,))
            result += ' MFA enrollment confirmed.'
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()
    print(result)


def purge_expired_scans(dry_run=False):
    """Run retention cleanup from a scheduler without exposing private content."""
    now = datetime.now().astimezone().isoformat(timespec='seconds')
    conn = sqlite3.connect(DATABASE_PATH)
    try:
        rows = conn.execute(
            'SELECT id, image_path, gradcam_path FROM scan_logs WHERE retention_expires_at IS NOT NULL AND retention_expires_at <= ?',
            (now,),
        ).fetchall()
        expired_concerns = conn.execute(
            'SELECT id FROM concern_reports WHERE retention_expires_at IS NOT NULL AND retention_expires_at <= ?',
            (now,),
        ).fetchall() if table_exists(conn, 'concern_reports') else []
        expired_nearby_contexts = conn.execute(
            'SELECT id FROM nearby_context_reports WHERE retention_expires_at IS NOT NULL AND retention_expires_at <= ?',
            (now,),
        ).fetchall() if table_exists(conn, 'nearby_context_reports') else []
        expired_feedback = conn.execute(
            'SELECT id FROM feedbacks WHERE retention_expires_at IS NOT NULL AND retention_expires_at <= ?',
            (now,),
        ).fetchall() if table_has_column(conn, 'feedbacks', 'retention_expires_at') else []
        queued_profile_avatars = conn.execute(
            'SELECT image_path FROM profile_avatar_deletion_queue'
        ).fetchall() if table_exists(conn, 'profile_avatar_deletion_queue') else []
        if dry_run:
            _, queued_avatar_candidates = purge_queued_profile_avatars(
                [row[0] for row in queued_profile_avatars], dry_run=True,
            )
            print(f'Would purge {len(rows)} expired scan record(s), {len(expired_concerns)} concern report(s), {len(expired_nearby_contexts)} nearby context report(s), {len(expired_feedback)} feedback item(s), and retry {queued_avatar_candidates} stale profile avatar(s).')
            return
        conn.executemany('DELETE FROM scan_logs WHERE id = ?', [(row[0],) for row in rows])
        if expired_concerns:
            conn.executemany('DELETE FROM concern_reports WHERE id = ?', [(row[0],) for row in expired_concerns])
        if expired_nearby_contexts:
            conn.executemany('DELETE FROM nearby_context_reports WHERE id = ?', [(row[0],) for row in expired_nearby_contexts])
        if expired_feedback:
            conn.executemany('DELETE FROM feedbacks WHERE id = ?', [(row[0],) for row in expired_feedback])
        conn.commit()
    finally:
        conn.close()

    for _, image_path, gradcam_path in rows:
        for artifact_path in (image_path, gradcam_path):
            if artifact_path:
                path = UPLOAD_PATH / secure_filename(artifact_path)
                if path.is_file():
                    path.unlink()
    removed_avatars, queued_avatar_candidates = purge_queued_profile_avatars(
        [row[0] for row in queued_profile_avatars],
    )
    print(f'Purged {len(rows)} expired scan record(s), {len(expired_concerns)} concern report(s), {len(expired_nearby_contexts)} nearby context report(s), and {len(expired_feedback)} feedback item(s); removed {removed_avatars} of {queued_avatar_candidates} queued stale profile avatar(s).')


def verify_model_release(model_path, metadata_path, evidence_path, catalog_path, output_path=None):
    """Verify that reviewed evidence is bound to one candidate artifact.

    This is an integrity/format check only.  A successful command never
    activates a model or establishes clinical validity; the accountable
    reviewer must still approve the intended use outside this command.
    """
    from validate_model_evaluation import validate_paths

    report = validate_paths(
        Path(metadata_path),
        Path(evidence_path),
        Path(model_path),
        Path(catalog_path),
    )
    serialized = json.dumps(report, ensure_ascii=False, indent=2) + '\n'
    if output_path:
        destination = Path(output_path)
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text(serialized, encoding='utf-8')
    print(serialized)
    if not report.get('evidence_format_valid'):
        raise ValueError('Independent evaluation evidence is incomplete or inconsistent; release remains blocked.')


def main():
    parser = argparse.ArgumentParser(description='Manage Smart Skin AI administrator accounts.')
    subparsers = parser.add_subparsers(dest='command', required=True)
    create_admin_parser = subparsers.add_parser('create-admin', help='Create or reset an administrator account.')
    create_admin_parser.add_argument('--email', required=True, help='Administrator email address')
    create_admin_parser.add_argument(
        '--enroll-mfa',
        action='store_true',
        help='Generate, confirm, and encrypt a TOTP enrolment in this controlled console. Required in production.',
    )
    purge_parser = subparsers.add_parser('purge-expired-scans', help='Delete health images and scan records past their retention date.')
    purge_parser.add_argument('--dry-run', action='store_true', help='Report the number of expired records without deleting them.')
    verify_release_parser = subparsers.add_parser(
        'verify-model-release',
        help='Verify a provenance-bound independent-evaluation package; never activates a model.',
    )
    verify_release_parser.add_argument('--model', required=True, help='Candidate model artifact path')
    verify_release_parser.add_argument('--metadata', required=True, help='Candidate model metadata JSON path')
    verify_release_parser.add_argument('--evidence', required=True, help='Reviewed independent-evaluation JSON path')
    verify_release_parser.add_argument('--catalog', default=str(Path(__file__).with_name('disease_catalog.json')), help='Disease catalog JSON path')
    verify_release_parser.add_argument('--output', help='Optional evidence report output JSON path')
    args = parser.parse_args()

    if args.command == 'create-admin':
        create_admin(args.email, enroll_mfa=args.enroll_mfa)
    elif args.command == 'purge-expired-scans':
        purge_expired_scans(args.dry_run)
    elif args.command == 'verify-model-release':
        verify_model_release(args.model, args.metadata, args.evidence, args.catalog, args.output)


if __name__ == '__main__':
    try:
        main()
    except ValueError as error:
        raise SystemExit(f'Error: {error}')
