// LOCAL UI harness only. All accounts/grants below are labelled fixtures.
// The SCIN image is public; its saved API response is reused, NOT re-inferred.
// No connection to a real account database or private bucket is made.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const base = path.join(__dirname, '../vercel-public');
const fixture = path.join(__dirname, '../../deploy/scin3');
const analysis = JSON.parse(fs.readFileSync(path.join(fixture, 'gradcam-public-fixture.json'), 'utf8'));
const id = '11111111-1111-4111-8111-111111111111';
const now = new Date().toISOString();
const expires = new Date(Date.now() + 86400000).toISOString();
const counters = { upload: 0, complete: 0, picture: 0, timeline: 0 };
const scan = { id, resultLabel: 'ผลเชิงทดลอง · สิว (ข้อมูลทดสอบ UI)', source: 'upload',
  originalName: 'ภาพ SCIN สาธารณะ · ข้อมูลทดสอบ UI', createdAt: now, retentionExpiresAt: expires };
let shared = true;
const banner = '<div style="position:relative;z-index:80;background:#fff2ba;padding:10px;text-align:center;font:14px sans-serif">ทดสอบหน้าเว็บในเครื่อง · บัญชีและการแชร์จำลอง · ภาพ SCIN สาธารณะและผล API ที่บันทึกไว้ · ไม่ใช่ผลทดสอบบัญชีจริง</div>';
const overview = { ok: true, privateSummaryAvailable: true, admin: { name: 'ผู้ดูแลทดสอบในเครื่อง', email: 'admin@example.invalid' },
  counts: { pendingUsers: 0, users: 2, accounts: 3, admins: 1, scans: 1, feedbacks: 0 }, feedbacks: [],
  users: [{ id: 9001, name: 'บัญชีทดสอบ · ภาพ SCIN สาธารณะ', email: 'fixture@example.invalid', approvalStatus: 'approved', lastLoginAt: now },
    { id: 9002, name: 'บัญชีทดสอบ · ไม่แชร์ประวัติ', email: 'private@example.invalid', approvalStatus: 'approved', lastLoginAt: now }] };
async function jsonBody(req) { let body = ''; for await (const chunk of req) { body += chunk; if (body.length > 100000) throw new Error('too large'); } return body ? JSON.parse(body) : {}; }
const server = http.createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const url = new URL(req.url, 'http://127.0.0.1:8784');
  const json = value => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); };
  try {
    if (url.pathname === '/api/admin/overview') return json(overview);
    if (url.pathname === '/api/admin/shared-history') {
      counters.timeline++;
      return json({ ok: true, history: shared && url.searchParams.get('userId') === '9001' ? [{ ...scan, userId: 9001,
        consentedAt: now, analysis, imageUrl: `/api/admin/shared-image?userId=9001&scanId=${id}` }] : [], nextCursor: null });
    }
    if (url.pathname === '/api/admin/shared-image') {
      counters.picture++; if (!shared) { res.statusCode = 404; return json({ ok: false }); }
      const bytes = fs.readFileSync(path.join(fixture, 'gradcam-public-fixture.png'));
      res.setHeader('Content-Type', 'image/png'); res.setHeader('Content-Length', bytes.length); return res.end(bytes);
    }
    if (url.pathname === '/api/account/me') return json({ ok: true, authenticated: true,
      user: { id: 9001, name: 'บัญชีทดสอบในเครื่อง', email: 'fixture@example.invalid', role: 'user', approvalStatus: 'approved' } });
    if (url.pathname === '/api/user/profile') return json({ ok: true, avatar: null });
    if (url.pathname === '/api/user/storage-status') return json({ ok: true, configured: true, retentionDays: 30 });
    if (url.pathname === '/api/user/scan/research/readiness') return json({ ok: true, researchAvailable: true, releaseStatus: 'research_only', classCount: 3, modelVersion: analysis.modelVersion });
    if (url.pathname === '/api/user/scan/research/upload') {
      counters.upload++; const body = await jsonBody(req); shared = body.shareWithAdmin === true;
      return json({ ok: true, upload: { id, url: '/preview-upload' } });
    }
    if (url.pathname === '/preview-upload') { for await (const chunk of req) {} res.statusCode = 200; return res.end(); }
    if (url.pathname === '/api/user/scan/research/complete') {
      counters.complete++; return json({ ok: true, storedImage: true, analysis, scan, adminShareStatus: shared ? 'shared' : 'private', message: 'ผลทดสอบการแสดงหน้าเว็บ ไม่ใช่การสแกนใหม่' });
    }
    if (url.pathname === '/api/user/history') return json({ ok: true, history: [scan] });
    if (url.pathname === '/api/user/scan/admin-share/revoke') { shared = false; return json({ ok: true, message: 'ถอนการแชร์ข้อมูลทดสอบในเครื่องแล้ว' }); }
    if (url.pathname === '/__preview_counters') return json(counters);
    const pathname = url.pathname === '/' ? '/admin.html' : url.pathname;
    if (!/^\/(?:[\w-]+\.(?:html|js)|assets\/[\w-]+\.(?:png|jpg))$/.test(pathname)) { res.statusCode = 404; return res.end('Not found'); }
    const file = path.join(base, pathname.slice(1));
    if (!fs.existsSync(file)) { res.statusCode = 404; return res.end('Not found'); }
    res.setHeader('Content-Type', pathname.endsWith('.html') ? 'text/html; charset=utf-8' : pathname.endsWith('.js') ? 'text/javascript' : 'image/png');
    if (pathname.endsWith('.html')) return res.end(fs.readFileSync(file, 'utf8').replace(/(<body[^>]*>)/, `$1${banner}`));
    res.end(fs.readFileSync(file));
  } catch { res.statusCode = 500; json({ ok: false, message: 'Local preview failure' }); }
});
server.listen(8784, '127.0.0.1', () => console.log('Local UI fixtures only: http://127.0.0.1:8784/admin.html'));
