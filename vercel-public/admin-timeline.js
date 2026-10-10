(() => {
  // Health data lives only in this open view, never localStorage/sessionStorage.
  const PAGE_SIZE = 10;
  const records = new Map();
  let generation = 0, controller, cursor = null, nextCursor = null, busy = false;
  let lastUsers = [], presenterPromise;
  const el = id => document.getElementById(id);
  const node = (tag, text = '', css = '') => {
    const value = document.createElement(tag); value.textContent = text; value.className = css; return value;
  };
  const date = value => {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? 'ไม่ทราบเวลา' : new Intl.DateTimeFormat('th-TH', { dateStyle: 'medium', timeStyle: 'short' }).format(parsed);
  };
  const modules = () => presenterPromise ||= Promise.all([import('./research-result.js'), import('./research-gradcam.js')]);

  function clearPicture(card) {
    card.imageController?.abort(); card.imageController = null;
    card.image.removeAttribute('src');
    if (card.url) URL.revokeObjectURL(card.url);
    card.url = null;
    card.canvas._renderMarker = null; card.canvas.width = card.canvas.height = 1;
    card.canvas.classList.add('hidden');
    card.gradcam.classList.add('hidden');
  }

  function clearRecords() {
    for (const card of records.values()) clearPicture(card);
    records.clear(); el('adminTimelineList').replaceChildren();
  }

  function stopRequest() {
    generation++; controller?.abort(); controller = null; busy = false;
    el('adminTimelineRefresh').disabled = false;
  }

  function closeHistory() {
    stopRequest(); clearRecords(); cursor = nextCursor = null;
    el('adminTimelineUser').value = '';
    el('adminTimelineNext').classList.add('hidden');
    el('adminTimelineStatus').textContent = 'ปิดประวัติแล้ว เลือกผู้ใช้เพื่อเปิดรายการที่ยังยินยอมแชร์';
  }

  async function loadPicture(card, row, revision) {
    if (card.url || card.imageController) return;
    const abort = new AbortController(); card.imageController = abort;
    const timer = setTimeout(() => abort.abort(), 25_000);
    card.imageStatus.textContent = 'กำลังตรวจสิทธิ์และโหลดภาพส่วนตัว…';
    try {
      // Exact same-origin route only; never accept an upstream signed URL.
      const expected = `/api/admin/shared-image?userId=${row.userId}&scanId=${row.id}`;
      if (row.imageUrl !== expected) throw new Error('image-route');
      const response = await fetch(expected, { credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: abort.signal });
      if (!response.ok || !['image/jpeg', 'image/png', 'image/webp'].includes(response.headers.get('Content-Type')?.split(';')[0])
          || Number(response.headers.get('Content-Length')) > 8 * 1024 * 1024) throw new Error('image-unavailable');
      const blob = await response.blob();
      if (blob.size <= 0 || blob.size > 8 * 1024 * 1024) throw new Error('image-size');
      if (abort.signal.aborted || revision !== generation || records.get(row.id) !== card || !card.details.open) return;
      const [result, gradcam] = await modules();
      if (abort.signal.aborted || revision !== generation || records.get(row.id) !== card || !card.details.open) return;
      card.url = URL.createObjectURL(blob); card.image.src = card.url;
      card.imageStatus.textContent = 'ภาพของรายการที่ผู้ใช้ยินยอมแชร์ · ห้ามเผยแพร่ต่อ';
      const explanation = result.researchResultView(row.analysis).explanation;
      // Reuse the exact owner renderer and the real stored numeric explanation.
      // No coordinates or heatmap are generated from labels or mock values here.
      gradcam.renderGradcam({ defaultView: document.defaultView,
        createElement: tag => document.createElement(tag),
        getElementById: id => ({ dashboardGradcamPanel: card.gradcam, dashboardGradcamCanvas: card.canvas,
          dashboardGradcamStatus: card.camStatus, dashboardGradcamNotice: card.camNotice })[id] }, explanation, { previewUrl: card.url });
    } catch {
      if (revision === generation && records.get(row.id) === card && card.details.open && card.imageController === abort) {
        clearPicture(card);
        card.imageStatus.textContent = 'ยังเปิดภาพไม่ได้ หรือสิทธิ์ถูกถอน/หมดอายุ กรุณาโหลดประวัติใหม่ ระบบไม่สร้างภาพหรือ Grad-CAM ขึ้นมาแทน';
      }
    } finally {
      clearTimeout(timer);
      if (card.imageController === abort) card.imageController = null;
    }
  }

  function createRecord(row, presenter) {
    const view = presenter.researchResultView(row.analysis);
    if (view.code !== 'RESEARCH_ONLY') return null;
    const article = node('article', '', 'relative rounded-2xl border border-teal-100 bg-white p-4 shadow-sm sm:p-6');
    article.dataset.scanId = row.id;
    const header = node('div', '', 'flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 pb-4');
    const heading = node('div');
    const time = node('time', date(row.createdAt), 'text-xs font-bold text-teal-700'); time.dateTime = row.createdAt;
    heading.append(time, node('h3', `ผลเชิงทดลอง · ${view.candidates[0].name}`, 'mt-2 text-lg font-extrabold text-slate-900'),
      node('p', `${row.source === 'camera' ? 'ถ่ายภาพ' : 'อัปโหลด'} · ${row.originalName || 'ภาพผิวหนัง'}`, 'mt-2 break-words text-xs text-slate-500'));
    header.append(heading, node('span', 'ผู้ใช้ยินยอมแชร์', 'rounded-full bg-teal-50 px-3 py-1.5 text-xs font-bold text-teal-800'));
    const meta = node('p', `ยินยอม ${date(row.consentedAt)} · หมดอายุ ${date(row.retentionExpiresAt)} · ${row.analysis.modelVersion}`, 'mt-3 break-words text-xs leading-6 text-slate-500');
    const details = node('details', '', 'mt-4');
    details.append(node('summary', 'ดูภาพ ผลวิเคราะห์ คำแนะนำ และ Grad-CAM', 'cursor-pointer rounded-xl bg-teal-50 px-4 py-3 text-sm font-bold text-teal-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-teal-700'));
    const grid = node('div', '', 'mt-4 grid items-start gap-4 lg:grid-cols-3');
    const pictures = node('div', '', 'space-y-3');
    const image = node('img', '', 'max-h-80 w-full rounded-xl border border-slate-200 object-contain');
    image.alt = 'ภาพส่วนตัวที่ผู้ใช้ยินยอมให้ผู้ดูแลดู'; image.referrerPolicy = 'no-referrer';
    const imageStatus = node('p', '', 'text-xs leading-6 text-slate-500');
    const gradcam = node('section', '', 'hidden rounded-xl border border-amber-200 bg-amber-50 p-3');
    const canvas = node('canvas', '', 'hidden mt-3 h-auto w-full rounded-xl');
    const camStatus = node('p', '', 'mt-2 text-xs leading-6 text-slate-700');
    const camNotice = node('p', '', 'mt-2 text-xs leading-6 text-amber-900');
    gradcam.append(node('h4', 'Grad-CAM · แผนที่อิทธิพล', 'text-sm font-bold text-slate-900'), camStatus, canvas, camNotice);
    pictures.append(image, imageStatus, gradcam);
    const analysis = node('div', '', 'rounded-2xl bg-slate-900 p-4 lg:col-span-2');
    presenter.renderResearchResult(analysis, row.analysis);
    grid.append(pictures, analysis); details.append(grid); article.append(header, meta, details);
    const card = { article, details, image, imageStatus, gradcam, canvas, camStatus, camNotice, row,
      fingerprint: JSON.stringify(row) };
    details.addEventListener('toggle', () => {
      if (details.open) loadPicture(card, row, generation);
      else clearPicture(card);
    });
    return card;
  }

  async function loadHistory(page = cursor) {
    const userId = el('adminTimelineUser').value;
    if (!/^[1-9]\d{0,14}$/.test(userId) || document.hidden || busy) return;
    busy = true;
    const revision = generation;
    const abort = new AbortController(); controller = abort;
    const timer = setTimeout(() => abort.abort(), 20_000);
    el('adminTimelineRefresh').disabled = true;
    el('adminTimelineStatus').textContent = 'กำลังตรวจสิทธิ์และโหลดรายการที่ยินยอมแชร์…';
    try {
      const [presenter] = await modules();
      if (abort.signal.aborted || revision !== generation) return;
      const response = await fetch(`/api/admin/shared-history?userId=${userId}${page ? `&cursor=${encodeURIComponent(page)}` : ''}`,
        { credentials: 'same-origin', cache: 'no-store', signal: abort.signal });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.ok !== true) {
        const error = new Error(data.code === 'mfa_required' ? 'กรุณาเข้าสู่ระบบและยืนยัน MFA ของผู้ดูแลก่อนดูภาพและประวัติ' : 'ยังโหลดประวัติไม่ได้ กรุณาตรวจเซสชันและลองใหม่');
        throw error;
      }
      if (abort.signal.aborted || revision !== generation || el('adminTimelineUser').value !== userId) return;
      if (!Array.isArray(data.history) || data.history.length > PAGE_SIZE) throw new Error('รูปแบบประวัติไม่ถูกต้อง');
      const rows = data.history.filter(row => String(row.userId) === userId
        && typeof row.id === 'string' && /^[0-9a-f-]{36}$/.test(row.id)
        && Date.parse(row.retentionExpiresAt) > Date.now());
      const keep = new Set();
      for (const row of rows) {
        let card = records.get(row.id);
        if (card && card.fingerprint !== JSON.stringify(row)) { clearPicture(card); card.article.remove(); records.delete(row.id); card = null; }
        if (!card) { card = createRecord(row, presenter); if (card) records.set(row.id, card); }
        if (card) { keep.add(row.id); el('adminTimelineList').append(card.article); }
      }
      for (const [id, card] of records) if (!keep.has(id)) { clearPicture(card); card.article.remove(); records.delete(id); }
      cursor = page;
      nextCursor = typeof data.nextCursor === 'string' && /^[\w-]{1,180}$/.test(data.nextCursor) ? data.nextCursor : null;
      el('adminTimelineNext').classList.toggle('hidden', !nextCursor);
      el('adminTimelineStatus').textContent = keep.size
        ? `แสดง ${keep.size} รายการในหน้านี้ · เรียงจากล่าสุด · ตรวจสิทธิ์ล่าสุด ${date(new Date())} · โหลดประวัติใหม่เพื่อกลับรายการล่าสุด`
        : 'ยังไม่มีรายการที่ยินยอมแชร์ในหน้านี้ ประวัติส่วนตัวเดิม รายการที่ถอนการแชร์ หรือหมดอายุจะไม่แสดง';
    } catch (error) {
      if (revision !== generation) return;
      clearRecords(); nextCursor = null; el('adminTimelineNext').classList.add('hidden');
      el('adminTimelineStatus').textContent = error.message || 'ยังโหลดประวัติไม่ได้ กรุณาลองใหม่';
    } finally {
      clearTimeout(timer);
      if (revision === generation) { busy = false; controller = null; el('adminTimelineRefresh').disabled = false; }
    }
  }

  window.setAdminTimelineUsers = users => {
    lastUsers = users;
    const select = el('adminTimelineUser');
    if (!select) return;
    const selected = select.value;
    select.replaceChildren();
    const first = node('option', 'เลือกบัญชีเพื่อดูประวัติที่ยินยอมแชร์'); first.value = ''; select.append(first);
    for (const user of users) {
      const option = node('option', `#${user.id} · ${user.name} · ${user.email}`); option.value = String(user.id); select.append(option);
    }
    if (users.some(user => String(user.id) === selected)) select.value = selected;
    else if (selected) closeHistory();
  };
  window.openAdminTimelineUser = userId => {
    if (!lastUsers.some(user => String(user.id) === String(userId))) return;
    stopRequest(); clearRecords(); cursor = nextCursor = null;
    el('adminTimelineUser').value = String(userId);
    el('adminUserTimeline').scrollIntoView({ behavior: 'smooth', block: 'start' });
    el('adminTimelineUser').focus(); loadHistory(null);
  };
  document.addEventListener('DOMContentLoaded', () => {
    el('adminTimelineUser').addEventListener('change', () => {
      if (!el('adminTimelineUser').value) return closeHistory();
      stopRequest(); clearRecords(); cursor = nextCursor = null;
      el('adminTimelineNext').classList.add('hidden'); loadHistory(null);
    });
    el('adminTimelineRefresh').addEventListener('click', () => { stopRequest(); clearRecords(); cursor = nextCursor = null; loadHistory(null); });
    el('adminTimelineClose').addEventListener('click', closeHistory);
    el('adminTimelineNext').addEventListener('click', () => { if (busy || !nextCursor) return; const page = nextCursor; stopRequest(); clearRecords(); loadHistory(page); });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) { stopRequest(); clearRecords(); }
      else loadHistory(cursor);
    });
    window.addEventListener('pagehide', () => { stopRequest(); clearRecords(); });
    setInterval(() => loadHistory(cursor), 30_000);
  });
})();
