import { countPrivateRows, selectPrivateRows } from './supabase-private.js';

// Private-storage statistics are optional, not evidence of an expired login.
// Never turn a failed lookup into a fabricated zero or expose upstream errors.
export async function adminPrivateSummary({ count = countPrivateRows, select = selectPrivateRows, timeoutMs = 10_000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const options = { signal: controller.signal };
    const results = await Promise.allSettled([
      Promise.resolve().then(() => count('smart_skin_scan_logs', '?select=id', options)),
      Promise.resolve().then(() => count('smart_skin_feedback', '?select=id', options)),
      Promise.resolve().then(() => select('smart_skin_feedback', '?select=id,user_id,message,created_at&order=created_at.desc&limit=30', options)),
    ]);
    const scans = results[0].status === 'fulfilled' && Number.isSafeInteger(results[0].value) && results[0].value >= 0 ? results[0].value : null;
    const feedbacks = results[1].status === 'fulfilled' && Number.isSafeInteger(results[1].value) && results[1].value >= 0 ? results[1].value : null;
    const feedbackRowsAvailable = results[2].status === 'fulfilled' && Array.isArray(results[2].value);
    return { scans, feedbacks, feedbackRowsAvailable,
      feedbackRows: feedbackRowsAvailable ? results[2].value : [],
      available: scans !== null && feedbacks !== null && feedbackRowsAvailable };
  } finally {
    clearTimeout(timer);
  }
}
