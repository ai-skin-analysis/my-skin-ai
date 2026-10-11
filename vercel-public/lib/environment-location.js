import { randomUUID } from 'node:crypto';
import { neon } from '@neondatabase/serverless';

const clean = value => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 120) : '';

// Only administrative names leave this adapter. Never return house numbers,
// roads, full addresses, provider geometry or the original coordinate query.
export function administrativeLocation(data) {
  const feature = Array.isArray(data?.features) ? data.features[0] : data?.features;
  const place = feature?.properties?.geocoding || {};
  const admin = place.admin || {};
  const country = clean(place.country || admin.level2);
  const isThai = /^(ประเทศไทย|ไทย|Thailand)$/i.test(country);
  const province = clean(isThai ? admin.level4 || place.state : place.state);
  const district = clean(isThai ? admin.level6 : place.county);
  const subdistrict = clean(isThai ? admin.level8 : place.district);
  const locality = clean(place.city || place.locality);
  const isBangkok = isThai && /กรุงเทพ|Bangkok/i.test(province || locality);
  return { province: province || (isBangkok ? locality : ''), district, subdistrict, locality, country, isThai, isBangkok };
}

// One shared, location-free lease for ALL Vercel instances, not a user/IP
// counter. Fail closed if the shared limiter is unavailable. This enforces the
// public Nominatim service's aggregate rate limit and prevents concurrent calls.
let limiterSchema;
async function limiterClient() {
  if (!process.env.DATABASE_URL) throw new Error('Location limiter unavailable');
  const sql = neon(process.env.DATABASE_URL);
  if (!limiterSchema) {
    limiterSchema = sql`CREATE TABLE IF NOT EXISTS smart_skin_public_provider_lease (
      provider VARCHAR(32) PRIMARY KEY, lease_token UUID NOT NULL, next_allowed_at TIMESTAMPTZ NOT NULL
    )`.catch(error => { limiterSchema = null; throw error; });
  }
  await limiterSchema;
  return sql;
}

async function reserveProvider() {
  const sql = await limiterClient();
  const token = randomUUID();
  const rows = await sql`INSERT INTO smart_skin_public_provider_lease (provider, lease_token, next_allowed_at)
    VALUES ('nominatim', ${token}, clock_timestamp() + INTERVAL '30 seconds')
    ON CONFLICT (provider) DO UPDATE SET lease_token = EXCLUDED.lease_token, next_allowed_at = EXCLUDED.next_allowed_at
    WHERE smart_skin_public_provider_lease.next_allowed_at <= clock_timestamp()
    RETURNING lease_token`;
  return rows.length ? token : null;
}

async function releaseProvider(token) {
  const sql = await limiterClient();
  // Leave a gap AFTER completion, not merely between reservation attempts.
  await sql`UPDATE smart_skin_public_provider_lease SET next_allowed_at = clock_timestamp() + INTERVAL '1200 milliseconds'
    WHERE provider = 'nominatim' AND lease_token = ${token}`;
}

export function createLocationService({ reserve = reserveProvider, release = releaseProvider, fetchProvider = (...args) => fetch(...args), now = Date.now } = {}) {
  // Short-lived RAM only; no position/name is persisted in the shared limiter.
  const cache = new Map(), pending = new Map();
  return async function locate(latitude, longitude) {
    if (!Number.isFinite(latitude) || Math.abs(latitude) > 90 || !Number.isFinite(longitude) || Math.abs(longitude) > 180) throw new Error('Invalid location');
    const lat = Number(latitude.toFixed(4)), lon = Number(longitude.toFixed(4));
    const key = `${lat},${lon}`;
    for (const [id, entry] of cache) if (entry.expires <= now()) cache.delete(id);
    if (cache.has(key)) return cache.get(key).location;
    if (pending.has(key)) return pending.get(key);
    const work = (async () => {
      const started = now();
      const token = await reserve();
      if (!token) { const error = new Error('Location provider busy'); error.status = 429; throw error; }
      try {
        // Never start a provider request if reserving the 30-second lease took
        // too long. The upstream's six-second deadline stays inside the lease.
        if (now() - started > 12000) throw new Error('Location limiter timeout');
        const query = new URLSearchParams({ format: 'geocodejson', lat: String(lat), lon: String(lon),
          zoom: '18', addressdetails: '1', layer: 'address', 'accept-language': 'th' });
        const signal = AbortSignal.timeout(6000);
        const response = await fetchProvider(`https://nominatim.openstreetmap.org/reverse?${query}`, {
          signal, redirect: 'error', cache: 'no-store', headers: {
            'User-Agent': 'SmartSkinAI-Weather/1.0 (+https://smart-skin-ai.vercel.app/)', Accept: 'application/json',
          },
        });
        if (!response.ok) throw new Error('Location provider unavailable');
        const data = await response.json();
        if (signal.aborted) throw new Error('Location provider timeout');
        const location = administrativeLocation(data);
        if (![location.province, location.district, location.subdistrict, location.locality, location.country].some(Boolean)) throw new Error('No administrative area');
        if (cache.size >= 100) cache.delete(cache.keys().next().value);
        cache.set(key, { location, expires: now() + 90000 });
        return location;
      } finally {
        // A failed release conservatively retains the lease until its expiry.
        await release(token).catch(() => {});
      }
    })();
    pending.set(key, work);
    try { return await work; } finally { pending.delete(key); }
  };
}

export const locateAdministrativeArea = createLocationService();
