// Loopback-only UI fixture. GPS, administrative names and weather are ALL
// synthetic. No real device permission, user data or provider call is used.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const base = path.join(__dirname, '../vercel-public');
const banner = '<div style="position:sticky;top:0;z-index:80;background:#fff2ba;padding:10px;text-align:center;font:14px sans-serif">ทดสอบหน้าจอในเครื่อง · GPS ชื่อพื้นที่ และอากาศจำลอง · ไม่ใช่ตำแหน่งหรืออากาศจริงของคุณ</div>';
const fixtureScript = `Object.defineProperty(navigator, 'geolocation', { configurable:true, value: { getCurrentPosition(success,error) {
  if (new URLSearchParams(location.search).has('denied')) return error({code:1});
  setTimeout(() => success({timestamp:Date.now(),coords:{latitude:0.123456,longitude:1.234567,accuracy:50}}),150);
} } });`;
const counters = { location: 0, weather: 0, air: 0 };
http.createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const url = new URL(req.url, 'http://127.0.0.1:8786');
  const json = data => { res.setHeader('Content-Type','application/json'); res.end(JSON.stringify(data)); };
  try {
    if (url.pathname === '/api/account/me') return json({ ok:true, user:null });
    if (url.pathname === '/__fixture_counters') return json(counters);
    if (url.pathname === '/test-location-fixture.js') { res.setHeader('Content-Type','text/javascript'); return res.end(fixtureScript); }
    if (url.pathname === '/api/environment' && req.method === 'POST') {
      let body = ''; for await (const chunk of req) { body += chunk; if (body.length > 512) throw new Error('too large'); }
      const input = JSON.parse(body);
      if (input.latitude !== 0.1235 || input.longitude !== 1.2346) throw new Error('not fixture coordinates');
      if (input.kind === 'location') { counters.location++; return json({ location:{province:'จังหวัดทดสอบ',district:'อำเภอทดสอบ',subdistrict:'ตำบลทดสอบ',country:'ประเทศไทย',isThai:true,isBangkok:false} }); }
      if (input.kind === 'weather') { counters.weather++; return json({ current:{temperature_2m:24.3,relative_humidity_2m:50,uv_index:3,weather_code:2,is_day:1,time:'2026-10-11T09:00'},timezone:'Asia/Bangkok' }); }
      if (input.kind === 'air') { counters.air++; return json({current:{us_aqi:20,time:'2026-10-11T09:00'},timezone:'Asia/Bangkok'}); }
      throw new Error('unknown fixture');
    }
    const pathname = url.pathname === '/' ? '/index.html' : url.pathname;
    if (!/^\/(?:[\w-]+\.(?:html|js)|assets\/[\w-]+\.(?:png|jpg))$/.test(pathname)) { res.statusCode=404; return res.end('Not found'); }
    const file = path.join(base, pathname.slice(1));
    if (!fs.existsSync(file)) { res.statusCode=404; return res.end('Not found'); }
    res.setHeader('Content-Type', pathname.endsWith('.html') ? 'text/html; charset=utf-8' : pathname.endsWith('.js') ? 'text/javascript' : 'image/png');
    if (pathname.endsWith('.html')) {
      const policy = JSON.parse(fs.readFileSync(path.join(base,'vercel.json'),'utf8'));
      for (const header of policy.headers[0].headers) res.setHeader(header.key,header.value);
      return res.end(fs.readFileSync(file,'utf8').replace(/(<body[^>]*>)/,`$1${banner}`).replace('<script src="app.js" defer>', '<script src="/test-location-fixture.js" defer></script><script src="app.js" defer>'));
    }
    res.end(fs.readFileSync(file));
  } catch { res.statusCode=400; json({ok:false,message:'Synthetic UI fixture failure'}); }
}).listen(8786,'127.0.0.1',()=>console.log('Synthetic location UI only: http://127.0.0.1:8786/'));
