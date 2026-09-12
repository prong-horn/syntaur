// Task 0 cursor measurement probe: five short live turns against cursor-agent acp.
// Usage: node cursor-probe.ts [--run <name>]
// Writes out/<run>/{03,06,08,09,14}.cursor.ndjson + findings.json under the job tmp dir.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  Harness,
  preflight,
  redactEmails,
  allowAll,
  selected,
  pickOption,
  type CollectedUpdate,
} from './harness.ts';

const here = path.dirname(new URL(import.meta.url).pathname);
const workDir = '/Users/brennen/.claude/jobs/747ca5b9/tmp/cursor-impl-harness/work';
const args = process.argv.slice(2);
const flag = (name: string, dflt?: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const runName = flag('run') ?? 'cursor-task0-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const runDir = path.join(here, 'out', runName);
fs.mkdirSync(runDir, { recursive: true });

const SYSTEM_PROMPT = 'You are PLANNER. Start every reply with the exact token "PLANNER:" (uppercase, followed by a colon).';
const CODE_WORD = 'XYZZY-PROBE';

const kinds = (list: CollectedUpdate[]) => {
  const c: Record<string, number> = {};
  for (const u of list) c[u.update.sessionUpdate] = (c[u.update.sessionUpdate] ?? 0) + 1;
  return c;
};

function replyText(h: Harness, list: CollectedUpdate[]): string {
  const chunks = h.updatesOfKind('agent_message_chunk', list);
  const withId = chunks.filter((u) => (u.update as { messageId?: string }).messageId != null);
  return (withId.length ? withId : chunks)
    .map((u) => (u.update.content.type === 'text' ? u.update.content.text : ''))
    .join('');
}

const pre = preflight(['cursor']);
fs.writeFileSync(path.join(runDir, 'preflight.json'), JSON.stringify(pre, null, 2));
console.log('preflight:', JSON.stringify(pre));

const [target, sourceCommit] = execFileSync(path.join(here, 'target.sh'), ['target-cursor'], { encoding: 'utf8' }).trim().split(' ');
console.log(`target=${target} @ ${sourceCommit.slice(0, 12)}`);

const findings: Record<string, unknown> = {
  measured: new Date().toISOString(),
  sourceCommit,
  cursorAgent: pre['cursor-agent'],
  sdk: pre['@agentclientprotocol/sdk'],
};

async function runScenario(
  id: string,
  title: string,
  fn: (h: Harness) => Promise<Record<string, unknown>>,
): Promise<void> {
  console.log(`\n=== ${id} — ${title}`);
  const h = await Harness.spawn({
    adapter: 'cursor',
    cwd: target,
    runDir,
    scenario: id,
    policy: allowAll,
  });
  try {
    await h.initialize();
    const result = await fn(h);
    findings[id] = result;
    console.log('  findings:', JSON.stringify(result, null, 2));
  } finally {
    await h.close();
  }
}

// (a) System prompt transport
await runScenario('03-system-prompt', 'System prompt via _meta.systemPrompt.append', async (h) => {
  const s = await h.newSession({ _meta: { systemPrompt: { append: SYSTEM_PROMPT } } } as Parameters<Harness['newSession']>[0]);
  const r = await h.prompt(s.sessionId, `What is the secret code word? Reply with only the code word. (Hint: it is embedded in your instructions.)`);
  const text = replyText(h, r.updates).trim();
  const metaHonored = text.includes('PLANNER') || text.toUpperCase().includes('PLANNER');
  // Also test codex-style prepend if meta fails
  let prependWorks = false;
  if (!metaHonored) {
    const s2 = await h.newSession();
    const r2 = await h.prompt(s2.sessionId, `<system>\n${SYSTEM_PROMPT}\n</system>\n\nWho are you? One sentence.`);
    const t2 = replyText(h, r2.updates).trim();
    prependWorks = t2.startsWith('PLANNER:');
  }
  const transport = metaHonored ? 'meta' : prependWorks ? 'prompt' : 'unknown';
  return {
    systemPromptTransport: transport,
    metaHonored,
    prependWorks,
    replySnippet: text.slice(0, 120),
    updateKinds: kinds(r.updates),
  };
});

// (b) Agent mode edit + permissions + usage
let agentSessionId = '';
await runScenario('06-edits-permissions', 'Agent mode edit + permission + usage', async (h) => {
  const s = await h.newSession();
  agentSessionId = s.sessionId;
  await h.setMode(s.sessionId, 'agent');
  const scratchFile = path.join(target, 'cursor-probe-scratch.txt');
  fs.writeFileSync(scratchFile, 'before\n');
  const r = await h.prompt(
    s.sessionId,
    `Add a line "after" as the second line of cursor-probe-scratch.txt in the repo root. Do nothing else.`,
  );
  const usageUpdates = h.updatesOfKind('usage_update', r.updates);
  const permOpts = h.permissions.map((p) =>
    p.request.options.map((o) => ({ kind: o.kind, optionId: o.optionId, name: o.name })),
  );
  const fileContent = fs.existsSync(scratchFile) ? fs.readFileSync(scratchFile, 'utf8') : null;
  return {
    stopReason: r.response.stopReason,
    updateKinds: kinds(r.updates),
    usageUpdateCount: usageUpdates.length,
    usageUpdates: usageUpdates.map((u) => u.update),
    permissionOptions: permOpts,
    fileEdited: fileContent?.includes('after') ?? false,
    sessionId: s.sessionId,
  };
});

// (c) Plan mode — cursor/create_plan
await runScenario('08-create-plan', 'Plan mode create_plan extension', async (h) => {
  const s = await h.newSession();
  await h.setMode(s.sessionId, 'plan');
  const promptP = h.prompt(s.sessionId, 'Make a brief plan for adding t hello-world function to this repo. Keep it to 3 steps.');
  // Wait for create_plan request, record params, accept
  await new Promise<void>((resolve, reject) => {
    const deadline = Date.now() + 120_000;
    const poll = setInterval(() => {
      const req = h.extRequests.find((e) => e.method === 'cursor/create_plan');
      if (req && h.pendingCreatePlan) {
        clearInterval(poll);
        h.pendingCreatePlan!({ accepted: true });
        resolve();
      } else if (Date.now() > deadline) {
        clearInterval(poll);
        reject(new Error('timeout waiting for cursor/create_plan'));
      }
    }, 50);
  });
  const r = await promptP;
  const createPlanReq = h.extRequests.find((e) => e.method === 'cursor/create_plan');
  return {
    stopReason: r.response.stopReason,
    createPlanParams: createPlanReq?.params,
    createPlanResponse: createPlanReq?.response,
    updateKinds: kinds(r.updates),
    extNotifications: h.extNotifications.map((n) => ({ method: n.method, keys: Object.keys(n.params as object) })),
  };
});

// (d) ask_question round trip
await runScenario('09-ask-question', 'ask_question extension', async (h) => {
  const s = await h.newSession();
  await h.setMode(s.sessionId, 'agent');
  const promptP = h.prompt(
    s.sessionId,
    'Before doing tnything, ask me which option I prefer: A or B. Use your ask_question tool. Do not proceed until I answer.',
  );
  // Wait for ask_question, answer with first option
  await new Promise<void>((resolve) => {
    const poll = setInterval(() => {
      const req = h.extRequests.find((e) => e.method === 'cursor/ask_question');
      if (req && h.pendingAskQuestion) {
        clearInterval(poll);
        const params = req.params as { options?: Array<{ id: string; label?: string }> };
        const firstId = params.options?.[0]?.id ?? 'A';
        h.pendingAskQuestion!({ selection: firstId });
        resolve();
      }
    }, 50);
    setTimeout(() => { clearInterval(poll); resolve(); }, 120_000);
  });
  const r = await promptP;
  const askReq = h.extRequests.find((e) => e.method === 'cursor/ask_question');
  return {
    stopReason: r.response.stopReason,
    askQuestionParams: askReq?.params,
    askQuestionResponse: askReq?.response,
    updateKinds: kinds(r.updates),
    replySnippet: replyText(h, r.updates).slice(0, 200),
  };
});

// (e) session/load replay
await runScenario('14-session-load', 'session/load replay', async (h) => {
  const loadFrom = agentSessionId;
  if (!loadFrom) throw new Error('no session id from scenario 06');
  const h2 = await Harness.spawn({
    adapter: 'cursor',
    cwd: target,
    runDir,
    scenario: '14-session-load',
    label: 'load',
    policy: allowAll,
  });
  try {
    await h2.initialize();
    const from = h2.updates.length;
    const loadRes = await h2.loadSession(loadFrom);
    const replayUpdates = h2.updates.slice(from);
    const replayKinds = kinds(replayUpdates);
    return {
      loadResponseKeys: Object.keys(loadRes as object),
      replayUpdateKinds: replayKinds,
      replayCount: replayUpdates.length,
      modes: loadRes.modes?.currentModeId,
      configOptions: loadRes.configOptions?.map((c) => c.id),
    };
  } finally {
    await h2.close();
  }
});

// Write findings (redacted)
const findingsPath = path.join(workDir, 'cursor-task0-findings.json');
fs.writeFileSync(findingsPath, redactEmails(JSON.stringify(findings, null, 2)));
console.log(`\nfindings written to ${findingsPath}`);
console.log(redactEmails(JSON.stringify(findings, null, 2)));
