const { test } = require('node:test');
const assert = require('node:assert/strict');

const settings = { url: 'https://inference.example.com', apiKey: 'a'.repeat(43),
  modelVersion: 'scin3-local-baab96df5bf5' };
const envelope = { ok: false, mode: 'authenticated_research', releaseStatus: 'research_only',
  publicDeployment: false, scopeValidated: false, unsupportedValidated: false,
  imageStored: false, imageForwarded: false };

test('image decoder faults are not mislabeled as unavailable infrastructure', async () => {
  const { createResearchInferenceClient } = await import('../vercel-public/lib/research-inference.js');
  for (const [status, code] of [[400, 'INVALID_IMAGE'], [400, 'INSUFFICIENT_DETAIL'],
    [400, 'IMAGE_DIMENSIONS'], [400, 'UNSUPPORTED_FORMAT'], [413, 'IMAGE_TOO_LARGE']]) {
    const client = createResearchInferenceClient({ ...settings, fetchImpl: async () =>
      new Response(JSON.stringify({ ...envelope, code, message: 'private-secret' }),
        { status, headers: { 'content-type': 'application/json' } }) });
    await assert.rejects(client.analyze(Buffer.from('fixture'), { consent: true }), error => {
      assert.equal(error.code, code); assert.equal(error.status, 422);
      assert.equal(error.message.includes('private-secret'), false);
      assert.equal(error.diagnostic.upstreamStatus, status);
      return true;
    });
  }
});

test('valid model execution failure is distinct from proxy and network failures', async () => {
  const { createResearchInferenceClient } = await import('../vercel-public/lib/research-inference.js');
  const client = createResearchInferenceClient({ ...settings, fetchImpl: async () =>
    new Response(JSON.stringify({ ...envelope, code: 'MODEL_ERROR', message: 'private-secret' }),
      { status: 503, headers: { 'content-type': 'application/json' } }) });
  await assert.rejects(client.analyze(Buffer.from('fixture'), { consent: true }),
    error => error.code === 'MODEL_ERROR' && error.status === 503 && !error.message.includes('private-secret'));
  for (const status of [408, 504]) {
    const timeout = createResearchInferenceClient({ ...settings, fetchImpl: async () =>
      new Response('private-secret', { status }) });
    await assert.rejects(timeout.analyze(Buffer.from('fixture'), { consent: true }), { code: 'MODEL_TIMEOUT' });
  }
  const timeout = createResearchInferenceClient({ ...settings, fetchImpl: async () => {
    const error = new TypeError('private-secret'); error.cause = { code: 'UND_ERR_CONNECT_TIMEOUT' }; throw error;
  } });
  await assert.rejects(timeout.analyze(Buffer.from('fixture'), { consent: true }), { code: 'MODEL_TIMEOUT' });
});

test('error mapping cannot bypass failed validation or make predictions available', async () => {
  const { createResearchInferenceClient } = await import('../vercel-public/lib/research-inference.js');
  for (const changes of [{ publicDeployment: true }, { imageStored: true },
    { diagnostics: [{ id: 'acne_vulgaris', score: 1 }] }, { code: 'attacker-controlled' }]) {
    const client = createResearchInferenceClient({ ...settings, fetchImpl: async () =>
      new Response(JSON.stringify({ ...envelope, code: 'INVALID_IMAGE', ...changes }),
        { status: 400, headers: { 'content-type': 'application/json' } }) });
    await assert.rejects(client.analyze(Buffer.from('fixture'), { consent: true }), { code: 'MODEL_UNAVAILABLE' });
  }
});

test('private workflow traces exactly the failed step without identifiers or content', async () => {
  const { analyzePrivateResearchScan, RESEARCH_CONSENT_VERSION } = await import('../vercel-public/lib/research-workflow.js');
  const pending = { id: '11111111-1111-4111-8111-111111111111',
    object_path: 'scans/2/11111111-1111-4111-8111-111111111111.jpg',
    research_consent_version: RESEARCH_CONSENT_VERSION, image_size_bytes: 7,
    original_name: 'private-secret.jpg', source: 'camera' };
  for (const failedStage of ['private_download', 'inference', 'history_save']) {
    const events = [];
    const fault = () => { throw new Error('private-secret'); };
    const options = {
      trace: event => events.push(event),
      download: failedStage === 'private_download' ? fault : async () => Buffer.from('private'),
      client: { analyze: failedStage === 'inference' ? fault : async () => ({ ok: true,
        modelVersion: settings.modelVersion,
        diagnostics: [{ id: 'acne_vulgaris', score: .9 }, { id: 'psoriasis', score: .08 }, { id: 'urticaria', score: .02 }] }) },
      save: failedStage === 'history_save' ? fault : async () => [{ id: pending.id }],
    };
    await assert.rejects(analyzePrivateResearchScan(pending, 2, 'expiry', options), /private-secret/);
    assert.equal(events.at(-1).stage, failedStage); assert.equal(events.at(-1).ok, false);
    for (const event of events) {
      assert.deepEqual(Object.keys(event), ['stage', 'ok', 'elapsedMs']);
      assert.ok(Number.isSafeInteger(event.elapsedMs) && event.elapsedMs >= 0);
    }
    assert.equal(JSON.stringify(events).includes('private-secret'), false);
    assert.equal(JSON.stringify(events).includes(pending.id), false);
  }
});

test('scan function stays bounded in one nearby region without changing its security headers', () => {
  const { readFileSync } = require('node:fs');
  const config = JSON.parse(readFileSync(require.resolve('../vercel-public/vercel.json'), 'utf8'));
  assert.deepEqual(config.regions, ['sin1']);
  assert.equal(config.functions['api/admin-handler.js'].maxDuration, 300);
  const headers = config.headers[0].headers;
  assert.ok(headers.some(row => row.key === 'X-Frame-Options' && row.value === 'DENY'));
  assert.ok(headers.some(row => row.key === 'Content-Security-Policy' && row.value.includes("connect-src 'self'")));
});

test('failed stage logger cannot break accepted result persistence', async () => {
  const { analyzePrivateResearchScan, RESEARCH_CONSENT_VERSION } = await import('../vercel-public/lib/research-workflow.js');
  const pending = { id: '11111111-1111-4111-8111-111111111111',
    object_path: 'scans/2/11111111-1111-4111-8111-111111111111.jpg',
    research_consent_version: RESEARCH_CONSENT_VERSION, image_size_bytes: 7, source: 'camera' };
  const result = await analyzePrivateResearchScan(pending, 2, 'expiry', {
    trace: () => { throw new Error('logging failed'); }, download: async () => Buffer.from('fixture'),
    client: { analyze: async () => ({ ok: true, modelVersion: settings.modelVersion,
      diagnostics: [{ id: 'acne_vulgaris', score: .9 }, { id: 'psoriasis', score: .08 }, { id: 'urticaria', score: .02 }] }) },
    save: async () => [{ id: pending.id }],
  });
  assert.equal(result.storedImage, true);
});
