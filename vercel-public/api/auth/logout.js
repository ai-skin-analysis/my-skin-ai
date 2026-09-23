import { clearSession, json, requirePost, requireSameOrigin } from '../../lib/account-auth.js';

export default async function handler(req, res) {
  if (!requirePost(req, res) || !requireSameOrigin(req, res)) return;
  clearSession(res);
  return json(res, 200, { ok: true });
}
