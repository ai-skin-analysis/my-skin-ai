import { json, publicError, publicUserById, requireGet, sessionClaims } from '../../../lib/account-auth.js';

export default async function handler(req, res) {
  if (!requireGet(req, res)) return;
  try {
    const claims = sessionClaims(req);
    if (!claims) return json(res, 401, { ok: false, message: 'กรุณาเข้าสู่ระบบ' });
    const user = await publicUserById(claims.sub);
    if (!user || user.role !== 'admin') return json(res, 403, { ok: false, message: 'หน้านี้สำหรับผู้ดูแลระบบ' });
    return json(res, 200, { ok: true, mfaEnrolled: user.mfaEnrolled, mfaVerified: claims.mfaVerified });
  } catch (error) {
    return publicError(res, error, 'admin-mfa-status');
  }
}
