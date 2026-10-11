const { test } = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const { join } = require('node:path');
const { readFileSync } = require('node:fs');
const locationModule = import(pathToFileURL(join(__dirname, '../vercel-public/lib/environment-location.js')));
const fixture = (admin = { level2: 'ประเทศไทย', level4: 'จังหวัดทดสอบ', level6: 'อำเภอทดสอบ', level8: 'ตำบลทดสอบ' }, extra = {}) => ({ features: [{ properties: { geocoding: { country: 'ประเทศไทย', admin, ...extra } } }] });

test('administrative parser uses Thai boundary levels, not nearby streets, villages or municipalities', async () => {
  const { administrativeLocation } = await locationModule;
  const result = administrativeLocation(fixture(undefined, { street: 'road', housenumber: '99', label: 'private full address', city: 'municipality', district: 'neighbourhood' }));
  assert.equal(result.province, 'จังหวัดทดสอบ'); assert.equal(result.district, 'อำเภอทดสอบ'); assert.equal(result.subdistrict, 'ตำบลทดสอบ');
  assert.doesNotMatch(JSON.stringify(result), /private|road|housenumber|99|neighbourhood/);
  const missing = administrativeLocation(fixture({ level2: 'ประเทศไทย', level4: 'กรุงเทพมหานคร', level6: 'เขตพระนคร' }, { district: 'not an official subdistrict' }));
  assert.equal(missing.isBangkok, true); assert.equal(missing.subdistrict, '');
  assert.equal(administrativeLocation({}).province, '');
});

test('foreign boundaries are not interpreted as Thai level-6 or level-8 divisions; only bounded text fields return', async () => {
  const { administrativeLocation } = await locationModule;
  const result = administrativeLocation(fixture({ level4: 'wrong level', level6: 'wrong district', level8: 'wrong subdistrict' },
    { country: 'Other country', state: 'state', county: 'county', district: 'district', city: '\u0000city', label: 'do not return' }));
  assert.equal(result.isThai, false); assert.equal(result.province, 'state'); assert.equal(result.district, 'county');
  assert.equal(result.subdistrict, 'district'); assert.equal(result.locality, 'city');
  assert.equal(administrativeLocation(fixture(undefined, { country: 'x'.repeat(300) })).country.length, 120);
});

test('reverse provider uses fixed host, rounded coordinates, identifying UA, six-second timeout and minimal cached results', async () => {
  const { createLocationService } = await locationModule;
  let fetches = 0, reserves = 0, releases = 0, clock = 0;
  const locate = createLocationService({ now: () => clock, reserve: async () => { reserves++; return 'lease'; }, release: async () => { releases++; },
    fetchProvider: async (url, options) => {
      fetches++; const query = new URL(url);
      assert.equal(query.hostname, 'nominatim.openstreetmap.org'); assert.equal(query.pathname, '/reverse');
      assert.equal(query.searchParams.get('lat'), '0.1235'); assert.equal(query.searchParams.get('lon'), '1.2346');
      assert.equal(query.searchParams.get('format'), 'geocodejson'); assert.equal(query.searchParams.get('zoom'), '18');
      assert.equal(options.redirect, 'error'); assert.equal(options.cache, 'no-store'); assert.ok(options.signal);
      assert.match(options.headers['User-Agent'], /SmartSkinAI/); return { ok: true, json: async () => fixture() };
    } });
  assert.equal((await locate(0.123456, 1.234567)).district, 'อำเภอทดสอบ');
  await locate(0.123456, 1.234567); assert.equal(fetches, 1); assert.equal(reserves, 1); assert.equal(releases, 1);
  clock = 90001; await locate(0.123456, 1.234567); assert.equal(fetches, 2);
});

test('same-position in-flight requests share one provider call; shared busy lease fails closed without sending coordinates', async () => {
  const { createLocationService } = await locationModule;
  let resolveProvider, calls = 0;
  const locate = createLocationService({ reserve: async () => 'token', release: async () => {},
    fetchProvider: async () => { calls++; return new Promise(resolve => { resolveProvider = () => resolve({ ok: true, json: async () => fixture() }); }); } });
  const first = locate(0.1, 1.2), second = locate(0.1, 1.2);
  await new Promise(setImmediate); resolveProvider(); await Promise.all([first, second]); assert.equal(calls, 1);
  const busy = createLocationService({ reserve: async () => null, fetchProvider: async () => { throw new Error('must not fetch'); } });
  await assert.rejects(busy(0.1, 1.2), error => error.status === 429);
  await assert.rejects(busy(999, 1.2), /Invalid location/);
});

test('slow/failed limiter or malformed provider cannot fabricate names; lease releases on upstream failure', async () => {
  const { createLocationService } = await locationModule;
  let released = 0, calls = 0, clock = 0;
  const slow = createLocationService({ now: () => clock, reserve: async () => { clock = 13000; return 'lease'; }, release: async () => { released++; },
    fetchProvider: async () => { calls++; } });
  await assert.rejects(slow(0.1, 1.2), /timeout/); assert.equal(calls, 0); assert.equal(released, 1);
  const broken = createLocationService({ reserve: async () => 'lease', release: async () => { released++; }, fetchProvider: async () => ({ ok: true, json: async () => ({}) }) });
  await assert.rejects(broken(0.1, 1.2), /No administrative area/); assert.equal(released, 2);
  const source = readFileSync(join(__dirname, '../vercel-public/lib/environment-location.js'), 'utf8');
  const schema = source.match(/CREATE TABLE IF NOT EXISTS[^`]+/)[0];
  assert.doesNotMatch(schema, /latitude|longitude|user_id|email|address|ip_address/);
  assert.match(source, /ON CONFLICT \(provider\)[\s\S]+WHERE smart_skin_public_provider_lease\.next_allowed_at <= clock_timestamp\(\)/);
  assert.match(source, /INTERVAL '1200 milliseconds'/);
});
