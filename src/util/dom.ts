// DOM probing helpers for Perplexity's main search/answer UI. These return
// plain data so they're cheap to unit-test (no CDP, no DOM dependency at
// test time).

/** A piece of agent work observed on the page. */
export interface PageObservation {
  /** True if a stop/cancel button is currently visible. */
  hasStopButton: boolean;
  /** True if any loading spinner is visible. */
  hasLoadingSpinner: boolean;
  /** True if the page shows an "X steps completed" marker. */
  hasStepsCompleted: boolean;
  /** Current number of `[class*="prose"]` answer elements on the page. */
  proseCount: number;
  /** Text of the last prose element, trimmed; empty if none. */
  lastProseText: string;
  /** All prose element texts in document order, trimmed. */
  proseTexts: string[];
}
/**
 * Capture a single observation of the page state. The expression is a
 * self-invoking function that returns a JSON-serialisable object so it can
 * be evaluated in the page via `Runtime.evaluate({returnByValue:true})`
 * without bringing RemoteObject wrappers back to Node.
 */
export const OBSERVE_PAGE_EXPRESSION = `(() => {
  const body = document.body.innerText;
  const stopBtn = [...document.querySelectorAll('button[aria-label*="Stop"], button[aria-label*="Cancel"]')]
    .some(b => b.offsetParent !== null && !b.disabled);
  const loading = !!document.querySelector('[class*="animate-spin"], [class*="animate-pulse"]');
  const completed = /\\d+ steps? completed/i.test(body) || (body.includes('Finished') && !stopBtn);
  const proseEls = [...document.querySelectorAll('[class*="prose"]')]
    .filter(el => {
      if (el.closest('nav, aside, header, footer, form')) return false;
      const t = el.innerText.trim();
      if (!t) return false;
      if (['Library','Discover','Spaces','Finance','Account','Upgrade','Home','Search','Ask a follow-up']
        .some(ui => t.startsWith(ui))) return false;
      return t.length > 5;
    });
  const last = proseEls[proseEls.length - 1];
  return {
    hasStopButton: stopBtn,
    hasLoadingSpinner: loading,
    hasStepsCompleted: completed,
    proseCount: proseEls.length,
    lastProseText: last ? last.innerText.trim().substring(0, 8000) : '',
    proseTexts: proseEls.map(el => el.innerText.trim())
})()`;

/**
 * Concatenate all prose elements added since the baseline. For multi-section
 * answers (bulleted lists, tables split across siblings) the previous
 * implementation dropped everything but the last element.
 *
 * `baselineCount` is the proseCount captured BEFORE submitting the prompt.
 * We include every prose element from `baselineCount` onward whose text
 * passes the UI-text filter. Returns "" if none qualify.
 */
export function extractAnswerSince(
  currentProseTexts: string[],
  baselineCount: number,
  maxChars = 16000,
): string {
  const slice = currentProseTexts
    .slice(baselineCount)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  const joined = slice.join('\n\n').trim();
  if (joined.length <= maxChars) return joined;
  return joined.substring(0, maxChars) + '\n\n[…truncated…]';
}

/**
 * Time-based heuristic: research mode takes longer than search mode.
 * Caller can still override with an explicit `explicitMs` >= 1.
 */
export function defaultTimeoutForMode(mode: string | undefined, explicitMs?: number): number {
  if (explicitMs && explicitMs > 0) return explicitMs;
  if (mode === 'research') return 90_000;
  if (mode === 'labs') return 45_000;
  return 15_000;
}
