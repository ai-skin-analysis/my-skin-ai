// An opt-in, authenticated experiment. This deliberately never returns the
// CLASSIFIED / supported_skin_lesion public-release contract.
import { SCAN_CLASSES } from '../scan-result.js';
import { researchInferenceFromEnvironment } from './research-inference.js';
import { downloadPrivateScanObject, removePrivateObjects, upsertPrivateRow } from './supabase-private.js';

export const RESEARCH_CONSENT_VERSION = 'skin-research-20261006-v1';

export async function researchReadiness(client = researchInferenceFromEnvironment()) {
  const ready = await client.readiness();
  return { researchAvailable: ready.modelLoaded === true, releaseStatus: 'research_only',
    classCount: ready.classCount, modelVersion: ready.modelVersion,
    comparisonAvailable: ready.comparisonAvailable === true,
    classificationAvailable: false, scopeFilterAvailable: false,
    publicReleaseApproved: false, scopeValidated: false, unsupportedValidated: false };
}

export async function analyzePrivateResearchScan(pending, userId, retentionExpiresAt, {
  client = researchInferenceFromEnvironment(), download = downloadPrivateScanObject,
  remove = removePrivateObjects, save = upsertPrivateRow,
} = {}) {
  if (pending.research_consent_version !== RESEARCH_CONSENT_VERSION
      || !pending.object_path?.startsWith(`scans/${userId}/`)) {
    throw new Error('Invalid research consent or ownership');
  }
  const bytes = await download(pending.object_path, Number(pending.image_size_bytes));
  const analysis = await client.analyze(bytes, { consent: true });
  if (!analysis.ok) {
    // Rejected/uncertain images are not saved as a classified history entry.
    await remove([pending.object_path]);
    return { analysis, storedImage: false, temporaryUploadDeleted: true,
      message: analysis.message };
  }
  const ranking = [...analysis.diagnostics].sort((a, b) => b.score - a.score);
  const first = SCAN_CLASSES.find(row => row.id === ranking[0].id);
  const label = `ผลเชิงทดลอง · ${first.name} (ไม่ใช่การวินิจฉัย)`;
  // A stable server-created ID makes retry after an interrupted save idempotent.
  const saved = await save('smart_skin_scan_logs', {
    id: pending.id, user_id: Number(userId), image_object_path: pending.object_path,
    source: pending.source, original_name: pending.original_name,
    image_size_bytes: Number(pending.image_size_bytes), result_disease: label,
    confidence: null, consent_version: RESEARCH_CONSENT_VERSION,
    retention_expires_at: retentionExpiresAt, top_predictions: ranking.slice(0, 2).map(row => ({ id: row.id })),
    is_uncertain: true, decision_status: 'research_only', model_version: analysis.modelVersion,
  }, 'id');
  const scan = saved[0];
  if (!scan?.id) throw new Error('Research result was not saved');
  return { analysis, storedImage: true, scan: {
    id: scan.id, resultLabel: label, source: pending.source, originalName: pending.original_name,
    imageSizeBytes: Number(pending.image_size_bytes), createdAt: scan.created_at,
    retentionExpiresAt,
  }, message: 'วิเคราะห์เชิงทดลองและบันทึกในพื้นที่ส่วนตัวแล้ว ผลนี้อาจผิดพลาด ไม่ใช้แทนแพทย์' };
}
