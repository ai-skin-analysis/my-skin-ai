import { createHmac, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { neon } from '@neondatabase/serverless';

const scrypt = promisify(scryptCallback);
const SESSION_TTL_SECONDS = 8 * 60 * 60;
const MIN_PASSWORD_LENGTH = 12;
const MAX_NAME_LENGTH = 100;
const MAX_EMAIL_LENGTH = 254;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const RATE_WINDOWS = {
  register: { limit: 5, windowMs: 60 * 60 * 1000 },
  login: { limit: 10, windowMs: 15 * 60 * 1000 },
  admin_mfa: { limit: 10, windowMs: 15 * 60 * 1000 },
  admin_approval: { limit: 30, windowMs: 15 * 60 * 1000 },
  user_profile: { limit: 8, windowMs: 60 * 60 * 1000 },
  user_sensitive: { limit: 5, windowMs: 60 * 60 * 1000 },
  user_feedback: { limit: 10, windowMs: 60 * 60 * 1000 },
  user_nearby_context: { limit: 4, windowMs: 24 * 60 * 60 * 1000 },
  user_scan: { limit: 12, windowMs: 60 * 60 * 1000 },
};
// This bootstrap identifier is only used to retain the initial administrator
// account requested for this deployment. A deployment secret can replace it
// without changing code after the first admin is provisioned.
const bootstrapAdminEmail = (process.env.SMART_SKIN_ADMIN_EMAIL || 'admin@hucksmartskinai.com').trim().toLowerCase();

const requestBuckets = new Map();
let schemaPromise;
let dummyPasswordHashPromise;

export class PublicAccountError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

export function json(res, status, payload) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  return res.status(status).json(payload);
}

export function requirePost(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    json(res, 405, { ok: false, message: 'ไม่รองรับวิธีเรียกใช้นี้' });
    return false;
  }
  return true;
}

export function requireGet(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    json(res, 405, { ok: false, message: 'ไม่รองรับวิธีเรียกใช้นี้' });
    return false;
  }
  return true;
}

export function sameOriginRequest(req) {
  const origin = req.headers.origin;
  if (!origin || typeof origin !== 'string') return false;
  try {
    const requestOrigin = new URL(origin);
    const forwardedHost = req.headers['x-forwarded-host'];
    const host = (Array.isArray(forwardedHost) ? forwardedHost[0] : forwardedHost) || req.headers.host;
    return Boolean(host)
      && requestOrigin.host === host
      && requestOrigin.protocol === 'https:';
  } catch {
    return false;
  }
}

export function requireSameOrigin(req, res) {
  if (sameOriginRequest(req)) return true;
  json(res, 403, { ok: false, message: 'คำขอนี้ต้องมาจากหน้าเว็บไซต์เดียวกัน' });
  return false;
}

export function requestJson(req) {
  if (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) return req.body;
  if (typeof req.body === 'string') {
    try {
      const parsed = JSON.parse(req.body);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      throw new PublicAccountError('รูปแบบข้อมูลไม่ถูกต้อง');
    }
  }
  return {};
}

export function normalizeRegistration(body) {
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  const acceptedTerms = body.termsAccepted === true;

  if (!name || name.length > MAX_NAME_LENGTH || /[\u0000-\u001f\u007f]/.test(name)) {
    throw new PublicAccountError('กรุณาระบุชื่อให้ถูกต้อง');
  }
  if (!email || email.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(email)) {
    throw new PublicAccountError('กรุณาระบุอีเมลให้ถูกต้อง');
  }
  if (
    password.length < MIN_PASSWORD_LENGTH
    || !/\p{L}/u.test(password)
    || !/\d/.test(password)
  ) {
    throw new PublicAccountError('รหัสผ่านต้องมีอย่างน้อย 12 ตัวอักษร และมีทั้งตัวอักษรกับตัวเลข');
  }
  if (!acceptedTerms) {
    throw new PublicAccountError('กรุณายอมรับข้อกำหนดการใช้งานและประกาศความเป็นส่วนตัว');
  }
  return { name, email, password };
}

export function normalizeLogin(body) {
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  if (!email || email.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(email) || !password) {
    throw new PublicAccountError('กรุณากรอกอีเมลและรหัสผ่านให้ถูกต้อง');
  }
  return { email, password };
}

export function takeRateBudget(req, operation) {
  const policy = RATE_WINDOWS[operation];
  if (!policy) return { ok: true, retryAfter: 0 };
  const forwardedFor = req.headers['x-forwarded-for'];
  const client = (Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor || 'unknown')
    .split(',')[0]
    .trim();
  const key = `${operation}:${client}`;
  const now = Date.now();
  const current = requestBuckets.get(key);
  if (!current || now - current.startedAt >= policy.windowMs) {
    requestBuckets.set(key, { startedAt: now, count: 1 });
    return { ok: true, retryAfter: 0 };
  }
  if (current.count >= policy.limit) {
    return { ok: false, retryAfter: Math.max(1, Math.ceil((policy.windowMs - (now - current.startedAt)) / 1000)) };
  }
  current.count += 1;
  return { ok: true, retryAfter: 0 };
}

function sqlClient() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new PublicAccountError('ระบบบัญชีกำลังตั้งค่า กรุณาลองใหม่ภายหลัง', 503);
  }
  return neon(databaseUrl);
}

export async function database() {
  const sql = sqlClient();
  if (!schemaPromise) {
    schemaPromise = (async () => {
      await sql`CREATE TABLE IF NOT EXISTS smart_skin_users (
        id BIGSERIAL PRIMARY KEY,
        email VARCHAR(254) NOT NULL UNIQUE,
        display_name VARCHAR(100) NOT NULL,
        password_hash TEXT NOT NULL,
        role VARCHAR(16) NOT NULL DEFAULT 'user',
        approval_status VARCHAR(16) NOT NULL DEFAULT 'pending',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_login_at TIMESTAMPTZ
      )`;
      await sql`ALTER TABLE smart_skin_users
        ADD COLUMN IF NOT EXISTS role VARCHAR(16) NOT NULL DEFAULT 'user'`;
      await sql`ALTER TABLE smart_skin_users
        ADD COLUMN IF NOT EXISTS approval_status VARCHAR(16) NOT NULL DEFAULT 'pending'`;
      // The account must exist already: this statement never creates an
      // administrator or accepts a role supplied by the browser.
      await sql`UPDATE smart_skin_users SET role = 'admin'
        WHERE email = ${bootstrapAdminEmail} AND role = 'user'`;
      await sql`UPDATE smart_skin_users SET approval_status = 'approved'
        WHERE role = 'admin'`;
      await sql`CREATE INDEX IF NOT EXISTS smart_skin_users_created_at_idx
        ON smart_skin_users (created_at DESC)`;
      await sql`CREATE INDEX IF NOT EXISTS smart_skin_users_approval_status_idx
        ON smart_skin_users (approval_status, created_at DESC)`;
      await sql`CREATE TABLE IF NOT EXISTS smart_skin_profile_avatars (
        user_id BIGINT PRIMARY KEY REFERENCES smart_skin_users(id) ON DELETE CASCADE,
        data_uri TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`;
      await sql`CREATE TABLE IF NOT EXISTS smart_skin_scan_logs (
        id BIGSERIAL PRIMARY KEY,
        user_id BIGINT NOT NULL REFERENCES smart_skin_users(id) ON DELETE CASCADE,
        source VARCHAR(24) NOT NULL DEFAULT 'upload',
        original_name VARCHAR(255),
        image_size_bytes INTEGER,
        result_label VARCHAR(160),
        confidence NUMERIC(5,4),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`;
      await sql`CREATE INDEX IF NOT EXISTS smart_skin_scan_logs_user_created_idx
        ON smart_skin_scan_logs (user_id, created_at DESC)`;
      await sql`CREATE TABLE IF NOT EXISTS smart_skin_feedback (
        id BIGSERIAL PRIMARY KEY,
        user_id BIGINT NOT NULL REFERENCES smart_skin_users(id) ON DELETE CASCADE,
        message VARCHAR(2000) NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`;
      await sql`CREATE INDEX IF NOT EXISTS smart_skin_feedback_created_idx
        ON smart_skin_feedback (created_at DESC)`;
      // This table intentionally retains only one coarse environmental
      // context per person. Exact device GPS never reaches persistent storage.
      await sql`CREATE TABLE IF NOT EXISTS smart_skin_nearby_context_reports (
        id BIGSERIAL PRIMARY KEY,
        user_id BIGINT NOT NULL UNIQUE REFERENCES smart_skin_users(id) ON DELETE CASCADE,
        latitude_approx NUMERIC(6,2) NOT NULL,
        longitude_approx NUMERIC(6,2) NOT NULL,
        pm25 NUMERIC(8,2) NOT NULL,
        uv_index NUMERIC(6,2) NOT NULL,
        relative_humidity NUMERIC(6,2) NOT NULL,
        temperature_c NUMERIC(6,2) NOT NULL,
        context_level VARCHAR(160) NOT NULL,
        context_summary TEXT NOT NULL,
        consented_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        retention_expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`;
      await sql`CREATE INDEX IF NOT EXISTS smart_skin_nearby_context_active_idx
        ON smart_skin_nearby_context_reports (user_id, retention_expires_at DESC)`;
      // The browser receives a one-time upload URL only after the current
      // approved user has been verified. This table never contains image data.
      await sql`CREATE TABLE IF NOT EXISTS smart_skin_pending_scan_uploads (
        id UUID PRIMARY KEY,
        user_id BIGINT NOT NULL REFERENCES smart_skin_users(id) ON DELETE CASCADE,
        object_path TEXT NOT NULL UNIQUE,
        original_name VARCHAR(255) NOT NULL,
        mime_type VARCHAR(32) NOT NULL,
        image_size_bytes INTEGER NOT NULL,
        source VARCHAR(24) NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`;
      await sql`CREATE INDEX IF NOT EXISTS smart_skin_pending_scan_uploads_expiry_idx
        ON smart_skin_pending_scan_uploads (expires_at)`;
      await sql`CREATE TABLE IF NOT EXISTS smart_skin_admin_mfa (
        user_id BIGINT PRIMARY KEY REFERENCES smart_skin_users(id) ON DELETE CASCADE,
        secret_ciphertext TEXT NOT NULL,
        recovery_code_hashes JSONB NOT NULL DEFAULT '[]'::jsonb,
        enabled_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`;
      await sql`CREATE TABLE IF NOT EXISTS smart_skin_admin_mfa_enrollments (
        id VARCHAR(80) PRIMARY KEY,
        user_id BIGINT NOT NULL REFERENCES smart_skin_users(id) ON DELETE CASCADE,
        secret_ciphertext TEXT NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        used_at TIMESTAMPTZ
      )`;
      await sql`CREATE TABLE IF NOT EXISTS smart_skin_admin_mfa_challenges (
        id VARCHAR(80) PRIMARY KEY,
        user_id BIGINT NOT NULL REFERENCES smart_skin_users(id) ON DELETE CASCADE,
        expires_at TIMESTAMPTZ NOT NULL,
        used_at TIMESTAMPTZ
      )`;
    })().catch((error) => {
      schemaPromise = undefined;
      throw error;
    });
  }
  await schemaPromise;
  // Match the legacy retention behavior: any active application request also
  // removes expired environmental context records from every account.
  await sql`DELETE FROM smart_skin_nearby_context_reports WHERE retention_expires_at <= NOW()`;
  return sql;
}

async function hashPassword(password) {
  const salt = randomBytes(16).toString('base64url');
  const derived = await scrypt(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${salt}$${Buffer.from(derived).toString('base64url')}`;
}

function assertStrongPassword(password) {
  if (
    typeof password !== 'string'
    || password.length < MIN_PASSWORD_LENGTH
    || !/\p{L}/u.test(password)
    || !/\d/.test(password)
  ) {
    throw new PublicAccountError('รหัสผ่านต้องมีอย่างน้อย 12 ตัวอักษร และมีทั้งตัวอักษรกับตัวเลข');
  }
}

async function verifyPassword(password, storedHash) {
  const [algorithm, salt, encodedKey] = String(storedHash || '').split('$');
  if (algorithm !== 'scrypt' || !salt || !encodedKey) return false;
  const expected = Buffer.from(encodedKey, 'base64url');
  if (expected.length !== 64) return false;
  const derived = Buffer.from(await scrypt(password, salt, expected.length, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }));
  return timingSafeEqual(expected, derived);
}

async function dummyPasswordHash() {
  if (!dummyPasswordHashPromise) dummyPasswordHashPromise = hashPassword('smart-skin-account-timing-placeholder');
  return dummyPasswordHashPromise;
}

export function authSecret() {
  const secret = process.env.AUTH_SESSION_SECRET;
  if (!secret || Buffer.byteLength(secret, 'utf8') < 32) {
    throw new PublicAccountError('ระบบบัญชีกำลังตั้งค่า กรุณาลองใหม่ภายหลัง', 503);
  }
  return secret;
}

function signature(value) {
  return createHmac('sha256', authSecret()).update(value).digest('base64url');
}

export function issueSession(res, userId, { mfaVerified = false } = {}) {
  const payload = Buffer.from(JSON.stringify({ sub: Number(userId), mfa: Boolean(mfaVerified), exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS })).toString('base64url');
  const token = `v1.${payload}.${signature(`v1.${payload}`)}`;
  res.setHeader(
    'Set-Cookie',
    `smart_skin_session=${token}; Path=/; Max-Age=${SESSION_TTL_SECONDS}; HttpOnly; Secure; SameSite=Lax`,
  );
}

export function clearSession(res) {
  res.setHeader('Set-Cookie', 'smart_skin_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax');
}

function cookieValue(req, name) {
  const raw = req.headers.cookie || '';
  for (const item of raw.split(';')) {
    const [key, ...parts] = item.trim().split('=');
    if (key === name) return parts.join('=');
  }
  return '';
}

export function sessionClaims(req) {
  const token = cookieValue(req, 'smart_skin_session');
  const [version, payload, providedSignature] = token.split('.');
  if (version !== 'v1' || !payload || !providedSignature) return null;
  const expectedSignature = signature(`v1.${payload}`);
  const expected = Buffer.from(expectedSignature);
  const provided = Buffer.from(providedSignature);
  if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!Number.isSafeInteger(data.sub) || data.sub < 1 || !Number.isSafeInteger(data.exp) || data.exp <= Math.floor(Date.now() / 1000)) return null;
    return { sub: data.sub, mfaVerified: data.mfa === true };
  } catch {
    return null;
  }
}

export function sessionUserId(req) {
  return sessionClaims(req)?.sub || null;
}

export async function publicUserById(userId) {
  const sql = await database();
  const rows = await sql`SELECT users.id, users.display_name, users.email, users.role, users.approval_status,
    EXISTS(SELECT 1 FROM smart_skin_admin_mfa WHERE smart_skin_admin_mfa.user_id = users.id) AS mfa_enabled
    FROM smart_skin_users AS users WHERE users.id = ${userId}`;
  const user = rows[0];
  return user ? { id: Number(user.id), name: user.display_name, email: user.email, role: user.role, approvalStatus: user.approval_status, mfaEnrolled: user.mfa_enabled === true } : null;
}

export async function registerUser({ name, email, password }) {
  const sql = await database();
  const passwordHash = await hashPassword(password);
  try {
    const rows = await sql`INSERT INTO smart_skin_users (display_name, email, password_hash, role, approval_status)
      
      VALUES (${name}, ${email}, ${passwordHash}, 'user', 'pending')
      RETURNING id, display_name, email, role, approval_status`;
    const user = rows[0];
    return { id: Number(user.id), name: user.display_name, email: user.email, role: user.role, approvalStatus: user.approval_status, mfaEnrolled: false };
  } catch (error) {
    if (error && error.code === '23505') {
      throw new PublicAccountError('อีเมลนี้ถูกใช้งานแล้ว');
    }
    throw error;
  }
}

export async function authenticateUser({ email, password }) {
  const sql = await database();
  const rows = await sql`SELECT users.id, users.display_name, users.email, users.password_hash, users.role, users.approval_status,
    EXISTS(SELECT 1 FROM smart_skin_admin_mfa WHERE smart_skin_admin_mfa.user_id = users.id) AS mfa_enabled
    FROM smart_skin_users AS users WHERE users.email = ${email}`;
  const user = rows[0];
  const valid = await verifyPassword(password, user?.password_hash || await dummyPasswordHash());
  if (!user || !valid) return null;
  await sql`UPDATE smart_skin_users SET last_login_at = NOW() WHERE id = ${user.id}`;
  return { id: Number(user.id), name: user.display_name, email: user.email, role: user.role, approvalStatus: user.approval_status, mfaEnrolled: user.mfa_enabled === true };
}

export async function changeOwnPassword(userId, { currentPassword, newPassword, confirmation }) {
  if (!currentPassword) throw new PublicAccountError('กรุณากรอกรหัสผ่านปัจจุบัน');
  if (newPassword !== confirmation) throw new PublicAccountError('ยืนยันรหัสผ่านใหม่ไม่ตรงกัน');
  assertStrongPassword(newPassword);
  const sql = await database();
  const rows = await sql`SELECT password_hash FROM smart_skin_users
    WHERE id = ${userId} AND role = 'user'`;
  const user = rows[0];
  if (!user || !await verifyPassword(currentPassword, user.password_hash)) {
    throw new PublicAccountError('รหัสผ่านปัจจุบันไม่ถูกต้อง', 403);
  }
  if (await verifyPassword(newPassword, user.password_hash)) {
    throw new PublicAccountError('โปรดตั้งรหัสผ่านใหม่ที่แตกต่างจากรหัสผ่านปัจจุบัน');
  }
  const passwordHash = await hashPassword(newPassword);
  await sql`UPDATE smart_skin_users SET password_hash = ${passwordHash} WHERE id = ${userId} AND role = 'user'`;
}

export async function verifyOwnPassword(userId, password) {
  if (!password) throw new PublicAccountError('กรุณากรอกรหัสผ่านปัจจุบันเพื่อยืนยัน');
  const sql = await database();
  const rows = await sql`SELECT password_hash FROM smart_skin_users
    WHERE id = ${userId} AND role = 'user'`;
  const user = rows[0];
  if (!user || !await verifyPassword(password, user.password_hash)) {
    throw new PublicAccountError('รหัสผ่านไม่ถูกต้อง', 403);
  }
}

export async function deleteOwnUser(userId, password, beforeDelete) {
  if (!password) throw new PublicAccountError('กรุณากรอกรหัสผ่านเพื่อยืนยันการลบบัญชี');
  await verifyOwnPassword(userId, password);
  const sql = await database();
  if (typeof beforeDelete === 'function') await beforeDelete();
  const deleted = await sql`DELETE FROM smart_skin_users WHERE id = ${userId} AND role = 'user' RETURNING id`;
  if (!deleted[0]) throw new PublicAccountError('ไม่พบบัญชีผู้ใช้', 404);
}

export function publicError(res, error, operation) {
  if (error instanceof PublicAccountError) return json(res, error.status, { ok: false, message: error.message });
  // Do not log request bodies, credentials, connection strings, or SQL text.
  console.error(`account-${operation}-failed`, { code: error && typeof error === 'object' ? error.code : undefined });
  return json(res, 500, { ok: false, message: 'ระบบบัญชีขัดข้องชั่วคราว กรุณาลองใหม่ภายหลัง' });
}
