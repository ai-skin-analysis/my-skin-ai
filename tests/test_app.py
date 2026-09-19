import io
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np
import tensorflow as tf
from PIL import Image, ImageDraw
from werkzeug.security import generate_password_hash

import app as application


class StubModel:
    def predict(self, image_array, verbose=0):
        # Basal cell carcinoma is one of the legacy outputs that remains
        # inside the current mobile-photo target catalog.
        return np.array([[0.05, 0.70, 0.05, 0.05, 0.10, 0.05]], dtype='float32')


class OutOfScopeStubModel:
    def predict(self, image_array, verbose=0):
        return np.array([[0.36, 0.35, 0.10, 0.08, 0.06, 0.05]], dtype='float32')


class AmbiguousStubModel:
    def predict(self, image_array, verbose=0):
        return np.array([[0.52, 0.41, 0.03, 0.02, 0.01, 0.01]], dtype='float32')


class NeverCalledModel:
    def predict(self, image_array, verbose=0):
        raise AssertionError('Quality gate must reject this image before model scoring.')


class TestSmartSkinApp(unittest.TestCase):
    def setUp(self):
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.database_path = Path(self.temporary_directory.name) / 'test-users.db'
        self.upload_path = Path(self.temporary_directory.name) / 'private-uploads'
        self.upload_path.mkdir()
        self.previous_database = application.app.config['DATABASE']
        self.previous_upload_folder = application.app.config['UPLOAD_FOLDER']
        self.previous_public_information_mode = application.app.config['PUBLIC_INFORMATION_MODE']
        self.previous_model = application.model
        application.app.config.update(
            TESTING=True,
            DATABASE=str(self.database_path),
            UPLOAD_FOLDER=str(self.upload_path),
            PUBLIC_INFORMATION_MODE=False,
        )
        application.model = StubModel()
        application.LOGIN_ATTEMPTS.clear()
        application.init_db()
        self.client = application.app.test_client()

    def tearDown(self):
        application.LOGIN_ATTEMPTS.clear()
        application.model = self.previous_model
        application.app.config['DATABASE'] = self.previous_database
        application.app.config['UPLOAD_FOLDER'] = self.previous_upload_folder
        application.app.config['PUBLIC_INFORMATION_MODE'] = self.previous_public_information_mode
        self.temporary_directory.cleanup()

    def csrf_token(self):
        self.client.get('/')
        with self.client.session_transaction() as session:
            return session['csrf_token']

    def create_user(self, email='member@example.com', approved=True):
        conn = application.get_db_connection()
        cursor = conn.cursor()
        cursor.execute(
            """INSERT INTO users
               (name, email, password, role, is_approved, terms_accepted_at, terms_version)
               VALUES (?, ?, ?, 'user', ?, ?, ?)""",
            (
                'Member',
                email,
                generate_password_hash('Password12345'),
                int(approved),
                '2026-09-02T00:00:00+07:00',
                application.TERMS_VERSION,
            ),
        )
        user_id = cursor.lastrowid
        conn.commit()
        conn.close()
        return user_id

    def create_admin(self, email='admin@example.com', name='Administrator'):
        conn = application.get_db_connection()
        cursor = conn.cursor()
        cursor.execute(
            "INSERT INTO users (name, email, password, role, is_approved) VALUES (?, ?, ?, 'admin', 1)",
            (name, email, generate_password_hash('Password12345')),
        )
        admin_id = cursor.lastrowid
        conn.commit()
        conn.close()
        return admin_id

    def enroll_admin_mfa_directly(self, admin_id, secret=None):
        """Create an encrypted credential to exercise post-enrollment behavior."""
        secret = secret or application.generate_admin_totp_secret()
        now = application.datetime.now().astimezone().isoformat(timespec='seconds')
        conn = application.get_db_connection()
        conn.execute(
            '''INSERT INTO admin_mfa_credentials
               (user_id, secret_ciphertext, enabled_at, last_used_counter, created_at, updated_at)
               VALUES (?, ?, ?, NULL, ?, ?)''',
            (admin_id, application.encrypt_admin_mfa_secret(secret), now, now, now),
        )
        conn.commit()
        conn.close()
        return secret

    def sign_in_mfa_admin_session(self, user_id, email='admin@example.com', name='Administrator', auth_epoch=0):
        self.sign_in_session(user_id, email=email, role='admin', name=name, auth_epoch=auth_epoch)
        with self.client.session_transaction() as session:
            session['mfa_authenticated_at'] = application.datetime.now().astimezone().isoformat(timespec='seconds')
            session['mfa_authenticated_auth_epoch'] = auth_epoch

    def sign_in_session(self, user_id, email='member@example.com', role='user', name='Member', auth_epoch=0):
        with self.client.session_transaction() as session:
            session['user_id'] = user_id
            session['user_name'] = name
            session['user_email'] = email
            session['user_role'] = role
            session['auth_epoch'] = auth_epoch

    def skin_lesion_image_buffer(self, image_format='PNG', exif=None):
        """Create a non-flat test image with enough detail for the quality gate."""
        image = Image.new('RGB', (160, 160), color=(190, 142, 112))
        drawing = ImageDraw.Draw(image)
        drawing.ellipse((31, 28, 130, 128), fill=(90, 42, 35), outline=(55, 24, 20), width=4)
        drawing.ellipse((58, 52, 104, 98), fill=(140, 61, 43))
        drawing.line((44, 122, 64, 143), fill=(110, 55, 35), width=3)
        buffer = io.BytesIO()
        save_options = {'format': image_format}
        if exif is not None:
            save_options['exif'] = exif
        image.save(buffer, **save_options)
        buffer.seek(0)
        return buffer

    def test_landing_page_restores_the_original_interactive_eilik_mascot(self):
        response = self.client.get('/')
        page = response.get_data(as_text=True)
        self.assertEqual(response.status_code, 200)
        self.assertIn('น้องอิลลิค', page)
        self.assertIn('id="eilik-space-container"', page)
        self.assertIn('id="eilik-render"', page)
        self.assertIn('roamEilikEverywhere', page)
        self.assertIn('state-float', page)
        self.assertNotIn('สถานะการคัดกรอง', page)
        self.assertNotIn('อนุมัติครบถ้วน', page)
        self.assertNotIn('manifest.webmanifest', page)
        self.assertNotIn("service-worker.js", page)
        self.assertIn('name="terms_consent"', page)
        self.assertNotIn('illic-stage', page)
        self.assertNotIn('illicFloatingCompanion', page)
        self.assertNotIn('assets/illic-ai-mascot-v2.png', page)

    def test_public_information_mode_exposes_only_public_content_and_health_probes(self):
        application.app.config['PUBLIC_INFORMATION_MODE'] = True
        # Public mode must not quietly initialise or require the account and
        # health-image data stores while it is serving only public content.
        public_mode_root = Path(self.temporary_directory.name)
        application.app.config['DATABASE'] = str(public_mode_root / 'not-used-in-public-mode.db')
        application.app.config['UPLOAD_FOLDER'] = str(public_mode_root / 'not-used-in-public-mode-uploads')

        landing = self.client.get('/')
        page = landing.get_data(as_text=True)
        self.assertEqual(landing.status_code, 200)
        self.assertIn('PUBLIC INFORMATION MODE', page)
        self.assertIn('ไม่มีการสมัครสมาชิก เข้าสู่ระบบ หรือรับภาพเพื่อวิเคราะห์ในขณะนี้', page)
        self.assertNotIn('id="formLogin"', page)
        self.assertIn('RESPONSIBLE SKIN HEALTH INFORMATION', page)
        self.assertNotIn('COMPUTER VISION & SKIN IMAGE SCREENING', page)
        self.assertEqual(landing.headers['Permissions-Policy'], 'camera=(), geolocation=(self), microphone=()')

        # The public host neither accepts registrations nor leaks dashboard
        # routes, even if a visitor knows the legacy URL.
        self.assertEqual(self.client.post('/register', data={}).status_code, 404)
        dashboard = self.client.get('/dashboard')
        self.assertEqual(dashboard.status_code, 302)
        self.assertTrue(dashboard.headers['Location'].endswith('/'))
        self.assertEqual(self.client.get('/privacy').status_code, 200)

        self.assertEqual(self.client.get('/healthz').get_json(), {'status': 'ok'})
        readiness = self.client.get('/readyz')
        self.assertEqual(readiness.status_code, 200)
        self.assertEqual(readiness.get_json(), {'status': 'ready'})

    def test_rejected_trusted_host_fails_closed_without_redirect_error(self):
        previous_hosts = application.app.config.get('TRUSTED_HOSTS')
        application.app.config['TRUSTED_HOSTS'] = ['skin.example.test', '.run.app']
        try:
            response = self.client.get('/healthz', headers={'Host': 'untrusted.example'})
            self.assertEqual(response.status_code, 400)
            self.assertNotEqual(response.status_code, 500)
        finally:
            application.app.config['TRUSTED_HOSTS'] = previous_hosts

    def test_weather_and_map_location_features_require_an_in_app_consent_before_geolocation(self):
        landing_response = self.client.get('/')
        landing_page = landing_response.get_data(as_text=True)
        self.assertIn('id="environmentLocationConsentModal"', landing_page)
        self.assertIn('id="environmentLocationConsentCheck"', landing_page)
        self.assertIn('approveEnvironmentLocationConsent()', landing_page)
        self.assertLess(
            landing_page.index('function approveEnvironmentLocationConsent()'),
            landing_page.index('navigator.geolocation.getCurrentPosition(', landing_page.index('function approveEnvironmentLocationConsent()')),
        )
        self.assertIn('format=jsonv2', landing_page)
        self.assertIn('weather_code', landing_page)
        self.assertIn('useCurrentLocationForMap()', landing_page)
        self.assertIn('mapLocationConsent', landing_page)
        self.assertIn('id="mapLocationConsentCheck"', landing_page)
        self.assertIn('openstreetmap.org/export/embed.html', landing_page)
        self.assertIn('marker=${markerLat.toFixed(4)}', landing_page)
        self.assertIn('maximumAge: 0', landing_page)
        self.assertIn('function clearMapLocationConsent()', landing_page)
        self.assertIn('mapLocationConsent = false;', landing_page)
        self.assertIn('mapGoogleMapsLocationConsent = false;', landing_page)
        self.assertIn('const wantsGoogleMapsLocation = document.getElementById(\'googleMapLocationConsentCheck\').checked === true;', landing_page)
        self.assertIn('mapGoogleMapsLocationConsent = wantsGoogleMapsLocation;', landing_page)
        self.assertIn('&& mapGoogleMapsLocationConsent', landing_page)
        self.assertGreaterEqual(landing_page.count('clearMapLocationConsent();'), 2)
        self.assertIn('id="environment-source-text"', landing_page)
        self.assertIn('Open-Meteo current conditions', landing_page)
        self.assertNotIn('กะลุวอเหนือ', landing_page)
        self.assertIn('https://www.openstreetmap.org', landing_response.headers['Content-Security-Policy'])
        self.assertIn('window.isSecureContext', landing_page)
        self.assertIn('insecureLocationContextMessage()', landing_page)

        user_id = self.create_user()
        self.sign_in_session(user_id)
        dashboard_page = self.client.get('/dashboard').get_data(as_text=True)
        self.assertIn('id="locationServiceConsentModal"', dashboard_page)
        self.assertIn('id="dashboardLocationConsentCheck"', dashboard_page)
        self.assertIn('id="nearbyContextConsentCheck"', dashboard_page)
        self.assertIn('latitude: environment.latitudeApprox', dashboard_page)
        self.assertIn('longitude: environment.longitudeApprox', dashboard_page)
        self.assertIn('dashboardMapLocationConsent', dashboard_page)
        self.assertIn('function mayShareDashboardLocationWithGoogleMaps()', dashboard_page)
        self.assertIn('const wantsGoogleMapsLocation = document.getElementById(\'dashboardGoogleMapsConsentCheck\').checked === true;', dashboard_page)
        self.assertIn('dashboardGoogleMapsLocationConsent = wantsGoogleMapsLocation;', dashboard_page)
        self.assertIn('if (mayShareDashboardLocationWithGoogleMaps())', dashboard_page)
        self.assertLess(
            dashboard_page.index('if (mayShareDashboardLocationWithGoogleMaps())'),
            dashboard_page.index('https://maps.google.com/maps?q=${currentLat.toFixed(4)}'),
        )
        self.assertIn('window.isSecureContext', dashboard_page)
        self.assertIn('dashboardLocationErrorMessage(error)', dashboard_page)

        privacy_page = self.client.get('/privacy').get_data(as_text=True)
        self.assertIn('การเปิดแผนที่จะขอความยินยอมแยก', privacy_page)
        self.assertIn('พิกัดจริงใช้ชั่วคราวในเบราว์เซอร์เพื่อปัดค่า', privacy_page)

    def test_retired_offline_worker_only_clears_prior_public_caches(self):
        service_worker = self.client.get('/service-worker.js')
        try:
            self.assertEqual(service_worker.status_code, 200)
            self.assertIn('application/javascript', service_worker.headers['Content-Type'])
            self.assertIn('no-cache', service_worker.headers['Cache-Control'])
            worker_source = service_worker.get_data(as_text=True)
            self.assertIn("caches.delete(key)", worker_source)
            self.assertIn("self.registration.unregister()", worker_source)
            self.assertNotIn("PUBLIC_SHELL_ASSETS", worker_source)
            self.assertNotIn("cache.put(request", worker_source)
        finally:
            service_worker.close()

        manifest = self.client.get('/static/manifest.webmanifest')
        try:
            self.assertEqual(manifest.status_code, 404)
        finally:
            manifest.close()

        offline_page = self.client.get('/static/offline.html')
        try:
            self.assertEqual(offline_page.status_code, 404)
        finally:
            offline_page.close()

    def test_privacy_notice_version_remains_internal_and_dynamic_pages_are_not_cached(self):
        landing_page = self.client.get('/')
        try:
            self.assertNotIn('2026-09-02', landing_page.get_data(as_text=True))
            self.assertEqual(landing_page.headers['Cache-Control'], 'no-store, max-age=0')
        finally:
            landing_page.close()

        privacy_page = self.client.get('/privacy')
        try:
            privacy_html = privacy_page.get_data(as_text=True)
            self.assertNotIn('2026-09-02', privacy_html)
            self.assertNotIn('ประกาศฉบับ', privacy_html)
            self.assertEqual(privacy_page.headers['Cache-Control'], 'no-store, max-age=0')
        finally:
            privacy_page.close()

        terms_page = self.client.get('/terms')
        try:
            self.assertNotIn('2026-09-02', terms_page.get_data(as_text=True))
            self.assertEqual(terms_page.headers['Cache-Control'], 'no-store, max-age=0')
        finally:
            terms_page.close()

        user_id = self.create_user()
        self.sign_in_session(user_id)
        dashboard_page = self.client.get('/dashboard')
        try:
            dashboard_html = dashboard_page.get_data(as_text=True)
            self.assertNotIn('2026-09-02', dashboard_html)
            self.assertEqual(dashboard_page.headers['Cache-Control'], 'no-store, max-age=0')
            self.assertEqual(dashboard_page.headers['Pragma'], 'no-cache')
        finally:
            dashboard_page.close()

        # The stored version remains available for consent/audit records even
        # though it is no longer rendered in public or authenticated HTML.
        self.assertEqual(application.PRIVACY_NOTICE_VERSION, '2026-09-02')

    def test_admin_scan_and_logout_controls_are_branded_and_logout_clears_the_session(self):
        conn = application.get_db_connection()
        cursor = conn.cursor()
        cursor.execute(
            "INSERT INTO users (name, email, password, role, is_approved) VALUES (?, ?, ?, 'admin', 1)",
            ('Administrator', 'controls-admin@example.com', generate_password_hash('Password12345')),
        )
        admin_id = cursor.lastrowid
        conn.commit()
        conn.close()
        self.sign_in_session(admin_id, 'controls-admin@example.com', role='admin', name='Administrator')

        response = self.client.get('/admin_dashboard')
        page = response.get_data(as_text=True)
        self.assertEqual(response.status_code, 200)
        self.assertIn('id="adminScanInterfaceButton"', page)
        self.assertIn('id="adminLogoutButton"', page)
        self.assertIn('href="/dashboard"', page)
        self.assertIn('data-accessible-modal="true"', page)
        self.assertIn('function openAdminAccessibleModal', page)
        self.assertIn('function closeAdminAccessibleModal', page)
        self.assertIn('aria-labelledby="logoutModalTitle"', page)
        self.assertIn('<script nonce="', page)

        with self.client.session_transaction() as session:
            token = session['csrf_token']
        response = self.client.post('/logout', data={'csrf_token': token})
        self.assertEqual(response.status_code, 302)
        self.assertTrue(response.headers['Location'].endswith('/'))
        with self.client.session_transaction() as session:
            self.assertNotIn('user_id', session)

    def test_post_routes_require_csrf(self):
        response = self.client.post('/register', data={})
        self.assertEqual(response.status_code, 400)

    def test_skin_timeline_button_is_available_to_regular_users_only(self):
        user_id = self.create_user()
        self.sign_in_session(user_id)
        response = self.client.get('/dashboard')
        self.assertIn('id="userTimelineButton"', response.get_data(as_text=True))

        conn = application.get_db_connection()
        cursor = conn.cursor()
        cursor.execute(
            "INSERT INTO users (name, email, password, role, is_approved) VALUES (?, ?, ?, 'admin', 1)",
            ('Administrator', 'timeline-admin@example.com', generate_password_hash('Password12345')),
        )
        admin_id = cursor.lastrowid
        conn.commit()
        conn.close()
        self.sign_in_session(admin_id, 'timeline-admin@example.com', role='admin', name='Administrator')
        response = self.client.get('/dashboard')
        self.assertNotIn('id="userTimelineButton"', response.get_data(as_text=True))

    def test_scan_user_account_menu_groups_account_controls_and_feedback_stays_on_scan(self):
        user_id = self.create_user()
        self.sign_in_session(user_id)

        dashboard_page = self.client.get('/dashboard').get_data(as_text=True)
        self.assertIn('id="userAccountButton"', dashboard_page)
        self.assertIn('id="userAccountMenu"', dashboard_page)
        self.assertIn('id="userTimelineButton"', dashboard_page)
        self.assertIn('id="nearbyEnvironmentRadarButton"', dashboard_page)
        self.assertIn('/terms?return_to=scan', dashboard_page)
        self.assertIn('/privacy?return_to=scan', dashboard_page)
        self.assertIn('id="changePasswordMenuItem"', dashboard_page)
        self.assertIn('id="changePasswordModal"', dashboard_page)
        self.assertNotIn('id="accountPrivacyControls"', dashboard_page)
        self.assertIn('id="scanFeedbackControl"', dashboard_page)
        self.assertIn('id="scanFeedbackButton"', dashboard_page)

        landing_page = self.client.get('/').get_data(as_text=True)
        self.assertNotIn('id="feedbackModal"', landing_page)
        self.assertNotIn('toggleFeedbackModal()', landing_page)

        privacy_page = self.client.get('/privacy?return_to=scan').get_data(as_text=True)
        terms_page = self.client.get('/terms?return_to=scan').get_data(as_text=True)
        self.assertIn('← กลับหน้าแสกน', privacy_page)
        self.assertIn('← กลับหน้าแสกน', terms_page)
        self.assertIn('href="/dashboard"', privacy_page)
        self.assertIn('href="/dashboard"', terms_page)

    def test_regular_user_can_change_password_from_the_scan_account_menu(self):
        user_id = self.create_user()
        self.sign_in_session(user_id)
        token = self.csrf_token()

        response = self.client.post(
            '/account/change-password',
            data={
                'csrf_token': token,
                'current_password': 'Password12345',
                'new_password': 'UpdatedPassword123',
                'new_password_confirmation': 'UpdatedPassword123',
            },
            follow_redirects=True,
        )
        self.assertIn('เปลี่ยนรหัสผ่านเรียบร้อยแล้ว', response.get_data(as_text=True))
        conn = application.get_db_connection()
        stored_password = conn.execute('SELECT password FROM users WHERE id = ?', (user_id,)).fetchone()[0]
        audit_action = conn.execute(
            "SELECT action FROM audit_logs WHERE action = 'password_changed' AND actor_user_id = ?",
            (user_id,),
        ).fetchone()
        conn.close()
        self.assertTrue(application.check_password_hash(stored_password, 'UpdatedPassword123'))
        self.assertFalse(application.check_password_hash(stored_password, 'Password12345'))
        self.assertEqual(audit_action[0], 'password_changed')

        response = self.client.post(
            '/account/change-password',
            data={
                'csrf_token': token,
                'current_password': 'wrong-password',
                'new_password': 'AnotherPassword123',
                'new_password_confirmation': 'AnotherPassword123',
            },
            follow_redirects=True,
        )
        self.assertIn('รหัสผ่านปัจจุบันไม่ถูกต้อง', response.get_data(as_text=True))

    def test_regular_user_can_manage_a_private_reencoded_profile_avatar(self):
        user_id = self.create_user()
        self.sign_in_session(user_id)
        token = self.csrf_token()
        exif = Image.Exif()
        exif[270] = 'Private profile-image metadata'

        response = self.client.post(
            '/account/profile-avatar',
            data={
                'csrf_token': token,
                'profile_avatar': (self.skin_lesion_image_buffer('JPEG', exif=exif), 'selfie.png'),
            },
            content_type='multipart/form-data',
        )
        self.assertEqual(response.status_code, 302)
        self.assertTrue(response.headers['Location'].endswith('/dashboard'))

        conn = application.get_db_connection()
        avatar = conn.execute(
            'SELECT image_path, created_at, updated_at FROM profile_avatars WHERE user_id = ?', (user_id,)
        ).fetchone()
        conn.close()
        self.assertIsNotNone(avatar)
        self.assertRegex(avatar[0], r'^profile_[0-9a-f]{32}\.jpg$')
        self.assertTrue(avatar[1])
        self.assertTrue(avatar[2])
        stored_avatar = self.upload_path / avatar[0]
        self.assertTrue(stored_avatar.is_file())
        with Image.open(stored_avatar) as normalized_avatar:
            self.assertEqual(normalized_avatar.format, 'JPEG')
            self.assertEqual(normalized_avatar.size, (256, 256))
            self.assertNotIn(270, normalized_avatar.getexif())

        dashboard_page = self.client.get('/dashboard').get_data(as_text=True)
        self.assertIn('id="profileAvatarMenuItem"', dashboard_page)
        self.assertIn('id="userProfileAvatarImage"', dashboard_page)
        self.assertIn('id="profileAvatarModal"', dashboard_page)
        self.assertIn('/account/profile-avatar?v=', dashboard_page)

        response = self.client.get('/account/profile-avatar')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.mimetype, 'image/jpeg')
        self.assertIn('no-store', response.headers['Cache-Control'])
        response.close()

        # A different regular user has no way to name or retrieve this image.
        other_user_id = self.create_user('other-member@example.com')
        self.sign_in_session(other_user_id, email='other-member@example.com')
        self.assertEqual(self.client.get('/account/profile-avatar').status_code, 404)
        self.assertEqual(self.client.get(f'/account/profile-avatar/{avatar[0]}').status_code, 404)

        # Administrators do not receive a privileged avatar-view route either.
        admin_id = self.create_admin('avatar-admin@example.com')
        self.sign_in_session(admin_id, email='avatar-admin@example.com', role='admin', name='Administrator')
        self.assertEqual(self.client.get('/account/profile-avatar').status_code, 403)

        # The owner may replace and remove their avatar; no stale private files remain.
        self.sign_in_session(user_id)
        response = self.client.post(
            '/account/profile-avatar',
            data={
                'csrf_token': token,
                'profile_avatar': (self.skin_lesion_image_buffer('PNG'), 'replacement.webp'),
            },
            content_type='multipart/form-data',
        )
        self.assertEqual(response.status_code, 302)
        conn = application.get_db_connection()
        replacement = conn.execute(
            'SELECT image_path FROM profile_avatars WHERE user_id = ?', (user_id,)
        ).fetchone()[0]
        conn.close()
        self.assertNotEqual(replacement, avatar[0])
        self.assertFalse(stored_avatar.exists())
        self.assertTrue((self.upload_path / replacement).is_file())

        response = self.client.post(
            '/account/profile-avatar/remove',
            data={'csrf_token': token},
        )
        self.assertEqual(response.status_code, 302)
        conn = application.get_db_connection()
        self.assertIsNone(conn.execute('SELECT image_path FROM profile_avatars WHERE user_id = ?', (user_id,)).fetchone())
        conn.close()
        self.assertFalse((self.upload_path / replacement).exists())

    def test_profile_avatar_rejects_non_images_without_creating_a_record(self):
        user_id = self.create_user()
        self.sign_in_session(user_id)
        token = self.csrf_token()
        response = self.client.post(
            '/account/profile-avatar',
            data={
                'csrf_token': token,
                'profile_avatar': (io.BytesIO(b'<svg><script>alert(1)</script></svg>'), 'profile.png'),
            },
            content_type='multipart/form-data',
            follow_redirects=True,
        )
        self.assertIn('ไม่ใช่รูปภาพ JPEG, PNG หรือ WEBP', response.get_data(as_text=True))
        conn = application.get_db_connection()
        self.assertIsNone(conn.execute('SELECT image_path FROM profile_avatars WHERE user_id = ?', (user_id,)).fetchone())
        conn.close()
        self.assertEqual(list(self.upload_path.iterdir()), [])

    def test_profile_avatar_replacement_queues_a_locked_old_file_for_retry(self):
        user_id = self.create_user()
        self.sign_in_session(user_id)
        token = self.csrf_token()
        first_response = self.client.post(
            '/account/profile-avatar',
            data={
                'csrf_token': token,
                'profile_avatar': (self.skin_lesion_image_buffer('PNG'), 'first.png'),
            },
            content_type='multipart/form-data',
        )
        self.assertEqual(first_response.status_code, 302)
        conn = application.get_db_connection()
        first_filename = conn.execute(
            'SELECT image_path FROM profile_avatars WHERE user_id = ?', (user_id,)
        ).fetchone()[0]
        conn.close()

        # Simulate the short Windows file lock that can occur while an old
        # avatar response is still being streamed to a browser.
        with patch.object(application.Path, 'unlink', side_effect=PermissionError('file is in use')):
            replacement_response = self.client.post(
                '/account/profile-avatar',
                data={
                    'csrf_token': token,
                    'profile_avatar': (self.skin_lesion_image_buffer('JPEG'), 'second.jpg'),
                },
                content_type='multipart/form-data',
            )
        self.assertEqual(replacement_response.status_code, 302)
        conn = application.get_db_connection()
        queued = conn.execute(
            'SELECT image_path FROM profile_avatar_deletion_queue'
        ).fetchall()
        replacement_filename = conn.execute(
            'SELECT image_path FROM profile_avatars WHERE user_id = ?', (user_id,)
        ).fetchone()[0]
        conn.close()
        self.assertEqual(queued, [(first_filename,)])
        self.assertNotEqual(replacement_filename, first_filename)
        self.assertTrue((self.upload_path / first_filename).is_file())

        self.assertEqual(application.retry_queued_profile_avatar_deletions(), 1)
        self.assertFalse((self.upload_path / first_filename).exists())

    def test_registration_enforces_server_side_validation(self):
        token = self.csrf_token()
        response = self.client.post(
            '/register',
            data={'csrf_token': token, 'name': 'Member', 'email': 'member@example.com', 'password': 'short'},
            follow_redirects=True,
        )
        self.assertIn('อย่างน้อย 12 ตัวอักษร', response.get_data(as_text=True))
        conn = application.get_db_connection()
        self.assertEqual(conn.execute('SELECT COUNT(*) FROM users').fetchone()[0], 0)
        conn.close()

    def test_registration_requires_explicit_terms_acceptance(self):
        token = self.csrf_token()
        response = self.client.post(
            '/register',
            data={
                'csrf_token': token,
                'name': 'New Member',
                'email': 'new-member@example.com',
                'password': 'Password12345',
            },
            follow_redirects=True,
        )
        self.assertIn('ยอมรับข้อกำหนดการใช้งาน', response.get_data(as_text=True))
        conn = application.get_db_connection()
        self.assertEqual(conn.execute('SELECT COUNT(*) FROM users').fetchone()[0], 0)
        conn.close()

    def test_regular_user_can_permanently_delete_own_account(self):
        user_id = self.create_user()
        image_path = self.upload_path / 'owned-image.png'
        gradcam_path = self.upload_path / 'owned-gradcam.png'
        profile_avatar_path = self.upload_path / ('profile_' + ('a' * 32) + '.jpg')
        image_path.write_bytes(b'private image')
        gradcam_path.write_bytes(b'private overlay')
        profile_avatar_path.write_bytes(b'private profile image')
        conn = application.get_db_connection()
        conn.execute(
            """INSERT INTO scan_logs
               (user_id, image_path, gradcam_path, result_disease, confidence, created_at)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (user_id, image_path.name, gradcam_path.name, 'Melanoma', '80.00%', '2026-09-02T00:00:00+07:00'),
        )
        conn.execute(
            "INSERT INTO feedbacks (user_email, user_name, message) VALUES (?, ?, ?)",
            ('member@example.com', 'Member', 'ลบข้อมูลของฉัน'),
        )
        conn.execute(
            "INSERT INTO profile_avatars (user_id, image_path, created_at, updated_at) VALUES (?, ?, ?, ?)",
            (user_id, profile_avatar_path.name, '2026-09-02T00:00:00+07:00', '2026-09-02T00:00:00+07:00'),
        )
        conn.commit()
        conn.close()
        self.sign_in_session(user_id)
        token = self.csrf_token()

        response = self.client.post(
            '/account/delete',
            data={'csrf_token': token, 'delete_account_confirmation': 'DELETE'},
        )
        self.assertEqual(response.status_code, 302)
        self.assertTrue(response.headers['Location'].endswith('/'))
        self.assertFalse(image_path.exists())
        self.assertFalse(gradcam_path.exists())
        self.assertFalse(profile_avatar_path.exists())
        conn = application.get_db_connection()
        self.assertEqual(conn.execute('SELECT COUNT(*) FROM users WHERE id = ?', (user_id,)).fetchone()[0], 0)
        self.assertEqual(conn.execute('SELECT COUNT(*) FROM scan_logs WHERE user_id = ?', (user_id,)).fetchone()[0], 0)
        self.assertEqual(conn.execute('SELECT COUNT(*) FROM profile_avatars WHERE user_id = ?', (user_id,)).fetchone()[0], 0)
        self.assertEqual(conn.execute('SELECT COUNT(*) FROM feedbacks').fetchone()[0], 0)
        conn.close()

    def test_admin_must_confirm_before_deleting_a_user_account(self):
        user_id = self.create_user()
        conn = application.get_db_connection()
        cursor = conn.cursor()
        cursor.execute(
            "INSERT INTO users (name, email, password, role, is_approved) VALUES (?, ?, ?, 'admin', 1)",
            ('Administrator', 'admin-delete@example.com', generate_password_hash('Password12345')),
        )
        admin_id = cursor.lastrowid
        conn.commit()
        conn.close()
        self.sign_in_session(admin_id, email='admin-delete@example.com', role='admin', name='Administrator')
        token = self.csrf_token()

        response = self.client.get('/admin_dashboard')
        page = response.get_data(as_text=True)
        self.assertIn('id="adminUserDeletionModal"', page)
        self.assertIn('openAdminUserDeletionModal(this)', page)
        self.assertIn('ยืนยันการลบ', page)
        self.assertIn('ยกเลิก', page)

        response = self.client.post(f'/delete_user/{user_id}', data={'csrf_token': token})
        self.assertEqual(response.status_code, 302)
        conn = application.get_db_connection()
        self.assertEqual(conn.execute('SELECT COUNT(*) FROM users WHERE id = ?', (user_id,)).fetchone()[0], 1)
        conn.close()

        response = self.client.post(
            f'/delete_user/{user_id}',
            data={'csrf_token': token, 'admin_delete_confirmation': 'DELETE'},
        )
        self.assertEqual(response.status_code, 302)
        conn = application.get_db_connection()
        self.assertEqual(conn.execute('SELECT COUNT(*) FROM users WHERE id = ?', (user_id,)).fetchone()[0], 0)
        audit_log = conn.execute(
            "SELECT action, actor_user_id, target_id FROM audit_logs WHERE action = 'user_deleted'"
        ).fetchone()
        self.assertEqual((audit_log[0], audit_log[1], audit_log[2]), ('user_deleted', admin_id, str(user_id)))
        conn.close()

    def test_password_reset_is_single_use_and_revokes_existing_sessions(self):
        user_id = self.create_user()
        with patch.object(application, 'PASSWORD_RESET_EMAIL_CONFIGURED', True), patch.object(
            application, 'configured_public_base_url', 'https://skin.example.test'
        ), patch.object(application, 'send_account_email', return_value=True) as send_email:
            with application.app.test_request_context('/password/forgot'):
                self.assertTrue(application.issue_password_reset_email(user_id))

        reset_email_body = send_email.call_args.args[2]
        reset_link = reset_email_body.split('ตั้งรหัสผ่านใหม่ได้ที่: ', 1)[1].split('\n', 1)[0]
        self.assertIn('/password/reset#', reset_link)
        self.assertNotIn('?', reset_link)
        token = reset_link.rsplit('#', 1)[1]
        self.assertIsNotNone(application.resolve_password_reset_token(token))
        token_csrf = self.csrf_token()
        handoff = self.client.post(
            '/password/reset/claim',
            json={'token': token},
            headers={'X-CSRF-Token': token_csrf},
        )
        self.assertEqual(handoff.status_code, 200)
        self.assertEqual(handoff.get_json(), {'redirect_url': '/password/reset'})
        with self.client.session_transaction() as session:
            final_handoff_csrf = session['csrf_token']
        response = self.client.post(
            '/password/reset',
            data={
                'csrf_token': final_handoff_csrf,
                'new_password': 'FreshPassword123',
                'new_password_confirmation': 'FreshPassword123',
            },
        )
        self.assertEqual(response.status_code, 302)
        self.assertTrue(response.headers['Location'].endswith('/'))
        self.assertIsNone(application.resolve_password_reset_token(token))

        conn = application.get_db_connection()
        user = conn.execute('SELECT password, auth_epoch FROM users WHERE id = ?', (user_id,)).fetchone()
        audit_actions = [row[0] for row in conn.execute('SELECT action FROM audit_logs WHERE target_id = ?', (str(user_id),))]
        conn.close()
        self.assertTrue(application.check_password_hash(user[0], 'FreshPassword123'))
        self.assertEqual(user[1], 1)
        self.assertIn('password_reset_completed', audit_actions)

        self.sign_in_session(user_id, auth_epoch=0)
        response = self.client.get('/dashboard')
        self.assertEqual(response.status_code, 302)
        self.assertTrue(response.headers['Location'].endswith('/'))

    def test_email_verification_requires_a_single_use_confirmation(self):
        user_id = self.create_user(email='unverified@example.com')
        conn = application.get_db_connection()
        conn.execute('UPDATE users SET email_verified_at = NULL WHERE id = ?', (user_id,))
        conn.commit()
        conn.close()

        with patch.object(application, 'PASSWORD_RESET_EMAIL_CONFIGURED', True), patch.object(
            application, 'configured_public_base_url', 'https://skin.example.test'
        ), patch.object(application, 'send_account_email', return_value=True) as send_email:
            with application.app.test_request_context('/email/verification/resend'):
                self.assertTrue(application.issue_email_verification_email(user_id))

        verification_email_body = send_email.call_args.args[2]
        verification_link = verification_email_body.split('ยืนยันอีเมลได้ที่: ', 1)[1].split('\n', 1)[0]
        self.assertIn('/email/verify#', verification_link)
        self.assertNotIn('?', verification_link)
        token = verification_link.rsplit('#', 1)[1]
        self.sign_in_session(user_id, email='unverified@example.com')
        response = self.client.get('/dashboard')
        self.assertEqual(response.status_code, 302)
        self.assertTrue(response.headers['Location'].endswith('/'))

        verification_csrf = self.csrf_token()
        handoff = self.client.post(
            '/email/verify/claim',
            json={'token': token},
            headers={'X-CSRF-Token': verification_csrf},
        )
        self.assertEqual(handoff.status_code, 200)
        self.assertEqual(handoff.get_json(), {'redirect_url': '/email/verify'})
        with self.client.session_transaction() as session:
            final_handoff_csrf = session['csrf_token']
        response = self.client.post('/email/verify', data={'csrf_token': final_handoff_csrf})
        self.assertEqual(response.status_code, 302)
        self.assertTrue(response.headers['Location'].endswith('/'))
        self.assertIsNone(application.resolve_email_verification_token(token))
        conn = application.get_db_connection()
        verified_at = conn.execute('SELECT email_verified_at FROM users WHERE id = ?', (user_id,)).fetchone()[0]
        conn.close()
        self.assertIsNotNone(verified_at)

    def test_login_clears_prelogin_session_and_revoked_user_loses_access(self):
        user_id = self.create_user()
        token = self.csrf_token()
        with self.client.session_transaction() as session:
            session['untrusted_prelogin_value'] = 'remove-me'

        response = self.client.post(
            '/login',
            data={'csrf_token': token, 'email': 'member@example.com', 'password': 'Password12345'},
        )
        self.assertEqual(response.status_code, 302)
        self.assertTrue(response.headers['Location'].endswith('/dashboard'))
        with self.client.session_transaction() as session:
            self.assertEqual(session['user_id'], user_id)
            self.assertNotIn('untrusted_prelogin_value', session)

        conn = application.get_db_connection()
        conn.execute('UPDATE users SET is_approved = 0 WHERE id = ?', (user_id,))
        conn.commit()
        conn.close()
        response = self.client.get('/dashboard')
        self.assertEqual(response.status_code, 302)
        self.assertTrue(response.headers['Location'].endswith('/'))

    def test_login_is_rate_limited_after_five_failed_attempts(self):
        self.create_user()
        token = self.csrf_token()
        for _ in range(application.LOGIN_RATE_LIMIT):
            response = self.client.post(
                '/login',
                data={'csrf_token': token, 'email': 'member@example.com', 'password': 'wrong-password'},
            )
            self.assertEqual(response.status_code, 302)

        response = self.client.post(
            '/login',
            data={'csrf_token': token, 'email': 'member@example.com', 'password': 'Password12345'},
            follow_redirects=True,
        )
        self.assertIn('พยายามเข้าสู่ระบบมากเกินไป', response.get_data(as_text=True))

    def test_scan_reencodes_image_and_uses_private_minimal_log(self):
        user_id = self.create_user()
        self.sign_in_session(user_id)
        token = self.csrf_token()

        image_buffer = self.skin_lesion_image_buffer()
        response = self.client.post(
            '/dashboard',
            data={
                'csrf_token': token,
                'scan_consent': 'on',
                'lesion_image_confirmation': 'on',
                'file': (image_buffer, 'mismatched-extension.jpg'),
            },
            content_type='multipart/form-data',
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers['Cache-Control'], 'no-store, max-age=0')

        conn = application.get_db_connection()
        scan = conn.execute(
            'SELECT image_path, user_name, user_email, consented_at, consent_version, retention_expires_at, top_predictions, is_uncertain, decision_status, model_version FROM scan_logs WHERE user_id = ?',
            (user_id,),
        ).fetchone()
        conn.close()
        self.assertIsNotNone(scan)
        self.assertTrue(scan[0].endswith('.png'))
        self.assertIsNone(scan[1])
        self.assertIsNone(scan[2])
        self.assertTrue(scan[3])
        self.assertEqual(scan[4], application.PRIVACY_NOTICE_VERSION)
        self.assertTrue(scan[5])
        self.assertEqual(
            json.loads(scan[6])[0]['label'],
            application.display_name_for_label('Basal cell carcinoma'),
        )
        self.assertEqual(scan[7], 0)
        self.assertEqual(scan[8], 'supported')
        self.assertEqual(scan[9], 'legacy-6-class')
        self.assertTrue((Path(application.app.config['UPLOAD_FOLDER']) / scan[0]).is_file())

    def test_flat_or_unusable_images_are_rejected_before_model_scoring(self):
        application.model = NeverCalledModel()
        user_id = self.create_user()
        self.sign_in_session(user_id)
        token = self.csrf_token()
        image_buffer = io.BytesIO()
        Image.new('RGB', (160, 160), color=(100, 100, 100)).save(image_buffer, format='PNG')
        image_buffer.seek(0)

        response = self.client.post(
            '/dashboard',
            data={
                'csrf_token': token,
                'scan_consent': 'on',
                'lesion_image_confirmation': 'on',
                'file': (image_buffer, 'flat-image.png'),
            },
            content_type='multipart/form-data',
        )
        self.assertEqual(response.status_code, 302)
        self.assertEqual(list(self.upload_path.iterdir()), [])
        conn = application.get_db_connection()
        self.assertEqual(conn.execute('SELECT COUNT(*) FROM scan_logs WHERE user_id = ?', (user_id,)).fetchone()[0], 0)
        conn.close()

    def test_gradcam_overlay_is_rendered_as_a_private_png(self):
        source_path = self.upload_path / 'lesion-source.png'
        source_path.write_bytes(self.skin_lesion_image_buffer().getvalue())
        inputs = tf.keras.Input(shape=(224, 224, 3))
        features = tf.keras.layers.Conv2D(
            2, 3, activation='relu', use_bias=False, kernel_initializer='ones', name='attention_conv',
        )(inputs)
        pooled = tf.keras.layers.GlobalAveragePooling2D()(features)
        classifier = tf.keras.layers.Dense(6, activation='softmax', name='classifier')
        outputs = classifier(pooled)
        explanation_model = tf.keras.Model(inputs, outputs)
        classifier.set_weights([
            np.array([[0.010, 0.000, -0.004, 0.002, 0.001, -0.002], [0.003, 0.007, -0.001, 0.000, 0.002, -0.003]], dtype='float32'),
            np.zeros(6, dtype='float32'),
        ])
        output_path = self.upload_path / 'lesion-gradcam.png'

        explanation = application.generate_gradcam_overlay(source_path, explanation_model, 0, output_path)

        self.assertIsNotNone(explanation)
        self.assertEqual(explanation['layer_name'], 'attention_conv')
        self.assertTrue(output_path.is_file())
        with Image.open(output_path) as rendered:
            self.assertEqual(rendered.format, 'PNG')
            self.assertLessEqual(max(rendered.size), 1280)

    def test_packaged_model_can_render_gradcam_for_its_top_output(self):
        self.assertIsNotNone(self.previous_model)
        source_path = self.upload_path / 'packaged-model-source.png'
        source_path.write_bytes(self.skin_lesion_image_buffer().getvalue())
        prediction = application.predict_image_scores(
            source_path,
            self.previous_model,
            class_names=application.MODEL_CLASS_NAMES,
        )
        output_path = self.upload_path / 'packaged-model-gradcam.png'

        explanation = application.generate_gradcam_overlay(
            source_path,
            self.previous_model,
            prediction['class_index'],
            output_path,
        )

        self.assertIsNotNone(explanation)
        self.assertTrue(output_path.is_file())

    def test_scan_displays_a_private_gradcam_when_the_model_supports_explanations(self):
        inputs = tf.keras.Input(shape=(224, 224, 3))
        features = tf.keras.layers.Conv2D(
            2, 3, activation='relu', use_bias=False, kernel_initializer='ones', name='scan_attention_conv',
        )(inputs)
        pooled = tf.keras.layers.GlobalAveragePooling2D()(features)
        classifier = tf.keras.layers.Dense(6, activation='softmax', name='scan_classifier')
        explanation_model = tf.keras.Model(inputs, classifier(pooled))
        classifier.set_weights([
            np.array([[0.010, 0.000, -0.004, 0.002, 0.001, -0.002], [0.003, 0.007, -0.001, 0.000, 0.002, -0.003]], dtype='float32'),
            np.array([0.0, 2.0, 0.0, 0.0, 0.0, 0.0], dtype='float32'),
        ])
        application.model = explanation_model
        user_id = self.create_user()
        self.sign_in_session(user_id)
        token = self.csrf_token()

        response = self.client.post(
            '/dashboard',
            data={
                'csrf_token': token,
                'scan_consent': 'on',
                'lesion_image_confirmation': 'on',
                'file': (self.skin_lesion_image_buffer(), 'supported-lesion.png'),
            },
            content_type='multipart/form-data',
        )

        self.assertEqual(response.status_code, 200)
        self.assertIn('id="gradcamExplanation"', response.get_data(as_text=True))
        conn = application.get_db_connection()
        gradcam_path = conn.execute('SELECT gradcam_path FROM scan_logs WHERE user_id = ?', (user_id,)).fetchone()[0]
        conn.close()
        self.assertTrue(gradcam_path)
        self.assertTrue((self.upload_path / gradcam_path).is_file())
        response = self.client.get(f'/scan-images/{gradcam_path}')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.mimetype, 'image/png')

    def test_expired_scan_data_is_purged_with_its_private_image(self):
        user_id = self.create_user()
        expired_filename = 'expired-private-image.png'
        expired_gradcam_filename = 'expired-private-gradcam.png'
        (self.upload_path / expired_filename).write_bytes(b'not-a-real-image')
        (self.upload_path / expired_gradcam_filename).write_bytes(b'not-a-real-image')
        conn = application.get_db_connection()
        conn.execute(
            """INSERT INTO scan_logs
            (user_id, image_path, gradcam_path, result_disease, confidence, created_at, retention_expires_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (user_id, expired_filename, expired_gradcam_filename, 'ผลคัดกรองยังไม่ชัดเจน', '0.00%', '2026-01-01T00:00:00+00:00', '2026-01-02T00:00:00+00:00'),
        )
        conn.commit()
        conn.close()

        self.assertEqual(application.purge_expired_scan_data(), 1)
        conn = application.get_db_connection()
        self.assertEqual(conn.execute('SELECT COUNT(*) FROM scan_logs WHERE user_id = ?', (user_id,)).fetchone()[0], 0)
        self.assertEqual(conn.execute("SELECT COUNT(*) FROM audit_logs WHERE action = 'retention_purge'").fetchone()[0], 1)
        conn.close()
        self.assertFalse((self.upload_path / expired_filename).exists())
        self.assertFalse((self.upload_path / expired_gradcam_filename).exists())

    def test_expired_feedback_is_purged(self):
        user_id = self.create_user()
        conn = application.get_db_connection()
        conn.execute(
            """INSERT INTO feedbacks
               (user_id, user_email, user_name, message, retention_expires_at)
               VALUES (?, ?, ?, ?, ?)""",
            (user_id, 'member@example.com', 'Member', 'feedback ที่หมดอายุ', '2026-01-02T00:00:00+00:00'),
        )
        conn.commit()
        conn.close()

        self.assertEqual(application.purge_expired_scan_data(), 1)
        conn = application.get_db_connection()
        self.assertEqual(conn.execute('SELECT COUNT(*) FROM feedbacks').fetchone()[0], 0)
        self.assertEqual(
            conn.execute("SELECT COUNT(*) FROM audit_logs WHERE action = 'retention_purge' AND target_type = 'feedback_batch'").fetchone()[0],
            1,
        )
        conn.close()

    def test_regular_user_can_consent_to_a_coarse_nearby_context_and_delete_it(self):
        user_id = self.create_user()
        self.sign_in_session(user_id)
        token = self.csrf_token()
        response = self.client.post(
            '/nearby-context',
            json={
                'consent': True,
                'latitude': 6.541234,
                'longitude': 101.282345,
                'pm25': 42.5,
                'uv_index': 7.0,
                'relative_humidity': 75.0,
                'temperature_c': 33.5,
            },
            headers={'X-CSRF-Token': token},
        )
        self.assertEqual(response.status_code, 201)
        payload = response.get_json()
        self.assertEqual(payload['latitude_approx'], 6.54)
        self.assertEqual(payload['longitude_approx'], 101.28)
        self.assertEqual(payload['context_level'], 'ควรระวังมาก')
        self.assertIn('updated_at', payload)

        conn = application.get_db_connection()
        stored = conn.execute(
            'SELECT latitude_approx, longitude_approx, context_level FROM nearby_context_reports WHERE user_id = ?',
            (user_id,),
        ).fetchone()
        conn.close()
        self.assertEqual(stored, (6.54, 101.28, 'ควรระวังมาก'))

        # A newer opt-in replaces the old coarse location instead of retaining history.
        response = self.client.post(
            '/nearby-context',
            json={
                'consent': True,
                'latitude': 6.553456,
                'longitude': 101.296789,
                'pm25': 20.0,
                'uv_index': 2.0,
                'relative_humidity': 60.0,
                'temperature_c': 30.0,
            },
            headers={'X-CSRF-Token': token},
        )
        self.assertEqual(response.status_code, 201)
        conn = application.get_db_connection()
        stored_rows = conn.execute(
            'SELECT latitude_approx, longitude_approx FROM nearby_context_reports WHERE user_id = ?',
            (user_id,),
        ).fetchall()
        conn.close()
        self.assertEqual(stored_rows, [(6.55, 101.3)])

        response = self.client.post('/nearby-context/delete', data={'csrf_token': token}, follow_redirects=True)
        self.assertIn('ลบตำแหน่งโดยประมาณ', response.get_data(as_text=True))
        conn = application.get_db_connection()
        self.assertEqual(conn.execute('SELECT COUNT(*) FROM nearby_context_reports WHERE user_id = ?', (user_id,)).fetchone()[0], 0)
        conn.close()

    def test_expired_nearby_context_is_purged(self):
        user_id = self.create_user()
        conn = application.get_db_connection()
        conn.execute(
            """INSERT INTO nearby_context_reports
               (user_id, latitude_approx, longitude_approx, pm25, uv_index, relative_humidity,
                temperature_c, context_level, context_summary, consented_at, consent_version,
                retention_expires_at, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                user_id, 6.54, 101.28, 10.0, 2.0, 55.0, 30.0, 'ข้อมูลทั่วไป',
                'test', '2026-01-01T00:00:00+00:00', application.PRIVACY_NOTICE_VERSION,
                '2026-01-02T00:00:00+00:00', '2026-01-01T00:00:00+00:00',
            ),
        )
        conn.commit()
        conn.close()

        self.assertEqual(application.purge_expired_scan_data(), 1)
        conn = application.get_db_connection()
        self.assertEqual(conn.execute('SELECT COUNT(*) FROM nearby_context_reports WHERE user_id = ?', (user_id,)).fetchone()[0], 0)
        self.assertEqual(conn.execute("SELECT COUNT(*) FROM audit_logs WHERE action = 'retention_purge' AND target_type = 'nearby_context_batch'").fetchone()[0], 1)
        conn.close()

    def test_nearby_environment_radar_uses_the_same_opt_in_context_in_user_and_admin_views(self):
        user_id = self.create_user()
        self.sign_in_session(user_id)
        response = self.client.get('/dashboard')
        user_page = response.get_data(as_text=True)
        self.assertIn('id="nearbyEnvironmentRadarButton"', user_page)
        self.assertIn('Nearby Environment Radar', user_page)
        self.assertNotIn('ไฟล์โมเดลปัจจุบันมี output', user_page)

        conn = application.get_db_connection()
        conn.execute(
            """INSERT INTO nearby_context_reports
               (user_id, latitude_approx, longitude_approx, pm25, uv_index, relative_humidity,
                temperature_c, context_level, context_summary, consented_at, consent_version,
                retention_expires_at, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                user_id, 6.54, 101.28, 42.5, 7.0, 75.0, 33.5, 'ควรระวังมาก',
                'บริบททดสอบจากผู้ใช้ที่ยินยอม', '2026-08-31T00:00:00+00:00', application.PRIVACY_NOTICE_VERSION,
                '2099-01-01T00:00:00+00:00', '2026-08-31T00:00:00+00:00',
            ),
        )
        cursor = conn.cursor()
        cursor.execute(
            "INSERT INTO users (name, email, password, role, is_approved) VALUES (?, ?, ?, 'admin', 1)",
            ('Administrator', 'radar-admin@example.com', generate_password_hash('Password12345')),
        )
        admin_id = cursor.lastrowid
        conn.commit()
        conn.close()

        self.sign_in_session(admin_id, 'radar-admin@example.com', role='admin', name='Administrator')
        response = self.client.get('/admin_dashboard')
        admin_page = response.get_data(as_text=True)
        self.assertIn('id="adminNearbyEnvironmentRadar"', admin_page)
        self.assertIn('Member', admin_page)
        self.assertIn('member@example.com', admin_page)
        self.assertIn('6.54, 101.28', admin_page)

    def test_security_headers_include_a_nonce_bound_content_security_policy(self):
        response = self.client.get('/')
        policy = response.headers['Content-Security-Policy']
        self.assertIn("default-src 'self'", policy)
        self.assertIn("frame-ancestors 'none'", policy)
        self.assertIn("script-src 'self' 'nonce-", policy)

    def test_regular_user_keeps_the_original_timeline_button_outside_demo_mode(self):
        user_id = self.create_user()
        self.sign_in_session(user_id)
        response = self.client.get('/dashboard')
        page = response.get_data(as_text=True)
        self.assertEqual(response.status_code, 200)
        self.assertIn('id="userTimelineButton"', page)
        self.assertIn('openTimelineModal()', page)

    def test_regular_user_can_send_feedback_from_the_scan_dashboard(self):
        user_id = self.create_user()
        self.sign_in_session(user_id)
        token = self.csrf_token()
        response = self.client.get('/dashboard')
        page = response.get_data(as_text=True)
        self.assertIn('id="scanFeedbackButton"', page)
        self.assertIn('id="feedbackModal"', page)
        self.assertIn('openFeedbackModal()', page)
        self.assertIn('ส่งความเห็นให้ทีมผู้ดูแลได้โดยตรงจากหน้าแสกนนี้', page)
        self.assertGreater(page.index('id="scanFeedbackButton"'), page.index('<main'))

        response = self.client.post(
            '/send_feedback',
            data={'csrf_token': token, 'message': 'ต้องการให้เพิ่มคำแนะนำก่อนถ่ายภาพ'},
            follow_redirects=True,
        )
        self.assertIn('ส่งข้อเสนอแนะเรียบร้อยแล้ว', response.get_data(as_text=True))
        conn = application.get_db_connection()
        feedback = conn.execute('SELECT user_email, topic, message FROM feedbacks').fetchone()
        conn.close()
        self.assertEqual(feedback, ('member@example.com', 'general', 'ต้องการให้เพิ่มคำแนะนำก่อนถ่ายภาพ'))

    def test_admin_dashboard_uses_a_computer_engineering_background(self):
        conn = application.get_db_connection()
        cursor = conn.cursor()
        cursor.execute(
            "INSERT INTO users (name, email, password, role, is_approved) VALUES (?, ?, ?, 'admin', 1)",
            ('Administrator', 'engineering-admin@example.com', generate_password_hash('Password12345')),
        )
        admin_id = cursor.lastrowid
        conn.commit()
        conn.close()

        self.sign_in_session(admin_id, 'engineering-admin@example.com', role='admin', name='Administrator')
        response = self.client.get('/admin_dashboard')
        page = response.get_data(as_text=True)
        self.assertEqual(response.status_code, 200)
        self.assertIn('enterprise-engineering-art', page)
        self.assertIn('assets/admin-computer-engineering-bg-v1.png', page)
        self.assertNotIn('Candidate Model 50', page)
        self.assertNotIn('start_admin_training', page)
        background = self.client.get('/static/assets/admin-computer-engineering-bg-v1.png')
        self.assertEqual(background.status_code, 200)
        self.assertEqual(background.mimetype, 'image/png')

    def test_scan_page_includes_a_non_diagnostic_medical_tech_background(self):
        user_id = self.create_user()
        self.sign_in_session(user_id)
        response = self.client.get('/dashboard')
        page = response.get_data(as_text=True)
        self.assertEqual(response.status_code, 200)
        self.assertIn('scan-medical-page', page)
        self.assertIn('scan-medical-backdrop', page)
        self.assertIn('scan-engineering-art', page)
        self.assertIn('id="scanHeroTitle"', page)
        self.assertIn('scan-workbench', page)
        self.assertIn('PHOTO GUIDE', page)
        self.assertIn('/static/%E0%B8%A3%E0%B8%B9%E0%B8%9B.png', page)
        self.assertIn('assets/scan-medical-engineering-bg-v2.png', page)
        self.assertIn('assets/scan-hero-medical-tech-v3.png', page)
        self.assertIn('ส่งภาพบริเวณผิวหนังที่ต้องการตรวจ', page)
        self.assertNotIn('เลือกหรือถ่ายภาพรอยโรคผิวหนัง', page)
        self.assertIn('id="imageSuitabilityGate"', page)
        self.assertIn('id="lesionImageConfirmation"', page)
        self.assertIn('ใบหน้า หนังศีรษะ หรือทุกตำแหน่งของร่างกาย', page)
        self.assertIn('ไม่ใช่ภาพกระเป๋า วัตถุ เอกสาร สัตว์', page)
        self.assertNotIn('ไม่ใช่ใบหน้า บุคคล วัตถุ เอกสาร', page)
        self.assertNotIn('medical-data-grid', page)
        self.assertNotIn('medical-cross-watermark', page)
        self.assertNotIn('CONSENTED IMAGE SCREENING', page)
        background = self.client.get('/static/assets/scan-medical-engineering-bg-v2.png')
        self.assertEqual(background.status_code, 200)
        self.assertEqual(background.mimetype, 'image/png')
        hero_background = self.client.get('/static/assets/scan-hero-medical-tech-v3.png')
        self.assertEqual(hero_background.status_code, 200)
        self.assertEqual(hero_background.mimetype, 'image/png')
        hero_image = self.client.get('/static/รูป.png')
        self.assertEqual(hero_image.status_code, 200)
        self.assertEqual(hero_image.mimetype, 'image/png')

    def test_unapproved_model_is_never_available_in_production_mode(self):
        previous_environment = application.IS_PRODUCTION
        previous_testing = application.app.config['TESTING']
        try:
            application.IS_PRODUCTION = True
            application.app.config['TESTING'] = False
            self.assertFalse(application.analysis_is_available())
        finally:
            application.IS_PRODUCTION = previous_environment
            application.app.config['TESTING'] = previous_testing

    def test_production_dashboard_shows_the_release_gate_instead_of_upload_form(self):
        user_id = self.create_user()
        self.sign_in_session(user_id)
        with self.client.session_transaction() as session:
            session['terms_version'] = application.TERMS_VERSION
        previous_environment = application.IS_PRODUCTION
        previous_testing = application.app.config['TESTING']
        try:
            application.IS_PRODUCTION = True
            application.app.config['TESTING'] = False
            response = self.client.get('/dashboard')
            page = response.get_data(as_text=True)
            self.assertEqual(response.status_code, 200)
            self.assertIn('บริการข้อมูลจากภาพยังไม่เปิดใช้กับข้อมูลสุขภาพ', page)
            self.assertNotIn('id="scanForm"', page)
        finally:
            application.IS_PRODUCTION = previous_environment
            application.app.config['TESTING'] = previous_testing

    def test_low_scope_images_are_rejected_without_a_scan_log(self):
        application.model = OutOfScopeStubModel()
        user_id = self.create_user()
        self.sign_in_session(user_id)
        token = self.csrf_token()
        image_buffer = self.skin_lesion_image_buffer()

        response = self.client.post(
            '/dashboard',
            data={
                'csrf_token': token,
                'scan_consent': 'on',
                'lesion_image_confirmation': 'on',
                'file': (image_buffer, 'close-call.png'),
            },
            content_type='multipart/form-data',
        )
        self.assertEqual(response.status_code, 302)
        conn = application.get_db_connection()
        scan_count = conn.execute('SELECT COUNT(*) FROM scan_logs WHERE user_id = ?', (user_id,)).fetchone()[0]
        conn.close()
        self.assertEqual(scan_count, 0)
        self.assertEqual(list(self.upload_path.iterdir()), [])

    def test_candidate_model_scores_are_not_stored_while_release_gate_is_closed(self):
        application.model = AmbiguousStubModel()
        user_id = self.create_user()
        self.sign_in_session(user_id)
        token = self.csrf_token()
        image_buffer = self.skin_lesion_image_buffer()

        response = self.client.post(
            '/dashboard',
            data={
                'csrf_token': token,
                'scan_consent': 'on',
                'lesion_image_confirmation': 'on',
                'file': (image_buffer, 'ambiguous.png'),
            },
            content_type='multipart/form-data',
        )
        # A candidate/legacy model cannot become an image service merely
        # because it returns close scores. The release gate keeps the upload
        # route closed and must leave no private record behind.
        self.assertEqual(response.status_code, 302)
        self.assertTrue(response.headers['Location'].endswith('/dashboard'))
        conn = application.get_db_connection()
        scan = conn.execute('SELECT is_uncertain, decision_status FROM scan_logs WHERE user_id = ?', (user_id,)).fetchone()
        conn.close()
        self.assertIsNone(scan)

    def test_scan_removes_embedded_image_metadata(self):
        user_id = self.create_user()
        self.sign_in_session(user_id)
        token = self.csrf_token()
        exif = Image.Exif()
        exif[270] = 'Private camera description'
        image_buffer = self.skin_lesion_image_buffer('JPEG', exif=exif)

        response = self.client.post(
            '/dashboard',
            data={
                'csrf_token': token,
                'scan_consent': 'on',
                'lesion_image_confirmation': 'on',
                'file': (image_buffer, 'camera.jpg'),
            },
            content_type='multipart/form-data',
        )
        self.assertEqual(response.status_code, 200)
        conn = application.get_db_connection()
        image_path = conn.execute('SELECT image_path FROM scan_logs WHERE user_id = ?', (user_id,)).fetchone()[0]
        conn.close()
        with Image.open(Path(application.app.config['UPLOAD_FOLDER']) / image_path) as stored_image:
            self.assertNotIn(270, stored_image.getexif())

    def test_admin_dashboard_uses_account_identity_for_minimal_scan_logs(self):
        member_id = self.create_user()
        conn = application.get_db_connection()
        cursor = conn.cursor()
        cursor.execute(
            "INSERT INTO users (name, email, password, role, is_approved) VALUES (?, ?, ?, 'admin', 1)",
            ('Administrator', 'admin@example.com', generate_password_hash('Password12345')),
        )
        admin_id = cursor.lastrowid
        cursor.execute(
            "INSERT INTO scan_logs (user_id, image_path, result_disease, confidence, created_at, consented_at) VALUES (?, ?, ?, ?, ?, ?)",
            (member_id, 'private-test.png', 'ผลจำแนกจากโมเดล: Benign keratosis', '70.00%', '2026-08-30T10:00:00+07:00', '2026-08-30T10:00:00+07:00'),
        )
        conn.commit()
        conn.close()

        self.sign_in_session(admin_id, 'admin@example.com', role='admin', name='Administrator')
        response = self.client.get('/admin_dashboard')
        page = response.get_data(as_text=True)
        self.assertEqual(response.status_code, 200)
        self.assertIn('Member', page)
        self.assertIn('ผลจำแนกจากโมเดล', page)
        self.assertIn('AI SCREENING LOGS', page)

    def test_admin_training_http_route_stays_closed_without_creating_a_job(self):
        conn = application.get_db_connection()
        cursor = conn.cursor()
        cursor.execute(
            "INSERT INTO users (name, email, password, role, is_approved) VALUES (?, ?, ?, 'admin', 1)",
            ('Administrator', 'training-admin@example.com', generate_password_hash('Password12345')),
        )
        admin_id = cursor.lastrowid
        conn.commit()
        conn.close()
        self.sign_in_session(admin_id, 'training-admin@example.com', role='admin', name='Administrator')
        token = self.csrf_token()

        response = self.client.post(
            '/admin/training/start',
            data={'csrf_token': token, 'epochs': '10'},
        )
        # Candidate training was intentionally removed from the web dashboard.
        # Training can only be prepared through the controlled back-office
        # workflow, so a posted browser form must not create a job.
        self.assertEqual(response.status_code, 302)
        self.assertTrue(response.headers['Location'].endswith('/admin_dashboard'))
        conn = application.get_db_connection()
        self.assertEqual(conn.execute('SELECT COUNT(*) FROM training_jobs').fetchone()[0], 0)
        conn.close()

    def test_admin_research_candidate_preflight_and_command_use_five_images_per_class(self):
        self.assertEqual(application.training_preflight()['minimum_images_per_class'], 5)
        command = application.training_command(
            'candidate-job',
            10,
            {'source': 'approved-archive', 'license': 'approved-data-use'},
        )
        minimum_index = command.index('--min-images')
        self.assertEqual(command[minimum_index + 1], '5')

    def test_admin_totp_enrollment_is_explicit_encrypted_and_required_at_login(self):
        admin_id = self.create_admin('mfa-enroll@example.com')
        self.sign_in_session(admin_id, 'mfa-enroll@example.com', role='admin', name='Administrator')
        csrf = self.csrf_token()

        response = self.client.post(
            '/admin/mfa/enroll',
            data={'csrf_token': csrf, 'current_password': 'wrong-password'},
            follow_redirects=True,
        )
        self.assertIn('รหัสผ่านปัจจุบันไม่ถูกต้อง', response.get_data(as_text=True))
        conn = application.get_db_connection()
        self.assertEqual(conn.execute('SELECT COUNT(*) FROM admin_mfa_credentials').fetchone()[0], 0)
        conn.close()

        response = self.client.post(
            '/admin/mfa/enroll',
            data={'csrf_token': csrf, 'current_password': 'Password12345'},
        )
        self.assertEqual(response.status_code, 302)
        self.assertTrue(response.headers['Location'].endswith('/admin/mfa/enroll/confirm'))
        with self.client.session_transaction() as session:
            enrollment_id = session['mfa_enrollment_id']

        conn = application.get_db_connection()
        ciphertext = conn.execute(
            'SELECT secret_ciphertext FROM admin_mfa_enrollments WHERE id = ?', (enrollment_id,)
        ).fetchone()[0]
        conn.close()
        secret = application.decrypt_admin_mfa_secret(ciphertext)
        self.assertIsNotNone(secret)
        self.assertNotEqual(ciphertext, secret)
        self.assertNotIn(secret, ciphertext)

        enrollment_counter = int(application.time.time() // application.TOTP_STEP_SECONDS)
        response = self.client.post(
            '/admin/mfa/enroll/confirm',
            data={
                'csrf_token': csrf,
                'totp_code': application.totp_code_for_secret(secret, enrollment_counter),
            },
        )
        self.assertEqual(response.status_code, 302)
        self.assertTrue(response.headers['Location'].endswith('/admin_dashboard'))
        conn = application.get_db_connection()
        credential = conn.execute(
            'SELECT secret_ciphertext, last_used_counter FROM admin_mfa_credentials WHERE user_id = ?', (admin_id,)
        ).fetchone()
        audit_actions = [row[0] for row in conn.execute('SELECT action FROM audit_logs WHERE target_id = ?', (str(admin_id),))]
        conn.close()
        self.assertIsNotNone(credential)
        self.assertNotEqual(credential[0], secret)
        self.assertEqual(credential[1], enrollment_counter)
        self.assertIn('admin_mfa_enabled', audit_actions)
        with self.client.session_transaction() as session:
            self.assertEqual(session['mfa_authenticated_auth_epoch'], 1)

        csrf = self.csrf_token()
        self.client.post('/logout', data={'csrf_token': csrf})
        csrf = self.csrf_token()
        response = self.client.post(
            '/login',
            data={'csrf_token': csrf, 'email': 'mfa-enroll@example.com', 'password': 'Password12345'},
        )
        self.assertEqual(response.status_code, 302)
        self.assertTrue(response.headers['Location'].endswith('/login/mfa'))
        mfa_page = self.client.get('/login/mfa')
        self.assertIn('ยืนยันตัวตนสองชั้น', mfa_page.get_data(as_text=True))
        with self.client.session_transaction() as session:
            mfa_csrf = session['csrf_token']
        # A fresh next-step code proves that the enrollment code cannot be replayed.
        login_counter = int(application.time.time() // application.TOTP_STEP_SECONDS) + 1
        response = self.client.post(
            '/login/mfa',
            data={'csrf_token': mfa_csrf, 'totp_code': application.totp_code_for_secret(secret, login_counter)},
        )
        self.assertEqual(response.status_code, 302)
        self.assertTrue(response.headers['Location'].endswith('/admin_dashboard'))

    def test_enrolled_admin_session_needs_mfa_binding_and_self_disable_needs_password_and_totp(self):
        admin_id = self.create_admin('mfa-disable@example.com')
        secret = self.enroll_admin_mfa_directly(admin_id)
        self.sign_in_session(admin_id, 'mfa-disable@example.com', role='admin', name='Administrator')

        response = self.client.get('/admin_dashboard')
        self.assertEqual(response.status_code, 302)
        self.assertTrue(response.headers['Location'].endswith('/'))

        self.sign_in_mfa_admin_session(admin_id, 'mfa-disable@example.com')
        csrf = self.csrf_token()
        current_counter = int(application.time.time() // application.TOTP_STEP_SECONDS)
        code = application.totp_code_for_secret(secret, current_counter)
        response = self.client.post(
            '/admin/mfa/disable',
            data={
                'csrf_token': csrf,
                'disable_mfa_confirmation': 'DISABLE',
                'current_password': 'wrong-password',
                'totp_code': code,
            },
            follow_redirects=True,
        )
        self.assertIn('ต้องใช้รหัสผ่านปัจจุบันและรหัส TOTP ใหม่ที่ถูกต้อง', response.get_data(as_text=True))
        conn = application.get_db_connection()
        self.assertEqual(conn.execute('SELECT COUNT(*) FROM admin_mfa_credentials WHERE user_id = ?', (admin_id,)).fetchone()[0], 1)
        conn.close()

        response = self.client.post(
            '/admin/mfa/disable',
            data={
                'csrf_token': csrf,
                'disable_mfa_confirmation': 'DISABLE',
                'current_password': 'Password12345',
                'totp_code': code,
            },
        )
        self.assertEqual(response.status_code, 302)
        conn = application.get_db_connection()
        self.assertEqual(conn.execute('SELECT COUNT(*) FROM admin_mfa_credentials WHERE user_id = ?', (admin_id,)).fetchone()[0], 0)
        self.assertEqual(conn.execute('SELECT auth_epoch FROM users WHERE id = ?', (admin_id,)).fetchone()[0], 1)
        self.assertEqual(
            conn.execute("SELECT COUNT(*) FROM audit_logs WHERE action = 'admin_mfa_disabled_self_service' AND actor_user_id = ?", (admin_id,)).fetchone()[0],
            1,
        )
        conn.close()

    def test_mfa_enrolled_admin_can_recover_another_admin_with_password_totp_and_audit(self):
        actor_id = self.create_admin('mfa-actor@example.com', 'Recovery Administrator')
        target_id = self.create_admin('mfa-target@example.com', 'Locked Administrator')
        actor_secret = self.enroll_admin_mfa_directly(actor_id)
        self.enroll_admin_mfa_directly(target_id)
        self.sign_in_mfa_admin_session(actor_id, 'mfa-actor@example.com', name='Recovery Administrator')
        csrf = self.csrf_token()
        counter = int(application.time.time() // application.TOTP_STEP_SECONDS)
        response = self.client.post(
            '/admin/mfa/recover',
            data={
                'csrf_token': csrf,
                'mfa_recovery_confirmation': 'RECOVER',
                'target_admin_email': 'mfa-target@example.com',
                'current_password': 'Password12345',
                'totp_code': application.totp_code_for_secret(actor_secret, counter),
            },
        )
        self.assertEqual(response.status_code, 302)
        conn = application.get_db_connection()
        self.assertEqual(conn.execute('SELECT COUNT(*) FROM admin_mfa_credentials WHERE user_id = ?', (target_id,)).fetchone()[0], 0)
        self.assertEqual(conn.execute('SELECT auth_epoch FROM users WHERE id = ?', (target_id,)).fetchone()[0], 1)
        audit = conn.execute(
            "SELECT actor_user_id, target_id FROM audit_logs WHERE action = 'admin_mfa_recovery_disabled'"
        ).fetchone()
        conn.close()
        self.assertEqual((audit[0], audit[1]), (actor_id, str(target_id)))


if __name__ == '__main__':
    unittest.main()
