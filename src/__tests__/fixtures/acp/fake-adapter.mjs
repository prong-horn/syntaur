#!/usr/bin/env node
// A minimal ACP agent that speaks NDJSON JSON-RPC over stdio, used by
// `src/__tests__/chat-acp-client.test.ts` to prove the real-spawn path and the
// process-group teardown without touching a paid adapter.
//
// It answers `initialize`, `session/new`, and a `session/prompt` that streams
// three `agent_message_chunk`s plus one `tool_call`, and honours
// `session/cancel`. On `session/new` it spawns a `sleep` grandchild DETACHED —
// Node calls `setsid()` for `detached: true`, so the grandchild lands in its own
// session and process group. A `kill(-pgid)` of the adapter alone would leave it
// behind, which is exactly the case `close()`'s descendant walk has to catch.

import { spawn } from 'node:child_process';
import readline from 'node:readline';

const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
const notify = (method, params) => send({ jsonrpc: '2.0', method, params });
const reply = (id, result) => send({ jsonrpc: '2.0', id, result });

/** sessionId → true while a prompt is in flight and not yet cancelled. */
const running = new Map();
let grandchild = null;

function spawnGrandchild() {
  // `detached: true` makes Node call setsid(2): the child leads a new session
  // and process group, so `pgrep -g <adapter pid>` will never list it. There is
  // no `setsid` binary on macOS, which is why this goes through Node's own flag.
  grandchild = spawn('sleep', ['600'], { stdio: 'ignore', detached: true });
  // A spawn failure must not take the adapter down with an unhandled 'error'.
  grandchild.on('error', () => {});
  grandchild.unref();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

readline.createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', async (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params } = msg;

  if (method === 'initialize') {
    reply(id, {
      protocolVersion: 1,
      agentCapabilities: { loadSession: true },
      agentInfo: { name: 'fake-adapter', version: '9.9.9' },
      authMethods: [],
    });
    return;
  }

  if (method === 'session/new') {
    spawnGrandchild();
    // Report the grandchild pid so the test can assert it is gone after close().
    reply(id, { sessionId: 'fake-spawned-session', _meta: { grandchildPid: grandchild?.pid ?? null } });
    return;
  }

  if (method === 'session/prompt') {
    const sessionId = params.sessionId;
    running.set(sessionId, true);
    for (const text of ['Reading ', 'the ', 'file.']) {
      if (!running.get(sessionId)) break;
      notify('session/update', {
        sessionId,
        update: { sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: { type: 'text', text } },
      });
      await sleep(5);
    }
    if (running.get(sessionId)) {
      notify('session/update', {
        sessionId,
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 't1',
          title: 'Read package.json',
          kind: 'read',
          status: 'completed',
          content: [{ type: 'content', content: { type: 'text', text: 'ok' } }],
        },
      });
    }
    const wasCancelled = !running.get(sessionId);
    running.delete(sessionId);
    reply(id, { stopReason: wasCancelled ? 'cancelled' : 'end_turn' });
    return;
  }

  if (method === 'session/cancel') {
    running.set(params.sessionId, false);
    return;
  }

  if (id !== undefined) {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
  }
});

// Exit when the client closes stdin — the behaviour both real adapters have
// (spike row 20), and what makes a dying dashboard take its adapters with it.
process.stdin.on('end', () => process.exit(0));
