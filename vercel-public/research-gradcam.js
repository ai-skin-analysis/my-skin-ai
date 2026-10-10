// Small numeric explanations only. Never load an upstream image/URL or persist
// image pixels, heatmaps or result labels in browser storage.
import { researchClassesForVersion } from './research-catalog.js';

export const GRADCAM_NOTICE = 'สีเหลือง–แดงและเครื่องหมาย + แสดงบริเวณที่มีอิทธิพลต่อคะแนนของโมเดลมาก ไม่ใช่ขอบเขตหรือตำแหน่งรอยโรคที่ยืนยันแล้ว ไม่ใช่การวินิจฉัย';

export function validatedGradcam(value, version, classId) {
  if (!value || value.contract !== 'gradcam-v1' || value.method !== 'gradcam'
      || value.modelVersion !== version || value.classId !== classId || value.clinicallyValidated !== false
      || !researchClassesForVersion(version)?.some(row => row.id === classId)) return null;
  const common = { contract: 'gradcam-v1', method: 'gradcam', modelVersion: version,
    classId, clinicallyValidated: false };
  if (value.status === 'unavailable') {
    if (!['zero_signal', 'computation_failed'].includes(value.reason) || value.values !== undefined) return null;
    return Object.freeze({ ...common, status: 'unavailable', reason: value.reason });
  }
  if (value.status !== 'available' || value.targetLayer !== 'mobilenetv2/out_relu'
      || value.scoreSpace !== 'pre_softmax_logit' || value.coordinateSpace !== 'normalized_full_image'
      || value.width !== 7 || value.height !== 7 || !Array.isArray(value.values) || value.values.length !== 49
      || value.values.some(x => typeof x !== 'number' || !Number.isFinite(x) || x < 0 || x > 1)
      || Math.max(...value.values) < .99999) return null;
  return Object.freeze({ ...common, status: 'available', targetLayer: 'mobilenetv2/out_relu',
    scoreSpace: 'pre_softmax_logit', coordinateSpace: 'normalized_full_image', width: 7, height: 7,
    values: Object.freeze([...value.values]) });
}

export function heatmapRgba(values) {
  const data = new Uint8ClampedArray(values.length * 4);
  values.forEach((v, i) => {
    // Transparent low influence -> yellow -> red. Intensity is relative to this
    // one explanation, not a probability of a disease or severity score.
    data.set([255, Math.round(255 * (1 - v)), 0, Math.round(155 * v)], i * 4);
  });
  return data;
}

export function renderGradcam(doc, explanation, { previewUrl } = {}) {
  const panel = doc.getElementById('dashboardGradcamPanel');
  const canvas = doc.getElementById('dashboardGradcamCanvas');
  const status = doc.getElementById('dashboardGradcamStatus');
  const marker = {};
  canvas._renderMarker = marker;
  canvas.width = canvas.height = 1;
  canvas.classList.add('hidden');
  panel.classList.remove('hidden');
  doc.getElementById('dashboardGradcamNotice').textContent = GRADCAM_NOTICE;
  status.textContent = 'ยังไม่มี Grad-CAM ที่คำนวณได้สำหรับผลนี้ ระบบไม่วาดตำแหน่งขึ้นมาแทน';
  if (explanation?.status !== 'available' || typeof previewUrl !== 'string' || !previewUrl.startsWith('blob:')) return;
  const ImageClass = doc.defaultView?.Image;
  if (!ImageClass || typeof canvas.getContext !== 'function') return;
  status.textContent = 'กำลังแสดงแผนที่อิทธิพลจากโมเดลจริง…';
  const image = new ImageClass();
  image.onload = () => {
    if (canvas._renderMarker !== marker) return;
    try {
      const scale = Math.min(1, 960 / Math.max(image.naturalWidth, image.naturalHeight));
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      const context = canvas.getContext('2d');
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      const heatmap = doc.createElement('canvas');
      heatmap.width = heatmap.height = 7;
      const heatContext = heatmap.getContext('2d');
      const pixels = heatContext.createImageData(7, 7);
      pixels.data.set(heatmapRgba(explanation.values));
      heatContext.putImageData(pixels, 0, 0);
      context.imageSmoothingEnabled = true;
      context.drawImage(heatmap, 0, 0, canvas.width, canvas.height);
      const index = explanation.values.indexOf(Math.max(...explanation.values));
      const x = (index % 7 + .5) / 7 * canvas.width;
      const y = (Math.floor(index / 7) + .5) / 7 * canvas.height;
      for (const [color, width] of [['#111827', 5], ['#ffffff', 2]]) {
        context.strokeStyle = color; context.lineWidth = width; context.beginPath();
        context.moveTo(x - 10, y); context.lineTo(x + 10, y);
        context.moveTo(x, y - 10); context.lineTo(x, y + 10); context.stroke();
      }
      canvas.classList.remove('hidden');
      status.textContent = 'Grad-CAM จากโมเดลจริง · + คือจุดอิทธิพลสูงสุดในแผนที่หยาบ 7 × 7 ไม่ใช่พิกัดโรคที่ยืนยัน';
    } catch {
      canvas.width = canvas.height = 1; canvas.classList.add('hidden');
      status.textContent = 'แสดง Grad-CAM ไม่สำเร็จ ระบบไม่สร้างแผนที่จำลองขึ้นมาแทน';
    }
  };
  image.onerror = () => {
    if (canvas._renderMarker === marker) status.textContent = 'อ่านภาพบนอุปกรณ์เพื่อแสดง Grad-CAM ไม่สำเร็จ';
  };
  image.src = previewUrl;
}

export function clearGradcam(doc) {
  const canvas = doc.getElementById('dashboardGradcamCanvas');
  canvas._renderMarker = null;
  canvas.width = canvas.height = 1;
  canvas.classList.add('hidden');
  doc.getElementById('dashboardGradcamPanel').classList.add('hidden');
}
