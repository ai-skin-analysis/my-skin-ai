const { test } = require('node:test');
const assert = require('node:assert/strict');

test('unavailable models cannot be bypassed by a quality check or a client checkbox', async () => {
    const { scanReadiness, requireScanEngine } = await import('../vercel-public/lib/scan-readiness.js');
    assert.equal(scanReadiness().classificationAvailable, false);
    assert.equal(scanReadiness().scopeFilterAvailable, false);
    let result;
    assert.equal(requireScanEngine({}, (_res, status, body) => { result = { status, body }; }), false);
    assert.equal(result.status, 503);
    assert.equal(result.body.code, 'MODEL_UNAVAILABLE');
});
