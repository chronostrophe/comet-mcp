import { describe, it, expect } from 'vitest';
import {
  ANP_AGENT_CARD,
  serializeAnpAgentCard,
  matchCapability,
  isAnpAgentCard,
} from '../../src/protocols/anp.js';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pkg = require('../../package.json') as { version: string };

describe('ANP_AGENT_CARD', () => {
  it('has all required fields and version matches package.json', () => {
    expect(ANP_AGENT_CARD['@context']).toBe('https://agent-network-protocol.com/specs/1.1/');
    expect(ANP_AGENT_CARD.id).toBe('did:comet-mcp:agent:researcher');
    expect(ANP_AGENT_CARD.type).toBe('Agent');
    expect(ANP_AGENT_CARD.name).toBe('comet-mcp');
    expect(typeof ANP_AGENT_CARD.description).toBe('string');
    expect(ANP_AGENT_CARD.description.length).toBeGreaterThan(0);
    expect(typeof ANP_AGENT_CARD.version).toBe('string');
    expect(ANP_AGENT_CARD.version).toBe(pkg.version);
    expect(typeof ANP_AGENT_CARD.capabilities).toBe('object');
    expect(Array.isArray(ANP_AGENT_CARD.protocols)).toBe(true);
    expect(typeof ANP_AGENT_CARD.endpoints).toBe('object');
    expect(ANP_AGENT_CARD.publicKey).toBeNull();
  });

  it('emits created as an ISO 8601 timestamp', () => {
    expect(typeof ANP_AGENT_CARD.created).toBe('string');
    // toISOString() yields e.g. "2026-08-05T12:34:56.789Z"
    expect(ANP_AGENT_CARD.created).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
    );
    expect(Number.isNaN(Date.parse(ANP_AGENT_CARD.created))).toBe(false);
  });
});

describe('serializeAnpAgentCard', () => {
  it('returns valid JSON that round-trips back to the same card', () => {
    const serialized = serializeAnpAgentCard();
    expect(typeof serialized).toBe('string');
    // Pretty-printed with 2-space indent — verify at least one newline.
    expect(serialized).toContain('\n');

    const parsed: unknown = JSON.parse(serialized);
    expect(isAnpAgentCard(parsed)).toBe(true);
    expect(parsed).toEqual(ANP_AGENT_CARD);
  });
});

describe('matchCapability', () => {
  it('returns the capability descriptor for known names', () => {
    expect(matchCapability(ANP_AGENT_CARD, 'research')).toEqual({
      input: 'text',
      output: 'text',
    });
    expect(matchCapability(ANP_AGENT_CARD, 'browser_control')).toEqual({
      input: 'text',
      output: 'text+actions',
    });
  });

  it('returns null for unknown capability names', () => {
    expect(matchCapability(ANP_AGENT_CARD, 'unknown')).toBeNull();
    expect(matchCapability(ANP_AGENT_CARD, '')).toBeNull();
  });
});

describe('isAnpAgentCard', () => {
  it('returns true for the exported card', () => {
    expect(isAnpAgentCard(ANP_AGENT_CARD)).toBe(true);
  });

  it('returns false for null and non-objects', () => {
    expect(isAnpAgentCard(null)).toBe(false);
    expect(isAnpAgentCard(undefined)).toBe(false);
    expect(isAnpAgentCard('agent-card')).toBe(false);
    expect(isAnpAgentCard(42)).toBe(false);
  });

  it('returns false when required fields are missing', () => {
    expect(isAnpAgentCard({})).toBe(false);
    expect(isAnpAgentCard({ id: 'x' })).toBe(false);
    expect(isAnpAgentCard({ id: 'x', type: 'Agent' })).toBe(false);
    expect(
      isAnpAgentCard({ id: 'x', type: 'Agent', capabilities: 'not-an-object' })
    ).toBe(false);
    expect(
      isAnpAgentCard({ id: 'x', type: 'Agent', capabilities: null })
    ).toBe(false);
  });

  it('returns false when type is not "Agent"', () => {
    expect(
      isAnpAgentCard({ id: 'x', type: 'NotAgent', capabilities: {} })
    ).toBe(false);
  });
});

describe('ANP_AGENT_CARD.protocols', () => {
  it('contains a2a/0.2 and mcp/2025-11-25', () => {
    expect(ANP_AGENT_CARD.protocols).toContain('a2a/0.2');
    expect(ANP_AGENT_CARD.protocols).toContain('mcp/2025-11-25');
    expect(ANP_AGENT_CARD.protocols).toHaveLength(2);
  });

  it('maps endpoints for each protocol', () => {
    expect(ANP_AGENT_CARD.endpoints.research).toBe('/a2a');
    expect(ANP_AGENT_CARD.endpoints.mcp).toBe('/mcp');
  });
});
