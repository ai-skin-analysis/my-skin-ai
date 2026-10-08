const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');

async function fixture() {
  const workflow = await import('../vercel-public/lib/research-workflow.js');
  const view = await import('../vercel-public/research-result.js');
  const { SCAN_CLASSES } = await import('../vercel-public/scan-result.js');
  const pending = { id: '11111111-1111-4111-8111-111111111111', object_path: 'scans/2/11111111-1111-4111-8111-111111111111.jpg',
    research_consent_version: workflow.RESEARCH_CONSENT_VERSION, image_size_bytes: 5, source: 'camera', original_name: 'prepared.jpg' };
  const analysis = { ok: true, code: 'RESEARCH_ONLY', releaseStatus: 'research_only', classificationStatus: 'experimental',
    publicDeployment: false, scopeValidated: false, unsupportedValidated: false, modelVersion: 'derm-local-e10f89ad2ac8',
    diagnostics: SCAN_CLASSES.map((row, index) => ({ id: row.id, score: index ? 0.1 / 19 : 0.9 })) };
  return { ...workflow, ...view, pending, analysis };
}

test('research readiness is actual authenticated runtime readiness and not public approval', async () => {
  const f = await fixture();
  let called = false;
  const result = await f.researchReadiness({ readiness: async () => { called = true; return { modelLoaded: true, classCount: 20, modelVersion: f.analysis.modelVersion }; } });
  assert.equal(called, true); assert.equal(result.researchAvailable, true);
  for (const name of ['classificationAvailable', 'scopeFilterAvailable', 'publicReleaseApproved', 'scopeValidated', 'unsupportedValidated']) assert.equal(result[name], false);
  await assert.rejects(f.researchReadiness({ readiness: async () => { throw new Error('offline'); } }));
});

test('an owned consented upload is analyzed before an idempotent research-only save', async () => {
  const f = await fixture(); const calls = [];
  const result = await f.analyzePrivateResearchScan(f.pending, 2, 'expiry', {
    download: async (path, size) => { calls.push('download'); assert.equal(path, f.pending.object_path); assert.equal(size, 5); return Buffer.from('image'); },
    client: { analyze: async (bytes, options) => { calls.push('analyze'); assert.equal(bytes.toString(), 'image'); assert.equal(options.consent, true); return f.analysis; } },
    save: async (table, row, conflict) => { calls.push('save'); assert.equal(row.id, f.pending.id); assert.equal(row.decision_status, 'research_only');
      assert.equal(row.confidence, null); assert.equal(row.is_uncertain, true); assert.equal(conflict, 'id');
      assert.deepEqual(Object.keys(row.top_predictions[0]), ['id']); return [{ id: row.id, created_at: 'now' }]; },
    remove: async () => { throw new Error('accepted image unexpectedly deleted'); },
  });
  assert.deepEqual(calls, ['download', 'analyze', 'save']); assert.equal(result.storedImage, true);
  assert.equal(result.analysis.code, 'RESEARCH_ONLY'); assert.match(result.scan.resultLabel, /เชิงทดลอง/);
});

test('other accounts or missing research consent cannot download or infer', async () => {
  const f = await fixture();
  const options = { client: {}, download: async () => { throw new Error('should never download'); } };
  await assert.rejects(f.analyzePrivateResearchScan(f.pending, 3, 'expiry', options), /ownership/);
  await assert.rejects(f.analyzePrivateResearchScan({ ...f.pending, research_consent_version: null }, 2, 'expiry', options), /consent/);
});

test('objects and uncertain lesions are removed and never stored as classification history', async () => {
  const f = await fixture();
  for (const code of ['NON_SKIN_IMAGE', 'UNCERTAIN_CLASSIFICATION']) {
    let removed = false;
    const result = await f.analyzePrivateResearchScan(f.pending, 2, 'expiry', {
      download: async () => Buffer.from('image'),
      client: { analyze: async () => ({ ...f.analysis, ok: false, code, diagnostics: undefined }) },
      remove: async paths => { assert.deepEqual(paths, [f.pending.object_path]); removed = true; },
      save: async () => { throw new Error('must not save'); },
    });
    assert.equal(removed, true); assert.equal(result.temporaryUploadDeleted, true); assert.equal(result.storedImage, false);
    assert.equal(f.researchResultView(result.analysis).candidates.length, 0);
  }
});

test('download, inference or save outages cannot become success records', async () => {
  const f = await fixture();
  for (const failAt of ['download', 'analyze', 'save']) {
    const fail = () => { throw new Error('failed'); };
    await assert.rejects(f.analyzePrivateResearchScan(f.pending, 2, 'expiry', {
      download: failAt === 'download' ? fail : async () => Buffer.from('image'),
      client: { analyze: failAt === 'analyze' ? fail : async () => f.analysis },
      save: failAt === 'save' ? fail : async () => [{ id: f.pending.id }],
    }), /failed/);
  }
});

test('educational comparison on abstention is returned only after deletion and never saved as classification', async () => {
  const f = await fixture(); let removed = false;
  const comparison = { contract: 'research-ranking-v1', method: 'classifier_score_order',
    status: 'educational_only', clinicallyValidated: false, classCount: 20,
    modelVersion: f.analysis.modelVersion, classIds: ['rosacea', 'acne_vulgaris'] };
  const analysis = { ...f.analysis, ok: false, code: 'UNCERTAIN_CLASSIFICATION', diagnostics: undefined,
    classificationStatus: 'abstained', comparison };
  const options = { download: async () => Buffer.from('fixture'), client: { analyze: async () => analysis },
    remove: async () => { removed = true; }, save: async () => { throw new Error('must not save comparison'); } };
  const result = await f.analyzePrivateResearchScan(f.pending, 2, 'expiry', options);
  assert.equal(removed, true); assert.equal(result.storedImage, false);
  assert.equal(result.temporaryUploadDeleted, true); assert.equal(result.scan, undefined);
  const view = f.researchResultView(result.analysis);
  assert.equal(view.candidates.length, 0);
  assert.deepEqual(view.comparisonCandidates.map(row => row.id), comparison.classIds);
  await assert.rejects(f.analyzePrivateResearchScan(f.pending, 2, 'expiry', { ...options,
    remove: async () => { throw new Error('deletion failed'); } }), /deletion failed/);
});

test('research views use curated names, no calibrated probabilities or validated comparisons', async () => {
  const f = await fixture();
  f.analysis.diagnostics[0].name = '<script>secret</script>';
  const result = f.researchResultView(f.analysis);
  assert.equal(result.code, 'RESEARCH_ONLY'); assert.equal(result.candidates[0].name, 'สิว');
  assert.equal(result.candidates.length, 2); assert.equal(JSON.stringify(result).includes('secret'), false);
  assert.match(result.message, /ไม่ใช่/);
  assert.equal(f.researchResultView({ ...f.analysis, scopeValidated: true }).code, 'INVALID_MODEL_RESULT');
  assert.equal(f.researchResultView({ ...f.analysis, diagnostics: f.analysis.diagnostics.slice(1) }).candidates.length, 0);
  assert.equal(f.researchResultView({ ok: true, code: 'CLASSIFIED' }).candidates.length, 0);
});

test('all research routes retain session, approval, same-origin and atomic account ownership checks', () => {
  const source = readFileSync(require.resolve('../vercel-public/api/admin-handler.js'), 'utf8');
  assert.match(source, /async function getResearchReadiness[\s\S]*?signedInApprovedUser/);
  assert.match(source, /async function startScanUpload[\s\S]*?requireSameOrigin[\s\S]*?signedInApprovedUser/);
  assert.match(source, /async function completeResearchUpload[\s\S]*?requireSameOrigin[\s\S]*?signedInApprovedUser[\s\S]*?takeRateBudget/);
  assert.match(source, /UPDATE smart_skin_pending_scan_uploads SET analysis_started_at = NOW\(\)[\s\S]*?user_id = \$\{account.user.id\}[\s\S]*?analysis_started_at IS NULL[\s\S]*?research_consent_version/);
  const front = readFileSync(require.resolve('../vercel-public/dashboard.js'), 'utf8');
  assert.equal(front.includes('SMART_SKIN_INFERENCE_API_KEY'), false);
  assert.match(front, /researchAvailable !== true/);
});

test('real route entry rejects unauthenticated and cross-origin research calls before infrastructure access', async () => {
  const { default: handler } = await import('../vercel-public/api/admin-handler.js');
  function response() {
    return { headers: {}, setHeader(key, value) { this.headers[key] = value; },
      status(value) { this.statusCode = value; return this; }, json(value) { this.body = value; return this; } };
  }
  for (const route of ['readiness', 'upload', 'complete']) {
    const res = response();
    await handler({ method: route === 'readiness' ? 'GET' : 'POST',
      query: { path: `user/scan/research/${route}` },
      headers: { host: 'smart-skin-ai.vercel.app', origin: 'https://smart-skin-ai.vercel.app' }, body: {} }, res);
    assert.equal(res.statusCode, 401); assert.equal(res.body.ok, false); assert.equal(res.headers['Cache-Control'], 'no-store');
  }
  const res = response();
  await handler({ method: 'POST', query: { path: 'user/scan/research/complete' },
    headers: { host: 'smart-skin-ai.vercel.app', origin: 'https://evil.example' }, body: {} }, res);
  assert.equal(res.statusCode, 403);
});
