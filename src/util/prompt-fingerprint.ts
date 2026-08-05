// Prompt deduplication primitives. Local-only: a fast hash plus character
// 3-gram (shingle) Jaccard similarity. This is the foundation for a future
// swap to a real embedding model — the call shape (`textSimilarity`,
// `findDuplicate`) stays the same; only the scoring implementation changes.
//
// No remote calls, no network, no extra deps: only `node:crypto` for SHA-256
// and stdlib string ops for normalization + shingling.

import { createHash } from 'node:crypto';

/**
 * Lowercase the input, replace any non `[a-z0-9 ]` run with a single space,
 * collapse internal whitespace, and trim the ends. This is the canonical
 * form both `fingerprint` and `textSimilarity` operate on, so casing,
 * punctuation, and whitespace variants all collapse to one string.
 *
 * @example
 *   normalize("Hello,  World!") === "hello world"
 *   normalize("---") === ""
 */
export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * SHA-256 hex digest of the normalized text. Two prompts that normalize to
 * the same string will hash identically regardless of how the user typed
 * them, which makes this a cheap exact-match fingerprint.
 */
export function fingerprint(text: string): string {
  return createHash('sha256').update(normalize(text), 'utf8').digest('hex');
}

/** Unique character 3-grams of the input. Strings shorter than 3 chars
 *  contribute at most one shingle (themselves); the empty string contributes
 *  none. Sets make intersection / union via Jaccard trivial. */
function shingles(text: string): Set<string> {
  const out = new Set<string>();
  if (text.length === 0) return out;
  if (text.length < 3) {
    out.add(text);
    return out;
  }
  for (let i = 0; i <= text.length - 3; i++) {
    out.add(text.slice(i, i + 3));
  }
  return out;
}

/** Jaccard similarity over character 3-grams of the *normalized* inputs.
 *  Range is [0, 1]. Two empty-normalized inputs return 0 (no signal, not a
 *  perfect match — there is literally nothing to compare). */
function jaccard(a: string, b: string): number {
  if (a.length === 0 && b.length === 0) return 0;
  const sa = shingles(a);
  const sb = shingles(b);
  if (sa.size === 0 && sb.size === 0) return 0;
  let intersect = 0;
  for (const s of sa) {
    if (sb.has(s)) intersect++;
  }
  const union = sa.size + sb.size - intersect;
  return union === 0 ? 0 : intersect / union;
}

/**
 * Jaccard similarity over character 3-grams of the normalized text. Range
 * [0, 1]. Catches trivial rephrasing ("hello world" vs "hello there world")
 * but is purely lexical — semantic paraphrases will score low until a real
 * embedding backend replaces this function.
 */
export function textSimilarity(a: string, b: string): number {
  return jaccard(normalize(a), normalize(b));
}

export interface DuplicateMatch<T> {
  duplicate: T;
  similarity: number;
}

/**
 * Find the prior candidate whose prompt is most similar to the LAST
 * candidate's prompt, but only if that similarity meets `threshold`. The
 * "last" element is treated as the probe; everything before it is the
 * candidate pool. Returns the highest-similarity match above threshold
 * (lowest index breaks ties). Returns `null` if no candidate clears the
 * threshold or the input has fewer than two elements.
 *
 * @param candidates  Ordered list. The last element is the probe.
 * @param promptKey   Extracts the text to compare from each candidate.
 * @param threshold   Minimum similarity to count as a duplicate. Default 0.85.
 */
export function findDuplicate<T>(
  candidates: T[],
  promptKey: (t: T) => string,
  threshold: number = 0.85
): DuplicateMatch<T> | null {
  if (candidates.length < 2) return null;

  const probe = normalize(promptKey(candidates[candidates.length - 1]));
  const probeShingles = shingles(probe);
  let best: DuplicateMatch<T> | null = null;

  for (let i = 0; i < candidates.length - 1; i++) {
    const cand = candidates[i];
    const candNorm = normalize(promptKey(cand));
    const candShingles = shingles(candNorm);

    let sim: number;
    if (probeShingles.size === 0 && candShingles.size === 0) {
      sim = 0;
    } else {
      let intersect = 0;
      for (const s of probeShingles) {
        if (candShingles.has(s)) intersect++;
      }
      const union = probeShingles.size + candShingles.size - intersect;
      sim = union === 0 ? 0 : intersect / union;
    }

    if (sim >= threshold && (best === null || sim > best.similarity)) {
      best = { duplicate: cand, similarity: sim };
    }
  }
  return best;
}
