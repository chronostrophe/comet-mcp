// ANP (Agent Network Protocol) well-known Agent Card emitter.
//
// ANP uses DIDs for identity and exposes capability descriptors at
// `/.well-known/agent-card.json`. We emit a JSON-LD-ish object — strict
// JSON-LD parsing isn't required for the test surface, but the shape mirrors
// the ANP 1.1 spec.

import { createRequire } from 'node:module';

// `import` of package.json would resolve at compile time via resolveJsonModule,
// but Node ESM also needs an import assertion which is awkward. Use createRequire
// for a single, portable read at module load.
const require = createRequire(import.meta.url);
const pkg = require('../../package.json') as { version: string };

/** Input/output shape of an ANP capability descriptor. */
export interface AnpCapabilityDescriptor {
  input: string;
  output: string;
}

/** Map of capability name → descriptor. */
export type AnpCapabilities = Record<string, AnpCapabilityDescriptor>;

/** Shape of the well-known agent card object. */
export interface AnpAgentCard {
  '@context': string;
  id: string;
  type: string;
  name: string;
  description: string;
  version: string;
  capabilities: AnpCapabilities;
  protocols: string[];
  endpoints: Record<string, string>;
  publicKey: null;
  created: string;
}

/** Static capability descriptors for this server. */
const CAPABILITIES: AnpCapabilities = {
  research: { input: 'text', output: 'text' },
  browser_control: { input: 'text', output: 'text+actions' },
  summarization: { input: 'text', output: 'text' },
};

/** Well-known agent card describing this MCP server's identity and capabilities. */
export const ANP_AGENT_CARD: AnpAgentCard = {
  '@context': 'https://agent-network-protocol.com/specs/1.1/',
  id: 'did:comet-mcp:agent:researcher',
  type: 'Agent',
  name: 'comet-mcp',
  description: 'Browser-control agentic research via Perplexity Comet',
  version: pkg.version,
  capabilities: CAPABILITIES,
  protocols: ['a2a/0.2', 'mcp/2025-11-25'],
  endpoints: {
    research: '/a2a',
    mcp: '/mcp',
  },
  publicKey: null,
  created: new Date().toISOString(),
};

/**
 * Serialize the agent card to a stable, pretty-printed JSON string. Useful
 * for serving at `/.well-known/agent-card.json` and for snapshot tests.
 */
export function serializeAnpAgentCard(): string {
  return JSON.stringify(ANP_AGENT_CARD, null, 2);
}

/**
 * Look up a capability descriptor by name. Returns null when the capability
 * is not advertised — callers should fall back to a default or error path.
 */
export function matchCapability(
  card: AnpAgentCard,
  name: string
): AnpCapabilityDescriptor | null {
  const cap = card.capabilities[name];
  return cap ?? null;
}

/**
 * Runtime type guard for an unknown value. Returns true only when the value
 * is an object carrying the required ANP agent-card fields. Used at the
 * boundary where the card arrives over the wire (file, HTTP, or stdin) so
 * the rest of the codebase can trust the shape.
 */
export function isAnpAgentCard(value: unknown): value is AnpAgentCard {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.id !== 'string') return false;
  if (v.type !== 'Agent') return false;
  if (typeof v.capabilities !== 'object' || v.capabilities === null) return false;
  return true;
}
