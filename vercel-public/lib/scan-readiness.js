// The deployed research service has a separate opt-in authenticated workflow.
// Its experimental classifier/filter do not approve a general-use release.
// Image-quality checks, environment flags and checkboxes cannot approve it.
import { SCAN_MESSAGES } from '../scan-result.js';

export function scanReadiness() {
  return {
    classificationAvailable: false,
    scopeFilterAvailable: false,
    code: 'MODEL_UNAVAILABLE',
    message: SCAN_MESSAGES.MODEL_UNAVAILABLE,
  };
}

export function requireScanEngine(res, json) {
  const readiness = scanReadiness();
  if (!readiness.classificationAvailable || !readiness.scopeFilterAvailable) {
    json(res, 503, { ok: false, ...readiness });
    return false;
  }
  return true;
}
