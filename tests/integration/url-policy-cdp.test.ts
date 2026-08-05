import { describe, it, expect } from 'vitest';
import { assertUrlAllowed, checkUrl } from '../../src/safety/url-policy.js';

describe('integration: policy gates Comet-style navigations', () => {
  it('blocks chrome://settings (Comet settings page) by default', () => {
    const r = checkUrl('chrome://settings');
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('internal-scheme');
  });

  it('blocks chrome://password-manager (credential surface)', () => {
    const r = checkUrl('chrome://password-manager/passwords');
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('internal-scheme');
  });

  it('blocks file:// access to Windows credential stores', () => {
    const r = checkUrl('file:///C:/Users/x/AppData/Local/Google/Chrome/User Data/Default/Login Data');
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('file-scheme');
  });

  it('blocks downloading an .exe from any host', () => {
    const r = checkUrl('https://download.perplexity.ai/agent/installer.exe');
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('dangerous-extension');
  });

  it('allows normal https navigation', () => {
    const r = checkUrl('https://www.perplexity.ai/search?q=hello');
    expect(r.allowed).toBe(true);
  });

  it('assertUrlAllowed throws BlockedUrlError with useful message', () => {
    let caught: unknown;
    try {
      assertUrlAllowed('chrome://settings');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    expect((caught as Error).message).toContain('Refusing');
    expect((caught as Error).message).toContain('chrome://settings');
  });
});
