import {
  authenticateUser,
  issueSession,
  json,
  normalizeLogin,
  publicError,
  requestJson,
  requirePost,
  requireSameOrigin,
  takeRateBudget,
} from '../../lib/account-auth.js';
import { createMfaChallenge } from '../../lib/admin-mfa.js';

export default async function handler(req, res) {
  if (!requirePost(req, res) || !requireSameOrigin(req, res)) return;
  const budget = takeRateBudget(req, 'login');
  if (!budget.ok) {
    res.setHeader('Retry-After', String(budget.retryAfter));
    return json(res, 429, { ok: false, message: 'พยายามเข้าสู่ระบบมากเกินไป กรุณาลองใหม่ภายหลัง' });
  }
  try {
    const user = await authenticateUser(normalizeLogin(requestJson(req)));
    if (!user) return json(res, 401, { ok: false, message: 'อีเมลหรือรหัสผ่านไม่ถูกต้อง' });
    if (user.role === 'admin') {
      if (!user.mfaEnrolled) {
        // This limited session only permits the one-time MFA enrollment flow.
        issueSession(res, user.id, { mfaVerified: false });
        return json(res, 200, {
          ok: true,
          user,
          mfaEnrollmentRequired: true,
          message: 'กรุณาตั้งค่า MFA ด้วยแอปยืนยันตัวตนก่อนเข้าสู่แดชบอร์ด',
        });
      }
      const challengeId = await createMfaChallenge(user.id);
      return json(res, 200, {
        ok: true,
        user: { id: user.id, name: user.name, email: user.email, role: user.role },
        mfaRequired: true,
        challengeId,
        message: 'กรุณากรอกรหัส 6 หลักจากแอปยืนยันตัวตน',
      });
    }
    issueSession(res, user.id);
    return json(res, 200, { ok: true, user, message: `ยินดีต้อนรับ ${user.name}` });
  } catch (error) {
    return publicError(res, error, 'login');
  }
}
