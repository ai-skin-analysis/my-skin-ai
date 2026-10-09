const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { inflateSync } = require('node:zlib');

test('probe uses only a fixed valid generated PNG, never storage or history', async () => {
  const { researchTransportCheck } = await import('../vercel-public/lib/research-transport-check.js');
  let calls = 0;
  const result = await researchTransportCheck({
    readiness: async () => ({ modelVersion: 'scin3-local-baab96df5bf5', classCount: 3 }),
    analyze: async (bytes, options) => {
      calls++;
      assert.equal(bytes.length, 792 + 1024 * 1024 + 12);
      assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
      assert.deepEqual(options, { consent: true });
      assert.equal(bytes.readUInt32BE(16), 224);
      assert.equal(bytes.readUInt32BE(20), 224);
      const dataLength = bytes.readUInt32BE(33);
      assert.equal(bytes.toString('ascii', 37, 41), 'IDAT');
      assert.equal(inflateSync(bytes.subarray(41, 41 + dataLength)).length, 224 * (224 * 3 + 1));
      assert.equal(bytes.toString('ascii', bytes.length - 8, bytes.length - 4), 'IEND');
      return { ok: false, code: 'NON_SKIN_IMAGE' };
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.userImageSent, false);
  assert.equal(result.generatedProbeOnly, true);
  assert.equal(result.publicReleaseApproved, false);
  const source = readFileSync(require.resolve('../vercel-public/lib/research-transport-check.js'), 'utf8');
  assert.doesNotMatch(source, /supabase|downloadPrivate|upsert|readFile/);
});

test('probe cannot report success when readiness or inference fails', async () => {
  const { researchTransportCheck } = await import('../vercel-public/lib/research-transport-check.js');
  await assert.rejects(researchTransportCheck({ readiness: async () => { throw Error('not ready'); } }));
  await assert.rejects(researchTransportCheck({ readiness: async () => ({}),
    analyze: async () => { throw Error('transport failed'); } }));
});

test('route preserves approved-user, same-origin and shared rate-budget guards', () => {
  const handler = readFileSync(require.resolve('../vercel-public/api/admin-handler.js'), 'utf8');
  const guard = handler.slice(handler.indexOf('async function checkResearchTransport'),
    handler.indexOf('async function getAdminModelReadiness'));
  assert.match(guard, /requirePost\(req, res\).*requireSameOrigin\(req, res\)/);
  assert.match(guard, /signedInApprovedUser/);
  assert.match(guard, /takeRateBudget\(req, 'user_scan'\)/);
});

test('inference error diagnostics allow no URL, key, payload, or raw exception text', async () => {
  const { createResearchInferenceClient } = await import('../vercel-public/lib/research-inference.js');
  const settings = { url: 'https://model.example.com/', apiKey: 't'.repeat(43),
    modelVersion: 'scin3-local-baab96df5bf5' };
  const client = createResearchInferenceClient({ ...settings, fetchImpl: async () => {
    throw Object.assign(new Error('SECRET KEY AND PRIVATE PATH'), { cause: { code: 'ECONNRESET', message: 'PRIVATE IMAGE' } });
  } });
  await assert.rejects(client.readiness(), error => {
    assert.deepEqual(error.diagnostic, { operation: 'readiness', stage: 'upstream_transport', transportCode: 'ECONNRESET' });
    assert.doesNotMatch(JSON.stringify(error), /SECRET|PRIVATE|example|ttttt/);
    return error.code === 'MODEL_UNAVAILABLE';
  });
  const upstream = createResearchInferenceClient({ ...settings, fetchImpl: async () => new Response('PRIVATE TRACE', { status: 502 }) });
  await assert.rejects(upstream.readiness(), error => {
    assert.deepEqual(error.diagnostic, { operation: 'readiness', stage: 'upstream_http', upstreamStatus: 502 });
    assert.doesNotMatch(JSON.stringify(error), /PRIVATE|TRACE/);
    return error.code === 'MODEL_UNAVAILABLE';
  });
});
