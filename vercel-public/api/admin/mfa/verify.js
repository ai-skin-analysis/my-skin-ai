import {
  issueSession,
  json,
  publicError,
  publicUserById,
  requestJson,
  requirePost,
  requireSameOrigin,
  takeRateBudget,
} from '../../../lib/account-auth.js';
import { verifyMfaChallenge } from '../../../lib/admin-mfa.js';

export default async function handler(req, res) {
  if (!requirePost(req, res) || !requireSameOrigin(req, res)) return;
  const budget = takeRateBudget(req, 'admin_mfa');
  if (!budget.ok) {
    res.setHeader('Retry-After', String(budget.retryAfter));
    return json(res, 429, { ok: false, message: 'ลองยืนยัน MFA มากเกินไป กรุณาลองใหม่ภายหลัง' });
  }
  try {
    const { challengeId, code } = requestJson(req);
    const userId = await verifyMfaChallenge(challengeId, code);
    const user = await publicUserById(userId);
    if (!user || user.role !== 'admin' || !user.mfaEnrolled) return json(res, 403, { ok: false, message: 'ไม่สามารถยืนยันสิทธิ์ผู้ดูแลระบบได้' });
    issueSession(res, user.id, { mfaVerified: true });
    return json(res, 200, { ok: true, user: { ...user, mfaVerified: true }, message: 'ยืนยัน MFA สำเร็จแล้ว' });
  } catch (error) {
    return publicError(res, error, 'admin-mfa-verify');
  }
}
