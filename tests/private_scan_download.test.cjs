const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = 'scans/2/11111111-1111-4111-8111-111111111111.jpg';

test('private binary download is bounded, fixed-path, no redirect and server-only', async () => {
  process.env.SUPABASE_SECRET_KEY = 'sb_secret_fixture'; process.env.SUPABASE_URL = 'https://fixture.supabase.co';
  const { downloadPrivateScanObject } = await import('../vercel-public/lib/supabase-private.js');
  let calls = 0;
  const options = { fetchImpl: async (url, request) => {
    calls++; assert.match(url, /^https:\/\/fixture.supabase.co\/storage\/v1\/object\/smart-skin-private\/scans\/2\//);
    assert.equal(request.redirect, 'manual'); assert.equal(request.headers.apikey, 'sb_secret_fixture');
    return new Response(Buffer.from('image'), { headers: { 'content-type': 'image/jpeg', 'content-length': '5' } });
  } };
  assert.equal((await downloadPrivateScanObject(path, 5, options)).toString(), 'image');
  for (const invalid of ['https://evil.test/photo', '../etc/passwd', 'scans/2/../../photo.jpg']) await assert.rejects(downloadPrivateScanObject(invalid, 5, options));
  await assert.rejects(downloadPrivateScanObject(path, 8388609, options)); assert.equal(calls, 1);
  for (const response of [new Response('image', { status: 302, headers: { location: 'https://evil.test' } }),
    new Response('image', { headers: { 'content-type': 'text/html' } }),
    new Response('image-long', { headers: { 'content-type': 'image/jpeg' } }),
    new Response('im', { headers: { 'content-type': 'image/jpeg' } }),
    new Response('image', { headers: { 'content-type': 'image/jpeg', 'content-length': '99' } })]) {
    await assert.rejects(downloadPrivateScanObject(path, 5, { fetchImpl: async () => response }));
  }
  await assert.rejects(downloadPrivateScanObject(path, 5, { fetchImpl: async () => { throw new Error('sb_secret_fixture'); } }), error => !error.message.includes('sb_secret_fixture'));
});
