import { describe, it, expect } from 'vitest';
import path from 'node:path';
import {
  createPlaybookStore,
  resolvePlaybookDir,
  loadPlaybooksFromFile,
  loadBundledPlaybooks,
  type SitePlaybook,
  type PlaybookStoreOptions,
} from '../../src/site/playbook-store.js';

const SAMPLE: SitePlaybook[] = [
  { domain: 'youtube.com', skill: 'window.__yt = true' },
  { domain: '*.perplexity.ai', skill: 'window.__pp = true' },
  { domain: 'crunchyroll.com', skill: 'window.__cr = true' },
];

function withFs(files: Record<string, string>, env: Record<string, string> = {}): PlaybookStoreOptions {
  // Normalize Windows-style paths in `files` keys so tests work cross-platform.
  const norm: Record<string, string> = {};
  for (const [k, v] of Object.entries(files)) {
    norm[path.normalize(k)] = v;
  }
  return {
    env: { ...env },
    homeDir: path.normalize('/home/test'),
    existsSync: (p) => Object.prototype.hasOwnProperty.call(norm, path.normalize(p)),
    readFileSync: (p) => {
      const v = norm[path.normalize(p)];
      if (v === undefined) throw new Error(`ENOENT: ${p}`);
      return v;
    },
    bundledPath: path.normalize('/bundled/site-playbooks.json'),
  };
}

/** Normalize for cross-platform comparisons. */
function np(p: string): string { return path.normalize(p); }

describe('resolvePlaybookDir', () => {
  it('returns null when no candidate exists', () => {
    expect(resolvePlaybookDir(withFs({}))).toBeNull();
  });

  it('prefers COMET_PLAYBOOKS_DIR over ~/.comet-mcp/playbooks.json', () => {
    const envDir = path.normalize('/etc/comet/playbooks.json');
    const opts = withFs({
      [envDir]: '[]',
      [path.join('/home/test', '.comet-mcp', 'playbooks.json')]: '[]',
    }, { COMET_PLAYBOOKS_DIR: envDir });
    expect(resolvePlaybookDir(opts)).toBe(envDir);
  });

  it('falls back to ~/.comet-mcp/playbooks.json when env var is unset and file exists', () => {
    const opts = withFs({
      [path.join('/home/test', '.comet-mcp', 'playbooks.json')]: '[]',
    });
    expect(resolvePlaybookDir(opts)).toBe(np(path.join('/home/test', '.comet-mcp', 'playbooks.json')));
  });
});

describe('loadPlaybooksFromFile', () => {
  it('returns [] when file does not exist', () => {
    expect(loadPlaybooksFromFile('/missing.json', withFs({}))).toEqual([]);
  });

  it('parses a valid array', () => {
    const opts = withFs({ '/x.json': JSON.stringify(SAMPLE) });
    expect(loadPlaybooksFromFile('/x.json', opts)).toEqual(SAMPLE);
  });

  it('returns [] on invalid JSON', () => {
    const opts = withFs({ '/x.json': '{not json' });
    expect(loadPlaybooksFromFile('/x.json', opts)).toEqual([]);
  });

  it('returns [] when JSON is not an array', () => {
    const opts = withFs({ '/x.json': '{"domain":"x"}' });
    expect(loadPlaybooksFromFile('/x.json', opts)).toEqual([]);
  });
});

describe('loadBundledPlaybooks', () => {
  it('returns the bundled array when file exists', () => {
    const opts = withFs({ '/bundled/site-playbooks.json': JSON.stringify(SAMPLE) });
    expect(loadBundledPlaybooks(opts)).toEqual(SAMPLE);
  });

  it('returns [] on missing or invalid bundled file', () => {
    expect(loadBundledPlaybooks(withFs({}))).toEqual([]);
    expect(loadBundledPlaybooks(withFs({ '/bundled/site-playbooks.json': 'broken' }))).toEqual([]);
  });
});

describe('createPlaybookStore', () => {
  it('returns a store with empty list when no sources exist', () => {
    const store = createPlaybookStore(withFs({}));
    expect(store.list()).toEqual([]);
    expect(store.sourcePath()).toBeNull();
  });

  it('loads bundled by default', () => {
    const store = createPlaybookStore(withFs({
      '/bundled/site-playbooks.json': JSON.stringify(SAMPLE),
    }));
    expect(store.list().length).toBe(3);
    expect(store.sourcePath()).toBeNull();
  });

  it('prefers override at construction time', () => {
    const bundledPath = path.normalize('/bundled/site-playbooks.json');
    const overridePath = path.normalize('/override.json');
    const opts = withFs({
      [bundledPath]: JSON.stringify([{ domain: 'bundled.example', skill: 'b' }]),
      [overridePath]: JSON.stringify([{ domain: 'override.example', skill: 'o' }]),
    }, { COMET_PLAYBOOKS_DIR: overridePath });
    const store = createPlaybookStore(opts);
    expect(store.list().map(p => p.domain)).toEqual(['override.example']);
    expect(store.sourcePath()).toBe(overridePath);
  });

  it('find returns direct host match', () => {
    const store = createPlaybookStore(withFs({
      '/bundled/site-playbooks.json': JSON.stringify(SAMPLE),
    }));
    expect(store.find('youtube.com')?.skill).toBe('window.__yt = true');
  });

  it('find returns wildcard match for subdomain', () => {
    const store = createPlaybookStore(withFs({
      '/bundled/site-playbooks.json': JSON.stringify(SAMPLE),
    }));
    expect(store.find('www.perplexity.ai')?.skill).toBe('window.__pp = true');
    expect(store.find('api.perplexity.ai')?.skill).toBe('window.__pp = true');
  });

  it('find returns null for unknown host', () => {
    const store = createPlaybookStore(withFs({
      '/bundled/site-playbooks.json': JSON.stringify(SAMPLE),
    }));
    expect(store.find('example.com')).toBeNull();
  });

  it('find returns null for empty input', () => {
    const store = createPlaybookStore(withFs({
      '/bundled/site-playbooks.json': JSON.stringify(SAMPLE),
    }));
    expect(store.find('')).toBeNull();
  });

  it('reload re-reads from disk', () => {
    let storeFile = JSON.stringify([{ domain: 'a.example', skill: 'a' }]);
    const bundledPath = path.normalize('/bundled/site-playbooks.json');
    const overridePath = path.normalize('/override.json');
    const opts: PlaybookStoreOptions = {
      env: { COMET_PLAYBOOKS_DIR: overridePath },
      homeDir: path.normalize('/home/test'),
      existsSync: (p) => {
        const n = path.normalize(p);
        return n === overridePath || n === bundledPath;
      },
      readFileSync: (p) => {
        const n = path.normalize(p);
        if (n === overridePath) return storeFile;
        if (n === bundledPath) return JSON.stringify(SAMPLE);
        throw new Error(`ENOENT: ${p}`);
      },
      bundledPath,
    };
    const store = createPlaybookStore(opts);
    expect(store.list().map(p => p.domain)).toEqual(['a.example']);
    storeFile = JSON.stringify([
      { domain: 'b.example', skill: 'b' },
      { domain: 'c.example', skill: 'c' },
    ]);
    expect(store.reload()).toBe(2);
    expect(store.list().map(p => p.domain)).toEqual(['b.example', 'c.example']);
  });

  it('list returns a defensive copy', () => {
    const store = createPlaybookStore(withFs({
      '/bundled/site-playbooks.json': JSON.stringify(SAMPLE),
    }));
    const a = store.list();
    a.push({ domain: 'evil.example', skill: 'x' });
    expect(store.list().length).toBe(3);
  });
});
