import { PublicAccountError } from './account-auth.js';

export const PRIVATE_BUCKET = 'smart-skin-private';

function configuration() {
  const baseUrl = String(process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
  // Prefer the current secret key. The legacy service_role name remains only
  // for existing projects while they rotate keys before its 2026 retirement.
  const secretKey = String(process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  if (!baseUrl || !secretKey) {
    throw new PublicAccountError('ระบบจัดเก็บภาพส่วนตัวยังไม่ได้เชื่อมต่อ กรุณาตั้งค่า Supabase ก่อนใช้งาน', 503);
  }
  let parsed;
  try { parsed = new URL(baseUrl); } catch { throw new PublicAccountError('การตั้งค่า Supabase ไม่ถูกต้อง', 503); }
  if (parsed.protocol !== 'https:') throw new PublicAccountError('การตั้งค่า Supabase ต้องใช้ HTTPS', 503);
  return { baseUrl, secretKey };
}

export function isSupabasePrivateStorageConfigured() {
  return Boolean(String(process.env.SUPABASE_URL || '').trim() && String(process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim());
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
    throw new PublicAccountError('ไม่สามารถจัดการข้อมูลส่วนตัวได้ กรุณาลองใหม่ภายหลัง', response.status >= 500 ? 503 : 502);
  }
  return data;
}

export async function createPrivateUpload(path) {
  const data = await request(`/storage/v1/object/upload/sign/${PRIVATE_BUCKET}/${objectPath(path)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ upsert: false }),
  });
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
