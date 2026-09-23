import { clearSession, json, publicError, publicUserById, requireGet, sessionUserId } from '../../lib/account-auth.js';

export default async function handler(req, res) {
  if (!requireGet(req, res)) return;
  try {
    const userId = sessionUserId(req);
    if (!userId) return json(res, 401, { ok: false, user: null });
    const user = await publicUserById(userId);
    if (!user) {
      clearSession(res);
      return json(res, 401, { ok: false, user: null });
    }
    return json(res, 200, { ok: true, user });
  } catch (error) {
    return publicError(res, error, 'session');
  }
}
