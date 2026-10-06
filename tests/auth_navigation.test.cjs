const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');

function adminEnvironment(fetch) {
    const nodes = new Map();
    const redirects = [];
    const element = id => {
        if (!nodes.has(id)) {
            const classes = new Set(['hidden']);
            nodes.set(id, { textContent: '', disabled: false, className: '',
                classList: { add: n => classes.add(n), remove: n => classes.delete(n), contains: n => classes.has(n),
                    toggle: (n, on) => on ? classes.add(n) : classes.delete(n) },
                setAttribute() {}, addEventListener() {}, focus() {},
                appendChild() {}, append() {}, replaceChildren() {},
            });
        }
        return nodes.get(id);
    };
    const context = vm.createContext({ fetch, AbortController, setTimeout, clearTimeout, console, Intl, Date,
        document: { getElementById: element, addEventListener() {}, createElement: element },
        window: { location: { replace: path => redirects.push(path) } },
    });
    const source = readFileSync(join(__dirname, '../vercel-public/admin.js'), 'utf8');
    vm.runInContext(source.replace(/\}\)\(\);\s*$/, 'globalThis.testAdmin = { loadAdmin };})();'), context);
    return { context, element, redirects, load: context.testAdmin.loadAdmin };
}

const response = (status, data) => ({ ok: status >= 200 && status < 300, status, json: async () => data });
const overview = { ok: true, admin: { name: 'test' }, counts: { users: 1, pendingUsers: 2, scans: 4, feedbacks: 0 }, users: [], feedbacks: [] };

test('admin overview 503/network/bad JSON errors offer retry, not a redirect loop', async () => {
    for (const fetch of [async () => response(503, {}), async () => { throw new Error('offline'); },
        async () => ({ ok: true, status: 200, json: async () => { throw new Error('bad json'); } })]) {
        const e = adminEnvironment(fetch);
        await e.load();
        assert.deepEqual(e.redirects, []);
        assert.equal(e.element('adminLoadError').classList.contains('hidden'), false);
        assert.equal(e.element('adminMain').classList.contains('hidden'), true);
        assert.equal(e.element('adminReloadButton').disabled, false);
    }
});

test('partial storage outage opens account management and shows unavailable, not zero statistics', async () => {
    const e = adminEnvironment(async () => response(200, { ...overview,
        counts: { ...overview.counts, scans: null, feedbacks: null },
        privateSummaryAvailable: false, feedbacksAvailable: false, warning: 'storage unavailable' }));
    await e.load();
    assert.deepEqual(e.redirects, []);
    assert.equal(e.element('adminMain').classList.contains('hidden'), false);
    assert.equal(e.element('scanCount').textContent, '—');
    assert.equal(e.element('feedbackCount').textContent, 'ยังโหลดไม่ได้');
    assert.match(e.element('feedbackList').textContent, /ยังโหลด/);
    assert.equal(e.element('adminStorageWarning').classList.contains('hidden'), false);
    assert.match(e.element('adminDataStatus').textContent, /ยังไม่พร้อม/);
});

test('manual retry recovers after a temporary outage and prevents overlapping requests', async () => {
    let finish;
    let calls = 0;
    const e = adminEnvironment(() => { calls++; return new Promise(resolve => { finish = resolve; }); });
    const pending = e.load();
    await e.load();
    assert.equal(calls, 1);
    finish(response(503, {})); await pending;
    e.context.fetch = async () => response(200, overview);
    await e.load();
    assert.deepEqual(e.redirects, []);
    assert.equal(e.element('adminLoadError').classList.contains('hidden'), true);
    assert.equal(e.element('adminMain').classList.contains('hidden'), false);
});

test('real authorization rejection and MFA enrollment still protect admin access', async () => {
    for (const status of [401, 403]) {
        const e = adminEnvironment(async () => response(status, { ok: false }));
        await e.load();
        assert.deepEqual(e.redirects, ['/?signin=1']);
        assert.equal(e.element('adminMain').classList.contains('hidden'), true);
    }
    const e = adminEnvironment(async () => response(403, { code: 'mfa_enrollment_required' }));
    await e.load();
    assert.deepEqual(e.redirects, ['/admin-mfa-enroll.html']);
});

function landingRestoreEnvironment(search, result) {
    const redirects = []; const messages = []; let requests = 0;
    const source = readFileSync(join(__dirname, '../vercel-public/app.js'), 'utf8');
    const restore = source.match(/        async function restoreAccountSession\(\) \{[\s\S]*?\n        \}\n/)[0];
    const context = vm.createContext({ URLSearchParams,
        window: { location: { search, replace: path => redirects.push(path) } },
        accountRequest: async () => { requests++; return result; },
        setAccountStatus: message => messages.push(message),
    });
    vm.runInContext(`${restore}\nglobalThis.restore = restoreAccountSession;`, context);
    return { redirects, messages, requests: () => requests, restore: context.restore };
}

test('return to sign-in does not automatically redirect an unprivileged cookie back to protected pages', async () => {
    const e = landingRestoreEnvironment('?signin=1', { user: { role: 'admin' } });
    await e.restore();
    assert.equal(e.requests(), 0); assert.deepEqual(e.redirects, []);
    assert.match(e.messages[0], /เข้าสู่ระบบอีกครั้ง/);
});

test('ordinary valid session restore still routes the authenticated user correctly', async () => {
    for (const role of ['user', 'admin']) {
        const e = landingRestoreEnvironment('', { user: { role } }); await e.restore();
        assert.equal(e.requests(), 1);
        assert.deepEqual(e.redirects, [role === 'admin' ? '/admin.html' : '/dashboard.html']);
    }
});

test('private summary outages remain separate from successful authentication and never leak errors', async () => {
    const { adminPrivateSummary } = await import('../vercel-public/lib/admin-private-summary.js');
    const result = await adminPrivateSummary({ count: async () => { throw new Error('SECRET_UPSTREAM'); }, select: async () => { throw new Error('SECRET_UPSTREAM'); } });
    assert.equal(result.available, false); assert.equal(result.scans, null); assert.equal(result.feedbacks, null);
    assert.equal(result.feedbackRowsAvailable, false); assert.deepEqual(result.feedbackRows, []);
    assert.ok(!JSON.stringify(result).includes('SECRET_UPSTREAM'));
    const source = readFileSync(join(__dirname, '../vercel-public/api/admin-handler.js'), 'utf8');
    assert.match(source, /const summary = await adminPrivateSummary\(\)/);
    assert.match(source, /feedbacksAvailable,/);
});

test('summary preserves each successful field and honors bounded read aborts', async () => {
    const { adminPrivateSummary } = await import('../vercel-public/lib/admin-private-summary.js');
    const result = await adminPrivateSummary({ count: async table => table.includes('scan') ? 9 : Promise.reject(new Error('failed')),
        select: async () => [{ id: 'test' }] });
    assert.equal(result.scans, 9); assert.equal(result.feedbacks, null); assert.equal(result.feedbackRowsAvailable, true);
    let aborted = 0;
    const waitForAbort = (table, query, { signal }) => new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => { aborted++; reject(new Error('aborted')); }, { once: true });
    });
    const timed = await adminPrivateSummary({ count: waitForAbort, select: waitForAbort, timeoutMs: 10 });
    assert.equal(aborted, 3); assert.equal(timed.available, false);
});

test('invalid private counts cannot be displayed as real statistics', async () => {
    const { adminPrivateSummary } = await import('../vercel-public/lib/admin-private-summary.js');
    const result = await adminPrivateSummary({ count: async () => -1, select: async () => null });
    assert.equal(result.scans, null); assert.equal(result.feedbacks, null); assert.equal(result.feedbackRowsAvailable, false);
});

test('actual overview route returns account management during a storage outage, after authenticating admin', async () => {
    const { adminPrivateSummary } = await import('../vercel-public/lib/admin-private-summary.js');
    const source = readFileSync(join(__dirname, '../vercel-public/api/admin-handler.js'), 'utf8')
        .replace(/^import[\s\S]*?from ['"][^'"]+['"];\r?\n/gm, '')
        .replace('export default async function handler', 'async function handler');
    const sql = async strings => strings.join('').includes('COUNT(*)') ? [{ value: 2 }] : [];
    let dbCalls = 0;
    const context = vm.createContext({
        requireGet: () => true, sessionClaims: () => ({ sub: 1 }),
        publicUserById: async () => ({ id: 1, role: 'admin', name: 'test', email: '' }),
        database: async () => { dbCalls++; return sql; }, isSupabasePrivateStorageConfigured: () => true,
        adminPrivateSummary: () => adminPrivateSummary({ count: async () => { throw new Error('offline'); }, select: async () => { throw new Error('offline'); } }),
        json: (res, status, body) => ({ status, body }),
        publicError: () => { throw new Error('unexpected fatal overview error'); },
    });
    vm.runInContext(`${source}\nglobalThis.overviewRoute = overview;`, context);
    const result = await context.overviewRoute({ method: 'GET', headers: {} }, {});
    assert.equal(result.status, 200); assert.equal(result.body.ok, true); assert.equal(dbCalls, 1);
    assert.equal(result.body.counts.users, 2); assert.equal(result.body.counts.scans, null);
    assert.equal(result.body.feedbacksAvailable, false); assert.match(result.body.warning, /ยังจัดการบัญชี/);
    context.sessionClaims = () => null;
    assert.equal((await context.overviewRoute({ method: 'GET' }, {})), undefined);
    assert.equal(dbCalls, 1);
    let deniedStatus;
    context.json = (res, status) => { deniedStatus = status; };
    context.sessionClaims = () => ({ sub: 2 }); context.publicUserById = async () => ({ role: 'user' });
    await context.overviewRoute({ method: 'GET' }, {});
    assert.equal(deniedStatus, 403); assert.equal(dbCalls, 1);
});
