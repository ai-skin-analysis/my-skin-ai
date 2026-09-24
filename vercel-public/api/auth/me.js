import { clearSession, json, publicError, publicUserById, requireGet, sessionClaims } from '../../lib/account-auth.js';

export default async function handler(req, res) {
  if (!requireGet(req, res)) return;
  try {
    const claims = sessionClaims(req);
    if (!claims) return json(res, 401, { ok: false, user: null });
    const user = await publicUserById(claims.sub);
    if (!user || (user.role === 'user' && user.approvalStatus !== 'approved')) {
      clearSession(res);
      return json(res, 401, { ok: false, user: null, message: 'บัญชีนี้กำลังรอผู้ดูแลระบบยืนยัน' });
    }
    return json(res, 200, { ok: true, user: { ...user, mfaVerified: claims.mfaVerified } });
  } catch (error) {
    return publicError(res, error, 'session');
  }
}
