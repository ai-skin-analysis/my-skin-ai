const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');

async function setup() {
  const { PAD6_CLASSES } = await import('../vercel-public/research-catalog.js');
  const { createResearchInferenceClient } = await import('../vercel-public/lib/research-inference.js');
  const { researchResultView } = await import('../vercel-public/research-result.js');
  const { validatedResearchComparison } = await import('../vercel-public/research-comparison.js');
  const settings = { url: 'https://model.example.com/', apiKey: 't'.repeat(43), modelVersion: 'pad6-local-aaaaaaaaaaaa' };
  const common = { mode: 'authenticated_research', releaseStatus: 'research_only', publicDeployment: false,
    scopeValidated: false, unsupportedValidated: false, imageStored: false, imageForwarded: false,
    modelVersion: settings.modelVersion };
  const ready = { ...common, ok: true, modelLoaded: true, classCount: 6,
    classIds: PAD6_CLASSES.map(row => row.id), objectFilterAvailable: true, objectFilterStatus: 'experimental',
    uncertaintyAbstentionAvailable: true };
  const result = { ...common, ok: true, code: 'RESEARCH_ONLY', analysisStatus: 'completed', classificationStatus: 'experimental',
    input: { format: 'PNG', width: 200, height: 200, metadataStripped: true }, seconds: 1,
    inputCheck: { status: 'experimental_continue', validated: false, version: 'object-filter-aaaaaaaaaaaa', score: .8, threshold: .5 },
    diagnostics: PAD6_CLASSES.map((row, i) => ({ id: row.id, score: i ? .02 : .9, name: 'untrusted remote diagnosis' })) };
  const respond = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
  return { PAD6_CLASSES, createResearchInferenceClient, researchResultView, validatedResearchComparison, settings, ready, result, respond };
}

test('six-class client accepts only the exact six ordered IDs and the pinned new version', async () => {
  const f = await setup();
  const client = f.createResearchInferenceClient({ ...f.settings, fetchImpl: async () => f.respond(f.ready) });
  assert.equal((await client.readiness()).classCount, 6);
  for (const changes of [{ classCount: 20 }, { classIds: f.ready.classIds.slice(1) },
    { classIds: [...f.ready.classIds].reverse() }, { modelVersion: 'derm-local-aaaaaaaaaaaa' },
    { publicDeployment: true }, { scopeValidated: true }]) {
    const wrong = f.createResearchInferenceClient({ ...f.settings, fetchImpl: async () => f.respond({ ...f.ready, ...changes }) });
    await assert.rejects(wrong.readiness(), { code: 'INVALID_MODEL_RESULT' });
  }
});

test('six raw scores render six-label curated names, never server names or old acne labels', async () => {
  const f = await setup();
  const client = f.createResearchInferenceClient({ ...f.settings, fetchImpl: async () => f.respond(f.result) });
  const result = await client.analyze(Buffer.from('synthetic transport fixture, not a photo'), { consent: true });
  assert.equal(result.diagnostics.length, 6);
  assert.equal(result.publicDeployment, false);
  assert.equal(f.researchResultView(result).candidates[0].id, 'actinic_keratosis');
  assert.equal(JSON.stringify(result).includes('untrusted remote'), false);
  for (const diagnostics of [f.result.diagnostics.concat(f.result.diagnostics),
    f.result.diagnostics.map((row, i) => i ? row : { ...row, id: 'acne_vulgaris' })]) {
    const wrong = f.createResearchInferenceClient({ ...f.settings, fetchImpl: async () => f.respond({ ...f.result, diagnostics }) });
    await assert.rejects(wrong.analyze(Buffer.from('fixture'), { consent: true }), { code: 'INVALID_MODEL_RESULT' });
    assert.equal(f.researchResultView({ ...f.result, diagnostics }).candidates.length, 0);
  }
});

test('six-label uncertainty comparison never becomes a diagnosis or an old twenty-label comparison', async () => {
  const f = await setup();
  const comparison = { contract: 'research-ranking-v1', method: 'classifier_score_order', status: 'educational_only',
    clinicallyValidated: false, modelVersion: f.settings.modelVersion, classCount: 6,
    classIds: f.ready.classIds.slice(0, 2) };
  const result = { ...f.result, ok: false, code: 'UNCERTAIN_CLASSIFICATION', classificationStatus: 'abstained', diagnostics: undefined, comparison };
  const view = f.researchResultView(result);
  assert.equal(view.candidates.length, 0);
  assert.equal(view.comparisonCandidates.length, 2);
  for (const changes of [{ classCount: 20 }, { classIds: ['acne_vulgaris', 'rosacea'] },
    { modelVersion: 'derm-local-aaaaaaaaaaaa' }, { clinicallyValidated: true }]) {
    assert.equal(f.validatedResearchComparison({ ...comparison, ...changes }, f.settings.modelVersion), null);
  }
});

test('Thai public catalog and training catalog agree exactly, with sources and explicit limitations', async () => {
  const f = await setup();
  const original = JSON.parse(readFileSync(require.resolve('../pad6_catalog.json'), 'utf8'));
  assert.deepEqual(f.PAD6_CLASSES.map(row => row.id), original.classes.map(row => row.id));
  assert.equal(f.PAD6_CLASSES.length, 6);
  for (const row of f.PAD6_CLASSES) {
    assert.ok(row.description.length > 25);
    assert.ok(row.context.length > 25);
    assert.match(row.source, /^https:\/\/(www\.nhs\.uk|www\.aad\.org)\//);
    assert.match(row.recommendation, /ไม่ยืนยันหรือคัดโรคมะเร็งออก/);
  }
});
