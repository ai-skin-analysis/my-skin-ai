const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');

const html = readFileSync(join(__dirname, '../vercel-public/index.html'), 'utf8');
const script = readFileSync(join(__dirname, '../vercel-public/app.js'), 'utf8');
const flush = async () => { for (let n = 0; n < 5; n++) await new Promise(setImmediate); };

function environment({ secure = true, supported = true, accountFailure = false, gpsError = null, weatherFailure = false } = {}) {
    const nodes = new Map(), documentEvents = new Map(), requests = [], positions = [], redirects = [];
    class Element {
        constructor(id) {
            this.id = id; this.textContent = ''; this.checked = false; this.style = {}; this.dataset = {};
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
        closest() { return null; }
        querySelector(selector) { return selector.startsWith('#') ? element(selector.slice(1)) : null; }
        querySelectorAll() { return []; }
    }
    const element = id => { if (!nodes.has(id)) nodes.set(id, new Element(id)); return nodes.get(id); };
    const closeConsent = [element('closeEnvironment'), element('cancelEnvironment')];
    const closeDetails = [element('closeDetails'), element('acceptDetails')];
    const cards = ['uv', 'temp', 'humidity', 'aqi'].map(key => {
        const card = element(`detail-${key}`); card.dataset.environmentDetail = key; return card;
    });
    const document = { getElementById: element, activeElement: element('environmentLocationButton'),
        documentElement: element('html'), body: element('body'),
        addEventListener(type, fn) { documentEvents.set(type, fn); },
        querySelectorAll(selector) {
            if (selector === '[data-close-environment-consent]') return closeConsent;
            if (selector === '[data-close-environment-detail]') return closeDetails;
            if (selector === '[data-environment-detail]') return cards;
            if (selector === '[data-accessible-modal="true"]') return [element('environmentLocationConsentModal'), element('envDetailModal')];
            return [];
        } };
    const fetch = async url => {
        requests.push(String(url));
        if (url === '/api/account/me') {
            if (accountFailure) throw new Error('Account service unavailable');
            return { ok: true, json: async () => ({ ok: true, user: null }) };
        }
        if (weatherFailure) throw new Error('Provider unavailable');
        const host = new URL(url).hostname;
        const data = host === 'api.open-meteo.com' ? { current: { temperature_2m: 24.3, relative_humidity_2m: 50, uv_index: 3, weather_code: 0, time: '2026-10-10T10:00' }, timezone: 'UTC' }
            : host === 'air-quality-api.open-meteo.com' ? { current: { us_aqi: 20, time: '2026-10-10T10:00' }, timezone: 'UTC' }
            : { address: { city: 'พื้นที่ทดสอบ' } };
        return { ok: true, json: async () => data };
    };
    const context = vm.createContext({ document, HTMLElement: Element, navigator: { onLine: true,
        ...(supported ? { geolocation: { getCurrentPosition(success, error, options) {
            positions.push(options);
            if (gpsError) error({ code: gpsError });
            else success({ timestamp: Date.now(), coords: { latitude: 0.123456, longitude: 1.234567, accuracy: 50 } });
        } } } : {}) }, fetch, AbortController, Intl, Date, URLSearchParams,
        window: { isSecureContext: secure, matchMedia: () => ({ matches: true }),
            setTimeout: () => 1, clearTimeout() {}, setInterval() {},
            location: { search: '', replace: path => redirects.push(path) } } });
    vm.runInContext(script, context);
    documentEvents.get('DOMContentLoaded')();
    return { element, requests, positions, redirects, closeConsent, closeDetails, cards };
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
    assert.equal(e.positions[0].maximumAge, 0); assert.equal(e.positions[0].timeout, 15000);
    assert.equal(e.requests.length, 3);
    assert.ok(e.requests.every(url => ['api.open-meteo.com', 'air-quality-api.open-meteo.com', 'nominatim.openstreetmap.org'].includes(new URL(url).hostname)));
    for (const url of e.requests) { assert.doesNotMatch(url, /0\.123456|1\.234567/); }
    assert.match(e.requests[0], /latitude=0\.1235&longitude=1\.2346/);
    assert.equal(e.element('card-temp-val').textContent, '24.3°C');
    assert.match(e.element('location-text').textContent, /พื้นที่ทดสอบ/);
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
    assert.ok(e.requests.every(url => url.startsWith('https://'))); assert.deepEqual(e.redirects, []);
});

test('permission denial, timeout and unavailable GPS show actionable errors without sending coordinates', async () => {
    for (const code of [1, 2, 3]) {
        const e = environment({ gpsError: code }); await flush(); e.requests.length = 0;
        e.element('environmentLocationButton').dispatch(); e.element('environmentLocationConsentCheck').checked = true;
        e.element('environmentLocationConfirmButton').dispatch();
        assert.equal(e.element('card-temp-val').textContent, '—'); assert.deepEqual(e.requests, []);
        assert.match(e.element('location-text').textContent, /Location|GPS|นานเกินไป/);
    }
    for (const config of [{ secure: false }, { supported: false }]) {
        const e = environment(config); await flush(); e.requests.length = 0;
        e.element('environmentLocationButton').dispatch();
        assert.equal(e.positions.length, 0); assert.deepEqual(e.requests, []);
        assert.match(e.element('location-text').textContent, /HTTPS|ไม่รองรับ/);
    }
});

test('provider failures do not fabricate weather, and restarting asks for separate unchecked consent', async () => {
    const e = environment({ weatherFailure: true }); await flush(); e.requests.length = 0;
    e.element('environmentLocationButton').dispatch(); e.element('environmentLocationConsentCheck').checked = true;
    e.element('environmentLocationConfirmButton').dispatch(); await flush();
    assert.equal(e.element('card-temp-val').textContent, '—');
    assert.match(e.element('location-text').textContent, /ไม่สำเร็จ/);
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
