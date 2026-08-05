// Hot-loaded site playbook store.
//
// Reads JSON playbooks from a configurable directory at startup AND on each
// `reload()` call. Lets ops update learned site fingerprints (YouTube,
// Crunchyroll, Perplexity sidecar) without rebuilding the MCP binary.
//
// Resolution order:
//   1. $COMET_PLAYBOOKS_DIR env var
//   2. ~/.comet-mcp/playbooks.json
//   3. bundled default at <project>/src/site-playbooks.json
//
// File format: array of `{ domain: string, skill: string }` objects, where
// `domain` may be a host or a `*.suffix` pattern for subdomain matching.

import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

export interface SitePlaybook {
  /** Domain or `*.suffix` pattern. */
  domain: string;
  /** Free-form JS expression that runs before the page's user code. */
  skill: string;
}

export interface PlaybookStoreOptions {
  /** Override the env-var lookup. */
  env?: Record<string, string | undefined>;
  /** Override the home-dir fallback. */
  homeDir?: string;
  /** Override the bundled default path (used in tests). */
  bundledPath?: string;
  /** Custom filesystem check (used in tests). */
  existsSync?: (path: string) => boolean;
  /** Custom file reader (used in tests). */
  readFileSync?: (path: string, encoding: 'utf8') => string;
}

/**
 * Resolve the directory to load playbooks from. Returns the first existing
 * path; never throws. If nothing exists, returns null and the caller falls
 * back to the bundled defaults.
 */
export function resolvePlaybookDir(opts: PlaybookStoreOptions = {}): string | null {
  const env = opts.env ?? process.env;
  const home = opts.homeDir ?? homedir();
  const fs = opts.existsSync ?? existsSync;

  const candidates = [
    env.COMET_PLAYBOOKS_DIR,
    join(home, '.comet-mcp', 'playbooks.json'),
  ].filter((p): p is string => Boolean(p));

  for (const p of candidates) {
    if (fs(p)) return p;
  }
  return null;
}

/**
 * Load the default playbooks that ship with the package. Path is resolved
 * relative to this module's URL so it survives `tsc` re-rooting into `dist/`.
 */
export function loadBundledPlaybooks(opts: PlaybookStoreOptions = {}): SitePlaybook[] {
  const here = fileURLToPath(import.meta.url);
  // src/site/playbook-store.ts -> ../site-playbooks.json
  const defaultPath = opts.bundledPath ?? join(here, '..', '..', 'site-playbooks.json');
  const reader = opts.readFileSync ?? ((p) => readFileSync(p, 'utf8'));
  try {
    const raw = reader(defaultPath, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as SitePlaybook[]) : [];
  } catch {
    return [];
  }
}

/**
 * Load playbooks from a specific JSON file. Returns [] on missing/invalid.
 */
export function loadPlaybooksFromFile(path: string, opts: PlaybookStoreOptions = {}): SitePlaybook[] {
  const fs = opts.existsSync ?? existsSync;
  if (!fs(path)) return [];
  const reader = opts.readFileSync ?? ((p) => readFileSync(p, 'utf8'));
  try {
    const raw = reader(path, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as SitePlaybook[]) : [];
  } catch {
    return [];
  }
}

/**
 * In-memory playbook store with a hot-reload path. Created via
 * `createPlaybookStore({ ... })`. Pure data — no I/O at construction.
 */
export interface PlaybookStore {
  /** Current playbook list (snapshot; do not mutate). */
  list(): SitePlaybook[];
  /** Lookup by URL or domain (exact match or `*.suffix` wildcard). */
  find(urlOrDomain: string): SitePlaybook | null;
  /** Read fresh from disk + bundled fallback. Returns the new count. */
  reload(): number;
  /** Where the live overrides came from, or null if using bundled defaults. */
  sourcePath(): string | null;
}

export function createPlaybookStore(opts: PlaybookStoreOptions = {}): PlaybookStore {
  let current: SitePlaybook[] = loadBundledPlaybooks(opts);
  let source: string | null = null;

  function tryLoadOverride(): SitePlaybook[] {
    const dir = resolvePlaybookDir(opts);
    if (!dir) return current;
    const loaded = loadPlaybooksFromFile(dir, opts);
    if (loaded.length === 0) return current;
    source = dir;
    return loaded;
  }

  function find(urlOrDomain: string): SitePlaybook | null {
    if (!urlOrDomain) return null;
    const target = urlOrDomain.toLowerCase();
    // Direct host match first
    const direct = current.find((p) => p.domain.toLowerCase() === target);
    if (direct) return direct;
    // Suffix / wildcard match. Strip a leading `*.` from the pattern so
    // `*.perplexity.ai` matches `www.perplexity.ai` (the pattern represents
    // the apex + subdomains).
    const suffix = current.find((p) => {
      const pd = p.domain.toLowerCase().replace(/^\*\./, '');
      return pd.length > 0 && (target === pd || target.endsWith('.' + pd));
    });
    return suffix ?? null;
  }

  function reload(): number {
    current = tryLoadOverride();
    return current.length;
  }

  // Attempt override at construction so callers see live config immediately.
  current = tryLoadOverride();

  return {
    list: () => current.slice(),
    find,
    reload,
    sourcePath: () => source,
  };
}

