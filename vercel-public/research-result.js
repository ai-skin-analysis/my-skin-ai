import { SCAN_CLASSES, SCAN_DISCLAIMER } from './scan-result.js';

const FAILURES = {
  NON_SKIN_IMAGE: 'ข้อมูลภาพผิดพลาด กรุณาใช้ภาพรอยโรคผิวหนังของมนุษย์ที่เห็นชัดเจน ตัวกรองเชิงทดลองอาจผิดพลาดได้',
  UNCERTAIN_CLASSIFICATION: 'ขออภัย ระบบยังจำแนกภาพนี้ไม่ได้อย่างมั่นใจ หรืออาจเป็นรอยโรคที่เว็บยังไม่รองรับ โปรดพบแพทย์ผู้เชี่ยวชาญ',
};

export function researchResultView(result) {
  const invalid = { code: 'INVALID_MODEL_RESULT', title: 'ยังไม่สามารถสรุปผลได้',
    message: 'ผลวิเคราะห์ไม่ครบถ้วน จึงไม่แสดงชื่อกลุ่มรอยโรค', candidates: [] };
  if (!result || result.releaseStatus !== 'research_only' || result.publicDeployment !== false
      || result.scopeValidated !== false || result.unsupportedValidated !== false
      || !/^derm-local-[0-9a-f]{12}$/.test(result.modelVersion || '')) return invalid;
  if (result.ok === false && Object.hasOwn(FAILURES, result.code) && result.diagnostics === undefined) {
    return { code: result.code, title: result.code === 'NON_SKIN_IMAGE' ? 'ข้อมูลภาพผิดพลาด' : 'ยังไม่สามารถจำแนกรอยโรคได้',
      message: FAILURES[result.code], candidates: [] };
  }
  if (result.ok !== true || result.code !== 'RESEARCH_ONLY' || result.classificationStatus !== 'experimental'
      || result.diagnostics?.length !== 20) return invalid;
  let total = 0;
  for (const [index, row] of result.diagnostics.entries()) {
    if (row.id !== SCAN_CLASSES[index].id || !Number.isFinite(row.score) || row.score < 0 || row.score > 1) return invalid;
    total += row.score;
  }
  if (Math.abs(total - 1) > 1e-5) return invalid;
  const ranking = [...result.diagnostics].sort((a, b) => b.score - a.score);
  return { code: 'RESEARCH_ONLY', title: 'ผลวิเคราะห์และจำแนกเชิงทดลอง',
    message: 'กลุ่มอันดับแรกตามคะแนนโมเดล ไม่ใช่การยืนยันว่าคุณเป็นโรคนี้ คะแนนยังไม่ใช่ความน่าจะเป็นของโรค',
    candidates: ranking.slice(0, 2).map(row => SCAN_CLASSES.find(item => item.id === row.id)) };
}

export function renderResearchResult(container, result) {
  const view = researchResultView(result);
  const doc = container.ownerDocument;
  const node = (tag, text, css = '') => {
    const element = doc.createElement(tag); element.textContent = text; element.className = css; return element;
  };
  const card = (item, heading) => {
    const section = node('section', '', 'mt-3 rounded-2xl border border-teal-300/25 bg-slate-950/30 p-4');
    section.append(node('p', heading, 'text-xs text-slate-300'), node('h4', item.name, 'mt-1 font-bold text-teal-200'),
      node('p', item.description, 'mt-2 text-xs leading-relaxed text-slate-200'),
      node('p', item.context, 'mt-2 text-xs leading-relaxed text-slate-300'));
    const link = node('a', 'อ่านคำอธิบายจากแหล่งอ้างอิง', 'mt-3 inline-block text-xs text-cyan-200 underline');
    link.href = item.source; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.referrerPolicy = 'no-referrer';
    section.append(link); return section;
  };
  container.replaceChildren(); container.dataset.resultCode = view.code;
  container.append(node('h3', view.title, 'text-base font-extrabold text-white'),
    node('p', view.message, 'mt-2 text-xs leading-relaxed text-slate-200'));
  if (view.candidates.length) {
    const comparison = node('div', '', 'mt-4 grid gap-3 md:grid-cols-2');
    comparison.append(card(view.candidates[0], 'อันดับ 1 · กลุ่มที่โมเดลจัดไว้ใกล้เคียง'),
      card(view.candidates[1], 'อันดับ 2 · กลุ่มสำหรับเปรียบเทียบ'));
    container.append(comparison,
      node('p', 'ใช้เปรียบเทียบความรู้ทั่วไปเท่านั้น อันดับสองไม่ได้หมายความว่าพบรอยโรคอีกชนิด และระบบยังไม่ได้ผ่านการทดสอบการแยกรอยโรคคู่นี้', 'mt-3 text-xs leading-relaxed text-slate-300'));
  }
  container.append(node('p', 'รุ่นทดลองยังไม่พร้อมสำหรับการประเมินสุขภาพทั่วไป ผลทดสอบภายในชุดเพิ่มเติมถูก 112 จาก 338 ภาพ (33.1%) และครอบคลุมเพียง 11 กลุ่ม จึงอาจจำแนกผิดหรือพลาดรอยโรคนอกขอบเขตได้', 'mt-4 rounded-xl border border-amber-200/25 bg-amber-400/10 p-3 text-xs leading-relaxed text-amber-100'),
    node('p', SCAN_DISCLAIMER, 'mt-3 text-xs leading-relaxed text-slate-300'));
  container.classList.remove('hidden');
  return view;
}

// This is a separate, owner-facing screen in the authenticated dashboard.
// It consumes an actual completion response, not query parameters, fixture
// scores, localStorage or a second inference call. Abstention remains distinct
// from an accepted experimental result.
export function renderAnalysisScreen(doc, completed, { imageName = '', previewUrl = '' } = {}) {
  const view = researchResultView(completed?.analysis);
  const accepted = view.code === 'RESEARCH_ONLY';
  const uncertain = view.code === 'UNCERTAIN_CLASSIFICATION';
  if ((!accepted && !uncertain)
      || (accepted && (completed.storedImage !== true || !completed.scan?.id))
      || (uncertain && (completed.storedImage !== false || completed.temporaryUploadDeleted !== true))) {
    throw new Error('ยังไม่มีผลประมวลผลที่ตรวจสอบได้ จึงไม่เปิดหน้าผล AI');
  }
  renderResearchResult(doc.getElementById('dashboardAnalysisResult'), completed.analysis);
  const image = doc.getElementById('dashboardAnalysisImage');
  // The preview is the existing local object URL, never a browser-supplied
  // external URL or a new public/signed link to private storage.
  image.removeAttribute('src');
  image.classList.add('hidden');
  if (typeof previewUrl === 'string' && previewUrl.startsWith('blob:')) {
    image.src = previewUrl;
    image.classList.remove('hidden');
  }
  doc.getElementById('dashboardAnalysisImageName').textContent = imageName;
  doc.getElementById('dashboardAnalysisModel').textContent = completed.analysis.modelVersion;
  const created = new Date(completed.scan?.createdAt || Date.now());
  doc.getElementById('dashboardAnalysisTime').textContent = Number.isNaN(created.getTime()) ? 'ไม่ได้ระบุเวลา'
    : new Intl.DateTimeFormat('th-TH', { dateStyle: 'medium', timeStyle: 'short' }).format(created);
  doc.getElementById('dashboardAnalysisStatus').textContent = accepted
    ? 'ผลจัดกลุ่มเชิงทดลอง · ยังไม่ใช่ผลวินิจฉัย' : 'ประมวลผลแล้ว · ยังไม่สามารถสรุปกลุ่มได้';
  doc.getElementById('dashboardAnalysisPrivacy').textContent = accepted
    ? 'บันทึกผลเชิงทดลองในพื้นที่ส่วนตัวตามรอบหมดอายุที่บัญชีกำหนด ลบได้จากเมนูบัญชี'
    : 'ลบภาพชั่วคราวแล้ว ไม่บันทึกเป็นผลจำแนกสำเร็จ ภาพต้นฉบับยังอยู่บนอุปกรณ์ของคุณ';
  doc.getElementById('dashboardAnalysisView').dataset.resultCode = view.code;
  doc.getElementById('dashboardScanView').classList.add('hidden');
  doc.getElementById('dashboardAnalysisView').classList.remove('hidden');
  doc.title = 'ผลวิเคราะห์และจำแนกโดย AI | Smart Skin AI';
  doc.getElementById('dashboardAnalysisTitle').focus();
  return view;
}
