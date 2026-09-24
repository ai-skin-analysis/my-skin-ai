import {
  changeOwnPassword,
  clearSession,
  database,
  deleteOwnUser,
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

async function signedInApprovedUser(req, res) {
  const claims = sessionClaims(req);
  if (!claims) {
    json(res, 401, { ok: false, message: 'กรุณาเข้าสู่ระบบ' });
    return null;
  }
  const user = await publicUserById(claims.sub);
  if (!user || user.role !== 'user' || user.approvalStatus !== 'approved') {
    json(res, 403, { ok: false, message: 'บัญชีนี้ยังไม่มีสิทธิ์ใช้งาน' });
    return null;
  }
  return { user, claims };
}

async function overview(req, res) {
  if (!requireGet(req, res)) return;
  const admin = await signedInAdmin(req, res);
  if (!admin) return;
  const sql = await database();
  const [accountCount, adminCount, approvedUserCount, pendingUserCount, scanCount, feedbackCount, users, feedbacks] = await Promise.all([
    sql`SELECT COUNT(*)::int AS value FROM smart_skin_users`,
    sql`SELECT COUNT(*)::int AS value FROM smart_skin_users WHERE role = 'admin'`,
    sql`SELECT COUNT(*)::int AS value FROM smart_skin_users WHERE role = 'user' AND approval_status = 'approved'`,
    sql`SELECT COUNT(*)::int AS value FROM smart_skin_users WHERE role = 'user' AND approval_status = 'pending'`,
    sql`SELECT COUNT(*)::int AS value FROM smart_skin_scan_logs`,
    sql`SELECT COUNT(*)::int AS value FROM smart_skin_feedback`,
    sql`SELECT id, display_name, email, approval_status, created_at, last_login_at
      FROM smart_skin_users WHERE role = 'user' ORDER BY id DESC LIMIT 100`,
    sql`SELECT feedback.id, feedback.message, feedback.created_at, users.display_name
      FROM smart_skin_feedback AS feedback
      JOIN smart_skin_users AS users ON users.id = feedback.user_id
      ORDER BY feedback.created_at DESC LIMIT 30`,
  ]);
  return json(res, 200, {
    ok: true,
    admin: { name: admin.user.name, email: admin.user.email },
    counts: {
      accounts: accountCount[0].value,
      users: approvedUserCount[0].value,
      pendingUsers: pendingUserCount[0].value,
      admins: adminCount[0].value,
      scans: scanCount[0].value,
      feedbacks: feedbackCount[0].value,
    },
    users: users.map((user) => ({
      id: Number(user.id),
      name: user.display_name,
      email: user.email,
      approvalStatus: user.approval_status,
      createdAt: user.created_at,
      lastLoginAt: user.last_login_at,
    })),
    feedbacks: feedbacks.map((feedback) => ({
      id: Number(feedback.id),
      name: feedback.display_name,
      message: feedback.message,
      createdAt: feedback.created_at,
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

function avatarDataUrl(value) {
  if (typeof value !== 'string') throw new Error('invalid-avatar');
  const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(value);
  if (!match) throw new Error('invalid-avatar');
  const bytes = Buffer.from(match[2], 'base64');
  if (!bytes.length || bytes.length > 400 * 1024) throw new Error('invalid-avatar');
  return `data:${match[1]};base64,${bytes.toString('base64')}`;
}

async function userProfile(req, res) {
  if (!requireGet(req, res)) return;
  const account = await signedInApprovedUser(req, res);
  if (!account) return;
  const sql = await database();
  const rows = await sql`SELECT data_uri, updated_at FROM smart_skin_profile_avatars WHERE user_id = ${account.user.id}`;
  const avatar = rows[0];
  return json(res, 200, { ok: true, user: account.user, avatar: avatar ? { dataUrl: avatar.data_uri, updatedAt: avatar.updated_at } : null });
}

async function updateAvatar(req, res) {
  if (!requirePost(req, res) || !requireSameOrigin(req, res)) return;
  const budget = takeRateBudget(req, 'user_profile');
  if (!budget.ok) return rejectRateLimit(res, 'อัปเดตรูปโปรไฟล์บ่อยเกินไป กรุณาลองใหม่ภายหลัง', budget);
  const account = await signedInApprovedUser(req, res);
  if (!account) return;
  let dataUrl;
  try { dataUrl = avatarDataUrl(requestJson(req).dataUrl); }
  catch { return json(res, 400, { ok: false, message: 'รูปโปรไฟล์ต้องเป็น JPEG, PNG หรือ WEBP ที่มีขนาดไม่เกิน 400 KB' }); }
  const sql = await database();
  const rows = await sql`INSERT INTO smart_skin_profile_avatars (user_id, data_uri, updated_at)
    VALUES (${account.user.id}, ${dataUrl}, NOW())
    ON CONFLICT (user_id) DO UPDATE SET data_uri = EXCLUDED.data_uri, updated_at = NOW()
    RETURNING data_uri, updated_at`;
  return json(res, 200, { ok: true, avatar: { dataUrl: rows[0].data_uri, updatedAt: rows[0].updated_at }, message: 'บันทึกรูปโปรไฟล์เรียบร้อยแล้ว' });
}

async function removeAvatar(req, res) {
  if (!requirePost(req, res) || !requireSameOrigin(req, res)) return;
  const budget = takeRateBudget(req, 'user_profile');
  if (!budget.ok) return rejectRateLimit(res, 'ลบรูปโปรไฟล์บ่อยเกินไป กรุณาลองใหม่ภายหลัง', budget);
  const account = await signedInApprovedUser(req, res);
  if (!account) return;
  const sql = await database();
  await sql`DELETE FROM smart_skin_profile_avatars WHERE user_id = ${account.user.id}`;
  return json(res, 200, { ok: true, message: 'ลบรูปโปรไฟล์เรียบร้อยแล้ว' });
}

async function userHistory(req, res) {
  if (!requireGet(req, res)) return;
  const account = await signedInApprovedUser(req, res);
  if (!account) return;
  const sql = await database();
  const rows = await sql`SELECT id, source, original_name, image_size_bytes, result_label, confidence, created_at
    FROM smart_skin_scan_logs WHERE user_id = ${account.user.id} ORDER BY created_at DESC LIMIT 50`;
  return json(res, 200, { ok: true, history: rows.map((item) => ({
    id: Number(item.id), source: item.source, originalName: item.original_name, imageSizeBytes: item.image_size_bytes,
    resultLabel: item.result_label, confidence: item.confidence === null ? null : Number(item.confidence), createdAt: item.created_at,
  })) });
}

async function changePassword(req, res) {
  if (!requirePost(req, res) || !requireSameOrigin(req, res)) return;
  const budget = takeRateBudget(req, 'user_sensitive');
  if (!budget.ok) return rejectRateLimit(res, 'เปลี่ยนรหัสผ่านบ่อยเกินไป กรุณาลองใหม่ภายหลัง', budget);
  const account = await signedInApprovedUser(req, res);
  if (!account) return;
  const body = requestJson(req);
  await changeOwnPassword(account.user.id, { currentPassword: body.currentPassword, newPassword: body.newPassword, confirmation: body.confirmation });
  return json(res, 200, { ok: true, message: 'เปลี่ยนรหัสผ่านเรียบร้อยแล้ว' });
}

async function sendFeedback(req, res) {
  if (!requirePost(req, res) || !requireSameOrigin(req, res)) return;
  const budget = takeRateBudget(req, 'user_feedback');
  if (!budget.ok) return rejectRateLimit(res, 'ส่งข้อความบ่อยเกินไป กรุณาลองใหม่ภายหลัง', budget);
  const account = await signedInApprovedUser(req, res);
  if (!account) return;
  const message = typeof requestJson(req).message === 'string' ? requestJson(req).message.trim() : '';
  if (!message || message.length > 2000 || /[\u0000-\u001f\u007f]/.test(message)) return json(res, 400, { ok: false, message: 'กรุณาระบุข้อความที่ถูกต้องและยาวไม่เกิน 2,000 ตัวอักษร' });
  const sql = await database();
  await sql`INSERT INTO smart_skin_feedback (user_id, message) VALUES (${account.user.id}, ${message})`;
  return json(res, 201, { ok: true, message: 'ส่งข้อความถึงผู้ดูแลระบบเรียบร้อยแล้ว' });
}

async function deleteAccount(req, res) {
  if (!requirePost(req, res) || !requireSameOrigin(req, res)) return;
  const budget = takeRateBudget(req, 'user_sensitive');
  if (!budget.ok) return rejectRateLimit(res, 'ส่งคำขอลบบัญชีบ่อยเกินไป กรุณาลองใหม่ภายหลัง', budget);
  const account = await signedInApprovedUser(req, res);
  if (!account) return;
  const body = requestJson(req);
  if (body.confirmation !== 'DELETE') return json(res, 400, { ok: false, message: 'กรุณาพิมพ์ DELETE เพื่อยืนยันการลบบัญชี' });
  await deleteOwnUser(account.user.id, body.password);
  clearSession(res);
  return json(res, 200, { ok: true, message: 'ลบบัญชีและข้อมูลที่เกี่ยวข้องเรียบร้อยแล้ว' });
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
      case 'user/profile': return await userProfile(req, res);
      case 'user/avatar': return await updateAvatar(req, res);
      case 'user/avatar/remove': return await removeAvatar(req, res);
      case 'user/history': return await userHistory(req, res);
      case 'user/password': return await changePassword(req, res);
      case 'user/feedback': return await sendFeedback(req, res);
      case 'user/delete': return await deleteAccount(req, res);
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
