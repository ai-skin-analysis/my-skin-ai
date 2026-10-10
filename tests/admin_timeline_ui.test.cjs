const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const source = readFileSync(require.resolve('../vercel-public/admin-timeline.js'), 'utf8');
const id = '11111111-1111-4111-8111-111111111111';
async function environment() {
  const presenter = await import('../vercel-public/research-result.js');
  const gradcam = await import('../vercel-public/research-gradcam.js');
  const { SCIN3_CLASSES } = await import('../vercel-public/research-catalog.js');
  const row = { id, userId: 2, originalName: '<script>not markup</script>.jpg', source: 'upload',
    createdAt: new Date().toISOString(), consentedAt: new Date().toISOString(),
    retentionExpiresAt: new Date(Date.now() + 86400000).toISOString(),
    imageUrl: `/api/admin/shared-image?userId=2&scanId=${id}`, analysis: { ok: true, code: 'RESEARCH_ONLY', releaseStatus: 'research_only',
      classificationStatus: 'experimental', publicDeployment: false, scopeValidated: false, unsupportedValidated: false,
      modelVersion: 'scin3-local-baab96df5bf5', diagnostics: SCIN3_CLASSES.map((c, i) => ({ id: c.id, score: i ? .05 : .9 })) } };
  const nodes = new Map(), revoked = [], listeners = new Map(); let urlIndex = 0;
  const doc = { hidden: false, defaultView: {} };
  const make = tag => {
    const classes = new Set(); const callbacks = new Map();
    const value = { tagName: tag, ownerDocument: doc, children: [], dataset: {}, textContent: '', value: '', open: false,
      classList: { add: (...v) => v.forEach(x => classes.add(x)), remove: (...v) => v.forEach(x => classes.delete(x)),
        contains: x => classes.has(x), toggle: (x, on) => on ? classes.add(x) : classes.delete(x) },
      append(...values) { for (const child of values) { child.remove(); this.children.push(child); child.parent = this; } },
      replaceChildren(...values) { this.children.forEach(x => x.parent = null); this.children = []; this.append(...values); },
      remove() { if (this.parent) { this.parent.children = this.parent.children.filter(x => x !== this); this.parent = null; } },
      removeAttribute(name) { delete this[name]; }, focus() {}, scrollIntoView() {},
      addEventListener(name, cb) { callbacks.set(name, cb); }, fire(name) { return callbacks.get(name)?.(); } };
    return value;
  };
  doc.createElement = make;
  doc.getElementById = key => { if (!nodes.has(key)) nodes.set(key, make('div')); return nodes.get(key); };
  doc.addEventListener = (name, cb) => listeners.set(name, cb);
  const context = vm.createContext({ document: doc, console, AbortController, Blob, Response, Intl, Date,
    setTimeout, clearTimeout, setInterval() {},
    URL: { createObjectURL: () => `blob:test-${++urlIndex}`, revokeObjectURL: url => revoked.push(url) },
    testModules: [presenter, gradcam], fetch: async () => new Response(JSON.stringify({ ok: true, history: [row], nextCursor: null }), { headers: { 'Content-Type': 'application/json' } }) });
  context.window = { addEventListener: (name, cb) => listeners.set(name, cb) };
  vm.runInContext(source.replace(/  const modules = .*\n/, '  const modules = async () => testModules;\n')
    .replace(/\}\)\(\);\s*$/, 'globalThis.ui = { loadHistory, loadPicture, closeHistory, records, stopRequest, clearRecords };})();'), context);
  listeners.get('DOMContentLoaded')();
  context.window.setAdminTimelineUsers([{ id: 2, name: 'fixture', email: 'fixture@example.invalid' }, { id: 3, name: 'private', email: 'private@example.invalid' }]);
  doc.getElementById('adminTimelineUser').value = '2';
  return { context, ui: context.ui, doc, row, revoked, listeners };
}

test('admin timeline uses curated analysis, inert filenames and does not fetch a photo until opening details', async () => {
  const f = await environment(); let pictures = 0;
  f.context.fetch = async path => {
    if (path.includes('shared-image')) { pictures++; return new Response('image', { headers: { 'Content-Type': 'image/jpeg' } }); }
    return new Response(JSON.stringify({ ok: true, history: [f.row] }));
  };
  await f.ui.loadHistory(null);
  assert.equal(pictures, 0); assert.equal(f.ui.records.size, 1);
  const card = f.ui.records.get(id);
  const text = value => [value.textContent, ...value.children.map(text)].join(' ');
  assert.match(text(card.article), /not markup/); assert.match(text(card.article), /สิว/); assert.match(text(card.article), /ไม่ใช่/);
  card.details.open = true;
  await f.ui.loadPicture(card, f.row, 0);
  assert.equal(pictures, 1); assert.match(card.image.src, /^blob:/);
  assert.match(card.camStatus.textContent, /ยังไม่มี Grad-CAM/);
  f.ui.closeHistory(); assert.equal(f.ui.records.size, 0); assert.equal(f.revoked.length, 1);
  assert.equal(card.image.src, undefined); assert.equal(card.canvas.width, 1);
});

test('switching users aborts old requests and cannot display a late result under the new user', async () => {
  const f = await environment(); let finish;
  f.context.fetch = () => new Promise(resolve => finish = resolve);
  const pending = f.ui.loadHistory(null);
  await new Promise(resolve => setImmediate(resolve));
  f.context.window.openAdminTimelineUser(3);
  const newFinish = finish;
  await new Promise(resolve => setImmediate(resolve));
  finish(new Response(JSON.stringify({ ok: true, history: [], nextCursor: null })));
  newFinish(new Response(JSON.stringify({ ok: true, history: [f.row], nextCursor: null })));
  await pending; await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.doc.getElementById('adminTimelineUser').value, '3'); assert.equal(f.ui.records.size, 0);
});

test('periodic refresh keeps open valid records but clears them when revoked or storage/session fails', async () => {
  const f = await environment(); await f.ui.loadHistory(null);
  const first = f.ui.records.get(id); first.details.open = true;
  await f.ui.loadHistory(null); assert.equal(f.ui.records.get(id), first); assert.equal(first.details.open, true);
  f.context.fetch = async () => new Response(JSON.stringify({ ok: true, history: [] }));
  await f.ui.loadHistory(null); assert.equal(f.ui.records.size, 0); assert.equal(first.canvas.width, 1);
  f.context.fetch = async () => new Response(JSON.stringify({ ok: true, history: [f.row] }));
  await f.ui.loadHistory(null);
  f.context.fetch = async () => new Response(JSON.stringify({ ok: false, code: 'mfa_required' }), { status: 403 });
  await f.ui.loadHistory(null); assert.equal(f.ui.records.size, 0);
  assert.match(f.doc.getElementById('adminTimelineStatus').textContent, /MFA/);
});

test('backgrounding a health timeline clears pixel/result memory; external image URLs are never fetched', async () => {
  const f = await environment(); await f.ui.loadHistory(null); const card = f.ui.records.get(id); card.details.open = true;
  let fetched = 0; f.context.fetch = async () => { fetched++; return new Response('image'); };
  await f.ui.loadPicture(card, { ...f.row, imageUrl: 'https://example.invalid/photo.jpg' }, 0);
  assert.equal(fetched, 0); assert.equal(card.image.src, undefined);
  f.doc.hidden = true; f.listeners.get('visibilitychange')();
  assert.equal(f.ui.records.size, 0); assert.equal(f.doc.getElementById('adminTimelineList').children.length, 0);
});

test('an old aborted image cannot cancel a replacement image request after closing and reopening details', async () => {
  const f = await environment(); await f.ui.loadHistory(null); const card = f.ui.records.get(id); card.details.open = true;
  const finish = [];
  f.context.fetch = () => new Promise((resolve, reject) => finish.push({ resolve, reject }));
  const old = f.ui.loadPicture(card, f.row, 0);
  card.details.open = false; card.details.fire('toggle');
  card.details.open = true;
  const current = f.ui.loadPicture(card, f.row, 0);
  finish[0].reject(new Error('aborted old request')); await old;
  assert.equal(card.imageController.signal.aborted, false);
  finish[1].resolve(new Response('image', { headers: { 'Content-Type': 'image/jpeg' } })); await current;
  assert.match(card.image.src, /^blob:/); f.ui.closeHistory();
});

test('owner scan consent is unchecked by default and a top result back button binds the existing no-network return', () => {
  const html = readFileSync(require.resolve('../vercel-public/dashboard.html'), 'utf8');
  const input = html.match(/<input id="dashboardAdminShareInput"[^>]*>/)[0];
  assert.doesNotMatch(input, /\bchecked\b/);
  assert.match(html, /ไม่ติ๊กก็สแกนได้ตามปกติ/);
  assert.match(html, /id="dashboardAnalysisBackButton"/); assert.match(html, /id="userRevokeAdminShareButton"/);
  const dash = readFileSync(require.resolve('../vercel-public/dashboard.js'), 'utf8');
  assert.match(dash, /dashboardAnalysisBackButton'\)\.addEventListener\('click', returnToScan\)/);
  assert.equal((dash.match(/dashboardAdminShareInput'\)\.checked = false/g) || []).length, 3);
  const back = dash.match(/function returnToScan\(\)[\s\S]*?\n    \}/)[0];
  assert.doesNotMatch(back, /fetch\(|userRequest\(|logout/);
});
