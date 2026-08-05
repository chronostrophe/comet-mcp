import { describe, it, expect } from 'vitest';
import {
  normalize,
  fingerprint,
  textSimilarity,
  findDuplicate,
} from '../../src/util/prompt-fingerprint.js';

describe('normalize', () => {
  it('lowercases the input', () => {
    expect(normalize('HELLO World')).toBe('hello world');
  });

  it('strips punctuation and symbols, keeping only [a-z0-9 ]', () => {
    expect(normalize('Hello, World!')).toBe('hello world');
    expect(normalize('a-b/c?d.e')).toBe('a b c d e');
    expect(normalize('price: $42.99')).toBe('price 42 99');
  });

  it('collapses runs of whitespace into a single space', () => {
    expect(normalize('hello   world')).toBe('hello world');
    expect(normalize('a\n\tb  c')).toBe('a b c');
  });

  it('trims leading and trailing whitespace', () => {
    expect(normalize('   hello world   ')).toBe('hello world');
  });

  it('returns an empty string when input has no alphanumeric content', () => {
    expect(normalize('!!!---???')).toBe('');
    expect(normalize('   ')).toBe('');
    expect(normalize('')).toBe('');
  });

  it('preserves digits as content', () => {
    expect(normalize('Order #12345 placed')).toBe('order 12345 placed');
  });
});

describe('fingerprint', () => {
  it('produces identical hashes for identical strings', () => {
    expect(fingerprint('hello world')).toBe(fingerprint('hello world'));
  });

  it('produces identical hashes regardless of case', () => {
    expect(fingerprint('Hello World')).toBe(fingerprint('hello world'));
    expect(fingerprint('HELLO WORLD')).toBe(fingerprint('hello world'));
  });

  it('produces identical hashes regardless of whitespace differences', () => {
    expect(fingerprint('hello   world')).toBe(fingerprint('hello world'));
    expect(fingerprint('  hello world  ')).toBe(fingerprint('hello world'));
  });

  it('produces identical hashes regardless of punctuation', () => {
    expect(fingerprint('Hello, World!')).toBe(fingerprint('hello world'));
    expect(fingerprint('hello... world?!')).toBe(fingerprint('hello world'));
  });

  it('returns a 64-char lowercase hex SHA-256 digest', () => {
    const fp = fingerprint('test prompt');
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
  });

  it('produces different hashes for meaningfully different prompts', () => {
    expect(fingerprint('cats are great')).not.toBe(fingerprint('dogs are great'));
  });
});

describe('textSimilarity', () => {
  it('returns 1 for identical strings', () => {
    expect(textSimilarity('hello world', 'hello world')).toBe(1);
  });

  it('returns 1 for strings that only differ in case / whitespace / punctuation', () => {
    expect(textSimilarity('Hello, World!', 'hello world')).toBe(1);
    expect(textSimilarity('HELLO   WORLD', 'hello world')).toBe(1);
  });

  it('returns 0 for strings with completely disjoint 3-grams', () => {
    expect(textSimilarity('abcdef', 'ghijkl')).toBe(0);
    expect(textSimilarity('the cat sat', 'xyz pqr stu')).toBe(0);
  });

  it('scores minor rephrasing above 0.5', () => {
    // "the quick brown fox" vs "the quick brown dog" share 14 of 20 unique
    // shingles → 0.7, well above the 0.5 floor the spec calls out.
    const sim = textSimilarity('the quick brown fox', 'the quick brown dog');
    expect(sim).toBeGreaterThan(0.5);
  });

  it('scores near-identical strings close to 1', () => {
    // One word changes; most shingles survive.
    const sim = textSimilarity('hello world', 'hello worlds');
    expect(sim).toBeGreaterThan(0.8);
  });

  it('returns 0 when both inputs normalize to empty', () => {
    expect(textSimilarity('', '')).toBe(0);
    expect(textSimilarity('!!!', '???')).toBe(0);
  });
});

describe('findDuplicate', () => {
  interface Item {
    id: string;
    prompt: string;
  }

  it('returns null when the candidate list has fewer than two items', () => {
    expect(findDuplicate<Item>([], (i) => i.prompt)).toBeNull();
    expect(findDuplicate<Item>([{ id: 'a', prompt: 'x' }], (i) => i.prompt)).toBeNull();
  });

  it('returns null when no prior candidate clears the threshold', () => {
    const items: Item[] = [
      { id: 'a', prompt: 'cats are great' },
      { id: 'b', prompt: 'dogs are fine' },
      { id: 'c', prompt: 'fish swim' },
    ];
    expect(findDuplicate(items, (i) => i.prompt, 0.5)).toBeNull();
  });

  it('returns the matching candidate when the last item is a duplicate', () => {
    const items: Item[] = [
      { id: 'a', prompt: 'the quick brown fox' },
      { id: 'b', prompt: 'completely unrelated' },
      { id: 'c', prompt: 'the quick brown fox' },
    ];
    const result = findDuplicate(items, (i) => i.prompt, 0.99);
    expect(result).not.toBeNull();
    expect(result?.duplicate.id).toBe('a');
    expect(result?.similarity).toBe(1);
  });

  it('returns the highest-similarity match when multiple candidates are above threshold', () => {
    const items: Item[] = [
      { id: 'a', prompt: 'the quick brown fox' },   // sim 1.0 vs last
      { id: 'b', prompt: 'the quick brown dog' },   // sim ~0.7 vs last
      { id: 'c', prompt: 'the quick brown fox' },   // probe
    ];
    const result = findDuplicate(items, (i) => i.prompt, 0.5);
    expect(result).not.toBeNull();
    expect(result?.duplicate.id).toBe('a');
    expect(result?.similarity).toBeGreaterThan(0.9);
  });

  it('rejects matches at 0.99 that 0.85 accepts', () => {
    // Two strings share many but not all shingles → high but not perfect.
    const items: Item[] = [
      { id: 'a', prompt: 'the quick brown fox' },
      { id: 'b', prompt: 'the quick brown dog' },
    ];
    // Last item (b) vs prior (a) scores ~0.7: above 0.5, below 0.99.
    const permissive = findDuplicate(items, (i) => i.prompt, 0.5);
    const strict = findDuplicate(items, (i) => i.prompt, 0.99);
    expect(permissive).not.toBeNull();
    expect(strict).toBeNull();
  });

  it('respects case and punctuation via the promptKey extractor', () => {
    const items = [
      { id: 'a', prompt: 'Hello, World!' },
      { id: 'b', prompt: 'goodbye' },
      { id: 'c', prompt: 'hello world' },
    ];
    const result = findDuplicate(items, (i) => i.prompt, 0.99);
    expect(result?.duplicate.id).toBe('a');
    expect(result?.similarity).toBe(1);
  });
});
