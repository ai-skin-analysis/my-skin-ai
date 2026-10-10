const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');

const html = readFileSync(join(__dirname, '../vercel-public/index.html'), 'utf8');
const script = readFileSync(join(__dirname, '../vercel-public/app.js'), 'utf8');
const flush = async () => { for (let n = 0; n < 5; n++) await new Promise(setImmediate); };

function environment({ secure = true, supported = true, accountFailure = false, gpsError = null, gpsPlan = [], weatherFailure = false, providerResponse = null } = {}) {
    const nodes = new Map(), documentEvents = new Map(), requests = [], requestBodies = [], positions = [], redirects = [], gpsCallbacks = [], timers = new Map();
    let nextTimer = 0;
    class Element {
        constructor(id) {
            this.id = id; this.textContent = ''; this.value = ''; this.checked = false; this.style = {}; this.dataset = {}; this.children = [];
            this.isConnected = true; this.events = new Map(); this.attributes = new Map();
            const classes = new Set(id.endsWith('Modal') ? ['hidden'] : []);
            this.classList = { add: n => classes.add(n), remove: n => classes.delete(n), contains: n => classes.has(n),
                toggle: (n, on) => on ? classes.add(n) : classes.delete(n) };
        }
        addEventListener(type, callback) { this.events.set(type, [...(this.events.get(type) || []), callback]); }
        dispatch(type = 'click', extra = {}) {
            for (const fn of this.events.get(type) || []) fn({ target: this, currentTarget: this, preventDefault() {}, ...extra });
        }
        setAttribute(name, value) { this.attributes.set(name, value); }
        focus() { document.activeElement = this; }
        click() { this.dispatch(); }
        replaceChildren(...children) { this.children = children; }
        append(child) { this.children.push(child); }
        closest() { return null; }
        querySelector(selector) { return selector.startsWith('#') ? element(selector.slice(1)) : null; }
        querySelectorAll() { return []; }
    }
    const element = id => { if (!nodes.has(id)) nodes.set(id, new Element(id)); return nodes.get(id); };
    const closeConsent = [element('closeEnvironment'), element('cancelEnvironment')];
    const closeDetails = [element('closeDetails'), element('acceptDetails')];
    const closeArea = [element('closeArea'), element('cancelArea')];
    const closeMap = [element('closeMap'), element('cancelMap')];
    const categories = [['mapBtnDerm', 'dermatologist'], ['mapBtnHosp', 'hospital'], ['mapBtnPharm', 'pharmacy']].map(([id, category]) => {
        const button = element(id); button.dataset.mapCategory = category; return button;
    });
    const cards = ['uv', 'temp', 'humidity', 'aqi'].map(key => {
        const card = element(`detail-${key}`); card.dataset.environmentDetail = key; return card;
    });
    const document = { getElementById: element, activeElement: element('environmentLocationButton'),
        documentElement: element('html'), body: element('body'),
        createElement: tag => new Element(tag),
        addEventListener(type, fn) { documentEvents.set(type, fn); },
        querySelectorAll(selector) {
            if (selector === '[data-close-environment-consent]') return closeConsent;
            if (selector === '[data-close-environment-detail]') return closeDetails;
            if (selector === '[data-close-environment-area]') return closeArea;
            if (selector === '[data-close-medical-map]') return closeMap;
            if (selector === '[data-map-category]') return categories;
            if (selector === '[data-environment-detail]') return cards;
            if (selector === '[data-accessible-modal="true"]') return [element('environmentLocationConsentModal'), element('environmentAreaModal'), element('mapModal'), element('envDetailModal')];
            return [];
        } };
    const fetch = async (url, options = {}) => {
        requests.push(String(url));
        if (url === '/api/account/me') {
            if (accountFailure) throw new Error('Account service unavailable');
            return { ok: true, json: async () => ({ ok: true, user: null }) };
        }
        if (weatherFailure) throw new Error('Provider unavailable');
        let providerUrl = url;
        if (url === '/api/environment') {
            const body = JSON.parse(options.body);
            requestBodies.push(body);
            assert.equal(options.method, 'POST'); assert.equal(options.credentials, 'omit');
            providerUrl = body.kind === 'places' ? `https://geocoding-api.open-meteo.com/?name=${encodeURIComponent(body.query)}`
                : `https://${body.kind === 'weather' ? 'api.open-meteo.com' : 'air-quality-api.open-meteo.com'}/?latitude=${body.latitude}&longitude=${body.longitude}`;
        }
        const host = new URL(providerUrl).hostname;
        const data = host === 'api.open-meteo.com' ? { current: { temperature_2m: 24.3, relative_humidity_2m: 50, uv_index: 3, weather_code: 0, is_day: 1, time: '2026-10-10T10:00' }, timezone: 'UTC' }
            : host === 'air-quality-api.open-meteo.com' ? { current: { us_aqi: 20, time: '2026-10-10T10:00' }, timezone: 'UTC' }
            : host === 'geocoding-api.open-meteo.com' ? { results: [{ name: 'พื้นที่ทดสอบ', admin1: 'จังหวัดทดสอบ', country: 'ประเทศทดสอบ', latitude: 0.123456, longitude: 1.234567 }] }
            : { address: { city: 'พื้นที่ทดสอบ' } };
        return providerResponse ? providerResponse(String(providerUrl), options, data) : { ok: true, json: async () => data };
    };
    const context = vm.createContext({ document, HTMLElement: Element, navigator: { onLine: true,
        ...(supported ? { geolocation: { getCurrentPosition(success, error, options) {
            positions.push(options);
            gpsCallbacks.push({ success, error });
            const planned = gpsPlan[positions.length - 1];
            if (planned === 'pending') return;
            if (typeof planned === 'number' || gpsError) error({ code: planned || gpsError });
            else success(planned || { timestamp: Date.now(), coords: { latitude: 0.123456, longitude: 1.234567, accuracy: 50 } });
        } } } : {}) }, fetch, AbortController, Intl, Date, URLSearchParams,
        window: { isSecureContext: secure, matchMedia: () => ({ matches: true }),
            setTimeout: (fn, delay) => { timers.set(++nextTimer, { fn, delay }); return nextTimer; },
            clearTimeout: id => timers.delete(id), setInterval() {},
            location: { search: '', replace: path => redirects.push(path) } } });
    vm.runInContext(script, context);
    documentEvents.get('DOMContentLoaded')();
    return { element, requests, requestBodies, positions, redirects, closeConsent, closeDetails, closeArea, closeMap, cards, gpsCallbacks,
        run: code => vm.runInContext(code, context),
        fireTimers(delay) { for (const [id, timer] of [...timers]) if (timer.delay === delay) { timers.delete(id); timer.fn(); } } };
}

test('public location controls use external event listeners without weakening CSP or requiring an account', () => {
    for (const id of ['environmentLocationButton', 'environmentRefreshButton', 'environmentLocationConfirmButton']) {
        const tag = html.match(new RegExp(`<button[^>]*id="${id}"[^>]*>`))?.[0];
        assert.ok(tag); assert.doesNotMatch(tag, /onclick=/);
        assert.match(script, new RegExp(`getElementById\\('${id}'\\)\\?\\.addEventListener`));
    }
    assert.doesNotMatch(html, /onclick="(?:useCurrentLocationForEnvironment|approveEnvironmentLocationConsent|closeEnvironmentLocationConsent|openEnvDetailModal|closeEnvDetailModal|refreshEnvironmentData)\(/);
    assert.match(html, /ไม่ต้องลงทะเบียนหรือเข้าสู่ระบบ/);
    const policy = JSON.parse(readFileSync(join(__dirname, '../vercel-public/vercel.json'), 'utf8'));
    const csp = policy.headers[0].headers.find(h => h.key === 'Content-Security-Policy').value;
    assert.doesNotMatch(csp.match(/script-src [^;]+/)[0], /unsafe-inline|unsafe-eval/);
    assert.doesNotMatch(script, /localStorage|sessionStorage/);
});

test('all public medical-map controls are CSP-safe and a guest can search by button, category or Enter without GPS', async () => {
    assert.doesNotMatch(html, /on(?:click|keypress)="(?:openMapModal|closeMapModal|executeCustomSearch|filterMapSearch|useCurrentLocationForMap|handleSearchKeyPress)\(/);
    const e = environment({ accountFailure: true }); await flush(); e.requests.length = 0;
    e.element('medicalMapButton').dispatch();
    assert.equal(e.element('mapModal').classList.contains('hidden'), false);
    assert.match(e.element('googleMapIframe').src, /^https:\/\/www\.google\.com\/maps\?/);
    assert.doesNotMatch(e.element('googleMapIframe').src, /&ll=|marker=|latitude=/);
    e.element('mapBtnHosp').dispatch();
    assert.match(decodeURIComponent(e.element('btnExternalNav').href), /โรงพยาบาล/);
    e.element('customSearchInput').value = 'จังหวัดทดสอบ';
    e.element('customSearchInput').dispatch('keydown', { key: 'Enter' });
    assert.match(decodeURIComponent(e.element('btnExternalNav').href), /จังหวัดทดสอบ/);
    assert.equal(e.element('medicalMapExternalTop').href, e.element('btnExternalNav').href);
    assert.equal(e.positions.length, 0); assert.deepEqual(e.requests, []);
    e.closeMap[0].dispatch();
    assert.equal(e.element('mapModal').classList.contains('hidden'), true); assert.equal(e.element('googleMapIframe').src, '');
});

test('map location requires separate consent; denial keeps keyword search available and closing discards late GPS', async () => {
    const denied = environment({ gpsError: 1 }); await flush(); denied.requests.length = 0;
    denied.element('medicalMapButton').dispatch(); denied.element('mapLocationButton').dispatch();
    assert.equal(denied.positions.length, 0);
    denied.element('mapLocationConsentCheck').checked = true; denied.element('mapLocationButton').dispatch();
    assert.match(denied.element('mapLocationStatus').textContent, /สิทธิ์ตำแหน่ง/);
    assert.match(denied.element('btnExternalNav').href, /api=1&query=/);
    assert.equal(denied.element('mapLocationButton').disabled, false); assert.deepEqual(denied.requests, []);
    const late = environment({ gpsPlan: ['pending'] }); await flush(); late.requests.length = 0;
    late.element('medicalMapButton').dispatch(); late.element('mapLocationConsentCheck').checked = true;
    late.element('mapLocationButton').dispatch(); late.closeMap[1].dispatch();
    late.gpsCallbacks[0].success({ coords: { latitude: 0.1, longitude: 1.2, accuracy: 10 } }); await flush();
    assert.equal(late.element('googleMapIframe').src, ''); assert.deepEqual(late.requests, []);
});

test('map marker displays before optional geocoder, keeps coordinates out of Google until distinct consent, and is cleared on close', async () => {
    const e = environment({ providerResponse: (url) => url.includes('nominatim') ? new Promise(() => {}) : Promise.reject(new Error('unexpected request')) });
    await flush(); e.element('medicalMapButton').dispatch(); e.element('mapLocationConsentCheck').checked = true;
    e.element('mapLocationButton').dispatch();
    assert.match(e.element('googleMapIframe').src, /^https:\/\/www\.openstreetmap\.org\/export\/embed\.html/);
    assert.match(e.element('googleMapIframe').src, /marker=0\.1235%2C1\.2346/);
    assert.doesNotMatch(e.element('btnExternalNav').href, /0\.1235|1\.2346/);
    e.element('googleMapLocationConsentCheck').checked = true;
    e.element('mapBtnDerm').dispatch();
    assert.doesNotMatch(e.element('googleMapIframe').src, /&ll=/);
    e.closeMap[1].dispatch(); assert.equal(e.element('googleMapIframe').src, '');
});

test('guest can choose an area and refresh actual weather without GPS; chosen area never masquerades as a device location', async () => {
    const e = environment({ gpsError: 1 }); await flush(); e.requests.length = 0;
    e.element('environmentAreaButton').dispatch();
    assert.equal(e.element('environmentAreaModal').classList.contains('hidden'), false); assert.deepEqual(e.requests, []);
    e.element('environmentAreaInput').value = 'พื้นที่ทดสอบ'; e.element('environmentAreaForm').dispatch('submit'); await flush();
    assert.deepEqual(e.requestBodies[0], { kind: 'places', query: 'พื้นที่ทดสอบ' });
    e.element('environmentAreaResults').children[0].dispatch(); await flush();
    assert.equal(e.positions.length, 0); assert.equal(e.element('card-temp-val').textContent, '24.3°C');
    assert.match(e.element('environment-area-text').textContent, /พื้นที่ที่คุณเลือก.*ไม่ใช่ตำแหน่ง GPS/);
    assert.doesNotMatch(e.element('environment-source-note').textContent, /ขอพิกัดใหม่เวลา/);
    assert.equal(e.run('currentLat'), null); assert.equal(e.run('currentLng'), null);
    assert.equal(e.requests.some(url => url.includes('nominatim')), false);
    e.element('environmentRefreshButton').dispatch(); await flush();
    assert.equal(e.positions.length, 0); assert.equal(e.element('environmentAreaButton').disabled, false);
});

test('closing area search cancels late results; invalid or failed searches cannot fabricate weather', async () => {
    let resolveSearch;
    const e = environment({ providerResponse: (url, options, data) => url.includes('geocoding') ? new Promise(resolve => { resolveSearch = resolve; }) : { ok: true, json: async () => data } });
    await flush(); e.element('environmentAreaButton').dispatch();
    e.element('environmentAreaInput').value = 'x'; e.element('environmentAreaForm').dispatch('submit'); await flush();
    assert.equal(e.requestBodies.length, 0);
    e.element('environmentAreaInput').value = 'test'; e.element('environmentAreaForm').dispatch('submit'); await flush();
    e.closeArea[0].dispatch(); resolveSearch({ ok: true, json: async () => ({ results: [{ name: 'late', latitude: 0.1, longitude: 1.2 }] }) }); await flush();
    assert.deepEqual(e.element('environmentAreaResults').children, []); assert.equal(e.positions.length, 0);
    assert.equal(e.element('environmentAreaSearchButton').disabled, false);
});

test('map GPS fallback is fresh and its deadline releases controls and prevents late coordinate transmission', async () => {
    const e = environment({ gpsPlan: [3, 'pending'] }); await flush(); e.requests.length = 0;
    e.element('medicalMapButton').dispatch(); e.element('mapLocationConsentCheck').checked = true;
    e.element('mapLocationButton').dispatch(); e.element('mapLocationButton').dispatch();
    assert.equal(e.positions.length, 2); assert.equal(e.positions[0].enableHighAccuracy, false);
    assert.equal(e.positions[1].enableHighAccuracy, true); assert.equal(e.positions[1].maximumAge, 0);
    e.fireTimers(30000); assert.equal(e.element('mapLocationButton').disabled, false);
    e.gpsCallbacks[1].success({ coords: { latitude: 0.1, longitude: 1.2, accuracy: 5 } }); await flush();
    assert.deepEqual(e.requests, []); assert.doesNotMatch(e.element('googleMapIframe').src, /marker=|&ll=/);
});

test('explicit Google map consent creates encoded universal search links; iframe failure preserves the direct-search fallback', async () => {
    const e = environment(); await flush(); e.element('medicalMapButton').dispatch();
    e.element('mapLocationConsentCheck').checked = true; e.element('googleMapLocationConsentCheck').checked = true;
    e.element('mapLocationButton').dispatch(); await flush();
    assert.match(e.element('btnExternalNav').href, /api=1&query=/);
    assert.match(decodeURIComponent(e.element('btnExternalNav').href), /คลินิก.*0\.1235,1\.2346/);
    e.element('mapBtnHosp').dispatch();
    const mapHost = new URL(e.element('googleMapIframe').src).origin;
    const policy = JSON.parse(readFileSync(join(__dirname, '../vercel-public/vercel.json'), 'utf8'));
    const csp = policy.headers[0].headers.find(h => h.key === 'Content-Security-Policy').value;
    assert.ok(csp.match(/frame-src [^;]+/)[0].includes(mapHost));
    const directLink = e.element('medicalMapExternalTop').href;
    e.element('googleMapIframe').dispatch('error');
    assert.equal(e.element('mapFrameFallback').classList.contains('hidden'), false);
    assert.equal(e.element('medicalMapExternalTop').href, directLink);
});

test('guest can open and cancel location consent; no location or external data is requested before opt-in', async () => {
    const e = environment(); await flush(); e.requests.length = 0;
    assert.equal(e.positions.length, 0);
    e.element('environmentLocationButton').dispatch();
    assert.equal(e.element('environmentLocationConsentModal').classList.contains('hidden'), false);
    assert.equal(e.element('environmentLocationConsentCheck').checked, false);
    e.element('environmentLocationConfirmButton').dispatch();
    assert.match(e.element('environmentLocationConsentStatus').textContent, /โปรดยืนยัน/);
    e.closeConsent[1].dispatch();
    assert.equal(e.element('environmentLocationConsentModal').classList.contains('hidden'), true);
    assert.equal(e.positions.length, 0); assert.deepEqual(e.requests, []); assert.deepEqual(e.redirects, []);
});

test('anonymous opted-in visitor gets fresh GPS and rounded provider coordinates without account APIs', async () => {
    const e = environment(); await flush(); e.requests.length = 0;
    e.element('environmentLocationButton').dispatch(); e.element('environmentLocationConsentCheck').checked = true;
    e.element('environmentLocationConfirmButton').dispatch(); await flush();
    assert.equal(e.positions.length, 1);
    assert.equal(e.positions[0].maximumAge, 0); assert.equal(e.positions[0].timeout, 6000);
    assert.equal(e.positions[0].enableHighAccuracy, false);
    assert.equal(e.requests.length, 3);
    assert.ok(e.requests.every(url => url === '/api/environment' || new URL(url).hostname === 'nominatim.openstreetmap.org'));
    for (const url of e.requests) { assert.doesNotMatch(url, /0\.123456|1\.234567/); }
    assert.equal(e.requestBodies[0].latitude, 0.1235); assert.equal(e.requestBodies[0].longitude, 1.2346);
    assert.ok(e.requestBodies.every(body => body.latitude === 0.1235 && body.longitude === 1.2346));
    assert.ok(e.requests.filter(url => url.startsWith('/')).every(url => !url.includes('?')));
    assert.equal(e.element('card-temp-val').textContent, '24.3°C');
    assert.match(e.element('environment-area-text').textContent, /พื้นที่ทดสอบ/);
    assert.match(e.element('environment-current-weather').textContent, /ท้องฟ้าโปร่ง/);
    assert.equal(e.element('environmentLocationButton').disabled, false);
    e.element('environmentRefreshButton').dispatch(); await flush();
    assert.equal(e.positions.length, 2); assert.equal(e.requests.length, 6);
    assert.deepEqual(e.redirects, []);
});

test('account service outage does not disable public location controls', async () => {
    const e = environment({ accountFailure: true }); await flush(); e.requests.length = 0;
    e.element('environmentRefreshButton').dispatch();
    assert.equal(e.element('environmentLocationConsentModal').classList.contains('hidden'), false);
    assert.equal(e.positions.length, 0);
    e.element('environmentLocationConsentCheck').checked = true;
    e.element('environmentLocationConfirmButton').dispatch(); await flush();
    assert.equal(e.element('card-temp-val').textContent, '24.3°C');
    assert.ok(e.requests.every(url => url === '/api/environment' || url.startsWith('https://'))); assert.deepEqual(e.redirects, []);
});

test('permission denial, timeout and unavailable GPS show actionable errors without sending coordinates', async () => {
    for (const code of [1, 2, 3]) {
        const e = environment({ gpsError: code }); await flush(); e.requests.length = 0;
        e.element('environmentLocationButton').dispatch(); e.element('environmentLocationConsentCheck').checked = true;
        e.element('environmentLocationConfirmButton').dispatch();
        assert.equal(e.element('card-temp-val').textContent, '—'); assert.deepEqual(e.requests, []);
        assert.match(e.element('environment-area-text').textContent, /Location|GPS/);
        assert.equal(e.positions.length, code === 1 ? 1 : 2);
        assert.equal(e.element('environmentLocationButton').disabled, false);
    }
    for (const config of [{ secure: false }, { supported: false }]) {
        const e = environment(config); await flush(); e.requests.length = 0;
        e.element('environmentLocationButton').dispatch();
        assert.equal(e.positions.length, 0); assert.deepEqual(e.requests, []);
        assert.match(e.element('environment-area-text').textContent, /HTTPS|ไม่รองรับ/);
    }
});

test('provider failures do not fabricate weather, and restarting asks for separate unchecked consent', async () => {
    const e = environment({ weatherFailure: true }); await flush(); e.requests.length = 0;
    e.element('environmentLocationButton').dispatch(); e.element('environmentLocationConsentCheck').checked = true;
    e.element('environmentLocationConfirmButton').dispatch(); await flush();
    assert.equal(e.element('card-temp-val').textContent, '—');
    assert.match(e.element('environment-area-text').textContent, /ไม่สำเร็จ/);
    e.element('environmentLocationButton').dispatch();
    assert.equal(e.element('environmentLocationConsentCheck').checked, false);
});

test('weather details and their close controls work with keyboard and no inline handlers', async () => {
    const e = environment(); await flush();
    e.cards[0].dispatch('keydown', { key: 'Enter' });
    assert.equal(e.element('envDetailModal').classList.contains('hidden'), false);
    e.closeDetails[0].dispatch();
    assert.equal(e.element('envDetailModal').classList.contains('hidden'), true);
    e.cards[1].dispatch('click');
    assert.equal(e.element('envDetailModal').classList.contains('hidden'), false);
    e.closeDetails[1].dispatch();
    assert.equal(e.element('envDetailModal').classList.contains('hidden'), true);
    assert.equal(e.positions.length, 0);
});

function optIn(e) {
    e.element('environmentLocationButton').dispatch();
    e.element('environmentLocationConsentCheck').checked = true;
    e.element('environmentLocationConfirmButton').dispatch();
}

test('fast location timeout retries fresh high-accuracy GPS once, never permission denial', async () => {
    for (const code of [2, 3]) {
        const e = environment({ gpsPlan: [code] }); await flush(); e.requests.length = 0;
        optIn(e); await flush();
        assert.equal(e.positions.length, 2);
        assert.equal(e.positions[0].enableHighAccuracy, false);
        assert.equal(e.positions[1].enableHighAccuracy, true);
        assert.equal(e.positions[1].maximumAge, 0); assert.equal(e.positions[1].timeout, 10000);
        assert.equal(e.element('card-temp-val').textContent, '24.3°C');
    }
});

test('pending location shows help, prevents duplicate requests and discards late callbacks after deadline', async () => {
    const e = environment({ gpsPlan: ['pending'] }); await flush(); e.requests.length = 0;
    optIn(e);
    e.element('environmentRefreshButton').dispatch(); e.element('environmentLocationConfirmButton').dispatch();
    assert.equal(e.positions.length, 1); assert.deepEqual(e.requests, []);
    assert.equal(e.element('environmentLocationButton').disabled, true);
    e.fireTimers(5000);
    assert.match(e.element('environment-source-text').textContent, /อนุญาต Location/);
    e.fireTimers(30000);
    assert.equal(e.element('environmentLocationButton').disabled, false);
    assert.match(e.element('environment-area-text').textContent, /ยังหาตำแหน่งไม่สำเร็จ/);
    e.gpsCallbacks[0].success({ timestamp: Date.now(), coords: { latitude: 0.123456, longitude: 1.234567, accuracy: 50 } });
    await flush(); assert.deepEqual(e.requests, []);
    assert.equal(e.element('card-temp-val').textContent, '—');
});

test('weather renders immediately without waiting for place name or AQI, then adds optional results', async () => {
    const pending = new Map();
    const e = environment({ providerResponse(url, options, data) {
        if (new URL(url).hostname === 'api.open-meteo.com') return { ok: true, json: async () => data };
        return new Promise(resolve => pending.set(new URL(url).hostname, () => resolve({ ok: true, json: async () => data })));
    } });
    await flush(); optIn(e); await flush();
    assert.equal(e.element('card-temp-val').textContent, '24.3°C');
    assert.equal(e.element('card-humidity-val').textContent, '50%');
    assert.equal(e.element('card-aqi-val').textContent, '—');
    assert.match(e.element('card-aqi-status').textContent, /กำลังโหลด AQI/);
    assert.equal(e.element('environmentLocationButton').disabled, false);
    pending.get('nominatim.openstreetmap.org')(); await flush();
    assert.match(e.element('environment-area-text').textContent, /พื้นที่ทดสอบ/);
    pending.get('air-quality-api.open-meteo.com')(); await flush();
    assert.equal(e.element('card-aqi-val').textContent, 20);
});

test('AQI or geocoder failure never removes successful current weather or invents clean air', async () => {
    const e = environment({ providerResponse(url, options, data) {
        if (new URL(url).hostname !== 'api.open-meteo.com') throw new Error('Optional service unavailable');
        return { ok: true, json: async () => data };
    } });
    await flush(); optIn(e); await flush();
    assert.equal(e.element('card-temp-val').textContent, '24.3°C');
    assert.equal(e.element('card-aqi-val').textContent, '—');
    assert.equal(e.element('card-aqi-status').textContent, 'บริการ AQI ไม่พร้อม');
    assert.doesNotMatch(e.run('liveEnvData.aqi.desc'), /อากาศสะอาด/);
});

test('malformed or missing current readings cannot become zero-valued weather', async () => {
    for (const value of [null, undefined, '24', NaN, Infinity]) {
        const e = environment({ providerResponse(url, options, data) {
            if (new URL(url).hostname === 'api.open-meteo.com') data.current.temperature_2m = value;
            return { ok: true, json: async () => data };
        } });
        await flush(); optIn(e); await flush();
        assert.equal(e.element('card-temp-val').textContent, '—');
        assert.equal(e.element('environmentLocationButton').disabled, false);
        assert.match(e.element('environment-area-text').textContent, /ไม่สำเร็จ/);
    }
});

test('weather response body timeout is bounded and releases controls instead of spinning forever', async () => {
    const e = environment({ providerResponse(url, options, data) {
        if (new URL(url).hostname !== 'api.open-meteo.com') return { ok: true, json: async () => data };
        return { ok: true, json: () => new Promise((resolve, reject) => {
            options.signal.addEventListener('abort', () => reject(new Error('Aborted')), { once: true });
        }) };
    } });
    await flush(); optIn(e); await flush();
    assert.equal(e.element('environmentLocationButton').disabled, true);
    e.fireTimers(8000); await flush();
    assert.equal(e.element('environmentLocationButton').disabled, false);
    assert.equal(e.element('card-temp-val').textContent, '—');
});

test('late optional results from an older location cannot overwrite refreshed current weather', async () => {
    const late = [];
    let weatherCount = 0;
    const e = environment({ providerResponse(url, options, data) {
        const host = new URL(url).hostname;
        if (host === 'api.open-meteo.com') {
            data.current.temperature_2m = ++weatherCount === 1 ? 24.3 : 30.5;
            return { ok: true, json: async () => data };
        }
        if (!weatherCount) return new Promise(resolve => late.push(() => resolve({ ok: true, json: async () => data })));
        if (host === 'nominatim.openstreetmap.org') data.address.city = 'พื้นที่ใหม่';
        else data.current.us_aqi = 70;
        return { ok: true, json: async () => data };
    } });
    await flush(); optIn(e); await flush();
    e.element('environmentRefreshButton').dispatch(); await flush();
    assert.equal(e.positions.length, 2);
    assert.equal(e.element('card-temp-val').textContent, '30.5°C');
    late.forEach(resolve => resolve()); await flush();
    assert.equal(e.element('card-temp-val').textContent, '30.5°C');
    assert.equal(e.element('card-aqi-val').textContent, 70);
    assert.match(e.element('environment-area-text').textContent, /พื้นที่ใหม่/);
});

test('day or night presentation uses current provider data and a failed refresh clears stale detail values', async () => {
    const e = environment({ gpsPlan: [undefined, 1], providerResponse(url, options, data) {
        if (new URL(url).hostname === 'api.open-meteo.com') data.current.is_day = 0;
        return { ok: true, json: async () => data };
    } });
    await flush(); optIn(e); await flush();
    assert.match(e.element('time-period-text').textContent, /กลางคืน/);
    e.element('environmentRefreshButton').dispatch(); await flush();
    assert.equal(e.element('card-temp-val').textContent, '—');
    assert.equal(e.run('liveEnvData.temp.val'), '—');
    assert.doesNotMatch(e.element('env-summary-text').textContent, /24\.3/);
});

test('invalid browser coordinates are never sent to external weather providers', async () => {
    const e = environment({ gpsPlan: [{ timestamp: Date.now(), coords: { latitude: 999, longitude: NaN } }] });
    await flush(); e.requests.length = 0; optIn(e); await flush();
    assert.deepEqual(e.requests, []); assert.equal(e.element('environmentLocationButton').disabled, false);
});
