const { test } = require('node:test');
const assert = require('node:assert/strict');
const key = 'a'.repeat(43);
const version = 'derm-local-e10f89ad2ac8';
const settings = { url: 'https://inference.example.com/', apiKey: key, modelVersion: version };

async function fixtures() {
  const { createResearchInferenceClient, researchInferenceFromEnvironment } = await import('../vercel-public/lib/research-inference.js');
  const { SCAN_CLASSES } = await import('../vercel-public/scan-result.js');
  const base = { ok: true, mode: 'authenticated_research', releaseStatus: 'research_only',
    publicDeployment: false, scopeValidated: false, unsupportedValidated: false,
    imageStored: false, imageForwarded: false, modelVersion: version };
  const ready = { ...base, modelLoaded: true, classCount: 20, classIds: SCAN_CLASSES.map(row => row.id),
    objectFilterAvailable: true, objectFilterStatus: 'experimental', uncertaintyAbstentionAvailable: true };
  const result = { ...base, code: 'RESEARCH_ONLY', analysisStatus: 'completed', classificationStatus: 'experimental',
    input: { format: 'PNG', metadataStripped: true, width: 128, height: 96 }, seconds: 5.4,
    inputCheck: { validated: false, status: 'experimental_continue', version: 'object-filter-d14f30ce7eb4', score: .8, threshold: .46 },
    diagnostics: SCAN_CLASSES.map((row, index) => ({ id: row.id, name: 'untrusted server name', score: index ? .01 : .81 })) };
  const respond = (value, status = 200) => new Response(JSON.stringify(value), {
    status, headers: { 'content-type': 'application/json' } });
  return { createResearchInferenceClient, researchInferenceFromEnvironment, ready, result, respond };
}

test('only configured HTTPS endpoints, strong keys and pinned versions are accepted', async () => {
  const { createResearchInferenceClient, researchInferenceFromEnvironment } = await fixtures();
  for (const url of ('http://inference.example.com,https://127.0.0.1,https://user:password@inference.example.com,https://inference.example.com/path,https://inference.example.com?token=x,https://inference.example.com:8080').split(',')) {
    assert.throws(() => createResearchInferenceClient({ ...settings, url }));
  }
  assert.throws(() => createResearchInferenceClient({ ...settings, apiKey: 'short' }));
  assert.throws(() => createResearchInferenceClient({ ...settings, modelVersion: 'other' }));
  assert.throws(() => researchInferenceFromEnvironment({}));
});

test('readiness requires the backend-call contract and never approves a public release', async () => {
  const { createResearchInferenceClient, ready, respond } = await fixtures();
  let request;
  const client = createResearchInferenceClient({ ...settings, fetchImpl: async (url, options) => {
    request = { url: String(url), options }; return respond(ready);
  } });
  const status = await client.readiness();
  assert.equal(request.url, settings.url + 'v1/readiness');
  assert.equal(request.options.headers.Authorization, 'Bearer ' + key);
  assert.equal(request.options.redirect, 'manual');
  assert.equal(status.classCount, 20);
  assert.equal(status.publicDeployment, false);
  assert.equal(status.scopeValidated, false);
  assert.equal(status.unsupportedValidated, false);
});

test('malformed readiness or different versions cannot enable the service', async () => {
  const { createResearchInferenceClient, ready, respond } = await fixtures();
  for (const changes of [{ modelVersion: 'derm-local-000000000000' }, { publicDeployment: true },
    { scopeValidated: true }, { unsupportedValidated: true }, { classIds: [...ready.classIds].reverse() },
    { objectFilterAvailable: false }, { uncertaintyAbstentionAvailable: false }]) {
    const client = createResearchInferenceClient({ ...settings, fetchImpl: async () => respond({ ...ready, ...changes }) });
    await assert.rejects(client.readiness(), { code: 'INVALID_MODEL_RESULT' });
  }
});

test('educational comparison readiness is advertised only by the matching runtime contract', async () => {
  const { createResearchInferenceClient, ready, respond } = await fixtures();
  for (const [contract, expected] of [[undefined, false], ['research-ranking-v1', true], ['other', false]]) {
    const client = createResearchInferenceClient({ ...settings,
      fetchImpl: async () => respond({ ...ready, comparisonContract: contract }) });
    const status = await client.readiness();
    assert.equal(status.comparisonAvailable, expected); assert.equal(status.publicDeployment, false);
  }
});

test('image calls require explicit consent and bounded binary data before any request', async () => {
  const { createResearchInferenceClient } = await fixtures();
  let requests = 0;
  const client = createResearchInferenceClient({ ...settings, fetchImpl: async () => { requests++; } });
  for (const [data, options] of [[Buffer.from('x'), {}], ['https://private-photo', { consent: true }],
    [Buffer.alloc(0), { consent: true }], [Buffer.alloc(8 * 1024 * 1024 + 1), { consent: true }]]) {
    await assert.rejects(client.analyze(data, options));
  }
  assert.equal(requests, 0);
});

test('accepted results preserve exactly 20 ordered raw scores without remote names', async () => {
  const { createResearchInferenceClient, result, respond } = await fixtures();
  let request;
  const photo = Buffer.from('fixture bytes, API transport test only');
  const client = createResearchInferenceClient({ ...settings, fetchImpl: async (url, options) => {
    request = { url: String(url), options }; return respond(result);
  } });
  const response = await client.analyze(photo, { consent: true });
  assert.equal(request.url, settings.url + 'v1/analyze');
  assert.equal(request.options.body, photo);
  assert.equal(request.options.headers['X-Image-Consent'], 'yes');
  assert.equal(response.diagnostics.length, 20);
  assert.equal(response.publicDeployment, false);
  assert.equal(response.diagnostics[0].name, undefined);
});

test('invalid class order, score mass, score types or input contract fail closed', async () => {
  const { createResearchInferenceClient, result, respond } = await fixtures();
  for (const changes of [{ diagnostics: result.diagnostics.slice(1) },
    { diagnostics: [...result.diagnostics].reverse() },
    { diagnostics: result.diagnostics.map(row => ({ ...row, score: 1 })) },
    { diagnostics: result.diagnostics.map(row => ({ ...row, score: String(row.score) })) },
    { input: { ...result.input, metadataStripped: false } }, { seconds: -1 },
    { inputCheck: { ...result.inputCheck, validated: true } }]) {
    const client = createResearchInferenceClient({ ...settings, fetchImpl: async () => respond({ ...result, ...changes }) });
    await assert.rejects(client.analyze(Buffer.from('x'), { consent: true }), { code: 'INVALID_MODEL_RESULT' });
  }
});

test('object rejection and uncertainty carry no group names or server-injected text', async () => {
  const { createResearchInferenceClient, result, respond } = await fixtures();
  for (const object of [true, false]) {
    const rejected = { ...result, ok: false, message: 'untrusted private data',
      code: object ? 'NON_SKIN_IMAGE' : 'UNCERTAIN_CLASSIFICATION',
      analysisStatus: object ? 'input_rejected' : 'completed',
      classificationStatus: object ? 'not_run' : 'abstained',
      inputCheck: { ...result.inputCheck, status: object ? 'experimental_reject' : 'experimental_continue' } };
    delete rejected.diagnostics;
    const client = createResearchInferenceClient({ ...settings, fetchImpl: async () => respond(rejected, 422) });
    const response = await client.analyze(Buffer.from('x'), { consent: true });
    assert.equal(response.diagnostics, undefined);
    assert.notEqual(response.message, rejected.message);
    assert.equal(response.publicDeployment, false);
  }
});

test('rejected response with group names cannot leak predictions', async () => {
  const { createResearchInferenceClient, result, respond } = await fixtures();
  const client = createResearchInferenceClient({ ...settings, fetchImpl: async () => respond({ ...result,
    ok: false, code: 'UNCERTAIN_CLASSIFICATION', classificationStatus: 'abstained' }, 422) });
  await assert.rejects(client.analyze(Buffer.from('x'), { consent: true }), { code: 'INVALID_MODEL_RESULT' });
});

test('opt-in educational comparison preserves abstention, only curated IDs and no scores', async () => {
  const { createResearchInferenceClient, result, respond } = await fixtures();
  const comparison = { contract: 'research-ranking-v1', method: 'classifier_score_order',
    status: 'educational_only', clinicallyValidated: false, classCount: 20,
    modelVersion: version, classIds: ['rosacea', 'acne_vulgaris'],
    name: '<script>remote name</script>', scores: [0.5, 0.3], url: 'https://untrusted.example/' };
  const uncertain = { ...result, ok: false, code: 'UNCERTAIN_CLASSIFICATION', diagnostics: undefined,
    classificationStatus: 'abstained', comparison };
  let options;
  const client = createResearchInferenceClient({ ...settings, fetchImpl: async (_url, opts) => {
    options = opts; return respond(uncertain, 422);
  } });
  const response = await client.analyze(Buffer.from('fixture'), { consent: true });
  assert.equal(options.headers['X-Research-Comparison'], 'research-ranking-v1');
  assert.equal(response.ok, false); assert.equal(response.code, 'UNCERTAIN_CLASSIFICATION');
  assert.equal(response.classificationStatus, 'abstained');
  assert.deepEqual(response.comparison.classIds, comparison.classIds);
  assert.equal(response.diagnostics, undefined);
  for (const key of ['name', 'scores', 'url']) assert.equal(response.comparison[key], undefined);
  assert.equal(response.publicDeployment, false);
});

test('comparison cannot disguise objects, accepted classifications, unknown IDs or mismatched models', async () => {
  const { createResearchInferenceClient, result, respond } = await fixtures();
  const comparison = { contract: 'research-ranking-v1', method: 'classifier_score_order',
    status: 'educational_only', clinicallyValidated: false, classCount: 20,
    modelVersion: version, classIds: ['rosacea', 'acne_vulgaris'] };
  const uncertain = { ...result, ok: false, code: 'UNCERTAIN_CLASSIFICATION', diagnostics: undefined,
    classificationStatus: 'abstained', comparison };
  for (const changes of [{ classIds: ['unknown', 'acne_vulgaris'] }, { classIds: ['rosacea', 'rosacea'] },
    { classIds: ['rosacea'] }, { classIds: ['rosacea', 'acne_vulgaris', 'psoriasis'] },
    { clinicallyValidated: true }, { status: 'classified' }, { method: 'visual_similarity' },
    { modelVersion: 'derm-local-000000000000' }, { classCount: 21 }, { contract: 'other' }]) {
    const client = createResearchInferenceClient({ ...settings, fetchImpl: async () => respond({ ...uncertain,
      comparison: { ...comparison, ...changes } }, 422) });
    await assert.rejects(client.analyze(Buffer.from('x'), { consent: true }), { code: 'INVALID_MODEL_RESULT' });
  }
  for (const [body, status] of [[{ ...result, comparison }, 200], [{ ...uncertain, code: 'NON_SKIN_IMAGE',
    analysisStatus: 'input_rejected', classificationStatus: 'not_run',
    inputCheck: { ...result.inputCheck, status: 'experimental_reject' } }, 422]]) {
    const client = createResearchInferenceClient({ ...settings, fetchImpl: async () => respond(body, status) });
    await assert.rejects(client.analyze(Buffer.from('x'), { consent: true }), { code: 'INVALID_MODEL_RESULT' });
  }
});

test('redirects, credential errors and network exceptions never forward or reflect secrets', async () => {
  const { createResearchInferenceClient } = await fixtures();
  for (const status of [301, 302, 401, 403, 500]) {
    const client = createResearchInferenceClient({ ...settings, fetchImpl: async () => new Response('private-secret',
      { status, headers: { location: 'https://attacker.example/' } }) });
    await assert.rejects(client.readiness(), error => !error.message.includes('private-secret') && !error.message.includes(key));
  }
  const client = createResearchInferenceClient({ ...settings, fetchImpl: async () => { throw new Error(key); } });
  await assert.rejects(client.readiness(), error => !error.message.includes(key));
});

test('busy and rate limit statuses are sanitized and preserved', async () => {
  const { createResearchInferenceClient } = await fixtures();
  for (const [status, code] of [[409, 'MODEL_BUSY'], [429, 'RATE_LIMITED']]) {
    const client = createResearchInferenceClient({ ...settings, fetchImpl: async () => new Response('private-secret', { status }) });
    await assert.rejects(client.readiness(), { code, status });
  }
});

test('HTML and oversized streamed JSON responses are rejected', async () => {
  const { createResearchInferenceClient } = await fixtures();
  for (const response of [new Response('html'), new Response(JSON.stringify({ padding: 'x'.repeat(256 * 1024) }),
    { headers: { 'content-type': 'application/json' } })]) {
    const client = createResearchInferenceClient({ ...settings, fetchImpl: async () => response });
    await assert.rejects(client.readiness(), { code: 'INVALID_MODEL_RESULT' });
  }
});

test('production readiness remains unavailable despite adding the research transport', async () => {
  const { scanReadiness } = await import('../vercel-public/lib/scan-readiness.js');
  assert.equal(scanReadiness().classificationAvailable, false);
  assert.equal(scanReadiness().scopeFilterAvailable, false);
});
