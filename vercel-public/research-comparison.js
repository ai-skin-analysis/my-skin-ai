// A separate educational contract, never a successful classification. Shared
// by the server-side transport and the owner-facing presenter. Only curated IDs
// survive: no remote names, URLs, advice, percentages or training photos.
import { SCAN_CLASSES } from './scan-result.js';

const IDS = new Set(SCAN_CLASSES.map(item => item.id));

export function validatedResearchComparison(value, modelVersion) {
  if (!value || value.contract !== 'research-ranking-v1'
      || value.method !== 'classifier_score_order' || value.status !== 'educational_only'
      || value.clinicallyValidated !== false || value.modelVersion !== modelVersion
      || !/^derm-local-[0-9a-f]{12}$/.test(modelVersion || '') || value.classCount !== 20
      || !Array.isArray(value.classIds) || value.classIds.length !== 2
      || new Set(value.classIds).size !== 2 || value.classIds.some(id => !IDS.has(id))) return null;
  return Object.freeze({ contract: 'research-ranking-v1', method: 'classifier_score_order',
    status: 'educational_only', clinicallyValidated: false, modelVersion, classCount: 20,
    classIds: Object.freeze([...value.classIds]) });
}
