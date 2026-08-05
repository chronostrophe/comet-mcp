import { describe, it, expect } from 'vitest';
import {
  A2A_AGENT_CARD,
  handleA2ARequest,
  serializeA2AError,
  buildArtifactFromText,
  type A2AArtifact,
  type A2AResponse,
  type A2ATask,
} from '../../src/protocols/a2a.js';

describe('A2A_AGENT_CARD', () => {
  it('advertises all four required skills', () => {
    expect(A2A_AGENT_CARD.skills).toHaveLength(4);
    const ids = A2A_AGENT_CARD.skills.map((s) => s.id);
    expect(ids).toContain('comet_ask');
    expect(ids).toContain('comet_smart_click');
    expect(ids).toContain('comet_sidecar_prompt');
    expect(ids).toContain('comet_continuous_screenshots');
  });

  it('declares a capabilities object with all three flags set to false', () => {
    expect(A2A_AGENT_CARD.capabilities).toBeDefined();
    expect(A2A_AGENT_CARD.capabilities.streaming).toBe(false);
    expect(A2A_AGENT_CARD.capabilities.pushNotifications).toBe(false);
    expect(A2A_AGENT_CARD.capabilities.stateTransitionHistory).toBe(false);
  });

  it('declares text input and output modes on the card and on every skill', () => {
    expect(A2A_AGENT_CARD.defaultInputModes).toEqual(['text']);
    expect(A2A_AGENT_CARD.defaultOutputModes).toEqual(['text']);
    for (const skill of A2A_AGENT_CARD.skills) {
      expect(skill.inputModes).toEqual(['text']);
      expect(skill.outputModes).toEqual(['text']);
    }
  });

  it('reads version from package.json at runtime as a semver-ish string', () => {
    expect(typeof A2A_AGENT_CARD.version).toBe('string');
    expect(A2A_AGENT_CARD.version.length).toBeGreaterThan(0);
    expect(A2A_AGENT_CARD.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('includes a realistic examples entry for every skill', () => {
    for (const skill of A2A_AGENT_CARD.skills) {
      expect(Array.isArray(skill.examples)).toBe(true);
      expect(skill.examples!.length).toBeGreaterThan(0);
      expect(skill.examples![0].length).toBeGreaterThan(20);
    }
  });
});

describe('serializeA2AError', () => {
  it('builds a JSON-RPC envelope when an id is supplied', () => {
    const env = serializeA2AError(-32601, 'Method not found', 7);
    expect(env).toEqual({
      jsonrpc: '2.0',
      id: 7,
      error: { code: -32601, message: 'Method not found' },
    });
  });

  it('uses null id when none is supplied', () => {
    const env = serializeA2AError(-32600, 'Invalid Request');
    expect(env.id).toBeNull();
    expect(env.jsonrpc).toBe('2.0');
    expect(env.error?.code).toBe(-32600);
    expect(env.error?.message).toBe('Invalid Request');
  });

  it('passes optional data through to the error payload', () => {
    const env = serializeA2AError(-32001, 'Task not found', 'req-1', {
      hint: 'send a message first',
    });
    expect(env.id).toBe('req-1');
    expect(env.error?.data).toEqual({ hint: 'send a message first' });
  });

  it('omits the data field when it is undefined', () => {
    const env = serializeA2AError(-32601, 'Method not found');
    expect(env.error).not.toHaveProperty('data');
  });
});

describe('buildArtifactFromText', () => {
  it('wraps the text in a single text part and stamps the taskId', () => {
    const a: A2AArtifact = buildArtifactFromText('hello world', 'task-42');
    expect(a.parts).toEqual([{ type: 'text', text: 'hello world' }]);
    expect(a.name).toBe('response');
    expect(a.metadata).toEqual({ taskId: 'task-42' });
    expect(typeof a.artifactId).toBe('string');
    expect(a.artifactId.length).toBeGreaterThan(0);
  });

  it('produces distinct artifactIds for distinct task ids', () => {
    const a = buildArtifactFromText('x', 'task-A');
    const b = buildArtifactFromText('x', 'task-B');
    expect(a.artifactId).not.toBe(b.artifactId);
  });
});

describe('handleA2ARequest', () => {
  it('message/send returns a completed task with the [A2A stub] artifact', async () => {
    const env = (await handleA2ARequest('message/send', {
      message: { role: 'user', parts: [{ type: 'text', text: 'hello' }] },
    })) as A2AResponse;

    expect(env.jsonrpc).toBe('2.0');
    const task = env.result as A2ATask;
    expect(task.state).toBe('completed');
    expect(task.artifacts).toHaveLength(1);
    expect(task.artifacts[0].parts[0].text).toBe(
      '[A2A stub] Would dispatch to comet: hello',
    );
  });

  it('tasks/get echoes back the same artifact text for a known id (deterministic)', async () => {
    const send = (await handleA2ARequest('message/send', {
      message: { role: 'user', parts: [{ type: 'text', text: 'echo test' }] },
    })) as A2AResponse;
    const sentTask = send.result as A2ATask;

    const get = (await handleA2ARequest('tasks/get', {
      id: sentTask.id,
    })) as A2AResponse;
    const gotTask = get.result as A2ATask;

    expect(gotTask.id).toBe(sentTask.id);
    expect(gotTask.artifacts[0].parts[0].text).toBe(
      sentTask.artifacts[0].parts[0].text,
    );
    expect(gotTask.state).toBe('completed');
  });

  it('tasks/get with a fresh id after a fresh send is still deterministic', async () => {
    // Two independent message/send calls with the same text must yield
    // the same task id (and therefore the same artifact text).
    const a = (await handleA2ARequest('message/send', {
      message: { role: 'user', parts: [{ type: 'text', text: 'deterministic' }] },
    })) as A2AResponse;
    const b = (await handleA2ARequest('message/send', {
      message: { role: 'user', parts: [{ type: 'text', text: 'deterministic' }] },
    })) as A2AResponse;
    const aTask = a.result as A2ATask;
    const bTask = b.result as A2ATask;
    expect(aTask.id).toBe(bTask.id);
    expect(aTask.artifacts[0].parts[0].text).toBe(
      bTask.artifacts[0].parts[0].text,
    );
  });

  it('returns -32601 for unknown methods', async () => {
    const env = (await handleA2ARequest('unknown/method', {})) as A2AResponse;
    expect(env.error?.code).toBe(-32601);
    expect(env.error?.message).toBe('Method not found');
    expect(env.result).toBeUndefined();
  });

  it('returns -32600 when message/send params are not an object', async () => {
    const env = (await handleA2ARequest(
      'message/send',
      'not-an-object',
    )) as A2AResponse;
    expect(env.error?.code).toBe(-32600);
    expect(env.error?.message).toBe('Invalid Request');
  });

  it('returns -32600 when tasks/get is given a non-string id', async () => {
    const env = (await handleA2ARequest('tasks/get', { id: 42 })) as A2AResponse;
    expect(env.error?.code).toBe(-32600);
  });

  it('returns -32001 when tasks/get cannot find the id', async () => {
    const env = (await handleA2ARequest('tasks/get', {
      id: 'stub-doesnotexist',
    })) as A2AResponse;
    expect(env.error?.code).toBe(-32001);
    expect(env.error?.message).toBe('Task not found');
  });

  it('echoes the supplied id through to the response envelope', async () => {
    const env = (await handleA2ARequest(
      'message/send',
      {
        message: { role: 'user', parts: [{ type: 'text', text: 'with id' }] },
      },
      'req-99',
    )) as A2AResponse;
    expect(env.id).toBe('req-99');
  });
});
