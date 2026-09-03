import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertAgentAttached,
  inProcessDispatcher,
  restDispatcher,
  readDashboardPort,
  DispatchError,
} from '../schedules/dispatch.js';
import type { ChatBroker } from '../chat/broker.js';
import type { ResolvedAssignment } from '../utils/assignment-resolver.js';
import { fakeDispatcher } from './schedules-helpers.js';

/**
 * Task 1 (Decision 3): what used to be launch-ack — polling a runtime marker for
 * proof an agent came up — is now "the chat accepted the message". These cover
 * the two backends the tick can be handed and the pre-send attachment check.
 */

const ASSIGNMENT: ResolvedAssignment = {
  assignmentDir: '/recs/a',
  projectSlug: 'p',
  assignmentSlug: 'a',
  id: 'a-uuid',
  standalone: false,
  workspaceGroup: null,
};

function brokerStub(overrides: Partial<ChatBroker> = {}): ChatBroker {
  return {
    send: async () => ({ messageId: 'msg-in-process' }),
    withdraw: async () => true,
    cancel: async () => true,
    answerPermission: async () => true,
    getSession: async () => null,
    listAgents: async () => ({ definitions: [], errors: [] }),
    getParticipants: async () => ({
      participants: { agents: ['planner', 'implementer'], defaultAgent: 'planner' },
      agents: [],
    }),
    setParticipants: async () => ({
      participants: { agents: [], defaultAgent: null },
      agents: [],
    }),
    items: () => [],
    reindex: async () => ({ events: 0, items: 0 }),
    stopAll: async () => {},
    ...overrides,
  } as ChatBroker;
}

describe('assertAgentAttached', () => {
  it('passes when the named agent is attached', async () => {
    await expect(
      assertAgentAttached(fakeDispatcher({ attached: ['planner'] }), 'a-1', 'planner'),
    ).resolves.toBeUndefined();
  });

  it('passes with no agent named as long as somebody is attached', async () => {
    await expect(
      assertAgentAttached(fakeDispatcher({ attached: ['planner'] }), 'a-1', null),
    ).resolves.toBeUndefined();
  });

  it('refuses an empty room, naming the assignment', async () => {
    await expect(
      assertAgentAttached(fakeDispatcher({ attached: [] }), 'a-1', null),
    ).rejects.toThrow(/no agent is attached to assignment a-1/);
  });

  it('refuses an agent the chat has not attached, listing who is', async () => {
    await expect(
      assertAgentAttached(fakeDispatcher({ attached: ['planner'] }), 'a-1', 'reviewer'),
    ).rejects.toThrow(/"reviewer" is not attached .* \(attached: planner\)/);
  });
});

describe('inProcessDispatcher', () => {
  const deps = (broker: ChatBroker) =>
    inProcessDispatcher({ broker, resolveAssignment: async (id) => (id === 'a-1' ? ASSIGNMENT : null) });

  it('sends through the broker and returns the minted messageId', async () => {
    const sent: Array<{ agentId?: string | null; text: string }> = [];
    const chat = deps(
      brokerStub({
        send: async ({ agentId, text }) => {
          sent.push({ agentId, text });
          return { messageId: 'msg-7' };
        },
      }),
    );
    expect(await chat.send('a-1', 'planner', 'go')).toBe('msg-7');
    expect(sent).toEqual([{ agentId: 'planner', text: 'go' }]);
  });

  it('reads the attached set from the participants file', async () => {
    expect(await deps(brokerStub()).attachedAgents('a-1')).toEqual(['planner', 'implementer']);
  });

  it('fails by name when the assignment does not resolve', async () => {
    await expect(deps(brokerStub()).send('nope', null, 'go')).rejects.toThrow(DispatchError);
  });
});

describe('restDispatcher', () => {
  it('treats a 202 with a messageId as the ack', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const chat = restDispatcher({
      port: 4321,
      fetch: (async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        return new Response(JSON.stringify({ messageId: 'msg-rest' }), { status: 202 });
      }) as unknown as typeof globalThis.fetch,
    });
    expect(await chat.send('a-1', 'planner', 'go')).toBe('msg-rest');
    expect(calls[0].url).toBe('http://127.0.0.1:4321/api/assignments/a-1/chat/messages');
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ text: 'go', agentId: 'planner' });
  });

  it('surfaces the dashboard’s own error text on a refusal', async () => {
    const chat = restDispatcher({
      port: 4321,
      fetch: (async () =>
        new Response(JSON.stringify({ error: 'workspace path invalid' }), {
          status: 400,
        })) as unknown as typeof globalThis.fetch,
    });
    await expect(chat.send('a-1', null, 'go')).rejects.toThrow(/workspace path invalid/);
  });

  it('says the dashboard is unreachable rather than throwing a raw fetch error', async () => {
    const chat = restDispatcher({
      port: 4321,
      fetch: (async () => {
        throw new Error('ECONNREFUSED');
      }) as unknown as typeof globalThis.fetch,
    });
    await expect(chat.attachedAgents('a-1')).rejects.toThrow(/not reachable/);
  });

  it('maps a 404 on the message-state route to null (unknown, not ended)', async () => {
    const chat = restDispatcher({
      port: 4321,
      fetch: (async () => new Response('{}', { status: 404 })) as unknown as typeof globalThis.fetch,
    });
    expect(await chat.messageState('a-1', 'msg-gone')).toBeNull();
  });

  it('reads back the message state', async () => {
    const chat = restDispatcher({
      port: 4321,
      fetch: (async () =>
        new Response(JSON.stringify({ state: 'ended', stopReason: 'end_turn' }), {
          status: 200,
        })) as unknown as typeof globalThis.fetch,
    });
    expect(await chat.messageState('a-1', 'msg-1')).toEqual({ state: 'ended', stopReason: 'end_turn' });
  });
});

describe('readDashboardPort', () => {
  it('reads the port file the server writes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'syntaur-port-'));
    try {
      await writeFile(join(dir, 'dashboard-port'), '5599\n', 'utf-8');
      expect(await readDashboardPort(dir)).toBe(5599);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('is null when the dashboard is not running (no file)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'syntaur-port-'));
    try {
      expect(await readDashboardPort(dir)).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('is null for a garbage port file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'syntaur-port-'));
    try {
      await writeFile(join(dir, 'dashboard-port'), 'not-a-port', 'utf-8');
      expect(await readDashboardPort(dir)).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
