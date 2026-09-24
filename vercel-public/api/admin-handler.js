import {
  database,
  issueSession,
  json,
  publicError,
  publicUserById,
  requestJson,
  requireGet,
  requirePost,
  requireSameOrigin,
  sessionClaims,
  takeRateBudget,
} from '../lib/account-auth.js';
import { beginMfaEnrollment, confirmMfaEnrollment, verifyMfaChallenge } from '../lib/admin-mfa.js';

function requestPath(req) {
  const value = req.query?.path;
  if (Array.isArray(value)) return value.join('/');
  return typeof value === 'string' ? value : '';
}

function rejectRateLimit(res, message, budget) {
  res.setHeader('Retry-After', String(budget.retryAfter));
  return json(res, 429, { ok: false, message });
}

async function signedInAdmin(req, res) {
  const claims = sessionClaims(req);
  if (!claims) {
    json(res, 401, { ok: false, message: 'กรุณาเข้าสู่ระบบ' });
    return null;
  }
  const user = await publicUserById(claims.sub);
  if (!user || user.role !== 'admin') {
    json(res, 403, { ok: false, message: 'หน้านี้สำหรับผู้ดูแลระบบ' });
    return null;
  }
  return { user, claims };
}

async function overview(req, res) {
  if (!requireGet(req, res)) return;
  const admin = await signedInAdmin(req, res);
  if (!admin) return;
  const sql = await database();
  const [accountCount, adminCount, approvedUserCount, pendingUserCount, users] = await Promise.all([
    sql`SELECT COUNT(*)::int AS value FROM smart_skin_users`,
    sql`SELECT COUNT(*)::int AS value FROM smart_skin_users WHERE role = 'admin'`,
    sql`SELECT COUNT(*)::int AS value FROM smart_skin_users WHERE role = 'user' AND approval_status = 'approved'`,
    sql`SELECT COUNT(*)::int AS value FROM smart_skin_users WHERE role = 'user' AND approval_status = 'pending'`,
    sql`SELECT id, display_name, email, approval_status, created_at, last_login_at
      FROM smart_skin_users WHERE role = 'user' ORDER BY id DESC LIMIT 100`,
  ]);
  return json(res, 200, {
    ok: true,
    admin: { name: admin.user.name, email: admin.user.email },
    counts: {
      accounts: accountCount[0].value,
      users: approvedUserCount[0].value,
      pendingUsers: pendingUserCount[0].value,
      admins: adminCount[0].value,
      scans: 0,
    },
    users: users.map((user) => ({
      id: Number(user.id),
      name: user.display_name,
      email: user.email,
      approvalStatus: user.approval_status,
      createdAt: user.created_at,
      lastLoginAt: user.last_login_at,
    })),
  });
}

async function approveUser(req, res) {
  if (!requirePost(req, res) || !requireSameOrigin(req, res)) return;
  const budget = takeRateBudget(req, 'admin_approval');
  if (!budget.ok) return rejectRateLimit(res, 'ยืนยันบัญชีบ่อยเกินไป กรุณาลองใหม่ภายหลัง', budget);
  const admin = await signedInAdmin(req, res);
  if (!admin) return;
  const rawId = requestJson(req).userId;
  const userId = typeof rawId === 'number' ? rawId : Number(rawId);
  if (!Number.isSafeInteger(userId) || userId < 1) return json(res, 400, { ok: false, message: 'รหัสบัญชีผู้ใช้ไม่ถูกต้อง' });
  const sql = await database();
  const rows = await sql`UPDATE smart_skin_users
    SET approval_status = 'approved'
    WHERE id = ${userId} AND role = 'user' AND approval_status = 'pending'
    RETURNING id, display_name`;
  if (!rows[0]) return json(res, 409, { ok: false, message: 'บัญชีนี้ถูกยืนยันแล้ว หรือไม่พบบัญชีที่รอยืนยัน' });
  return json(res, 200, { ok: true, user: { id: Number(rows[0].id), name: rows[0].display_name }, message: 'ยืนยันบัญชีผู้ใช้เรียบร้อยแล้ว' });
}

async function enrollmentStart(req, res) {
  if (!requirePost(req, res) || !requireSameOrigin(req, res)) return;
  const budget = takeRateBudget(req, 'admin_mfa');
  if (!budget.ok) return rejectRateLimit(res, 'ลองตั้งค่า MFA มากเกินไป กรุณาลองใหม่ภายหลัง', budget);
  const admin = await signedInAdmin(req, res);
  if (!admin) return;
  if (admin.user.mfaEnrolled) return json(res, 409, { ok: false, message: 'บัญชีนี้เปิด MFA แล้ว' });
  const enrollment = await beginMfaEnrollment(admin.user);
  return json(res, 200, { ok: true, enrollment });
}

async function enrollmentConfirm(req, res) {
  if (!requirePost(req, res) || !requireSameOrigin(req, res)) return;
  const budget = takeRateBudget(req, 'admin_mfa');
  if (!budget.ok) return rejectRateLimit(res, 'ลองยืนยัน MFA มากเกินไป กรุณาลองใหม่ภายหลัง', budget);
  const admin = await signedInAdmin(req, res);
  if (!admin) return;
  if (admin.user.mfaEnrolled) return json(res, 409, { ok: false, message: 'บัญชีนี้เปิด MFA แล้ว' });
  const { enrollmentId, code } = requestJson(req);
  await confirmMfaEnrollment(admin.user.id, enrollmentId, code);
  issueSession(res, admin.user.id, { mfaVerified: true });
  return json(res, 200, {
    ok: true,
    user: { ...admin.user, mfaEnrolled: true, mfaVerified: true },
    message: 'เชื่อม MFA สำเร็จแล้ว',
  });
}

async function mfaVerify(req, res) {
  if (!requirePost(req, res) || !requireSameOrigin(req, res)) return;
  const budget = takeRateBudget(req, 'admin_mfa');
  if (!budget.ok) return rejectRateLimit(res, 'ลองยืนยัน MFA มากเกินไป กรุณาลองใหม่ภายหลัง', budget);
  const { challengeId, code } = requestJson(req);
  const userId = await verifyMfaChallenge(challengeId, code);
  const user = await publicUserById(userId);
  if (!user || user.role !== 'admin' || !user.mfaEnrolled) return json(res, 403, { ok: false, message: 'ไม่สามารถยืนยันสิทธิ์ผู้ดูแลระบบได้' });
  issueSession(res, user.id, { mfaVerified: true });
  return json(res, 200, { ok: true, user: { ...user, mfaVerified: true }, message: 'ยืนยัน MFA สำเร็จแล้ว' });
}

async function mfaStatus(req, res) {
  if (!requireGet(req, res)) return;
  const admin = await signedInAdmin(req, res);
  if (!admin) return;
  return json(res, 200, { ok: true, mfaEnrolled: admin.user.mfaEnrolled, mfaVerified: admin.claims.mfaVerified });
}

export default async function handler(req, res) {
  try {
    switch (requestPath(req)) {
      case 'overview': return await overview(req, res);
      case 'approve-user': return await approveUser(req, res);
      case 'mfa/enroll': return await enrollmentStart(req, res);
      case 'mfa/confirm': return await enrollmentConfirm(req, res);
      case 'mfa/verify': return await mfaVerify(req, res);
      case 'mfa/status': return await mfaStatus(req, res);
      default: return json(res, 404, { ok: false, message: 'ไม่พบปลายทางผู้ดูแลระบบ' });
    }
  } catch (error) {
    return publicError(res, error, 'admin');
  }
}
