import {
  json,
  publicError,
  publicUserById,
  requirePost,
  requireSameOrigin,
  sessionClaims,
  takeRateBudget,
} from '../../../lib/account-auth.js';
import { beginMfaEnrollment } from '../../../lib/admin-mfa.js';

export default async function handler(req, res) {
  if (!requirePost(req, res) || !requireSameOrigin(req, res)) return;
  const budget = takeRateBudget(req, 'admin_mfa');
  if (!budget.ok) {
    res.setHeader('Retry-After', String(budget.retryAfter));
    return json(res, 429, { ok: false, message: 'ลองตั้งค่า MFA มากเกินไป กรุณาลองใหม่ภายหลัง' });
  }
  try {
    const claims = sessionClaims(req);
    if (!claims) return json(res, 401, { ok: false, message: 'กรุณาเข้าสู่ระบบอีกครั้ง' });
    const user = await publicUserById(claims.sub);
    if (!user || user.role !== 'admin') return json(res, 403, { ok: false, message: 'หน้านี้สำหรับผู้ดูแลระบบ' });
    if (user.mfaEnrolled) return json(res, 409, { ok: false, message: 'บัญชีนี้เปิด MFA แล้ว' });
    const enrollment = await beginMfaEnrollment(user);
    return json(res, 200, { ok: true, enrollment });
  } catch (error) {
    return publicError(res, error, 'admin-mfa-enroll');
  }
}
