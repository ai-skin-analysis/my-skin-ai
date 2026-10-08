// Local visual fixture only. No accounts, patient images, credentials, storage
// access or inference requests. This file is outside the deployed public root.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const base = path.join(__dirname, '../vercel-public');
const dashboard = fs.readFileSync(path.join(base, 'dashboard.html'), 'utf8');
const admin = fs.readFileSync(path.join(base, 'admin.html'), 'utf8');
const dashboardJs = fs.readFileSync(path.join(base, 'dashboard.js'), 'utf8');
const head = html => html.match(/<head>([\s\S]*?)<\/head>/)[1];
const banner = '<div style="position:sticky;top:0;z-index:100;background:#fff3c4;color:#352509;padding:12px;font:14px sans-serif">ข้อมูลจำลองสำหรับตรวจหน้าจอเท่านั้น — ไม่ใช่ผล AI จากภาพจริงหรือผลประเมินความแม่นยำ</div>';
const analysisStart = dashboard.indexOf('        <section id="dashboardAnalysisView"');
const analysisEnd = dashboard.indexOf('    </main>', analysisStart);
if (analysisStart < 0 || analysisEnd < 0) throw new Error('Analysis screen boundaries changed');
const analysis = dashboard.slice(analysisStart, analysisEnd);
const resultPage = `<!doctype html><html lang="th"><head>${head(dashboard)}<title>หน้าทดสอบ UI — ไม่ใช่ผล AI จริง</title></head><body class="scan-medical-page min-h-screen text-slate-800">${banner}
<div class="mx-auto flex max-w-7xl flex-wrap gap-3 px-4 pt-4"><button id="fixtureAccepted" class="rounded-xl border bg-white p-3">ตัวอย่างผลสำเร็จ (จำลอง)</button><button id="fixtureUncertain" class="rounded-xl border bg-white p-3">ตัวอย่างไม่มั่นใจ (จำลอง)</button><button id="fixtureComparison" class="rounded-xl border bg-white p-3">ตัวอย่างเปรียบเทียบ (จำลอง)</button><label class="rounded-xl bg-white p-3">กลุ่มตัวอย่าง <select id="fixtureClass" class="max-w-full"></select></label><a href="/admin" class="rounded-xl border bg-white p-3">ตัวอย่างหน้าแอดมิน (จำลอง)</a></div>
<main class="mx-auto max-w-7xl p-4 sm:p-8"><div id="dashboardScanView" class="hidden">พื้นที่เลือกภาพใหม่ — ทดสอบ UI เท่านั้น</div>${analysis}</main>
<script type="module">
import { SCAN_CLASSES } from '/scan-result.js';
import { renderAnalysisScreen } from '/research-result.js';
const selection = document.getElementById('fixtureClass');
for (const item of SCAN_CLASSES) { const option = document.createElement('option'); option.value = item.id; option.textContent = item.name; selection.append(option); }
function show(accepted, comparison=false) {
  const analysis = { ok: accepted, code: accepted ? 'RESEARCH_ONLY' : 'UNCERTAIN_CLASSIFICATION', releaseStatus:'research_only',classificationStatus:accepted?'experimental':'abstained',modelVersion:'derm-local-e10f89ad2ac8',publicDeployment:false,scopeValidated:false,unsupportedValidated:false };
  if(accepted) analysis.diagnostics=SCAN_CLASSES.map(row=>({id:row.id,score:row.id===selection.value?0.9:0.1/19}));
  if(comparison) analysis.comparison={contract:'research-ranking-v1',method:'classifier_score_order',status:'educational_only',clinicallyValidated:false,modelVersion:analysis.modelVersion,classCount:20,classIds:['rosacea','acne_vulgaris']};
  renderAnalysisScreen(document,{analysis,storedImage:accepted,temporaryUploadDeleted:!accepted,scan:accepted?{id:'fixture-only',createdAt:'2026-10-07T16:00:00Z'}:undefined},{imageName:'ข้อมูลทดสอบ UI — ไม่ใช่ภาพผู้ใช้'});
}
document.getElementById('fixtureAccepted').onclick=()=>show(true);
document.getElementById('fixtureUncertain').onclick=()=>show(false);
document.getElementById('fixtureComparison').onclick=()=>show(false,true);
selection.onchange=()=>show(true);
document.getElementById('dashboardAnalysisNewButton').onclick=()=>{document.getElementById('dashboardAnalysisView').classList.add('hidden');document.getElementById('dashboardScanView').classList.remove('hidden');};
document.getElementById('dashboardAnalysisHistoryButton').onclick=()=>alert('ตัวอย่าง UI ไม่มีการเชื่อมบัญชีหรือประวัติจริง');
show(true);
</script></body></html>`;
const adminStart = admin.indexOf('  <main id="adminMain"');
const adminEnd = admin.indexOf('  </main>', adminStart);
if (adminStart < 0 || adminEnd < 0) throw new Error('Admin boundaries changed');
const adminPage = `<!doctype html><html lang="th"><head>${head(admin)}<title>ทดสอบหน้าแอดมิน — ข้อมูลจำลอง</title></head><body>${banner}${admin.slice(adminStart, adminEnd).replace('mx-auto hidden max-w-7xl', 'mx-auto max-w-7xl')}</main><a href="/">กลับตัวอย่างหน้าผล</a></body></html>`;
const progressStart = dashboard.indexOf('    <div id="dashboardProcessingModal"');
const progressEnd = dashboard.indexOf('    <div id="dashboardAlertToast"', progressStart);
if (progressStart < 0 || progressEnd < 0) throw new Error('Analysis dialog boundaries changed');
const progressLogic = dashboardJs.match(/    const ANALYSIS_PROGRESS = \{[\s\S]*?\n    \};/)[0]
  + dashboardJs.match(/    function setProcessingStage\(stage\) \{[\s\S]*?\n    \}/)[0];
const progressPage = `<!doctype html><html lang="th"><head>${head(dashboard)}<title>ทดสอบหน้ารอ AI — ไม่เรียกโมเดลจริง</title></head><body>${banner}${dashboard.slice(progressStart, progressEnd)}<script>
const refreshIcons=()=>{if(typeof lucide!=='undefined')lucide.createIcons();};
const showModal=id=>{const modal=document.getElementById(id);modal.classList.remove('hidden');modal.classList.add('flex');modal.setAttribute('aria-hidden','false');};
${progressLogic}
setProcessingStage('commit');
</script></body></html>`;
http.createServer((req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (['/', '/admin', '/progress'].includes(req.url)) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(req.url === '/' ? resultPage : req.url === '/admin' ? adminPage : progressPage);
  } else if (['/scan-result.js', '/research-result.js', '/research-comparison.js'].includes(req.url)) {
    res.setHeader('Content-Type', 'text/javascript; charset=utf-8'); res.end(fs.readFileSync(path.join(base, req.url.slice(1))));
  } else if (['/assets/scan-hero-medical-tech-v3.png', '/assets/admin-computer-engineering-bg-v1.png'].includes(req.url)) {
    res.setHeader('Content-Type', 'image/png'); res.end(fs.readFileSync(path.join(base, req.url.slice(1))));
  } else { res.statusCode = 404; res.end('Not found'); }
}).listen(8768, '127.0.0.1', () => console.log('Local UI fixture (not real AI): http://127.0.0.1:8768/'));
