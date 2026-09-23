import { database, json, publicError, requireGet } from '../../lib/account-auth.js';

export default async function handler(req, res) {
  if (!requireGet(req, res)) return;
  try {
    await database();
    return json(res, 200, { ok: true, status: 'ready' });
  } catch (error) {
    return publicError(res, error, 'health');
  }
}
