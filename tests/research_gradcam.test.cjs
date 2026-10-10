const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const version = 'scin3-local-baab96df5bf5';
const map = () => ({ contract: 'gradcam-v1', method: 'gradcam', modelVersion: version,
  classId: 'acne_vulgaris', clinicallyValidated: false, status: 'available', targetLayer: 'mobilenetv2/out_relu',
  scoreSpace: 'pre_softmax_logit', coordinateSpace: 'normalized_full_image', width: 7, height: 7,
  values: Array.from({ length:49 }, (_, i) => i / 48) });

test('only finite, bounded, normalized Grad-CAM for the exact version and accepted class is trusted', async () => {
  const { validatedGradcam } = await import('../vercel-public/research-gradcam.js');
  assert.equal(validatedGradcam(map(), version, 'acne_vulgaris').values.length, 49);
  for (const change of [{ classId:'psoriasis' }, { modelVersion:'other' }, { clinicallyValidated:true },
    { method:'random' }, { width:224 }, { values:[1] }, { values:Array(49).fill(0) },
    { values:Array(49).fill(NaN) }, { values:Array(49).fill('1') }, { values:Array(49).fill(1.1) }]) {
    assert.equal(validatedGradcam({ ...map(), ...change }, version, 'acne_vulgaris'), null);
  }
});

test('unavailable explanations never contain fabricated pixels; colormap preserves transparent zero signal', async () => {
  const { validatedGradcam, heatmapRgba, GRADCAM_NOTICE } = await import('../vercel-public/research-gradcam.js');
  const value = { contract:'gradcam-v1', method:'gradcam', modelVersion:version, classId:'acne_vulgaris',
    clinicallyValidated:false, status:'unavailable', reason:'zero_signal' };
  assert.equal(validatedGradcam(value, version, 'acne_vulgaris').status, 'unavailable');
  assert.equal(validatedGradcam({ ...value, values:[1] }, version, 'acne_vulgaris'), null);
  assert.deepEqual([...heatmapRgba([0,1])], [255,255,0,0,255,0,0,155]);
  assert.match(GRADCAM_NOTICE, /ไม่ใช่ขอบเขตหรือตำแหน่งรอยโรค/);
});

test('unsupported and non-skin statuses use requested notices without asserting unknown-disease detection', async () => {
  const { researchResultView } = await import('../vercel-public/research-result.js');
  const base = { ok:false, releaseStatus:'research_only', modelVersion:version, publicDeployment:false,
    scopeValidated:false, unsupportedValidated:false };
  assert.equal(researchResultView({ ...base, code:'UNCERTAIN_CLASSIFICATION' }).title, 'รอการพัฒนาจากระบบ');
  assert.match(researchResultView({ ...base, code:'NON_SKIN_IMAGE' }).title, /ไม่ผ่าน/);
  assert.equal(researchResultView({ ...base, code:'NON_SKIN_IMAGE', explanation:map() }).code, 'INVALID_MODEL_RESULT');
  const dashboard = readFileSync(require.resolve('../vercel-public/dashboard.js'), 'utf8');
  assert.match(dashboard, /if \(code === 'NON_SKIN_IMAGE'\) showDashboardAlert\(message\)/);
  const source = readFileSync(require.resolve('../vercel-public/research-gradcam.js'), 'utf8');
  assert.doesNotMatch(source, /innerHTML\s*=|localStorage|sessionStorage|fetch\(/);
});

test('real-map rendering keeps image coordinates and clears stale maps after a refusal', async () => {
  const { renderGradcam, clearGradcam } = await import('../vercel-public/research-gradcam.js');
  const elements = new Map(), images = [], strokes = [];
  const context = { drawImage() {}, createImageData: () => ({ data:new Uint8ClampedArray(196) }),
    putImageData() {}, beginPath() {}, moveTo: (...p) => strokes.push(p), lineTo() {}, stroke() {} };
  function element() {
    const classes = new Set(['hidden']);
    return { width:1, height:1, textContent:'', getContext: () => context,
      classList:{ add:c => classes.add(c), remove:c => classes.delete(c), contains:c => classes.has(c) } };
  }
  const doc = { getElementById(id) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); },
    createElement:element, defaultView:{ Image:class {
      constructor() { this.naturalWidth=400; this.naturalHeight=200; images.push(this); }
      set src(value) { this.source=value; }
    } } };
  renderGradcam(doc, map(), { previewUrl:'blob:local-prepared-image' });
  images[0].onload();
  const canvas = doc.getElementById('dashboardGradcamCanvas');
  assert.equal(canvas.width,400); assert.equal(canvas.height,200);
  assert.equal(canvas.classList.contains('hidden'),false);
  assert.match(doc.getElementById('dashboardGradcamStatus').textContent, /จากโมเดลจริง/);
  assert.ok(Math.abs(strokes[0][0] - (6.5 / 7 * 400 - 10)) < 1e-6);
  clearGradcam(doc); images[0].onload();
  assert.equal(canvas.width,1); assert.equal(canvas.classList.contains('hidden'),true);
  assert.equal(doc.getElementById('dashboardGradcamPanel').classList.contains('hidden'),true);
  const count = images.length;
  renderGradcam(doc, undefined, { previewUrl:'blob:local-prepared-image' });
  assert.equal(images.length,count);
  assert.match(doc.getElementById('dashboardGradcamStatus').textContent, /ไม่วาดตำแหน่งขึ้นมาแทน/);
});
