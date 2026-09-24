import {
  json,
  normalizeRegistration,
  publicError,
  registerUser,
  requestJson,
  requirePost,
  requireSameOrigin,
  takeRateBudget,
} from '../../lib/account-auth.js';

export default async function handler(req, res) {
  if (!requirePost(req, res) || !requireSameOrigin(req, res)) return;
  const budget = takeRateBudget(req, 'register');
  if (!budget.ok) {
    res.setHeader('Retry-After', String(budget.retryAfter));
    return json(res, 429, { ok: false, message: 'ลงทะเบียนบ่อยเกินไป กรุณาลองใหม่ภายหลัง' });
  }
  try {
    const user = await registerUser(normalizeRegistration(requestJson(req)));
    return json(res, 201, { ok: true, user, pendingApproval: true, message: 'ลงทะเบียนสำเร็จแล้ว บัญชีของคุณกำลังรอผู้ดูแลระบบยืนยัน' });
  } catch (error) {
    return publicError(res, error, 'register');
  }
}
