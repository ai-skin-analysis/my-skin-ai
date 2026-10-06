// Local-only, fixture-labelled visual test. Serves exactly two routes; no user
// accounts, images, inference requests, credentials or repository file browsing.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const base = path.join(__dirname, '../vercel-public');
const dashboard = fs.readFileSync(path.join(base, 'dashboard.html'), 'utf8');
const head = dashboard.match(/<head>([\s\S]*?)<\/head>/)[1];
const start = dashboard.indexOf('    <div id="dashboardProcessingModal"');
const end = dashboard.indexOf('    <div id="dashboardAlertToast"', start);
if (start < 0 || end < 0) throw new Error('Processing modal boundaries changed');
const modal = dashboard.slice(start, end);
const page = `<!doctype html><html lang="th"><head>${head}<title>ทดสอบหน้าจอ — ไม่ใช่ผล AI</title></head><body>
<div style="position:fixed;top:0;left:0;right:0;z-index:100;background:#fff3c4;color:#352509;padding:8px;font:14px sans-serif">
ตัวอย่างหน้าจอทดสอบเท่านั้น — ไม่ได้วิเคราะห์ภาพจริง
<button id="compare">เปรียบเทียบ</button> <button id="unsupported">ยังไม่รองรับ</button> <button id="invalid">ภาพไม่เกี่ยวข้อง</button>
<button id="mobile">ขนาดมือถือ</button> <button id="desktop">ขนาดปกติ</button></div>
${modal}<script type="module">
import { SCAN_CLASSES } from '/scan-result.js';
import { renderResearchResult } from '/research-result.js';
const modal = document.getElementById('dashboardProcessingModal');
modal.classList.remove('hidden'); modal.classList.add('flex'); modal.dataset.processing='complete';
modal.setAttribute('aria-hidden','false'); modal.style.paddingTop='90px';
const consolePanel = modal.querySelector('.processing-console');
document.getElementById('dashboardProcessingTitle').textContent='ตัวอย่างการแสดงผล';
document.getElementById('dashboardProcessingDetail').textContent='ข้อมูลจำลองสำหรับตรวจหน้าจอ ไม่ใช่ผลจากภาพผู้ใช้';
document.getElementById('dashboardProcessingCloseButton').classList.remove('hidden');
document.getElementById('dashboardProcessingCloseButton').textContent='ปิดตัวอย่าง';
document.getElementById('dashboardProcessingCloseButton').onclick=()=>modal.classList.add('hidden');
document.querySelectorAll('[data-processing-step]').forEach(node=>node.dataset.state='complete');
document.getElementById('dashboardProcessingSteps').classList.add('hidden');
function show(code) {
  modal.classList.remove('hidden');
  const result = {code, ok:code==='RESEARCH_ONLY', releaseStatus:'research_only', classificationStatus:'experimental',
    modelVersion:'derm-local-e10f89ad2ac8',publicDeployment:false,scopeValidated:false,unsupportedValidated:false};
  if(result.ok) result.diagnostics=SCAN_CLASSES.map((row,index)=>({id:row.id,score:index?0.1/19:0.9}));
  renderResearchResult(document.getElementById('dashboardScanResult'),result);
  consolePanel.scrollTop=0;
}
document.getElementById('compare').onclick=()=>show('RESEARCH_ONLY');
document.getElementById('unsupported').onclick=()=>show('UNCERTAIN_CLASSIFICATION');
document.getElementById('invalid').onclick=()=>show('NON_SKIN_IMAGE');
document.getElementById('mobile').onclick=()=>{ consolePanel.style.width='343px'; document.querySelector('#dashboardScanResult .grid')?.style.setProperty('grid-template-columns','1fr'); };
document.getElementById('desktop').onclick=()=>{ consolePanel.style.width=''; document.querySelector('#dashboardScanResult .grid')?.style.removeProperty('grid-template-columns'); };
show('RESEARCH_ONLY');
</script></body></html>`;
http.createServer((req,res) => {
  res.setHeader('Cache-Control','no-store');
  if (req.url === '/') { res.setHeader('Content-Type','text/html; charset=utf-8'); res.end(page); }
  else if (req.url === '/scan-result.js') { res.setHeader('Content-Type','text/javascript; charset=utf-8'); res.end(fs.readFileSync(path.join(base,'scan-result.js'))); }
  else if (req.url === '/research-result.js') { res.setHeader('Content-Type','text/javascript; charset=utf-8'); res.end(fs.readFileSync(path.join(base,'research-result.js'))); }
  else { res.statusCode=404; res.end('Not found'); }
}).listen(8767,'127.0.0.1',()=>console.log('Local fixture: http://127.0.0.1:8767/'));
