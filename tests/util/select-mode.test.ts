import { describe, it, expect } from 'vitest';
import {
  COMET_MODES,
  MODE_ARIA_LABEL,
  MODE_DESCRIPTIONS,
  SELECT_MODE_EXPRESSION,
  type CometMode,
} from '../../src/util/select-mode.js';

describe('COMET_MODES', () => {
  it('lists all four Perplexity modes in canonical order', () => {
    expect([...COMET_MODES]).toEqual(['search', 'research', 'labs', 'learn']);
  });
});

describe('MODE_ARIA_LABEL', () => {
  it('capitalizes each mode for the aria-label lookup', () => {
    expect(MODE_ARIA_LABEL.search).toBe('Search');
    expect(MODE_ARIA_LABEL.research).toBe('Research');
    expect(MODE_ARIA_LABEL.labs).toBe('Labs');
    expect(MODE_ARIA_LABEL.learn).toBe('Learn');
  });

  it('has an entry for every mode', () => {
    for (const m of COMET_MODES) {
      expect(MODE_ARIA_LABEL[m]).toBeTruthy();
    }
  });
});

describe('MODE_DESCRIPTIONS', () => {
  it('has a description for every mode', () => {
    for (const m of COMET_MODES) {
      expect(MODE_DESCRIPTIONS[m]).toBeTruthy();
      expect(MODE_DESCRIPTIONS[m].length).toBeGreaterThan(10);
    }
  });

  it('distinguishes research from search by mentioning depth', () => {
    expect(MODE_DESCRIPTIONS.research.toLowerCase()).toMatch(/deep|research|comprehensive/);
    expect(MODE_DESCRIPTIONS.search.toLowerCase()).toMatch(/basic|search|web/);
  });
});

describe('SELECT_MODE_EXPRESSION', () => {
  it('is a non-empty function expression', () => {
    expect(SELECT_MODE_EXPRESSION.length).toBeGreaterThan(50);
    expect(SELECT_MODE_EXPRESSION.trim().startsWith('(')).toBe(true);
  });

  it('mentions all four modes (case-insensitive)', () => {
    for (const m of COMET_MODES) {
      expect(SELECT_MODE_EXPRESSION.toLowerCase()).toContain(m);
    }
  });

  it('mentions all three strategy names for diagnostics', () => {
    expect(SELECT_MODE_EXPRESSION).toContain('aria-label');
    expect(SELECT_MODE_EXPRESSION).toContain('data-state');
    expect(SELECT_MODE_EXPRESSION).toContain('dropdown');
  });
});

describe('CometMode type', () => {
  it('is the union of the four modes', () => {
    const modes: CometMode[] = ['search', 'research', 'labs', 'learn'];
    expect(modes).toEqual([...COMET_MODES]);
  });
});
