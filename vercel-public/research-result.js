import { SCAN_DISCLAIMER } from './scan-result.js';
import { validatedResearchComparison } from './research-comparison.js';
import { PAD6_CLASSES, researchClassesForVersion } from './research-catalog.js';

const FAILURES = {
  NON_SKIN_IMAGE: 'ข้อมูลภาพผิดพลาด กรุณาใช้ภาพรอยโรคผิวหนังของมนุษย์ที่เห็นชัดเจน ตัวกรองเชิงทดลองอาจผิดพลาดได้',
  UNCERTAIN_CLASSIFICATION: 'ขออภัย ระบบยังจำแนกภาพนี้ไม่ได้อย่างมั่นใจ หรืออาจเป็นรอยโรคที่เว็บยังไม่รองรับ โปรดพบแพทย์ผู้เชี่ยวชาญ',
};

export function researchResultView(result) {
  const classes = researchClassesForVersion(result?.modelVersion);
  const invalid = { code: 'INVALID_MODEL_RESULT', title: 'ยังไม่สามารถสรุปผลได้',
    message: 'ผลวิเคราะห์ไม่ครบถ้วน จึงไม่แสดงชื่อกลุ่มรอยโรค', candidates: [] };
  if (!result || result.releaseStatus !== 'research_only' || result.publicDeployment !== false
      || result.scopeValidated !== false || result.unsupportedValidated !== false
      || !classes) return invalid;
  if (result.ok === false && Object.hasOwn(FAILURES, result.code) && result.diagnostics === undefined) {
    let comparison;
    if (result.comparison !== undefined) {
      if (result.code !== 'UNCERTAIN_CLASSIFICATION' || result.classificationStatus !== 'abstained') return invalid;
      comparison = validatedResearchComparison(result.comparison, result.modelVersion);
      if (!comparison) return invalid;
    }
    return { code: result.code, title: result.code === 'NON_SKIN_IMAGE' ? 'ข้อมูลภาพผิดพลาด' : 'ยังไม่สามารถจำแนกรอยโรคได้',
      message: FAILURES[result.code], candidates: [],
      comparisonCandidates: comparison ? comparison.classIds.map(id => classes.find(item => item.id === id)) : [] };
  }
  if (result.ok !== true || result.code !== 'RESEARCH_ONLY' || result.classificationStatus !== 'experimental'
      || result.comparison !== undefined || !Array.isArray(result.diagnostics) || result.diagnostics.length !== classes.length) return invalid;
  let total = 0;
  for (const [index, row] of result.diagnostics.entries()) {
    if (row.id !== classes[index].id || !Number.isFinite(row.score) || row.score < 0 || row.score > 1) return invalid;
    total += row.score;
  }
  if (Math.abs(total - 1) > 1e-5) return invalid;
  const ranking = [...result.diagnostics].sort((a, b) => b.score - a.score);
  return { code: 'RESEARCH_ONLY', title: 'ผลวิเคราะห์และจำแนกเชิงทดลอง',
    message: 'กลุ่มอันดับแรกตามคะแนนโมเดล ไม่ใช่การยืนยันว่าคุณเป็นโรคนี้ คะแนนยังไม่ใช่ความน่าจะเป็นของโรค',
    candidates: ranking.slice(0, 2).map(row => classes.find(item => item.id === row.id)) };
}

export function renderResearchResult(container, result) {
  const view = researchResultView(result);
  const count = researchClassesForVersion(result?.modelVersion)?.length;
  const doc = container.ownerDocument;
  const node = (tag, text, css = '') => {
    const element = doc.createElement(tag); element.textContent = text; element.className = css; return element;
  };
  const card = (item, heading) => {
    const section = node('section', '', 'mt-3 rounded-2xl border border-teal-300/25 bg-slate-950/30 p-4');
    section.dataset.classId = item.id;
    section.append(node('p', heading, 'text-xs text-slate-300'), node('h4', item.name, 'mt-2 text-2xl font-extrabold text-teal-200'),
      node('p', 'คำอธิบายกลุ่มรอยโรค', 'mt-4 text-xs font-bold text-teal-100'),
      node('p', item.description, 'mt-1 text-sm leading-7 text-slate-200'),
      node('p', 'ข้อมูลประกอบการพิจารณา', 'mt-4 text-xs font-bold text-teal-100'),
      node('p', item.context, 'mt-1 text-sm leading-7 text-slate-300'));
    const link = node('a', 'อ่านคำอธิบายจากแหล่งอ้างอิง', 'mt-3 inline-block text-xs text-cyan-200 underline');
    link.href = item.source; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.referrerPolicy = 'no-referrer';
    section.append(link); return section;
  };
  container.replaceChildren(); container.dataset.resultCode = view.code;
  container.append(node('h3', view.title, 'text-base font-extrabold text-white'),
    node('p', view.message, 'mt-2 text-xs leading-relaxed text-slate-200'));
  if (view.candidates.length) {
    const primary = view.candidates[0];
    const summary = node('section', '', 'mt-5 rounded-2xl border border-teal-200/50 bg-teal-400/10 p-5');
    summary.dataset.analysisSummary = 'accepted';
    summary.append(node('p', 'ชื่อกลุ่มรอยโรคที่โมเดลจัดไว้ใกล้เคียงที่สุด', 'text-xs font-bold text-teal-100'),
      node('h4', primary.name, 'mt-2 text-3xl font-extrabold text-white'),
      node('p', 'ผลการวิเคราะห์', 'mt-4 text-sm font-bold text-teal-100'),
      node('p', `โมเดลจัดภาพนี้ไว้ใกล้เคียงกลุ่ม “${primary.name}” มากที่สุดจาก ${count} กลุ่มที่ฝึกไว้ นี่เป็นผลจัดประเภทเชิงทดลอง ไม่ยืนยันสาเหตุ ความรุนแรง หรือการเป็นโรคจากภาพเดียว`, 'mt-1 text-sm leading-7 text-slate-200'),
      node('p', 'คำแนะนำเบื้องต้น', 'mt-4 text-sm font-bold text-teal-100'),
      node('p', primary.recommendation, 'mt-1 text-sm leading-7 text-slate-200'),
      node('p', 'คำแนะนำนี้เป็นข้อมูลทั่วไปเกี่ยวกับกลุ่มดังกล่าว ไม่ใช่แผนรักษาเฉพาะบุคคล อย่าเริ่ม หยุด หรือเปลี่ยนยาจากผลนี้เพียงอย่างเดียว', 'mt-3 text-xs leading-6 text-slate-300'));
    const source = node('a', 'แหล่งอ้างอิงคำอธิบายและคำแนะนำ', 'mt-3 inline-block text-xs text-cyan-200 underline');
    source.href = primary.source; source.target = '_blank'; source.rel = 'noopener noreferrer'; source.referrerPolicy = 'no-referrer';
    summary.append(source);
    container.append(summary);
    const comparison = node('div', '', 'mt-4 grid gap-3 md:grid-cols-2');
    comparison.append(card(view.candidates[0], 'อันดับ 1 · กลุ่มที่โมเดลจัดไว้ใกล้เคียง'),
      card(view.candidates[1], 'อันดับ 2 · กลุ่มสำหรับเปรียบเทียบ'));
    container.append(comparison,
      node('p', 'ใช้เปรียบเทียบความรู้ทั่วไปเท่านั้น อันดับสองไม่ได้หมายความว่าพบรอยโรคอีกชนิด และระบบยังไม่ได้ผ่านการทดสอบการแยกรอยโรคคู่นี้', 'mt-3 text-xs leading-relaxed text-slate-300'));
  } else if (view.code === 'UNCERTAIN_CLASSIFICATION') {
    container.append(node('p', 'เหตุผลที่ยังไม่สรุปชื่อรอยโรค', 'mt-5 text-sm font-bold text-teal-100'),
      node('p', 'ประมวลผลภาพแล้ว แต่ผลยังไม่ผ่านเกณฑ์ความมั่นใจของโมเดล การส่งภาพสำเร็จจึงไม่เท่ากับจำแนกสำเร็จ ระบบไม่เดาชื่อโรคและไม่ระบุว่าเป็นรอยโรคนอกกลุ่มอย่างแน่นอน', 'mt-2 text-sm leading-7 text-slate-200'),
      node('p', 'คำแนะนำเบื้องต้น', 'mt-5 text-sm font-bold text-teal-100'),
      node('p', 'ถ้าภาพไม่ชัด ให้ถ่ายเฉพาะบริเวณรอยโรคในแสงพอดีและไม่ใช้ฟิลเตอร์ หากยังสรุปไม่ได้หรือมีข้อกังวล ให้นำภาพพร้อมประวัติอาการไปพบแพทย์ผู้เชี่ยวชาญ ไม่จำเป็นต้องรอให้สแกนผ่าน', 'mt-2 text-sm leading-7 text-slate-200'));
    if (view.comparisonCandidates.length) {
      const comparison = node('section', '', 'mt-6 rounded-2xl border border-amber-200/40 bg-slate-950/30 p-4 sm:p-5');
      comparison.dataset.educationalComparison = 'abstained';
      comparison.append(node('p', 'เปรียบเทียบประกอบเท่านั้น · ยังจำแนกไม่ได้', 'text-xs font-bold text-amber-100'),
        node('h4', '2 กลุ่มจากโมเดลสำหรับเปรียบเทียบ', 'mt-2 text-xl font-extrabold text-white'),
        node('p', `ระบบใช้ลำดับคะแนนจาก ${count} กลุ่มที่ฝึกไว้ เลือก 2 กลุ่มอันดับแรกมาให้อ่านเทียบกัน ไม่ใช่การวัดความเหมือนกับภาพฝึก และไม่ใช่การยืนยันว่าภาพนี้เป็นกลุ่มใดกลุ่มหนึ่ง`, 'mt-3 text-sm leading-7 text-slate-200'),
        node('p', 'ระบบยังบอกไม่ได้แน่นอนว่ารอยโรคนี้อยู่นอกชุดฝึกหรือไม่ ภาพของรอยโรคที่ไม่รองรับอาจถูกจัดอันดับใกล้กลุ่มที่มีอยู่ได้ ทั้งสองกลุ่มจึงอาจไม่ตรงกับภาพของคุณ', 'mt-3 text-sm leading-7 text-amber-100'));
      const grid = node('div', '', 'mt-3 grid gap-3 md:grid-cols-2');
      view.comparisonCandidates.forEach((item, index) => grid.append(card(item, `ลำดับคะแนน ${index + 1} · ข้อมูลกลุ่มที่ฝึกไว้ ไม่ใช่ผลจำแนก`)));
      comparison.append(grid,
        node('p', 'คำอธิบายเป็นข้อมูลทั่วไป ไม่ได้ยืนยันว่าพบลักษณะเหล่านี้ในภาพของคุณ ไม่ใช้เลือกยา รักษา หรือยืนยัน/ตัดโรคออก ควรพบแพทย์ผู้เชี่ยวชาญหากต้องการประเมินรอยโรค', 'mt-4 text-sm leading-7 text-amber-100'));
      container.append(comparison);
    } else {
      container.append(node('p', 'ยังไม่มีลำดับคะแนนที่ใช้เปรียบเทียบได้ จึงไม่เลือกกลุ่มขึ้นมาแทนผลที่ไม่แน่ใจ', 'mt-4 text-sm leading-7 text-slate-300'));
    }
  }
  container.append(node('p', count === 20
    ? 'ผลเก่าจากโมเดล 20 กลุ่ม: ชุดทดสอบภายในเพิ่มเติมมีตัวอย่าง 11 จาก 20 กลุ่ม ตอบถูก 112 จาก 338 ภาพ (33.1%) ไม่ใช่ผลประเมินของรุ่น 6 กลุ่ม และยังไม่พร้อมสำหรับการประเมินสุขภาพทั่วไป'
    : 'รุ่น PAD 6 กลุ่มเป็นงานทดลอง ชุดข้อมูลมีกลุ่มเมลาโนมาเพียง 52 ภาพ การทดสอบภายในไม่ใช่การประเมินอิสระทางคลินิก ผลเป็นไฝหรือกระเนื้อไม่ได้ยืนยันว่าไม่ใช่มะเร็ง และระบบอาจพลาดรอยโรคนอกขอบเขตได้', 'mt-4 rounded-xl border border-amber-200/25 bg-amber-400/10 p-3 text-xs leading-relaxed text-amber-100'),
    node('p', SCAN_DISCLAIMER, 'mt-3 text-xs leading-relaxed text-slate-300'));
  container.classList.remove('hidden');
  return view;
}

// This list describes the classifier's labels, never findings in a user's image.
export function renderModelCatalogue(container, classes = PAD6_CLASSES) {
  container.replaceChildren();
  for (const item of classes) {
    const row = container.ownerDocument.createElement('li');
    row.textContent = item.name;
    row.className = 'rounded-xl bg-white px-3 py-2 text-sm text-slate-700';
    row.dataset.classId = item.id;
    container.append(row);
  }
}

// This is a separate, owner-facing screen in the authenticated dashboard.
// It consumes an actual completion response, not query parameters, fixture
// scores, localStorage or a second inference call. Abstention remains distinct
// from an accepted experimental result.
export function completedAnalysisView(completed) {
  const view = researchResultView(completed?.analysis);
  const accepted = view.code === 'RESEARCH_ONLY';
  const uncertain = view.code === 'UNCERTAIN_CLASSIFICATION';
  if ((!accepted && !uncertain)
      || (accepted && (completed.storedImage !== true || !completed.scan?.id))
      || (uncertain && (completed.storedImage !== false || completed.temporaryUploadDeleted !== true))) {
    throw new Error('ยังไม่มีผลประมวลผลที่ตรวจสอบได้ จึงไม่เปิดหน้าผล AI');
  }
  return view;
}

export function renderAnalysisScreen(doc, completed, { imageName = '', previewUrl = '' } = {}) {
  const view = completedAnalysisView(completed);
  const accepted = view.code === 'RESEARCH_ONLY';
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
    ? 'ผลจัดกลุ่มเชิงทดลอง · ยังไม่ใช่ผลวินิจฉัย'
    : view.comparisonCandidates.length ? 'ยังไม่สามารถสรุปกลุ่ม · มีข้อมูลเปรียบเทียบเท่านั้น' : 'ประมวลผลแล้ว · ยังไม่สามารถสรุปกลุ่มได้';
  doc.getElementById('dashboardAnalysisNextMessage').textContent = accepted
    ? 'อ่านชื่อกลุ่ม ผลวิเคราะห์ และคำแนะนำเบื้องต้นข้างต้นร่วมกับประวัติอาการ นำข้อมูลไปปรึกษาแพทย์หากมีข้อกังวล อย่าใช้ผลปัญญาประดิษฐ์เลือกยาหรือรักษาด้วยตนเอง'
    : 'หากภาพไม่ชัดสามารถถ่ายใหม่ได้ แต่การถ่ายซ้ำไม่รับประกันว่าจะจำแนกได้ หากยังไม่มั่นใจหรือกังวลเกี่ยวกับรอยโรค ควรให้แพทย์ตรวจโดยตรง';
  doc.getElementById('dashboardAnalysisPrivacy').textContent = accepted
    ? 'บันทึกผลเชิงทดลองในพื้นที่ส่วนตัวตามรอบหมดอายุที่บัญชีกำหนด ลบได้จากเมนูบัญชี'
    : 'ลบภาพชั่วคราวแล้ว ไม่บันทึกเป็นผลจำแนกสำเร็จ ภาพต้นฉบับยังอยู่บนอุปกรณ์ของคุณ';
  doc.getElementById('dashboardAnalysisView').dataset.resultCode = view.code;
  doc.getElementById('dashboardScanView').classList.add('hidden');
  doc.getElementById('dashboardAnalysisView').classList.remove('hidden');
  doc.title = 'ผลวิเคราะห์และจำแนกด้วยปัญญาประดิษฐ์ | Smart Skin AI';
  doc.getElementById('dashboardAnalysisTitle').focus();
  return view;
}
