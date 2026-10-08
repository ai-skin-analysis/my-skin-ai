const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');

function documentFixture() {
  const ids = new Map();
  const doc = { title: '', activeElement: null };
  doc.createElement = tag => {
    const classes = new Set(['hidden']);
    return { tagName: tag, ownerDocument: doc, children: [], dataset: {}, textContent: '',
      classList: { add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name) },
      append(...nodes) { this.children.push(...nodes); }, replaceChildren(...nodes) { this.children = nodes; },
      removeAttribute(name) { delete this[name]; }, focus() { doc.activeElement = this; } };
  };
  doc.getElementById = id => {
    if (!ids.has(id)) ids.set(id, doc.createElement('div'));
    return ids.get(id);
  };
  return doc;
}

async function fixture() {
  const { SCAN_CLASSES } = await import('../vercel-public/scan-result.js');
  const presenter = await import('../vercel-public/research-result.js');
  const analysis = { ok: true, code: 'RESEARCH_ONLY', releaseStatus: 'research_only', classificationStatus: 'experimental',
    modelVersion: 'derm-local-e10f89ad2ac8', publicDeployment: false, scopeValidated: false, unsupportedValidated: false,
    diagnostics: SCAN_CLASSES.map((row, index) => ({ id: row.id, score: index ? 0.1 / 19 : 0.9 })) };
  return { ...presenter, analysis, completed: { analysis, storedImage: true, scan: { id: 'saved', createdAt: '2026-10-07T16:00:00Z' } } };
}

test('accepted completion opens an accessible AI screen with real version, private preview and two educational groups', async () => {
  const f = await fixture(); const doc = documentFixture();
  const view = f.renderAnalysisScreen(doc, f.completed, { imageName: '<script>file.jpg</script>', previewUrl: 'blob:owned-local' });
  assert.equal(view.candidates.length, 2);
  assert.equal(doc.getElementById('dashboardAnalysisModel').textContent, f.analysis.modelVersion);
  assert.equal(doc.getElementById('dashboardAnalysisImage').src, 'blob:owned-local');
  assert.equal(doc.getElementById('dashboardAnalysisImageName').textContent, '<script>file.jpg</script>');
  assert.equal(doc.activeElement, doc.getElementById('dashboardAnalysisTitle'));
  assert.equal(doc.getElementById('dashboardAnalysisView').classList.contains('hidden'), false);
  assert.equal(doc.getElementById('dashboardScanView').classList.contains('hidden'), true);
  assert.match(doc.getElementById('dashboardAnalysisStatus').textContent, /ไม่ใช่ผลวินิจฉัย/);
  const treeText = node => [node.textContent, ...node.children.map(treeText)].join(' ');
  const text = treeText(doc.getElementById('dashboardAnalysisResult'));
  assert.match(text, /อันดับ 1/); assert.match(text, /อันดับ 2/);
  assert.match(text, /ไม่ใช่/); assert.match(text, /33\.1%/);
  assert.equal(text.includes('90%'), false);
  assert.match(text, /ชื่อกลุ่มรอยโรคที่โมเดลจัดไว้ใกล้เคียงที่สุด/);
  assert.match(text, /ผลการวิเคราะห์/);
  assert.match(text, /คำแนะนำเบื้องต้น/);
  assert.match(text, /หลีกเลี่ยงการบีบหรือแกะตุ่ม/);
  assert.match(doc.getElementById('dashboardAnalysisNextMessage').textContent, /คำแนะนำเบื้องต้น/);
});

test('all 20 trained labels have a visible name, explanatory analysis and curated advice after an accepted result', async () => {
  const f = await fixture();
  const { SCAN_CLASSES } = await import('../vercel-public/scan-result.js');
  const treeText = node => [node.textContent, ...node.children.map(treeText)].join(' ');
  for (const [index, item] of SCAN_CLASSES.entries()) {
    const doc = documentFixture();
    const analysis = { ...f.analysis, diagnostics: SCAN_CLASSES.map((row, i) => ({
      id: row.id, score: i === index ? 0.9 : 0.1 / 19,
      name: 'untrusted injected name', recommendation: 'untrusted injected advice',
    })) };
    const view = f.renderAnalysisScreen(doc, { ...f.completed, analysis });
    assert.equal(view.candidates[0].id, item.id);
    const summary = doc.getElementById('dashboardAnalysisResult').children.find(node => node.dataset.analysisSummary === 'accepted');
    const text = treeText(summary);
    assert.ok(text.includes(item.name), item.id);
    assert.ok(item.recommendation?.length > 30, item.id);
    assert.ok(text.includes(item.recommendation), item.id);
    assert.match(text, /ผลการวิเคราะห์/);
    assert.match(text, /คำแนะนำเบื้องต้น/);
    assert.doesNotMatch(text, /untrusted injected/);
    assert.ok(summary.children.some(node => node.tagName === 'a' && node.href === item.source));
  }
});

test('uncertainty clears a prior accepted name and class-specific advice instead of forcing classification', async () => {
  const f = await fixture(); const doc = documentFixture();
  f.renderAnalysisScreen(doc, f.completed);
  const analysis = { ...f.analysis, ok: false, code: 'UNCERTAIN_CLASSIFICATION', diagnostics: undefined };
  f.renderAnalysisScreen(doc, { analysis, storedImage: false, temporaryUploadDeleted: true });
  const treeText = node => [node.textContent, ...node.children.map(treeText)].join(' ');
  const text = treeText(doc.getElementById('dashboardAnalysisResult'));
  assert.doesNotMatch(text, /สิว|โรซาเซีย|หลีกเลี่ยงการบีบหรือแกะตุ่ม/);
  assert.match(text, /เหตุผลที่ยังไม่สรุปชื่อรอยโรค/);
  assert.match(text, /คำแนะนำเบื้องต้น/);
  assert.match(text, /ส่งภาพสำเร็จจึงไม่เท่ากับจำแนกสำเร็จ/);
  assert.match(doc.getElementById('dashboardAnalysisNextMessage').textContent, /ไม่รับประกัน/);
});

test('visible model catalogue contains exactly six PAD labels, not the old twenty, separate from results', async () => {
  const f = await fixture(); const doc = documentFixture();
  const { PAD6_CLASSES: SCAN_CLASSES } = await import('../vercel-public/research-catalog.js');
  const container = doc.getElementById('dashboardModelClassList');
  f.renderModelCatalogue(container);
  f.renderModelCatalogue(container);
  assert.equal(container.children.length, 6);
  assert.deepEqual(container.children.map(node => node.dataset.classId), SCAN_CLASSES.map(item => item.id));
  assert.deepEqual(container.children.map(node => node.textContent), SCAN_CLASSES.map(item => item.name));
  assert.equal(doc.getElementById('dashboardAnalysisResult').children.length, 0);
  const html = readFileSync(require.resolve('../vercel-public/dashboard.html'), 'utf8');
  assert.match(html, /ไม่ใช่ 6 โมเดลหรือภาพฝึกเพียง 6 ภาพ/);
  assert.match(html, /id="dashboardProcessingTitle"[^>]*>วิเคราะห์และจำแนกรอยโรคผิวหนังด้วยปัญญาประดิษฐ์/);
  assert.match(html, /id="dashboardAnalysisTitle"[^>]*>ผลวิเคราะห์และจำแนกรอยโรคด้วยปัญญาประดิษฐ์/);
});

test('uncertain educational comparison shows two curated groups but no diagnosis, percentage or treatment', async () => {
  const f = await fixture(); const doc = documentFixture();
  const comparison = { contract: 'research-ranking-v1', method: 'classifier_score_order',
    status: 'educational_only', clinicallyValidated: false, classCount: 20,
    modelVersion: f.analysis.modelVersion, classIds: ['rosacea', 'acne_vulgaris'], name: 'injected diagnosis' };
  const analysis = { ...f.analysis, ok: false, code: 'UNCERTAIN_CLASSIFICATION', diagnostics: undefined,
    classificationStatus: 'abstained', comparison };
  const view = f.renderAnalysisScreen(doc, { analysis, storedImage: false, temporaryUploadDeleted: true });
  assert.equal(view.candidates.length, 0);
  assert.deepEqual(view.comparisonCandidates.map(row => row.name), ['โรซาเซีย', 'สิว']);
  const container = doc.getElementById('dashboardAnalysisResult');
  assert.equal(container.children.some(node => node.dataset.analysisSummary === 'accepted'), false);
  const section = container.children.find(node => node.dataset.educationalComparison === 'abstained');
  const treeText = node => [node.textContent, ...node.children.map(treeText)].join(' ');
  const text = treeText(section);
  assert.match(text, /ยังจำแนกไม่ได้/); assert.match(text, /ไม่ใช่การวัดความเหมือนกับภาพฝึก/);
  assert.match(text, /ทั้งสองกลุ่มจึงอาจไม่ตรง/);
  assert.match(text, /โรซาเซีย/); assert.match(text, /สิว/);
  assert.doesNotMatch(text, /injected diagnosis|[0-9]+%|หลีกเลี่ยงการบีบหรือแกะตุ่ม/);
  assert.match(doc.getElementById('dashboardAnalysisPrivacy').textContent, /ไม่บันทึกเป็นผลจำแนกสำเร็จ/);
  assert.match(doc.getElementById('dashboardAnalysisStatus').textContent, /ยังไม่สามารถสรุป/);
  f.renderAnalysisScreen(doc, { analysis: { ...analysis, comparison: undefined },
    storedImage: false, temporaryUploadDeleted: true });
  assert.doesNotMatch(treeText(container), /โรซาเซีย|สิว/);
  assert.match(treeText(container), /จึงไม่เลือกกลุ่มขึ้นมาแทน/);
});

test('forged educational comparisons cannot open an owner-facing result screen', async () => {
  const f = await fixture();
  const comparison = { contract: 'research-ranking-v1', method: 'classifier_score_order',
    status: 'educational_only', clinicallyValidated: false, classCount: 20,
    modelVersion: f.analysis.modelVersion, classIds: ['rosacea', 'acne_vulgaris'] };
  const analysis = { ...f.analysis, ok: false, code: 'UNCERTAIN_CLASSIFICATION', diagnostics: undefined,
    classificationStatus: 'abstained', comparison };
  for (const changes of [{ code: 'NON_SKIN_IMAGE' }, { classificationStatus: 'classified' },
    { comparison: { ...comparison, clinicallyValidated: true } },
    { comparison: { ...comparison, classIds: ['untrained', 'acne_vulgaris'] } },
    { comparison: { ...comparison, classIds: ['rosacea', 'rosacea'] } }]) {
    assert.throws(() => f.renderAnalysisScreen(documentFixture(), { analysis: { ...analysis, ...changes },
      storedImage: false, temporaryUploadDeleted: true }));
  }
});

test('uncertain completion has no candidate names and explicitly confirms no classified history', async () => {
  const f = await fixture(); const doc = documentFixture();
  const analysis = { ...f.analysis, ok: false, code: 'UNCERTAIN_CLASSIFICATION', diagnostics: undefined };
  const view = f.renderAnalysisScreen(doc, { analysis, storedImage: false, temporaryUploadDeleted: true });
  assert.equal(view.candidates.length, 0);
  assert.match(doc.getElementById('dashboardAnalysisStatus').textContent, /ยังไม่สามารถสรุป/);
  assert.match(doc.getElementById('dashboardAnalysisPrivacy').textContent, /ลบภาพชั่วคราวแล้ว/);
  assert.match(doc.getElementById('dashboardAnalysisPrivacy').textContent, /ไม่บันทึกเป็นผลจำแนกสำเร็จ/);
});

test('quality-only, incomplete, forged public approval and invalid content cannot open the result screen', async () => {
  const f = await fixture();
  for (const completed of [ {}, { ...f.completed, scan: null }, { ...f.completed, storedImage: false },
    { ...f.completed, analysis: { ...f.analysis, publicDeployment: true } },
    { analysis: { ...f.analysis, ok: false, code: 'NON_SKIN_IMAGE', diagnostics: undefined }, storedImage: false, temporaryUploadDeleted: true },
    { analysis: { ...f.analysis, ok: false, code: 'UNCERTAIN_CLASSIFICATION', diagnostics: undefined }, storedImage: false, temporaryUploadDeleted: false } ]) {
    const doc = documentFixture();
    assert.throws(() => f.renderAnalysisScreen(doc, completed));
    assert.equal(doc.getElementById('dashboardAnalysisView').classList.contains('hidden'), true);
  }
});

test('external preview URLs are not loaded and presentation never persists health data in browser storage', async () => {
  const f = await fixture(); const doc = documentFixture();
  f.renderAnalysisScreen(doc, f.completed, { previewUrl: 'https://untrusted.example/photo.jpg' });
  assert.equal(doc.getElementById('dashboardAnalysisImage').src, undefined);
  const source = readFileSync(require.resolve('../vercel-public/research-result.js'), 'utf8');
  assert.doesNotMatch(source, /(?:localStorage|sessionStorage)\.(?:setItem|getItem)/);
  assert.doesNotMatch(source, /innerHTML\s*=/);
});

test('landing helper describes approved consented research access, not an obsolete no-upload claim', () => {
  const source = readFileSync(require.resolve('../vercel-public/app.js'), 'utf8');
  assert.match(source, /ขอบเขตรุ่นใหม่เป็นรอยโรค 6 กลุ่มจาก PAD-UFES-20/);
  assert.match(source, /ทดลองได้เมื่อบริการพร้อมและยินยอมส่งภาพ/);
  assert.match(source, /ผลอาจผิดพลาดและไม่ใช่การวินิจฉัย/);
  assert.doesNotMatch(source, /ตอนนี้ระบบเปิดข้อมูลสาธารณะและบัญชีทดลอง โดยยังไม่รับภาพเพื่อวิเคราะห์ครับ/);
});

test('admin monitoring is authenticated and MFA-protected, shares the actual engine and exposes no private scan data', async () => {
  const { default: handler } = await import('../vercel-public/api/admin-handler.js');
  const res = { headers: {}, setHeader(key, value) { this.headers[key] = value; },
    status(value) { this.statusCode = value; return this; }, json(value) { this.body = value; return this; } };
  await handler({ method: 'GET', query: { path: 'model/readiness' }, headers: {} }, res);
  assert.equal(res.statusCode, 401);
  assert.equal(res.headers['Cache-Control'], 'no-store');
  const source = readFileSync(require.resolve('../vercel-public/api/admin-handler.js'), 'utf8');
  const endpoint = source.match(/async function getAdminModelReadiness[\s\S]*?\n\}/)[0];
  assert.match(endpoint, /signedInAdmin/);
  assert.match(endpoint, /mfaVerified !== true/);
  assert.match(endpoint, /researchReadiness\(\)/);
  assert.doesNotMatch(endpoint, /selectPrivateRows|createPrivateDownloadUrl|INFERENCE_API_KEY/);
});

test('admin model endpoint denies user and unverified MFA before contacting the engine', async () => {
  const source = readFileSync(require.resolve('../vercel-public/api/admin-handler.js'), 'utf8')
    .replace(/^import[\s\S]*?from ['"][^'"]+['"];\r?\n/gm, '')
    .replace('export default async function handler', 'async function handler');
  let engineCalls = 0;
  const context = vm.createContext({
    requireGet: () => true, sessionClaims: () => ({ sub: 1, mfaVerified: false }),
    publicUserById: async () => ({ id: 1, role: 'admin', mfaEnrolled: true }),
    researchReadiness: async () => { engineCalls++; return { researchAvailable: true, classCount: 20,
      modelVersion: 'derm-local-e10f89ad2ac8', releaseStatus: 'research_only', publicReleaseApproved: false }; },
    json: (res, status, body) => { res.status = status; res.body = body; return res; },
  });
  vm.runInContext(`${source}\nglobalThis.modelRoute = getAdminModelReadiness;`, context);
  let res = await context.modelRoute({ method: 'GET' }, {});
  assert.equal(res.status, 403); assert.equal(res.body.code, 'mfa_required'); assert.equal(engineCalls, 0);
  context.sessionClaims = () => ({ sub: 1, mfaVerified: true });
  context.publicUserById = async () => ({ id: 1, role: 'admin', mfaEnrolled: false });
  res = await context.modelRoute({ method: 'GET' }, {});
  assert.equal(res.status, 403); assert.equal(engineCalls, 0);
  context.publicUserById = async () => ({ id: 1, role: 'user', mfaEnrolled: true });
  res = {}; await context.modelRoute({ method: 'GET' }, res);
  assert.equal(res.status, 403); assert.equal(engineCalls, 0);
  context.publicUserById = async () => ({ id: 1, role: 'admin', mfaEnrolled: true });
  res = await context.modelRoute({ method: 'GET' }, {});
  assert.equal(res.status, 200); assert.equal(engineCalls, 1);
  assert.equal(res.body.modelVersion, 'derm-local-e10f89ad2ac8');
  assert.equal(res.body.publicReleaseApproved, false);
  assert.ok(Number.isFinite(Date.parse(res.body.checkedAt)));
});
