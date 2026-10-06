// Server-side transport for the authenticated research service. Do not import
// this module into dashboard.js. It does NOT enable the public release gate.
import { SCAN_CLASSES } from '../scan-result.js';

const MAX_IMAGE = 8 * 1024 * 1024;
const MAX_RESPONSE = 256 * 1024;
const CLASS_IDS = SCAN_CLASSES.map(row => row.id);
const SAFE_MESSAGES = {
  MODEL_UNAVAILABLE: 'บริการวิเคราะห์ภาพยังไม่พร้อม กรุณาลองใหม่ภายหลัง',
  INVALID_MODEL_RESULT: 'ผลจากบริการโมเดลไม่ครบถ้วน จึงไม่แสดงชื่อกลุ่มรอยโรค',
  NON_SKIN_IMAGE: 'ข้อมูลภาพผิดพลาด กรุณาใช้ภาพรอยโรคผิวหนังของมนุษย์ที่เห็นชัดเจน ตัวกรองเชิงทดลองอาจผิดพลาดได้',
  UNCERTAIN_CLASSIFICATION: 'ขออภัย ระบบยังจำแนกภาพนี้ไม่ได้อย่างมั่นใจ หรืออาจอยู่นอกกลุ่มที่รองรับ โปรดพบแพทย์ผู้เชี่ยวชาญ',
  MODEL_BUSY: 'บริการกำลังประมวลผลภาพก่อนหน้า กรุณารอแล้วลองใหม่',
  RATE_LIMITED: 'มีคำขอจำนวนมาก กรุณารอแล้วลองใหม่',
};

export class InferenceServiceError extends Error {
  constructor(code = 'MODEL_UNAVAILABLE', status = 503) {
    super(SAFE_MESSAGES[code] || SAFE_MESSAGES.MODEL_UNAVAILABLE);
    this.code = code;
    this.status = status;
  }
}

function invalid() {
  throw new InferenceServiceError('INVALID_MODEL_RESULT');
}

function validateEnvelope(value, version) {
  if (!value || value.mode !== 'authenticated_research' || value.releaseStatus !== 'research_only'
      || value.publicDeployment !== false || value.scopeValidated !== false
      || value.unsupportedValidated !== false || value.imageStored !== false
      || value.imageForwarded !== false || value.modelVersion !== version) invalid();
}

function validateImageResult(value, version) {
  validateEnvelope(value, version);
  const input = value.input;
  const check = value.inputCheck;
  if (!input || input.metadataStripped !== true || !['JPEG', 'PNG', 'WEBP'].includes(input.format)
      || !Number.isInteger(input.width) || input.width < 1 || input.width > 2048
      || !Number.isInteger(input.height) || input.height < 1 || input.height > 2048
      || !Number.isFinite(value.seconds) || value.seconds < 0
      || !check || check.validated !== false
      || !['experimental_continue', 'experimental_reject'].includes(check.status)
      || !/^object-filter-[0-9a-f]{12}$/.test(check.version)
      || !Number.isFinite(check.score) || check.score < 0 || check.score > 1
      || !Number.isFinite(check.threshold) || check.threshold <= 0 || check.threshold >= 1) invalid();
}

async function readBoundedJson(response) {
  if (!response.headers.get('content-type')?.toLowerCase().startsWith('application/json')
      || Number(response.headers.get('content-length')) > MAX_RESPONSE || !response.body) invalid();
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE) {
        await reader.cancel();
        invalid();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  try { return JSON.parse(Buffer.concat(chunks, total).toString('utf8')); }
  catch { invalid(); }
}

export function createResearchInferenceClient({ url, apiKey, modelVersion, fetchImpl = globalThis.fetch }) {
  let base;
  try { base = new URL(url); } catch { throw new InferenceServiceError(); }
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash
      || base.pathname !== '/' || (base.port && base.port !== '443')
      || !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(base.hostname)
      || !/^[A-Za-z0-9_-]{43,128}$/.test(apiKey || '')
      || !/^derm-local-[0-9a-f]{12}$/.test(modelVersion || '') || typeof fetchImpl !== 'function') {
    throw new InferenceServiceError();
  }

  async function call(path, body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120_000);
    try {
      const response = await fetchImpl(new URL(path, base), {
        method: body ? 'POST' : 'GET', redirect: 'manual', signal: controller.signal,
        headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json',
          ...(body ? { 'Content-Type': 'application/octet-stream', 'X-Image-Consent': 'yes' } : {}) },
        ...(body ? { body } : {}),
      });
      // Never follow redirects with the credential, nor reflect remote HTML,
      // stack traces, or user-controlled descriptions back to a browser.
      if (![200, 422].includes(response.status)) {
        await response.body?.cancel();
        const code = response.status === 409 ? 'MODEL_BUSY' : response.status === 429 ? 'RATE_LIMITED' : 'MODEL_UNAVAILABLE';
        throw new InferenceServiceError(code, [409, 429].includes(response.status) ? response.status : 503);
      }
      const value = await readBoundedJson(response);
      return { value, status: response.status };
    } catch (error) {
      if (error instanceof InferenceServiceError) throw error;
      throw new InferenceServiceError();
    } finally { clearTimeout(timer); }
  }

  return Object.freeze({
    async readiness() {
      const { value, status } = await call('/v1/readiness');
      validateEnvelope(value, modelVersion);
      if (status !== 200 || value.ok !== true || value.modelLoaded !== true || value.classCount !== 20
          || !Array.isArray(value.classIds) || value.classIds.length !== 20
          || value.classIds.some((id, index) => id !== CLASS_IDS[index])
          || value.objectFilterAvailable !== true || value.objectFilterStatus !== 'experimental'
          || value.uncertaintyAbstentionAvailable !== true) invalid();
      return Object.freeze({ modelLoaded: true, modelVersion, classCount: 20,
        releaseStatus: 'research_only', scopeValidated: false, unsupportedValidated: false,
        publicDeployment: false, imageStored: false });
    },
    async analyze(bytes, { consent } = {}) {
      if (consent !== true || !Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > MAX_IMAGE) {
        throw new InferenceServiceError('MODEL_UNAVAILABLE', 400);
      }
      const { value, status } = await call('/v1/analyze', bytes);
      validateImageResult(value, modelVersion);
      if (status === 422) {
        const object = value.code === 'NON_SKIN_IMAGE' && value.inputCheck.status === 'experimental_reject'
          && value.analysisStatus === 'input_rejected' && value.classificationStatus === 'not_run';
        const uncertain = value.code === 'UNCERTAIN_CLASSIFICATION' && value.inputCheck.status === 'experimental_continue'
          && value.analysisStatus === 'completed' && value.classificationStatus === 'abstained';
        if (value.ok !== false || (!object && !uncertain) || value.diagnostics !== undefined) invalid();
        return Object.freeze({ ok: false, code: value.code, message: SAFE_MESSAGES[value.code],
          releaseStatus: 'research_only', publicDeployment: false, scopeValidated: false,
          unsupportedValidated: false, imageStored: false, modelVersion });
      }
      if (value.ok !== true || value.code !== 'RESEARCH_ONLY' || value.analysisStatus !== 'completed'
          || value.classificationStatus !== 'experimental' || value.inputCheck.status !== 'experimental_continue'
          || !Array.isArray(value.diagnostics) || value.diagnostics.length !== 20) invalid();
      let mass = 0;
      const diagnostics = value.diagnostics.map((row, index) => {
        if (row.id !== CLASS_IDS[index] || typeof row.score !== 'number' || !Number.isFinite(row.score)
            || row.score < 0 || row.score > 1) invalid();
        mass += row.score;
        return Object.freeze({ id: row.id, score: row.score });
      });
      if (Math.abs(mass - 1) > 1e-5) invalid();
      return Object.freeze({ ok: true, code: 'RESEARCH_ONLY', modelVersion,
        releaseStatus: 'research_only', classificationStatus: 'experimental',
        scopeValidated: false, unsupportedValidated: false, publicDeployment: false,
        imageStored: false, diagnostics: Object.freeze(diagnostics) });
    },
  });
}

export function researchInferenceFromEnvironment(env = process.env) {
  return createResearchInferenceClient({ url: env.SMART_SKIN_INFERENCE_URL,
    apiKey: env.SMART_SKIN_INFERENCE_API_KEY, modelVersion: env.SMART_SKIN_INFERENCE_VERSION });
}
