import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  SessionStore,
  createSessionStore,
  withFreshTimestamps,
} from '../../src/session/store.js';

const baseInput = {
  id: 'sess-1',
  label: 'work',
  cdpTargetId: 'target-abc',
  metadata: { user: 'hanzili' },
};

describe('SessionStore.register', () => {
  it('round-trips through get', () => {
    const store = createSessionStore();
    const entry = store.register(baseInput);
    expect(entry.id).toBe('sess-1');
    expect(entry.label).toBe('work');
    expect(entry.cdpTargetId).toBe('target-abc');
    expect(entry.metadata).toEqual({ user: 'hanzili' });

    const fetched = store.get('sess-1');
    expect(fetched).toEqual(entry);
  });

  it('throws when id already exists and the error message contains the id', () => {
    const store = createSessionStore();
    store.register(baseInput);
    expect(() => store.register(baseInput)).toThrowError(/sess-1/);
  });

  it('assigns createdAt and lastUsedAt to the same instant on insert', () => {
    const store = createSessionStore();
    const entry = store.register(baseInput);
    expect(entry.createdAt).toBe(entry.lastUsedAt);
    // Sanity: the value is a parseable ISO 8601 string.
    expect(() => new Date(entry.createdAt).toISOString()).not.toThrow();
  });
});

describe('SessionStore.touch', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('updates lastUsedAt but leaves createdAt alone', () => {
    const store = createSessionStore();
    const entry = store.register(baseInput);
    vi.setSystemTime(new Date('2026-01-01T00:00:05.000Z'));
    store.touch(entry.id);

    const after = store.get(entry.id);
    expect(after).toBeDefined();
    expect(after!.lastUsedAt).toBe('2026-01-01T00:00:05.000Z');
    expect(after!.createdAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('is a silent no-op for unknown ids', () => {
    const store = createSessionStore();
    expect(() => store.touch('nope')).not.toThrow();
    expect(store.size()).toBe(0);
  });
});

describe('SessionStore.unregister', () => {
  it('returns true and removes the entry when it exists', () => {
    const store = createSessionStore();
    store.register(baseInput);
    expect(store.unregister('sess-1')).toBe(true);
    expect(store.get('sess-1')).toBeUndefined();
    expect(store.size()).toBe(0);
  });

  it('returns false when the id is not registered', () => {
    const store = createSessionStore();
    expect(store.unregister('missing')).toBe(false);
  });
});

describe('SessionStore.list', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns entries sorted by lastUsedAt descending', () => {
    const store = createSessionStore();
    store.register({ ...baseInput, id: 'a' });
    vi.setSystemTime(new Date('2026-01-01T00:00:05.000Z'));
    store.register({ ...baseInput, id: 'b' });
    vi.setSystemTime(new Date('2026-01-01T00:00:10.000Z'));
    // Touch 'a' so it becomes the most recently used.
    store.touch('a');

    const ids = store.list().map((e) => e.id);
    expect(ids).toEqual(['a', 'b']);
  });

  it('returns an empty array when the store is empty', () => {
    const store = createSessionStore();
    expect(store.list()).toEqual([]);
  });
});

describe('SessionStore.findByLabel', () => {
  it('returns the matching entry', () => {
    const store = createSessionStore();
    store.register({ ...baseInput, id: 'a', label: 'work' });
    store.register({ ...baseInput, id: 'b', label: 'personal' });
    const found = store.findByLabel('personal');
    expect(found?.id).toBe('b');
  });

  it('returns undefined when no label matches', () => {
    const store = createSessionStore();
    store.register({ ...baseInput, id: 'a', label: 'work' });
    expect(store.findByLabel('home')).toBeUndefined();
  });
});

describe('SessionStore.size', () => {
  it('returns the current entry count, growing and shrinking with mutations', () => {
    const store = createSessionStore();
    expect(store.size()).toBe(0);
    store.register({ ...baseInput, id: 'a' });
    expect(store.size()).toBe(1);
    store.register({ ...baseInput, id: 'b' });
    expect(store.size()).toBe(2);
    store.unregister('a');
    expect(store.size()).toBe(1);
  });
});

describe('withFreshTimestamps', () => {
  it('sets both fields when missing', () => {
    const fixed = new Date('2026-01-01T00:00:00.000Z');
    const out = withFreshTimestamps({ id: 'x' }, () => fixed);
    expect(out.createdAt).toBe('2026-01-01T00:00:00.000Z');
    expect(out.lastUsedAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('preserves provided timestamps and ignores now()', () => {
    const fixed = new Date('2026-01-01T00:00:00.000Z');
    const out = withFreshTimestamps(
      {
        id: 'x',
        createdAt: '2025-12-01T00:00:00.000Z',
        lastUsedAt: '2025-12-31T00:00:00.000Z',
      },
      () => fixed,
    );
    expect(out.createdAt).toBe('2025-12-01T00:00:00.000Z');
    expect(out.lastUsedAt).toBe('2025-12-31T00:00:00.000Z');
  });

  it('fills in only the missing field when one timestamp is provided', () => {
    const fixed = new Date('2026-01-01T00:00:00.000Z');
    const out = withFreshTimestamps(
      { id: 'x', createdAt: '2025-06-01T00:00:00.000Z' },
      () => fixed,
    );
    expect(out.createdAt).toBe('2025-06-01T00:00:00.000Z');
    expect(out.lastUsedAt).toBe('2026-01-01T00:00:00.000Z');
  });
});

describe('SessionStore class export', () => {
  it('can be constructed directly, not only via the factory', () => {
    const store = new SessionStore();
    expect(store.size()).toBe(0);
    store.register(baseInput);
    expect(store.size()).toBe(1);
  });
});
