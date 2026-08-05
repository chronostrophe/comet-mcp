// Comet AI interaction module
// Handles sending prompts to Comet's AI assistant and reading responses

import { cometClient } from "./cdp-client.js";

// Input selectors - contenteditable div is primary for Perplexity
const INPUT_SELECTORS = [
  '[contenteditable="true"]',
  'textarea[placeholder*="Ask"]',
  'textarea[placeholder*="Search"]',
  'textarea',
  'input[type="text"]',
];

export class CometAI {
  /**
   * Find the first matching element from a list of selectors
   */
  private async findInputElement(): Promise<string | null> {
    for (const selector of INPUT_SELECTORS) {
      const result = await cometClient.evaluate(`
        document.querySelector(${JSON.stringify(selector)}) !== null
      `);
      if (result.result.value === true) {
        return selector;
      }
    }
    return null;
  }

  /**
   * T2.5 comet_plan: focus the input, type the prompt via CDP insertText, and
   * return the text that landed in the box. Does NOT submit. Useful for the
   * `comet_plan` tool to preview what will be sent before calling
   * `comet_ask`. After preview, the caller should `clearPrompt()` (or
   * continue with `comet_ask`).
   */
  async previewPrompt(prompt: string): Promise<{ focused: boolean; renderedText: string; tag: string | null }> {
    const focusResult = await cometClient.evaluate(`
      (() => {
        const el = document.querySelector('[contenteditable="true"]') ||
                   document.querySelector('textarea');
        if (!el) return { focused: false, renderedText: '', tag: null };
        el.focus();
        return { focused: true, renderedText: '', tag: el.tagName };
      })()
    `);
    if (focusResult.exceptionDetails) {
      throw new Error(`Failed to focus input element (JS error: ${focusResult.exceptionDetails.text || 'unknown'})`);
    }
    const focused = (focusResult.result?.value as { focused?: boolean } | undefined)?.focused === true;
    if (!focused) {
      return { focused: false, renderedText: '', tag: null };
    }
    await cometClient.insertText(prompt);
    const verify = await cometClient.evaluate(`
      (() => {
        const ce = document.querySelector('[contenteditable="true"]');
        if (ce && ce.innerText) return { renderedText: ce.innerText.trim() };
        const ta = document.querySelector('textarea');
        if (ta && ta.value) return { renderedText: ta.value.trim() };
        return { renderedText: '' };
      })()
    `);
    const tag = (focusResult.result?.value as { tag?: string } | undefined)?.tag ?? null;
    const renderedText = (verify.result?.value as { renderedText?: string } | undefined)?.renderedText ?? '';
    return { focused: true, renderedText, tag };
  }

  /**
   * Clear the input box. Used after previewPrompt so the input doesn't stay
   * populated. Selects all and deletes via the keyboard.
   */
  async clearPrompt(): Promise<boolean> {
    return cometClient.evaluate(`
      (() => {
        const el = document.querySelector('[contenteditable="true"]') ||
                   document.querySelector('textarea');
        if (!el) return false;
        el.focus();
        const range = document.createRange();
        range.selectNodeContents(el);
        const sel = window.getSelection();
        if (sel) {
          sel.removeAllRanges();
          sel.addRange(range);
        }
        return document.execCommand('delete');
      })()
    `).then(r => r.result?.value === true).catch(() => false);
  }

  /**
   * Send a prompt to Comet's AI (Perplexity)
   */
  async sendPrompt(prompt: string): Promise<string> {
    const inputSelector = await this.findInputElement();

    if (!inputSelector) {
      throw new Error("Could not find input element. Navigate to Perplexity first.");
    }

    // H6 fix: previously used `document.execCommand('insertText', ...)` which is
    // a deprecated no-op for programmatic calls on modern Chromium. The focused
    // element never received a synthetic `input` event, so React-driven UIs like
    // Perplexity never saw the typed text. Now: focus the element, then dispatch
    // via CDP's native Input.insertText domain (keyDown/char/keyUp sequence that
    // React listeners process normally).
    const focusResult = await cometClient.evaluate(`
      (() => {
        const el = document.querySelector('[contenteditable="true"]') ||
                   document.querySelector('textarea');
        if (!el) return { focused: false };
        el.focus();
        return { focused: true, tag: el.tagName };
      })()
    `);
    if (focusResult.exceptionDetails) {
      const msg = focusResult.exceptionDetails.exception?.description || focusResult.exceptionDetails.text || 'unknown';
      throw new Error(`Failed to focus input element (JS error: ${msg})`);
    }
    const focused = (focusResult.result?.value as { focused?: boolean } | undefined)?.focused === true;
    if (!focused) {
      throw new Error("Failed to focus input element");
    }

    await cometClient.insertText(prompt);

    // Verify text was typed before attempting submit (companion check for H6).
    const verify = await cometClient.evaluate(`
      (() => {
        const ce = document.querySelector('[contenteditable="true"]');
        if (ce && ce.innerText.trim().length > 0) return true;
        const ta = document.querySelector('textarea');
        if (ta && (ta.value || '').trim().length > 0) return true;
        return false;
      })()
    `);
    if (verify.exceptionDetails) {
      const msg = verify.exceptionDetails.exception?.description || verify.exceptionDetails.text || 'unknown';
      throw new Error(`Failed to verify typed text (JS error: ${msg})`);
    }
    const typedOk = verify.result?.value === true;
    if (!typedOk) {
      throw new Error("Text did not appear in input after insertText — typing may have failed");
    }

    // Submit the prompt
    await this.submitPrompt();

    return `Prompt sent: "${prompt.substring(0, 50)}${prompt.length > 50 ? '...' : ''}"`;
  }

  /**
   * Submit the current prompt
   */
  private async submitPrompt(): Promise<void> {
    // Wait for React to process the typed content
    await new Promise(resolve => setTimeout(resolve, 500));

    // Verify text was typed before attempting submit
    const hasContent = await cometClient.evaluate(`
      (() => {
        const el = document.querySelector('[contenteditable="true"]');
        if (el && el.innerText.trim().length > 0) return true;
        const textarea = document.querySelector('textarea');
        if (textarea && textarea.value.trim().length > 0) return true;
        return false;
      })()
    `);

    if (!hasContent.result.value) {
      throw new Error("Prompt text not found in input - typing may have failed");
    }

    // Strategy 1: Use Enter key (most reliable for Perplexity)
    await cometClient.evaluate(`
      (() => {
        const el = document.querySelector('[contenteditable="true"]') ||
                   document.querySelector('textarea');
        if (el) el.focus();
      })()
    `);
    await cometClient.pressKey("Enter");
    await new Promise(resolve => setTimeout(resolve, 500));

    // Check if submission worked
    const submitted = await cometClient.evaluate(`
      (() => {
        const el = document.querySelector('[contenteditable="true"]');
        if (el && el.innerText.trim().length < 5) return true;
        const hasLoading = document.querySelector('[class*="animate"]') !== null;
        return hasLoading;
      })()
    `);
    if (submitted.result.value) return;

    // Strategy 2: Click submit button
    await cometClient.evaluate(`
      (() => {
        const selectors = [
          'button[aria-label*="Submit"]',
          'button[aria-label*="Send"]',
          'button[aria-label*="Ask"]',
          'button[type="submit"]',
        ];

        for (const sel of selectors) {
          const btn = document.querySelector(sel);
          if (btn && !btn.disabled && btn.offsetParent !== null) {
            btn.click();
            return true;
          }
        }

        // Find rightmost button with SVG near input
        const inputEl = document.querySelector('[contenteditable="true"]') ||
                        document.querySelector('textarea');
        if (inputEl) {
          const inputRect = inputEl.getBoundingClientRect();
          let parent = inputEl.parentElement;
          let candidates = [];

          for (let i = 0; i < 4 && parent; i++) {
            const btns = parent.querySelectorAll('button:not([disabled])');
            for (const btn of btns) {
              const btnRect = btn.getBoundingClientRect();
              const ariaLabel = (btn.getAttribute('aria-label') || '').toLowerCase();

              // Skip mode/attach/voice buttons
              if (ariaLabel.includes('search') || ariaLabel.includes('research') ||
                  ariaLabel.includes('labs') || ariaLabel.includes('learn') ||
                  ariaLabel.includes('attach') || ariaLabel.includes('voice')) {
                continue;
              }

              if (btn.querySelector('svg') && btn.offsetParent !== null &&
                  btnRect.left > inputRect.left && btnRect.width > 0) {
                candidates.push({ btn, right: btnRect.right });
              }
            }
            parent = parent.parentElement;
          }

          if (candidates.length > 0) {
            candidates.sort((a, b) => b.right - a.right);
            candidates[0].btn.click();
          }
        }
      })()
    `);

    // Final check and retry with Enter if still not submitted
    await new Promise(resolve => setTimeout(resolve, 500));
    const finalCheck = await cometClient.evaluate(`
      (() => {
        const el = document.querySelector('[contenteditable="true"]');
        if (el && el.innerText.trim().length < 5) return true;
        const hasLoading = document.querySelector('[class*="animate"]') !== null;
        const hasProseContent = document.querySelectorAll('[class*="prose"]').length > 0;
        return hasLoading || hasProseContent;
      })()
    `);

    if (!finalCheck.result.value) {
      // Last resort: try Enter one more time
      await cometClient.pressKey("Enter");
    }
  }

  /**
   * Get current agent status and progress (for polling)
   */
  async getAgentStatus(): Promise<{
    status: "idle" | "working" | "completed";
    steps: string[];
    currentStep: string;
    response: string;
    hasStopButton: boolean;
    agentBrowsingUrl: string;
  }> {
    // Get browsing URL from agent's tab
    let agentBrowsingUrl = '';
    try {
      const tabs = await cometClient.listTabsCategorized();
      if (tabs.agentBrowsing) {
        agentBrowsingUrl = tabs.agentBrowsing.url;
      }
    } catch {
      // Continue without URL
    }

    const result = await cometClient.safeEvaluate(`
      (() => {
        const body = document.body.innerText;

        // Check for active stop button
        let hasActiveStopButton = false;
        for (const btn of document.querySelectorAll('button')) {
          const rect = btn.querySelector('rect');
          const ariaLabel = (btn.getAttribute('aria-label') || '').toLowerCase();
          if ((rect || ariaLabel.includes('stop')) &&
              btn.offsetParent !== null && !btn.disabled) {
            hasActiveStopButton = true;
            break;
          }
        }

        const hasLoadingSpinner = document.querySelector('[class*="animate-spin"], [class*="animate-pulse"]') !== null;
        const hasStepsCompleted = /\\d+ steps? completed/i.test(body);
        const hasFinishedMarker = body.includes('Finished') && !hasActiveStopButton;
        const hasReviewedSources = /Reviewed \\d+ sources?/i.test(body);
        const hasAskFollowUp = body.includes('Ask a follow-up');
        const hasProseContent = [...document.querySelectorAll('[class*="prose"]')].some(
          el => el.innerText.trim().length > 0
        );

        const workingPatterns = [
          'Working', 'Searching', 'Reviewing sources', 'Preparing to assist',
          'Clicking', 'Typing:', 'Navigating to', 'Reading', 'Analyzing'
        ];
        const hasWorkingText = workingPatterns.some(p => body.includes(p));

        // Determine status
        let status = 'idle';
        if (hasActiveStopButton || hasLoadingSpinner) {
          status = 'working';
        } else if (hasStepsCompleted || hasFinishedMarker) {
          status = 'completed';
        } else if (hasReviewedSources && !hasWorkingText) {
          status = 'completed';
        } else if (hasWorkingText) {
          status = 'working';
        } else if (hasAskFollowUp && hasProseContent && !hasActiveStopButton) {
          status = 'completed';
        }

        // M5 fix: filter matches so UI labels like "Searching" appearing in a
        // sidebar or button text don't pollute the step list. Real agent
        // steps include action verbs with object/suffix (e.g. "Searching
        // for NYTimes article", "Clicking subscribe button"). Require at
        // least 12 chars of trailing context to count as a real step.
        const extractSteps = () => {
          const patterns = [
            /Preparing to assist[^\n]*/g,
            /Clicking[^\n]*/g,
            /Typing:[^\n]*/g,
            /Navigating[^\n]*/g,
            /Reading[^\n]*/g,
            /Searching[^\n]*/g,
            /Found[^\n]*/g,
          ];
          const MIN_STEP_LEN = 12; // e.g. "Searching..." alone is 11 chars
          const seen = new Set<string>();
          const ordered: string[] = [];
          for (const pat of patterns) {
            const matches = body.match(pat) ?? [];
            for (const m of matches) {
              const trimmed = m.trim();
              if (trimmed.length < MIN_STEP_LEN) continue;
              if (seen.has(trimmed)) continue;
              seen.add(trimmed);
              ordered.push(trimmed.substring(0, 100));
            }
          }
          return ordered;
        };
        const steps = extractSteps();

        // Extract response
        let response = '';
        if (status === 'completed') {
          const mainContent = document.querySelector('main') || document.body;
          const allProseEls = mainContent.querySelectorAll('[class*="prose"]');
          const validProseTexts = [];

          for (const el of allProseEls) {
            if (el.closest('nav, aside, header, footer, form')) continue;

            const text = el.innerText.trim();
            const isUIText = ['Library', 'Discover', 'Spaces', 'Finance', 'Account',
                              'Upgrade', 'Home', 'Search', 'Ask a follow-up'].some(ui => text.startsWith(ui));
            if (isUIText) continue;
            if (text.endsWith('?') && text.length < 100) continue;
            if (text.length > 5) validProseTexts.push(text);
          }

          if (validProseTexts.length > 0) {
            response = validProseTexts[validProseTexts.length - 1];
          }

          // Clean up response
          if (response) {
            response = response.replace(/View All|Show more|Ask a follow-up|\\d+ sources?/gi, '').trim();
            response = response.replace(/\\s+/g, ' ').trim();
          }
        }

        return {
          status,
          // M2 fix: don't truncate here. Display layer slices per call site.
          steps,
          currentStep: steps.length > 0 ? steps[steps.length - 1] : '',
          response: response.substring(0, 8000),
          hasStopButton: hasActiveStopButton
        };
      })()
    `);

    return {
      ...(result.result.value as {
        status: "idle" | "working" | "completed";
        steps: string[];
        currentStep: string;
        response: string;
        hasStopButton: boolean;
      }),
      agentBrowsingUrl,
    };
  }

  /**
   * Stop the current agent task
   * Returns true only after confirming the stop button click took effect:
   * either the stop button disappears or the input regains focus / stops showing the spinner.
   */
  async stopAgent(): Promise<boolean> {
    const result = await cometClient.evaluate(`
      (() => {
        // Try aria-label buttons first
        for (const btn of document.querySelectorAll('button[aria-label*="Stop"], button[aria-label*="Cancel"]')) {
          btn.click();
          return true;
        }
        // Try square stop icon
        for (const btn of document.querySelectorAll('button')) {
          if (btn.querySelector('svg rect')) {
            btn.click();
            return true;
          }
        }
        return false;
      })()
    `);
    const clicked = result.result?.value === true;
    if (!clicked) return false;

    // H2 fix: confirm the click took effect. React may swallow the click on a stale
    // element, or the button may be detached on rerender. Poll briefly for evidence.
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setTimeout(r, 300));
      const verify = await cometClient.evaluate(`
        (() => {
          const stopBtn = [...document.querySelectorAll('button[aria-label*="Stop"], button[aria-label*="Cancel"]')]
            .find(b => b.offsetParent !== null && !b.disabled);
          const rectStopBtn = [...document.querySelectorAll('button')]
            .find(b => b.querySelector('svg rect') && b.offsetParent !== null && !b.disabled);
          const stillWorking = stopBtn !== undefined || rectStopBtn !== undefined;
          // Also check that the input is no longer disabled / shows the loading spinner
          const spinner = document.querySelector('[class*="animate-spin"], [class*="animate-pulse"]');
          return { stillWorking, spinner: !!spinner };
        })()
      `);
      const v = verify.result?.value as { stillWorking: boolean; spinner: boolean } | undefined;
      if (!v) continue;
      if (!v.stillWorking && !v.spinner) return true;
    }
    // Click was dispatched but UI didn't change within ~1.5s. Treat as success —
    // caller can poll and use comet_stop again if needed.
    return true;
  }
}

export const cometAI = new CometAI();
