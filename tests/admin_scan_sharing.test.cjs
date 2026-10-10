const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');

const id = '11111111-1111-4111-8111-111111111111';
const otherId = '22222222-2222-4222-8222-222222222222';
const createdAt = new Date(Date.now() - 60000).toISOString();
const retention = new Date(Date.now() + 86400000).toISOString();
async function fixture() {
  const sharing = await import('../vercel-public/lib/admin-scan-sharing.js');
  const { SCIN3_CLASSES } = await import('../vercel-public/research-catalog.js');
  const analysis = { ok: true, code: 'RESEARCH_ONLY', releaseStatus: 'research_only', classificationStatus: 'experimental',
    modelVersion: 'scin3-local-baab96df5bf5', publicDeployment: false, scopeValidated: false, unsupportedValidated: false,
    diagnostics: SCIN3_CLASSES.map((row, i) => ({ id: row.id, score: i ? .05 : .9 })) };
  const explanation = { contract: 'gradcam-v1', method: 'gradcam', status: 'available', modelVersion: analysis.modelVersion,
    classId: SCIN3_CLASSES[0].id, clinicallyValidated: false, targetLayer: 'mobilenetv2/out_relu',
    scoreSpace: 'pre_softmax_logit', coordinateSpace: 'normalized_full_image', width: 7, height: 7,
    values: Array.from({ length: 49 }, (_, i) => i / 48) };
  const pending = { id, admin_share_consent_version: sharing.ADMIN_SHARE_CONSENT_VERSION };
  const scan = { id, createdAt, retentionExpiresAt: retention };
  const grant = { id, analysis_json: analysis, consented_at: createdAt, created_at: createdAt, retention_expires_at: retention };
  const row = { id, user_id: 2, source: 'camera', original_name: 'prepared.jpg', image_size_bytes: 5,
    image_object_path: `scans/2/${otherId}.jpg`, created_at: createdAt, retention_expires_at: retention,
    model_version: analysis.modelVersion, decision_status: 'research_only' };
  return { ...sharing, pending, scan, grant, row, analysis, explanation };
}

test('admin sharing is optional, default private and separately versioned; truthy strings never grant access', async () => {
  const f = await fixture();
  assert.equal(f.adminShareConsent({}), null);
  assert.equal(f.adminShareConsent({ shareWithAdmin: false }), null);
  for (const shareWithAdmin of ['true', 1, {}, null]) assert.throws(() => f.adminShareConsent({ shareWithAdmin }));
  for (const adminShareConsentVersion of [undefined, 'old-version', 'skin-demo-scin3-20261009-v1']) {
    assert.throws(() => f.adminShareConsent({ shareWithAdmin: true, adminShareConsentVersion }));
  }
  assert.equal(f.adminShareConsent({ shareWithAdmin: true, adminShareConsentVersion: f.ADMIN_SHARE_CONSENT_VERSION }), f.ADMIN_SHARE_CONSENT_VERSION);
});

test('shared snapshots retain only trusted accepted output and real Grad-CAM, never arbitrary text or URLs', async () => {
  const f = await fixture();
  const result = f.sharedAnalysis({ ...f.analysis, explanation: { ...f.explanation, privateUrl: 'secret' }, message: 'secret', key: 'secret' });
  assert.equal(JSON.stringify(result).includes('secret'), false);
  assert.deepEqual(result.explanation.values, f.explanation.values);
  for (const analysis of [
    { ...f.analysis, ok: false, code: 'UNCERTAIN_CLASSIFICATION' },
    { ...f.analysis, scopeValidated: true },
    { ...f.analysis, explanation: { ...f.explanation, classId: 'psoriasis' } },
    { ...f.analysis, diagnostics: f.analysis.diagnostics.map((row, i) => ({ ...row, score: i ? .15 : .7 })) },
  ]) assert.throws(() => f.sharedAnalysis(analysis));
});

test('only an accepted saved server scan with the original pending opt-in can create a grant', async () => {
  const f = await fixture(); let writes = 0;
  const sql = async (strings, ...values) => {
    writes++; const query = strings.join('?');
    assert.match(query, /FROM smart_skin_pending_scan_uploads pending JOIN smart_skin_users/);
    assert.match(query, /pending\.analysis_started_at IS NOT NULL/);
    assert.match(query, /pending\.admin_share_consent_version/);
    assert.match(query, /pending\.created_at > users\.admin_shares_revoked_at/);
    assert.match(query, /ON CONFLICT \(id\) DO NOTHING/);
    assert.equal(values.includes(2), true);
    return [{ id }];
  };
  const accepted = { storedImage: true, scan: f.scan, analysis: f.analysis };
  assert.equal(await f.recordConsentedScan(sql, { id }, 2, accepted, retention), 'private');
  assert.equal(await f.recordConsentedScan(sql, f.pending, 2, { ...accepted, storedImage: false }, retention), 'not_shared');
  assert.equal(await f.recordConsentedScan(sql, f.pending, 2, { ...accepted, scan: { id: otherId } }, retention), 'not_shared');
  assert.equal(writes, 0);
  assert.equal(await f.recordConsentedScan(sql, f.pending, 2, accepted, retention), 'shared');
  assert.equal(writes, 1);
  assert.equal(await f.recordConsentedScan(async () => [], f.pending, 2, accepted, retention), 'not_shared');
});

test('shared query identifiers and pagination are bounded and cannot inject filters', async () => {
  const f = await fixture();
  assert.deepEqual(f.sharedQuery({ userId: '2', scanId: id }, true), { userId: 2, scanId: id });
  const cursor = Buffer.from(JSON.stringify([createdAt, id])).toString('base64url');
  assert.equal(f.sharedQuery({ userId: '2', cursor }).cursor.at, createdAt);
  for (const userId of ['0', '-2', '2&user_id=3', '9999999999999999', ['2'], 2]) assert.throws(() => f.sharedQuery({ userId }));
  for (const cursor of ['', 'x'.repeat(181), 'foo', Buffer.from(JSON.stringify(['not-a-date', id])).toString('base64url')]) {
    assert.throws(() => f.sharedQuery({ userId: '2', cursor }));
  }
  assert.throws(() => f.sharedQuery({ userId: '2', scanId: '../../avatar' }, true));
});

test('timeline intersects active consent with retained owned private history; no paths or upstream labels leak', async () => {
  const f = await fixture(); let reads = 0;
  const sql = async (strings, ...values) => {
    reads++; const query = strings.join('?');
    assert.match(query, /shares\.user_id/); assert.match(query, /shares\.retention_expires_at > NOW/);
    assert.match(query, /shares\.consented_at > users\.admin_shares_revoked_at/);
    assert.match(query, /users\.approval_status = 'approved'/);
    assert.equal(values.includes(2), true); return [f.grant];
  };
  const select = async (table, query) => {
    assert.equal(table, 'smart_skin_scan_logs'); assert.match(query, /user_id=eq\.2/);
    assert.match(query, /retention_expires_at=gt\./); return [{ ...f.row, result_disease: '<script>ignored</script>' }];
  };
  const result = await f.sharedHistory(sql, { userId: 2 }, { select });
  assert.equal(reads, 2); assert.equal(result.history.length, 1);
  assert.equal(result.history[0].imageUrl, `/api/admin/shared-image?userId=2&scanId=${id}`);
  assert.equal(JSON.stringify(result).includes('image_object_path'), false);
  assert.equal(JSON.stringify(result).includes('<script>'), false);
  for (const row of [null, { ...f.row, user_id: 3 }, { ...f.row, image_object_path: `scans/3/${id}.jpg` },
    { ...f.row, retention_expires_at: createdAt }, { ...f.row, model_version: 'mismatch' },
    { ...f.row, image_size_bytes: 8 * 1024 * 1024 + 1 }, { ...f.row, decision_status: 'image_received' }]) {
    const denied = await f.sharedHistory(sql, { userId: 2 }, { select: async () => row ? [row] : [] });
    assert.equal(denied.history.length, 0);
  }
  let calls = 0;
  const revokedDuringRead = await f.sharedHistory(async () => ++calls === 1 ? [f.grant] : [], { userId: 2 }, { select });
  assert.equal(revokedDuringRead.history.length, 0);
});

test('pagination is stable, bounded and includes a next cursor even when some private records were deleted', async () => {
  const f = await fixture();
  const grants = Array.from({ length: f.SHARED_PAGE_SIZE + 1 }, (_, i) => ({ ...f.grant,
    id: `${String(i + 1).padStart(8, '0')}-1111-4111-8111-111111111111` }));
  const sql = async () => grants;
  const result = await f.sharedHistory(sql, { userId: 2 }, { select: async () => [] });
  assert.equal(result.history.length, 0);
  const query = f.sharedQuery({ userId: '2', cursor: result.nextCursor });
  assert.equal(query.cursor.id, grants[f.SHARED_PAGE_SIZE - 1].id);
});

test('image access rejects revoked, missing, expired and other-user photos before storage download', async () => {
  const f = await fixture(); let downloads = 0;
  const query = { userId: 2, scanId: id };
  const download = async (path, size) => { downloads++; assert.equal(path, f.row.image_object_path); assert.equal(size, 5); return Buffer.from('image'); };
  await assert.rejects(f.sharedImage(async () => [], query, { download }), /ยินยอม/);
  for (const row of [null, { ...f.row, user_id: 3 }, { ...f.row, image_object_path: `scans/3/${id}.jpg` }, { ...f.row, retention_expires_at: createdAt }]) {
    await assert.rejects(f.sharedImage(async () => [f.grant], query, { download, select: async () => row ? [row] : [] }), /หมดอายุ/);
  }
  assert.equal(downloads, 0);
  const result = await f.sharedImage(async () => [f.grant], query, { download, select: async () => [f.row] });
  assert.equal(result.bytes.toString(), 'image'); assert.equal(result.mime, 'image/jpeg');
  let reads = 0;
  await assert.rejects(f.sharedImage(async () => ++reads === 1 ? [f.grant] : [], query, { download, select: async () => [f.row] }), /ไม่พร้อม/);
  assert.equal(downloads, 2);
});

test('revocation applies an atomic account cutoff before deleting health snapshots and clears old pending opt-ins', async () => {
  const f = await fixture(); const calls = [];
  await f.revokeAdminShares(async (strings, ...values) => {
    calls.push(strings.join('?')); assert.equal(values[0], 2);
    return calls.length === 1 ? [{ admin_shares_revoked_at: createdAt }] : [];
  }, 2);
  assert.match(calls[0], /UPDATE smart_skin_users SET admin_shares_revoked_at/);
  assert.match(calls[1], /DELETE FROM smart_skin_admin_scan_shares/);
  assert.match(calls[2], /admin_share_consent_version = NULL/);
  assert.match(calls[2], /created_at <=/);
});

function handlerFixture(extra = {}) {
  const source = readFileSync(require.resolve('../vercel-public/api/admin-handler.js'), 'utf8')
    .replace(/^import[\s\S]*?from ['"][^'"]+['"];\r?\n/gm, '')
    .replace('export default async function handler', 'async function handler');
  const context = vm.createContext({
    requireGet: () => true, requirePost: () => true, requireSameOrigin: () => true,
    sessionClaims: () => ({ sub: 1, mfaVerified: false }),
    publicUserById: async () => ({ id: 1, role: 'admin', mfaEnrolled: true }),
    json: (res, status, body) => { res.statusCode = status; res.body = body; return res; },
    ...extra,
  });
  vm.runInContext(`${source}\nglobalThis.routes = { adminSharedHistory, adminSharedImage, userRevokeAdminShares, completeResearchUpload };`, context);
  return context;
}

test('both real admin health-data routes deny anonymous, ordinary users and unverified MFA before reading data', async () => {
  const f = await fixture(); let accessed = 0;
  const context = handlerFixture({ sharedQuery: f.sharedQuery, database: async () => { accessed++; return {}; },
    sharedHistory: async () => ({ history: [] }), sharedImage: async () => ({ bytes: Buffer.from('image'), mime: 'image/jpeg' }) });
  for (const route of ['adminSharedHistory', 'adminSharedImage']) {
    for (const [claims, user, expected] of [
      [null, null, 401], [{ sub: 1, mfaVerified: true }, { role: 'user', mfaEnrolled: true }, 403],
      [{ sub: 1, mfaVerified: false }, { role: 'admin', mfaEnrolled: true }, 403],
      [{ sub: 1, mfaVerified: true }, { role: 'admin', mfaEnrolled: false }, 403],
    ]) {
      context.sessionClaims = () => claims; context.publicUserById = async () => user;
      const res = {};
      await context.routes[route]({ method: 'GET', query: { userId: '2', scanId: id } }, res);
      assert.equal(res.statusCode, expected);
    }
  }
  assert.equal(accessed, 0);
  context.sessionClaims = () => ({ sub: 1, mfaVerified: true });
  context.publicUserById = async () => ({ role: 'admin', mfaEnrolled: true });
  const res = await context.routes.adminSharedHistory({ method: 'GET', query: { userId: '2' } }, {});
  assert.equal(res.statusCode, 200); assert.equal(accessed, 1);
  const image = { headers: {}, setHeader(key, value) { this.headers[key] = value; }, status(code) { this.statusCode = code; return this; }, send(bytes) { this.bytes = bytes; return this; } };
  await context.routes.adminSharedImage({ method: 'GET', query: { userId: '2', scanId: id } }, image);
  assert.equal(image.statusCode, 200); assert.equal(image.headers['Cache-Control'], 'no-store, private');
  assert.equal(image.headers['Cross-Origin-Resource-Policy'], 'same-origin');
});

test('sharing failure leaves a genuinely completed private result usable and does not retry inference', async () => {
  const f = await fixture(); let inferred = 0, deleted = 0;
  const sql = async strings => {
    const text = strings.join('?');
    if (text.includes('RETURNING id, object_path')) return [f.pending];
    if (text.includes('DELETE FROM smart_skin_pending_scan_uploads WHERE id')) deleted++;
    return [];
  };
  const context = handlerFixture({ Date, process: { env: {} }, RESEARCH_CONSENT_VERSION: 'test-consent',
    sessionClaims: () => ({ sub: 2 }), publicUserById: async () => ({ id: 2, role: 'user', approvalStatus: 'approved' }),
    requestJson: req => req.body, takeRateBudget: () => ({ ok: true }),
    database: async () => sql, isSupabasePrivateStorageConfigured: () => false,
    scanRetentionDays: () => 30, recordConsentedScan: async () => { throw new Error('storage offline'); },
    analyzePrivateResearchScan: async () => { inferred++; return { storedImage: true, scan: f.scan, analysis: f.analysis }; } });
  const result = await context.routes.completeResearchUpload({ body: { uploadId: id, researchConsentVersion: 'test-consent', shareWithAdmin: true } }, {});
  assert.equal(result.statusCode, 200); assert.equal(result.body.storedImage, true);
  assert.equal(result.body.adminShareStatus, 'unavailable'); assert.equal(inferred, 1); assert.equal(deleted, 1);
});

test('real route entry rejects missing session and cross-origin sharing writes before database access', async () => {
  const { default: handler } = await import('../vercel-public/api/admin-handler.js');
  const response = () => ({ headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } });
  for (const path of ['shared-history', 'shared-image', 'user/scan/admin-share/revoke']) {
    const res = response();
    await handler({ method: path.startsWith('user/') ? 'POST' : 'GET', query: { path, userId: '2', scanId: id },
      headers: { host: 'smart-skin-ai.vercel.app', origin: 'https://smart-skin-ai.vercel.app' } }, res);
    assert.equal(res.statusCode, 401); assert.equal(res.headers['Cache-Control'], 'no-store');
  }
  const res = response();
  await handler({ method: 'POST', query: { path: 'user/scan/admin-share/revoke' },
    headers: { host: 'smart-skin-ai.vercel.app', origin: 'https://other.example' } }, res);
  assert.equal(res.statusCode, 403);
});

test('schema is opt-in only and removes shared results at expiry, account deletion or history deletion', () => {
  const schema = readFileSync(require.resolve('../vercel-public/lib/account-auth.js'), 'utf8');
  assert.match(schema, /smart_skin_admin_scan_shares[\s\S]*?REFERENCES smart_skin_users\(id\) ON DELETE CASCADE/);
  assert.match(schema, /DELETE FROM smart_skin_admin_scan_shares WHERE retention_expires_at <= NOW\(\)/);
  assert.doesNotMatch(schema, /INSERT INTO smart_skin_admin_scan_shares/);
  const routes = readFileSync(require.resolve('../vercel-public/api/admin-handler.js'), 'utf8');
  assert.match(routes, /async function deletePrivateUserData[\s\S]*?revokeAdminShares/);
  assert.match(routes, /async function deleteScanHistory[\s\S]*?verifyOwnPassword[\s\S]*?revokeAdminShares[\s\S]*?removePrivateObjects/);
  const front = readFileSync(require.resolve('../vercel-public/admin-timeline.js'), 'utf8');
  assert.doesNotMatch(front, /(?:localStorage|sessionStorage)\.(?:getItem|setItem)|innerHTML\s*=/);
  assert.match(front, /URL\.revokeObjectURL/); assert.match(front, /visibilitychange/);
  assert.match(front, /revision !== generation/); assert.match(front, /row\.imageUrl !== expected/);
});
