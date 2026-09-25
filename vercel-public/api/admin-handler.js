import { randomUUID } from 'node:crypto';
import {
  changeOwnPassword,
  clearSession,
  database,
  deleteOwnUser,
  issueSession,
  json,
  publicError,
  publicUserById,
  requestJson,
  requireGet,
  requirePost,
  requireSameOrigin,
  sessionClaims,
  takeRateBudget,
  verifyOwnPassword,
} from '../lib/account-auth.js';
import { beginMfaEnrollment, confirmMfaEnrollment, verifyMfaChallenge } from '../lib/admin-mfa.js';
import {
  countPrivateRows,
  createPrivateDownloadUrl,
  createPrivateUpload,
  deletePrivateRows,
  insertPrivateRow,
  isSupabasePrivateStorageConfigured,
  privateObjectExists,
  removePrivateObjects,
  selectPrivateRows,
  uploadPrivateObject,
  upsertPrivateRow,
} from '../lib/supabase-private.js';

function requestPath(req) {
  const value = req.query?.path;
  if (Array.isArray(value)) return value.join('/');
  return typeof value === 'string' ? value : '';
}

function rejectRateLimit(res, message, budget) {
  res.setHeader('Retry-After', String(budget.retryAfter));
  return json(res, 429, { ok: false, message });
}

async function signedInAdmin(req, res) {
  const claims = sessionClaims(req);
  if (!claims) {
    json(res, 401, { ok: false, message: 'กรุณาเข้าสู่ระบบ' });
    return null;
  }
  const user = await publicUserById(claims.sub);
  if (!user || user.role !== 'admin') {
    json(res, 403, { ok: false, message: 'หน้านี้สำหรับผู้ดูแลระบบ' });
    return null;
  }
  return { user, claims };
}

async function signedInApprovedUser(req, res) {
  const claims = sessionClaims(req);
  if (!claims) {
    json(res, 401, { ok: false, message: 'กรุณาเข้าสู่ระบบ' });
    return null;
  }
  const user = await publicUserById(claims.sub);
  if (!user || user.role !== 'user' || user.approvalStatus !== 'approved') {
    json(res, 403, { ok: false, message: 'บัญชีนี้ยังไม่มีสิทธิ์ใช้งาน' });
    return null;
  }
  return { user, claims };
}

async function overview(req, res) {
  if (!requireGet(req, res)) return;
  const admin = await signedInAdmin(req, res);
  if (!admin) return;
  const sql = await database();
  const [accountCount, adminCount, approvedUserCount, pendingUserCount, legacyScanCount, legacyFeedbackCount, users, legacyFeedbacks] = await Promise.all([
    sql`SELECT COUNT(*)::int AS value FROM smart_skin_users`,
    sql`SELECT COUNT(*)::int AS value FROM smart_skin_users WHERE role = 'admin'`,
    sql`SELECT COUNT(*)::int AS value FROM smart_skin_users WHERE role = 'user' AND approval_status = 'approved'`,
    sql`SELECT COUNT(*)::int AS value FROM smart_skin_users WHERE role = 'user' AND approval_status = 'pending'`,
    sql`SELECT COUNT(*)::int AS value FROM smart_skin_scan_logs`,
    sql`SELECT COUNT(*)::int AS value FROM smart_skin_feedback`,
    sql`SELECT id, display_name, email, approval_status, created_at, last_login_at
      FROM smart_skin_users WHERE role = 'user' ORDER BY id DESC LIMIT 100`,
    sql`SELECT feedback.id, feedback.message, feedback.created_at, users.display_name
      FROM smart_skin_feedback AS feedback
      JOIN smart_skin_users AS users ON users.id = feedback.user_id
      ORDER BY feedback.created_at DESC LIMIT 30`,
  ]);
  let scanCount = legacyScanCount[0].value;
  let feedbackCount = legacyFeedbackCount[0].value;
  let feedbacks = legacyFeedbacks;
  if (isSupabasePrivateStorageConfigured()) {
    const [privateScans, privateFeedbacks, privateFeedbackRows] = await Promise.all([
      countPrivateRows('smart_skin_scan_logs', '?select=id'),
      countPrivateRows('smart_skin_feedback', '?select=id'),
      selectPrivateRows('smart_skin_feedback', '?select=id,user_id,message,created_at&order=created_at.desc&limit=30'),
    ]);
    scanCount = privateScans;
    feedbackCount = privateFeedbacks;
    const usersById = new Map(users.map((user) => [String(user.id), user.display_name]));
    feedbacks = privateFeedbackRows.map((feedback) => ({
      id: feedback.id,
      message: feedback.message,
      created_at: feedback.created_at,
      display_name: usersById.get(String(feedback.user_id)) || 'ผู้ใช้ที่ลบบัญชีแล้ว',
    }));
  }
  return json(res, 200, {
    ok: true,
    admin: { name: admin.user.name, email: admin.user.email },
    counts: {
      accounts: accountCount[0].value,
      users: approvedUserCount[0].value,
      pendingUsers: pendingUserCount[0].value,
      admins: adminCount[0].value,
      scans: scanCount,
      feedbacks: feedbackCount,
    },
    users: users.map((user) => ({
      id: Number(user.id),
      name: user.display_name,
      email: user.email,
      approvalStatus: user.approval_status,
      createdAt: user.created_at,
      lastLoginAt: user.last_login_at,
    })),
    feedbacks: feedbacks.map((feedback) => ({
      id: feedback.id,
      name: feedback.display_name,
      message: feedback.message,
      createdAt: feedback.created_at,
    })),
  });
}

async function approveUser(req, res) {
  if (!requirePost(req, res) || !requireSameOrigin(req, res)) return;
  const budget = takeRateBudget(req, 'admin_approval');
  if (!budget.ok) return rejectRateLimit(res, 'ยืนยันบัญชีบ่อยเกินไป กรุณาลองใหม่ภายหลัง', budget);
  const admin = await signedInAdmin(req, res);
  if (!admin) return;
  const rawId = requestJson(req).userId;
  const userId = typeof rawId === 'number' ? rawId : Number(rawId);
  if (!Number.isSafeInteger(userId) || userId < 1) return json(res, 400, { ok: false, message: 'รหัสบัญชีผู้ใช้ไม่ถูกต้อง' });
  const sql = await database();
  const rows = await sql`UPDATE smart_skin_users
    SET approval_status = 'approved'
    WHERE id = ${userId} AND role = 'user' AND approval_status = 'pending'
    RETURNING id, display_name`;
  if (!rows[0]) return json(res, 409, { ok: false, message: 'บัญชีนี้ถูกยืนยันแล้ว หรือไม่พบบัญชีที่รอยืนยัน' });
  return json(res, 200, { ok: true, user: { id: Number(rows[0].id), name: rows[0].display_name }, message: 'ยืนยันบัญชีผู้ใช้เรียบร้อยแล้ว' });
}

function avatarPayload(value) {
  if (typeof value !== 'string') throw new Error('invalid-avatar');
  const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(value);
  if (!match) throw new Error('invalid-avatar');
  const bytes = Buffer.from(match[2], 'base64');
  if (!bytes.length || bytes.length > 400 * 1024) throw new Error('invalid-avatar');
  return { dataUrl: `data:${match[1]};base64,${bytes.toString('base64')}`, mimeType: match[1], bytes };
}

function avatarObjectPath(userId, mimeType) {
  const extension = mimeType === 'image/png' ? 'png' : mimeType === 'image/webp' ? 'webp' : 'jpg';
  return `avatars/${userId}/${randomUUID()}.${extension}`;
}

const NEARBY_CONTEXT_RETENTION_HOURS = 24;
// Supabase signed upload URLs currently have a fixed two-hour validity. Keep
// the local authorization record on the same bounded lifetime so an accepted
// signed URL never outlives the server-side pending-upload record.
const PENDING_SCAN_UPLOAD_TTL_MS = 2 * 60 * 60 * 1000;

function nearbyNumber(body, key, minimum, maximum) {
  const value = body[key];
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${key} อยู่นอกช่วงที่อนุญาต`);
  }
  return value;
}

function environmentalContextLevel(pm25, uvIndex, relativeHumidity, temperatureC) {
  const notices = [];
  if (uvIndex >= 6) notices.push('ดัชนี UV สูง ควรหลีกเลี่ยงแดดจัดและป้องกันผิว');
  if (pm25 >= 37.5) notices.push('PM2.5 สูง ควรลดการสัมผัสฝุ่นเมื่อทำได้');
  if (temperatureC >= 33 && relativeHumidity >= 70) notices.push('อากาศร้อนชื้น ควรรักษาผิวให้สะอาดและแห้งสบาย');
  if (notices.length >= 2) return { level: 'ควรระวังมาก', summary: notices.join(' · ') };
  if (notices.length) return { level: 'ควรระวัง', summary: notices.join(' · ') };
  return {
    level: 'ข้อมูลทั่วไป',
    summary: 'ไม่พบเงื่อนไขแจ้งเตือนจากกติกาสิ่งแวดล้อมของระบบ',
  };
}

function nearbyContextResponse(row) {
  if (!row) return null;
  return {
    latitudeApprox: Number(row.latitude_approx),
    longitudeApprox: Number(row.longitude_approx),
    pm25: Number(row.pm25),
    uvIndex: Number(row.uv_index),
    relativeHumidity: Number(row.relative_humidity),
    temperatureC: Number(row.temperature_c),
    contextLevel: row.context_level,
    contextSummary: row.context_summary,
    updatedAt: row.consented_at,
    retentionExpiresAt: row.retention_expires_at,
  };
}

async function userProfile(req, res) {
  if (!requireGet(req, res)) return;
  const account = await signedInApprovedUser(req, res);
  if (!account) return;
  if (isSupabasePrivateStorageConfigured()) {
    const rows = await selectPrivateRows('smart_skin_profile_avatars', `?select=object_path,updated_at&user_id=eq.${encodeURIComponent(account.user.id)}&limit=1`);
    const avatar = rows[0];
    if (!avatar) return json(res, 200, { ok: true, user: account.user, avatar: null });
    const dataUrl = await createPrivateDownloadUrl(avatar.object_path, 60);
    return json(res, 200, { ok: true, user: account.user, avatar: { dataUrl, updatedAt: avatar.updated_at } });
  }
  const sql = await database();
  const rows = await sql`SELECT data_uri, updated_at FROM smart_skin_profile_avatars WHERE user_id = ${account.user.id}`;
  const avatar = rows[0];
  return json(res, 200, { ok: true, user: account.user, avatar: avatar ? { dataUrl: avatar.data_uri, updatedAt: avatar.updated_at } : null });
}

async function updateAvatar(req, res) {
  if (!requirePost(req, res) || !requireSameOrigin(req, res)) return;
  const budget = takeRateBudget(req, 'user_profile');
  if (!budget.ok) return rejectRateLimit(res, 'อัปเดตรูปโปรไฟล์บ่อยเกินไป กรุณาลองใหม่ภายหลัง', budget);
  const account = await signedInApprovedUser(req, res);
  if (!account) return;
  let avatar;
  try { avatar = avatarPayload(requestJson(req).dataUrl); }
  catch { return json(res, 400, { ok: false, message: 'รูปโปรไฟล์ต้องเป็น JPEG, PNG หรือ WEBP ที่มีขนาดไม่เกิน 400 KB' }); }
  if (isSupabasePrivateStorageConfigured()) {
    const previousRows = await selectPrivateRows('smart_skin_profile_avatars', `?select=object_path&user_id=eq.${encodeURIComponent(account.user.id)}&limit=1`);
    const objectPath = avatarObjectPath(account.user.id, avatar.mimeType);
    await uploadPrivateObject(objectPath, avatar.bytes, avatar.mimeType);
    let saved;
    try {
      saved = await upsertPrivateRow('smart_skin_profile_avatars', {
        user_id: Number(account.user.id), object_path: objectPath, updated_at: new Date().toISOString(), retention_expires_at: null,
      }, 'user_id');
    } catch (error) {
      await removePrivateObjects([objectPath]).catch(() => {});
      throw error;
    }
    const previousPath = previousRows[0]?.object_path;
    if (previousPath && previousPath !== objectPath) await removePrivateObjects([previousPath]);
    const dataUrl = await createPrivateDownloadUrl(objectPath, 60);
    return json(res, 200, { ok: true, avatar: { dataUrl, updatedAt: saved[0]?.updated_at || new Date().toISOString() }, message: 'บันทึกรูปโปรไฟล์เรียบร้อยแล้ว' });
  }
  const sql = await database();
  const rows = await sql`INSERT INTO smart_skin_profile_avatars (user_id, data_uri, updated_at)
    VALUES (${account.user.id}, ${avatar.dataUrl}, NOW())
    ON CONFLICT (user_id) DO UPDATE SET data_uri = EXCLUDED.data_uri, updated_at = NOW()
    RETURNING data_uri, updated_at`;
  return json(res, 200, { ok: true, avatar: { dataUrl: rows[0].data_uri, updatedAt: rows[0].updated_at }, message: 'บันทึกรูปโปรไฟล์เรียบร้อยแล้ว' });
}

async function removeAvatar(req, res) {
  if (!requirePost(req, res) || !requireSameOrigin(req, res)) return;
  const budget = takeRateBudget(req, 'user_profile');
  if (!budget.ok) return rejectRateLimit(res, 'ลบรูปโปรไฟล์บ่อยเกินไป กรุณาลองใหม่ภายหลัง', budget);
  const account = await signedInApprovedUser(req, res);
  if (!account) return;
  if (isSupabasePrivateStorageConfigured()) {
    const previousRows = await selectPrivateRows('smart_skin_profile_avatars', `?select=object_path&user_id=eq.${encodeURIComponent(account.user.id)}&limit=1`);
    const removed = await deletePrivateRows('smart_skin_profile_avatars', `?user_id=eq.${encodeURIComponent(account.user.id)}`);
    const objectPath = previousRows[0]?.object_path;
    if (objectPath) await removePrivateObjects([objectPath]);
    return json(res, 200, { ok: true, message: removed?.length ? 'ลบรูปโปรไฟล์เรียบร้อยแล้ว' : 'ไม่พบรูปโปรไฟล์ที่ต้องลบ' });
  }
  const sql = await database();
  await sql`DELETE FROM smart_skin_profile_avatars WHERE user_id = ${account.user.id}`;
  return json(res, 200, { ok: true, message: 'ลบรูปโปรไฟล์เรียบร้อยแล้ว' });
}

async function userHistory(req, res) {
  if (!requireGet(req, res)) return;
  const account = await signedInApprovedUser(req, res);
  if (!account) return;
  if (isSupabasePrivateStorageConfigured()) {
    try {
      const now = new Date().toISOString();
      const expired = await deletePrivateRows('smart_skin_scan_logs', `?user_id=eq.${encodeURIComponent(account.user.id)}&retention_expires_at=lte.${encodeURIComponent(now)}&select=image_object_path,gradcam_object_path`);
      const expiredPaths = (Array.isArray(expired) ? expired : []).flatMap((row) => [row.image_object_path, row.gradcam_object_path]).filter(Boolean);
      if (expiredPaths.length) await removePrivateObjects(expiredPaths);
      const rows = await selectPrivateRows('smart_skin_scan_logs', `?select=id,source,original_name,image_size_bytes,result_disease,confidence,created_at,decision_status&user_id=eq.${encodeURIComponent(account.user.id)}&retention_expires_at=gt.${encodeURIComponent(now)}&order=created_at.desc&limit=50`);
      return json(res, 200, { ok: true, history: rows.map((item) => ({
        id: item.id,
        source: item.source || 'upload',
        originalName: item.original_name,
        imageSizeBytes: item.image_size_bytes,
        resultLabel: item.result_disease,
        confidence: item.confidence === null || item.confidence === undefined || item.confidence === '' ? null : Number(item.confidence),
        createdAt: item.created_at,
        decisionStatus: item.decision_status,
      })) });
    } catch (error) {
      // A temporary object-storage fault must not block a person from opening
      // their account timeline. Continue with records stored in the account
      // database; do not expose the upstream error or any credentials.
    }
  }
  const sql = await database();
  const rows = await sql`SELECT id, source, original_name, image_size_bytes, result_label, confidence, created_at
    FROM smart_skin_scan_logs WHERE user_id = ${account.user.id} ORDER BY created_at DESC LIMIT 50`;
  return json(res, 200, { ok: true, history: rows.map((item) => ({
    id: Number(item.id), source: item.source, originalName: item.original_name, imageSizeBytes: item.image_size_bytes,
    resultLabel: item.result_label, confidence: item.confidence === null ? null : Number(item.confidence), createdAt: item.created_at,
  })) });
}

async function privateStorageStatus(req, res) {
  if (!requireGet(req, res)) return;
  const account = await signedInApprovedUser(req, res);
  if (!account) return;
  return json(res, 200, { ok: true, configured: isSupabasePrivateStorageConfigured() });
}

function scanRetentionDays() {
  const configured = Number(process.env.SMART_SKIN_SCAN_RETENTION_DAYS || 30);
  return Number.isInteger(configured) && configured >= 1 && configured <= 365 ? configured : 30;
}

function validateScanRequest(body) {
  const originalName = typeof body.originalName === 'string' ? body.originalName.trim() : '';
  const mimeType = typeof body.mimeType === 'string' ? body.mimeType : '';
  const source = body.source === 'camera' ? 'camera' : body.source === 'upload' ? 'upload' : '';
  const imageSizeBytes = body.imageSizeBytes;
  if (body.consent !== true) throw new PublicAccountError('กรุณายืนยันสิทธิ์และความยินยอมก่อนส่งภาพ');
  if (!originalName || originalName.length > 255 || /[\u0000-\u001f\u007f]/.test(originalName)) throw new PublicAccountError('ชื่อไฟล์รูปภาพไม่ถูกต้อง');
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(mimeType)) throw new PublicAccountError('รองรับเฉพาะภาพ JPG, PNG และ WEBP');
  if (!Number.isSafeInteger(imageSizeBytes) || imageSizeBytes < 1 || imageSizeBytes > 8 * 1024 * 1024) throw new PublicAccountError('ขนาดรูปภาพต้องไม่เกิน 8 MB');
  if (!source) throw new PublicAccountError('แหล่งที่มาของรูปภาพไม่ถูกต้อง');
  return { originalName, mimeType, source, imageSizeBytes };
}

function scanObjectPath(userId, mimeType) {
  const extension = mimeType === 'image/png' ? 'png' : mimeType === 'image/webp' ? 'webp' : 'jpg';
  return `scans/${userId}/${randomUUID()}.${extension}`;
}

async function removeExpiredPendingScans(sql) {
  const rows = await sql`DELETE FROM smart_skin_pending_scan_uploads WHERE expires_at <= NOW() RETURNING object_path`;
  if (rows.length && isSupabasePrivateStorageConfigured()) {
    await removePrivateObjects(rows.map((row) => row.object_path));
  }
}

async function startScanUpload(req, res) {
  if (!requirePost(req, res) || !requireSameOrigin(req, res)) return;
  const budget = takeRateBudget(req, 'user_scan');
  if (!budget.ok) return rejectRateLimit(res, 'ส่งภาพบ่อยเกินไป กรุณาลองใหม่ภายหลัง', budget);
  const account = await signedInApprovedUser(req, res);
  if (!account) return;
  if (!isSupabasePrivateStorageConfigured()) return json(res, 503, { ok: false, message: 'ระบบจัดเก็บภาพส่วนตัวยังไม่ได้เชื่อมต่อ Supabase' });
  let details;
  try { details = validateScanRequest(requestJson(req)); }
  catch (error) { return json(res, error.status || 400, { ok: false, message: error.message || 'ข้อมูลรูปภาพไม่ถูกต้อง' }); }
  const sql = await database();
  await removeExpiredPendingScans(sql);
  const id = randomUUID();
  const objectPath = scanObjectPath(account.user.id, details.mimeType);
  const expiresAt = new Date(Date.now() + PENDING_SCAN_UPLOAD_TTL_MS);
  await sql`INSERT INTO smart_skin_pending_scan_uploads (
      id, user_id, object_path, original_name, mime_type, image_size_bytes, source, expires_at
    ) VALUES (
      ${id}, ${account.user.id}, ${objectPath}, ${details.originalName}, ${details.mimeType},
      ${details.imageSizeBytes}, ${details.source}, ${expiresAt}
    )`;
  let upload;
  try {
    upload = await createPrivateUpload(objectPath);
  } catch (error) {
    await sql`DELETE FROM smart_skin_pending_scan_uploads WHERE id = ${id}`;
    throw error;
  }
  return json(res, 201, {
    ok: true,
    upload: { id, url: upload.uploadUrl, expiresAt: expiresAt.toISOString(), mimeType: details.mimeType },
  });
}

async function completeScanUpload(req, res) {
  if (!requirePost(req, res) || !requireSameOrigin(req, res)) return;
  const account = await signedInApprovedUser(req, res);
  if (!account) return;
  const uploadId = typeof requestJson(req).uploadId === 'string' ? requestJson(req).uploadId : '';
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(uploadId)) return json(res, 400, { ok: false, message: 'รหัสอัปโหลดไม่ถูกต้อง' });
  const sql = await database();
  await removeExpiredPendingScans(sql);
  const rows = await sql`SELECT id, object_path, original_name, image_size_bytes, source
    FROM smart_skin_pending_scan_uploads WHERE id = ${uploadId} AND user_id = ${account.user.id} AND expires_at > NOW()`;
  const pending = rows[0];
  if (!pending) return json(res, 404, { ok: false, message: 'สิทธิ์อัปโหลดหมดอายุหรือไม่พบรายการ กรุณาเริ่มใหม่' });
  if (!await privateObjectExists(pending.object_path)) return json(res, 409, { ok: false, message: 'ยังไม่พบรูปภาพที่อัปโหลด กรุณาลองส่งภาพอีกครั้ง' });
  const retentionExpiresAt = new Date(Date.now() + scanRetentionDays() * 24 * 60 * 60 * 1000).toISOString();
  const saved = await insertPrivateRow('smart_skin_scan_logs', {
    user_id: Number(account.user.id),
    image_object_path: pending.object_path,
    source: pending.source,
    original_name: pending.original_name,
    image_size_bytes: Number(pending.image_size_bytes),
    result_disease: 'บันทึกภาพเพื่อการตรวจทาน',
    confidence: null,
    consent_version: 'vercel-supabase-v1',
    retention_expires_at: retentionExpiresAt,
    top_predictions: [],
    is_uncertain: true,
    decision_status: 'image_received',
    model_version: null,
  });
  await sql`DELETE FROM smart_skin_pending_scan_uploads WHERE id = ${uploadId} AND user_id = ${account.user.id}`;
  const scan = saved[0] || {};
  return json(res, 201, {
    ok: true,
    scan: {
      id: scan.id,
      source: pending.source,
      originalName: pending.original_name,
      imageSizeBytes: Number(pending.image_size_bytes),
      resultLabel: scan.result_disease || 'บันทึกภาพเพื่อการตรวจทาน',
      createdAt: scan.created_at || new Date().toISOString(),
      retentionExpiresAt,
    },
    message: 'จัดเก็บภาพไว้ในพื้นที่ส่วนตัวเรียบร้อยแล้ว ยังไม่มีผลวินิจฉัยจากโมเดล',
  });
}

async function userNearbyContext(req, res) {
  if (!requireGet(req, res)) return;
  const account = await signedInApprovedUser(req, res);
  if (!account) return;
  if (isSupabasePrivateStorageConfigured()) {
    try {
      const now = new Date().toISOString();
      await deletePrivateRows('smart_skin_nearby_context', `?user_id=eq.${encodeURIComponent(account.user.id)}&retention_expires_at=lte.${encodeURIComponent(now)}`);
      const rows = await selectPrivateRows('smart_skin_nearby_context', `?select=latitude_approx,longitude_approx,pm25,uv_index,relative_humidity,temperature_c,context_level,context_summary,consented_at,retention_expires_at&user_id=eq.${encodeURIComponent(account.user.id)}&retention_expires_at=gt.${encodeURIComponent(now)}&limit=1`);
      return json(res, 200, { ok: true, context: nearbyContextResponse(rows[0]) });
    } catch (error) {
      // The radar remains useful during a private-storage outage. Fall back to
      // the account database, which stores only the same coarse, expiring
      // context and never precise GPS or a location history.
    }
  }
  const sql = await database();
  // Expired contexts are never returned and are removed when this account is
  // next accessed. This keeps the store to one current coarse context only.
  await sql`DELETE FROM smart_skin_nearby_context_reports
    WHERE user_id = ${account.user.id} AND retention_expires_at <= NOW()`;
  const rows = await sql`SELECT latitude_approx, longitude_approx, pm25, uv_index,
      relative_humidity, temperature_c, context_level, context_summary,
      consented_at, retention_expires_at
    FROM smart_skin_nearby_context_reports
    WHERE user_id = ${account.user.id} AND retention_expires_at > NOW()`;
  return json(res, 200, { ok: true, context: nearbyContextResponse(rows[0]) });
}

async function saveNearbyContext(req, res) {
  if (!requirePost(req, res) || !requireSameOrigin(req, res)) return;
  const budget = takeRateBudget(req, 'user_nearby_context');
  if (!budget.ok) return rejectRateLimit(res, 'ส่งข้อมูลบริบทพื้นที่บ่อยเกินไป กรุณาลองใหม่ภายหลัง', budget);
  const account = await signedInApprovedUser(req, res);
  if (!account) return;
  const body = requestJson(req);
  if (body.consent !== true) return json(res, 400, { ok: false, message: 'ต้องยืนยันความยินยอมก่อนบันทึกบริบทพื้นที่' });

  let latitude;
  let longitude;
  let pm25;
  let uvIndex;
  let relativeHumidity;
  let temperatureC;
  try {
    latitude = nearbyNumber(body, 'latitude', -90, 90);
    longitude = nearbyNumber(body, 'longitude', -180, 180);
    pm25 = nearbyNumber(body, 'pm25', 0, 1000);
    uvIndex = nearbyNumber(body, 'uvIndex', 0, 30);
    relativeHumidity = nearbyNumber(body, 'relativeHumidity', 0, 100);
    temperatureC = nearbyNumber(body, 'temperatureC', -90, 70);
  } catch (error) {
    return json(res, 400, { ok: false, message: error.message });
  }

  // Discard GPS precision before persistence. Two decimal places are a coarse
  // coordinate grid (roughly 1 km), not a route or a circular detector.
  const latitudeApprox = Math.round(latitude * 100) / 100;
  const longitudeApprox = Math.round(longitude * 100) / 100;
  const notice = environmentalContextLevel(pm25, uvIndex, relativeHumidity, temperatureC);
  const retentionExpiresAt = new Date(Date.now() + NEARBY_CONTEXT_RETENTION_HOURS * 60 * 60 * 1000);
  if (isSupabasePrivateStorageConfigured()) {
    try {
      const saved = await upsertPrivateRow('smart_skin_nearby_context', {
        user_id: Number(account.user.id), latitude_approx: latitudeApprox, longitude_approx: longitudeApprox,
        pm25, uv_index: uvIndex, relative_humidity: relativeHumidity, temperature_c: temperatureC,
        context_level: notice.level, context_summary: notice.summary,
        consented_at: new Date().toISOString(), retention_expires_at: retentionExpiresAt.toISOString(),
      }, 'user_id');
      return json(res, 201, { ok: true, context: nearbyContextResponse(saved[0]), message: 'บันทึกบริบทพื้นที่โดยประมาณล่าสุดแล้ว' });
    } catch (error) {
      // Continue below using the account database. The value is already
      // rounded to a coarse grid and expires under the same retention rule.
    }
  }
  const sql = await database();
  const rows = await sql`INSERT INTO smart_skin_nearby_context_reports (
      user_id, latitude_approx, longitude_approx, pm25, uv_index,
      relative_humidity, temperature_c, context_level, context_summary,
      consented_at, retention_expires_at, created_at
    ) VALUES (
      ${account.user.id}, ${latitudeApprox}, ${longitudeApprox}, ${pm25}, ${uvIndex},
      ${relativeHumidity}, ${temperatureC}, ${notice.level}, ${notice.summary},
      NOW(), ${retentionExpiresAt}, NOW()
    ) ON CONFLICT (user_id) DO UPDATE SET
      latitude_approx = EXCLUDED.latitude_approx,
      longitude_approx = EXCLUDED.longitude_approx,
      pm25 = EXCLUDED.pm25,
      uv_index = EXCLUDED.uv_index,
      relative_humidity = EXCLUDED.relative_humidity,
      temperature_c = EXCLUDED.temperature_c,
      context_level = EXCLUDED.context_level,
      context_summary = EXCLUDED.context_summary,
      consented_at = NOW(),
      retention_expires_at = EXCLUDED.retention_expires_at,
      created_at = NOW()
    RETURNING latitude_approx, longitude_approx, pm25, uv_index,
      relative_humidity, temperature_c, context_level, context_summary,
      consented_at, retention_expires_at`;
  return json(res, 201, { ok: true, context: nearbyContextResponse(rows[0]), message: 'บันทึกบริบทพื้นที่โดยประมาณล่าสุดแล้ว' });
}

async function deleteNearbyContext(req, res) {
  if (!requirePost(req, res) || !requireSameOrigin(req, res)) return;
  const account = await signedInApprovedUser(req, res);
  if (!account) return;
  if (isSupabasePrivateStorageConfigured()) {
    try {
      const rows = await deletePrivateRows('smart_skin_nearby_context', `?user_id=eq.${encodeURIComponent(account.user.id)}`);
      return json(res, 200, {
        ok: true,
        message: rows?.length ? 'ลบตำแหน่งโดยประมาณและบริบทสภาพแวดล้อมล่าสุดแล้ว' : 'ไม่พบข้อมูลบริบทพื้นที่ที่ต้องลบ',
      });
    } catch (error) {
      // A fallback record may still be removed below. Do not expose a storage
      // credential failure to the browser.
    }
  }
  const sql = await database();
  const rows = await sql`DELETE FROM smart_skin_nearby_context_reports
    WHERE user_id = ${account.user.id} RETURNING id`;
  return json(res, 200, {
    ok: true,
    message: rows[0] ? 'ลบตำแหน่งโดยประมาณและบริบทสภาพแวดล้อมล่าสุดแล้ว' : 'ไม่พบข้อมูลบริบทพื้นที่ที่ต้องลบ',
  });
}

async function changePassword(req, res) {
  if (!requirePost(req, res) || !requireSameOrigin(req, res)) return;
  const budget = takeRateBudget(req, 'user_sensitive');
  if (!budget.ok) return rejectRateLimit(res, 'เปลี่ยนรหัสผ่านบ่อยเกินไป กรุณาลองใหม่ภายหลัง', budget);
  const account = await signedInApprovedUser(req, res);
  if (!account) return;
  const body = requestJson(req);
  await changeOwnPassword(account.user.id, { currentPassword: body.currentPassword, newPassword: body.newPassword, confirmation: body.confirmation });
  return json(res, 200, { ok: true, message: 'เปลี่ยนรหัสผ่านเรียบร้อยแล้ว' });
}

async function sendFeedback(req, res) {
  if (!requirePost(req, res) || !requireSameOrigin(req, res)) return;
  const budget = takeRateBudget(req, 'user_feedback');
  if (!budget.ok) return rejectRateLimit(res, 'ส่งข้อความบ่อยเกินไป กรุณาลองใหม่ภายหลัง', budget);
  const account = await signedInApprovedUser(req, res);
  if (!account) return;
  const message = typeof requestJson(req).message === 'string' ? requestJson(req).message.trim() : '';
  if (!message || message.length > 2000 || /[\u0000-\u001f\u007f]/.test(message)) return json(res, 400, { ok: false, message: 'กรุณาระบุข้อความที่ถูกต้องและยาวไม่เกิน 2,000 ตัวอักษร' });
  if (isSupabasePrivateStorageConfigured()) {
    const retentionExpiresAt = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString();
    await insertPrivateRow('smart_skin_feedback', {
      user_id: Number(account.user.id), topic: 'general', message, retention_expires_at: retentionExpiresAt,
    });
  } else {
    const sql = await database();
    await sql`INSERT INTO smart_skin_feedback (user_id, message) VALUES (${account.user.id}, ${message})`;
  }
  return json(res, 201, { ok: true, message: 'ส่งข้อความถึงผู้ดูแลระบบเรียบร้อยแล้ว' });
}

async function deletePrivateUserData(userId) {
  if (!isSupabasePrivateStorageConfigured()) return;
  const filter = `?user_id=eq.${encodeURIComponent(userId)}`;
  const [scans, avatars] = await Promise.all([
    selectPrivateRows('smart_skin_scan_logs', `${filter}&select=image_object_path,gradcam_object_path`),
    selectPrivateRows('smart_skin_profile_avatars', `${filter}&select=object_path`),
  ]);
  const paths = [
    ...scans.flatMap((scan) => [scan.image_object_path, scan.gradcam_object_path]),
    ...avatars.map((avatar) => avatar.object_path),
  ].filter(Boolean);
  if (paths.length) await removePrivateObjects(paths);
  await Promise.all([
    deletePrivateRows('smart_skin_scan_logs', filter),
    deletePrivateRows('smart_skin_feedback', filter),
    deletePrivateRows('smart_skin_nearby_context', filter),
    deletePrivateRows('smart_skin_profile_avatars', filter),
  ]);
}

async function deleteScanHistory(req, res) {
  if (!requirePost(req, res) || !requireSameOrigin(req, res)) return;
  const budget = takeRateBudget(req, 'user_sensitive');
  if (!budget.ok) return rejectRateLimit(res, 'ส่งคำขอลบประวัติบ่อยเกินไป กรุณาลองใหม่ภายหลัง', budget);
  const account = await signedInApprovedUser(req, res);
  if (!account) return;
  const body = requestJson(req);
  if (body.confirmed !== true) return json(res, 400, { ok: false, message: 'กรุณาติ๊กยืนยันก่อนลบประวัติการแสกน' });
  await verifyOwnPassword(account.user.id, body.password);

  const sql = await database();
  const pendingRows = await sql`SELECT object_path FROM smart_skin_pending_scan_uploads
    WHERE user_id = ${account.user.id}`;
  let privateDeleteComplete = true;
  if (isSupabasePrivateStorageConfigured()) {
    try {
      const filter = `?user_id=eq.${encodeURIComponent(account.user.id)}`;
      const scans = await selectPrivateRows('smart_skin_scan_logs', `${filter}&select=image_object_path,gradcam_object_path`);
      const paths = [
        ...scans.flatMap((scan) => [scan.image_object_path, scan.gradcam_object_path]),
        ...pendingRows.map((row) => row.object_path),
      ].filter(Boolean);
      if (paths.length) await removePrivateObjects(paths);
      await deletePrivateRows('smart_skin_scan_logs', filter);
    } catch (error) {
      privateDeleteComplete = false;
    }
  }
  await sql`DELETE FROM smart_skin_pending_scan_uploads WHERE user_id = ${account.user.id}`;
  await sql`DELETE FROM smart_skin_scan_logs WHERE user_id = ${account.user.id}`;
  return json(res, 200, {
    ok: true,
    complete: privateDeleteComplete,
    message: privateDeleteComplete
      ? 'ลบประวัติการแสกนและภาพที่เกี่ยวข้องทั้งหมดแล้ว โดยบัญชีของคุณยังใช้งานได้ตามปกติ'
      : 'ลบประวัติในบัญชีแล้ว แต่พื้นที่จัดเก็บภาพส่วนตัวยังไม่พร้อม กรุณาส่งข้อความถึงผู้ดูแลเพื่อยืนยันการลบภาพอีกครั้ง',
  });
}

async function deleteAccount(req, res) {
  if (!requirePost(req, res) || !requireSameOrigin(req, res)) return;
  const budget = takeRateBudget(req, 'user_sensitive');
  if (!budget.ok) return rejectRateLimit(res, 'ส่งคำขอลบบัญชีบ่อยเกินไป กรุณาลองใหม่ภายหลัง', budget);
  const account = await signedInApprovedUser(req, res);
  if (!account) return;
  const body = requestJson(req);
  if (body.confirmation !== 'DELETE') return json(res, 400, { ok: false, message: 'กรุณาพิมพ์ DELETE เพื่อยืนยันการลบบัญชี' });
  await deleteOwnUser(account.user.id, body.password, () => deletePrivateUserData(account.user.id));
  clearSession(res);
  return json(res, 200, { ok: true, message: 'ลบบัญชีและข้อมูลที่เกี่ยวข้องเรียบร้อยแล้ว' });
}

async function enrollmentStart(req, res) {
  if (!requirePost(req, res) || !requireSameOrigin(req, res)) return;
  const budget = takeRateBudget(req, 'admin_mfa');
  if (!budget.ok) return rejectRateLimit(res, 'ลองตั้งค่า MFA มากเกินไป กรุณาลองใหม่ภายหลัง', budget);
  const admin = await signedInAdmin(req, res);
  if (!admin) return;
  if (admin.user.mfaEnrolled) return json(res, 409, { ok: false, message: 'บัญชีนี้เปิด MFA แล้ว' });
  const enrollment = await beginMfaEnrollment(admin.user);
  return json(res, 200, { ok: true, enrollment });
}

async function enrollmentConfirm(req, res) {
  if (!requirePost(req, res) || !requireSameOrigin(req, res)) return;
  const budget = takeRateBudget(req, 'admin_mfa');
  if (!budget.ok) return rejectRateLimit(res, 'ลองยืนยัน MFA มากเกินไป กรุณาลองใหม่ภายหลัง', budget);
  const admin = await signedInAdmin(req, res);
  if (!admin) return;
  if (admin.user.mfaEnrolled) return json(res, 409, { ok: false, message: 'บัญชีนี้เปิด MFA แล้ว' });
  const { enrollmentId, code } = requestJson(req);
  await confirmMfaEnrollment(admin.user.id, enrollmentId, code);
  issueSession(res, admin.user.id, { mfaVerified: true });
  return json(res, 200, {
    ok: true,
    user: { ...admin.user, mfaEnrolled: true, mfaVerified: true },
    message: 'เชื่อม MFA สำเร็จแล้ว',
  });
}

async function mfaVerify(req, res) {
  if (!requirePost(req, res) || !requireSameOrigin(req, res)) return;
  const budget = takeRateBudget(req, 'admin_mfa');
  if (!budget.ok) return rejectRateLimit(res, 'ลองยืนยัน MFA มากเกินไป กรุณาลองใหม่ภายหลัง', budget);
  const { challengeId, code } = requestJson(req);
  const userId = await verifyMfaChallenge(challengeId, code);
  const user = await publicUserById(userId);
  if (!user || user.role !== 'admin' || !user.mfaEnrolled) return json(res, 403, { ok: false, message: 'ไม่สามารถยืนยันสิทธิ์ผู้ดูแลระบบได้' });
  issueSession(res, user.id, { mfaVerified: true });
  return json(res, 200, { ok: true, user: { ...user, mfaVerified: true }, message: 'ยืนยัน MFA สำเร็จแล้ว' });
}

async function mfaStatus(req, res) {
  if (!requireGet(req, res)) return;
  const admin = await signedInAdmin(req, res);
  if (!admin) return;
  return json(res, 200, { ok: true, mfaEnrolled: admin.user.mfaEnrolled, mfaVerified: admin.claims.mfaVerified });
}

export default async function handler(req, res) {
  try {
    switch (requestPath(req)) {
      case 'overview': return await overview(req, res);
      case 'approve-user': return await approveUser(req, res);
      case 'user/profile': return await userProfile(req, res);
      case 'user/avatar': return await updateAvatar(req, res);
      case 'user/avatar/remove': return await removeAvatar(req, res);
      case 'user/storage-status': return await privateStorageStatus(req, res);
      case 'user/history': return await userHistory(req, res);
      case 'user/scan/upload': return await startScanUpload(req, res);
      case 'user/scan/complete': return await completeScanUpload(req, res);
      case 'user/scan/delete-all': return await deleteScanHistory(req, res);
      case 'user/nearby-context': return await userNearbyContext(req, res);
      case 'user/nearby-context/save': return await saveNearbyContext(req, res);
      case 'user/nearby-context/delete': return await deleteNearbyContext(req, res);
      case 'user/password': return await changePassword(req, res);
      case 'user/feedback': return await sendFeedback(req, res);
      case 'user/delete': return await deleteAccount(req, res);
      case 'mfa/enroll': return await enrollmentStart(req, res);
      case 'mfa/confirm': return await enrollmentConfirm(req, res);
      case 'mfa/verify': return await mfaVerify(req, res);
      case 'mfa/status': return await mfaStatus(req, res);
      default: return json(res, 404, { ok: false, message: 'ไม่พบปลายทางผู้ดูแลระบบ' });
    }
  } catch (error) {
    return publicError(res, error, 'admin');
  }
}
