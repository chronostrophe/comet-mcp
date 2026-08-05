import { describe, it, expect } from 'vitest';
import { extractAnswerSince, defaultTimeoutForMode } from '../../src/util/dom.js';

describe('extractAnswerSince', () => {
  it('returns empty when nothing added since baseline', () => {
    expect(extractAnswerSince(['old1', 'old2'], 2)).toBe('');
  });

  it('returns all new prose since baseline', () => {
    const texts = ['old1', 'old2', 'answer-part-a', 'answer-part-b'];
    expect(extractAnswerSince(texts, 2)).toBe('answer-part-a\n\nanswer-part-b');
  });

  it('joins with double newlines so lists stay readable', () => {
    const texts = ['intro', '- one', '- two'];
    expect(extractAnswerSince(texts, 1)).toBe('- one\n\n- two');
  });

  it('truncates past maxChars with a marker', () => {
    const long = 'x'.repeat(20000);
    const out = extractAnswerSince(['old', long], 1, 1000);
    expect(out).toContain('[…truncated…]');
    expect(out.length).toBeLessThan(long.length + 50);
  });

  it('returns full string when under cap', () => {
    const texts = ['old', 'short answer'];
    expect(extractAnswerSince(texts, 1, 1000)).toBe('short answer');
  });

  it('handles baseline greater than length (no new prose)', () => {
    expect(extractAnswerSince(['only'], 5)).toBe('');
  });

  it('trims surrounding whitespace from joined output', () => {
    const texts = ['old', '   trimmed answer   ', '   second   '];
    expect(extractAnswerSince(texts, 1)).toBe('trimmed answer\n\nsecond');
  });
});

describe('defaultTimeoutForMode', () => {
  it('uses explicit timeout when provided', () => {
    expect(defaultTimeoutForMode('search', 30_000)).toBe(30_000);
    expect(defaultTimeoutForMode(undefined, 5_000)).toBe(5_000);
  });

  it('ignores invalid explicit (0 / negative)', () => {
    expect(defaultTimeoutForMode('search', 0)).toBe(15_000);
    expect(defaultTimeoutForMode('search', -1)).toBe(15_000);
  });

  it('extends timeout for research mode', () => {
    expect(defaultTimeoutForMode('research')).toBe(90_000);
  });

  it('extends timeout for labs mode', () => {
    expect(defaultTimeoutForMode('labs')).toBe(45_000);
  });

  it('default for search and unknown modes', () => {
    expect(defaultTimeoutForMode('search')).toBe(15_000);
    expect(defaultTimeoutForMode(undefined)).toBe(15_000);
    expect(defaultTimeoutForMode('learn')).toBe(15_000);
  });
});
