import { createHash } from 'node:crypto';
import { json, requirePost, requireSameOrigin, requestJson } from './account-auth.js';

// Best-effort per-instance abuse control, not an account or location store.
const buckets = new Map();
function withinBudget(req) {
  const key = createHash('sha256').update(String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown')).digest('hex');
  const now = Date.now();
  for (const [id, bucket] of buckets) if (bucket.expires <= now) buckets.delete(id);
  if (!buckets.has(key)) {
    if (buckets.size >= 1000) return false;
    buckets.set(key, { count: 0, expires: now + 60000 });
  }
  return ++buckets.get(key).count <= 24;
}

export default async function handler(req, res) {
  if (!requirePost(req, res) || !requireSameOrigin(req, res)) return;
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) return json(res, 415, { ok: false });
  if (Number(req.headers['content-length']) > 512) return json(res, 413, { ok: false });
  if (!withinBudget(req)) return json(res, 429, { ok: false, message: 'โปรดรอสักครู่ก่อนอัปเดตอีกครั้ง' });
  try {
    const body = requestJson(req);
    if (JSON.stringify(body).length > 512) return json(res, 400, { ok: false });
    const { kind, latitude, longitude } = body;
    if (kind === 'places') {
      if (Object.keys(body).some(key => !['kind', 'query'].includes(key)) || typeof body.query !== 'string'
        || body.query.trim().length < 2 || body.query.length > 80 || /[\u0000-\u001f\u007f]/.test(body.query)) return json(res, 400, { ok: false });
      const query = new URLSearchParams({ name: body.query.trim(), count: '8', language: 'th', format: 'json' });
      const signal = AbortSignal.timeout(6000);
      const upstream = await fetch(`https://geocoding-api.open-meteo.com/v1/search?${query}`, { signal, redirect: 'error', cache: 'no-store' });
      if (!upstream.ok) return json(res, 502, { ok: false, message: 'บริการค้นหาพื้นที่ยังไม่พร้อม' });
      const data = await upstream.json();
      if (signal.aborted) throw new Error('Provider timeout');
      const results = (Array.isArray(data.results) ? data.results : []).filter(place => place
        && typeof place.name === 'string' && place.name.trim() && Number.isFinite(place.latitude) && Math.abs(place.latitude) <= 90
        && Number.isFinite(place.longitude) && Math.abs(place.longitude) <= 180).slice(0, 8).map(place => ({
          name: place.name.slice(0, 100), admin1: typeof place.admin1 === 'string' ? place.admin1.slice(0, 100) : '',
          country: typeof place.country === 'string' ? place.country.slice(0, 100) : '',
          latitude: Number(place.latitude.toFixed(4)), longitude: Number(place.longitude.toFixed(4)),
        }));
      return json(res, 200, { results });
    }
    if (Object.keys(body).some(key => !['kind', 'latitude', 'longitude'].includes(key))) return json(res, 400, { ok: false });
    if (!['weather', 'air'].includes(kind) || typeof latitude !== 'number' || typeof longitude !== 'number'
      || !Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return json(res, 400, { ok: false });
    // Round again on the server. Never put coordinates in our request URL,
    // application logs, database, or a persistent cache.
    const query = new URLSearchParams({ latitude: String(Number(latitude.toFixed(4))), longitude: String(Number(longitude.toFixed(4))),
      current: kind === 'weather' ? 'temperature_2m,relative_humidity_2m,uv_index,weather_code,is_day' : 'us_aqi', timezone: 'auto' });
    const host = kind === 'weather' ? 'api.open-meteo.com/v1/forecast' : 'air-quality-api.open-meteo.com/v1/air-quality';
    const signal = AbortSignal.timeout(6000);
    const upstream = await fetch(`https://${host}?${query}`, { signal, redirect: 'error', cache: 'no-store' });
    if (!upstream.ok) return json(res, 502, { ok: false, message: 'บริการข้อมูลอากาศยังไม่พร้อม โปรดลองอีกครั้ง' });
    const data = await upstream.json();
    if (signal.aborted || !data.current || typeof data.current !== 'object') return json(res, 502, { ok: false });
    const keys = kind === 'weather' ? ['temperature_2m', 'relative_humidity_2m', 'uv_index', 'weather_code', 'is_day'] : ['us_aqi'];
    const current = { time: typeof data.current.time === 'string' ? data.current.time.slice(0, 40) : '' };
    for (const key of keys) current[key] = typeof data.current[key] === 'number' && Number.isFinite(data.current[key]) ? data.current[key] : null;
    return json(res, 200, { current, timezone: typeof data.timezone === 'string' ? data.timezone.slice(0, 100) : '' });
  } catch (error) {
    // Do not log upstream URLs, request bodies or positions on failure.
    if (error?.status === 400) return json(res, 400, { ok: false, message: 'ข้อมูลไม่ถูกต้อง' });
    return json(res, 502, { ok: false, message: 'เชื่อมต่อบริการข้อมูลอากาศไม่สำเร็จ โปรดลองอีกครั้ง' });
  }
}
