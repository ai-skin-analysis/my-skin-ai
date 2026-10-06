const { test } = require('node:test');
const assert = require('node:assert/strict');
const modulePromise = import('../vercel-public/lib/scan-decision.js');
const presentationPromise = import('../vercel-public/scan-result.js');

// Invented thresholds are test fixtures ONLY, not release calibration.
function fixture(classes, first = .47, second = .43) {
  return { modelVersion: 'test-fixture-only', content: 'skin_lesion', support: 'supported',
    predictions: classes.map((item, index) => ({ id: item.id, score: index === 0 ? first : index === 1 ? second : (1 - first - second) / 18 })) };
}
const policy = () => ({ deploymentApproved: true, scopeValidated: true, unsupportedValidated: true, modelVersion: 'test-fixture-only',
  single: { minScore: .8, minMargin: .2, allowedClasses: ['acne_vulgaris'] },
  comparison: { validated: true, minCandidateScore: .3, minPairMass: .8, maxMargin: .1, allowedPairs: ['acne_vulgaris|rosacea'] } });

test('educational catalogue exactly matches all 20 model IDs in order, with cited explanations', async () => {
  const { SCAN_CLASSES } = await presentationPromise;
  assert.deepEqual(SCAN_CLASSES.map(item => item.id), [
    'acne_vulgaris', 'rosacea', 'eczema_unspecified', 'allergic_contact_dermatitis',
    'irritant_contact_dermatitis', 'psoriasis', 'urticaria', 'pityriasis_rosea',
    'granuloma_annulare', 'folliculitis', 'tinea_unspecified', 'tinea_versicolor',
    'impetigo', 'molluscum_contagiosum', 'herpes_simplex', 'herpes_zoster',
    'insect_bite', 'pigmented_purpuric_eruption', 'keratosis_pilaris', 'lichen_simplex_chronicus',
  ]);
  for (const item of SCAN_CLASSES) {
    assert.ok(item.description && item.context && item.name);
    assert.ok(['www.nhs.uk', 'www.aad.org', 'www.pcds.org.uk', 'bad.org.uk'].includes(new URL(item.source).hostname));
    assert.equal(new URL(item.source).protocol, 'https:');
  }
});

test('research models and a missing/mismatched scope model cannot produce public labels', async () => {
  const { classifyScanEvidence: decide } = await modulePromise;
  const { SCAN_CLASSES } = await presentationPromise;
  const evidence = fixture(SCAN_CLASSES);
  for (const invalid of [undefined, {}, { ...policy(), deploymentApproved: false }, { ...policy(), scopeValidated: false }, { ...policy(), unsupportedValidated: false }, { ...policy(), modelVersion: 'different' }]) {
    const result = decide(evidence, invalid);
    assert.equal(result.code, 'MODEL_UNAVAILABLE');
    assert.deepEqual(result.candidates, []);
  }
});

test('unrelated content and unsupported lesions are distinct even with extremely high class scores', async () => {
  const { classifyScanEvidence: decide } = await modulePromise;
  const { SCAN_CLASSES, scanResultView } = await presentationPromise;
  const evidence = fixture(SCAN_CLASSES, .99, .005);
  for (const [change, expected] of [[{ content: 'non_lesion' }, 'OUT_OF_SCOPE'], [{ content: 'uncertain' }, 'UNCERTAIN_CONTENT'], [{ support: 'unsupported' }, 'UNSUPPORTED_LESION'], [{ support: 'uncertain' }, 'UNSUPPORTED_LESION']]) {
    const result = decide({ ...evidence, ...change }, policy());
    assert.equal(result.code, expected);
    assert.deepEqual(scanResultView({ ...result, candidates: [{ id: 'acne_vulgaris' }, { id: 'rosacea' }] }).candidates, []);
  }
});

test('two supported similar candidates are shown only for a validated pair, without probability claims', async () => {
  const { classifyScanEvidence: decide } = await modulePromise;
  const { SCAN_CLASSES, scanResultView } = await presentationPromise;
  const result = decide(fixture(SCAN_CLASSES), policy());
  assert.equal(result.code, 'COMPARE_SUPPORTED');
  const view = scanResultView(result);
  assert.deepEqual(view.candidates.map(item => item.id), ['acne_vulgaris', 'rosacea']);
  assert.match(view.title, /ยังไม่สรุป/);
  assert.match(view.message, /ไม่ยืนยัน/);
  assert.equal('score' in view.candidates[0], false);
});

test('weak scores, an unvalidated pair or missing comparison calibration abstain instead of forcing top two', async () => {
  const { classifyScanEvidence: decide } = await modulePromise;
  const { SCAN_CLASSES } = await presentationPromise;
  for (const comparison of [undefined, { ...policy().comparison, validated: false }, { ...policy().comparison, allowedPairs: [] }]) {
    assert.equal(decide(fixture(SCAN_CLASSES), { ...policy(), comparison }).code, 'UNCERTAIN_CLASSIFICATION');
  }
  assert.equal(decide(fixture(SCAN_CLASSES, .08, .07), policy()).code, 'UNCERTAIN_CLASSIFICATION');
});

test('accepted single prediction does not invent a second candidate', async () => {
  const { classifyScanEvidence: decide } = await modulePromise;
  const { SCAN_CLASSES } = await presentationPromise;
  const result = decide(fixture(SCAN_CLASSES, .9, .05), policy());
  assert.equal(result.code, 'CLASSIFIED');
  assert.equal(result.candidates.length, 1);
});

test('wrong class order, nonfinite scores and non-normalized results fail closed', async () => {
  const { classifyScanEvidence: decide } = await modulePromise;
  const { SCAN_CLASSES } = await presentationPromise;
  for (const mutate of [e => e.predictions.reverse(), e => { e.predictions[0].score = NaN; }, e => { e.predictions[0].score = 1; }, e => { e.predictions[0].score = '0.47'; }]) {
    const evidence = fixture(SCAN_CLASSES); mutate(evidence);
    assert.equal(decide(evidence, policy()).code, 'INVALID_MODEL_RESULT');
  }
});

test('renderer rejects duplicate/unknown classes, missing scope and fake result names', async () => {
  const { scanResultView } = await presentationPromise;
  for (const result of [undefined, { code: 'CLASSIFIED', candidates: [{ id: 'acne_vulgaris' }] },
    { code: 'COMPARE_SUPPORTED', scope: 'supported_skin_lesion', candidates: [{ id: 'acne_vulgaris' }, { id: 'acne_vulgaris' }] },
    { code: 'CLASSIFIED', scope: 'supported_skin_lesion', candidates: [{ id: '<script>bad</script>' }] }]) {
    assert.equal(scanResultView(result).code, 'INVALID_MODEL_RESULT');
  }
});

test('DOM rendering uses curated text and sources, drops stale comparison after unsupported result', async () => {
  const { renderScanResult } = await presentationPromise;
  const doc = { createElement(tag) { return { tag, textContent: '', children: [], append(...nodes) { this.children.push(...nodes); } }; } };
  const container = { ownerDocument: doc, dataset: {}, children: [], classList: { remove() {} }, append(...nodes) { this.children.push(...nodes); }, replaceChildren() { this.children = []; } };
  renderScanResult(container, { code: 'COMPARE_SUPPORTED', scope: 'supported_skin_lesion', candidates: [{ id: 'acne_vulgaris', name: '<img src=x>' }, { id: 'rosacea' }] });
  const text = JSON.stringify(container.children);
  assert.ok(text.includes('สิว') && text.includes('โรซาเซีย'));
  assert.ok(!text.includes('<img'));
  assert.ok(text.includes('no-referrer'));
  renderScanResult(container, { code: 'UNSUPPORTED_LESION', candidates: [{ id: 'acne_vulgaris' }] });
  assert.equal(container.dataset.resultCode, 'UNSUPPORTED_LESION');
  assert.ok(!JSON.stringify(container.children).includes('โรซาเซีย'));
  assert.ok(JSON.stringify(container.children).includes('แพทย์ผู้เชี่ยวชาญ'));
});
