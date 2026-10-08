// A separate educational contract, never a successful classification. Shared
// by the server-side transport and the owner-facing presenter. Only curated IDs
// survive: no remote names, URLs, advice, percentages or training photos.
import { researchClassesForVersion } from './research-catalog.js';

export function validatedResearchComparison(value, modelVersion) {
  const classes = researchClassesForVersion(modelVersion);
  if (!classes) return null;
  const IDS = new Set(classes.map(item => item.id));
  if (!value || value.contract !== 'research-ranking-v1'
      || value.method !== 'classifier_score_order' || value.status !== 'educational_only'
      || value.clinicallyValidated !== false || value.modelVersion !== modelVersion
      || value.classCount !== classes.length
      || !Array.isArray(value.classIds) || value.classIds.length !== 2
      || new Set(value.classIds).size !== 2 || value.classIds.some(id => !IDS.has(id))) return null;
  return Object.freeze({ contract: 'research-ranking-v1', method: 'classifier_score_order',
    status: 'educational_only', clinicallyValidated: false, modelVersion, classCount: classes.length,
    classIds: Object.freeze([...value.classIds]) });
}
