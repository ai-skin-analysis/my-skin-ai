import { PublicAccountError } from './account-auth.js';

export const PRIVATE_BUCKET = 'smart-skin-private';
// The public project endpoint is intentionally not secret. It lets the live
// deployment recover when an older Vercel URL variable is malformed; the
// server-only secret key is still required for every data operation.
const DEPLOYMENT_SUPABASE_URL = 'https://gpkvjwiblvnqjrreukox.supabase.co';

function normalizedSupabaseUrl(value) {
  // Environment-variable screens sometimes preserve quotes or an accidentally
  // pasted KEY=value pair. Accept those harmless forms without exposing the
  // configured value to a browser or response body.
  return String(value || '')
    .trim()
    .replace(/^SUPABASE_URL\s*=\s*/i, '')
    .replace(/^["'`]+|["'`]+$/g, '')
    .trim()
    .replace(/\/+$/, '');
}

function normalizedSecretKey(value) {
  // Accept values copied from an .env file or an Authorization header without
  // ever returning the key to the browser, logs, or a response body.
  return String(value || '')
    .trim()
    .replace(/^SUPABASE_(?:SECRET|SERVICE_ROLE)_KEY\s*=\s*/i, '')
    .replace(/^Bearer\s+/i, '')
    .replace(/^["'`]+|["'`]+$/g, '')
    .trim();
}

function configuredSecretKey() {
  const current = normalizedSecretKey(process.env.SUPABASE_SECRET_KEY);
  const legacy = normalizedSecretKey(process.env.SUPABASE_SERVICE_ROLE_KEY);
  // A current secret key has priority, but a usable legacy key still permits
  // existing deployments to keep operating during a credential rotation.
  if (current.startsWith('sb_secret_')) return current;
  if (legacy) return legacy;
  return current;
}

function configuration() {
  let baseUrl = normalizedSupabaseUrl(process.env.SUPABASE_URL) || DEPLOYMENT_SUPABASE_URL;
  // Prefer the current secret key. The legacy service_role name remains only
  // for existing projects while they rotate keys before its 2026 retirement.
  const secretKey = configuredSecretKey();
  if (!baseUrl || !secretKey) {
    throw new PublicAccountError('ระบบจัดเก็บภาพส่วนตัวยังไม่ได้เชื่อมต่อ กรุณาตั้งค่า Supabase ก่อนใช้งาน', 503);
  }
  let parsed;
  try { parsed = new URL(baseUrl); }
  catch {
    // Preserve a valid custom URL where one exists, but recover this deployed
    // project from a malformed legacy value instead of blocking every upload.
    baseUrl = DEPLOYMENT_SUPABASE_URL;
    parsed = new URL(baseUrl);
  }
  if (parsed.protocol !== 'https:') throw new PublicAccountError('การตั้งค่า Supabase ต้องใช้ HTTPS', 503);
  return { baseUrl, secretKey };
}

export function isSupabasePrivateStorageConfigured() {
  return Boolean(configuredSecretKey());
}

function objectPath(path) {
  return String(path).split('/').map((part) => encodeURIComponent(part)).join('/');
}

function privateHeaders(secretKey) {
  // Current sb_secret keys must be sent in apikey, not Authorization. Legacy
  // JWT service_role keys still use the historical Bearer header as well.
  return secretKey.startsWith('sb_')
    ? { apikey: secretKey }
    : { apikey: secretKey, authorization: `Bearer ${secretKey}` };
}

function upstreamFailure(response, data) {
  const reason = [data?.message, data?.error, data?.statusCode].find((value) => typeof value === 'string') || '';
  let message = 'ไม่สามารถจัดการข้อมูลส่วนตัวได้ กรุณาลองใหม่ภายหลัง';
  if (response.status === 401 || response.status === 403) {
    message = 'สิทธิ์เชื่อมต่อพื้นที่ส่วนตัวไม่ถูกต้อง กรุณาตรวจคีย์ Supabase ของเซิร์ฟเวอร์';
  } else if (/bucket.+not found|bucket not found/i.test(reason)) {
    message = 'กำลังเตรียมพื้นที่จัดเก็บภาพส่วนตัว โปรดลองอีกครั้ง';
  }
  const error = new PublicAccountError(message, response.status >= 500 ? 503 : 502);
  error.upstreamStatus = response.status;
  error.upstreamReason = reason;
  return error;
}

function bucketMissing(error) {
  return error?.upstreamStatus === 404 || /bucket.+not found|bucket not found/i.test(String(error?.upstreamReason || ''));
}

async function request(path, { method = 'GET', body, headers = {}, accept = 'application/json' } = {}) {
  const { baseUrl, secretKey } = configuration();
  let response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        ...privateHeaders(secretKey),
        accept,
        ...headers,
      },
      body,
    });
  } catch {
    throw new PublicAccountError('ไม่สามารถติดต่อพื้นที่จัดเก็บข้อมูลส่วนตัวได้ กรุณาลองใหม่ภายหลัง', 503);
  }
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!response.ok) {
    throw upstreamFailure(response, data);
  }
  return data;
}

async function ensurePrivateBucket() {
  try {
    await request(`/storage/v1/bucket/${PRIVATE_BUCKET}`);
    return;
  } catch (error) {
    if (!bucketMissing(error)) throw error;
  }
  await request('/storage/v1/bucket', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: PRIVATE_BUCKET,
      name: PRIVATE_BUCKET,
      public: false,
      file_size_limit: 8 * 1024 * 1024,
      allowed_mime_types: ['image/jpeg', 'image/png', 'image/webp'],
    }),
  });
}

export async function createPrivateUpload(path) {
  const requestSignedUpload = () => request(`/storage/v1/object/upload/sign/${PRIVATE_BUCKET}/${objectPath(path)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ upsert: false }),
  });
  let data;
  try { data = await requestSignedUpload(); }
  catch (error) {
    if (!bucketMissing(error)) throw error;
    await ensurePrivateBucket();
    data = await requestSignedUpload();
  }
  if (!data?.token || typeof data.token !== 'string') throw new PublicAccountError('ไม่สามารถสร้างสิทธิ์อัปโหลดภาพชั่วคราวได้', 503);
  const { baseUrl } = configuration();
  return {
    token: data.token,
    uploadUrl: `${baseUrl}/storage/v1/object/upload/sign/${PRIVATE_BUCKET}/${objectPath(path)}?token=${encodeURIComponent(data.token)}`,
  };
}

export async function uploadPrivateObject(path, bytes, contentType) {
  await request(`/storage/v1/object/${PRIVATE_BUCKET}/${objectPath(path)}`, {
    method: 'POST',
    headers: { 'Content-Type': contentType, 'x-upsert': 'false' },
    body: bytes,
  });
}

export async function privateObjectExists(path) {
  const { baseUrl, secretKey } = configuration();
  let response;
  try {
    response = await fetch(`${baseUrl}/storage/v1/object/${PRIVATE_BUCKET}/${objectPath(path)}`, {
      method: 'HEAD',
      headers: privateHeaders(secretKey),
    });
  } catch {
    throw new PublicAccountError('ไม่สามารถตรวจสอบภาพที่อัปโหลดได้ กรุณาลองใหม่ภายหลัง', 503);
  }
  return response.ok;
}

export async function removePrivateObjects(paths) {
  const validPaths = paths.filter((path) => typeof path === 'string' && path);
  if (!validPaths.length) return;
  await request(`/storage/v1/object/${PRIVATE_BUCKET}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prefixes: validPaths }),
  });
}

export async function createPrivateDownloadUrl(path, expiresIn = 60) {
  const seconds = Math.min(Math.max(Number(expiresIn) || 60, 10), 300);
  const data = await request(`/storage/v1/object/sign/${PRIVATE_BUCKET}/${objectPath(path)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ expiresIn: seconds }),
  });
  const signedPath = data?.signedURL || data?.signedUrl;
  if (!signedPath || typeof signedPath !== 'string') throw new PublicAccountError('ไม่สามารถเปิดรูปโปรไฟล์ได้ กรุณาลองใหม่ภายหลัง', 503);
  const { baseUrl } = configuration();
  return signedPath.startsWith('http') ? signedPath : `${baseUrl}/storage/v1${signedPath}`;
}

export async function selectPrivateRows(table, query = '') {
  const data = await request(`/rest/v1/${encodeURIComponent(table)}${query}`, {
    headers: { Accept: 'application/json' },
  });
  return Array.isArray(data) ? data : [];
}

export async function countPrivateRows(table, query = '') {
  const { baseUrl, secretKey } = configuration();
  let response;
  try {
    response = await fetch(`${baseUrl}/rest/v1/${encodeURIComponent(table)}${query}`, {
      method: 'HEAD',
      headers: {
        ...privateHeaders(secretKey),
        Prefer: 'count=exact',
        Range: '0-0',
      },
    });
  } catch {
    throw new PublicAccountError('ไม่สามารถอ่านข้อมูลส่วนตัวได้ กรุณาลองใหม่ภายหลัง', 503);
  }
  if (!response.ok) {
    throw new PublicAccountError('ไม่สามารถอ่านข้อมูลส่วนตัวได้ กรุณาลองใหม่ภายหลัง', response.status >= 500 ? 503 : 502);
  }
  const match = /\/(\d+)$/.exec(response.headers.get('content-range') || '');
  return match ? Number(match[1]) : 0;
}

export async function insertPrivateRow(table, values) {
  const data = await request(`/rest/v1/${encodeURIComponent(table)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: JSON.stringify(values),
  });
  return Array.isArray(data) ? data : [];
}

export async function upsertPrivateRow(table, values, onConflict) {
  const query = onConflict ? `?on_conflict=${encodeURIComponent(onConflict)}` : '';
  const data = await request(`/rest/v1/${encodeURIComponent(table)}${query}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify(values),
  });
  return Array.isArray(data) ? data : [];
}

export async function deletePrivateRows(table, query = '') {
  return request(`/rest/v1/${encodeURIComponent(table)}${query}`, {
    method: 'DELETE',
    headers: { Prefer: 'return=representation' },
  });
}
