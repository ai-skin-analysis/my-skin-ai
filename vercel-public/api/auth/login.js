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
    issueSession(res, user.id);
    return json(res, 200, { ok: true, user, message: `ยินดีต้อนรับ ${user.name}` });
  } catch (error) {
    return publicError(res, error, 'login');
  }
}
