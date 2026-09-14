import os
import sqlite3
import secrets
import hmac
import re
import time
import json
import hashlib
import base64
import subprocess
import sys
import threading
import warnings
import smtplib
import ssl
import numpy as np
from io import BytesIO
from datetime import datetime, timedelta
from email.message import EmailMessage
from functools import wraps
from uuid import uuid4
from pathlib import Path
from urllib.parse import quote, urlparse
from flask import Flask, abort, g, render_template, request, redirect, send_from_directory, url_for, session, flash
from PIL import Image, ImageOps, UnidentifiedImageError
from cryptography.fernet import Fernet, InvalidToken
from werkzeug.middleware.proxy_fix import ProxyFix
from werkzeug.utils import secure_filename
from werkzeug.security import check_password_hash, generate_password_hash
from predict import (
    display_name_for_label,
    load_disease_catalog,
    load_model,
    load_model_metadata,
    assess_deployment_readiness,
    MODEL_METADATA_PATH,
    MODEL_PATH,
    generate_gradcam_overlay,
    predict_image_scores,
)
from prepare_multiclass_dataset import inspect_dataset, load_catalog as load_training_catalog

# -------------------------------------------------------------------------
# 🧠 โหลดโมเดลสำหรับการสแกนภาพ
# -------------------------------------------------------------------------
model = load_model()
MODEL_METADATA = load_model_metadata()
MODEL_CLASS_NAMES = MODEL_METADATA['class_names']
MODEL_VERSION = MODEL_METADATA['model_version']
MODEL_ABSTENTION_THRESHOLD = min(max(MODEL_METADATA['abstention_threshold'], 0.0), 1.0)
MODEL_MARGIN_THRESHOLD = min(max(MODEL_METADATA['margin_threshold'], 0.0), 1.0)
MODEL_OUT_OF_SCOPE_THRESHOLD = min(max(MODEL_METADATA['out_of_scope_threshold'], 0.0), MODEL_ABSTENTION_THRESHOLD)
# This is a conservative pre-classification screen, not evidence that an
# uploaded image contains a particular lesion or a diagnosis.
IMAGE_SCOPE_MIN_CONFIDENCE = max(MODEL_OUT_OF_SCOPE_THRESHOLD, 0.50)
IMAGE_QUALITY_MIN_CONTRAST = 10.0
IMAGE_QUALITY_MIN_EDGE_DETAIL = 0.60
IMAGE_QUALITY_BRIGHTNESS_RANGE = (20.0, 240.0)
DISEASE_CATALOG = load_disease_catalog()
TARGET_CLASS_COUNT = len(DISEASE_CATALOG)
MODEL_EVALUATION_MANIFEST_PATH = os.environ.get('SMART_SKIN_MODEL_EVALUATION_MANIFEST', '').strip()
MODEL_READINESS = assess_deployment_readiness(
    model,
    MODEL_METADATA,
    model_path=MODEL_PATH,
    expected_catalog=DISEASE_CATALOG,
    metadata_path=MODEL_METADATA_PATH,
    evaluation_manifest_path=MODEL_EVALUATION_MANIFEST_PATH or None,
)

# The uploaded image type is user-selected, not guessed from pixels.  A future
# 50-class release may cover both domains only when its reviewed metadata maps
# each output class to one of these domains.
IMAGE_DOMAIN_DETAILS = {
    'clinical': {'label': 'ภาพถ่ายผิวหนังทั่วไป', 'hint': 'ถ่ายด้วยกล้องโทรศัพท์หรือกล้องทั่วไป'},
    'lesion': {'label': 'ภาพเดอร์โมสโคป (dermoscopy)', 'hint': 'ภาพขยายจากอุปกรณ์เดอร์โมสโคป'},
}
MODEL_CLASS_NAMES_BY_DOMAIN = {
    domain: [
        label for label in MODEL_CLASS_NAMES
        if DISEASE_CATALOG.get(label.casefold(), {}).get('group') == catalog_group
    ]
    for domain, catalog_group in (('clinical', 'clinical'), ('lesion', 'lesion'))
}

# -------------------------------------------------------------------------
# 📂 การตั้งค่าระบบ Flask และฐานข้อมูล
# -------------------------------------------------------------------------
app = Flask(__name__)
configured_secret = os.environ.get('FLASK_SECRET_KEY')
PROJECT_ROOT = Path(__file__).resolve().parent
RUNTIME_ENVIRONMENT = os.environ.get('SMART_SKIN_ENV', 'development').strip().lower()
IS_PRODUCTION = RUNTIME_ENVIRONMENT == 'production'
# This is deliberately separate from the model release gate.  It provides a
# safe publishable state while a health-image service is still being reviewed:
# no accounts, private records, uploads, or analysis routes are reachable.
configured_public_information_mode = os.environ.get(
    'SMART_SKIN_PUBLIC_INFORMATION_MODE', ''
).strip().lower()
PUBLIC_INFORMATION_MODE = (
    configured_public_information_mode in {'1', 'true', 'yes', 'on'}
    or (IS_PRODUCTION and not MODEL_READINESS['approved'])
)
configured_database = os.environ.get('SMART_SKIN_DATABASE')
configured_upload_folder = os.environ.get('SMART_SKIN_UPLOAD_FOLDER')
configured_training_candidate_folder = os.environ.get('SMART_SKIN_TRAINING_CANDIDATE_FOLDER')
configured_allowed_hosts = [
    host.strip().lower()
    for host in os.environ.get('SMART_SKIN_ALLOWED_HOSTS', '').split(',')
    if host.strip()
]
configured_privacy_contact = os.environ.get('SMART_SKIN_PRIVACY_CONTACT', '').strip()
configured_data_controller = os.environ.get('SMART_SKIN_DATA_CONTROLLER_NAME', '').strip()
configured_public_base_url = os.environ.get('SMART_SKIN_PUBLIC_BASE_URL', '').strip().rstrip('/')
configured_smtp_host = os.environ.get('SMART_SKIN_SMTP_HOST', '').strip()
configured_smtp_port = os.environ.get('SMART_SKIN_SMTP_PORT', '587').strip()
configured_smtp_username = os.environ.get('SMART_SKIN_SMTP_USERNAME', '').strip()
configured_smtp_password = os.environ.get('SMART_SKIN_SMTP_PASSWORD', '')
configured_smtp_from = os.environ.get('SMART_SKIN_SMTP_FROM', '').strip()
configured_smtp_starttls = os.environ.get('SMART_SKIN_SMTP_STARTTLS', '1') == '1'
configured_mfa_encryption_key = os.environ.get('SMART_SKIN_MFA_ENCRYPTION_KEY', '').strip()
# Public deployments must never create a password-only administrator session.
# The database-level gate below verifies every administrator has an enrolled
# encrypted TOTP credential before a production process can start.
ADMIN_MFA_REQUIRED = IS_PRODUCTION
# A generated per-process Flask secret cannot safely protect a durable MFA
# enrollment: the seed would be unreadable after a restart.  Production always
# uses the separately configured Fernet key below.
MFA_ENROLLMENT_KEY_IS_DURABLE = bool(configured_mfa_encryption_key or configured_secret)
try:
    trusted_proxy_hops = int(os.environ.get('SMART_SKIN_TRUSTED_PROXY_HOPS', '0'))
except ValueError as error:
    raise RuntimeError('SMART_SKIN_TRUSTED_PROXY_HOPS must be a whole number.') from error


def is_path_inside(path, parent):
    try:
        Path(path).resolve().relative_to(Path(parent).resolve())
        return True
    except ValueError:
        return False


if IS_PRODUCTION:
    if not configured_secret:
        raise RuntimeError('FLASK_SECRET_KEY must be set in production.')
    if os.environ.get('FLASK_HTTPS') != '1':
        raise RuntimeError('FLASK_HTTPS=1 is required in production.')
    if not configured_allowed_hosts or any('/' in host or ':' in host or host == '*' for host in configured_allowed_hosts):
        raise RuntimeError('Set SMART_SKIN_ALLOWED_HOSTS to explicit public domain names, separated by commas.')
    if not 1 <= trusted_proxy_hops <= 3:
        raise RuntimeError('Set SMART_SKIN_TRUSTED_PROXY_HOPS to the number of trusted reverse proxies (1-3).')
    if not configured_privacy_contact or not configured_data_controller:
        raise RuntimeError('Set SMART_SKIN_PRIVACY_CONTACT and SMART_SKIN_DATA_CONTROLLER_NAME in production.')
    # Public-information mode deliberately accepts no accounts or health
    # images.  It must not need an unused health-data store, SMTP account, or
    # administrator MFA merely to publish safe educational information.
    # Those controls become mandatory together when a private/account or
    # screening surface is enabled.
    production_confirmation_names = (
        'SMART_SKIN_PRIVACY_PROCESSORS_REVIEWED',
        'SMART_SKIN_INCIDENT_RESPONSE_CONFIRMED',
    )
    if not PUBLIC_INFORMATION_MODE:
        if not configured_database or not configured_upload_folder:
            raise RuntimeError('SMART_SKIN_DATABASE and SMART_SKIN_UPLOAD_FOLDER must be set outside the project in production.')
        if not Path(configured_database).is_absolute() or not Path(configured_upload_folder).is_absolute():
            raise RuntimeError('Production health-data paths must be absolute.')
        if is_path_inside(configured_database, PROJECT_ROOT) or is_path_inside(configured_upload_folder, PROJECT_ROOT):
            raise RuntimeError('Production health data must not be stored inside the application project directory.')
        if os.environ.get('SMART_SKIN_DATA_ENCRYPTION_AT_REST_CONFIRMED') != '1':
            raise RuntimeError('Confirm encrypted health-data storage with SMART_SKIN_DATA_ENCRYPTION_AT_REST_CONFIRMED=1.')
        if os.environ.get('SMART_SKIN_BACKUPS_ENCRYPTED_CONFIRMED') != '1':
            raise RuntimeError('Confirm encrypted backups with SMART_SKIN_BACKUPS_ENCRYPTED_CONFIRMED=1.')
        parsed_public_base_url = urlparse(configured_public_base_url)
        if (
            parsed_public_base_url.scheme != 'https'
            or not parsed_public_base_url.netloc
            or parsed_public_base_url.query
            or parsed_public_base_url.fragment
        ):
            raise RuntimeError('Set SMART_SKIN_PUBLIC_BASE_URL to the public HTTPS site URL in production.')
        if not all((configured_smtp_host, configured_smtp_username, configured_smtp_password, configured_smtp_from)):
            raise RuntimeError('Configure SMART_SKIN_SMTP_HOST, SMART_SKIN_SMTP_USERNAME, SMART_SKIN_SMTP_PASSWORD, and SMART_SKIN_SMTP_FROM in production.')
        if not configured_mfa_encryption_key:
            raise RuntimeError('SMART_SKIN_MFA_ENCRYPTION_KEY must be set in production to protect enrolled administrator TOTP secrets.')
        production_confirmation_names += ('SMART_SKIN_RETENTION_SCHEDULER_CONFIRMED',)
    for confirmation_name in production_confirmation_names:
        if os.environ.get(confirmation_name) != '1':
            raise RuntimeError(f'{confirmation_name}=1 must be confirmed before a public production launch.')
    if not PUBLIC_INFORMATION_MODE and os.environ.get('SMART_SKIN_ALLOW_ADMIN_TRAINING') == '1':
        if not configured_training_candidate_folder or not Path(configured_training_candidate_folder).is_absolute():
            raise RuntimeError('Set SMART_SKIN_TRAINING_CANDIDATE_FOLDER outside the project before enabling admin training in production.')
        if is_path_inside(configured_training_candidate_folder, PROJECT_ROOT):
            raise RuntimeError('Training candidate artifacts must be stored outside the application project directory in production.')

try:
    RETENTION_DAYS = int(os.environ.get('SMART_SKIN_RETENTION_DAYS', '30'))
except ValueError as error:
    raise RuntimeError('SMART_SKIN_RETENTION_DAYS must be a whole number.') from error
if not 1 <= RETENTION_DAYS <= 365:
    raise RuntimeError('SMART_SKIN_RETENTION_DAYS must be between 1 and 365.')
if IS_PRODUCTION and not PUBLIC_INFORMATION_MODE and 'SMART_SKIN_RETENTION_DAYS' not in os.environ:
    raise RuntimeError('Set SMART_SKIN_RETENTION_DAYS explicitly in production.')

app.secret_key = configured_secret or secrets.token_urlsafe(32)


def _development_mfa_encryption_key(secret_key):
    """Derive a deterministic development-only Fernet key from the app secret.

    Production always supplies a separately rotated key.  Keeping this fallback
    limited to non-production avoids storing a plaintext TOTP seed in SQLite
    while retaining zero-configuration local development and tests.
    """
    material = hashlib.sha256(f'smart-skin-mfa:{secret_key}'.encode('utf-8')).digest()
    return base64.urlsafe_b64encode(material)


def mfa_enrollment_key_is_available():
    """Return whether this runtime may safely create an MFA enrollment.

    Tests use an isolated database within one process, so their temporary key
    is stable for that test lifetime.  A real local runtime without any
    configured secret must not enroll an administrator it could lock out after
    the next restart.
    """
    return MFA_ENROLLMENT_KEY_IS_DURABLE or app.config.get('TESTING', False)


try:
    MFA_SECRET_CIPHER = Fernet(
        configured_mfa_encryption_key.encode('ascii')
        if configured_mfa_encryption_key
        else _development_mfa_encryption_key(app.secret_key)
    )
except (TypeError, ValueError) as error:
    raise RuntimeError('SMART_SKIN_MFA_ENCRYPTION_KEY must be a valid Fernet key.') from error
app.config.update(
    MAX_CONTENT_LENGTH=8 * 1024 * 1024,
    MIN_IMAGE_DIMENSION=128,
    MAX_IMAGE_PIXELS=20_000_000,
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE='Strict',
    SESSION_COOKIE_SECURE=os.environ.get('FLASK_HTTPS') == '1',
    PERMANENT_SESSION_LIFETIME=timedelta(minutes=30),
    SESSION_REFRESH_EACH_REQUEST=True,
    TRUSTED_HOSTS=configured_allowed_hosts or None,
    DATABASE=configured_database or os.path.join(app.root_path, 'users.db'),
    UPLOAD_RETENTION_DAYS=RETENTION_DAYS,
    PUBLIC_INFORMATION_MODE=PUBLIC_INFORMATION_MODE,
)
if trusted_proxy_hops:
    # Enable only when the reverse proxy is private/trusted and overwrites
    # forwarding headers. This makes HTTPS and client-IP policy work correctly.
    app.wsgi_app = ProxyFix(
        app.wsgi_app,
        x_for=trusted_proxy_hops,
        x_proto=trusted_proxy_hops,
        x_host=trusted_proxy_hops,
        x_port=trusted_proxy_hops,
    )
UPLOAD_FOLDER = configured_upload_folder or os.path.join(app.root_path, 'private_uploads')
app.config['UPLOAD_FOLDER'] = UPLOAD_FOLDER
# Treat oversized/decompression-bomb images as invalid before Pillow decodes them.
Image.MAX_IMAGE_PIXELS = app.config['MAX_IMAGE_PIXELS']
ALLOWED_IMAGE_EXTENSIONS = {'jpg', 'jpeg', 'png', 'webp'}
IMAGE_FORMAT_EXTENSIONS = {'JPEG': 'jpg', 'PNG': 'png', 'WEBP': 'webp'}
PROFILE_AVATAR_ALLOWED_FORMATS = {'JPEG', 'PNG', 'WEBP'}
PROFILE_AVATAR_MAX_BYTES = 2 * 1024 * 1024
PROFILE_AVATAR_MIN_DIMENSION = 64
PROFILE_AVATAR_MAX_PIXELS = 4_000_000
PROFILE_AVATAR_OUTPUT_DIMENSION = 256
PROFILE_AVATAR_FILENAME_PATTERN = re.compile(r'^profile_[0-9a-f]{32}\.jpg$')
MAX_NAME_LENGTH = 100
MAX_EMAIL_LENGTH = 254
MAX_FEEDBACK_LENGTH = 2000
FEEDBACK_TOPICS = {
    'general': 'ข้อเสนอแนะการใช้งาน',
    'privacy_rights': 'ข้อมูลส่วนบุคคลและการใช้สิทธิ์',
}
MIN_PASSWORD_LENGTH = 12
PASSWORD_RESET_TOKEN_TTL_MINUTES = 30
EMAIL_VERIFICATION_TOKEN_TTL_HOURS = 24
# The link fragment is exchanged for a short, browser-bound handoff.  This is
# intentionally far shorter than the email-link lifetime: the bearer verifier
# must not remain in a client-side URL, cookie, or session after the first
# same-origin page load.
ACCOUNT_SECURITY_HANDOFF_TTL_MINUTES = 10
ADMIN_MFA_ENROLLMENT_TTL_MINUTES = 10
ADMIN_MFA_LOGIN_CHALLENGE_TTL_MINUTES = 5
TOTP_STEP_SECONDS = 30
TOTP_DIGITS = 6
TOTP_CLOCK_SKEW_STEPS = 1
TOTP_CODE_PATTERN = re.compile(r'^\d{6}$')
# New account-security links contain a public selector and a high-entropy
# verifier.  Only a hash of the verifier is retained, so a database read does
# not create a usable reset/verification link.
TOKEN_SELECTOR_PATTERN = re.compile(r'^[A-Za-z0-9_-]{16,64}$')
TOKEN_VERIFIER_PATTERN = re.compile(r'^[A-Za-z0-9_-]{32,128}$')
try:
    SMTP_PORT = int(configured_smtp_port)
except ValueError as error:
    raise RuntimeError('SMART_SKIN_SMTP_PORT must be a whole number.') from error
if not 1 <= SMTP_PORT <= 65535:
    raise RuntimeError('SMART_SKIN_SMTP_PORT must be between 1 and 65535.')


def smtp_transport_is_encrypted():
    """Return whether account mail will use TLS for the configured transport."""
    # Port 465 is implicit TLS.  Any other port must explicitly negotiate
    # STARTTLS before credentials or message content are sent.
    return SMTP_PORT == 465 or configured_smtp_starttls


def assert_production_smtp_transport():
    """Fail closed rather than sending security links over plaintext SMTP."""
    if IS_PRODUCTION and not smtp_transport_is_encrypted():
        raise RuntimeError(
            'Production account email requires encrypted SMTP: use port 465 '
            'or set SMART_SKIN_SMTP_STARTTLS=1.'
        )


assert_production_smtp_transport()
PASSWORD_RESET_EMAIL_CONFIGURED = all(
    (
        configured_public_base_url,
        configured_smtp_host,
        configured_smtp_username,
        configured_smtp_password,
        configured_smtp_from,
    )
)
LOGIN_RATE_LIMIT = 5
LOGIN_RATE_WINDOW_SECONDS = 15 * 60
LOGIN_ATTEMPTS = {}
RATE_LIMITS = {
    'register': (3, 60 * 60),
    'scan': (12, 60 * 60),
    'feedback': (12, 60 * 60),
    'concern_report': (12, 60 * 60),
    'nearby_context': (4, 24 * 60 * 60),
    'account_delete': (3, 24 * 60 * 60),
    'password_change': (5, 60 * 60),
    'profile_avatar_update': (8, 60 * 60),
    'profile_avatar_remove': (5, 60 * 60),
    'password_reset_request': (5, 60 * 60),
    'admin_password_reset': (20, 60 * 60),
    'email_verification_request': (5, 60 * 60),
    'admin_mfa_enrollment': (5, 60 * 60),
    'admin_mfa_verify': (10, 15 * 60),
    'admin_mfa_recovery': (3, 24 * 60 * 60),
}
PRIVACY_NOTICE_VERSION = '2026-09-02'
TERMS_VERSION = '2026-09-01'
RETENTION_CLEANUP_INTERVAL_SECONDS = 60 * 60
last_retention_cleanup_at = 0.0
EMAIL_PATTERN = re.compile(r'^[^\s@]+@[^\s@]+\.[^\s@]+$')
CONCERN_LEVELS = {
    'routine': 'ติดตามทั่วไป',
    'review': 'ต้องการให้ตรวจทาน',
    'priority': 'ต้องการให้เห็นโดยเร็ว',
}
CONCERN_SIGNALS = {
    'new_or_changed': 'รอยโรคใหม่หรือมีการเปลี่ยนแปลง',
    'pain_or_itch': 'มีอาการเจ็บหรือคันมาก',
    'bleeding_or_not_healing': 'มีเลือดออกหรือแผลไม่หาย',
    'spreading_or_unwell': 'ผื่นลามเร็วหรือรู้สึกไม่สบายร่วม',
    'none_selected': 'ไม่มีข้อสังเกตข้างต้น ต้องการติดตามทั่วไป',
}
TRAINING_DATA_DIR = PROJECT_ROOT / 'dataset' / 'multiclass'
TRAINING_CANDIDATE_DIR = Path(configured_training_candidate_folder) if configured_training_candidate_folder else PROJECT_ROOT / 'models' / 'candidates'
TRAINING_LOG_DIR = TRAINING_CANDIDATE_DIR / 'logs'
ADMIN_TRAINING_ENABLED = (
    not PUBLIC_INFORMATION_MODE
    and (not IS_PRODUCTION or os.environ.get('SMART_SKIN_ALLOW_ADMIN_TRAINING') == '1')
)
TRAINING_EPOCH_OPTIONS = {10, 20, 30}
# A five-image floor is intentionally limited to admin-triggered research candidates.
# It is never evidence that a model is suitable for clinical deployment.
RESEARCH_CANDIDATE_MIN_IMAGES_PER_CLASS = 5
try:
    LOCATION_CONTEXT_RETENTION_HOURS = int(os.environ.get('SMART_SKIN_LOCATION_CONTEXT_RETENTION_HOURS', '24'))
except ValueError as error:
    raise RuntimeError('SMART_SKIN_LOCATION_CONTEXT_RETENTION_HOURS must be a whole number.') from error
if not 1 <= LOCATION_CONTEXT_RETENTION_HOURS <= 168:
    raise RuntimeError('SMART_SKIN_LOCATION_CONTEXT_RETENTION_HOURS must be between 1 and 168.')
if IS_PRODUCTION and not PUBLIC_INFORMATION_MODE and 'SMART_SKIN_LOCATION_CONTEXT_RETENTION_HOURS' not in os.environ:
    raise RuntimeError('Set SMART_SKIN_LOCATION_CONTEXT_RETENTION_HOURS explicitly in production.')

if not PUBLIC_INFORMATION_MODE:
    Path(UPLOAD_FOLDER).mkdir(parents=True, exist_ok=True)
    Path(app.config['DATABASE']).expanduser().resolve().parent.mkdir(parents=True, exist_ok=True)
    TRAINING_CANDIDATE_DIR.mkdir(parents=True, exist_ok=True)
    TRAINING_LOG_DIR.mkdir(parents=True, exist_ok=True)


def allowed_image_file(filename):
    return (
        '.' in filename
        and filename.rsplit('.', 1)[1].lower() in ALLOWED_IMAGE_EXTENSIONS
    )


def get_db_connection(row_factory=False):
    """Open the configured SQLite database with a bounded wait for locks."""
    conn = sqlite3.connect(app.config['DATABASE'], timeout=10)
    conn.execute('PRAGMA foreign_keys = ON')
    conn.execute('PRAGMA busy_timeout = 10000')
    # WAL improves the small single-service deployment's read/write behaviour.
    # It is not a substitute for a managed multi-instance database at scale.
    conn.execute('PRAGMA journal_mode = WAL')
    if row_factory:
        conn.row_factory = sqlite3.Row
    return conn


def is_valid_email(email):
    return bool(email) and len(email) <= MAX_EMAIL_LENGTH and bool(EMAIL_PATTERN.fullmatch(email))


def is_valid_name(name):
    return bool(name) and len(name) <= MAX_NAME_LENGTH and not any(ord(char) < 32 for char in name)


def is_strong_password(password):
    return (
        len(password) >= MIN_PASSWORD_LENGTH
        and any(char.isalpha() for char in password)
        and any(char.isdigit() for char in password)
    )


def generate_account_security_token():
    """Create a selector/verifier token without retaining its plaintext form."""
    selector = secrets.token_urlsafe(16)
    verifier = secrets.token_urlsafe(32)
    return f'{selector}.{verifier}', selector, verifier


def split_account_security_token(token):
    """Validate and split a selector/verifier token for a single hash check.

    A selector-less legacy token is accepted only until its normal short TTL
    expires after this migration.  It is deliberately scoped to rows without a
    selector, so new tokens never cause a scan of every active row.
    """
    if not isinstance(token, str) or not token or len(token) > 256:
        return None
    selector, separator, verifier = token.partition('.')
    if separator:
        if (
            '.' in verifier
            or not TOKEN_SELECTOR_PATTERN.fullmatch(selector)
            or not TOKEN_VERIFIER_PATTERN.fullmatch(verifier)
        ):
            return None
        return selector, verifier
    if TOKEN_VERIFIER_PATTERN.fullmatch(token):
        return None, token
    return None


def send_account_email(recipient, subject, body):
    """Send a security email without logging secrets or reset URLs."""
    if not PASSWORD_RESET_EMAIL_CONFIGURED:
        return False
    message = EmailMessage()
    message['Subject'] = subject
    message['From'] = configured_smtp_from
    message['To'] = recipient
    message.set_content(body)
    try:
        if IS_PRODUCTION and not smtp_transport_is_encrypted():
            # The startup assertion normally prevents this.  Retain the
            # runtime guard so a patched/misconfigured process fails closed.
            app.logger.error('Refusing to send account email over unencrypted SMTP in production')
            return False
        if SMTP_PORT == 465:
            with smtplib.SMTP_SSL(configured_smtp_host, SMTP_PORT, context=ssl.create_default_context(), timeout=15) as client:
                client.login(configured_smtp_username, configured_smtp_password)
                client.send_message(message)
        else:
            with smtplib.SMTP(configured_smtp_host, SMTP_PORT, timeout=15) as client:
                client.ehlo()
                if configured_smtp_starttls:
                    client.starttls(context=ssl.create_default_context())
                    client.ehlo()
                client.login(configured_smtp_username, configured_smtp_password)
                client.send_message(message)
    except (OSError, smtplib.SMTPException):
        app.logger.exception('Unable to deliver a security email')
        return False
    return True


def issue_password_reset_email(user_id, requested_by_user_id=None):
    """Create one short-lived, single-use reset token and email it to its owner."""
    if not PASSWORD_RESET_EMAIL_CONFIGURED:
        return False
    now = datetime.now().astimezone()
    expires_at = (now + timedelta(minutes=PASSWORD_RESET_TOKEN_TTL_MINUTES)).isoformat(timespec='seconds')
    created_at = now.isoformat(timespec='seconds')
    token, token_selector, token_verifier = generate_account_security_token()
    conn = get_db_connection()
    try:
        user = conn.execute(
            "SELECT id, name, email, role FROM users WHERE id = ?",
            (user_id,),
        ).fetchone()
        if not user or user[3] not in {'user', 'admin'}:
            return False
        conn.execute(
            "DELETE FROM password_reset_tokens WHERE user_id = ? AND used_at IS NULL",
            (user_id,),
        )
        cursor = conn.execute(
            """INSERT INTO password_reset_tokens
               (user_id, token_selector, token_hash, expires_at, requested_by_user_id, created_at)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (
                user_id,
                token_selector,
                generate_password_hash(token_verifier),
                expires_at,
                requested_by_user_id,
                created_at,
            ),
        )
        token_id = cursor.lastrowid
        conn.commit()
    finally:
        conn.close()

    # The verifier is in the fragment, not the path or query string.  Browsers
    # never send fragments in HTTP requests, which keeps this bearer credential
    # out of reverse-proxy/access logs and referrer headers.  The landing page
    # exchanges it once, over a CSRF-protected same-origin POST, for a short
    # session-bound handoff.
    reset_url = f"{configured_public_base_url}{url_for('reset_password')}#{token}"
    email_body = (
        f"สวัสดี {user[1]},\n\n"
        "มีคำขอตั้งรหัสผ่านใหม่สำหรับบัญชี Smart Skin AI ของคุณ\n"
        f"ตั้งรหัสผ่านใหม่ได้ที่: {reset_url}\n\n"
        f"ลิงก์นี้ใช้ได้ครั้งเดียวภายใน {PASSWORD_RESET_TOKEN_TTL_MINUTES} นาที "
        "หากคุณไม่ได้เป็นผู้ขอ กรุณาเพิกเฉยต่ออีเมลนี้และอย่าส่งต่อลิงก์ให้ผู้อื่น\n"
    )
    if send_account_email(user[2], 'ตั้งรหัสผ่านใหม่สำหรับ Smart Skin AI', email_body):
        return True

    conn = get_db_connection()
    try:
        conn.execute("DELETE FROM password_reset_tokens WHERE id = ?", (token_id,))
        conn.commit()
    finally:
        conn.close()
    return False


def resolve_password_reset_token(token):
    """Return an active token row only when the supplied opaque token matches."""
    token_parts = split_account_security_token(token)
    if not token_parts:
        return None
    token_selector, token_verifier = token_parts
    now = datetime.now().astimezone().isoformat(timespec='seconds')
    conn = get_db_connection(row_factory=True)
    try:
        if token_selector is None:
            rows = conn.execute(
                """SELECT password_reset_tokens.id, password_reset_tokens.user_id,
                          password_reset_tokens.token_hash, users.name, users.email
                   FROM password_reset_tokens
                   JOIN users ON users.id = password_reset_tokens.user_id
                   WHERE password_reset_tokens.token_selector IS NULL
                     AND password_reset_tokens.used_at IS NULL
                     AND password_reset_tokens.expires_at > ?""",
                (now,),
            ).fetchall()
        else:
            rows = conn.execute(
                """SELECT password_reset_tokens.id, password_reset_tokens.user_id,
                          password_reset_tokens.token_hash, users.name, users.email
                   FROM password_reset_tokens
                   JOIN users ON users.id = password_reset_tokens.user_id
                   WHERE password_reset_tokens.token_selector = ?
                     AND password_reset_tokens.used_at IS NULL
                     AND password_reset_tokens.expires_at > ?""",
                (token_selector, now),
            ).fetchall()
    finally:
        conn.close()
    for row in rows:
        try:
            if check_password_hash(row['token_hash'], token_verifier):
                return dict(row)
        except ValueError:
            continue
    return None


def complete_password_reset_by_id(reset_token_id, new_password):
    """Consume one active reset row by ID and revoke every existing session.

    The caller must already have verified the bearer verifier or established a
    browser-bound handoff.  Re-checking state inside an immediate transaction
    keeps account deletion, another reset request, and competing submissions
    from turning into a time-of-check/time-of-use issue.
    """
    if not isinstance(reset_token_id, int) or isinstance(reset_token_id, bool):
        return None
    now = datetime.now().astimezone().isoformat(timespec='seconds')
    conn = get_db_connection(row_factory=True)
    try:
        conn.execute('BEGIN IMMEDIATE')
        reset_row = conn.execute(
            """SELECT password_reset_tokens.id, password_reset_tokens.user_id,
                      users.name, users.email
               FROM password_reset_tokens
               JOIN users ON users.id = password_reset_tokens.user_id
               WHERE password_reset_tokens.id = ?
                 AND password_reset_tokens.used_at IS NULL
                 AND password_reset_tokens.expires_at > ?""",
            (reset_token_id, now),
        ).fetchone()
        if not reset_row:
            conn.rollback()
            return None
        conn.execute(
            "UPDATE password_reset_tokens SET used_at = ? WHERE id = ?",
            (now, reset_token_id),
        )
        conn.execute(
            "UPDATE users SET password = ?, auth_epoch = auth_epoch + 1 WHERE id = ?",
            (generate_password_hash(new_password), reset_row['user_id']),
        )
        conn.execute(
            "UPDATE password_reset_tokens SET used_at = ? WHERE user_id = ? AND used_at IS NULL",
            (now, reset_row['user_id']),
        )
        conn.commit()
    finally:
        conn.close()
    return dict(reset_row)


def complete_password_reset(token, new_password):
    """Legacy bearer-token completion, retained only for pre-migration links."""
    reset_row = resolve_password_reset_token(token)
    if not reset_row:
        return None
    return complete_password_reset_by_id(reset_row['id'], new_password)


def issue_email_verification_email(user_id):
    """Email a short-lived, single-use verification link to a new account."""
    if not PASSWORD_RESET_EMAIL_CONFIGURED:
        return False
    now = datetime.now().astimezone()
    expires_at = (now + timedelta(hours=EMAIL_VERIFICATION_TOKEN_TTL_HOURS)).isoformat(timespec='seconds')
    created_at = now.isoformat(timespec='seconds')
    token, token_selector, token_verifier = generate_account_security_token()
    conn = get_db_connection()
    try:
        user = conn.execute(
            "SELECT id, name, email, role, email_verified_at FROM users WHERE id = ?",
            (user_id,),
        ).fetchone()
        if not user or user[3] != 'user' or user[4]:
            return False
        conn.execute(
            "DELETE FROM email_verification_tokens WHERE user_id = ? AND used_at IS NULL",
            (user_id,),
        )
        cursor = conn.execute(
            """INSERT INTO email_verification_tokens
               (user_id, token_selector, token_hash, expires_at, created_at)
               VALUES (?, ?, ?, ?, ?)""",
            (user_id, token_selector, generate_password_hash(token_verifier), expires_at, created_at),
        )
        token_id = cursor.lastrowid
        conn.commit()
    finally:
        conn.close()

    # See password-reset issuance above: the fragment is intentionally not
    # transmitted to the web server or included in ordinary access logs.
    verification_url = f"{configured_public_base_url}{url_for('verify_email')}#{token}"
    email_body = (
        f"สวัสดี {user[1]},\n\n"
        "กรุณายืนยันอีเมลสำหรับบัญชี Smart Skin AI ของคุณ\n"
        f"ยืนยันอีเมลได้ที่: {verification_url}\n\n"
        f"ลิงก์นี้ใช้ได้ครั้งเดียวภายใน {EMAIL_VERIFICATION_TOKEN_TTL_HOURS} ชั่วโมง "
        "หลังยืนยันแล้ว บัญชีจะยังต้องรอผู้ดูแลอนุมัติก่อนเข้าสู่ระบบ\n"
    )
    if send_account_email(user[2], 'ยืนยันอีเมลสำหรับ Smart Skin AI', email_body):
        return True

    conn = get_db_connection()
    try:
        conn.execute("DELETE FROM email_verification_tokens WHERE id = ?", (token_id,))
        conn.commit()
    finally:
        conn.close()
    return False


def resolve_email_verification_token(token):
    token_parts = split_account_security_token(token)
    if not token_parts:
        return None
    token_selector, token_verifier = token_parts
    now = datetime.now().astimezone().isoformat(timespec='seconds')
    conn = get_db_connection(row_factory=True)
    try:
        if token_selector is None:
            rows = conn.execute(
                """SELECT email_verification_tokens.id, email_verification_tokens.user_id,
                          email_verification_tokens.token_hash, users.name
                   FROM email_verification_tokens
                   JOIN users ON users.id = email_verification_tokens.user_id
                   WHERE email_verification_tokens.token_selector IS NULL
                     AND email_verification_tokens.used_at IS NULL
                     AND email_verification_tokens.expires_at > ?
                     AND users.email_verified_at IS NULL""",
                (now,),
            ).fetchall()
        else:
            rows = conn.execute(
                """SELECT email_verification_tokens.id, email_verification_tokens.user_id,
                          email_verification_tokens.token_hash, users.name
                   FROM email_verification_tokens
                   JOIN users ON users.id = email_verification_tokens.user_id
                   WHERE email_verification_tokens.token_selector = ?
                     AND email_verification_tokens.used_at IS NULL
                     AND email_verification_tokens.expires_at > ?
                     AND users.email_verified_at IS NULL""",
                (token_selector, now),
            ).fetchall()
    finally:
        conn.close()
    for row in rows:
        try:
            if check_password_hash(row['token_hash'], token_verifier):
                return dict(row)
        except ValueError:
            continue
    return None


def complete_email_verification_by_id(verification_token_id):
    """Consume one verified-email token after a verified browser handoff."""
    if not isinstance(verification_token_id, int) or isinstance(verification_token_id, bool):
        return None
    now = datetime.now().astimezone().isoformat(timespec='seconds')
    conn = get_db_connection(row_factory=True)
    try:
        conn.execute('BEGIN IMMEDIATE')
        verification_row = conn.execute(
            """SELECT email_verification_tokens.id, email_verification_tokens.user_id,
                      users.name
               FROM email_verification_tokens
               JOIN users ON users.id = email_verification_tokens.user_id
               WHERE email_verification_tokens.id = ?
                 AND email_verification_tokens.used_at IS NULL
                 AND email_verification_tokens.expires_at > ?
                 AND users.email_verified_at IS NULL""",
            (verification_token_id, now),
        ).fetchone()
        if not verification_row:
            conn.rollback()
            return None
        conn.execute(
            "UPDATE email_verification_tokens SET used_at = ? WHERE id = ?",
            (now, verification_token_id),
        )
        conn.execute(
            "UPDATE users SET email_verified_at = ? WHERE id = ? AND email_verified_at IS NULL",
            (now, verification_row['user_id']),
        )
        conn.execute(
            "UPDATE email_verification_tokens SET used_at = ? WHERE user_id = ? AND used_at IS NULL",
            (now, verification_row['user_id']),
        )
        conn.commit()
    finally:
        conn.close()
    return dict(verification_row)


def complete_email_verification(token):
    """Legacy bearer-token completion, retained only for pre-migration links."""
    verification_row = resolve_email_verification_token(token)
    if not verification_row:
        return None
    return complete_email_verification_by_id(verification_row['id'])


def begin_account_security_handoff(purpose, token):
    """Validate a link fragment and retain only a short session-bound handle.

    The raw verifier arrives once in a POST body from a same-origin page.  It
    is never stored in the Flask session, database, query string, or route
    path.  Clearing the old session also prevents an account-reset link from
    inheriting an authenticated session on a shared device.
    """
    resolver = {
        'password_reset': resolve_password_reset_token,
        'email_verification': resolve_email_verification_token,
    }.get(purpose)
    if resolver is None:
        return None
    token_row = resolver(token)
    if not token_row:
        return None
    session.clear()
    session['account_security_handoff'] = {
        'purpose': purpose,
        'token_id': token_row['id'],
        'issued_at': int(time.time()),
    }
    # The handoff endpoint starts with a pre-authenticated session; mint a new
    # CSRF value after session rotation for the final confirmation form.
    session['csrf_token'] = secrets.token_urlsafe(32)
    session.permanent = False
    session.modified = True
    return token_row


def get_account_security_handoff(purpose):
    """Resolve a non-secret, short-lived security handoff from this browser."""
    handoff = session.get('account_security_handoff')
    if not isinstance(handoff, dict) or handoff.get('purpose') != purpose:
        return None
    token_id = handoff.get('token_id')
    issued_at = handoff.get('issued_at')
    if (
        not isinstance(token_id, int)
        or isinstance(token_id, bool)
        or not isinstance(issued_at, int)
        or isinstance(issued_at, bool)
        or issued_at > int(time.time()) + 60
        or int(time.time()) - issued_at > ACCOUNT_SECURITY_HANDOFF_TTL_MINUTES * 60
    ):
        session.pop('account_security_handoff', None)
        return None
    now = datetime.now().astimezone().isoformat(timespec='seconds')
    conn = get_db_connection(row_factory=True)
    try:
        if purpose == 'password_reset':
            row = conn.execute(
                """SELECT password_reset_tokens.id, password_reset_tokens.user_id,
                          users.name, users.email
                   FROM password_reset_tokens
                   JOIN users ON users.id = password_reset_tokens.user_id
                   WHERE password_reset_tokens.id = ?
                     AND password_reset_tokens.used_at IS NULL
                     AND password_reset_tokens.expires_at > ?""",
                (token_id, now),
            ).fetchone()
        else:
            row = conn.execute(
                """SELECT email_verification_tokens.id, email_verification_tokens.user_id,
                          users.name
                   FROM email_verification_tokens
                   JOIN users ON users.id = email_verification_tokens.user_id
                   WHERE email_verification_tokens.id = ?
                     AND email_verification_tokens.used_at IS NULL
                     AND email_verification_tokens.expires_at > ?
                     AND users.email_verified_at IS NULL""",
                (token_id, now),
            ).fetchone()
    finally:
        conn.close()
    return dict(row) if row else None


def clear_account_security_handoff():
    """Remove a consumed or invalid reset/verification handoff from session."""
    session.pop('account_security_handoff', None)


def encrypt_admin_mfa_secret(secret):
    """Encrypt a TOTP seed before it reaches SQLite; never log the seed."""
    return MFA_SECRET_CIPHER.encrypt(secret.encode('ascii')).decode('ascii')


def decrypt_admin_mfa_secret(ciphertext):
    """Return a valid TOTP seed, or fail closed if its encryption/key is invalid."""
    if not ciphertext:
        return None
    try:
        secret = MFA_SECRET_CIPHER.decrypt(str(ciphertext).encode('ascii')).decode('ascii')
        # Validate before returning it so malformed database data cannot reach
        # the HMAC routine below.
        _decode_totp_secret(secret)
        return secret
    except (InvalidToken, UnicodeError, ValueError, TypeError):
        return None


def _decode_totp_secret(secret):
    if not isinstance(secret, str):
        raise ValueError('Invalid TOTP secret')
    normalized = secret.strip().upper()
    if not re.fullmatch(r'[A-Z2-7]{16,128}', normalized):
        raise ValueError('Invalid TOTP secret')
    try:
        return base64.b32decode(normalized + ('=' * (-len(normalized) % 8)), casefold=True)
    except (ValueError, TypeError) as error:
        raise ValueError('Invalid TOTP secret') from error


def generate_admin_totp_secret():
    """Generate a 160-bit Base32 seed accepted by common authenticator apps."""
    return base64.b32encode(secrets.token_bytes(20)).decode('ascii').rstrip('=')


def totp_code_for_secret(secret, counter=None):
    """Generate a six-digit RFC 6238-compatible TOTP code for tests/verification."""
    secret_bytes = _decode_totp_secret(secret)
    if counter is None:
        counter = int(time.time() // TOTP_STEP_SECONDS)
    counter = int(counter)
    if counter < 0:
        raise ValueError('Invalid TOTP counter')
    digest = hmac.new(secret_bytes, counter.to_bytes(8, 'big'), hashlib.sha1).digest()
    offset = digest[-1] & 0x0F
    truncated = (
        ((digest[offset] & 0x7F) << 24)
        | (digest[offset + 1] << 16)
        | (digest[offset + 2] << 8)
        | digest[offset + 3]
    )
    return str(truncated % (10 ** TOTP_DIGITS)).zfill(TOTP_DIGITS)


def matching_totp_counter(secret, code, now=None):
    """Return a valid time-step counter, allowing only one 30-second skew each way."""
    normalized_code = str(code or '').strip().replace(' ', '')
    if not TOTP_CODE_PATTERN.fullmatch(normalized_code):
        return None
    current_counter = int((time.time() if now is None else now) // TOTP_STEP_SECONDS)
    candidate_counters = [current_counter]
    for offset in range(1, TOTP_CLOCK_SKEW_STEPS + 1):
        candidate_counters.extend((current_counter - offset, current_counter + offset))
    for counter in candidate_counters:
        if counter < 0:
            continue
        try:
            expected_code = totp_code_for_secret(secret, counter)
        except ValueError:
            return None
        if hmac.compare_digest(expected_code, normalized_code):
            return counter
    return None


def admin_mfa_provisioning_uri(email, secret):
    issuer = 'Smart Skin AI'
    label = quote(f'{issuer}:{email}', safe='')
    return (
        f'otpauth://totp/{label}?secret={secret}&issuer={quote(issuer, safe="")}'
        f'&algorithm=SHA1&digits={TOTP_DIGITS}&period={TOTP_STEP_SECONDS}'
    )


def _clear_expired_admin_mfa_state(conn, now_text):
    conn.execute('DELETE FROM admin_mfa_enrollments WHERE expires_at <= ?', (now_text,))
    conn.execute(
        'DELETE FROM admin_mfa_login_challenges WHERE expires_at <= ? OR used_at IS NOT NULL',
        (now_text,),
    )


def admin_mfa_is_enrolled(user_id):
    conn = get_db_connection()
    try:
        row = conn.execute(
            'SELECT 1 FROM admin_mfa_credentials WHERE user_id = ? LIMIT 1',
            (user_id,),
        ).fetchone()
        return row is not None
    finally:
        conn.close()


def start_admin_mfa_enrollment(user_id):
    """Create a short-lived encrypted enrollment record after password re-authentication."""
    enrollment_id = uuid4().hex
    secret = generate_admin_totp_secret()
    now = datetime.now().astimezone()
    now_text = now.isoformat(timespec='seconds')
    expires_at = (now + timedelta(minutes=ADMIN_MFA_ENROLLMENT_TTL_MINUTES)).isoformat(timespec='seconds')
    conn = get_db_connection()
    try:
        conn.execute('BEGIN IMMEDIATE')
        _clear_expired_admin_mfa_state(conn, now_text)
        admin = conn.execute(
            "SELECT id FROM users WHERE id = ? AND role = 'admin'",
            (user_id,),
        ).fetchone()
        already_enabled = conn.execute(
            'SELECT 1 FROM admin_mfa_credentials WHERE user_id = ?',
            (user_id,),
        ).fetchone()
        if not admin or already_enabled:
            conn.rollback()
            return None
        conn.execute('DELETE FROM admin_mfa_enrollments WHERE user_id = ?', (user_id,))
        conn.execute(
            '''INSERT INTO admin_mfa_enrollments
               (id, user_id, secret_ciphertext, expires_at, created_at)
               VALUES (?, ?, ?, ?, ?)''',
            (enrollment_id, user_id, encrypt_admin_mfa_secret(secret), expires_at, now_text),
        )
        conn.commit()
        return enrollment_id
    except sqlite3.Error:
        conn.rollback()
        app.logger.exception('Could not create administrator MFA enrollment')
        return None
    finally:
        conn.close()


def get_active_admin_mfa_enrollment(enrollment_id, user_id):
    if not enrollment_id or len(str(enrollment_id)) > 128:
        return None
    now_text = datetime.now().astimezone().isoformat(timespec='seconds')
    conn = get_db_connection(row_factory=True)
    try:
        row = conn.execute(
            '''SELECT id, user_id, secret_ciphertext, expires_at
               FROM admin_mfa_enrollments
               WHERE id = ? AND user_id = ? AND expires_at > ?''',
            (enrollment_id, user_id, now_text),
        ).fetchone()
        return dict(row) if row else None
    finally:
        conn.close()


def cancel_admin_mfa_enrollment(enrollment_id, user_id):
    if not enrollment_id:
        return False
    conn = get_db_connection()
    try:
        cursor = conn.execute(
            'DELETE FROM admin_mfa_enrollments WHERE id = ? AND user_id = ?',
            (enrollment_id, user_id),
        )
        conn.commit()
        return cursor.rowcount == 1
    finally:
        conn.close()


def _verify_and_consume_admin_totp(conn, user_id, code, now=None):
    """Verify an enrolled code exactly once per counter within one transaction."""
    credential = conn.execute(
        '''SELECT secret_ciphertext, last_used_counter
           FROM admin_mfa_credentials WHERE user_id = ?''',
        (user_id,),
    ).fetchone()
    if not credential:
        return None
    secret = decrypt_admin_mfa_secret(credential[0])
    if not secret:
        # Invalid or undecryptable MFA data is deliberately not bypassed.
        return None
    counter = matching_totp_counter(secret, code, now=now)
    if counter is None:
        return None
    now_text = datetime.now().astimezone().isoformat(timespec='seconds')
    cursor = conn.execute(
        '''UPDATE admin_mfa_credentials
           SET last_used_counter = ?, updated_at = ?
           WHERE user_id = ?
             AND (last_used_counter IS NULL OR last_used_counter < ?)''',
        (counter, now_text, user_id, counter),
    )
    return counter if cursor.rowcount == 1 else None


def start_admin_mfa_login_challenge(user_id):
    """Store a short-lived opaque post-password challenge; no credentials in session."""
    challenge_id = uuid4().hex
    now = datetime.now().astimezone()
    now_text = now.isoformat(timespec='seconds')
    expires_at = (now + timedelta(minutes=ADMIN_MFA_LOGIN_CHALLENGE_TTL_MINUTES)).isoformat(timespec='seconds')
    conn = get_db_connection()
    try:
        conn.execute('BEGIN IMMEDIATE')
        _clear_expired_admin_mfa_state(conn, now_text)
        admin = conn.execute(
            "SELECT auth_epoch FROM users WHERE id = ? AND role = 'admin'",
            (user_id,),
        ).fetchone()
        if not admin:
            conn.rollback()
            return None
        conn.execute('DELETE FROM admin_mfa_login_challenges WHERE user_id = ?', (user_id,))
        conn.execute(
            '''INSERT INTO admin_mfa_login_challenges (id, user_id, auth_epoch, expires_at, created_at)
               VALUES (?, ?, ?, ?, ?)''',
            (challenge_id, user_id, admin[0], expires_at, now_text),
        )
        conn.commit()
        return challenge_id
    except sqlite3.Error:
        conn.rollback()
        app.logger.exception('Could not create administrator MFA login challenge')
        return None
    finally:
        conn.close()


def complete_admin_mfa_login(challenge_id, code):
    """Consume a valid MFA challenge and return the minimal account session data."""
    if not challenge_id or len(str(challenge_id)) > 128:
        return None
    now = datetime.now().astimezone()
    now_text = now.isoformat(timespec='seconds')
    conn = get_db_connection(row_factory=True)
    try:
        conn.execute('BEGIN IMMEDIATE')
        _clear_expired_admin_mfa_state(conn, now_text)
        row = conn.execute(
            '''SELECT challenges.id AS challenge_id, challenges.user_id, users.id AS id,
                      users.name, users.email, users.role, users.is_approved,
                      users.terms_version, users.auth_epoch
               FROM admin_mfa_login_challenges AS challenges
               JOIN users ON users.id = challenges.user_id
               JOIN admin_mfa_credentials AS credentials ON credentials.user_id = users.id
               WHERE challenges.id = ? AND challenges.used_at IS NULL
                 AND challenges.expires_at > ? AND users.role = 'admin'
                 AND challenges.auth_epoch = users.auth_epoch ''',
            (challenge_id, now_text),
        ).fetchone()
        if not row:
            conn.rollback()
            return None
        if _verify_and_consume_admin_totp(conn, row['user_id'], code) is None:
            conn.rollback()
            return None
        consumed = conn.execute(
            '''UPDATE admin_mfa_login_challenges SET used_at = ?
               WHERE id = ? AND used_at IS NULL AND expires_at > ?''',
            (now_text, challenge_id, now_text),
        )
        if consumed.rowcount != 1:
            conn.rollback()
            return None
        conn.execute('UPDATE users SET last_login = ? WHERE id = ?', (now_text, row['user_id']))
        conn.commit()
        return dict(row)
    except sqlite3.Error:
        conn.rollback()
        app.logger.exception('Could not complete administrator MFA login')
        return None
    finally:
        conn.close()


def enable_admin_mfa_from_enrollment(user_id, enrollment_id, code):
    """Turn an encrypted pending seed into an active credential after TOTP proof."""
    if not enrollment_id or len(str(enrollment_id)) > 128:
        return None
    now = datetime.now().astimezone()
    now_text = now.isoformat(timespec='seconds')
    conn = get_db_connection(row_factory=True)
    try:
        conn.execute('BEGIN IMMEDIATE')
        _clear_expired_admin_mfa_state(conn, now_text)
        enrollment = conn.execute(
            '''SELECT secret_ciphertext FROM admin_mfa_enrollments
               WHERE id = ? AND user_id = ? AND expires_at > ?''',
            (enrollment_id, user_id, now_text),
        ).fetchone()
        admin = conn.execute(
            "SELECT id FROM users WHERE id = ? AND role = 'admin'",
            (user_id,),
        ).fetchone()
        already_enabled = conn.execute(
            'SELECT 1 FROM admin_mfa_credentials WHERE user_id = ?',
            (user_id,),
        ).fetchone()
        if not enrollment or not admin or already_enabled:
            conn.rollback()
            return None
        secret = decrypt_admin_mfa_secret(enrollment['secret_ciphertext'])
        counter = matching_totp_counter(secret, code) if secret else None
        if counter is None:
            conn.rollback()
            return None
        conn.execute(
            '''INSERT INTO admin_mfa_credentials
               (user_id, secret_ciphertext, enabled_at, last_used_counter, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?)''',
            (user_id, enrollment['secret_ciphertext'], now_text, counter, now_text, now_text),
        )
        conn.execute('DELETE FROM admin_mfa_enrollments WHERE id = ?', (enrollment_id,))
        conn.execute("UPDATE users SET auth_epoch = auth_epoch + 1 WHERE id = ? AND role = 'admin'", (user_id,))
        new_epoch = conn.execute('SELECT auth_epoch FROM users WHERE id = ?', (user_id,)).fetchone()['auth_epoch']
        conn.commit()
        return new_epoch
    except sqlite3.Error:
        conn.rollback()
        app.logger.exception('Could not enable administrator MFA')
        return None
    finally:
        conn.close()


def disable_admin_mfa_with_reauthentication(user_id, current_password, code):
    """Disable only the caller's MFA after their password and a fresh TOTP code."""
    if ADMIN_MFA_REQUIRED:
        # Production administrators may not downgrade themselves to a
        # password-only account between startup checks.
        return None
    now_text = datetime.now().astimezone().isoformat(timespec='seconds')
    conn = get_db_connection(row_factory=True)
    try:
        conn.execute('BEGIN IMMEDIATE')
        user = conn.execute(
            "SELECT password FROM users WHERE id = ? AND role = 'admin'",
            (user_id,),
        ).fetchone()
        if not user:
            conn.rollback()
            return None
        try:
            password_is_valid = check_password_hash(user['password'], current_password)
        except ValueError:
            password_is_valid = False
        if not password_is_valid or _verify_and_consume_admin_totp(conn, user_id, code) is None:
            conn.rollback()
            return None
        conn.execute('DELETE FROM admin_mfa_credentials WHERE user_id = ?', (user_id,))
        conn.execute('DELETE FROM admin_mfa_enrollments WHERE user_id = ?', (user_id,))
        conn.execute('DELETE FROM admin_mfa_login_challenges WHERE user_id = ?', (user_id,))
        conn.execute("UPDATE users SET auth_epoch = auth_epoch + 1 WHERE id = ? AND role = 'admin'", (user_id,))
        new_epoch = conn.execute('SELECT auth_epoch FROM users WHERE id = ?', (user_id,)).fetchone()['auth_epoch']
        conn.commit()
        return new_epoch
    except sqlite3.Error:
        conn.rollback()
        app.logger.exception('Could not disable administrator MFA')
        return None
    finally:
        conn.close()


def recover_other_admin_mfa(actor_user_id, current_password, code, target_email):
    """Allow one enrolled admin to revoke another admin's lost MFA with audit at route level."""
    if ADMIN_MFA_REQUIRED:
        # Recovery must use the controlled, out-of-band break-glass process in
        # production; deleting a TOTP credential would violate the MFA gate.
        return None
    normalized_email = str(target_email or '').strip().lower()
    if not is_valid_email(normalized_email):
        return None
    conn = get_db_connection(row_factory=True)
    try:
        conn.execute('BEGIN IMMEDIATE')
        actor = conn.execute(
            "SELECT password FROM users WHERE id = ? AND role = 'admin'",
            (actor_user_id,),
        ).fetchone()
        target = conn.execute(
            "SELECT id FROM users WHERE email = ? AND role = 'admin'",
            (normalized_email,),
        ).fetchone()
        if not actor or not target or target['id'] == actor_user_id:
            conn.rollback()
            return None
        try:
            password_is_valid = check_password_hash(actor['password'], current_password)
        except ValueError:
            password_is_valid = False
        if not password_is_valid or _verify_and_consume_admin_totp(conn, actor_user_id, code) is None:
            conn.rollback()
            return None
        deleted = conn.execute('DELETE FROM admin_mfa_credentials WHERE user_id = ?', (target['id'],))
        if deleted.rowcount != 1:
            conn.rollback()
            return None
        conn.execute('DELETE FROM admin_mfa_enrollments WHERE user_id = ?', (target['id'],))
        conn.execute('DELETE FROM admin_mfa_login_challenges WHERE user_id = ?', (target['id'],))
        conn.execute("UPDATE users SET auth_epoch = auth_epoch + 1 WHERE id = ?", (target['id'],))
        conn.commit()
        return target['id']
    except sqlite3.Error:
        conn.rollback()
        app.logger.exception('Could not complete administrator MFA recovery')
        return None
    finally:
        conn.close()


def establish_authenticated_session(user, mfa_verified=False):
    """Rotate all client-side session state only after complete authentication."""
    session.clear()
    session['user_id'] = user['id']
    session['user_name'] = user['name']
    session['user_email'] = user['email']
    session['user_role'] = user['role']
    session['terms_version'] = user.get('terms_version')
    session['auth_epoch'] = user['auth_epoch']
    if mfa_verified:
        session['mfa_authenticated_at'] = datetime.now().astimezone().isoformat(timespec='seconds')
        session['mfa_authenticated_auth_epoch'] = user['auth_epoch']
    session.permanent = True
    session.modified = True


def login_client_key():
    # Do not trust X-Forwarded-For unless a reverse proxy is explicitly configured.
    return request.remote_addr or 'unknown'


def is_login_rate_limited(client_key):
    now = time.monotonic()
    attempts = [attempt for attempt in LOGIN_ATTEMPTS.get(client_key, []) if now - attempt < LOGIN_RATE_WINDOW_SECONDS]
    if attempts:
        LOGIN_ATTEMPTS[client_key] = attempts
    else:
        LOGIN_ATTEMPTS.pop(client_key, None)
    if len(attempts) >= LOGIN_RATE_LIMIT:
        return True
    return rate_limit_reached('login', client_key, LOGIN_RATE_LIMIT, LOGIN_RATE_WINDOW_SECONDS)


def record_failed_login(client_key):
    LOGIN_ATTEMPTS.setdefault(client_key, []).append(time.monotonic())
    consume_rate_limit('login', client_key, LOGIN_RATE_LIMIT, LOGIN_RATE_WINDOW_SECONDS)


def clear_failed_logins(client_key):
    LOGIN_ATTEMPTS.pop(client_key, None)
    conn = get_db_connection()
    try:
        conn.execute('DELETE FROM rate_limits WHERE scope = ? AND identity_hash = ?', ('login', hashed_rate_limit_identity(client_key)))
        conn.commit()
    finally:
        conn.close()


def hashed_rate_limit_identity(identity):
    value = f'{app.secret_key}:{identity}'.encode('utf-8')
    return hashlib.sha256(value).hexdigest()


def consume_rate_limit(scope, identity, limit, window_seconds):
    """Atomically consume a persistent quota without retaining a raw IP address."""
    window_start = int(time.time() // window_seconds) * window_seconds
    identity_hash = hashed_rate_limit_identity(identity)
    conn = get_db_connection()
    try:
        cursor = conn.cursor()
        cursor.execute('BEGIN IMMEDIATE')
        cursor.execute(
            'SELECT request_count FROM rate_limits WHERE scope = ? AND identity_hash = ? AND window_start = ?',
            (scope, identity_hash, window_start),
        )
        row = cursor.fetchone()
        request_count = row[0] if row else 0
        if request_count >= limit:
            conn.commit()
            return False
        if row:
            cursor.execute(
                'UPDATE rate_limits SET request_count = request_count + 1 WHERE scope = ? AND identity_hash = ? AND window_start = ?',
                (scope, identity_hash, window_start),
            )
        else:
            cursor.execute(
                'INSERT INTO rate_limits (scope, identity_hash, window_start, request_count) VALUES (?, ?, ?, 1)',
                (scope, identity_hash, window_start),
            )
        cursor.execute('DELETE FROM rate_limits WHERE window_start < ?', (window_start - (2 * window_seconds),))
        conn.commit()
        return True
    except sqlite3.Error:
        conn.rollback()
        # Fail closed for health-data actions when rate limiting storage is unavailable.
        return False
    finally:
        conn.close()


def rate_limit_reached(scope, identity, limit, window_seconds):
    window_start = int(time.time() // window_seconds) * window_seconds
    conn = get_db_connection()
    try:
        row = conn.execute(
            'SELECT request_count FROM rate_limits WHERE scope = ? AND identity_hash = ? AND window_start = ?',
            (scope, hashed_rate_limit_identity(identity), window_start),
        ).fetchone()
        return bool(row and row[0] >= limit)
    except sqlite3.Error:
        return True
    finally:
        conn.close()


def require_rate_budget(scope, identity):
    limit, window_seconds = RATE_LIMITS[scope]
    return consume_rate_limit(scope, identity, limit, window_seconds)


def record_audit_event(action, target_type, target_id=None, actor_user_id=None):
    """Record security-relevant actions without copying image or health content."""
    try:
        if actor_user_id is None:
            actor_user_id = session.get('user_id')
        conn = get_db_connection()
        conn.execute(
            'INSERT INTO audit_logs (actor_user_id, action, target_type, target_id, created_at) VALUES (?, ?, ?, ?, ?)',
            (
                actor_user_id,
                action,
                target_type,
                str(target_id) if target_id is not None else None,
                datetime.now().astimezone().isoformat(timespec='seconds'),
            ),
        )
        conn.commit()
        conn.close()
    except (sqlite3.Error, RuntimeError):
        app.logger.exception('Could not write security audit event')


def training_preflight(check_duplicates=False):
    """Read the curated training folder; this never reads user scan uploads."""
    return inspect_dataset(
        TRAINING_DATA_DIR,
        load_training_catalog(),
        minimum_images=RESEARCH_CANDIDATE_MIN_IMAGES_PER_CLASS,
        check_duplicates=check_duplicates,
    )


def read_approved_training_manifest():
    manifest_path = TRAINING_DATA_DIR / 'dataset_manifest.json'
    try:
        manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
    except (OSError, json.JSONDecodeError) as error:
        raise ValueError('ไม่สามารถอ่าน dataset_manifest.json ที่ผ่านการอนุมัติได้') from error
    if not isinstance(manifest, dict) or not manifest.get('approved_for_training'):
        raise ValueError('dataset_manifest.json ยังไม่ได้รับอนุมัติให้ใช้ฝึกโมเดล')
    source = manifest.get('source')
    license_name = manifest.get('license')
    if not isinstance(source, str) or not source.strip() or not isinstance(license_name, str) or not license_name.strip():
        raise ValueError('dataset_manifest.json ต้องระบุแหล่งที่มาและสิทธิ์ใช้ข้อมูล')
    return manifest


def has_active_training_job():
    conn = get_db_connection()
    try:
        row = conn.execute(
            "SELECT id FROM training_jobs WHERE status IN ('queued', 'running') LIMIT 1"
        ).fetchone()
        return row is not None
    finally:
        conn.close()


def training_command(job_id, epochs, manifest):
    output_path = TRAINING_CANDIDATE_DIR / f'candidate-{job_id}.h5'
    return [
        os.environ.get('SMART_SKIN_TRAINING_PYTHON', sys.executable),
        str(PROJECT_ROOT / 'train_multiclass.py'),
        '--data-dir', str(TRAINING_DATA_DIR),
        '--dataset-manifest', str(TRAINING_DATA_DIR / 'dataset_manifest.json'),
        '--group', 'all',
        '--allow-mixed-domains',
        '--dataset-source', manifest['source'],
        '--dataset-license', manifest['license'],
        '--output', str(output_path),
        '--epochs', str(epochs),
        '--min-images', str(RESEARCH_CANDIDATE_MIN_IMAGES_PER_CLASS),
    ]


def finish_training_job(job_id, process):
    """Persist a child-process outcome without ever activating its model artifact."""
    exit_code = process.wait()
    completed_at = datetime.now().astimezone().isoformat(timespec='seconds')
    status = 'completed' if exit_code == 0 else 'failed'
    error_summary = None if exit_code == 0 else f'งานฝึกโมเดลสิ้นสุดด้วย exit code {exit_code}; โปรดดูไฟล์ log ที่จัดเก็บแบบ private'
    conn = get_db_connection()
    try:
        conn.execute(
            """UPDATE training_jobs
               SET status = ?, finished_at = ?, exit_code = ?, error_summary = ?
               WHERE id = ?""",
            (status, completed_at, exit_code, error_summary, job_id),
        )
        conn.commit()
    finally:
        conn.close()
    record_audit_event(f'training_job_{status}', 'training_job', job_id, actor_user_id=0)


def start_training_job(requested_by, epochs, preflight, manifest):
    """Start one deterministic, admin-authorized training process in the background."""
    if has_active_training_job():
        raise ValueError('มีงานฝึกโมเดลที่กำลังรันอยู่แล้ว')

    job_id = uuid4().hex
    output_path = TRAINING_CANDIDATE_DIR / f'candidate-{job_id}.h5'
    metadata_path = output_path.with_suffix('.metadata.json')
    evaluation_path = output_path.with_suffix('.evaluation.json')
    log_path = TRAINING_LOG_DIR / f'{job_id}.log'
    now = datetime.now().astimezone().isoformat(timespec='seconds')
    conn = get_db_connection()
    try:
        conn.execute(
            """INSERT INTO training_jobs
               (id, requested_by, status, epochs, output_path, metadata_path, evaluation_path, log_path, preflight_json, created_at)
               VALUES (?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?)""",
            (
                job_id, requested_by, epochs, str(output_path), str(metadata_path),
                str(evaluation_path), str(log_path), json.dumps(preflight, ensure_ascii=False), now,
            ),
        )
        conn.commit()
    finally:
        conn.close()

    try:
        creationflags = subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0
        with log_path.open('w', encoding='utf-8') as log_file:
            process = subprocess.Popen(
                training_command(job_id, epochs, manifest),
                cwd=str(PROJECT_ROOT),
                stdin=subprocess.DEVNULL,
                stdout=log_file,
                stderr=subprocess.STDOUT,
                shell=False,
                creationflags=creationflags,
            )
        conn = get_db_connection()
        try:
            conn.execute(
                "UPDATE training_jobs SET status = 'running', process_id = ?, started_at = ? WHERE id = ?",
                (process.pid, datetime.now().astimezone().isoformat(timespec='seconds'), job_id),
            )
            conn.commit()
        finally:
            conn.close()
    except OSError as error:
        conn = get_db_connection()
        try:
            conn.execute(
                "UPDATE training_jobs SET status = 'failed', finished_at = ?, error_summary = ? WHERE id = ?",
                (datetime.now().astimezone().isoformat(timespec='seconds'), 'ไม่สามารถเริ่ม worker ฝึกโมเดลได้: ' + str(error), job_id),
            )
            conn.commit()
        finally:
            conn.close()
        raise ValueError('ไม่สามารถเริ่ม worker ฝึกโมเดลได้') from error

    threading.Thread(target=finish_training_job, args=(job_id, process), daemon=True).start()
    record_audit_event('training_job_started', 'training_job', job_id, actor_user_id=requested_by)
    return job_id


def training_job_view(row):
    """Expose only aggregate development metrics to the administrator UI."""
    job = dict(row)
    metrics = None
    evaluation_path = Path(job['evaluation_path'])
    if job['status'] == 'completed' and is_path_inside(evaluation_path, TRAINING_CANDIDATE_DIR) and evaluation_path.is_file():
        try:
            evaluation = json.loads(evaluation_path.read_text(encoding='utf-8'))
            per_class = evaluation.get('per_class_metrics', {})
            lowest_recall = sorted(
                (
                    {'class_id': class_id, 'recall': values.get('recall'), 'support': values.get('support')}
                    for class_id, values in per_class.items()
                    if isinstance(values, dict) and values.get('recall') is not None
                ),
                key=lambda item: item['recall'],
            )[:3]
            metrics = {
                'validation_accuracy': evaluation.get('validation_accuracy'),
                'validation_examples': evaluation.get('validation_examples'),
                'lowest_recall': lowest_recall,
            }
        except (OSError, json.JSONDecodeError, TypeError, ValueError):
            metrics = {'error': 'อ่านไฟล์ผลประเมินของ candidate model ไม่ได้'}
    job['metrics'] = metrics
    return job


def analysis_is_available():
    # Tests and local development may exercise an unapproved model, but a
    # production process never accepts a health image until all evidence gates pass.
    if app.config.get('PUBLIC_INFORMATION_MODE'):
        return False
    return model is not None and (app.config.get('TESTING') or not IS_PRODUCTION or MODEL_READINESS['approved'])


def available_image_domains():
    """Return only image domains with real output classes in this model artifact."""
    return [
        {
            'id': domain,
            'label': IMAGE_DOMAIN_DETAILS[domain]['label'],
            'hint': IMAGE_DOMAIN_DETAILS[domain]['hint'],
            'class_count': len(class_names),
        }
        for domain, class_names in MODEL_CLASS_NAMES_BY_DOMAIN.items()
        if class_names
    ]


def resolve_image_domain(selected_domain):
    """Resolve a declared image domain without making a modality prediction."""
    active_domains = {item['id'] for item in available_image_domains()}
    if selected_domain in active_domains:
        return selected_domain
    if not selected_domain and len(active_domains) == 1:
        # Retains compatibility with the legacy six-class dermoscopy artifact
        # in local/test use. Production 50-class releases have two domains and
        # therefore require an explicit user selection.
        return next(iter(active_domains))
    return None


def purge_expired_scan_data(now=None):
    """Delete retained scan images and voluntary reports after their stated expiry."""
    timestamp = now or datetime.now().astimezone()
    conn = get_db_connection()
    try:
        cursor = conn.cursor()
        cursor.execute(
            'SELECT id, image_path, gradcam_path FROM scan_logs WHERE retention_expires_at IS NOT NULL AND retention_expires_at <= ?',
            (timestamp.isoformat(timespec='seconds'),),
        )
        expired = cursor.fetchall()
        if expired:
            cursor.executemany('DELETE FROM scan_logs WHERE id = ?', [(row[0],) for row in expired])
        cursor.execute(
            'SELECT id FROM concern_reports WHERE retention_expires_at IS NOT NULL AND retention_expires_at <= ?',
            (timestamp.isoformat(timespec='seconds'),),
        )
        expired_concern_reports = cursor.fetchall()
        if expired_concern_reports:
            cursor.executemany('DELETE FROM concern_reports WHERE id = ?', [(row[0],) for row in expired_concern_reports])
        cursor.execute(
            'SELECT id FROM nearby_context_reports WHERE retention_expires_at IS NOT NULL AND retention_expires_at <= ?',
            (timestamp.isoformat(timespec='seconds'),),
        )
        expired_nearby_contexts = cursor.fetchall()
        if expired_nearby_contexts:
            cursor.executemany('DELETE FROM nearby_context_reports WHERE id = ?', [(row[0],) for row in expired_nearby_contexts])
        cursor.execute(
            'SELECT id FROM feedbacks WHERE retention_expires_at IS NOT NULL AND retention_expires_at <= ?',
            (timestamp.isoformat(timespec='seconds'),),
        )
        expired_feedback = cursor.fetchall()
        if expired_feedback:
            cursor.executemany('DELETE FROM feedbacks WHERE id = ?', [(row[0],) for row in expired_feedback])
        if expired or expired_concern_reports or expired_nearby_contexts or expired_feedback:
            conn.commit()
    finally:
        conn.close()

    for _, image_path, gradcam_path in expired if 'expired' in locals() else []:
        for artifact_path in (image_path, gradcam_path):
            if artifact_path:
                delete_private_upload(artifact_path)
    if expired:
        record_audit_event('retention_purge', 'scan_log_batch', len(expired), actor_user_id=0)
    if 'expired_concern_reports' in locals() and expired_concern_reports:
        record_audit_event('retention_purge', 'concern_report_batch', len(expired_concern_reports), actor_user_id=0)
    if 'expired_nearby_contexts' in locals() and expired_nearby_contexts:
        record_audit_event('retention_purge', 'nearby_context_batch', len(expired_nearby_contexts), actor_user_id=0)
    if 'expired_feedback' in locals() and expired_feedback:
        record_audit_event('retention_purge', 'feedback_batch', len(expired_feedback), actor_user_id=0)
    removed_queued_avatars = retry_queued_profile_avatar_deletions()
    if removed_queued_avatars:
        record_audit_event('profile_avatar_deletion_retry', 'profile_avatar_batch', removed_queued_avatars, actor_user_id=0)
    return (
        len(expired if 'expired' in locals() else [])
        + len(expired_concern_reports if 'expired_concern_reports' in locals() else [])
        + len(expired_nearby_contexts if 'expired_nearby_contexts' in locals() else [])
        + len(expired_feedback if 'expired_feedback' in locals() else [])
    )


def delete_private_upload(filename):
    """Remove an application-owned private upload when its database record is deleted."""
    safe_filename = secure_filename(filename)
    filepath = os.path.join(app.config['UPLOAD_FOLDER'], safe_filename)
    if os.path.isfile(filepath):
        os.remove(filepath)


def is_profile_avatar_filename(filename):
    """Accept only names minted by the profile-avatar writer.

    Profile images share the private upload root with scan artifacts, so a
    profile record must never be allowed to reference an arbitrary file there.
    """
    return isinstance(filename, str) and bool(PROFILE_AVATAR_FILENAME_PATTERN.fullmatch(filename))


def _unlink_profile_avatar_upload(filename):
    """Attempt to unlink a minted avatar without touching any other upload."""
    if not is_profile_avatar_filename(filename):
        return True
    filepath = Path(app.config['UPLOAD_FOLDER']) / filename
    try:
        filepath.unlink()
    except FileNotFoundError:
        return True
    except OSError:
        return False
    return True


def queue_profile_avatar_deletion(filename):
    """Persist a retry when Windows still has an old avatar file open."""
    if not is_profile_avatar_filename(filename):
        return
    try:
        conn = get_db_connection()
        conn.execute(
            '''INSERT OR IGNORE INTO profile_avatar_deletion_queue (image_path, queued_at)
               VALUES (?, ?)''',
            (filename, datetime.now().astimezone().isoformat(timespec='seconds')),
        )
        conn.commit()
    except sqlite3.Error:
        app.logger.exception('Unable to queue a stale profile-avatar file for deletion')
    finally:
        if 'conn' in locals():
            conn.close()


def delete_profile_avatar_upload(filename):
    """Delete a profile avatar only when it has an application-owned name.

    A currently downloading image can remain open briefly on Windows.  Its
    database record is already gone, so queue a durable retry rather than
    failing an otherwise successful update, removal, or account deletion.
    """
    if not _unlink_profile_avatar_upload(filename):
        queue_profile_avatar_deletion(filename)
        return False
    return True


def retry_queued_profile_avatar_deletions():
    """Retry only queued, application-owned avatar names; never scan folders."""
    conn = get_db_connection()
    try:
        queued = conn.execute(
            'SELECT image_path FROM profile_avatar_deletion_queue'
        ).fetchall()
    finally:
        conn.close()
    removed = []
    for (filename,) in queued:
        if _unlink_profile_avatar_upload(filename):
            removed.append((filename,))
    if removed:
        conn = get_db_connection()
        try:
            conn.executemany(
                'DELETE FROM profile_avatar_deletion_queue WHERE image_path = ?',
                removed,
            )
            conn.commit()
        finally:
            conn.close()
    return len(removed)


def get_user_profile_avatar(user_id):
    """Get one valid avatar record for the signed-in user, if it still exists.

    The actual image is deliberately not exposed here.  The account-scoped
    route below authorizes the request again before it serves any bytes.
    """
    if not isinstance(user_id, int):
        return None
    conn = get_db_connection(row_factory=True)
    try:
        row = conn.execute(
            'SELECT image_path, updated_at FROM profile_avatars WHERE user_id = ?',
            (user_id,),
        ).fetchone()
    finally:
        conn.close()
    if not row or not is_profile_avatar_filename(row['image_path']):
        return None
    image_path = Path(app.config['UPLOAD_FOLDER']) / row['image_path']
    if not image_path.is_file():
        return None
    return {'image_path': row['image_path'], 'updated_at': row['updated_at']}


def normalize_profile_avatar(uploaded_file):
    """Validate and re-encode an uploaded avatar without preserving metadata.

    The output is always a fixed-size JPEG.  This eliminates EXIF metadata
    (including camera location), non-image payloads, animation, and unbounded
    image dimensions before anything is placed in private storage.
    """
    if uploaded_file is None or not uploaded_file.filename:
        raise ValueError('กรุณาเลือกรูปโปรไฟล์ก่อนบันทึก')
    if uploaded_file.content_length and uploaded_file.content_length > PROFILE_AVATAR_MAX_BYTES:
        raise ValueError('รูปโปรไฟล์มีขนาดเกิน 2 MB กรุณาเลือกไฟล์ที่เล็กลง')
    try:
        uploaded_file.stream.seek(0, os.SEEK_END)
        input_size = uploaded_file.stream.tell()
        uploaded_file.stream.seek(0)
    except (AttributeError, OSError):
        raise ValueError('ไม่สามารถอ่านไฟล์รูปโปรไฟล์ได้')
    if input_size <= 0 or input_size > PROFILE_AVATAR_MAX_BYTES:
        raise ValueError('รูปโปรไฟล์ต้องเป็นไฟล์ภาพขนาดไม่เกิน 2 MB')

    try:
        with warnings.catch_warnings():
            warnings.simplefilter('error', Image.DecompressionBombWarning)
            with Image.open(uploaded_file.stream) as verified_image:
                verified_image.verify()
            uploaded_file.stream.seek(0)
            with Image.open(uploaded_file.stream) as source_image:
                if source_image.format not in PROFILE_AVATAR_ALLOWED_FORMATS:
                    raise UnidentifiedImageError('Unsupported profile image format')
                width, height = source_image.size
                if min(width, height) < PROFILE_AVATAR_MIN_DIMENSION:
                    raise ValueError('รูปโปรไฟล์ต้องกว้างและสูงอย่างน้อย 64 พิกเซล')
                if width * height > PROFILE_AVATAR_MAX_PIXELS:
                    raise ValueError('รูปโปรไฟล์มีความละเอียดสูงเกินไป')
                source_image.load()
                normalized = ImageOps.exif_transpose(source_image)
                if normalized.mode in {'RGBA', 'LA'} or 'transparency' in normalized.info:
                    rgba_image = normalized.convert('RGBA')
                    background = Image.new('RGB', rgba_image.size, 'white')
                    background.paste(rgba_image, mask=rgba_image.getchannel('A'))
                    normalized = background
                else:
                    normalized = normalized.convert('RGB')
                normalized = ImageOps.fit(
                    normalized,
                    (PROFILE_AVATAR_OUTPUT_DIMENSION, PROFILE_AVATAR_OUTPUT_DIMENSION),
                    method=Image.Resampling.LANCZOS,
                    centering=(0.5, 0.5),
                )
                encoded = BytesIO()
                normalized.save(encoded, format='JPEG', quality=88, optimize=True, progressive=False)
    except ValueError:
        raise
    except (UnidentifiedImageError, Image.DecompressionBombError, Image.DecompressionBombWarning, OSError):
        raise ValueError('ไฟล์ที่อัปโหลดไม่ใช่รูปภาพ JPEG, PNG หรือ WEBP ที่เปิดอ่านได้')

    image_bytes = encoded.getvalue()
    if not image_bytes or len(image_bytes) > PROFILE_AVATAR_MAX_BYTES:
        raise ValueError('ไม่สามารถบันทึกรูปโปรไฟล์ให้อยู่ในขนาดที่ปลอดภัยได้')
    return image_bytes


def write_profile_avatar_file(image_bytes):
    """Atomically write a newly normalized profile avatar to private storage."""
    filename = f'profile_{uuid4().hex}.jpg'
    destination = Path(app.config['UPLOAD_FOLDER']) / filename
    temporary = destination.with_suffix('.tmp')
    try:
        with open(temporary, 'xb') as output_file:
            output_file.write(image_bytes)
            output_file.flush()
            os.fsync(output_file.fileno())
        os.replace(temporary, destination)
    except OSError:
        if temporary.is_file():
            temporary.unlink()
        if destination.is_file():
            destination.unlink()
        raise
    return filename


def csrf_token():
    if 'csrf_token' not in session:
        session['csrf_token'] = secrets.token_urlsafe(32)
    return session['csrf_token']


@app.context_processor
def inject_csrf_token():
    return {'csrf_token': csrf_token, 'csp_nonce': getattr(g, 'csp_nonce', '')}


@app.context_processor
def inject_model_scope():
    active_domains = available_image_domains()
    return {
        'model_class_count': len(MODEL_CLASS_NAMES),
        'target_class_count': TARGET_CLASS_COUNT,
        'model_version': MODEL_VERSION,
        'analysis_available': analysis_is_available(),
        'model_release_ready': MODEL_READINESS['approved'],
        'active_image_domains': active_domains,
        'model_readiness_problems': MODEL_READINESS['problems'],
        'terms_version': TERMS_VERSION,
        'privacy_contact': configured_privacy_contact or 'ผู้ดูแลข้อมูลยังไม่ได้กำหนดช่องทางติดต่อ',
        'data_controller_name': configured_data_controller or 'ผู้ให้บริการ Smart Skin AI',
        'retention_days': app.config['UPLOAD_RETENTION_DAYS'],
        'location_context_retention_hours': LOCATION_CONTEXT_RETENTION_HOURS,
        'demo_features_enabled': os.environ.get('SMART_SKIN_ENABLE_DEMO_FEATURES') == '1' and not IS_PRODUCTION,
        'password_reset_email_configured': PASSWORD_RESET_EMAIL_CONFIGURED,
        'public_information_mode': app.config['PUBLIC_INFORMATION_MODE'],
    }


PUBLIC_INFORMATION_ALLOWED_ENDPOINTS = frozenset({
    'home',
    'privacy',
    'terms',
    'service_worker',
    'healthz',
    'readyz',
    'static',
})


@app.before_request
def enforce_csrf_protection():
    global last_retention_cleanup_at
    g.csp_nonce = secrets.token_urlsafe(18)
    now_monotonic = time.monotonic()
    if (
        not app.config['PUBLIC_INFORMATION_MODE']
        and now_monotonic - last_retention_cleanup_at >= RETENTION_CLEANUP_INTERVAL_SECONDS
    ):
        purge_expired_scan_data()
        last_retention_cleanup_at = now_monotonic
    # A public-information deployment must not accidentally collect health or
    # account data because a user discovers a legacy route.  It remains useful
    # for public education, privacy/terms, optional weather, and health probes.
    if (
        app.config['PUBLIC_INFORMATION_MODE']
        and request.endpoint not in PUBLIC_INFORMATION_ALLOWED_ENDPOINTS
    ):
        session.clear()
        if request.method == 'GET':
            return redirect(url_for('home'))
        abort(404)
    if request.method == 'POST':
        form_token = request.form.get('csrf_token', '') or request.headers.get('X-CSRF-Token', '')
        session_token = session.get('csrf_token', '')
        if not session_token or not hmac.compare_digest(form_token, session_token):
            abort(400, description='คำขอไม่ถูกต้องหรือหมดอายุ กรุณาลองใหม่อีกครั้ง')


@app.after_request
def apply_security_headers(response):
    response.headers.setdefault('X-Content-Type-Options', 'nosniff')
    response.headers.setdefault('X-Frame-Options', 'DENY')
    response.headers.setdefault('Cross-Origin-Opener-Policy', 'same-origin')
    response.headers.setdefault('Cross-Origin-Resource-Policy', 'same-origin')
    response.headers.setdefault('X-Permitted-Cross-Domain-Policies', 'none')
    response.headers.setdefault('Referrer-Policy', 'strict-origin-when-cross-origin')
    response.headers.setdefault(
        'Permissions-Policy',
        'camera=(), geolocation=(self), microphone=()'
        if app.config['PUBLIC_INFORMATION_MODE']
        else 'camera=(self), geolocation=(self), microphone=()',
    )
    response.headers.setdefault(
        'Content-Security-Policy',
        "default-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; object-src 'none'; "
        f"script-src 'self' 'nonce-{getattr(g, 'csp_nonce', '')}' https://cdn.tailwindcss.com https://unpkg.com; "
        "script-src-attr 'unsafe-inline'; "
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; "
        "img-src 'self' data: https://images.unsplash.com; connect-src 'self' https://api.open-meteo.com https://air-quality-api.open-meteo.com https://nominatim.openstreetmap.org; "
        "frame-src https://maps.google.com https://www.google.com https://www.openstreetmap.org; media-src 'self'",
    )
    # New security links carry their verifier only in a browser fragment and
    # exchange it for a session-bound handoff.  Keep the clean landing and the
    # temporary legacy compatibility routes especially strict as well.
    if request.endpoint in {
        'reset_password', 'verify_email',
        'reset_password_legacy', 'verify_email_legacy',
        'claim_password_reset', 'claim_email_verification',
    }:
        response.headers['Referrer-Policy'] = 'no-referrer'
        response.headers['X-Robots-Tag'] = 'noindex, nofollow, noarchive'
    # Dynamic pages may contain a session-bound CSRF token, account state, or
    # health data.  Keep them out of the browser HTTP cache; the service worker
    # separately caches only its strict public-shell allowlist.
    if not request.path.startswith('/static/') and request.endpoint != 'service_worker':
        response.headers['Cache-Control'] = 'no-store, max-age=0'
        response.headers['Pragma'] = 'no-cache'
    if app.config['SESSION_COOKIE_SECURE']:
        response.headers.setdefault('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
    return response


@app.errorhandler(413)
def uploaded_file_too_large(error):
    flash('ไฟล์มีขนาดเกิน 8 MB กรุณาเลือกรูปที่เล็กลง', 'error')
    return redirect(url_for('dashboard')), 413

def determine_decision_status(confidence_percent, margin_percent):
    """Classify score safety without claiming to identify untrained conditions."""
    confidence = confidence_percent / 100
    margin = margin_percent / 100
    if confidence < MODEL_OUT_OF_SCOPE_THRESHOLD:
        return 'out_of_scope'
    if confidence < MODEL_ABSTENTION_THRESHOLD or margin < MODEL_MARGIN_THRESHOLD:
        return 'ambiguous'
    return 'supported'


def assess_image_quality(uploaded_image):
    """Reject technically unusable images before model scoring.

    The checks intentionally evaluate exposure and visible detail only.  They
    do not infer a person's skin tone, condition, or diagnosis.
    """
    preview = uploaded_image.convert('RGB').copy()
    preview.thumbnail((640, 640), Image.Resampling.LANCZOS)
    pixels = np.asarray(preview, dtype='float32')
    luminance = (
        pixels[:, :, 0] * 0.2126
        + pixels[:, :, 1] * 0.7152
        + pixels[:, :, 2] * 0.0722
    )
    brightness = float(np.mean(luminance))
    contrast = float(np.std(luminance))
    horizontal_detail = float(np.mean(np.abs(np.diff(luminance, axis=1))))
    vertical_detail = float(np.mean(np.abs(np.diff(luminance, axis=0))))
    edge_detail = (horizontal_detail + vertical_detail) / 2
    reasons = []
    if brightness < IMAGE_QUALITY_BRIGHTNESS_RANGE[0]:
        reasons.append('ภาพมืดเกินไป')
    elif brightness > IMAGE_QUALITY_BRIGHTNESS_RANGE[1]:
        reasons.append('ภาพสว่างหรือขาวโพลนเกินไป')
    if contrast < IMAGE_QUALITY_MIN_CONTRAST:
        reasons.append('ภาพมีความต่างแสงน้อยเกินไป')
    if edge_detail < IMAGE_QUALITY_MIN_EDGE_DETAIL:
        reasons.append('ไม่พบรายละเอียดของภาพเพียงพอ')
    return {
        'accepted': not reasons,
        'reasons': reasons,
        'brightness': brightness,
        'contrast': contrast,
        'edge_detail': edge_detail,
    }


def assess_model_scope(prediction):
    """Conservatively decline images outside the model's validated score scope."""
    confidence = float(prediction.get('confidence', 0.0)) / 100
    if confidence < IMAGE_SCOPE_MIN_CONFIDENCE:
        return {
            'accepted': False,
            'reason': 'ภาพไม่ให้สัญญาณว่าอยู่ในขอบเขตภาพรอยโรคที่โมเดลรองรับเพียงพอ',
        }
    return {'accepted': True, 'reason': None}


def build_result_info(disease_key, decision_status='supported'):
    """Return presentation copy without treating a model label as a diagnosis."""
    label = display_name_for_label(disease_key)
    if decision_status == 'out_of_scope':
        return {
            "th_name": "ไม่พบกลุ่มที่ใกล้เคียงเพียงพอในโมเดล",
            "msg": "ภาพนี้อาจอยู่นอกขอบเขตที่โมเดลคัดกรองได้ หรือคุณภาพภาพยังไม่เพียงพอ",
            "desc": "คะแนนของทุกกลุ่มที่โมเดลรองรับต่ำ จึงไม่สามารถบอกชื่อโรคที่ไม่มีอยู่ในระบบจากภาพนี้ได้ รายการอันดับด้านล่างเป็นเพียงกลุ่มที่ถูกเปรียบเทียบ ไม่ใช่ข้อสรุปว่าเป็นโรคเหล่านั้น",
            "advice": "ควรถ่ายภาพใหม่ในแสงสม่ำเสมอและให้เห็นรอยโรคชัดเจน หรือปรึกษาแพทย์ผิวหนัง โดยเฉพาะเมื่อรอยโรคใหม่ เปลี่ยนแปลง โตเร็ว เจ็บ คันมาก หรือมีเลือดออก",
        }
    if decision_status == 'ambiguous':
        return {
            "th_name": "ผลคัดกรองยังไม่ชัดเจน",
            "msg": "คะแนนของกลุ่มที่ใกล้เคียงกันอยู่ในช่วงที่ระบบไม่ควรฟันธง",
            "desc": "ระบบจะแสดงกลุ่มที่มีคะแนนสูงสุด 3 อันดับเพื่อความโปร่งใส แต่ไม่สามารถใช้ระบุว่าเป็นโรคใดโรคหนึ่งได้จากภาพนี้",
            "advice": "ควรถ่ายภาพใหม่ในแสงสม่ำเสมอหรือปรึกษาแพทย์ผิวหนัง โดยเฉพาะเมื่อรอยโรคใหม่ เปลี่ยนแปลง โตเร็ว เจ็บ คันมาก หรือมีเลือดออก",
        }
    return {
        "th_name": f"ผลจำแนกจากโมเดล: {label}",
        "msg": "ผลนี้เป็นการคัดกรองจากภาพด้วยโมเดล ไม่ใช่การวินิจฉัยโรค",
        "desc": "โมเดลเลือกกลุ่มที่มีความน่าจะเป็นสูงสุดจากภาพที่อัปโหลด ผลอาจคลาดเคลื่อนจากคุณภาพภาพและข้อจำกัดของชุดข้อมูล",
        "advice": "หากรอยโรคใหม่ เปลี่ยนแปลง โตเร็ว เลือดออก หรือมีความกังวล ควรปรึกษาแพทย์ผิวหนังเพื่อรับการประเมิน",
    }

# -------------------------------------------------------------------------
# 🛠️ ระบบจัดการสิทธิ์การใช้งาน (Decorators & Auth)
# -------------------------------------------------------------------------
def login_required(f):
    @wraps(f)
    def decorated_function(*args, **kwargs):
        user_id = session.get('user_id')
        user_email = session.get('user_email')
        if not user_id or not user_email:
            flash('กรุณาเข้าสู่ระบบก่อนใช้งาน', 'error')
            return redirect(url_for('home'))

        conn = get_db_connection()
        cursor = conn.cursor()
        cursor.execute(
            '''SELECT users.name, users.email, users.role, users.is_approved,
                      users.terms_version, users.auth_epoch, users.email_verified_at,
                      EXISTS(SELECT 1 FROM admin_mfa_credentials WHERE admin_mfa_credentials.user_id = users.id)
               FROM users WHERE users.id = ?''',
            (user_id,),
        )
        user = cursor.fetchone()
        conn.close()

        if (
            not user
            or user[1] != user_email
            or user[2] not in {'user', 'admin'}
            or (user[2] != 'admin' and user[3] != 1)
            or session.get('auth_epoch') != user[5]
            or (user[2] == 'user' and not user[6])
            or (user[2] == 'admin' and ADMIN_MFA_REQUIRED and not bool(user[7]))
            or (
                user[2] == 'admin'
                and bool(user[7])
                and (
                    not session.get('mfa_authenticated_at')
                    or session.get('mfa_authenticated_auth_epoch') != user[5]
                )
            )
        ):
            session.clear()
            flash('เซสชันหมดอายุหรือสิทธิ์การใช้งานเปลี่ยนแปลง กรุณาเข้าสู่ระบบอีกครั้ง', 'error')
            return redirect(url_for('home'))

        # Keep the signed client-side session synchronized with current account data.
        session['user_name'] = user[0]
        session['user_email'] = user[1]
        session['user_role'] = user[2]
        session['terms_version'] = user[4]
        session['auth_epoch'] = user[5]
        return f(*args, **kwargs)
    return decorated_function

def admin_required(f):
    @wraps(f)
    def decorated_function(*args, **kwargs):
        if session.get('user_role') != 'admin':
            flash('⚠️ เฉพาะผู้พัฒนาระบบ / แอดมินเท่านั้นที่เข้าถึงหน้านี้ได้', 'error')
            return redirect(url_for('dashboard'))
        return f(*args, **kwargs)
    return decorated_function


def get_user_scan_history():
    """Return only the signed-in user's recent scans for the dashboard timeline."""
    user_id = session.get('user_id')
    if not user_id:
        return []

    conn = get_db_connection(row_factory=True)
    cursor = conn.cursor()
    cursor.execute(
        """
        SELECT id, image_path, gradcam_path, result_disease, confidence, created_at, is_uncertain, decision_status
        FROM scan_logs
        WHERE user_id = ?
        ORDER BY id DESC
        LIMIT 20
        """,
        (user_id,),
    )
    scan_logs = cursor.fetchall()
    conn.close()

    return [
        {
            'id': scan_log['id'],
            'image_url': url_for('scan_image', filename=scan_log['image_path']),
            'gradcam_url': url_for('scan_image', filename=scan_log['gradcam_path']) if scan_log['gradcam_path'] else None,
            'result_disease': scan_log['result_disease'],
            'confidence': scan_log['confidence'],
            'created_at': scan_log['created_at'],
            'is_uncertain': bool(scan_log['is_uncertain']),
            'decision_status': scan_log['decision_status'] or ('ambiguous' if scan_log['is_uncertain'] else 'supported'),
        }
        for scan_log in scan_logs
    ]


def environmental_context_level(pm25, uv_index, relative_humidity, temperature_c):
    """Return a transparent, non-diagnostic environmental notice from public readings."""
    notices = []
    if uv_index >= 6:
        notices.append('ดัชนี UV สูง ควรหลีกเลี่ยงแดดจัดและป้องกันผิว')
    if pm25 >= 37.5:
        notices.append('PM2.5 สูง ควรลดการสัมผัสฝุ่นเมื่อทำได้')
    if temperature_c >= 33 and relative_humidity >= 70:
        notices.append('อากาศร้อนชื้น ควรรักษาผิวให้สะอาดและแห้งสบาย')
    if len(notices) >= 2:
        level = 'ควรระวังมาก'
    elif notices:
        level = 'ควรระวัง'
    else:
        level = 'ข้อมูลทั่วไป'
        notices.append('ไม่พบเงื่อนไขแจ้งเตือนจากกติกาสิ่งแวดล้อมของระบบ')
    return level, ' · '.join(notices)


def finite_payload_number(payload, key, minimum, maximum):
    value = payload.get(key)
    if isinstance(value, bool):
        raise ValueError(f'{key} ต้องเป็นตัวเลข')
    try:
        value = float(value)
    except (TypeError, ValueError) as error:
        raise ValueError(f'{key} ต้องเป็นตัวเลข') from error
    if not value == value or value in {float('inf'), float('-inf')} or not minimum <= value <= maximum:
        raise ValueError(f'{key} อยู่นอกช่วงที่อนุญาต')
    return value


def get_user_nearby_context(user_id):
    conn = get_db_connection(row_factory=True)
    try:
        row = conn.execute(
            """SELECT latitude_approx, longitude_approx, pm25, uv_index, relative_humidity,
                      temperature_c, context_level, context_summary, consented_at, retention_expires_at
               FROM nearby_context_reports
               WHERE user_id = ? AND retention_expires_at > ?
               ORDER BY id DESC LIMIT 1""",
            (user_id, datetime.now().astimezone().isoformat(timespec='seconds')),
        ).fetchone()
        return dict(row) if row else None
    finally:
        conn.close()


def delete_regular_user_account(user_id):
    """Delete a regular user's account and owned health artifacts, returning file names.

    Audit events are intentionally retained without health content so that a
    security investigation can still establish that deletion was requested.
    """
    conn = get_db_connection()
    try:
        cursor = conn.cursor()
        # Acquire the write lock before reading owned records so the database
        # deletion is one transaction even when a reset/verification request
        # races with account deletion.
        cursor.execute('BEGIN IMMEDIATE')
        user = cursor.execute(
            "SELECT email, role FROM users WHERE id = ?", (user_id,)
        ).fetchone()
        if not user or user[1] != 'user':
            conn.rollback()
            return None
        user_email = user[0]
        artifact_rows = cursor.execute(
            "SELECT image_path, gradcam_path FROM scan_logs WHERE user_id = ?", (user_id,)
        ).fetchall()
        artifact_paths = [artifact_path for row in artifact_rows for artifact_path in row if artifact_path]
        avatar_row = cursor.execute(
            "SELECT image_path FROM profile_avatars WHERE user_id = ?", (user_id,)
        ).fetchone()
        if avatar_row and is_profile_avatar_filename(avatar_row[0]):
            artifact_paths.append(avatar_row[0])
        cursor.execute("DELETE FROM scan_logs WHERE user_id = ?", (user_id,))
        cursor.execute("DELETE FROM concern_reports WHERE user_id = ?", (user_id,))
        cursor.execute("DELETE FROM nearby_context_reports WHERE user_id = ?", (user_id,))
        cursor.execute("DELETE FROM feedbacks WHERE user_id = ? OR user_email = ?", (user_id, user_email))
        cursor.execute("DELETE FROM profile_avatars WHERE user_id = ?", (user_id,))
        # These tables intentionally retain foreign keys (rather than using
        # cascades) so security-link ownership is explicit.  Remove both the
        # account's own tokens and any legacy requester reference before
        # deleting the user; otherwise SQLite correctly rejects the delete.
        cursor.execute(
            "DELETE FROM password_reset_tokens WHERE user_id = ? OR requested_by_user_id = ?",
            (user_id, user_id),
        )
        cursor.execute("DELETE FROM email_verification_tokens WHERE user_id = ?", (user_id,))
        deleted_user = cursor.execute(
            "DELETE FROM users WHERE id = ? AND role = 'user'", (user_id,)
        )
        if deleted_user.rowcount != 1:
            conn.rollback()
            return None
        conn.commit()
        return artifact_paths
    except sqlite3.Error:
        conn.rollback()
        # The account remains intact if any dependent record cannot be removed.
        # Keep database details out of the user-facing deletion response.
        app.logger.exception('Unable to delete a regular user account transactionally')
        return None
    finally:
        conn.close()


# -------------------------------------------------------------------------
# 🗄️ การเตรียมและอัปเดตฐานข้อมูล (Database Init)
# -------------------------------------------------------------------------
def init_db():
    conn = get_db_connection()
    cursor = conn.cursor()
    
    # 1. สร้างตาราง users พร้อมคอลัมน์ is_approved และ last_login
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT, 
            name TEXT, 
            email TEXT UNIQUE, 
            password TEXT,
            role TEXT DEFAULT 'user',
            is_approved INTEGER DEFAULT 0,
            last_login TEXT,
            terms_accepted_at TEXT,
            terms_version TEXT,
            email_verified_at TEXT DEFAULT CURRENT_TIMESTAMP,
            auth_epoch INTEGER DEFAULT 0
        )
    ''')
    
    # 2. ตรวจสอบคอลัมน์ที่มีอยู่เดิมและทำ Auto Migration
    cursor.execute("PRAGMA table_info(users)")
    columns = [column[1] for column in cursor.fetchall()]

    if 'name' not in columns:
        cursor.execute("ALTER TABLE users ADD COLUMN name TEXT")

    if 'role' not in columns:
        cursor.execute("ALTER TABLE users ADD COLUMN role TEXT DEFAULT 'user'")

    if 'is_approved' not in columns:
        cursor.execute("ALTER TABLE users ADD COLUMN is_approved INTEGER DEFAULT 0")

    if 'last_login' not in columns:
        cursor.execute("ALTER TABLE users ADD COLUMN last_login TEXT")
    if 'terms_accepted_at' not in columns:
        cursor.execute("ALTER TABLE users ADD COLUMN terms_accepted_at TEXT")
    if 'terms_version' not in columns:
        cursor.execute("ALTER TABLE users ADD COLUMN terms_version TEXT")
    if 'email_verified_at' not in columns:
        cursor.execute("ALTER TABLE users ADD COLUMN email_verified_at TEXT")
        # Existing accounts were created before email verification existed; keep
        # them accessible instead of silently locking them out after migration.
        cursor.execute(
            "UPDATE users SET email_verified_at = ? WHERE email_verified_at IS NULL",
            (datetime.now().astimezone().isoformat(timespec='seconds'),),
        )
    if 'auth_epoch' not in columns:
        cursor.execute("ALTER TABLE users ADD COLUMN auth_epoch INTEGER DEFAULT 0")
        cursor.execute("UPDATE users SET auth_epoch = 0 WHERE auth_epoch IS NULL")

    # 3. สร้างตาราง scan_logs เก็บประวัติการถ่าย/อัปโหลดภาพผิวหนัง (ระบุวันเวลา)
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS scan_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER,
            user_name TEXT,
            user_email TEXT,
            image_path TEXT,
            result_disease TEXT,
            confidence TEXT,
            created_at TEXT,
            consented_at TEXT,
            consent_version TEXT,
            retention_expires_at TEXT,
            top_predictions TEXT,
            is_uncertain INTEGER DEFAULT 0,
            decision_status TEXT DEFAULT 'supported',
            model_version TEXT,
            gradcam_path TEXT
        )
    ''')

    cursor.execute("PRAGMA table_info(scan_logs)")
    scan_log_columns = [column[1] for column in cursor.fetchall()]
    if 'consented_at' not in scan_log_columns:
        cursor.execute("ALTER TABLE scan_logs ADD COLUMN consented_at TEXT")
    if 'consent_version' not in scan_log_columns:
        cursor.execute("ALTER TABLE scan_logs ADD COLUMN consent_version TEXT")
        cursor.execute("UPDATE scan_logs SET consent_version = 'legacy-unknown' WHERE consent_version IS NULL")
    if 'retention_expires_at' not in scan_log_columns:
        cursor.execute("ALTER TABLE scan_logs ADD COLUMN retention_expires_at TEXT")
        legacy_expiry = (datetime.now().astimezone() + timedelta(days=app.config['UPLOAD_RETENTION_DAYS'])).isoformat(timespec='seconds')
        cursor.execute(
            "UPDATE scan_logs SET retention_expires_at = ? WHERE retention_expires_at IS NULL",
            (legacy_expiry,),
        )
    if 'top_predictions' not in scan_log_columns:
        cursor.execute("ALTER TABLE scan_logs ADD COLUMN top_predictions TEXT")
    if 'is_uncertain' not in scan_log_columns:
        cursor.execute("ALTER TABLE scan_logs ADD COLUMN is_uncertain INTEGER DEFAULT 0")
    if 'decision_status' not in scan_log_columns:
        cursor.execute("ALTER TABLE scan_logs ADD COLUMN decision_status TEXT DEFAULT 'supported'")
        # Preserve the more cautious meaning of historical uncertain scans.
        cursor.execute("UPDATE scan_logs SET decision_status = 'ambiguous' WHERE is_uncertain = 1")
    if 'model_version' not in scan_log_columns:
        cursor.execute("ALTER TABLE scan_logs ADD COLUMN model_version TEXT")
    if 'gradcam_path' not in scan_log_columns:
        cursor.execute("ALTER TABLE scan_logs ADD COLUMN gradcam_path TEXT")

    cursor.execute('''
        CREATE TABLE IF NOT EXISTS audit_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            actor_user_id INTEGER,
            action TEXT NOT NULL,
            target_type TEXT NOT NULL,
            target_id TEXT,
            created_at TEXT NOT NULL
        )
    ''')
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS password_reset_tokens (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            token_selector TEXT,
            token_hash TEXT NOT NULL,
            expires_at TEXT NOT NULL,
            used_at TEXT,
            requested_by_user_id INTEGER,
            created_at TEXT NOT NULL,
            FOREIGN KEY(user_id) REFERENCES users(id),
            FOREIGN KEY(requested_by_user_id) REFERENCES users(id)
        )
    ''')
    cursor.execute("PRAGMA table_info(password_reset_tokens)")
    password_reset_token_columns = [column[1] for column in cursor.fetchall()]
    if 'token_selector' not in password_reset_token_columns:
        # Existing links stay valid for their short TTL, but newly issued links
        # use a selector to avoid a database-wide password-hash scan.
        cursor.execute("ALTER TABLE password_reset_tokens ADD COLUMN token_selector TEXT")
    if 'requested_by_user_id' not in password_reset_token_columns:
        # Older installations predate administrator-initiated reset links.
        # Preserve those rows while allowing account deletion to remove every
        # dependent token reference before deleting its owner/requester.
        cursor.execute("ALTER TABLE password_reset_tokens ADD COLUMN requested_by_user_id INTEGER")
    cursor.execute(
        "CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_active "
        "ON password_reset_tokens(user_id, expires_at, used_at)"
    )
    cursor.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_password_reset_tokens_selector "
        "ON password_reset_tokens(token_selector)"
    )
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS email_verification_tokens (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            token_selector TEXT,
            token_hash TEXT NOT NULL,
            expires_at TEXT NOT NULL,
            used_at TEXT,
            created_at TEXT NOT NULL,
            FOREIGN KEY(user_id) REFERENCES users(id)
        )
    ''')
    cursor.execute("PRAGMA table_info(email_verification_tokens)")
    email_verification_token_columns = [column[1] for column in cursor.fetchall()]
    if 'token_selector' not in email_verification_token_columns:
        cursor.execute("ALTER TABLE email_verification_tokens ADD COLUMN token_selector TEXT")
    cursor.execute(
        "CREATE INDEX IF NOT EXISTS idx_email_verification_tokens_active "
        "ON email_verification_tokens(user_id, expires_at, used_at)"
    )
    cursor.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_email_verification_tokens_selector "
        "ON email_verification_tokens(token_selector)"
    )
    # Administrator MFA uses separate tables so existing administrators stay
    # password-only until they explicitly finish enrollment.  TOTP seeds are
    # encrypted before insertion; this schema deliberately has no plaintext
    # password or TOTP-secret column in users.
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS admin_mfa_credentials (
            user_id INTEGER PRIMARY KEY,
            secret_ciphertext TEXT NOT NULL,
            enabled_at TEXT NOT NULL,
            last_used_counter INTEGER,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
        )
    ''')
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS admin_mfa_enrollments (
            id TEXT PRIMARY KEY,
            user_id INTEGER NOT NULL,
            secret_ciphertext TEXT NOT NULL,
            expires_at TEXT NOT NULL,
            created_at TEXT NOT NULL,
            FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
        )
    ''')
    cursor.execute(
        "CREATE INDEX IF NOT EXISTS idx_admin_mfa_enrollments_active "
        "ON admin_mfa_enrollments(user_id, expires_at)"
    )
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS admin_mfa_login_challenges (
            id TEXT PRIMARY KEY,
            user_id INTEGER NOT NULL,
            auth_epoch INTEGER NOT NULL,
            expires_at TEXT NOT NULL,
            used_at TEXT,
            created_at TEXT NOT NULL,
            FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
        )
    ''')
    cursor.execute("PRAGMA table_info(admin_mfa_login_challenges)")
    admin_mfa_challenge_columns = [column[1] for column in cursor.fetchall()]
    if 'auth_epoch' not in admin_mfa_challenge_columns:
        cursor.execute("ALTER TABLE admin_mfa_login_challenges ADD COLUMN auth_epoch INTEGER NOT NULL DEFAULT 0")
        cursor.execute(
            '''UPDATE admin_mfa_login_challenges
               SET auth_epoch = COALESCE((SELECT auth_epoch FROM users WHERE users.id = admin_mfa_login_challenges.user_id), 0)'''
        )
    cursor.execute(
        "CREATE INDEX IF NOT EXISTS idx_admin_mfa_login_challenges_active "
        "ON admin_mfa_login_challenges(user_id, expires_at, used_at)"
    )
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS rate_limits (
            scope TEXT NOT NULL,
            identity_hash TEXT NOT NULL,
            window_start INTEGER NOT NULL,
            request_count INTEGER NOT NULL,
            PRIMARY KEY (scope, identity_hash, window_start)
        )
    ''')
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS training_jobs (
            id TEXT PRIMARY KEY,
            requested_by INTEGER NOT NULL,
            status TEXT NOT NULL,
            epochs INTEGER NOT NULL,
            output_path TEXT NOT NULL,
            metadata_path TEXT NOT NULL,
            evaluation_path TEXT NOT NULL,
            log_path TEXT NOT NULL,
            process_id INTEGER,
            preflight_json TEXT NOT NULL,
            error_summary TEXT,
            created_at TEXT NOT NULL,
            started_at TEXT,
            finished_at TEXT,
            exit_code INTEGER,
            FOREIGN KEY(requested_by) REFERENCES users(id)
        )
    ''')
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS concern_reports (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            self_reported_level TEXT NOT NULL,
            selected_signals TEXT NOT NULL,
            consented_at TEXT NOT NULL,
            consent_version TEXT NOT NULL,
            retention_expires_at TEXT NOT NULL,
            created_at TEXT NOT NULL,
            FOREIGN KEY(user_id) REFERENCES users(id)
        )
    ''')
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS nearby_context_reports (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            latitude_approx REAL NOT NULL,
            longitude_approx REAL NOT NULL,
            pm25 REAL NOT NULL,
            uv_index REAL NOT NULL,
            relative_humidity REAL NOT NULL,
            temperature_c REAL NOT NULL,
            context_level TEXT NOT NULL,
            context_summary TEXT NOT NULL,
            consented_at TEXT NOT NULL,
            consent_version TEXT NOT NULL,
            retention_expires_at TEXT NOT NULL,
            created_at TEXT NOT NULL,
            FOREIGN KEY(user_id) REFERENCES users(id)
        )
    ''')
    # Profile pictures are not scan images.  They remain private, exist only
    # while the user keeps them, and are deleted on replacement, explicit
    # removal, or account deletion.
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS profile_avatars (
            user_id INTEGER PRIMARY KEY,
            image_path TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
        )
    ''')
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS profile_avatar_deletion_queue (
            image_path TEXT PRIMARY KEY,
            queued_at TEXT NOT NULL
        )
    ''')

    # 4. Development-only bootstrap.  Production account provisioning happens
    # through the controlled CLI so passwords are never stored in a service
    # environment or used to reset an administrator on every restart.
    admin_email = os.environ.get('SMART_SKIN_ADMIN_EMAIL', '').strip().lower()
    admin_password = os.environ.get('SMART_SKIN_ADMIN_PASSWORD', '')
    if IS_PRODUCTION and (admin_email or admin_password):
        raise RuntimeError(
            'Production forbids SMART_SKIN_ADMIN_EMAIL/SMART_SKIN_ADMIN_PASSWORD. '
            'Provision a unique MFA-enrolled administrator through manage.py in a controlled console.'
        )
    if admin_email and admin_password:
        if not is_valid_email(admin_email) or not is_strong_password(admin_password):
            raise ValueError(
                'SMART_SKIN_ADMIN_EMAIL must be valid and SMART_SKIN_ADMIN_PASSWORD must be at least 12 characters with letters and numbers.'
            )
        cursor.execute("SELECT id FROM users WHERE email = ?", (admin_email,))
        admin_user = cursor.fetchone()
        if not admin_user:
            cursor.execute(
                "INSERT INTO users (name, email, password, role, is_approved) VALUES (?, ?, ?, ?, 1)",
                (
                    "ผู้ดูแลระบบ",
                    admin_email,
                    generate_password_hash(admin_password),
                    "admin",
                ),
            )
        else:
            cursor.execute(
                "UPDATE users SET password = ?, role = 'admin', is_approved = 1 WHERE id = ?",
                (generate_password_hash(admin_password), admin_user[0]),
            )

    # Disable the legacy bootstrap account so a previously published default
    # credential cannot be used after this security migration.
    cursor.execute(
        "UPDATE users SET role = 'disabled', is_approved = 0 WHERE email = ?",
        ('admin@dev.com',),
    )

    # 5. ย้ายรหัสผ่านเดิมแบบ plain text ไปเป็น hash โดยไม่ทำให้บัญชีเดิมใช้ไม่ได้
    cursor.execute("SELECT id, password FROM users")
    for user_id, stored_password in cursor.fetchall():
        if stored_password and not stored_password.startswith(('scrypt:', 'pbkdf2:', 'argon2:')):
            cursor.execute(
                "UPDATE users SET password = ? WHERE id = ?",
                (generate_password_hash(stored_password), user_id),
            )

    # 6. สร้างตารางเก็บข้อเสนอแนะ (feedbacks)
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS feedbacks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER,
            user_email TEXT,
            user_name TEXT,
            topic TEXT NOT NULL DEFAULT 'general',
            message TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            retention_expires_at TEXT,
            FOREIGN KEY(user_id) REFERENCES users(id)
        )
    ''')
    cursor.execute("PRAGMA table_info(feedbacks)")
    feedback_columns = [column[1] for column in cursor.fetchall()]
    if 'user_id' not in feedback_columns:
        cursor.execute("ALTER TABLE feedbacks ADD COLUMN user_id INTEGER")
        cursor.execute(
            """UPDATE feedbacks SET user_id = (
                   SELECT id FROM users WHERE users.email = feedbacks.user_email
               ) WHERE user_id IS NULL"""
        )
    if 'retention_expires_at' not in feedback_columns:
        cursor.execute("ALTER TABLE feedbacks ADD COLUMN retention_expires_at TEXT")
        feedback_expiry = (datetime.now().astimezone() + timedelta(days=app.config['UPLOAD_RETENTION_DAYS'])).isoformat(timespec='seconds')
        cursor.execute(
            "UPDATE feedbacks SET retention_expires_at = ? WHERE retention_expires_at IS NULL",
            (feedback_expiry,),
        )
    if 'topic' not in feedback_columns:
        cursor.execute("ALTER TABLE feedbacks ADD COLUMN topic TEXT NOT NULL DEFAULT 'general'")
    conn.commit()
    conn.close()

def assert_production_admin_mfa_enrollment():
    """Refuse a production boot with password-only administrator accounts.

    Login-time enforcement still covers accounts changed while the process is
    live. This startup check closes the more dangerous case where a database
    containing legacy administrators is deployed to the public service.
    """
    if not ADMIN_MFA_REQUIRED:
        return
    conn = get_db_connection(row_factory=True)
    try:
        rows = conn.execute(
            '''SELECT users.id, admin_mfa_credentials.secret_ciphertext
               FROM users
               LEFT JOIN admin_mfa_credentials ON admin_mfa_credentials.user_id = users.id
               WHERE users.role = 'admin' '''
        ).fetchall()
    finally:
        conn.close()
    missing_or_unreadable = [
        row['id']
        for row in rows
        if not row['secret_ciphertext'] or not decrypt_admin_mfa_secret(row['secret_ciphertext'])
    ]
    if missing_or_unreadable:
        raise RuntimeError(
            'Production requires an enrolled, decryptable MFA credential for every administrator. '
            'Complete controlled MFA enrollment before starting the public service.'
        )
    # A future screening release needs a tested two-admin recovery path.  A
    # public-information host may run without administrators because it has no
    # account or health-data functions, but must still remain in that mode.
    if not PUBLIC_INFORMATION_MODE and len(rows) < 2:
        raise RuntimeError(
            'Production screening requires at least two MFA-enrolled administrators for controlled recovery.'
        )


if not PUBLIC_INFORMATION_MODE:
    init_db()
    assert_production_admin_mfa_enrollment()

# -------------------------------------------------------------------------
# 🌐 เส้นทางแอปพลิเคชัน (Routes)
# -------------------------------------------------------------------------

@app.route('/')
def home():
    return render_template('landing.html')


@app.get('/healthz')
def healthz():
    """Return process liveness without disclosing deployment internals."""
    return {'status': 'ok'}, 200


@app.get('/readyz')
def readyz():
    """Return whether the service can safely serve its configured mode.

    This endpoint intentionally returns no database, filesystem, model, or
    secret details.  The reverse proxy and monitoring service only need a
    binary readiness signal; operators diagnose failures through protected
    logs instead of a public HTTP response.
    """
    # Public-information mode has no account or health-image storage by
    # design.  Its readiness must not initialise or probe an unused private
    # SQLite/upload store.
    if app.config['PUBLIC_INFORMATION_MODE']:
        return {'status': 'ready'}, 200

    ready = True
    try:
        conn = get_db_connection()
        try:
            conn.execute('SELECT 1').fetchone()
        finally:
            conn.close()
        if not Path(app.config['UPLOAD_FOLDER']).is_dir():
            ready = False
    except (sqlite3.Error, OSError):
        ready = False
    # In screening mode, the same release gate that controls upload must be
    # present before traffic is declared ready.  Public-information mode is
    # intentionally ready without an approved image model.
    if IS_PRODUCTION and not app.config['PUBLIC_INFORMATION_MODE'] and not MODEL_READINESS['approved']:
        ready = False
    return ({'status': 'ready'} if ready else {'status': 'not_ready'}), (200 if ready else 503)


@app.route('/password/forgot', methods=['GET', 'POST'])
def forgot_password():
    if request.method == 'POST':
        client_key = login_client_key()
        if require_rate_budget('password_reset_request', client_key):
            email = request.form.get('email', '').strip().lower()
            if is_valid_email(email):
                conn = get_db_connection()
                try:
                    user = conn.execute(
                        "SELECT id FROM users WHERE email = ? AND role IN ('user', 'admin')",
                        (email,),
                    ).fetchone()
                finally:
                    conn.close()
                if user and issue_password_reset_email(user[0]):
                    record_audit_event('password_reset_requested', 'user', user[0], actor_user_id=0)
        # Keep this wording identical whether or not an account exists.
        flash('หากอีเมลนี้มีบัญชีในระบบ เราได้ส่งลิงก์ตั้งรหัสผ่านใหม่ไปให้แล้ว', 'success')
        return redirect(url_for('forgot_password'))
    return render_template('password_forgot.html')


@app.route('/password/reset/claim', methods=['POST'])
def claim_password_reset():
    """Exchange a fragment-only reset verifier for a browser-bound handoff."""
    payload = request.get_json(silent=True)
    token = payload.get('token') if isinstance(payload, dict) else None
    if not begin_account_security_handoff('password_reset', token):
        return {'error': 'ลิงก์ตั้งรหัสผ่านใหม่ไม่ถูกต้อง หมดอายุ หรือถูกใช้ไปแล้ว'}, 400
    return {'redirect_url': url_for('reset_password')}


@app.route('/password/reset', methods=['GET', 'POST'])
def reset_password():
    reset_row = get_account_security_handoff('password_reset')
    if not reset_row:
        if request.method == 'GET':
            return render_template(
                'account_security_handoff.html',
                claim_url=url_for('claim_password_reset'),
                fallback_url=url_for('forgot_password'),
                page_title='ตั้งรหัสผ่านใหม่',
                status_message='กำลังตรวจสอบลิงก์ตั้งรหัสผ่านใหม่อย่างปลอดภัย',
            )
        flash('ลิงก์ตั้งรหัสผ่านใหม่ไม่ถูกต้อง หมดอายุ หรือถูกใช้ไปแล้ว', 'error')
        return redirect(url_for('forgot_password'))
    if request.method == 'POST':
        new_password = request.form.get('new_password', '')
        confirmation = request.form.get('new_password_confirmation', '')
        if new_password != confirmation:
            flash('ยืนยันรหัสผ่านใหม่ไม่ตรงกัน', 'error')
            return render_template('password_reset.html', reset_user_name=reset_row['name']), 400
        if not is_strong_password(new_password):
            flash('รหัสผ่านใหม่ต้องยาวอย่างน้อย 12 ตัวอักษร และมีทั้งตัวอักษรกับตัวเลข', 'error')
            return render_template('password_reset.html', reset_user_name=reset_row['name']), 400
        completed_reset = complete_password_reset_by_id(reset_row['id'], new_password)
        clear_account_security_handoff()
        if not completed_reset:
            flash('ลิงก์ตั้งรหัสผ่านใหม่ไม่ถูกต้อง หมดอายุ หรือถูกใช้ไปแล้ว', 'error')
            return redirect(url_for('forgot_password'))
        record_audit_event('password_reset_completed', 'user', completed_reset['user_id'], actor_user_id=completed_reset['user_id'])
        flash('ตั้งรหัสผ่านใหม่เรียบร้อยแล้ว กรุณาเข้าสู่ระบบอีกครั้ง', 'success')
        return redirect(url_for('home'))
    return render_template('password_reset.html', reset_user_name=reset_row['name'])


@app.route('/password/reset/<token>', methods=['GET', 'POST'])
def reset_password_legacy(token):
    """Support old path-based links only through their existing short TTL.

    Newly-issued links use a fragment and never reach this endpoint with a raw
    verifier in the request URL.  A legacy GET is immediately converted to the
    clean, session-bound flow; legacy POST remains solely for an already open
    pre-migration form.
    """
    reset_row = resolve_password_reset_token(token)
    if not reset_row:
        flash('ลิงก์ตั้งรหัสผ่านใหม่ไม่ถูกต้อง หมดอายุ หรือถูกใช้ไปแล้ว', 'error')
        return redirect(url_for('forgot_password'))
    if request.method == 'GET':
        begin_account_security_handoff('password_reset', token)
        return redirect(url_for('reset_password'), code=303)
    new_password = request.form.get('new_password', '')
    confirmation = request.form.get('new_password_confirmation', '')
    if new_password != confirmation:
        flash('ยืนยันรหัสผ่านใหม่ไม่ตรงกัน', 'error')
        return render_template('password_reset.html', reset_user_name=reset_row['name']), 400
    if not is_strong_password(new_password):
        flash('รหัสผ่านใหม่ต้องยาวอย่างน้อย 12 ตัวอักษร และมีทั้งตัวอักษรกับตัวเลข', 'error')
        return render_template('password_reset.html', reset_user_name=reset_row['name']), 400
    completed_reset = complete_password_reset(token, new_password)
    if not completed_reset:
        flash('ลิงก์ตั้งรหัสผ่านใหม่ไม่ถูกต้อง หมดอายุ หรือถูกใช้ไปแล้ว', 'error')
        return redirect(url_for('forgot_password'))
    record_audit_event('password_reset_completed', 'user', completed_reset['user_id'], actor_user_id=completed_reset['user_id'])
    flash('ตั้งรหัสผ่านใหม่เรียบร้อยแล้ว กรุณาเข้าสู่ระบบอีกครั้ง', 'success')
    return redirect(url_for('home'))


@app.route('/email/verify/claim', methods=['POST'])
def claim_email_verification():
    """Exchange a fragment-only verification verifier for a browser handoff."""
    payload = request.get_json(silent=True)
    token = payload.get('token') if isinstance(payload, dict) else None
    if not begin_account_security_handoff('email_verification', token):
        return {'error': 'ลิงก์ยืนยันอีเมลไม่ถูกต้อง หมดอายุ หรือถูกใช้ไปแล้ว'}, 400
    return {'redirect_url': url_for('verify_email')}


@app.route('/email/verify', methods=['GET', 'POST'])
def verify_email():
    verification_row = get_account_security_handoff('email_verification')
    if not verification_row:
        if request.method == 'GET':
            return render_template(
                'account_security_handoff.html',
                claim_url=url_for('claim_email_verification'),
                fallback_url=url_for('home'),
                page_title='ยืนยันอีเมล',
                status_message='กำลังตรวจสอบลิงก์ยืนยันอีเมลอย่างปลอดภัย',
            )
        flash('ลิงก์ยืนยันอีเมลไม่ถูกต้อง หมดอายุ หรือถูกใช้ไปแล้ว', 'error')
        return redirect(url_for('home'))
    if request.method == 'POST':
        completed_verification = complete_email_verification_by_id(verification_row['id'])
        clear_account_security_handoff()
        if not completed_verification:
            flash('ลิงก์ยืนยันอีเมลไม่ถูกต้อง หมดอายุ หรือถูกใช้ไปแล้ว', 'error')
            return redirect(url_for('home'))
        record_audit_event('email_verified', 'user', completed_verification['user_id'], actor_user_id=completed_verification['user_id'])
        flash('ยืนยันอีเมลเรียบร้อยแล้ว กรุณารอผู้ดูแลระบบอนุมัติบัญชีก่อนเข้าสู่ระบบ', 'success')
        return redirect(url_for('home'))
    return render_template('email_verification.html', verification_user_name=verification_row['name'])


@app.route('/email/verify/<token>', methods=['GET', 'POST'])
def verify_email_legacy(token):
    """Short-term compatibility route for verification links sent before migration."""
    verification_row = resolve_email_verification_token(token)
    if not verification_row:
        flash('ลิงก์ยืนยันอีเมลไม่ถูกต้อง หมดอายุ หรือถูกใช้ไปแล้ว', 'error')
        return redirect(url_for('home'))
    if request.method == 'GET':
        begin_account_security_handoff('email_verification', token)
        return redirect(url_for('verify_email'), code=303)
    completed_verification = complete_email_verification(token)
    if not completed_verification:
        flash('ลิงก์ยืนยันอีเมลไม่ถูกต้อง หมดอายุ หรือถูกใช้ไปแล้ว', 'error')
        return redirect(url_for('home'))
    record_audit_event('email_verified', 'user', completed_verification['user_id'], actor_user_id=completed_verification['user_id'])
    flash('ยืนยันอีเมลเรียบร้อยแล้ว กรุณารอผู้ดูแลระบบอนุมัติบัญชีก่อนเข้าสู่ระบบ', 'success')
    return redirect(url_for('home'))


@app.route('/email/verification/resend', methods=['GET', 'POST'])
def resend_email_verification():
    if request.method == 'POST':
        client_key = login_client_key()
        if require_rate_budget('email_verification_request', client_key):
            email = request.form.get('email', '').strip().lower()
            if is_valid_email(email):
                conn = get_db_connection()
                try:
                    user = conn.execute(
                        "SELECT id FROM users WHERE email = ? AND role = 'user' AND email_verified_at IS NULL",
                        (email,),
                    ).fetchone()
                finally:
                    conn.close()
                if user and issue_email_verification_email(user[0]):
                    record_audit_event('email_verification_resent', 'user', user[0], actor_user_id=0)
        flash('หากอีเมลนี้มีบัญชีที่ยังไม่ได้ยืนยัน เราได้ส่งลิงก์ยืนยันใหม่ไปให้แล้ว', 'success')
        return redirect(url_for('resend_email_verification'))
    return render_template('email_verification_resend.html')


@app.route('/service-worker.js')
def service_worker():
    response = send_from_directory(app.static_folder, 'service-worker.js', mimetype='application/javascript')
    # Browsers must check this file on each visit so an offline update is
    # applied quickly, while the worker itself controls its own asset cache.
    response.headers['Cache-Control'] = 'no-cache, max-age=0, must-revalidate'
    return response


@app.route('/privacy')
def privacy():
    return_to_scan = request.args.get('return_to') == 'scan' and session.get('user_role') == 'user'
    return render_template(
        'privacy.html',
        return_to_scan=return_to_scan,
        can_submit_privacy_request=session.get('user_role') == 'user',
        feedback_max_length=MAX_FEEDBACK_LENGTH,
    )


@app.route('/terms')
def terms():
    terms_acceptance_required = (
        session.get('user_role') == 'user'
        and session.get('terms_version') != TERMS_VERSION
    )
    return_to_scan = request.args.get('return_to') == 'scan' and session.get('user_role') == 'user'
    return render_template(
        'terms.html',
        terms_acceptance_required=terms_acceptance_required,
        return_to_scan=return_to_scan,
    )


@app.route('/terms/accept', methods=['POST'])
@login_required
def accept_terms():
    if session.get('user_role') != 'user':
        abort(403)
    if request.form.get('terms_consent') != 'on':
        flash('กรุณายอมรับข้อกำหนดการใช้งานก่อนดำเนินการต่อ', 'error')
        return redirect(url_for('terms'))
    now = datetime.now().astimezone().isoformat(timespec='seconds')
    conn = get_db_connection()
    try:
        conn.execute(
            'UPDATE users SET terms_accepted_at = ?, terms_version = ? WHERE id = ?',
            (now, TERMS_VERSION, session.get('user_id')),
        )
        conn.commit()
    finally:
        conn.close()
    session['terms_version'] = TERMS_VERSION
    record_audit_event('terms_accepted', 'terms', TERMS_VERSION)
    flash('บันทึกการยอมรับข้อกำหนดเรียบร้อยแล้ว', 'success')
    return redirect(url_for('dashboard'))

@app.route('/login', methods=['POST'])
def login():
    client_key = login_client_key()
    if is_login_rate_limited(client_key):
        flash('มีการพยายามเข้าสู่ระบบมากเกินไป กรุณารอ 15 นาทีแล้วลองใหม่อีกครั้ง', 'error')
        return redirect(url_for('home'))

    email = request.form.get('email', '').strip().lower()
    password = request.form.get('password', '')

    conn = get_db_connection()
    cursor = conn.cursor()
    user = None
    if is_valid_email(email):
        cursor.execute(
            """SELECT id, name, email, password, role, is_approved, terms_version,
                      auth_epoch, email_verified_at,
                      EXISTS(SELECT 1 FROM admin_mfa_credentials WHERE admin_mfa_credentials.user_id = users.id)
               FROM users WHERE email = ?""",
            (email,),
        )
        user = cursor.fetchone()

    password_is_valid = False
    if user:
        try:
            password_is_valid = check_password_hash(user[3], password)
        except ValueError:
            password_is_valid = False

    if user and password_is_valid and user[4] in {'user', 'admin'}:
        (
            user_id, name, user_email, _, role, is_approved,
            accepted_terms_version, auth_epoch, email_verified_at, mfa_enabled,
        ) = user

        if role == 'admin' or (is_approved == 1 and email_verified_at):
            conn.close()
            if role == 'admin' and ADMIN_MFA_REQUIRED and not bool(mfa_enabled):
                record_audit_event('admin_mfa_required_login_blocked', 'admin_mfa', user_id, actor_user_id=0)
                flash('บัญชีผู้ดูแลยังไม่มี MFA จึงไม่อนุญาตให้เข้าสู่ระบบ production', 'error')
                return redirect(url_for('home'))
            if role == 'admin' and bool(mfa_enabled):
                if not require_rate_budget('admin_mfa_verify', f'challenge:{user_id}:{client_key}'):
                    record_failed_login(client_key)
                    flash('มีการยืนยันรหัส MFA มากเกินไป กรุณารอแล้วลองใหม่อีกครั้ง', 'error')
                    return redirect(url_for('home'))
                challenge_id = start_admin_mfa_login_challenge(user_id)
                if not challenge_id:
                    flash('ไม่สามารถเริ่มการยืนยัน MFA ได้ในขณะนี้ กรุณาลองใหม่อีกครั้ง', 'error')
                    return redirect(url_for('home'))
                # Password validation succeeded, but this is still not an
                # authenticated session.  Retain only an opaque challenge ID.
                session.clear()
                session['mfa_login_challenge_id'] = challenge_id
                session.permanent = False
                session.modified = True
                flash('กรุณากรอกรหัสยืนยัน 6 หลักจากแอป Authenticator เพื่อเข้าสู่ระบบผู้ดูแล', 'warning')
                return redirect(url_for('admin_mfa_login'))

            now_str = datetime.now().astimezone().isoformat(timespec='seconds')
            conn = get_db_connection()
            try:
                conn.execute("UPDATE users SET last_login = ? WHERE id = ?", (now_str, user_id))
                conn.commit()
            finally:
                conn.close()

            establish_authenticated_session(
                {
                    'id': user_id,
                    'name': name,
                    'email': user_email,
                    'role': role,
                    'terms_version': accepted_terms_version,
                    'auth_epoch': auth_epoch,
                }
            )
            clear_failed_logins(client_key)
            flash(f'ยินดีต้อนรับคุณ {name}', 'success')
            if role == 'admin':
                return redirect(url_for('admin_dashboard'))
            return redirect(url_for('dashboard'))
        conn.close()
        if not email_verified_at:
            flash('กรุณายืนยันอีเมลก่อนเข้าสู่ระบบ แล้วรอผู้ดูแลระบบอนุมัติการใช้งาน', 'warning')
        else:
            flash('บัญชีของคุณกำลังอยู่ระหว่างรอผู้ดูแลระบบอนุมัติการใช้งาน', 'warning')
        return redirect(url_for('home'))

    conn.close()
    record_failed_login(client_key)
    flash('อีเมลหรือรหัสผ่านไม่ถูกต้อง', 'error')
    return redirect(url_for('home'))


@app.route('/login/mfa', methods=['GET', 'POST'])
def admin_mfa_login():
    """Finish an administrator login only after a short-lived TOTP challenge."""
    challenge_id = session.get('mfa_login_challenge_id')
    if not challenge_id:
        flash('กรุณาเข้าสู่ระบบด้วยอีเมลและรหัสผ่านก่อนยืนยัน MFA', 'error')
        return redirect(url_for('home'))
    if request.method == 'GET':
        return render_template('admin_mfa_login.html')

    client_key = login_client_key()
    if is_login_rate_limited(client_key) or not require_rate_budget('admin_mfa_verify', f'login:{client_key}'):
        session.pop('mfa_login_challenge_id', None)
        record_failed_login(client_key)
        flash('มีการยืนยันรหัส MFA มากเกินไป กรุณาเข้าสู่ระบบใหม่ภายหลัง', 'error')
        return redirect(url_for('home'))

    completed_user = complete_admin_mfa_login(challenge_id, request.form.get('totp_code', ''))
    if not completed_user:
        record_failed_login(client_key)
        record_audit_event('admin_mfa_login_failed', 'admin_mfa_login', actor_user_id=0)
        flash('รหัสยืนยันไม่ถูกต้อง หมดอายุ หรือถูกใช้ไปแล้ว กรุณาลองใหม่', 'error')
        return redirect(url_for('admin_mfa_login'))

    establish_authenticated_session(completed_user, mfa_verified=True)
    clear_failed_logins(client_key)
    record_audit_event('admin_mfa_login_succeeded', 'admin_mfa_login', completed_user['id'], actor_user_id=completed_user['id'])
    flash(f"ยินดีต้อนรับคุณ {completed_user['name']}", 'success')
    return redirect(url_for('admin_dashboard'))


@app.route('/register', methods=['POST'])
def register():
    if not require_rate_budget('register', login_client_key()):
        flash('ลงทะเบียนบ่อยเกินไป กรุณาลองใหม่ภายหลัง', 'error')
        return redirect(url_for('home'))
    name = request.form.get('name', '').strip()
    email = request.form.get('email', '').strip().lower()
    password = request.form.get('password', '')

    if not is_valid_name(name) or not is_valid_email(email) or not is_strong_password(password):
        flash('กรุณากรอกชื่อและอีเมลให้ถูกต้อง พร้อมตั้งรหัสผ่านอย่างน้อย 12 ตัวอักษรที่มีทั้งตัวอักษรและตัวเลข', 'error')
        return redirect(url_for('home'))
    if request.form.get('terms_consent') != 'on':
        flash('กรุณายอมรับข้อกำหนดการใช้งานและประกาศความเป็นส่วนตัวก่อนลงทะเบียน', 'error')
        return redirect(url_for('home'))

    conn = None
    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        registration_time = datetime.now().astimezone().isoformat(timespec='seconds')
        email_verified_at = registration_time if not IS_PRODUCTION else None
        cursor.execute(
            """INSERT INTO users
               (name, email, password, role, is_approved, terms_accepted_at, terms_version, email_verified_at)
               VALUES (?, ?, ?, 'user', 0, ?, ?, ?)""",
            (
                name,
                email,
                generate_password_hash(password),
                registration_time,
                TERMS_VERSION,
                email_verified_at,
            ),
        )
        user_id = cursor.lastrowid
        conn.commit()
        if IS_PRODUCTION:
            if issue_email_verification_email(user_id):
                record_audit_event('email_verification_requested', 'user', user_id, actor_user_id=0)
                flash('ลงทะเบียนสำเร็จ! กรุณาตรวจอีเมลเพื่อยืนยันบัญชี แล้วรอผู้ดูแลระบบอนุมัติการใช้งาน', 'warning')
            else:
                flash('ลงทะเบียนสำเร็จ แต่ยังส่งอีเมลยืนยันไม่ได้ กรุณาขอส่งอีเมลยืนยันใหม่ภายหลัง', 'warning')
        else:
            flash('ลงทะเบียนสำเร็จ! กรุณารอผู้ดูแลระบบ (Admin) อนุมัติการใช้งานก่อนเข้าสู่ระบบ', 'warning')
    except sqlite3.IntegrityError:
        flash('อีเมลนี้ถูกใช้งานแล้ว', 'error')
    finally:
        if conn is not None:
            conn.close()
    return redirect(url_for('home'))

# 🟢 หน้า Dashboard สำหรับผู้ใช้งานทั่วไปและการสแกนภาพ
@app.route('/dashboard', methods=['GET', 'POST'])
@app.route('/scan', methods=['GET', 'POST'], endpoint='scan_legacy')
@login_required
def dashboard():
    if (
        session.get('user_role') == 'user'
        and not app.config.get('TESTING')
        and session.get('terms_version') != TERMS_VERSION
    ):
        flash('กรุณาอ่านและยอมรับข้อกำหนดการใช้งานฉบับล่าสุดก่อนส่งข้อมูลสุขภาพ', 'warning')
        return redirect(url_for('terms'))
    if request.method == 'POST':
        if not analysis_is_available():
            flash('ระบบคัดกรองยังไม่เปิดใช้ เพราะโมเดลยังไม่มีหลักฐานการประเมินและการอนุมัติครบถ้วน', 'error')
            return redirect(url_for('dashboard'))
        if not require_rate_budget('scan', f"user:{session.get('user_id')}"):
            flash('ส่งภาพเพื่อคัดกรองบ่อยเกินไป กรุณาลองใหม่ภายหลัง', 'error')
            return redirect(url_for('dashboard'))
        if request.form.get('scan_consent') != 'on':
            flash('กรุณายืนยันความยินยอมก่อนส่งภาพผิวหนังเพื่อวิเคราะห์', 'error')
            return redirect(url_for('dashboard'))
        if request.form.get('lesion_image_confirmation') != 'on':
            flash('กรุณายืนยันว่าภาพเป็นผิวหนังของมนุษย์ที่มีรอยโรคหรือผื่น (ใบหน้า หนังศีรษะ หรือส่วนอื่นของร่างกาย) ก่อนส่งตรวจ', 'error')
            return redirect(url_for('dashboard'))

        image_domain = resolve_image_domain(request.form.get('image_domain', '').strip())
        if image_domain is None:
            flash('กรุณาเลือกชนิดภาพให้ตรงกับภาพที่อัปโหลด ระบบจะไม่เดาชนิดภาพแทนคุณ', 'error')
            return redirect(url_for('dashboard'))
        eligible_class_names = MODEL_CLASS_NAMES_BY_DOMAIN[image_domain]

        if 'file' not in request.files:
            flash('กรุณาเลือกไฟล์ภาพก่อนสแกน', 'error')
            return redirect(url_for('dashboard'))
        file = request.files['file']
        if file.filename == '':
            flash('กรุณาเลือกไฟล์ภาพก่อนสแกน', 'error')
            return redirect(url_for('dashboard'))

        if not allowed_image_file(file.filename):
            flash('รองรับเฉพาะไฟล์ JPG, JPEG, PNG และ WEBP ขนาดไม่เกิน 8 MB', 'error')
            return redirect(url_for('dashboard'))

        if file:
            conn = None
            filename = None
            try:
                with warnings.catch_warnings():
                    warnings.simplefilter('error', Image.DecompressionBombWarning)
                    with Image.open(file.stream) as uploaded_image:
                        uploaded_image.verify()
                    file.stream.seek(0)
                    with Image.open(file.stream) as uploaded_image:
                        image_format = uploaded_image.format
                        width, height = uploaded_image.size
                        if image_format not in IMAGE_FORMAT_EXTENSIONS:
                            raise UnidentifiedImageError('Unsupported image format')
                        if min(width, height) < app.config['MIN_IMAGE_DIMENSION']:
                            flash('ภาพมีขนาดเล็กเกินไป กรุณาใช้ภาพที่กว้างและสูงอย่างน้อย 128 พิกเซล', 'error')
                            return redirect(url_for('dashboard'))
                        if width * height > app.config['MAX_IMAGE_PIXELS']:
                            flash('ภาพมีความละเอียดสูงเกินไป กรุณาลดขนาดภาพก่อนอัปโหลด', 'error')
                            return redirect(url_for('dashboard'))
                        uploaded_image.load()
                        sanitized_image = uploaded_image.copy()
                        has_transparency = 'transparency' in uploaded_image.info
            except (UnidentifiedImageError, Image.DecompressionBombError, Image.DecompressionBombWarning, OSError, ValueError):
                flash('ไฟล์ที่อัปโหลดไม่ใช่รูปภาพที่เปิดอ่านได้', 'error')
                return redirect(url_for('dashboard'))

            quality_assessment = assess_image_quality(sanitized_image)
            if not quality_assessment['accepted']:
                record_audit_event('scan_rejected_image_quality', 'scan_upload', 'quality-gate')
                flash(
                    'ระบบปฏิเสธภาพก่อนวิเคราะห์: ' + ' · '.join(quality_assessment['reasons'])
                    + ' กรุณาถ่ายเฉพาะผิวหนังของมนุษย์ที่มีรอยโรคให้ชัดเจน และหลีกเลี่ยงภาพวัตถุ เอกสาร สัตว์ หรือสิ่งที่ไม่ใช่ผิวหนัง ระบบจะไม่สร้างผลวิเคราะห์หรือบันทึกภาพนี้',
                    'error',
                )
                return redirect(url_for('dashboard'))

            try:
                extension = IMAGE_FORMAT_EXTENSIONS[image_format]
                filename = f"{uuid4().hex}.{extension}"
                filepath = os.path.join(app.config['UPLOAD_FOLDER'], filename)
                if image_format == 'JPEG':
                    if sanitized_image.mode in {'RGBA', 'LA'} or has_transparency:
                        sanitized_image = sanitized_image.convert('RGBA')
                        background = Image.new('RGB', sanitized_image.size, 'white')
                        background.paste(sanitized_image, mask=sanitized_image.getchannel('A'))
                        sanitized_image = background
                    else:
                        sanitized_image = sanitized_image.convert('RGB')
                    sanitized_image.save(filepath, format='JPEG', quality=92, optimize=True)
                else:
                    if sanitized_image.mode not in {'RGB', 'RGBA'}:
                        sanitized_image = sanitized_image.convert('RGBA' if has_transparency else 'RGB')
                    save_options = {'format': image_format}
                    if image_format == 'WEBP':
                        save_options.update({'quality': 92, 'method': 6})
                    elif image_format == 'PNG':
                        save_options.update({'optimize': True})
                    sanitized_image.save(filepath, **save_options)
                if os.path.getsize(filepath) > app.config['MAX_CONTENT_LENGTH']:
                    delete_private_upload(filename)
                    flash('ไฟล์ภาพหลังประมวลผลมีขนาดเกิน 8 MB กรุณาใช้ภาพที่เล็กลง', 'error')
                    return redirect(url_for('dashboard'))
            except (OSError, ValueError):
                if filename:
                    delete_private_upload(filename)
                flash('ไม่สามารถบันทึกไฟล์ภาพได้ กรุณาลองใหม่อีกครั้ง', 'error')
                return redirect(url_for('dashboard'))

            if model is None:
                delete_private_upload(filename)
                flash('ไม่พบโมเดลสำหรับวิเคราะห์ภาพ กรุณาติดต่อผู้ดูแลระบบ', 'error')
                return redirect(url_for('dashboard'))

            gradcam_filename = None
            try:
                prediction = predict_image_scores(
                    filepath,
                    model,
                    class_names=MODEL_CLASS_NAMES,
                    eligible_class_names=eligible_class_names,
                )
                scope_assessment = assess_model_scope(prediction)
                if not scope_assessment['accepted']:
                    delete_private_upload(filename)
                    record_audit_event('scan_rejected_model_scope', 'scan_upload', 'scope-gate')
                    flash(
                        'ระบบปฏิเสธภาพก่อนแสดงผลจำแนก: ' + scope_assessment['reason']
                        + ' กรุณาใช้ภาพผิวหนังของมนุษย์ที่เห็นรอยโรคชัดเจน (ใบหน้า หนังศีรษะ หรือส่วนอื่นของร่างกายได้) ภาพนี้จะไม่ถูกบันทึกเป็นผลสแกน',
                        'error',
                    )
                    return redirect(url_for('dashboard'))

                disease_key = prediction['label'].lower().strip()
                confidence_num = float(prediction['confidence'])
                confidence_percent = f"{confidence_num:.2f}%"
                margin_percent = float(prediction['margin'])
                decision_status = determine_decision_status(confidence_num, margin_percent)
                is_uncertain = decision_status != 'supported'
                disease_info = build_result_info(disease_key, decision_status=decision_status)
                warning_message = disease_info["msg"]
                top_predictions = [
                    {
                        'label': display_name_for_label(item['label']),
                        'confidence': round(item['confidence'], 2),
                    }
                    for item in prediction['ranked_predictions'][:3]
                ]
                uncertainty_reasons = []
                if decision_status == 'out_of_scope':
                    uncertainty_reasons.append('คะแนนของทุกกลุ่มที่โมเดลรองรับต่ำกว่าเกณฑ์เปรียบเทียบ')
                else:
                    if confidence_num / 100 < MODEL_ABSTENTION_THRESHOLD:
                        uncertainty_reasons.append('คะแนนสูงสุดต่ำกว่าเกณฑ์')
                    if margin_percent / 100 < MODEL_MARGIN_THRESHOLD:
                        uncertainty_reasons.append('คะแนนอันดับหนึ่งและสองใกล้กัน')
                uncertainty_reason = ' และ '.join(uncertainty_reasons)
                if decision_status == 'out_of_scope':
                    stored_result = 'ไม่พบกลุ่มที่ใกล้เคียงเพียงพอในโมเดล'
                elif decision_status == 'ambiguous':
                    stored_result = 'ผลคัดกรองยังไม่ชัดเจน'
                else:
                    stored_result = f"ผลจำแนกจากโมเดล: {display_name_for_label(prediction['label'])}"

                try:
                    gradcam_filename = f"{uuid4().hex}_gradcam.png"
                    gradcam_metadata = generate_gradcam_overlay(
                        filepath,
                        model,
                        prediction['class_index'],
                        os.path.join(app.config['UPLOAD_FOLDER'], gradcam_filename),
                    )
                    if gradcam_metadata is None:
                        gradcam_filename = None
                    else:
                        record_audit_event('gradcam_created', 'scan_explanation', gradcam_metadata['layer_name'])
                except Exception:
                    if gradcam_filename:
                        delete_private_upload(gradcam_filename)
                    gradcam_filename = None
                    app.logger.exception('Could not create Grad-CAM explanation')
                
                # Save only the account identifier; names and emails are read from the account when needed.
                now_str = datetime.now().astimezone().isoformat(timespec='seconds')
                consented_at = now_str
                retention_expires_at = (datetime.now().astimezone() + timedelta(days=app.config['UPLOAD_RETENTION_DAYS'])).isoformat(timespec='seconds')
                conn = get_db_connection()
                cursor = conn.cursor()
                cursor.execute(
                    """
                    INSERT INTO scan_logs
                    (user_id, image_path, gradcam_path, result_disease, confidence, created_at, consented_at, consent_version, retention_expires_at, top_predictions, is_uncertain, decision_status, model_version)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        session.get('user_id'), filename, gradcam_filename, stored_result, confidence_percent, now_str,
                        consented_at, PRIVACY_NOTICE_VERSION, retention_expires_at,
                        json.dumps(top_predictions, ensure_ascii=False), int(is_uncertain), decision_status, MODEL_VERSION,
                    )
                )
                conn.commit()
                conn.close()
                conn = None
                record_audit_event('scan_created', 'scan_log', filename)
                
                return render_template(
                    'dashboard.html',
                    disease_info=disease_info,
                    confidence=confidence_percent,
                    top_predictions=top_predictions,
                    margin=f"{margin_percent:.2f}%",
                    is_uncertain=is_uncertain,
                    decision_status=decision_status,
                    uncertainty_reason=uncertainty_reason,
                    model_version=MODEL_VERSION,
                    msg=warning_message,
                    gradcam_url=url_for('scan_image', filename=gradcam_filename) if gradcam_filename else None,
                    scan_history=get_user_scan_history(),
                    nearby_context=get_user_nearby_context(session.get('user_id')),
                    profile_avatar=get_user_profile_avatar(session.get('user_id')),
                )
            except Exception:
                if conn is not None:
                    conn.close()
                app.logger.exception('Image analysis failed')
                delete_private_upload(filename)
                if gradcam_filename:
                    delete_private_upload(gradcam_filename)
                flash('ไม่สามารถวิเคราะห์ภาพนี้ได้ กรุณาลองใช้ภาพผิวหนังที่ชัดเจนและถ่ายใหม่', 'error')
                return redirect(url_for('dashboard'))

    return render_template(
        'dashboard.html',
        scan_history=get_user_scan_history(),
        nearby_context=get_user_nearby_context(session.get('user_id')),
        profile_avatar=get_user_profile_avatar(session.get('user_id')),
    )


@app.route('/nearby-context', methods=['POST'])
@login_required
def save_nearby_context():
    """Store one consented, coarse environmental context per regular user."""
    if session.get('user_role') != 'user':
        abort(403)
    if not require_rate_budget('nearby_context', f"user:{session.get('user_id')}"):
        return {'error': 'ส่งข้อมูลบริบทพื้นที่บ่อยเกินไป กรุณาลองใหม่ภายหลัง'}, 429
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict) or payload.get('consent') is not True:
        return {'error': 'ต้องยืนยันความยินยอมก่อนบันทึกบริบทพื้นที่'}, 400
    try:
        latitude = finite_payload_number(payload, 'latitude', -90, 90)
        longitude = finite_payload_number(payload, 'longitude', -180, 180)
        pm25 = finite_payload_number(payload, 'pm25', 0, 1000)
        uv_index = finite_payload_number(payload, 'uv_index', 0, 30)
        relative_humidity = finite_payload_number(payload, 'relative_humidity', 0, 100)
        temperature_c = finite_payload_number(payload, 'temperature_c', -90, 70)
    except ValueError as error:
        return {'error': str(error)}, 400

    # Keep only roughly a 1 km grid in persistent storage; exact device GPS is
    # deliberately discarded as soon as this request is processed.
    latitude_approx = round(latitude, 2)
    longitude_approx = round(longitude, 2)
    context_level, context_summary = environmental_context_level(pm25, uv_index, relative_humidity, temperature_c)
    now = datetime.now().astimezone()
    now_text = now.isoformat(timespec='seconds')
    expiry = (now + timedelta(hours=LOCATION_CONTEXT_RETENTION_HOURS)).isoformat(timespec='seconds')
    conn = get_db_connection()
    try:
        # Latest context replaces the user's older entry, avoiding a location history.
        conn.execute('DELETE FROM nearby_context_reports WHERE user_id = ?', (session.get('user_id'),))
        cursor = conn.execute(
            """INSERT INTO nearby_context_reports
               (user_id, latitude_approx, longitude_approx, pm25, uv_index, relative_humidity,
                temperature_c, context_level, context_summary, consented_at, consent_version,
                retention_expires_at, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                session.get('user_id'), latitude_approx, longitude_approx, pm25, uv_index,
                relative_humidity, temperature_c, context_level, context_summary, now_text,
                PRIVACY_NOTICE_VERSION, expiry, now_text,
            ),
        )
        conn.commit()
    finally:
        conn.close()
    record_audit_event('nearby_context_saved', 'nearby_context', cursor.lastrowid)
    return {
        'context_level': context_level,
        'context_summary': context_summary,
        'latitude_approx': latitude_approx,
        'longitude_approx': longitude_approx,
        'updated_at': now_text,
        'retention_expires_at': expiry,
    }, 201


@app.route('/nearby-context/delete', methods=['POST'])
@login_required
def delete_nearby_context():
    if session.get('user_role') != 'user':
        abort(403)
    conn = get_db_connection()
    try:
        cursor = conn.execute('DELETE FROM nearby_context_reports WHERE user_id = ?', (session.get('user_id'),))
        conn.commit()
        deleted = cursor.rowcount
    finally:
        conn.close()
    if deleted:
        record_audit_event('nearby_context_deleted', 'nearby_context', 'own-latest')
    flash('ลบตำแหน่งโดยประมาณและบริบทสิ่งแวดล้อมล่าสุดเรียบร้อยแล้ว' if deleted else 'ไม่พบข้อมูลบริบทพื้นที่ที่ต้องลบ', 'success' if deleted else 'warning')
    return redirect(url_for('dashboard'))


@app.route('/scan-images/<filename>')
@login_required
def scan_image(filename):
    filename = secure_filename(filename)
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT user_id FROM scan_logs WHERE image_path = ? OR gradcam_path = ?", (filename, filename))
    scan_log = cursor.fetchone()
    conn.close()

    if not scan_log:
        abort(404)
    if session.get('user_role') != 'admin' and scan_log[0] != session.get('user_id'):
        abort(403)

    record_audit_event(
        'admin_viewed_scan_image' if session.get('user_role') == 'admin' else 'user_viewed_own_scan_image',
        'scan_image',
        filename,
    )

    return send_from_directory(app.config['UPLOAD_FOLDER'], filename, max_age=0)


@app.route('/account/profile-avatar')
@login_required
def own_profile_avatar():
    """Serve only the signed-in regular user's current avatar.

    There is intentionally no filename parameter.  An attacker cannot turn
    this endpoint into a private-upload browser, and an administrator does not
    gain a route for viewing a member's personal profile picture.
    """
    if session.get('user_role') != 'user':
        abort(403)
    avatar = get_user_profile_avatar(session.get('user_id'))
    if not avatar:
        abort(404)
    response = send_from_directory(
        app.config['UPLOAD_FOLDER'],
        avatar['image_path'],
        mimetype='image/jpeg',
        max_age=0,
    )
    response.headers['Cache-Control'] = 'private, no-store, max-age=0'
    response.headers['Pragma'] = 'no-cache'
    return response


@app.route('/scan-logs/<int:scan_id>/delete', methods=['POST'])
@login_required
def delete_scan_log(scan_id):
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT user_id, image_path, gradcam_path FROM scan_logs WHERE id = ?", (scan_id,))
    scan_log = cursor.fetchone()

    if not scan_log:
        conn.close()
        abort(404)
    if session.get('user_role') != 'admin' and scan_log[0] != session.get('user_id'):
        conn.close()
        abort(403)

    cursor.execute("DELETE FROM scan_logs WHERE id = ?", (scan_id,))
    conn.commit()
    conn.close()
    for artifact_path in scan_log[1:]:
        if artifact_path:
            delete_private_upload(artifact_path)
    record_audit_event('scan_deleted', 'scan_log', scan_id)
    flash('ลบผลสแกนและภาพที่เกี่ยวข้องเรียบร้อยแล้ว', 'success')
    return redirect(url_for('dashboard'))


@app.route('/scan-logs/delete-all', methods=['POST'])
@login_required
def delete_all_scan_logs():
    user_id = session.get('user_id')
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT image_path, gradcam_path FROM scan_logs WHERE user_id = ?", (user_id,))
    image_paths = [artifact_path for row in cursor.fetchall() for artifact_path in row if artifact_path]
    cursor.execute("DELETE FROM scan_logs WHERE user_id = ?", (user_id,))
    conn.commit()
    conn.close()

    for image_path in image_paths:
        delete_private_upload(image_path)

    record_audit_event('all_scans_deleted', 'scan_log_batch', len(image_paths))

    flash('ลบประวัติการสแกนและภาพทั้งหมดในบัญชีของคุณเรียบร้อยแล้ว', 'success')
    return redirect(url_for('dashboard'))

# 🛠️ หน้าแผงควบคุมผู้พัฒนาระบบ / แอดมิน (ดึงข้อมูลจริงทั้งหมดจากฐานข้อมูลหลังบ้าน)
@app.route('/admin')
@app.route('/admin_dashboard')
@login_required
@admin_required
def admin_dashboard():
    record_audit_event('admin_dashboard_viewed', 'admin_dashboard')
    conn = get_db_connection(row_factory=True)
    cursor = conn.cursor()
    
    # 1. ดึงข้อเสนอแนะจริงทั้งหมด
    cursor.execute("SELECT * FROM feedbacks ORDER BY created_at DESC")
    feedbacks = cursor.fetchall()
    
    # 2. ดึงเฉพาะข้อมูลที่จำเป็นสำหรับตารางผู้ใช้งานทั่วไปเท่านั้น
    # Never pass password hashes (or future credential fields) to a template.
    cursor.execute(
        """SELECT id, name, email, is_approved, last_login, email_verified_at
           FROM users WHERE role = 'user' ORDER BY id DESC"""
    )
    all_users = cursor.fetchall()
    
    # 3. Read display names from the accounts instead of storing new copies in scan logs.
    cursor.execute(
        """
        SELECT scan_logs.id, scan_logs.user_id, scan_logs.image_path, scan_logs.result_disease,
               scan_logs.confidence, scan_logs.created_at, scan_logs.consented_at,
               scan_logs.is_uncertain, scan_logs.decision_status, scan_logs.model_version,
               COALESCE(users.name, scan_logs.user_name, 'ไม่ทราบชื่อผู้ใช้') AS user_name,
               COALESCE(users.email, scan_logs.user_email, 'ไม่มีอีเมล') AS user_email
        FROM scan_logs
        LEFT JOIN users ON users.id = scan_logs.user_id
        ORDER BY scan_logs.id DESC
        """
    )
    scan_logs = cursor.fetchall()

    cursor.execute(
        "SELECT result_disease, COUNT(*) AS scan_count FROM scan_logs GROUP BY result_disease ORDER BY scan_count DESC"
    )
    distribution_rows = cursor.fetchall()
    
    # 4. สรุปสถิติจริงจากฐานข้อมูล
    cursor.execute("SELECT COUNT(*) as user_count FROM users WHERE role = 'user'")
    total_users_count = cursor.fetchone()['user_count']

    cursor.execute("SELECT COUNT(*) as approved_count FROM users WHERE role = 'user' AND is_approved = 1")
    approved_user_count = cursor.fetchone()['approved_count']
    
    cursor.execute("SELECT COUNT(*) as pending_count FROM users WHERE role = 'user' AND is_approved = 0")
    pending_user_count = cursor.fetchone()['pending_count']

    cursor.execute(
        """SELECT nearby_context_reports.id, nearby_context_reports.user_id,
                  nearby_context_reports.latitude_approx, nearby_context_reports.longitude_approx,
                  nearby_context_reports.pm25, nearby_context_reports.uv_index,
                  nearby_context_reports.relative_humidity, nearby_context_reports.temperature_c,
                  nearby_context_reports.context_level, nearby_context_reports.context_summary,
                  nearby_context_reports.consented_at, nearby_context_reports.retention_expires_at,
                  users.name AS user_name, users.email AS user_email
           FROM nearby_context_reports
           JOIN users ON users.id = nearby_context_reports.user_id
           WHERE nearby_context_reports.retention_expires_at > ?
           ORDER BY nearby_context_reports.consented_at DESC LIMIT 20""",
        (datetime.now().astimezone().isoformat(timespec='seconds'),),
    )
    nearby_context_reports = cursor.fetchall()
    cursor.execute(
        'SELECT enabled_at FROM admin_mfa_credentials WHERE user_id = ?',
        (session.get('user_id'),),
    )
    admin_mfa_credential = cursor.fetchone()
    
    conn.close()
    
    stats = {
        "total_users": total_users_count,
        "approved_users": approved_user_count,
        "pending_users": pending_user_count,
        "total_scans": len(scan_logs),
        "feedbacks_count": len(feedbacks),
        "nearby_context_count": len(nearby_context_reports),
        "model_status": "พร้อมคัดกรอง" if analysis_is_available() else "ระงับจนกว่าจะผ่าน release gate"
    }

    disease_distribution = [
        {
            'label': row['result_disease'],
            'count': row['scan_count'],
            'percent': round((row['scan_count'] / stats['total_scans']) * 100, 1),
        }
        for row in distribution_rows
    ] if stats['total_scans'] else []

    return render_template(
        'admin_dashboard.html',
        stats=stats,
        feedbacks=feedbacks,
        users=all_users,
        scan_logs=scan_logs,
        disease_distribution=disease_distribution,
        feedback_topic_labels=FEEDBACK_TOPICS,
        nearby_context_reports=nearby_context_reports,
        admin_mfa_enabled=admin_mfa_credential is not None,
        admin_mfa_enabled_at=admin_mfa_credential['enabled_at'] if admin_mfa_credential else None,
        admin_mfa_enrollment_available=mfa_enrollment_key_is_available(),
    )


@app.route('/admin/mfa/enroll', methods=['GET', 'POST'])
@login_required
@admin_required
def admin_mfa_enroll():
    admin_id = session.get('user_id')
    if admin_mfa_is_enrolled(admin_id):
        flash('บัญชีผู้ดูแลนี้เปิดใช้ MFA อยู่แล้ว หากต้องการปิดให้ยืนยันรหัสผ่านและรหัสจาก Authenticator ในหน้าแดชบอร์ด', 'warning')
        return redirect(url_for('admin_dashboard'))
    if not mfa_enrollment_key_is_available():
        flash('ยังตั้งค่า MFA ไม่ได้: กำหนด SMART_SKIN_MFA_ENCRYPTION_KEY ใน secret manager (หรือ FLASK_SECRET_KEY ที่คงที่สำหรับเครื่องพัฒนา) แล้วเริ่มระบบใหม่ก่อน', 'error')
        return redirect(url_for('admin_dashboard'))

    existing_enrollment_id = session.get('mfa_enrollment_id')
    if request.method == 'GET':
        if existing_enrollment_id and get_active_admin_mfa_enrollment(existing_enrollment_id, admin_id):
            return redirect(url_for('admin_mfa_enroll_confirm'))
        session.pop('mfa_enrollment_id', None)
        return render_template('admin_mfa_enroll.html', enrollment_secret=None, provisioning_uri=None)

    if not require_rate_budget('admin_mfa_enrollment', f'admin:{admin_id}'):
        flash('เริ่มตั้งค่า MFA บ่อยเกินไป กรุณาลองใหม่ภายหลัง', 'error')
        return redirect(url_for('admin_dashboard'))
    current_password = request.form.get('current_password', '')
    conn = get_db_connection(row_factory=True)
    try:
        admin = conn.execute(
            "SELECT password FROM users WHERE id = ? AND role = 'admin'",
            (admin_id,),
        ).fetchone()
    finally:
        conn.close()
    try:
        password_is_valid = bool(admin) and check_password_hash(admin['password'], current_password)
    except ValueError:
        password_is_valid = False
    if not password_is_valid:
        record_audit_event('admin_mfa_enrollment_reauthentication_failed', 'admin_mfa', admin_id, actor_user_id=admin_id)
        flash('รหัสผ่านปัจจุบันไม่ถูกต้อง จึงยังไม่เริ่มตั้งค่า MFA', 'error')
        return redirect(url_for('admin_mfa_enroll'))

    enrollment_id = start_admin_mfa_enrollment(admin_id)
    if not enrollment_id:
        flash('ไม่สามารถเริ่มตั้งค่า MFA ได้ กรุณาลองใหม่อีกครั้ง', 'error')
        return redirect(url_for('admin_dashboard'))
    session['mfa_enrollment_id'] = enrollment_id
    record_audit_event('admin_mfa_enrollment_started', 'admin_mfa', admin_id, actor_user_id=admin_id)
    return redirect(url_for('admin_mfa_enroll_confirm'))


@app.route('/admin/mfa/enroll/confirm', methods=['GET', 'POST'])
@login_required
@admin_required
def admin_mfa_enroll_confirm():
    admin_id = session.get('user_id')
    enrollment_id = session.get('mfa_enrollment_id')
    enrollment = get_active_admin_mfa_enrollment(enrollment_id, admin_id)
    if not enrollment:
        session.pop('mfa_enrollment_id', None)
        flash('การตั้งค่า MFA หมดอายุหรือถูกยกเลิกแล้ว กรุณาเริ่มใหม่', 'error')
        return redirect(url_for('admin_mfa_enroll'))
    secret = decrypt_admin_mfa_secret(enrollment['secret_ciphertext'])
    if not secret:
        cancel_admin_mfa_enrollment(enrollment_id, admin_id)
        session.pop('mfa_enrollment_id', None)
        record_audit_event('admin_mfa_enrollment_unreadable', 'admin_mfa', admin_id, actor_user_id=admin_id)
        flash('ข้อมูลตั้งค่า MFA อ่านไม่ได้ ระบบยกเลิกการตั้งค่านี้เพื่อความปลอดภัย กรุณาเริ่มใหม่', 'error')
        return redirect(url_for('admin_mfa_enroll'))

    if request.method == 'POST':
        if not require_rate_budget('admin_mfa_verify', f'enroll:{admin_id}'):
            flash('ยืนยันรหัส MFA บ่อยเกินไป กรุณาเริ่มใหม่ภายหลัง', 'error')
            return redirect(url_for('admin_mfa_enroll_confirm'))
        new_epoch = enable_admin_mfa_from_enrollment(admin_id, enrollment_id, request.form.get('totp_code', ''))
        if new_epoch is None:
            record_audit_event('admin_mfa_enrollment_confirmation_failed', 'admin_mfa', admin_id, actor_user_id=admin_id)
            flash('รหัสยืนยันไม่ถูกต้องหรือหมดอายุ กรุณาตรวจเวลาในอุปกรณ์แล้วลองใหม่', 'error')
            return redirect(url_for('admin_mfa_enroll_confirm'))
        establish_authenticated_session(
            {
                'id': admin_id,
                'name': session.get('user_name'),
                'email': session.get('user_email'),
                'role': 'admin',
                'terms_version': session.get('terms_version'),
                'auth_epoch': new_epoch,
            },
            mfa_verified=True,
        )
        record_audit_event('admin_mfa_enabled', 'admin_mfa', admin_id, actor_user_id=admin_id)
        flash('เปิดใช้ MFA สำเร็จแล้ว บัญชีผู้ดูแลจะต้องใช้รหัสจาก Authenticator ทุกครั้งที่เข้าสู่ระบบ', 'success')
        return redirect(url_for('admin_dashboard'))

    return render_template(
        'admin_mfa_enroll.html',
        enrollment_secret=secret,
        provisioning_uri=admin_mfa_provisioning_uri(session.get('user_email', ''), secret),
    )


@app.route('/admin/mfa/enroll/cancel', methods=['POST'])
@login_required
@admin_required
def admin_mfa_enroll_cancel():
    admin_id = session.get('user_id')
    if cancel_admin_mfa_enrollment(session.get('mfa_enrollment_id'), admin_id):
        record_audit_event('admin_mfa_enrollment_cancelled', 'admin_mfa', admin_id, actor_user_id=admin_id)
    session.pop('mfa_enrollment_id', None)
    flash('ยกเลิกการตั้งค่า MFA แล้ว', 'success')
    return redirect(url_for('admin_dashboard'))


@app.route('/admin/mfa/disable', methods=['POST'])
@login_required
@admin_required
def admin_mfa_disable():
    admin_id = session.get('user_id')
    if ADMIN_MFA_REQUIRED:
        record_audit_event('admin_mfa_disable_blocked_by_policy', 'admin_mfa', admin_id, actor_user_id=admin_id)
        flash('Production บังคับใช้ MFA สำหรับผู้ดูแล จึงไม่อนุญาตให้ปิด MFA จากหน้าเว็บ', 'error')
        return redirect(url_for('admin_dashboard'))
    if request.form.get('disable_mfa_confirmation', '').strip().upper() != 'DISABLE':
        flash('ยกเลิกการปิด MFA: ต้องกดยืนยันจากแบบฟอร์มความปลอดภัย', 'error')
        return redirect(url_for('admin_dashboard'))
    if not require_rate_budget('admin_mfa_verify', f'disable:{admin_id}'):
        flash('ยืนยันการปิด MFA บ่อยเกินไป กรุณาลองใหม่ภายหลัง', 'error')
        return redirect(url_for('admin_dashboard'))
    new_epoch = disable_admin_mfa_with_reauthentication(
        admin_id,
        request.form.get('current_password', ''),
        request.form.get('totp_code', ''),
    )
    if new_epoch is None:
        record_audit_event('admin_mfa_disable_failed', 'admin_mfa', admin_id, actor_user_id=admin_id)
        flash('ไม่สามารถปิด MFA ได้: ต้องใช้รหัสผ่านปัจจุบันและรหัส TOTP ใหม่ที่ถูกต้อง', 'error')
        return redirect(url_for('admin_dashboard'))
    establish_authenticated_session(
        {
            'id': admin_id,
            'name': session.get('user_name'),
            'email': session.get('user_email'),
            'role': 'admin',
            'terms_version': session.get('terms_version'),
            'auth_epoch': new_epoch,
        }
    )
    record_audit_event('admin_mfa_disabled_self_service', 'admin_mfa', admin_id, actor_user_id=admin_id)
    flash('ปิด MFA สำหรับบัญชีนี้แล้ว โปรดเปิดใช้งานใหม่โดยเร็วหากยังต้องดูแลระบบ', 'warning')
    return redirect(url_for('admin_dashboard'))


@app.route('/admin/mfa/recover', methods=['POST'])
@login_required
@admin_required
def admin_mfa_recover():
    actor_id = session.get('user_id')
    if ADMIN_MFA_REQUIRED:
        record_audit_event('admin_mfa_recovery_blocked_by_policy', 'admin_mfa', actor_id, actor_user_id=actor_id)
        flash('Production บังคับใช้ MFA สำหรับผู้ดูแล การกู้คืนต้องทำตามขั้นตอน break-glass นอกระบบ', 'error')
        return redirect(url_for('admin_dashboard'))
    if request.form.get('mfa_recovery_confirmation', '').strip().upper() != 'RECOVER':
        flash('ยกเลิกการกู้คืน MFA: ต้องยืนยันจากแบบฟอร์มฉุกเฉิน', 'error')
        return redirect(url_for('admin_dashboard'))
    if not require_rate_budget('admin_mfa_recovery', f'admin:{actor_id}'):
        flash('ทำรายการกู้คืน MFA บ่อยเกินไป กรุณาลองใหม่ภายหลัง', 'error')
        return redirect(url_for('admin_dashboard'))
    recovered_admin_id = recover_other_admin_mfa(
        actor_id,
        request.form.get('current_password', ''),
        request.form.get('totp_code', ''),
        request.form.get('target_admin_email', ''),
    )
    if recovered_admin_id is None:
        record_audit_event('admin_mfa_recovery_failed', 'admin_mfa', actor_id, actor_user_id=actor_id)
        flash('ไม่สามารถกู้คืน MFA ได้: ผู้ดำเนินการต้องเป็นแอดมินคนอื่นที่เปิด MFA และยืนยันรหัสผ่านกับรหัส TOTP ใหม่ให้ถูกต้อง', 'error')
        return redirect(url_for('admin_dashboard'))
    record_audit_event('admin_mfa_recovery_disabled', 'admin_mfa', recovered_admin_id, actor_user_id=actor_id)
    flash('ปิด MFA ของแอดมินเป้าหมายแล้ว และบังคับให้ออกจากทุกเซสชันเพื่อให้ตั้งค่าใหม่อย่างปลอดภัย', 'success')
    return redirect(url_for('admin_dashboard'))


@app.route('/admin/training/start', methods=['POST'])
@login_required
@admin_required
def start_admin_training():
    if not ADMIN_TRAINING_ENABLED:
        flash('การฝึกโมเดลจากหน้าแอดมินถูกปิดใน production; ผู้ดูแลระบบต้องเปิดค่า SMART_SKIN_ALLOW_ADMIN_TRAINING=1 ก่อน', 'error')
        return redirect(url_for('admin_dashboard'))
    try:
        epochs = int(request.form.get('epochs', '20'))
    except ValueError:
        epochs = 0
    if epochs not in TRAINING_EPOCH_OPTIONS:
        flash('จำนวนรอบฝึกไม่ถูกต้อง', 'error')
        return redirect(url_for('admin_dashboard'))

    preflight = training_preflight(check_duplicates=True)
    if not preflight['ready_for_training']:
        flash('ยังเริ่มฝึกไม่ได้: ต้องมีภาพจริงครบทุกคลาส, manifest ที่อนุมัติแล้ว และไม่พบภาพซ้ำ', 'error')
        return redirect(url_for('admin_dashboard'))
    try:
        manifest = read_approved_training_manifest()
        job_id = start_training_job(session.get('user_id'), epochs, preflight, manifest)
    except ValueError as error:
        flash(str(error), 'error')
        return redirect(url_for('admin_dashboard'))

    flash(f'เริ่มงานฝึก candidate model 50 คลาสแล้ว (Job {job_id[:8]}) ผลที่ได้จะยังไม่ถูกเปิดใช้กับผู้ใช้จริง', 'success')
    return redirect(url_for('admin_dashboard'))

# 🛡️ ระบบให้แอดมินกดอนุมัติการใช้งานผู้ใช้
@app.route('/approve_user/<int:user_id>', methods=['POST'])
@login_required
@admin_required
def approve_user(user_id):
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("UPDATE users SET is_approved = 1 WHERE id = ? AND role = 'user'", (user_id,))
    conn.commit()
    updated = cursor.rowcount
    conn.close()
    if updated:
        record_audit_event('user_approved', 'user', user_id)
    flash('อนุมัติสมาชิกเข้าใช้งานเรียบร้อยแล้ว!' if updated else 'ไม่พบสมาชิกที่รออนุมัติ', 'success' if updated else 'error')
    return redirect(url_for('admin_dashboard'))


@app.route('/admin/users/<int:user_id>/password-reset', methods=['POST'])
@login_required
@admin_required
def admin_send_password_reset(user_id):
    admin_id = session.get('user_id')
    if not require_rate_budget('admin_password_reset', f'admin:{admin_id}'):
        flash('ส่งลิงก์ตั้งรหัสผ่านใหม่บ่อยเกินไป กรุณาลองใหม่ภายหลัง', 'error')
        return redirect(url_for('admin_dashboard'))
    if not PASSWORD_RESET_EMAIL_CONFIGURED:
        flash('ยังส่งลิงก์ตั้งรหัสผ่านใหม่ไม่ได้: ผู้ดูแลต้องกำหนด SMTP และ SMART_SKIN_PUBLIC_BASE_URL ก่อน', 'error')
        return redirect(url_for('admin_dashboard'))
    if issue_password_reset_email(user_id, requested_by_user_id=admin_id):
        record_audit_event('admin_password_reset_sent', 'user', user_id, actor_user_id=admin_id)
        flash('ส่งลิงก์ตั้งรหัสผ่านใหม่แบบใช้ครั้งเดียวให้ผู้ใช้แล้ว', 'success')
    else:
        flash('ไม่สามารถส่งลิงก์ตั้งรหัสผ่านใหม่ได้ กรุณาตรวจการตั้งค่าอีเมลและบัญชีผู้ใช้', 'error')
    return redirect(url_for('admin_dashboard'))


# ❌ ระบบให้แอดมินลบบัญชีสมาชิก
@app.route('/delete_user/<int:user_id>', methods=['POST'])
@app.route('/reject_user/<int:user_id>', methods=['POST'])
@login_required
@admin_required
def delete_user(user_id):
    if request.form.get('admin_delete_confirmation', '').strip().upper() != 'DELETE':
        flash('ยกเลิกการลบบัญชี: ต้องกดยืนยันจากหน้าต่างยืนยันก่อนดำเนินการ', 'error')
        return redirect(url_for('admin_dashboard'))
    artifact_paths = delete_regular_user_account(user_id)
    if artifact_paths is None:
        flash('ไม่พบสมาชิกที่สามารถลบได้', 'error')
        return redirect(url_for('admin_dashboard'))
    for image_path in artifact_paths:
        if is_profile_avatar_filename(image_path):
            delete_profile_avatar_upload(image_path)
        else:
            delete_private_upload(image_path)

    record_audit_event('user_deleted', 'user', user_id)

    flash('ลบข้อมูลสมาชิก ภาพสแกน ประวัติ และข้อเสนอแนะเรียบร้อยแล้ว', 'success')
    return redirect(url_for('admin_dashboard'))


@app.route('/account/delete', methods=['POST'])
@login_required
def delete_own_account():
    user_id = session.get('user_id')
    if session.get('user_role') != 'user':
        abort(403)
    if request.form.get('delete_account_confirmation', '').strip().upper() != 'DELETE':
        flash('พิมพ์ DELETE เพื่อยืนยันการลบบัญชีและข้อมูลทั้งหมด', 'error')
        return redirect(url_for('dashboard'))
    if not require_rate_budget('account_delete', f'user:{user_id}'):
        flash('ส่งคำขอลบบัญชีบ่อยเกินไป กรุณาลองใหม่ภายหลัง', 'error')
        return redirect(url_for('dashboard'))
    artifact_paths = delete_regular_user_account(user_id)
    if artifact_paths is None:
        abort(404)
    for artifact_path in artifact_paths:
        if is_profile_avatar_filename(artifact_path):
            delete_profile_avatar_upload(artifact_path)
        else:
            delete_private_upload(artifact_path)
    record_audit_event('own_account_deleted', 'user', user_id, actor_user_id=user_id)
    session.clear()
    flash('ลบบัญชี ประวัติ ภาพ และข้อมูลที่เกี่ยวข้องเรียบร้อยแล้ว', 'success')
    return redirect(url_for('home'))


@app.route('/account/change-password', methods=['POST'])
@login_required
def change_own_password():
    user_id = session.get('user_id')
    if session.get('user_role') != 'user':
        abort(403)
    if not require_rate_budget('password_change', f'user:{user_id}'):
        flash('เปลี่ยนรหัสผ่านบ่อยเกินไป กรุณาลองใหม่ภายหลัง', 'error')
        return redirect(url_for('dashboard'))

    current_password = request.form.get('current_password', '')
    new_password = request.form.get('new_password', '')
    confirmation = request.form.get('new_password_confirmation', '')
    if not current_password:
        flash('กรุณากรอกรหัสผ่านปัจจุบัน', 'error')
        return redirect(url_for('dashboard'))
    if new_password != confirmation:
        flash('ยืนยันรหัสผ่านใหม่ไม่ตรงกัน', 'error')
        return redirect(url_for('dashboard'))
    if not is_strong_password(new_password):
        flash('รหัสผ่านใหม่ต้องยาวอย่างน้อย 12 ตัวอักษร และมีทั้งตัวอักษรกับตัวเลข', 'error')
        return redirect(url_for('dashboard'))

    conn = get_db_connection()
    try:
        cursor = conn.cursor()
        user = cursor.execute(
            "SELECT password, role, auth_epoch FROM users WHERE id = ?",
            (user_id,),
        ).fetchone()
        if not user or user[1] != 'user':
            session.clear()
            abort(403)
        try:
            current_password_is_valid = check_password_hash(user[0], current_password)
            password_is_unchanged = check_password_hash(user[0], new_password)
        except ValueError:
            current_password_is_valid = False
            password_is_unchanged = False
        if not current_password_is_valid:
            flash('รหัสผ่านปัจจุบันไม่ถูกต้อง', 'error')
            return redirect(url_for('dashboard'))
        if password_is_unchanged:
            flash('โปรดตั้งรหัสผ่านใหม่ที่แตกต่างจากรหัสผ่านปัจจุบัน', 'error')
            return redirect(url_for('dashboard'))
        cursor.execute(
            "UPDATE users SET password = ?, auth_epoch = auth_epoch + 1 WHERE id = ? AND role = 'user'",
            (generate_password_hash(new_password), user_id),
        )
        # A prior reset link must not remain capable of taking over an account
        # after its owner has deliberately changed the password.
        cursor.execute(
            "UPDATE password_reset_tokens SET used_at = ? WHERE user_id = ? AND used_at IS NULL",
            (datetime.now().astimezone().isoformat(timespec='seconds'), user_id),
        )
        conn.commit()
    finally:
        conn.close()

    session['auth_epoch'] = user[2] + 1
    record_audit_event('password_changed', 'user', user_id, actor_user_id=user_id)
    flash('เปลี่ยนรหัสผ่านเรียบร้อยแล้ว', 'success')
    return redirect(url_for('dashboard'))


@app.route('/account/profile-avatar', methods=['POST'])
@login_required
def update_own_profile_avatar():
    """Replace the signed-in regular user's private profile image."""
    user_id = session.get('user_id')
    if session.get('user_role') != 'user':
        abort(403)
    if not require_rate_budget('profile_avatar_update', f'user:{user_id}'):
        flash('อัปเดตรูปโปรไฟล์บ่อยเกินไป กรุณาลองใหม่ภายหลัง', 'error')
        return redirect(url_for('dashboard'))
    try:
        image_bytes = normalize_profile_avatar(request.files.get('profile_avatar'))
    except ValueError as error:
        flash(str(error), 'error')
        return redirect(url_for('dashboard'))

    try:
        new_filename = write_profile_avatar_file(image_bytes)
    except OSError:
        app.logger.exception('Unable to write normalized profile avatar')
        flash('ไม่สามารถบันทึกรูปโปรไฟล์ได้ กรุณาลองใหม่อีกครั้ง', 'error')
        return redirect(url_for('dashboard'))

    previous_filename = None
    conn = get_db_connection()
    try:
        conn.execute('BEGIN IMMEDIATE')
        account = conn.execute(
            "SELECT role FROM users WHERE id = ?", (user_id,)
        ).fetchone()
        if not account or account[0] != 'user':
            conn.rollback()
            delete_profile_avatar_upload(new_filename)
            session.clear()
            abort(403)
        existing = conn.execute(
            "SELECT image_path FROM profile_avatars WHERE user_id = ?", (user_id,)
        ).fetchone()
        previous_filename = existing[0] if existing else None
        now_text = datetime.now().astimezone().isoformat(timespec='seconds')
        conn.execute(
            '''INSERT INTO profile_avatars (user_id, image_path, created_at, updated_at)
               VALUES (?, ?, ?, ?)
               ON CONFLICT(user_id) DO UPDATE SET
                   image_path = excluded.image_path,
                   updated_at = excluded.updated_at''',
            (user_id, new_filename, now_text, now_text),
        )
        conn.commit()
    except sqlite3.Error:
        conn.rollback()
        delete_profile_avatar_upload(new_filename)
        app.logger.exception('Unable to persist profile-avatar ownership record')
        flash('ไม่สามารถบันทึกรูปโปรไฟล์ได้ กรุณาลองใหม่อีกครั้ง', 'error')
        return redirect(url_for('dashboard'))
    finally:
        conn.close()

    if previous_filename:
        delete_profile_avatar_upload(previous_filename)
    record_audit_event('profile_avatar_updated', 'profile_avatar', user_id, actor_user_id=user_id)
    flash('อัปเดตรูปโปรไฟล์เรียบร้อยแล้ว ระบบลบข้อมูลเมตาของภาพก่อนจัดเก็บ', 'success')
    return redirect(url_for('dashboard'))


@app.route('/account/profile-avatar/remove', methods=['POST'])
@login_required
def remove_own_profile_avatar():
    """Delete the signed-in regular user's avatar record and private image."""
    user_id = session.get('user_id')
    if session.get('user_role') != 'user':
        abort(403)
    if not require_rate_budget('profile_avatar_remove', f'user:{user_id}'):
        flash('ลบรูปโปรไฟล์บ่อยเกินไป กรุณาลองใหม่ภายหลัง', 'error')
        return redirect(url_for('dashboard'))
    conn = get_db_connection()
    try:
        conn.execute('BEGIN IMMEDIATE')
        row = conn.execute(
            'SELECT image_path FROM profile_avatars WHERE user_id = ?', (user_id,)
        ).fetchone()
        conn.execute('DELETE FROM profile_avatars WHERE user_id = ?', (user_id,))
        conn.commit()
    except sqlite3.Error:
        conn.rollback()
        app.logger.exception('Unable to delete profile-avatar ownership record')
        flash('ไม่สามารถลบรูปโปรไฟล์ได้ กรุณาลองใหม่อีกครั้ง', 'error')
        return redirect(url_for('dashboard'))
    finally:
        conn.close()

    if not row:
        flash('ไม่พบรูปโปรไฟล์ที่ต้องลบ', 'warning')
        return redirect(url_for('dashboard'))
    delete_profile_avatar_upload(row[0])
    record_audit_event('profile_avatar_removed', 'profile_avatar', user_id, actor_user_id=user_id)
    flash('ลบรูปโปรไฟล์เรียบร้อยแล้ว', 'success')
    return redirect(url_for('dashboard'))

# 💬 ระบบรับข้อเสนอแนะถึงผู้พัฒนา
@app.route('/send_feedback', methods=['POST'])
@login_required
def send_feedback():
    if not require_rate_budget('feedback', f"user:{session.get('user_id')}"):
        flash('ส่งข้อเสนอแนะบ่อยเกินไป กรุณาลองใหม่ภายหลัง', 'error')
        return redirect(url_for('dashboard'))
    message = request.form.get('message', '').strip()
    topic = request.form.get('topic', 'general').strip()
    if topic not in FEEDBACK_TOPICS:
        topic = 'general'
    user_email = session.get('user_email', 'Guest')
    user_name = session.get('user_name', 'ผู้เยี่ยมชม')
    return_to_privacy = request.form.get('return_to') == 'privacy'
    destination = (
        url_for('privacy', return_to='scan')
        if return_to_privacy and session.get('user_role') == 'user'
        else url_for('admin_dashboard') if session.get('user_role') == 'admin' else url_for('dashboard')
    )
    
    if message and len(message) <= MAX_FEEDBACK_LENGTH and '\x00' not in message:
        conn = get_db_connection()
        cursor = conn.cursor()
        retention_expires_at = (
            datetime.now().astimezone() + timedelta(days=app.config['UPLOAD_RETENTION_DAYS'])
        ).isoformat(timespec='seconds')
        cursor.execute(
            """INSERT INTO feedbacks
               (user_id, user_email, user_name, topic, message, retention_expires_at)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (session.get('user_id'), user_email, user_name, topic, message, retention_expires_at)
        )
        conn.commit()
        conn.close()
        flash('ส่งข้อเสนอแนะเรียบร้อยแล้ว ขอบคุณครับ!', 'success')
    else:
        flash(f'กรุณากรอกข้อความที่ยาวไม่เกิน {MAX_FEEDBACK_LENGTH:,} ตัวอักษร', 'error')
        
    return redirect(destination)

@app.route('/logout', methods=['POST'])
def logout():
    session.clear()
    return redirect(url_for('home'))

if __name__ == '__main__':
    app.run(
        debug=os.environ.get('FLASK_DEBUG') == '1',
        host=os.environ.get('FLASK_HOST', '127.0.0.1'),
        port=int(os.environ.get('FLASK_PORT', '5000')),
    )
