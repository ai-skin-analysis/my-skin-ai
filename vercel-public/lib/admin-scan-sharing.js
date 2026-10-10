import { PublicAccountError } from './account-auth.js';
import { researchResultView } from '../research-result.js';
import { selectPrivateRows, downloadPrivateScanObject } from './supabase-private.js';

export const ADMIN_SHARE_CONSENT_VERSION = 'admin-scan-share-20261010-v1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const SHARED_PAGE_SIZE = 10;

export function adminShareConsent(body) {
  if (body.shareWithAdmin !== undefined && typeof body.shareWithAdmin !== 'boolean') {
    throw new PublicAccountError('รูปแบบความยินยอมแชร์ให้ผู้ดูแลไม่ถูกต้อง');
  }
  if (body.shareWithAdmin !== true) return null;
  if (body.adminShareConsentVersion !== ADMIN_SHARE_CONSENT_VERSION) {
    throw new PublicAccountError('กรุณาอ่านและยืนยันความยินยอมแชร์ให้ผู้ดูแลฉบับปัจจุบัน');
  }
  return ADMIN_SHARE_CONSENT_VERSION;
}

export function sharedQuery(query = {}, image = false) {
  if (typeof query.userId !== 'string' || !/^[1-9]\d{0,14}$/.test(query.userId)
      || !Number.isSafeInteger(Number(query.userId))) throw new PublicAccountError('รหัสผู้ใช้ไม่ถูกต้อง');
  if (image) {
    if (typeof query.scanId !== 'string' || !UUID.test(query.scanId)) throw new PublicAccountError('รหัสรายการไม่ถูกต้อง');
    return { userId: Number(query.userId), scanId: query.scanId.toLowerCase() };
  }
  let cursor = null;
  if (query.cursor !== undefined) {
    try {
      if (typeof query.cursor !== 'string' || !/^[\w-]{1,180}$/.test(query.cursor)) throw new Error();
      const parsed = JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8'));
      if (!Array.isArray(parsed) || parsed.length !== 2 || !UUID.test(parsed[1])
          || typeof parsed[0] !== 'string' || new Date(parsed[0]).toISOString() !== parsed[0]) throw new Error();
      cursor = { at: parsed[0], id: parsed[1].toLowerCase() };
    } catch { throw new PublicAccountError('หน้าประวัติไม่ถูกต้อง กรุณาโหลดใหม่'); }
  }
  return { userId: Number(query.userId), cursor };
}

// No upstream messages, object paths, image URLs, browser-supplied findings or
// arbitrary JSON survive this whitelist. Rendering uses the curated catalogue.
export function sharedAnalysis(value) {
  const view = researchResultView(value);
  if (view.code !== 'RESEARCH_ONLY') throw new Error('Invalid shared analysis');
  const ranked = [...value.diagnostics].sort((a, b) => b.score - a.score);
  if (ranked[0].score < .75 || ranked[0].score - ranked[1].score < .30) throw new Error('Unaccepted shared analysis');
  return { ok: true, code: 'RESEARCH_ONLY', releaseStatus: 'research_only', classificationStatus: 'experimental',
    publicDeployment: false, scopeValidated: false, unsupportedValidated: false, modelVersion: value.modelVersion,
    diagnostics: value.diagnostics.map(({ id, score }) => ({ id, score })),
    ...(view.explanation ? { explanation: view.explanation } : {}) };
}

export async function recordConsentedScan(sql, pending, userId, result, retention) {
  if (pending.admin_share_consent_version !== ADMIN_SHARE_CONSENT_VERSION) return 'private';
  if (result.storedImage !== true || result.scan?.id !== pending.id) return 'not_shared';
  const analysis = sharedAnalysis(result.analysis);
  // Read the permission again from the claimed upload, not the completion body.
  // A global revocation invalidates even a still-running older scan. Access also
  // rechecks this cutoff, so an insertion racing revocation cannot regain access.
  const saved = await sql`INSERT INTO smart_skin_admin_scan_shares
    (id, user_id, analysis_json, consent_version, consented_at, created_at, retention_expires_at)
    SELECT pending.id, pending.user_id, ${JSON.stringify(analysis)}::jsonb, ${ADMIN_SHARE_CONSENT_VERSION},
      pending.created_at, date_trunc('milliseconds', ${result.scan.createdAt || new Date().toISOString()}::timestamptz), ${retention}::timestamptz
    FROM smart_skin_pending_scan_uploads pending JOIN smart_skin_users users ON users.id = pending.user_id
    WHERE pending.id = ${pending.id} AND pending.user_id = ${userId}
      AND pending.admin_share_consent_version = ${ADMIN_SHARE_CONSENT_VERSION}
      AND pending.analysis_started_at IS NOT NULL AND pending.expires_at > NOW()
      AND users.role = 'user' AND users.approval_status = 'approved'
      AND (users.admin_shares_revoked_at IS NULL OR pending.created_at > users.admin_shares_revoked_at)
    ON CONFLICT (id) DO NOTHING RETURNING id`;
  if (saved.length) return 'shared';
  // Retry after a lost acknowledgement must not claim an existing valid share
  // is private. Never reactivate a withdrawn permission on conflict.
  return (await activeShares(sql, { userId, scanId: pending.id })).length ? 'shared' : 'not_shared';
}

export async function revokeAdminShares(sql, userId) {
  // Set the access cutoff FIRST. A later cleanup outage cannot leave access open.
  const rows = await sql`UPDATE smart_skin_users SET admin_shares_revoked_at = NOW()
    WHERE id = ${userId} AND role = 'user' RETURNING admin_shares_revoked_at`;
  const cutoff = rows[0]?.admin_shares_revoked_at;
  if (!cutoff) throw new Error('Revocation failed');
  await sql`DELETE FROM smart_skin_admin_scan_shares WHERE user_id = ${userId} AND consented_at <= ${cutoff}`;
  await sql`UPDATE smart_skin_pending_scan_uploads SET admin_share_consent_version = NULL
    WHERE user_id = ${userId} AND created_at <= ${cutoff}`;
}

async function activeShares(sql, { userId, cursor = null, scanId = null }) {
  return sql`SELECT shares.id, shares.analysis_json, shares.consented_at, shares.created_at, shares.retention_expires_at
    FROM smart_skin_admin_scan_shares shares JOIN smart_skin_users users ON users.id = shares.user_id
    WHERE shares.user_id = ${userId} AND shares.consent_version = ${ADMIN_SHARE_CONSENT_VERSION}
      AND shares.retention_expires_at > NOW() AND users.role = 'user' AND users.approval_status = 'approved'
      AND (users.admin_shares_revoked_at IS NULL OR shares.consented_at > users.admin_shares_revoked_at)
      AND (${scanId}::uuid IS NULL OR shares.id = ${scanId}::uuid)
      AND (${cursor?.at || null}::timestamptz IS NULL OR (shares.created_at, shares.id)
        < (${cursor?.at || null}::timestamptz, ${cursor?.id || null}::uuid))
    ORDER BY shares.created_at DESC, shares.id DESC LIMIT ${scanId ? 1 : SHARED_PAGE_SIZE + 1}`;
}

async function ownedStoredRows(userId, ids, select) {
  if (!ids.length) return [];
  const now = encodeURIComponent(new Date().toISOString());
  const rows = await select('smart_skin_scan_logs', `?select=id,user_id,source,original_name,image_size_bytes,image_object_path,created_at,retention_expires_at,model_version,decision_status&user_id=eq.${userId}&id=in.(${ids.join(',')})&retention_expires_at=gt.${now}&limit=${SHARED_PAGE_SIZE + 1}`);
  return rows.filter(row => String(row.user_id) === String(userId) && ids.includes(row.id)
    && row.decision_status === 'research_only' && Date.parse(row.retention_expires_at) > Date.now()
    && typeof row.image_object_path === 'string'
    && new RegExp(`^scans/${userId}/[0-9a-f-]{36}\\.(jpg|png|webp)$`, 'i').test(row.image_object_path)
    && Number.isInteger(Number(row.image_size_bytes)) && Number(row.image_size_bytes) > 0
    && Number(row.image_size_bytes) <= 8 * 1024 * 1024);
}

export async function sharedHistory(sql, query, { select = selectPrivateRows } = {}) {
  const grants = await activeShares(sql, query);
  const page = grants.slice(0, SHARED_PAGE_SIZE);
  const owned = await ownedStoredRows(query.userId, page.map(row => row.id), select);
  const byId = new Map(owned.map(row => [row.id, row]));
  const stillGranted = new Set((await activeShares(sql, query)).map(row => row.id));
  const history = [];
  for (const grant of page) {
    const row = byId.get(grant.id);
    if (!row || !stillGranted.has(grant.id)) continue; // Removed/expired/revoked history never reappears.
    try {
      const analysis = sharedAnalysis(grant.analysis_json);
      if (analysis.modelVersion !== row.model_version) continue;
      history.push({ id: grant.id, userId: query.userId, source: row.source, originalName: row.original_name,
        createdAt: grant.created_at, consentedAt: grant.consented_at,
        retentionExpiresAt: grant.retention_expires_at, analysis,
        imageUrl: `/api/admin/shared-image?userId=${query.userId}&scanId=${grant.id}` });
    } catch { /* A corrupt stored result is not a finding. */ }
  }
  const last = page.at(-1);
  const nextCursor = grants.length > SHARED_PAGE_SIZE && last
    ? Buffer.from(JSON.stringify([new Date(last.created_at).toISOString(), last.id])).toString('base64url') : null;
  return { history, nextCursor };
}

export async function sharedImage(sql, query, { select = selectPrivateRows, download = downloadPrivateScanObject } = {}) {
  const [grant] = await activeShares(sql, query);
  if (!grant) throw new PublicAccountError('ไม่พบรายการที่ยังยินยอมแชร์', 404);
  const [row] = await ownedStoredRows(query.userId, [grant.id], select);
  if (!row) throw new PublicAccountError('ภาพนี้หมดอายุ ถูกลบ หรือถอนการแชร์แล้ว', 404);
  const analysis = sharedAnalysis(grant.analysis_json);
  if (analysis.modelVersion !== row.model_version) throw new PublicAccountError('ผลกับภาพไม่ตรงกัน', 404);
  const bytes = await download(row.image_object_path, Number(row.image_size_bytes));
  // Never stream an image after permission was withdrawn during a slow download.
  const stillGranted = await activeShares(sql, query);
  const stillOwned = await ownedStoredRows(query.userId, [grant.id], select);
  if (!stillGranted.length || !stillOwned.length) throw new PublicAccountError('รายการนี้ไม่พร้อมให้เข้าถึงแล้ว', 404);
  const mime = row.image_object_path.endsWith('.png') ? 'image/png'
    : row.image_object_path.endsWith('.webp') ? 'image/webp' : 'image/jpeg';
  return { bytes, mime };
}
