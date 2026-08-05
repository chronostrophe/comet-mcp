// In-memory registry of cross-account Comet sessions.
//
// Comet today is one browser + one Perplexity session. The "skip" tier
// (see docs/plans) introduces session sharing across Comet accounts — the
// first piece of that is a process-local registry that maps a user-facing
// sessionId to the underlying CDP target, plus bookkeeping metadata.
//
// Full BrowserContext isolation arrives in a later commit; this module
// only owns the registry. Uses `Map` (not a plain `Record`) so callers
// can't pollute `Object.prototype` via accidental string keys.

/**
 * A registered cross-account session.
 *
 * - `id` is the user-facing session id (appears in tool arguments and URLs).
 * - `cdpTargetId` is the Chrome DevTools Protocol target id this session is
 *   bound to. The CDP client uses this to route commands.
 * - `createdAt` and `lastUsedAt` are ISO 8601 strings; `touch()` bumps the
 *   latter on every access.
 * - `metadata` is intentionally `Record<string, string>` so it round-trips
 *   cleanly through MCP's JSON-RPC transport without bespoke marshaling.
 */
export interface SessionEntry {
  id: string;
  label: string;
  cdpTargetId: string;
  createdAt: string;
  lastUsedAt: string;
  metadata: Record<string, string>;
}

/**
 * Stamp `createdAt` and `lastUsedAt` on an entry-like value. Missing fields
 * are filled in with `now().toISOString()`; provided fields are preserved.
 *
 * Exported as a pure helper so tests can verify the preserve-on-provided
 * path without going through `SessionStore.register`. The `now` injection
 * point lets tests pin a deterministic clock.
 */
export function withFreshTimestamps<
  E extends { createdAt?: string; lastUsedAt?: string }
>(entry: E, now: () => Date = () => new Date()): E {
  const iso = now().toISOString();
  return {
    ...entry,
    createdAt: entry.createdAt ?? iso,
    lastUsedAt: entry.lastUsedAt ?? iso,
  };
}

/**
 * Process-local session registry. One instance per server; create via
 * {@link createSessionStore}.
 */
export class SessionStore {
  private readonly entries: Map<string, SessionEntry> = new Map();

  /**
   * Insert a new entry. Both timestamps are stamped from the same `new Date()`
   * call so `createdAt === lastUsedAt` immediately after insert — see test
   * "assigns createdAt and lastUsedAt to the same instant".
   *
   * Throws when `input.id` is already registered; callers should treat that
   * as a programmer error, not a recoverable condition.
   */
  register(input: Omit<SessionEntry, 'createdAt' | 'lastUsedAt'>): SessionEntry {
    if (this.entries.has(input.id)) {
      throw new Error(`Session id already registered: ${input.id}`);
    }
    const iso = new Date().toISOString();
    const entry: SessionEntry = { ...input, createdAt: iso, lastUsedAt: iso };
    this.entries.set(entry.id, entry);
    return entry;
  }

  /** Look up an entry by id. Returns `undefined` when not registered. */
  get(id: string): SessionEntry | undefined {
    return this.entries.get(id);
  }

  /**
   * Bump `lastUsedAt` to `new Date()`. Silently no-ops on unknown ids so
   * callers can `touch` speculatively without a preceding `get`.
   */
  touch(id: string): void {
    const existing = this.entries.get(id);
    if (!existing) return;
    this.entries.set(id, { ...existing, lastUsedAt: new Date().toISOString() });
  }

  /**
   * Remove an entry. Returns `true` when the id was registered, `false`
   * otherwise — matches `Map.delete` semantics so callers can use the
   * return value directly as a "did anything change?" signal.
   */
  unregister(id: string): boolean {
    return this.entries.delete(id);
  }

  /**
   * All entries sorted by `lastUsedAt` descending (most recently used first).
   * ISO 8601 strings sort lexicographically, so a plain `localeCompare`
   * comparator is sufficient and avoids re-parsing dates.
   */
  list(): SessionEntry[] {
    return [...this.entries.values()].sort((a, b) =>
      b.lastUsedAt.localeCompare(a.lastUsedAt),
    );
  }

  /**
   * First entry whose `label` exactly matches `label`. Labels are intended
   * to be unique per session, so this short-circuits on first hit.
   */
  findByLabel(label: string): SessionEntry | undefined {
    for (const entry of this.entries.values()) {
      if (entry.label === label) return entry;
    }
    return undefined;
  }

  /** Number of currently registered entries. */
  size(): number {
    return this.entries.size;
  }
}

/** Factory for {@link SessionStore}. Kept as a named export so callers can
 *  swap in a fake during tests without changing import paths. */
export function createSessionStore(): SessionStore {
  return new SessionStore();
}
