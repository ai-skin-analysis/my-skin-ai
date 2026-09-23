import { database, json, publicError, publicUserById, requireGet, sessionClaims } from '../../lib/account-auth.js';

export default async function handler(req, res) {
  if (!requireGet(req, res)) return;
  try {
    const claims = sessionClaims(req);
    if (!claims) return json(res, 401, { ok: false, message: 'กรุณาเข้าสู่ระบบ' });
    const user = await publicUserById(claims.sub);
    if (!user || user.role !== 'admin') return json(res, 403, { ok: false, message: 'หน้านี้สำหรับผู้ดูแลระบบ' });
    if (!user.mfaEnrolled) return json(res, 428, { ok: false, code: 'mfa_enrollment_required', message: 'กรุณาตั้งค่า MFA ก่อนเข้าสู่แดชบอร์ด' });
    if (!claims.mfaVerified) return json(res, 401, { ok: false, code: 'mfa_verification_required', message: 'กรุณายืนยัน MFA ก่อนเข้าสู่แดชบอร์ด' });

    const sql = await database();
    const [accountCount, adminCount] = await Promise.all([
      sql`SELECT COUNT(*)::int AS value FROM smart_skin_users`,
      sql`SELECT COUNT(*)::int AS value FROM smart_skin_users WHERE role = 'admin'`,
    ]);
    return json(res, 200, {
      ok: true,
      admin: { name: user.name, email: user.email },
      counts: { accounts: accountCount[0].value, admins: adminCount[0].value },
    });
  } catch (error) {
    return publicError(res, error, 'admin-overview');
  }
}
