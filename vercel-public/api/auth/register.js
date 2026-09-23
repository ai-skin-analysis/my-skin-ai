import {
  issueSession,
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
    issueSession(res, user.id);
    return json(res, 201, { ok: true, user, message: 'ลงทะเบียนและเข้าสู่ระบบเรียบร้อยแล้ว' });
  } catch (error) {
    return publicError(res, error, 'register');
  }
}
