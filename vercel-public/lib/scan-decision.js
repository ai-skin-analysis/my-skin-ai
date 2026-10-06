import { SCAN_CLASSES, SCAN_MESSAGES } from '../scan-result.js';

const IDS = SCAN_CLASSES.map(item => item.id);
const fraction = value => typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 1;
const abstain = code => ({ code, message: SCAN_MESSAGES[code], candidates: [] });

// Server-side postprocessor for a future verified inference adapter.
// `policy` is release configuration, NOT request JSON. No default thresholds:
// scope/OOD and pair thresholds need validation independent of classifier scores.
// This function cannot turn the currently unavailable engine on.
export function classifyScanEvidence(evidence, policy) {
  if (policy?.deploymentApproved !== true || policy?.scopeValidated !== true || policy?.unsupportedValidated !== true ||
      !policy.modelVersion || evidence?.modelVersion !== policy.modelVersion) return abstain('MODEL_UNAVAILABLE');
  if (!['non_lesion', 'uncertain', 'skin_lesion'].includes(evidence?.content)) return abstain('INVALID_MODEL_RESULT');
  if (evidence.content === 'non_lesion') return abstain('OUT_OF_SCOPE');
  if (evidence.content === 'uncertain') return abstain('UNCERTAIN_CONTENT');
  if (['unsupported', 'uncertain'].includes(evidence.support)) return abstain('UNSUPPORTED_LESION');
  if (evidence.support !== 'supported') return abstain('INVALID_MODEL_RESULT');
  const predictions = evidence.predictions;
  if (!Array.isArray(predictions) || predictions.length !== IDS.length ||
      predictions.some((item, index) => item?.id !== IDS[index] || typeof item.score !== 'number' || !Number.isFinite(item.score) || item.score < 0 || item.score > 1) ||
      Math.abs(predictions.reduce((sum, item) => sum + item.score, 0) - 1) > 0.0001) return abstain('INVALID_MODEL_RESULT');
  const [first, second] = [...predictions].sort((a, b) => b.score - a.score);
  const margin = first.score - second.score;
  const single = policy.single;
  if (fraction(single?.minScore) && fraction(single?.minMargin) &&
      Array.isArray(single.allowedClasses) && single.allowedClasses.includes(first.id) && first.score >= single.minScore && margin >= single.minMargin) {
    return { code: 'CLASSIFIED', scope: 'supported_skin_lesion', modelVersion: policy.modelVersion, candidates: [{ id: first.id }] };
  }
  const pair = policy.comparison;
  const pairId = [first.id, second.id].sort().join('|');
  if (pair?.validated === true && fraction(pair.minCandidateScore) && fraction(pair.minPairMass) && fraction(pair.maxMargin) &&
      Array.isArray(pair.allowedPairs) && pair.allowedPairs.includes(pairId) && second.score >= pair.minCandidateScore &&
      first.score + second.score >= pair.minPairMass && margin <= pair.maxMargin) {
    return { code: 'COMPARE_SUPPORTED', scope: 'supported_skin_lesion', modelVersion: policy.modelVersion, candidates: [{ id: first.id }, { id: second.id }] };
  }
  return abstain('UNCERTAIN_CLASSIFICATION');
}
