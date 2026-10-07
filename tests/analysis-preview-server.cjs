// Local visual fixture only. No accounts, patient images, credentials, storage
// access or inference requests. This file is outside the deployed public root.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const base = path.join(__dirname, '../vercel-public');
const dashboard = fs.readFileSync(path.join(base, 'dashboard.html'), 'utf8');
const admin = fs.readFileSync(path.join(base, 'admin.html'), 'utf8');
const head = html => html.match(/<head>([\s\S]*?)<\/head>/)[1];
const banner = '<div style="position:sticky;top:0;z-index:100;background:#fff3c4;color:#352509;padding:12px;font:14px sans-serif">ข้อมูลจำลองสำหรับตรวจหน้าจอเท่านั้น — ไม่ใช่ผล AI จากภาพจริงหรือผลประเมินความแม่นยำ</div>';
const analysisStart = dashboard.indexOf('        <section id="dashboardAnalysisView"');
const analysisEnd = dashboard.indexOf('    </main>', analysisStart);
if (analysisStart < 0 || analysisEnd < 0) throw new Error('Analysis screen boundaries changed');
const analysis = dashboard.slice(analysisStart, analysisEnd);
const resultPage = `<!doctype html><html lang="th"><head>${head(dashboard)}<title>หน้าทดสอบ UI — ไม่ใช่ผล AI จริง</title></head><body class="scan-medical-page min-h-screen text-slate-800">${banner}
<div class="mx-auto flex max-w-7xl flex-wrap gap-3 px-4 pt-4"><button id="fixtureAccepted" class="rounded-xl border bg-white p-3">ตัวอย่าง 2 กลุ่ม (จำลอง)</button><button id="fixtureUncertain" class="rounded-xl border bg-white p-3">ตัวอย่างไม่มั่นใจ (จำลอง)</button><a href="/admin" class="rounded-xl border bg-white p-3">ตัวอย่างหน้าแอดมิน (จำลอง)</a></div>
<main class="mx-auto max-w-7xl p-4 sm:p-8"><div id="dashboardScanView" class="hidden">พื้นที่เลือกภาพใหม่ — ทดสอบ UI เท่านั้น</div>${analysis}</main>
<script type="module">
import { SCAN_CLASSES } from '/scan-result.js';
import { renderAnalysisScreen } from '/research-result.js';
function show(accepted) {
  const analysis = { ok: accepted, code: accepted ? 'RESEARCH_ONLY' : 'UNCERTAIN_CLASSIFICATION', releaseStatus:'research_only',classificationStatus:'experimental',modelVersion:'derm-local-e10f89ad2ac8',publicDeployment:false,scopeValidated:false,unsupportedValidated:false };
  if(accepted) analysis.diagnostics=SCAN_CLASSES.map((row,index)=>({id:row.id,score:index?0.1/19:0.9}));
  renderAnalysisScreen(document,{analysis,storedImage:accepted,temporaryUploadDeleted:!accepted,scan:accepted?{id:'fixture-only',createdAt:'2026-10-07T16:00:00Z'}:undefined},{imageName:'ข้อมูลทดสอบ UI — ไม่ใช่ภาพผู้ใช้'});
}
document.getElementById('fixtureAccepted').onclick=()=>show(true);
document.getElementById('fixtureUncertain').onclick=()=>show(false);
document.getElementById('dashboardAnalysisNewButton').onclick=()=>{document.getElementById('dashboardAnalysisView').classList.add('hidden');document.getElementById('dashboardScanView').classList.remove('hidden');};
document.getElementById('dashboardAnalysisHistoryButton').onclick=()=>alert('ตัวอย่าง UI ไม่มีการเชื่อมบัญชีหรือประวัติจริง');
show(false);
</script></body></html>`;
const panelStart = admin.indexOf('    <section id="adminAiPanel"');
const panelEnd = admin.indexOf('    <section class="glass-panel-pro overflow-hidden', panelStart);
if (panelStart < 0 || panelEnd < 0) throw new Error('Admin panel boundaries changed');
const adminPage = `<!doctype html><html lang="th"><head>${head(admin)}<title>ทดสอบหน้าแอดมิน — ข้อมูลจำลอง</title></head><body>${banner}<main class="mx-auto max-w-7xl p-4 sm:p-8">${admin.slice(panelStart, panelEnd)}<a href="/">กลับตัวอย่างหน้าผล</a></main><script>
document.getElementById('adminAiStatus').textContent='ตัวอย่าง UI — ยังไม่ได้ตรวจบริการจริงในหน้านี้';
document.getElementById('adminAiVersion').textContent='derm-local-e10f89ad2ac8 (ข้อมูลจำลอง)';
document.getElementById('adminAiClassCount').textContent='20 กลุ่ม · 1 โมเดลจำแนก (ข้อมูลจำลอง)';
document.getElementById('adminAiRefreshButton').onclick=()=>{document.getElementById('adminAiStatus').textContent='ตัวอย่างสถานะติดต่อไม่ได้ — ไม่ใช่สถานะบริการจริง';};
</script></body></html>`;
http.createServer((req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.url === '/' || req.url === '/admin') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(req.url === '/' ? resultPage : adminPage);
  } else if (['/scan-result.js', '/research-result.js'].includes(req.url)) {
    res.setHeader('Content-Type', 'text/javascript; charset=utf-8'); res.end(fs.readFileSync(path.join(base, req.url.slice(1))));
  } else if (req.url === '/assets/scan-hero-medical-tech-v3.png') {
    res.setHeader('Content-Type', 'image/png'); res.end(fs.readFileSync(path.join(base, req.url.slice(1))));
  } else { res.statusCode = 404; res.end('Not found'); }
}).listen(8768, '127.0.0.1', () => console.log('Local UI fixture (not real AI): http://127.0.0.1:8768/'));
