// Passive A2A (Agent-to-Agent) v0.2 server stub.
//
// This module emits the static agent card and dispatches the minimal
// subset of JSON-RPC 2.0 methods we expose to peer agents while the
// parent HTTP server is being designed. Real wiring to `cometClient`
// is intentionally out of scope — the parent integrates the dispatcher
// with its request handler and decides how to surface results. Tasks
// returned here are deterministic stubs so callers can round-trip
// `message/send` → `tasks/get` without spinning up a live Comet
// connection.

import { readFileSync } from 'node:fs';

// Read the package version once at module load. We use `fs.readFileSync`
// with `import.meta.url` instead of JSON import attributes to keep the
// module portable across Node ESM versions and to match the convention
// already used by other protocol stubs.
const pkg = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
) as { version: string };

// ---- Type definitions -----------------------------------------------------

/** A single content part inside an A2A message or artifact. */
export interface A2APart {
  type: 'text';
  text: string;
}

/** An artifact produced by a completed task. */
export interface A2AArtifact {
  artifactId: string;
  name: string;
  parts: A2APart[];
  metadata?: Record<string, unknown>;
}

/** Minimal task shape — A2A v0.2 also allows `contextId` and `history`,
 *  but we only expose what the stub actually fills. */
export interface A2ATask {
  id: string;
  state: 'completed' | 'failed' | 'pending';
  artifacts: A2AArtifact[];
}

/** Inbound JSON-RPC request (the parent parses the envelope). */
export interface A2ARequest {
  method: string;
  params?: unknown;
  id?: string | number | null;
}

/** JSON-RPC 2.0 error payload. */
export interface A2AError {
  code: number;
  message: string;
  data?: unknown;
}

/** Outbound JSON-RPC 2.0 envelope. Either `result` or `error` is set. */
export interface A2AResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: A2AError;
}

/** A capability advertised on the agent card. */
export interface A2ASkill {
  id: string;
  name: string;
  description: string;
  inputModes: string[];
  outputModes: string[];
  examples?: string[];
}

/** A2A v0.2 agent card schema. */
export interface A2AAgentCard {
  name: string;
  description: string;
  url: string;
  version: string;
  capabilities: {
    streaming: boolean;
    pushNotifications: boolean;
    stateTransitionHistory: boolean;
  };
  defaultInputModes: string[];
  defaultOutputModes: string[];
  provider: {
    organization: string;
    url: string;
  };
  skills: A2ASkill[];
}

// ---- Agent card -----------------------------------------------------------

/** Static A2A v0.2 agent card. Version is read from package.json at
 *  module load so it always tracks the running server. Skill
 *  descriptions mirror the MCP tool descriptions in `src/index.ts`. */
export const A2A_AGENT_CARD: A2AAgentCard = {
  name: 'comet-mcp',
  description: 'Browser-control agentic research via Perplexity Comet',
  url: 'http://localhost:7333/a2a',
  version: pkg.version,
  capabilities: {
    streaming: false,
    pushNotifications: false,
    stateTransitionHistory: false,
  },
  defaultInputModes: ['text'],
  defaultOutputModes: ['text'],
  provider: {
    organization: 'comet-mcp',
    url: 'https://github.com/hanzili/comet-mcp',
  },
  skills: [
    {
      id: 'comet_ask',
      name: 'comet_ask',
      description:
        'Send a prompt to Comet/Perplexity and wait for the complete response (blocking). Ideal for tasks requiring real browser interaction (login walls, dynamic content, filling forms) or deep research with agentic browsing.',
      inputModes: ['text'],
      outputModes: ['text'],
      examples: [
        'Use comet_ask to research the latest advances in fusion energy and summarize the top three in plain language.',
      ],
    },
    {
      id: 'comet_smart_click',
      name: 'comet_smart_click',
      description:
        'Ultra-Reliable Verified SmartClick Engine: Dual-Layer AXTree + DOM resolution, Hardware Input dispatch, Action Verification, and Backtracking Fallbacks',
      inputModes: ['text'],
      outputModes: ['text'],
      examples: [
        'Use comet_smart_click to press the "Sign in" button on the page even when the DOM has been mutated by the SPA.',
      ],
    },
    {
      id: 'comet_sidecar_prompt',
      name: 'comet_sidecar_prompt',
      description:
        "Comet Assistant Sidecar: Inject a prompt directly into Comet's native Assistant side panel",
      inputModes: ['text'],
      outputModes: ['text'],
      examples: [
        'Use comet_sidecar_prompt to ask the sidecar assistant to draft an email reply based on the open inbox thread.',
      ],
    },
    {
      id: 'comet_continuous_screenshots',
      name: 'comet_continuous_screenshots',
      description:
        'Continuous Coverage Screenshot Engine: Captures sequential 90% viewport overlap PNG screenshots down the document',
      inputModes: ['text'],
      outputModes: ['text'],
      examples: [
        'Use comet_continuous_screenshots to capture every viewport-sized slice of a long-form research report for later OCR.',
      ],
    },
  ],
};

// ---- Helpers --------------------------------------------------------------

/**
 * Build a JSON-RPC 2.0 error envelope. The `data` field is omitted when
 * `undefined` so wire output stays minimal.
 */
export function serializeA2AError(
  code: number,
  message: string,
  id: string | number | null = null,
  data?: unknown,
): A2AResponse {
  const error: A2AError = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id, error };
}

/**
 * Wrap a plain text reply into an A2A artifact. The taskId is stamped
 * into metadata so downstream consumers can correlate the artifact
 * back to its task without parsing the id out of the parts.
 */
export function buildArtifactFromText(text: string, taskId: string): A2AArtifact {
  return {
    artifactId: `artifact-${taskId}`,
    name: 'response',
    parts: [{ type: 'text', text }],
    metadata: { taskId },
  };
}

// ---- Dispatcher -----------------------------------------------------------

/** djb2-ish hash → base36. Deterministic, no crypto dependency, short. */
function stubTaskId(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) {
    h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  }
  return `stub-${(h >>> 0).toString(36)}`;
}

/** Module-scoped store of stub tasks keyed by their deterministic id. */
const stubTasks = new Map<string, A2ATask>();

/**
 * JSON-RPC 2.0 dispatcher for the A2A v0.2 surface.
 *
 * Supported methods:
 *   - `message/send` → completes immediately with a stub artifact.
 *   - `tasks/get`    → returns a previously stored stub task by id.
 *
 * Errors follow JSON-RPC 2.0 codes:
 *   - `-32600` Invalid Request   — method is not a string or params
 *     are not an object, or `message/send` is missing the expected
 *     `message.parts[0].text`.
 *   - `-32601` Method not found  — method is not `message/send` or
 *     `tasks/get`.
 *   - `-32001` Task not found    — `tasks/get` was called with an id
 *     that has no stub task in the store.
 *
 * The function never rejects; both success and failure paths resolve
 * to a JSON-RPC envelope so the parent HTTP handler can serialize
 * uniformly.
 */
export async function handleA2ARequest(
  method: string,
  params: unknown,
  id: string | number | null = null,
): Promise<unknown> {
  if (typeof method !== 'string') {
    return serializeA2AError(-32600, 'Invalid Request', id);
  }

  if (method === 'message/send') {
    if (typeof params !== 'object' || params === null) {
      return serializeA2AError(-32600, 'Invalid Request', id);
    }
    const p = params as { message?: { parts?: Array<{ text?: unknown }> } };
    const text = p?.message?.parts?.[0]?.text;
    if (typeof text !== 'string') {
      return serializeA2AError(-32600, 'Invalid Request', id);
    }
    const taskId = stubTaskId(text);
    const artifact = buildArtifactFromText(
      `[A2A stub] Would dispatch to comet: ${text}`,
      taskId,
    );
    const task: A2ATask = {
      id: taskId,
      state: 'completed',
      artifacts: [artifact],
    };
    stubTasks.set(taskId, task);
    return { jsonrpc: '2.0', id, result: task };
  }

  if (method === 'tasks/get') {
    if (typeof params !== 'object' || params === null) {
      return serializeA2AError(-32600, 'Invalid Request', id);
    }
    const p = params as { id?: unknown };
    if (typeof p.id !== 'string') {
      return serializeA2AError(-32600, 'Invalid Request', id);
    }
    const task = stubTasks.get(p.id);
    if (!task) {
      return serializeA2AError(-32001, 'Task not found', id);
    }
    return { jsonrpc: '2.0', id, result: task };
  }

  return serializeA2AError(-32601, 'Method not found', id);
}
