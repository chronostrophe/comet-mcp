// Pure helper for selecting Perplexity's mode (Search / Research / Labs / Learn).
// The DOM has changed over time, so this implements a chain of strategies
// rather than relying on a single selector.

/** Valid mode names — also surfaced to callers. */
export type CometMode = 'search' | 'research' | 'labs' | 'learn';

export const COMET_MODES: readonly CometMode[] = ['search', 'research', 'labs', 'learn'] as const;

export const MODE_DESCRIPTIONS: Record<CometMode, string> = {
  search: 'Basic web search',
  research: 'Deep research with comprehensive analysis',
  labs: 'Analytics, visualizations, and coding',
  learn: 'Educational content and explanations',
};

/** Mode name → aria-label capitalization Perplexity's UI uses. */
export const MODE_ARIA_LABEL: Record<CometMode, string> = {
  search: 'Search',
  research: 'Research',
  labs: 'Labs',
  learn: 'Learn',
};

/**
 * Page-side JavaScript that performs the click. Returned as a string so it
 * can be embedded in `Runtime.evaluate({expression, returnByValue: true})`.
 *
 * Strategy chain (returns the first match):
 *   1. `<button aria-label="<Mode>">` (wide-screen button group)
 *   2. `<button data-state="checked">` whose text contains the mode (current)
 *   3. Open a dropdown by clicking the only `<button>` containing the mode
 *      name + an SVG (narrow-screen), then pick the matching menu item.
 *
 * Returning `{success:false, attempted:[...]}` lets the caller log which
 * strategies failed, which is gold for diagnosing UI regressions.
 */
export const SELECT_MODE_EXPRESSION = `((mode) => {
  const label = { search: 'Search', research: 'Research', labs: 'Labs', learn: 'Learn' }[mode];
  if (!label) return { success: false, error: 'invalid mode' };
  const attempted = [];

  // Strategy 1: direct button by aria-label
  let btn = document.querySelector('button[aria-label="' + label + '"]');
  if (btn) {
    btn.click();
    return { success: true, method: 'aria-label' };
  }
  attempted.push('aria-label');

  // Strategy 2: data-state=checked + text match (current Perplexity wide layout)
  btn = [...document.querySelectorAll('button[data-state="checked"]')]
    .find(b => b.innerText.toLowerCase().includes(mode));
  if (btn) {
    // Walk siblings/parents looking for a clickable mode pill.
    const siblings = btn.parentElement?.querySelectorAll('button') || [];
    const target = [...siblings].find(b => b.innerText.toLowerCase().includes(mode));
    if (target) {
      target.click();
      return { success: true, method: 'data-state-sibling' };
    }
  }
  attempted.push('data-state');

  // Strategy 3: dropdown — open the trigger then pick the item
  const triggers = [...document.querySelectorAll('button')]
    .filter(b => b.querySelector('svg') && /search|research|labs|learn/i.test(b.innerText));
  if (triggers.length > 0) {
    triggers[0].click();
    // Caller will poll for the menu; we return a hint.
    return { success: false, needsSelect: true, attempted };
  }
  attempted.push('dropdown-trigger');

  return { success: false, error: 'Mode selector not found', attempted };
})`;
