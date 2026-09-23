import {
  issueSession,
  json,
  publicError,
  publicUserById,
  requestJson,
  requirePost,
  requireSameOrigin,
  sessionClaims,
  takeRateBudget,
} from '../../../lib/account-auth.js';
import { confirmMfaEnrollment } from '../../../lib/admin-mfa.js';

export default async function handler(req, res) {
  if (!requirePost(req, res) || !requireSameOrigin(req, res)) return;
  const budget = takeRateBudget(req, 'admin_mfa');
  if (!budget.ok) {
    res.setHeader('Retry-After', String(budget.retryAfter));
    return json(res, 429, { ok: false, message: 'ลองยืนยัน MFA มากเกินไป กรุณาลองใหม่ภายหลัง' });
  }
  try {
    const claims = sessionClaims(req);
    if (!claims) return json(res, 401, { ok: false, message: 'กรุณาเข้าสู่ระบบอีกครั้ง' });
    const user = await publicUserById(claims.sub);
    if (!user || user.role !== 'admin') return json(res, 403, { ok: false, message: 'หน้านี้สำหรับผู้ดูแลระบบ' });
    if (user.mfaEnrolled) return json(res, 409, { ok: false, message: 'บัญชีนี้เปิด MFA แล้ว' });
    const { enrollmentId, code } = requestJson(req);
    await confirmMfaEnrollment(user.id, enrollmentId, code);
    issueSession(res, user.id, { mfaVerified: true });
    return json(res, 200, {
      ok: true,
      user: { ...user, mfaEnrolled: true, mfaVerified: true },
      message: 'เชื่อม MFA สำเร็จแล้ว',
    });
  } catch (error) {
    return publicError(res, error, 'admin-mfa-confirm');
  }
}
