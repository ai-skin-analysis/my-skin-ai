const { test } = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const { join } = require('node:path');
const handler = import(pathToFileURL(join(__dirname, '../vercel-public/lib/public-environment.js'))).then(module => module.default);

function request(body, extra = {}) {
    return { method: 'POST', headers: { origin: 'https://smart-skin-ai.vercel.app', host: 'smart-skin-ai.vercel.app',
        'content-type': 'application/json', 'x-forwarded-for': 'documentation-test-client', ...extra.headers }, body, ...extra };
}
function response() {
    return { headers: {}, setHeader(key, value) { this.headers[key] = value; }, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
}

test('anonymous weather proxy rounds inputs, selects only allowlisted upstreams and returns minimal uncached current data', async () => {
    const run = await handler;
    const calls = [], original = global.fetch;
    global.fetch = async (url, options) => {
        calls.push({ url, options });
        return { ok: true, json: async () => ({ latitude: 0.123456, current: { time: '2026-10-10T12:00', temperature_2m: 24,
            relative_humidity_2m: 50, uv_index: 2, weather_code: 0, is_day: 1, us_aqi: 30, extra: 'not returned' }, timezone: 'UTC' }) };
    };
    try {
        for (const kind of ['weather', 'air']) {
            const res = response(); await run(request({ kind, latitude: 0.123456, longitude: 1.234567 }), res);
            assert.equal(res.code, 200); assert.equal(res.headers['Cache-Control'], 'no-store');
            assert.equal(res.body.latitude, undefined); assert.equal(res.body.current.extra, undefined);
        }
        assert.match(calls[0].url, /^https:\/\/api\.open-meteo\.com\/v1\/forecast\?/);
        assert.match(calls[1].url, /^https:\/\/air-quality-api\.open-meteo\.com\/v1\/air-quality\?/);
        for (const call of calls) { assert.match(call.url, /latitude=0\.1235&longitude=1\.2346/); assert.equal(call.options.redirect, 'error'); }
    } finally { global.fetch = original; }
});

test('proxy refuses GET, cross-origin requests, non-JSON, oversized bodies, forged URLs and invalid coordinates before fetch', async () => {
    const run = await handler, original = global.fetch;
    let calls = 0; global.fetch = async () => { calls++; throw new Error('Must not fetch'); };
    try {
        const valid = { kind: 'weather', latitude: 0.1, longitude: 1.2 };
        for (const [req, expected] of [
            [request(valid, { method: 'GET' }), 405],
            [request(valid, { headers: { origin: 'https://other.invalid', host: 'smart-skin-ai.vercel.app', 'content-type': 'application/json' } }), 403],
            [request(valid, { headers: { origin: 'https://smart-skin-ai.vercel.app', host: 'smart-skin-ai.vercel.app', 'content-type': 'text/plain' } }), 415],
            [request({ ...valid, text: 'x'.repeat(600) }), 400],
            [request({ ...valid, url: 'http://localhost' }), 400],
            [request({ ...valid, kind: 'unknown' }), 400],
            [request({ ...valid, latitude: 999 }), 400],
            [request({ ...valid, longitude: NaN }), 400],
            [request({ ...valid, latitude: '0.1' }), 400],
            [request('invalid JSON'), 400],
        ]) { const res = response(); await run(req, res); assert.equal(res.code, expected); }
        assert.equal(calls, 0);
    } finally { global.fetch = original; }
});

test('provider failure is a generic uncached failure without reflecting upstream URLs or coordinates', async () => {
    const run = await handler, original = global.fetch;
    global.fetch = async () => { throw new Error('private URL and coordinates'); };
    try {
        const res = response(); await run(request({ kind: 'weather', latitude: 0.1, longitude: 1.2 }), res);
        assert.equal(res.code, 502); assert.equal(res.headers['Cache-Control'], 'no-store');
        assert.doesNotMatch(JSON.stringify(res.body), /private|0\.1|1\.2/);
    } finally { global.fetch = original; }
});

test('public proxy has bounded per-instance abuse control without requiring a login or database', async () => {
    const run = await handler, original = global.fetch;
    global.fetch = async () => ({ ok: false });
    try {
        const req = request({ kind: 'air', latitude: 0.1, longitude: 1.2 });
        req.headers['x-forwarded-for'] = 'separate-rate-test-client';
        let res;
        for (let index = 0; index < 25; index++) { res = response(); await run(req, res); }
        assert.equal(res.code, 429);
    } finally { global.fetch = original; }
});

test('real shared router permits public weather while retaining denial for anonymous private health routes', async () => {
    const router = (await import(pathToFileURL(join(__dirname, '../vercel-public/api/admin-handler.js')))).default;
    const original = global.fetch;
    global.fetch = async () => ({ ok: true, json: async () => ({ current: { time: '2026-10-10T12:00', us_aqi: 30 }, timezone: 'UTC' }) });
    try {
        const publicResponse = response();
        await router({ ...request({ kind: 'air', latitude: 0.1, longitude: 1.2 }), query: { path: 'environment' } }, publicResponse);
        assert.equal(publicResponse.code, 200);
        const privateResponse = response();
        await router({ ...request({}), method: 'GET', query: { path: 'user/history' } }, privateResponse);
        assert.equal(privateResponse.code, 401);
    } finally { global.fetch = original; }
});

test('public area search uses a fixed geocoding host, returns bounded sanitized rounded places and no account data', async () => {
    const run = await handler, original = global.fetch;
    let url;
    global.fetch = async input => { url = input; return { ok: true, json: async () => ({ results: [
        { name: 'พื้นที่ทดสอบ', admin1: 'จังหวัด', country: 'ประเทศ', latitude: 0.123456, longitude: 1.234567, secret: 'not returned' },
        { name: 'invalid', latitude: 999, longitude: 1 },
    ] }) }; };
    try {
        const req = request({ kind: 'places', query: 'พื้นที่ทดสอบ' }); req.headers['x-forwarded-for'] = 'area-test-client';
        const res = response(); await run(req, res);
        assert.equal(res.code, 200); assert.equal(res.headers['Cache-Control'], 'no-store');
        assert.match(url, /^https:\/\/geocoding-api\.open-meteo\.com\/v1\/search\?/);
        assert.equal(res.body.results.length, 1); assert.equal(res.body.results[0].latitude, 0.1235);
        assert.equal(res.body.results[0].longitude, 1.2346); assert.equal(res.body.results[0].secret, undefined);
    } finally { global.fetch = original; }
});

test('area search refuses missing, huge, non-string, control-character and extra-coordinate input before fetch', async () => {
    const run = await handler, original = global.fetch; let calls = 0;
    global.fetch = async () => { calls++; throw new Error('must not fetch'); };
    try {
        for (const body of [{ kind: 'places' }, { kind: 'places', query: 'x' }, { kind: 'places', query: 123 },
            { kind: 'places', query: 'x'.repeat(81) }, { kind: 'places', query: 'test\u0001' },
            { kind: 'places', query: 'test', latitude: 0.1, longitude: 1.2 }]) {
            const req = request(body); req.headers['x-forwarded-for'] = 'invalid-area-test-client';
            const res = response(); await run(req, res); assert.equal(res.code, 400);
        }
        assert.equal(calls, 0);
    } finally { global.fetch = original; }
});
