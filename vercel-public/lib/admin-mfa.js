import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';
import { authSecret, database, PublicAccountError } from './account-auth.js';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const TOTP_STEP_SECONDS = 30;
const ENROLLMENT_TTL_MS = 10 * 60 * 1000;
const CHALLENGE_TTL_MS = 5 * 60 * 1000;

function encryptionKey() {
  return createHash('sha256').update('smart-skin-admin-mfa-v1').update(authSecret()).digest();
}

function encryptSecret(value) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return `v1.${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${encrypted.toString('base64url')}`;
}

function decryptSecret(value) {
  const [version, ivText, tagText, payloadText] = String(value || '').split('.');
  if (version !== 'v1' || !ivText || !tagText || !payloadText) throw new PublicAccountError('ข้อมูล MFA ไม่ถูกต้อง', 500);
  try {
    const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(ivText, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagText, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(payloadText, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    throw new PublicAccountError('ไม่สามารถอ่านข้อมูล MFA ได้', 500);
  }
}

function encodeBase32(buffer) {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

function decodeBase32(value) {
  const input = String(value || '').replace(/[\s=-]/g, '').toUpperCase();
  if (!input || !/^[A-Z2-7]+$/.test(input)) throw new PublicAccountError('รหัส MFA ไม่ถูกต้อง');
  let bits = 0;
  let accumulator = 0;
  const output = [];
  for (const char of input) {
    accumulator = (accumulator << 5) | BASE32_ALPHABET.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      output.push((accumulator >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(output);
}

function totpCode(secret, counter) {
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', decodeBase32(secret)).update(counterBuffer).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const value = ((digest[offset] & 0x7f) << 24) | (digest[offset + 1] << 16) | (digest[offset + 2] << 8) | digest[offset + 3];
  return String(value % 1_000_000).padStart(6, '0');
}

export function verifyTotp(secret, code) {
  const supplied = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(supplied)) return false;
  const counter = Math.floor(Date.now() / 1000 / TOTP_STEP_SECONDS);
  return [-1, 0, 1].some((offset) => totpCode(secret, counter + offset) === supplied);
}

export async function mfaEnabledForUser(userId) {
  const sql = await database();
  const rows = await sql`SELECT 1 FROM smart_skin_admin_mfa WHERE user_id = ${userId}`;
  return rows.length > 0;
}

export async function beginMfaEnrollment(user) {
  if (!user || user.role !== 'admin') throw new PublicAccountError('หน้านี้สำหรับผู้ดูแลระบบ', 403);
  if (await mfaEnabledForUser(user.id)) throw new PublicAccountError('บัญชีนี้เปิด MFA แล้ว');
  const sql = await database();
  const enrollmentId = randomBytes(24).toString('base64url');
  const secret = encodeBase32(randomBytes(20));
  const expiresAt = new Date(Date.now() + ENROLLMENT_TTL_MS);
  await sql`DELETE FROM smart_skin_admin_mfa_enrollments WHERE user_id = ${user.id} OR expires_at <= NOW()`;
  await sql`INSERT INTO smart_skin_admin_mfa_enrollments (id, user_id, secret_ciphertext, expires_at)
    VALUES (${enrollmentId}, ${user.id}, ${encryptSecret(secret)}, ${expiresAt})`;
  return { enrollmentId, secret };
}

export async function confirmMfaEnrollment(userId, enrollmentId, code) {
  const sql = await database();
  const rows = await sql`SELECT id, secret_ciphertext FROM smart_skin_admin_mfa_enrollments
    WHERE id = ${String(enrollmentId || '')} AND user_id = ${userId} AND used_at IS NULL AND expires_at > NOW()`;
  const enrollment = rows[0];
  if (!enrollment) throw new PublicAccountError('คำขอตั้งค่า MFA หมดอายุ กรุณาเริ่มใหม่');
  const secret = decryptSecret(enrollment.secret_ciphertext);
  if (!verifyTotp(secret, code)) throw new PublicAccountError('รหัสจากแอปยืนยันตัวตนไม่ถูกต้อง');
  const consumed = await sql`UPDATE smart_skin_admin_mfa_enrollments SET used_at = NOW()
    WHERE id = ${enrollment.id} AND used_at IS NULL RETURNING id`;
  if (!consumed.length) throw new PublicAccountError('คำขอตั้งค่า MFA ถูกใช้งานแล้ว');
  await sql`INSERT INTO smart_skin_admin_mfa (user_id, secret_ciphertext, enabled_at)
    VALUES (${userId}, ${encryptSecret(secret)}, NOW())
    ON CONFLICT (user_id) DO UPDATE SET secret_ciphertext = EXCLUDED.secret_ciphertext, enabled_at = EXCLUDED.enabled_at`;
}

export async function createMfaChallenge(userId) {
  const sql = await database();
  const id = randomBytes(24).toString('base64url');
  const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MS);
  await sql`DELETE FROM smart_skin_admin_mfa_challenges WHERE user_id = ${userId} OR expires_at <= NOW()`;
  await sql`INSERT INTO smart_skin_admin_mfa_challenges (id, user_id, expires_at) VALUES (${id}, ${userId}, ${expiresAt})`;
  return id;
}

export async function verifyMfaChallenge(challengeId, code) {
  const sql = await database();
  const rows = await sql`SELECT challenges.id, challenges.user_id, credentials.secret_ciphertext
    FROM smart_skin_admin_mfa_challenges AS challenges
    JOIN smart_skin_admin_mfa AS credentials ON credentials.user_id = challenges.user_id
    WHERE challenges.id = ${String(challengeId || '')} AND challenges.used_at IS NULL AND challenges.expires_at > NOW()`;
  const challenge = rows[0];
  if (!challenge) throw new PublicAccountError('คำขอ MFA หมดอายุ กรุณาเข้าสู่ระบบใหม่');
  if (!verifyTotp(decryptSecret(challenge.secret_ciphertext), code)) throw new PublicAccountError('รหัส MFA ไม่ถูกต้อง');
  const consumed = await sql`UPDATE smart_skin_admin_mfa_challenges SET used_at = NOW()
    WHERE id = ${challenge.id} AND used_at IS NULL RETURNING user_id`;
  if (!consumed.length) throw new PublicAccountError('คำขอ MFA ถูกใช้งานแล้ว');
  return Number(challenge.user_id);
}
