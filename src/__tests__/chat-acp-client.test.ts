import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import * as acp from '@agentclientprotocol/sdk';
import {
  adapterVersion,
  connectAcpClient,
  descendants,
  groupMembers,
  spawnAcpClient,
} from '../chat/acp-client.js';
import {
  createFakeAgent,
  textChunk,
  toolCall,
  usageUpdate,
  type FakeStep,
} from '../chat/fake-agent.js';

/**
 * Task 1 — the ACP client wrapper.
 *
 * Protocol behaviour runs against the in-process fake agent (Decision 7); one
 * test spawns a real process (`fixtures/acp/fake-adapter.mjs`) to prove the
 * process-group teardown leaves no survivors, including a `setsid` grandchild
 * that is NOT in the adapter's process group.
 */

const FAKE_ADAPTER = fileURLToPath(new URL('./fixtures/acp/fake-adapter.mjs', import.meta.url));

function noPermissions(): Promise<acp.RequestPermissionResponse> {
  return Promise.resolve({ outcome: { outcome: 'cancelled' } });
}

const alive = (pid: number): boolean => {
  try {
    execFileSync('ps', ['-p', String(pid)], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

describe('connectAcpClient (in-process)', () => {
  it('initializes, opens a session and runs a prompt', async () => {
    const updates: acp.SessionNotification[] = [];
    const fake = createFakeAgent({
      agentInfo: { name: 'fake-acp-agent', version: '1.2.3' },
      turns: [
        {
          steps: [
            { kind: 'update', update: textChunk('Hello ', 'm1') },
            { kind: 'update', update: textChunk('world', 'm1') },
            { kind: 'update', update: usageUpdate(100, 1000, 0.17) },
          ],
          usage: { totalTokens: 30, inputTokens: 20, outputTokens: 10 },
        },
      ],
    });

    const client = connectAcpClient(fake.app, {
      onUpdate: (n) => updates.push(n),
      onPermissionRequest: noPermissions,
    });

    const init = await client.initialize();
    expect(init.agentInfo?.name).toBe('fake-acp-agent');
    expect(adapterVersion(init)).toBe('fake-acp-agent@1.2.3');

    const session = await client.newSession({ cwd: '/tmp/x' });
    expect(session.sessionId).toBe('fake-session-1');
    // Decision 6: no client capabilities are advertised.
    expect(fake.calls).toEqual(['initialize', 'session/new']);

    const res = await client.prompt(session.sessionId, [{ type: 'text', text: 'hi' }]);
    expect(res.stopReason).toBe('end_turn');
    expect(res.usage?.totalTokens).toBe(30);
    expect(updates).toHaveLength(3);
    expect(updates[0].update.sessionUpdate).toBe('agent_message_chunk');
    expect(client.pid).toBeNull();
    await client.close();
  });

  it('sends `_meta` and `mcpServers` on session/new verbatim', async () => {
    const fake = createFakeAgent();
    const client = connectAcpClient(fake.app, {
      onUpdate: () => {},
      onPermissionRequest: noPermissions,
    });
    await client.initialize();
    await client.newSession({
      cwd: '/tmp/x',
      _meta: { systemPrompt: { append: 'You are PLANNER.' } },
    });
    expect(fake.newSessionRequests[0].cwd).toBe('/tmp/x');
    expect(fake.newSessionRequests[0].mcpServers).toEqual([]);
    expect(fake.newSessionRequests[0]._meta).toEqual({ systemPrompt: { append: 'You are PLANNER.' } });
    await client.close();
  });

  it('routes a permission request to the handler and returns the answer', async () => {
    const seen: acp.RequestPermissionRequest[] = [];
    const step: FakeStep = {
      kind: 'permission',
      request: {
        toolCall: { toolCallId: 't1', title: 'Run `rm -rf /`' },
        options: [
          { optionId: 'yes', name: 'Allow', kind: 'allow_once' },
          { optionId: 'no', name: 'Deny', kind: 'reject_once' },
        ],
      },
    };
    const fake = createFakeAgent({ turns: [{ steps: [step] }] });
    const client = connectAcpClient(fake.app, {
      onUpdate: () => {},
      onPermissionRequest: async (req) => {
        seen.push(req);
        return { outcome: { outcome: 'selected', optionId: 'no' } };
      },
    });
    await client.initialize();
    const s = await client.newSession({ cwd: '/tmp/x' });
    await client.prompt(s.sessionId, [{ type: 'text', text: 'go' }]);
    expect(seen).toHaveLength(1);
    expect(seen[0].toolCall.title).toBe('Run `rm -rf /`');
    expect(fake.permissionAnswers[0]).toEqual({ outcome: { outcome: 'selected', optionId: 'no' } });
    await client.close();
  });

  it('cancel resolves the in-flight prompt as cancelled', async () => {
    const fake = createFakeAgent({ turns: [{ steps: [{ kind: 'awaitCancel' }] }] });
    const client = connectAcpClient(fake.app, {
      onUpdate: () => {},
      onPermissionRequest: noPermissions,
    });
    await client.initialize();
    const s = await client.newSession({ cwd: '/tmp/x' });
    const pending = client.prompt(s.sessionId, [{ type: 'text', text: 'essay' }]);
    await client.cancel(s.sessionId);
    await expect(pending).resolves.toMatchObject({ stopReason: 'cancelled' });
    await client.close();
  });

  it('resume and load reach the agent; a failing resume rejects', async () => {
    const replayed: acp.SessionNotification[] = [];
    const fake = createFakeAgent({ loadReplay: [textChunk('replayed', 'r1')] });
    const client = connectAcpClient(fake.app, {
      onUpdate: (n) => replayed.push(n),
      onPermissionRequest: noPermissions,
    });
    await client.initialize();
    await client.resumeSession('sess-1', '/tmp/x');
    await client.loadSession('sess-1', '/tmp/x');
    expect(fake.calls).toEqual(['initialize', 'session/resume', 'session/load']);
    expect(replayed).toHaveLength(1);
    await client.close();

    const failing = createFakeAgent({ resumeError: 'session not found' });
    const c2 = connectAcpClient(failing.app, {
      onUpdate: () => {},
      onPermissionRequest: noPermissions,
    });
    await c2.initialize();
    await expect(c2.resumeSession('gone', '/tmp/x')).rejects.toThrow(/session not found/);
    await c2.close();
  });

  it('applies pinned mode and config options', async () => {
    const fake = createFakeAgent();
    const client = connectAcpClient(fake.app, {
      onUpdate: () => {},
      onPermissionRequest: noPermissions,
    });
    await client.initialize();
    const s = await client.newSession({ cwd: '/tmp/x' });
    await client.setMode(s.sessionId, 'plan');
    await client.setConfigOption(s.sessionId, 'effort', 'high');
    expect(fake.configCalls.map((c) => c.method)).toEqual([
      'session/set_mode',
      'session/set_config_option',
    ]);
    expect(fake.configCalls[0].params).toMatchObject({ modeId: 'plan' });
    expect(fake.configCalls[1].params).toMatchObject({ configId: 'effort', value: 'high' });
    await client.close();
  });

  it('surfaces a tool call through onUpdate untouched', async () => {
    const updates: acp.SessionNotification[] = [];
    const fake = createFakeAgent({
      turns: [{ steps: [{ kind: 'update', update: toolCall('t1', { kind: 'edit', status: 'completed' }) }] }],
    });
    const client = connectAcpClient(fake.app, {
      onUpdate: (n) => updates.push(n),
      onPermissionRequest: noPermissions,
    });
    await client.initialize();
    const s = await client.newSession({ cwd: '/tmp/x' });
    await client.prompt(s.sessionId, [{ type: 'text', text: 'edit' }]);
    expect(updates[0].update).toMatchObject({
      sessionUpdate: 'tool_call',
      toolCallId: 't1',
      kind: 'edit',
      status: 'completed',
    });
    await client.close();
  });
});

describe('spawnAcpClient (real process)', () => {
  it('drives a spawned adapter and leaves no survivors after close()', async () => {
    const updates: acp.SessionNotification[] = [];
    const client = spawnAcpClient({
      command: process.execPath,
      args: [FAKE_ADAPTER],
      cwd: process.cwd(),
      onUpdate: (n) => updates.push(n),
      onPermissionRequest: noPermissions,
    });

    const init = await client.initialize();
    expect(init.agentInfo?.version).toBe('9.9.9');
    expect(client.pid).toBeGreaterThan(0);
    expect(client.alive()).toBe(true);

    const session = await client.newSession({ cwd: process.cwd() });
    expect(session.sessionId).toBe('fake-spawned-session');
    const grandchildPid = (session._meta as { grandchildPid?: number } | undefined)?.grandchildPid;
    expect(typeof grandchildPid).toBe('number');

    const res = await client.prompt(session.sessionId, [{ type: 'text', text: 'read it' }]);
    expect(res.stopReason).toBe('end_turn');
    expect(updates.filter((u) => u.update.sessionUpdate === 'agent_message_chunk')).toHaveLength(3);
    expect(updates.filter((u) => u.update.sessionUpdate === 'tool_call')).toHaveLength(1);

    // The `setsid` grandchild is deliberately outside the adapter's process
    // group — a `kill(-pgid)` alone would miss it.
    const pid = client.pid!;
    expect(groupMembers(pid).some((m) => m.pid === grandchildPid)).toBe(false);
    expect(descendants(pid).some((d) => d.pid === grandchildPid)).toBe(true);

    await client.close();

    expect(client.alive()).toBe(false);
    expect(groupMembers(pid)).toEqual([]);
    expect(alive(pid)).toBe(false);
    expect(alive(grandchildPid as number)).toBe(false);
  });

  it('cancels an in-flight prompt on a spawned adapter', async () => {
    const client = spawnAcpClient({
      command: process.execPath,
      args: [FAKE_ADAPTER],
      cwd: process.cwd(),
      onUpdate: () => {},
      onPermissionRequest: noPermissions,
    });
    await client.initialize();
    const s = await client.newSession({ cwd: process.cwd() });
    const pending = client.prompt(s.sessionId, [{ type: 'text', text: 'go' }]);
    await client.cancel(s.sessionId);
    const res = await pending;
    expect(['cancelled', 'end_turn']).toContain(res.stopReason);
    await client.close();
    expect(client.alive()).toBe(false);
  });

  it('captures stderr into a bounded buffer and reports a dead adapter', async () => {
    const client = spawnAcpClient({
      command: process.execPath,
      args: ['-e', 'process.stderr.write("boom\\n"); process.exit(3);'],
      cwd: process.cwd(),
      onUpdate: () => {},
      onPermissionRequest: noPermissions,
    });
    const exit = await client.exit;
    expect(exit.code).toBe(3);
    expect(client.stderr()).toContain('boom');
    expect(client.alive()).toBe(false);
    await client.close();
  });
});
