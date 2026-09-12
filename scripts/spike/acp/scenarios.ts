// Spike scenarios 2–19 from claude-info/plans/ticket-chat-design.md §5.9a.
// Each scenario spawns its own adapter(s) via ctx.spawn, prompts, and records
// notes/metrics; `pass` is null for observation-only rows.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type * as acp from '@agentclientprotocol/sdk';
import {
  Harness,
  allowAll,
  allowFirstRejectRest,
  cancelledOutcome,
  holdForever,
  sleep,
  withTimeout,
  type Adapter,
  type CollectedUpdate,
  type SpawnOptions,
} from './harness.ts';

export interface Ctx {
  adapter: Adapter;
  runDir: string;
  target: string; // cwd for the adapter (fresh clone of this repo)
  spawn(label?: string, opts?: Partial<SpawnOptions>): Promise<Harness>;
  note(s: string): void;
  metric(k: string, v: unknown): void;
}

export interface Scenario {
  id: string; // "<nn>-<slug>"
  title: string;
  adapters: Adapter[];
  run(ctx: Ctx): Promise<boolean | null>;
}

const SYSTEM_PROMPT = 'You are PLANNER. Start every reply with the exact token "PLANNER:" (uppercase, followed by a colon).';
const CODEX_ENV_SCRUB = ['OPENAI_API_KEY', 'CODEX_API_KEY', 'DEFAULT_AUTH_REQUEST', 'MODEL_PROVIDER', 'CODEX_CONFIG'];
const CLAUDE_ENV_SCRUB = ['ANTHROPIC_API_KEY'];
export const envScrub = (a: Adapter) => (a === 'codex' ? CODEX_ENV_SCRUB : CLAUDE_ENV_SCRUB);

/**
 * Mode ids that mean "auto-approve edits" / "ask the client" per adapter. codex-acp 1.7 routes approvals by
 * mode: `read-only` ("Ask for approval", approvalsReviewer=user) sends `session/request_permission` to the
 * client; `agent` ("Approve for me", approvalsReviewer=auto_review) hands escalations to codex's Guardian
 * reviewer instead, so the client never sees a request; `agent-full-access` never asks. All three keep a
 * workspace-write sandbox — `read-only` is a label, not a sandbox policy.
 */
const MODES: Record<Adapter, { edits: string; ask: string; plan: string }> = {
  claude: { edits: 'acceptEdits', ask: 'default', plan: 'plan' },
  codex: { edits: 'agent', ask: 'read-only', plan: 'read-only' },
};

/** codex-acp has no _meta.systemPrompt: prepend a <system> section to the first prompt instead. */
function firstPrompt(adapter: Adapter, text: string): string {
  return adapter === 'claude' ? text : `<system>\n${SYSTEM_PROMPT}\n</system>\n\n${text}`;
}

const kinds = (list: CollectedUpdate[]) => {
  const c: Record<string, number> = {};
  for (const u of list) c[u.update.sessionUpdate] = (c[u.update.sessionUpdate] ?? 0) + 1;
  return c;
};

const toolCalls = (h: Harness, list = h.updates) => h.updatesOfKind('tool_call', list);

const here = path.dirname(new URL(import.meta.url).pathname);
/** Outside both the target cwd and /tmp, so a write here needs approval under any sandbox that has one. */
const permDir = path.join(here, 'out', 'perm');

/**
 * Text of the agent's actual reply. codex-acp 1.7 forwards runtime notices ("Warning: Skill descriptions were
 * shortened…") as agent_message_chunks that carry no messageId; real reply chunks always carry one on both adapters.
 */
function replyText(h: Harness, list: CollectedUpdate[]): string {
  const chunks = h.updatesOfKind('agent_message_chunk', list);
  const withId = chunks.filter((u) => (u.update as any).messageId != null);
  return (withId.length ? withId : chunks)
    .map((u) => (u.update.content.type === 'text' ? u.update.content.text : ''))
    .join('');
}
/** Chunks without a messageId (adapter notices leaked into the agent text stream). */
function leakedNotices(h: Harness, list: CollectedUpdate[]): string[] {
  return h.updatesOfKind('agent_message_chunk', list)
    .filter((u) => (u.update as any).messageId == null && u.update.content.type === 'text')
    .map((u) => (u.update.content as any).text.slice(0, 80));
}
const toolUpdates = (h: Harness, list = h.updates) => h.updatesOfKind('tool_call_update', list);

/** Characters a renderer could actually show from tool-call content blocks (text and diffs; a `terminal` ref is not text). */
const blockChars = (blocks: acp.ToolCallContent[] | null | undefined) =>
  (blocks ?? []).reduce(
    (n, b) =>
      n +
      (b.type === 'content' && b.content.type === 'text' ? b.content.text.length
        : b.type === 'diff' ? (b.oldText?.length ?? 0) + b.newText.length
        : 0),
    0,
  );
/** Characters of string values anywhere inside rawInput/rawOutput (codex reports through rawOutput.formatted_output). */
const rawChars = (raw: unknown): number =>
  typeof raw === 'string' ? raw.length
    : raw && typeof raw === 'object' ? Object.values(raw as Record<string, unknown>).reduce<number>((n, v) => n + rawChars(v), 0)
    : 0;

/** Resolve a prompt with a bound, reporting either the stop reason or the timeout/error. */
async function settleStop(p: Promise<acp.PromptResponse>, timeoutMs = 30_000): Promise<{ stop?: string; err?: string }> {
  try {
    return { stop: (await withTimeout(p, timeoutMs, 'prompt after cancel')).stopReason };
  } catch (e) {
    return { err: (e as Error).message.slice(0, 200) };
  }
}

function git(target: string, ...args: string[]): string {
  return execFileSync('git', ['-C', target, ...args], { encoding: 'utf8' }).trim();
}

async function initAndNew(h: Harness, ctx: Ctx, extra: Partial<acp.NewSessionRequest> = {}) {
  const init = await h.initialize();
  const s = await h.newSession(extra);
  ctx.metric('currentModeId', s.modes?.currentModeId ?? null);
  return { init, s };
}

export const scenarios: Scenario[] = [
  {
    id: '02-handshake',
    title: 'Handshake + trivial prompt',
    adapters: ['claude', 'codex'],
    async run(ctx) {
      const h = await ctx.spawn();
      const init = await h.initialize();
      ctx.metric('initialize', init);
      const caps = init.agentCapabilities ?? {};
      const sc = (caps.sessionCapabilities ?? {}) as Record<string, unknown>;
      const capMeta = (caps._meta ?? {}) as Record<string, any>;
      const topMeta = ((init as any)._meta ?? {}) as Record<string, any>; // steering lives here, not under agentCapabilities
      ctx.note(`agentInfo=${JSON.stringify(init.agentInfo)}`);
      ctx.note(`loadSession=${caps.loadSession} sessionCapabilities=${Object.keys(sc).join(',')}`);
      ctx.note(`agentCapabilities._meta=${JSON.stringify(capMeta)} initialize._meta keys=${Object.keys(topMeta).join(',')}`);
      const s = await h.newSession();
      ctx.note(`modes=${JSON.stringify(s.modes?.availableModes?.map((m) => m.id))} current=${s.modes?.currentModeId}`);
      ctx.note(`configOptions=${JSON.stringify(s.configOptions?.map((c) => c.id))}`);
      ctx.metric('newSession', s);
      const r = await h.prompt(s.sessionId, 'Reply with exactly the single word PONG and nothing else.');
      const text = h.agentText(r.updates);
      ctx.note(`stop=${r.response.stopReason} text=${JSON.stringify(text)} ms=${r.ms} updates=${JSON.stringify(kinds(r.updates))}`);
      // codex-acp registers a private, unprefixed `authentication/status` (not in ACP 1.4); claude-agent-acp should reject it.
      let authType: string | undefined;
      try {
        const a = (await withTimeout(h.ext('authentication/status'), 15_000, 'authentication/status')) as Record<string, unknown>;
        authType = String(a.type);
        ctx.note(`authentication/status → type=${authType} keys=${Object.keys(a).join(',')} (values redacted in the transcript)`);
      } catch (e) {
        ctx.note(`authentication/status → ${(e as Error).message.slice(0, 120)}`);
      }
      ctx.metric('authStatusType', authType ?? null);
      ctx.metric('authMethods', init.authMethods);
      const ok =
        caps.loadSession === true &&
        'resume' in sc &&
        'list' in sc &&
        'close' in sc &&
        (ctx.adapter === 'codex' ? authType === 'chat-gpt' : 'fork' in sc && topMeta.steering?.supported === true && capMeta.claudeCode?.promptQueueing === true) &&
        /PONG/.test(text) &&
        r.response.stopReason === 'end_turn';
      await h.close();
      return ok;
    },
  },
  {
    id: '03-system-prompt',
    title: 'System prompt transport',
    adapters: ['claude', 'codex'],
    async run(ctx) {
      const h = await ctx.spawn();
      await h.initialize();
      const ask = 'Who are you? Answer in one sentence.';
      // A: _meta.systemPrompt on session/new (claude supports it; codex is expected to ignore it)
      const a = await h.newSession({ _meta: { systemPrompt: { append: SYSTEM_PROMPT } } } as any);
      ctx.metric('modes', a.modes);
      ctx.metric('configOptions', a.configOptions);
      const ra = await h.prompt(a.sessionId, ask);
      const ta = replyText(h, ra.updates).trim();
      ctx.note(`_meta.systemPrompt → ${JSON.stringify(ta.slice(0, 120))}`);
      const leaks = leakedNotices(h, ra.updates);
      if (leaks.length) ctx.note(`agent_message_chunks without messageId (adapter notices): ${JSON.stringify(leaks)}`);
      ctx.metric('leakedNotices', leaks);
      const metaWorks = ta.startsWith('PLANNER:');
      let ok = metaWorks;
      if (ctx.adapter === 'codex') {
        // B: <system> section prepended to the first prompt
        const b = await h.newSession();
        const rb = await h.prompt(b.sessionId, firstPrompt('codex', ask));
        const tb = replyText(h, rb.updates).trim();
        ctx.note(`<system> prepend → ${JSON.stringify(tb.slice(0, 120))}`);
        // does it stick on a second, plain prompt?
        const rc = await h.prompt(b.sessionId, 'What is 2+2? One line.');
        const tc = replyText(h, rc.updates).trim();
        ctx.note(`second plain prompt → ${JSON.stringify(tc.slice(0, 120))}`);
        ctx.metric('metaSystemPromptHonored', metaWorks);
        ok = tb.startsWith('PLANNER:') && tc.startsWith('PLANNER:');
      } else {
        const rc = await h.prompt(a.sessionId, 'What is 2+2? One line.');
        const tc = replyText(h, rc.updates).trim();
        ctx.note(`second prompt → ${JSON.stringify(tc.slice(0, 120))}`);
        const modeIds = a.modes?.availableModes?.map((m) => m.id) ?? [];
        const cfgIds = a.configOptions?.map((c) => c.id) ?? [];
        ok = ok && tc.startsWith('PLANNER:') && ['plan', 'acceptEdits', 'bypassPermissions', 'default', 'dontAsk'].every((m) => modeIds.includes(m)) && cfgIds.includes('model') && cfgIds.includes('effort');
      }
      await h.close();
      return ok;
    },
  },
  {
    id: '04-streaming',
    title: 'Streaming / coalescing',
    adapters: ['claude', 'codex'],
    async run(ctx) {
      const h = await ctx.spawn(undefined, { quiet: true });
      const { s } = await initAndNew(h, ctx);
      const r = await h.prompt(
        s.sessionId,
        'Write three short paragraphs about the JSON-RPC protocol. Put a markdown H2 heading above each paragraph, and end with a bullet list of three related protocols. Use markdown.',
      );
      const chunks = h.updatesOfKind('agent_message_chunk', r.updates);
      const text = h.agentText(r.updates);
      const times = chunks.map((c) => Date.parse(c.ts));
      const spreadMs = times.length ? times[times.length - 1] - times[0] : 0;
      const withId = chunks.filter((c) => c.update.messageId != null).length;
      const last = chunks.at(-1)?.update.content;
      const lastLen = last?.type === 'text' ? last.text.length : 0;
      const cumulative = chunks.length > 1 && lastLen === text.length;
      ctx.metric('chunks', chunks.length);
      ctx.metric('spreadMs', spreadMs);
      ctx.metric('messageIdChunks', withId);
      ctx.metric('messageIds', [...new Set(chunks.map((c) => c.update.messageId).filter(Boolean))]);
      ctx.metric('avgChunkChars', chunks.length ? Math.round(text.length / chunks.length) : 0);
      ctx.note(`chunks=${chunks.length} over ${spreadMs}ms; messageId on ${withId}/${chunks.length}; deltas=${!cumulative}; headings=${(text.match(/^## /gm) ?? []).length}; bullets=${(text.match(/^[-*] /gm) ?? []).length}`);
      fs.writeFileSync(path.join(ctx.runDir, `04-streaming.${ctx.adapter}.md`), text);
      await h.close();
      return chunks.length >= 3 && spreadMs > 100 && !cumulative && /^## /m.test(text) && /^[-*] /m.test(text);
    },
  },
  {
    id: '05-tool-calls',
    title: 'Tool calls (read + search)',
    adapters: ['claude', 'codex'],
    async run(ctx) {
      const h = await ctx.spawn();
      const { s } = await initAndNew(h, ctx);
      const r = await h.prompt(
        s.sessionId,
        'Two read-only tasks in the current working directory (a local checkout; do not use GitHub, network, or REPL tools). First, read package.json and tell me the value of its "version" field. Second, search this repository for the string createDashboardServer and list every file path that contains it. Use a separate tool call or shell command for each task (do not chain them into one command). Do not modify anything.',
      );
      const calls = toolCalls(h, r.updates);
      const ups = toolUpdates(h, r.updates);
      const byId = new Map<string, { title: string; kind?: string; statuses: string[]; content: number; locations: number; rawInput: boolean; rawOutput: boolean; renderedChars: number }>();
      for (const c of calls) {
        byId.set(c.update.toolCallId, {
          title: c.update.title,
          kind: c.update.kind ?? undefined,
          statuses: [c.update.status ?? 'pending'],
          content: c.update.content?.length ?? 0,
          locations: c.update.locations?.length ?? 0,
          rawInput: c.update.rawInput != null,
          rawOutput: c.update.rawOutput != null,
          renderedChars: blockChars(c.update.content) + rawChars(c.update.rawOutput),
        });
      }
      for (const u of ups) {
        const e = byId.get(u.update.toolCallId);
        if (!e) continue;
        if (u.update.status) e.statuses.push(u.update.status);
        e.content += u.update.content?.length ?? 0;
        e.locations += u.update.locations?.length ?? 0;
        e.rawInput ||= u.update.rawInput != null;
        e.rawOutput ||= u.update.rawOutput != null;
        e.renderedChars += blockChars(u.update.content) + rawChars(u.update.rawOutput);
      }
      // narration: agent text (real reply chunks only — see replyText) between the previous update and each tool_call
      const narration: string[] = [];
      let buf = '';
      for (const u of r.updates) {
        if (u.update.sessionUpdate === 'agent_message_chunk' && u.update.content.type === 'text' && (u.update as any).messageId != null) buf += u.update.content.text;
        else if (u.update.sessionUpdate === 'tool_call') {
          narration.push(buf.trim());
          buf = '';
        }
      }
      ctx.metric('toolCalls', Object.fromEntries(byId));
      ctx.metric('narrationBeforeToolCalls', narration);
      for (const [id, e] of byId) ctx.note(`${id}: kind=${e.kind} "${e.title}" ${e.statuses.join('→')} content=${e.content} locations=${e.locations} rawInput=${e.rawInput} rawOutput=${e.rawOutput} renderedChars=${e.renderedChars}`);
      ctx.note(`narration lengths=${JSON.stringify(narration.map((n) => n.length))}`);
      ctx.note(`text=${JSON.stringify(h.agentText(r.updates).slice(0, 200))}`);
      const kindSet = new Set([...byId.values()].map((e) => e.kind));
      const entries = [...byId.values()];
      // Pass on what a chat renderer needs from every tool call: a terminal status, an id/kind/title, and
      // something to show (non-empty text in content blocks or in rawOutput), plus a search-shaped call —
      // and on the calls having done the job: the final reply names the target's package.json version and
      // at least one file that really contains createDashboardServer. Everything else in §5.9a step 5 is
      // RECORDED per adapter, not required: claude-agent-acp 0.70 goes pending → completed (never
      // in_progress) and puts content+rawInput+rawOutput+locations on every call; codex-acp 1.7 parses shell
      // commands into read/search/execute calls that carry only title (+locations for read, +terminal
      // content/rawInput for unparsed commands) and report through rawOutput.formatted_output.
      const inProgressSeen = entries.some((e) => e.statuses.includes('in_progress'));
      const version = JSON.parse(fs.readFileSync(path.join(ctx.target, 'package.json'), 'utf8')).version as string;
      const hits = git(ctx.target, 'grep', '-l', 'createDashboardServer').split('\n').filter(Boolean);
      const reply = replyText(h, r.updates);
      const pathsInReply = hits.filter((f) => reply.includes(f) || reply.includes(path.basename(f)));
      ctx.metric('coverage', { version, versionInReply: reply.includes(version), hits: hits.length, pathsInReply });
      const checks = {
        twoCalls: calls.length >= 2,
        allCompleted: entries.every((e) => e.statuses.at(-1) === 'completed'),
        allTitled: entries.every((e) => typeof e.title === 'string' && e.title.length > 0 && typeof e.kind === 'string'),
        allRenderable: entries.every((e) => e.renderedChars > 0),
        searchKind: kindSet.has('search') || kindSet.has('execute'),
        versionReported: reply.includes(version),
        searchHitReported: pathsInReply.length > 0,
      };
      const recorded = {
        inProgressSeen,
        allContent: entries.every((e) => e.content > 0),
        allRawInput: entries.every((e) => e.rawInput),
        allRawOutput: entries.every((e) => e.rawOutput),
        readKind: kindSet.has('read'),
        locations: entries.some((e) => e.locations > 0),
      };
      ctx.metric('checks', checks);
      ctx.metric('recorded', recorded);
      ctx.note(`checks=${JSON.stringify(checks)}`);
      ctx.note(`recorded (not required)=${JSON.stringify(recorded)}`);
      const ok = Object.values(checks).every(Boolean);
      ctx.note(`search tool kind used: ${kindSet.has('search') ? 'search' : kindSet.has('execute') ? 'execute (agent chose a shell grep)' : 'none'}`);
      await h.close();
      return ok;
    },
  },
  {
    id: '06-edits',
    title: 'Edits / diffs in auto-accept mode',
    adapters: ['claude', 'codex'],
    async run(ctx) {
      const h = await ctx.spawn();
      const { s } = await initAndNew(h, ctx);
      await h.setMode(s.sessionId, MODES[ctx.adapter].edits);
      const marker = `<!-- acp-spike: edited by ${ctx.adapter} -->`;
      const r = await h.prompt(s.sessionId, `Insert the line ${marker} as the very first line of README.md, above the existing first line \`# Syntaur\` (keep everything else exactly as is). Make only that change, then reply DONE.`);
      const calls = toolCalls(h, r.updates);
      const ups = toolUpdates(h, r.updates);
      const diffs = [...calls, ...ups].flatMap((u) => (u.update.content ?? []).filter((c) => c.type === 'diff'));
      const editCalls = calls.filter((c) => c.update.kind === 'edit');
      const onDisk = fs.readFileSync(path.join(ctx.target, 'README.md'), 'utf8').split('\n')[0] === marker;
      const status = git(ctx.target, 'status', '--porcelain');
      ctx.metric('editCalls', editCalls.map((c) => ({ title: c.update.title, kind: c.update.kind, status: c.update.status })));
      ctx.metric('diffs', diffs.map((d: any) => ({ path: d.path, oldLen: d.oldText?.length ?? null, newLen: d.newText?.length ?? null })));
      ctx.metric('permissionRequests', h.permissions.length);
      ctx.note(`edit tool_calls=${editCalls.length} diffs=${diffs.length} permissions=${h.permissions.length} onDisk=${onDisk} gitStatus=${JSON.stringify(status)}`);
      ctx.note(`kinds seen=${JSON.stringify([...new Set(calls.map((c) => c.update.kind))])}`);
      const editIds = new Set(editCalls.map((c) => c.update.toolCallId));
      const editCompleted = ups.some((u) => editIds.has(u.update.toolCallId) && u.update.status === 'completed');
      const diffShape = diffs.length >= 1 && diffs.every((d: any) => typeof d.path === 'string' && typeof d.oldText === 'string' && typeof d.newText === 'string');
      ctx.note(`edit completed=${editCompleted} diff{path,oldText,newText}=${diffShape}`);
      git(ctx.target, 'checkout', '--', 'README.md');
      await h.close();
      return editCalls.length >= 1 && editCompleted && diffShape && onDisk;
    },
  },
  {
    id: '07-permissions',
    title: 'Permission requests: allow, reject, and cancel-while-pending',
    adapters: ['claude', 'codex'],
    async run(ctx) {
      // /tmp is a writable root for codex's workspace-write sandbox, so the probe files live outside both cwd and /tmp
      fs.mkdirSync(permDir, { recursive: true });
      const tmp = (n: string) => path.join(permDir, `${ctx.adapter}-${n}`);
      for (const f of [tmp('x'), tmp('y'), tmp('hold')]) try { fs.unlinkSync(f); } catch {}
      const h = await ctx.spawn(undefined, { policy: allowFirstRejectRest });
      await h.initialize();
      if (ctx.adapter === 'claude') {
        // Part 0: a plain session inherits ~/.claude/settings.json allow rules (this machine has Bash(*)),
        // so `default` mode never asks. Record that, then isolate via settingSources.
        const s0 = await h.newSession();
        await h.setMode(s0.sessionId, 'default');
        const r0 = await h.prompt(s0.sessionId, 'Run the shell command `ls -la` and show me the output.');
        ctx.metric('inheritedSettingsRequests', h.permissions.length);
        ctx.note(`part 0 (user settings inherited): permission requests=${h.permissions.length} stop=${r0.response.stopReason}`);
        h.permissions.length = 0;
      }
      const s = await h.newSession(
        ctx.adapter === 'claude' ? ({ _meta: { claudeCode: { options: { settingSources: ['project'] } } } } as any) : {},
      );
      ctx.metric('currentModeId', s.modes?.currentModeId ?? null);
      await h.setMode(s.sessionId, MODES[ctx.adapter].ask);
      const r = await h.prompt(
        s.sessionId,
        `Run these as two separate shell commands, one at a time, and report the result of each. First: \`echo hi > ${tmp('x')}\`. After it finishes, second: \`echo bye > ${tmp('y')}\`. Both paths are outside the workspace, so a sandboxed run will be blocked: request escalated permissions for each command and wait for my answer. If I refuse a command, do not retry it — say so and stop.`,
      );
      const reqs = h.permissions.length;
      ctx.metric('permissionRequests', h.permissions.map((p) => ({ title: p.request.toolCall.title, options: p.request.options.map((o) => `${o.kind}=${o.optionId}`), response: p.response })));
      const ups = toolUpdates(h, r.updates);
      const finalStatus = new Map<string, string>();
      for (const u of ups) if (u.update.status) finalStatus.set(u.update.toolCallId, u.update.status);
      const xWritten = fs.existsSync(tmp('x'));
      const yWritten = fs.existsSync(tmp('y'));
      ctx.note(`requests=${reqs} kinds=${JSON.stringify(h.permissions[0]?.request.options.map((o) => o.kind))} stop=${r.response.stopReason} toolStatuses=${JSON.stringify([...finalStatus.values()])} x-written=${xWritten} y-written=${yWritten}`);
      try { fs.unlinkSync(tmp('x')); } catch {}
      try { fs.unlinkSync(tmp('y')); } catch {}
      ctx.note(`text=${JSON.stringify(h.agentText(r.updates).slice(-200))}`);
      const statuses = [...finalStatus.values()];
      // codex-acp offers `reject_once` only as codex's "cancel" decision (no "decline" in the command decision
      // set), and codex ends the turn as `cancelled` when the client picks it; claude keeps going and ends the
      // turn itself. Both are clean refusals, so either stop reason passes when it matches the option taken.
      const rejectedWith = h.permissions[1]?.response?.outcome;
      const rejectedOptionId = rejectedWith?.outcome === 'selected' ? rejectedWith.optionId : undefined;
      const stopOk = r.response.stopReason === 'end_turn' || (r.response.stopReason === 'cancelled' && rejectedOptionId === 'cancel');
      ctx.metric('partA', { requests: reqs, stop: r.response.stopReason, rejectedOptionId, statuses, xWritten, yWritten });
      const partA = reqs >= 2 && stopOk && statuses.includes('completed') && statuses.includes('failed') && xWritten && !yWritten;
      const kindsOk = ['allow_once', 'reject_once'].every((k) => h.permissions[0]?.request.options.some((o) => o.kind === k));

      // Part B: leave a request unanswered, cancel the turn, then answer `cancelled`.
      h.policy = holdForever;
      const before = h.permissions.length;
      const p = h.promptNoWait(s.sessionId, `Run the shell command \`echo hold > ${tmp('hold')}\` and tell me when done. The path is outside the workspace: request escalated permissions and wait for my answer.`);
      let held = false;
      try {
        await h.waitFor(() => h.permissions.length > before, 60_000, 'a permission request to hold');
        held = true;
      } catch (e) {
        ctx.note(`part B: ${(e as Error).message}`);
      }
      await sleep(3000);
      const t0 = Date.now();
      await h.cancel(s.sessionId);
      // The client answers the outstanding request with `cancelled` on cancel.
      for (const resolve of h.heldPermissions.splice(0)) resolve(cancelledOutcome);
      let stop: string | undefined;
      let err: string | undefined;
      try {
        stop = (await withTimeout(p, 30_000, 'prompt after cancel')).stopReason;
      } catch (e) {
        err = (e as Error).message;
      }
      const cancelMs = Date.now() - t0;
      ctx.metric('cancelWhilePending', { held, stop, err, cancelMs });
      ctx.note(`part B: held=${held} stop=${stop} err=${err ?? '-'} cancelMs=${cancelMs}`);
      // Part C (codex): the same write in each of the three modes, everything allowed — what does each mode do on its own?
      let partC = true;
      if (ctx.adapter === 'codex') {
        h.policy = allowAll;
        const perMode: Record<string, { requests: number; written: boolean; stop?: string; failed: boolean }> = {};
        for (const mode of ['read-only', 'agent', 'agent-full-access']) {
          const f = tmp(`mode-${mode}`);
          try { fs.unlinkSync(f); } catch {}
          const sm = await h.newSession();
          await h.setMode(sm.sessionId, mode);
          const n0 = h.permissions.length;
          const rm = await h.prompt(sm.sessionId, `Run the shell command \`echo ${mode} > ${f}\` and reply DONE. The path is outside the workspace: if the sandbox blocks it, request escalated permissions; if that is refused, say so.`);
          const failed = toolUpdates(h, rm.updates).some((u) => u.update.status === 'failed');
          perMode[mode] = { requests: h.permissions.length - n0, written: fs.existsSync(f), stop: rm.response.stopReason, failed };
          try { fs.unlinkSync(f); } catch {}
          ctx.note(`mode ${mode}: ${JSON.stringify(perMode[mode])}`);
        }
        ctx.metric('perMode', perMode);
        // read-only must not write silently (asks the client); agent writes, with Guardian rather than the client
        // reviewing the escalation; full access writes without asking anyone
        partC =
          (!perMode['read-only'].written || perMode['read-only'].requests > 0) &&
          perMode['agent'].written &&
          perMode['agent-full-access'].written &&
          perMode['agent-full-access'].requests === 0;
      }
      await h.close();
      return partA && kindsOk && held && stop === 'cancelled' && partC;
    },
  },
  {
    id: '07n-sandbox-denied',
    title: 'Negative control: sandbox-denied command, no escalation (codex)',
    adapters: ['codex'],
    async run(ctx) {
      // Retained evidence for a finding first seen in an overwritten 07 run: when codex's sandbox denies a command and
      // the model does not escalate, does the ACP stream carry any tool_call for it? Same out-of-workspace write as 07,
      // in the "ask" mode, everything the client is asked it allows — the point is what arrives unprompted.
      fs.mkdirSync(permDir, { recursive: true });
      const f = path.join(permDir, `${ctx.adapter}-denied`);
      try { fs.unlinkSync(f); } catch {}
      const h = await ctx.spawn(undefined, { policy: allowAll });
      const { s } = await initAndNew(h, ctx);
      await h.setMode(s.sessionId, MODES[ctx.adapter].ask);
      const r = await h.prompt(
        s.sessionId,
        `Run exactly this shell command once: \`echo probe > ${f}\`. Do not request escalated permissions and do not retry with a different command: if the sandbox blocks it, quote the error text you received and stop.`,
      );
      const calls = toolCalls(h, r.updates);
      const statuses = toolUpdates(h, r.updates).map((u) => u.update.status).filter(Boolean);
      const written = fs.existsSync(f);
      try { fs.unlinkSync(f); } catch {}
      const obs = {
        toolCalls: calls.length,
        toolKinds: calls.map((c) => `${c.update.kind}:${c.update.title}`),
        statuses,
        permissionRequests: h.permissions.length,
        written,
        stop: r.response.stopReason,
        updateKinds: kinds(r.updates),
      };
      ctx.metric('denied', obs);
      ctx.note(`denied exec: ${JSON.stringify(obs)}`);
      ctx.note(`text=${JSON.stringify(replyText(h, r.updates).slice(-300))}`);
      await h.close();
      return null;
    },
  },
  {
    id: '08-plan-events',
    title: 'Plan / todo events',
    adapters: ['claude', 'codex'],
    async run(ctx) {
      const h = await ctx.spawn();
      const { s } = await initAndNew(h, ctx);
      const r = await h.prompt(
        s.sessionId,
        'Use your todo/plan tool to create a list with exactly three items: (1) count the lines in package.json, (2) count the files directly inside src/, (3) report both numbers. Then work through the list one item at a time, updating each item to in-progress and then completed as you go. Read-only; do not modify files.',
      );
      const plans = r.updates.filter((u) => u.update.sessionUpdate === 'plan' || u.update.sessionUpdate === 'plan_update');
      const sizes = plans.map((p) => ((p.update as any).entries?.length ?? -1));
      const statusSeq = plans.map((p) => ((p.update as any).entries ?? []).map((e: any) => e.status[0]).join(''));
      ctx.metric('planUpdates', plans.length);
      ctx.metric('entryCounts', sizes);
      ctx.metric('statusSequence', statusSeq);
      ctx.metric('kinds', [...new Set(plans.map((p) => p.update.sessionUpdate))]);
      ctx.note(`plan updates=${plans.length} kinds=${JSON.stringify([...new Set(plans.map((p) => p.update.sessionUpdate))])} sizes=${JSON.stringify(sizes)} statuses=${JSON.stringify(statusSeq)}`);
      // Creation streams the list as it grows (1,2,3 entries); after that every update must carry all 3.
      const full = sizes.indexOf(3);
      const replace = full >= 0 && sizes.slice(full).every((n) => n === 3);
      const completed = statusSeq.at(-1) === 'ccc';
      const sawInProgress = statusSeq.some((s) => s.includes('i'));
      ctx.note(`replace semantics after list complete=${replace}; growth during creation=${JSON.stringify(sizes.slice(0, full + 1))}`);
      await h.close();
      return plans.length >= 2 && replace && completed && sawInProgress;
    },
  },
  {
    id: '09-thoughts',
    title: 'Thought chunks at high effort',
    adapters: ['claude', 'codex'],
    async run(ctx) {
      const h = await ctx.spawn(undefined, { quiet: true });
      const { s } = await initAndNew(h, ctx);
      const effortId = ctx.adapter === 'claude' ? 'effort' : 'reasoning_effort';
      const opt = s.configOptions?.find((c) => c.id === effortId);
      ctx.metric('effortOption', opt ?? null);
      try {
        const res = await h.setConfigOption(s.sessionId, effortId, 'high');
        ctx.note(`set ${effortId}=high → ${JSON.stringify(res).slice(0, 200)}`);
      } catch (e) {
        ctx.note(`set ${effortId}=high failed: ${(e as Error).message}`);
      }
      const r = await h.prompt(s.sessionId, 'Think carefully and step by step: what is the sum of the first 20 prime numbers? Reply with only the final number.');
      const thoughts = h.updatesOfKind('agent_thought_chunk', r.updates);
      const thoughtText = thoughts.map((t) => (t.update.content.type === 'text' ? t.update.content.text : '')).join('');
      ctx.metric('thoughtChunks', thoughts.length);
      ctx.metric('thoughtChars', thoughtText.length);
      ctx.note(`thought chunks=${thoughts.length} chars=${thoughtText.length} answer=${JSON.stringify(h.agentText(r.updates).trim())} (expected 639)`);
      await h.close();
      return null;
    },
  },
  {
    id: '10-commands-config',
    title: 'Slash commands + config option switch',
    adapters: ['claude', 'codex'],
    async run(ctx) {
      const h = await ctx.spawn();
      const { s } = await initAndNew(h, ctx);
      await sleep(1500);
      const cmds = h.updatesOfKind('available_commands_update');
      const names = cmds.flatMap((c) => c.update.availableCommands.map((x) => x.name));
      ctx.metric('availableCommandsUpdates', cmds.length);
      ctx.metric('commandCount', names.length);
      ctx.metric('sampleCommands', names.slice(0, 15));
      ctx.note(`available_commands_update x${cmds.length}, ${names.length} commands, has /context=${names.includes('context')}`);
      const r1 = await h.prompt(s.sessionId, '/context');
      ctx.note(`/context → stop=${r1.response.stopReason} text=${JSON.stringify(h.agentText(r1.updates).slice(0, 160))} kinds=${JSON.stringify(kinds(r1.updates))}`);
      const modelOpt = s.configOptions?.find((c) => c.id === 'model') as any;
      const current = modelOpt?.currentValue;
      const other = modelOpt?.options?.find((o: any) => o.value !== current)?.value;
      ctx.metric('modelOption', { current, options: modelOpt?.options?.map((o: any) => o.value) });
      let switched = false;
      if (other) {
        const before = h.updates.length;
        const res = await h.setConfigOption(s.sessionId, 'model', other);
        const nowVal = (res.configOptions?.find((c) => c.id === 'model') as any)?.currentValue;
        const cfgUpd = h.updatesOfKind('config_option_update', h.updates.slice(before)).length;
        ctx.note(`set model ${current} → ${other}: response currentValue=${nowVal}, config_option_update notifications=${cfgUpd}`);
        ctx.metric('configOptionUpdateNotifications', cfgUpd);
        const r2 = await h.prompt(s.sessionId, 'Which model are you? Reply with only your model name and version.');
        // The self-report is recorded, not asserted: models are unreliable about their own identity. The
        // assertion is that the switch is echoed back (response or notification) and the session still answers.
        ctx.note(`model self-report → ${JSON.stringify(h.agentText(r2.updates).trim().slice(0, 120))} stop=${r2.response.stopReason}`);
        switched = nowVal === other && r2.response.stopReason === 'end_turn';
      } else ctx.note('no alternative model option available');
      await h.close();
      return cmds.length >= 1 && r1.response.stopReason === 'end_turn' && switched;
    },
  },
  {
    id: '11-usage',
    title: 'Usage updates',
    adapters: ['claude', 'codex'],
    async run(ctx) {
      const h = await ctx.spawn();
      const { s } = await initAndNew(h, ctx);
      const r = await h.prompt(s.sessionId, 'Reply with exactly the single word PONG.');
      const usage = h.updatesOfKind('usage_update', r.updates).map((u) => u.update as any);
      ctx.metric('usageUpdates', usage);
      ctx.note(`usage_update x${usage.length}: ${usage.map((u) => `used=${u.used} size=${u.size} cost=${u.cost ? JSON.stringify(u.cost) : '-'} meta=${u._meta ? Object.keys(u._meta).join(',') : '-'}`).join(' | ')}`);
      await h.close();
      return usage.length >= 1 && usage.every((u) => typeof u.used === 'number' && typeof u.size === 'number');
    },
  },
  {
    id: '12-cancel',
    title: 'Cancel mid-turn + process hygiene',
    adapters: ['claude', 'codex'],
    async run(ctx) {
      const essay = 'Write a very long, detailed essay of at least 3000 words on the history of version control systems, from SCCS to git. Do not stop early.';
      const effortKey = ctx.adapter === 'claude' ? 'effort' : 'reasoning_effort';
      const effortOf = (sess: acp.NewSessionResponse) => ((sess.configOptions ?? []).find((o) => o.id === effortKey) as { currentValue?: unknown } | undefined)?.currentValue ?? null;

      // Part A — at the session's inherited effort (whatever the user's local config sets; xhigh on this machine):
      // how long until any progress signal at all, and does session/cancel work while the model is still silent?
      // Cancel at the first agent_message_chunk or at 45 s, whichever comes first. Chunk presence is recorded, not required.
      const hA = await ctx.spawn('inherited', { quiet: true });
      const { s: sA } = await initAndNew(hA, ctx);
      const inheritedEffort = effortOf(sA);
      const pA = hA.promptNoWait(sA.sessionId, essay);
      const tA = Date.now();
      let firstChunkMsA: number | null = null;
      try {
        await hA.waitFor(() => hA.updatesOfKind('agent_message_chunk').length > 0, 45_000, 'first agent_message_chunk');
        firstChunkMsA = Date.now() - tA;
      } catch (e) {
        ctx.note(`part A (${effortKey}=${inheritedEffort}): ${(e as Error).message}`);
      }
      const silentMs = firstChunkMsA ?? Date.now() - tA;
      const kindsBeforeCancelA = kinds(hA.updates);
      const t0A = Date.now();
      await hA.cancel(sA.sessionId);
      const ra = await settleStop(pA);
      const cancelMsA = Date.now() - t0A;
      const treeA = hA.descendants();
      await hA.close();
      const survivorsA = Harness.alive(treeA.map((d) => d.pid));
      const partAMetric = { effort: inheritedEffort, firstChunkMs: firstChunkMsA, silentMs, updateKindsBeforeCancel: kindsBeforeCancelA, stop: ra.stop, err: ra.err, cancelMs: cancelMsA, survivorsAfterClose: survivorsA.map((p) => `${p.pid} ${p.cmd}`) };
      ctx.metric('inherited', partAMetric);
      ctx.note(`part A (${effortKey}=${inheritedEffort}): first chunk at ${firstChunkMsA ?? `none within ${silentMs}ms`}, updates before cancel=${JSON.stringify(kindsBeforeCancelA)}, stop=${ra.stop} err=${ra.err ?? '-'} cancelMs=${cancelMsA}, survivors after close()=${survivorsA.length}`);
      const partA = ra.stop === 'cancelled' && survivorsA.length === 0;

      // Part B — effort=low so the turn is streaming when cancelled: latency from session/cancel to the response,
      // nothing after it, and process hygiene (SIGTERM to the adapter pid alone is recorded; close() must leave nothing).
      const h = await ctx.spawn('low', { quiet: true });
      const { s } = await initAndNew(h, ctx);
      await h.setConfigOption(s.sessionId, effortKey, 'low');
      const p = h.promptNoWait(s.sessionId, essay);
      const tPrompt = Date.now();
      try {
        await h.waitFor(() => h.updatesOfKind('agent_message_chunk').length > 0, 30_000, 'first agent_message_chunk');
      } catch (e) {
        ctx.note(`part B: ${(e as Error).message}`);
      }
      const firstChunkMs = h.updatesOfKind('agent_message_chunk').length ? Date.now() - tPrompt : null;
      await sleep(2000);
      const chunksBefore = h.updatesOfKind('agent_message_chunk').length;
      const t0 = Date.now();
      await h.cancel(s.sessionId);
      const rb = await settleStop(p);
      const stop = rb.stop;
      const err = rb.err;
      const cancelMs = Date.now() - t0;
      await sleep(1000);
      const chunksAfter = h.updatesOfKind('agent_message_chunk').length;
      const tree = h.descendants(); // exact pids, snapshotted before any signal
      const groupAfterCancel = tree.map((d) => `${d.pid}:${d.cmd}`);
      // Hygiene: SIGTERM only the adapter pid (what a naive supervisor would do) and see which of those pids survive.
      h.child.kill('SIGTERM');
      await Promise.race([h.exit, sleep(5000)]);
      await sleep(1500);
      const survivors = Harness.alive(tree.map((d) => d.pid));
      ctx.metric('cancel', { effort: 'low', stop, err, cancelMs, firstChunkMs, chunksBefore, chunksAfterExtra: chunksAfter - chunksBefore });
      ctx.metric('treeAfterCancel', groupAfterCancel);
      ctx.metric('survivorsAfterAdapterSigterm', survivors);
      ctx.note(`part B (${effortKey}=low): stop=${stop} err=${err ?? '-'} cancelMs=${cancelMs} first chunk at ${firstChunkMs}ms, chunks streamed before cancel=${chunksBefore}, after=${chunksAfter - chunksBefore}`);
      ctx.note(`process tree after cancel: ${groupAfterCancel.join(' | ')}`);
      ctx.note(`after SIGTERM to adapter pid only: ${survivors.length ? survivors.map((s) => `${s.pid} ${s.cmd}`).join(' | ') : 'none'}`);
      await h.close(); // process-group SIGTERM → SIGKILL → descendants
      const afterClose = Harness.alive(tree.map((d) => d.pid));
      ctx.metric('survivorsAfterClose', afterClose);
      ctx.note(`after close() (group kill): ${afterClose.length ? afterClose.map((s) => `${s.pid} ${s.cmd}`).join(' | ') : 'none'}`);
      const partB = stop === 'cancelled' && cancelMs < 10_000 && chunksBefore > 0 && afterClose.length === 0;
      return partA && partB;
    },
  },
  {
    id: '13-queue-vs-steer',
    title: 'Second prompt during t turn; steering',
    adapters: ['claude', 'codex'],
    async run(ctx) {
      const h = await ctx.spawn(undefined, { quiet: true });
      const { s } = await initAndNew(h, ctx);
      const essay = 'Write a detailed essay of about 800 words on the history of the Unix shell. Do not stop early.';
      const tA = Date.now();
      const pA = h.promptNoWait(s.sessionId, essay);
      await sleep(2000);
      const tB = Date.now();
      const pB = h.promptNoWait(s.sessionId, 'Ignore any previous task. Reply with exactly the single word QUEUED.');
      const settle = async (p: Promise<acp.PromptResponse>, t: number, timeoutMs = 240_000) => {
        try {
          const r = await withTimeout(p, timeoutMs, 'prompt');
          return { stop: r.stopReason, ms: Date.now() - t, doneAt: Date.now() };
        } catch (e) {
          return { err: (e as Error).message.slice(0, 200), ms: Date.now() - t, doneAt: Date.now() };
        }
      };
      const [ra, rb] = await Promise.all([settle(pA, tA), settle(pB, tB)]);
      const text = h.agentText();
      const userEchoes = h.updatesOfKind('user_message_chunk').length;
      const sawQUEUED = /QUEUED/.test(text);
      // rejected: B errored | preempted: A came back cancelled | queued: B answered after A ended | interleaved: B answered first
      const classification = rb.err ? 'rejected' : ra.stop === 'cancelled' ? 'preempted' : rb.doneAt >= ra.doneAt ? 'queued' : 'interleaved';
      ctx.metric('queue', { a: ra, b: rb, userEchoes, sawQUEUED, textLen: text.length, classification });
      ctx.note(`second prompt mid-turn → ${classification}; A: ${JSON.stringify({ stop: ra.stop, err: ra.err, ms: ra.ms })}  B: ${JSON.stringify({ stop: rb.stop, err: rb.err, ms: rb.ms })}  QUEUED in stream=${sawQUEUED} user echoes=${userEchoes}`);
      // Steering (claude extension; codex expected to reject the method)
      const before = h.updates.length;
      const tC = Date.now();
      const pC = h.promptNoWait(s.sessionId, essay);
      await sleep(2000);
      let steer: unknown;
      try {
        steer = await withTimeout(h.steer(s.sessionId, 'Stop the essay immediately. Reply with exactly the single word STEERED and end your turn.'), 30_000, 'steer');
      } catch (e) {
        steer = { error: (e as Error).message.slice(0, 200) };
      }
      const rc = await settle(pC, tC, 90_000); // claude-agent-acp 0.70 never closes the steered turn — don't wait 4 min for it
      const textC = h.agentText(h.updates.slice(before));
      ctx.metric('steer', { response: steer, c: rc, sawSTEERED: /STEERED/.test(textC), textLen: textC.length });
      ctx.note(`steer → ${JSON.stringify(steer)}  C: ${JSON.stringify(rc)} STEERED in stream=${/STEERED/.test(textC)} textLen=${textC.length}`);
      // Steering while idle
      let idle: unknown;
      try {
        idle = await withTimeout(h.steer(s.sessionId, 'Reply with exactly the word IDLESTEER.', { steering: { idleBehavior: 'promptRequired' } }), 30_000, 'idle steer');
      } catch (e) {
        idle = { error: (e as Error).message.slice(0, 200) };
      }
      ctx.note(`steer while idle (promptRequired) → ${JSON.stringify(idle)}`);
      ctx.metric('steerIdle', idle);
      await h.close();
      // pass: every session/prompt this client sent resolves (queued or merged is fine, an orphaned request is not) and
      // mid-turn steering returns an outcome. The classification and timings are the Decision 6 evidence either way.
      const steerOk = typeof steer === 'object' && steer !== null && !('error' in steer);
      const orphaned = (r: { err?: string }) => r.err?.startsWith('timeout') === true; // an explicit JSON-RPC error IS a resolution
      const unresolved = [orphaned(ra) ? 'A (first prompt)' : '', orphaned(rb) ? 'B (second prompt)' : '', orphaned(rc) ? 'C (steered prompt)' : ''].filter(Boolean);
      if (unresolved.length) ctx.note(`FAIL: session/prompt request(s) never resolved: ${unresolved.join(', ')}`);
      ctx.metric('unresolved', unresolved);
      return unresolved.length === 0 && steerOk;
    },
  },
  {
    id: '14-load-resume',
    title: 'session/load and session/resume after adapter restart',
    adapters: ['claude', 'codex'],
    async run(ctx) {
      const h1 = await ctx.spawn('p1');
      const { s } = await initAndNew(h1, ctx);
      const r0 = await h1.prompt(s.sessionId, 'Remember this: the code word is PELICAN. Reply with exactly OK.');
      ctx.note(`p1: ${JSON.stringify(h1.agentText(r0.updates).trim())}`);
      await h1.close();

      const h2 = await ctx.spawn('p2');
      await h2.initialize();
      const t1 = Date.now();
      let loadOk = false;
      let loadReplay = false;
      try {
        const lr = await h2.loadSession(s.sessionId);
        const loadMs = Date.now() - t1;
        const replay = kinds(h2.updates); // everything received before session/load returned
        loadReplay = (replay.user_message_chunk ?? 0) >= 1 && (replay.agent_message_chunk ?? 0) >= 1;
        ctx.metric('load', { ms: loadMs, response: lr, replay });
        ctx.note(`load: ${loadMs}ms, replay=${JSON.stringify(replay)} history replayed=${loadReplay} response keys=${Object.keys(lr).join(',')}`);
        const r = await h2.prompt(s.sessionId, 'What is the code word? Reply with only the word.');
        const t = h2.agentText(r.updates);
        loadOk = /PELICAN/.test(t);
        ctx.note(`after load → ${JSON.stringify(t.trim())}`);
      } catch (e) {
        ctx.note(`load failed: ${(e as Error).message.slice(0, 300)}`);
      }
      await h2.close();

      const h3 = await ctx.spawn('p3');
      await h3.initialize();
      const t2 = Date.now();
      let resumeOk = false;
      let resumeReplay = false;
      try {
        const rr = await h3.resumeSession(s.sessionId);
        const resumeMs = Date.now() - t2;
        const replay = kinds(h3.updates);
        resumeReplay = (replay.user_message_chunk ?? 0) + (replay.agent_message_chunk ?? 0) > 0;
        ctx.metric('resume', { ms: resumeMs, response: rr, replay });
        ctx.note(`resume: ${resumeMs}ms, replay=${JSON.stringify(replay)} history replayed=${resumeReplay} response keys=${Object.keys(rr).join(',')}`);
        const r = await h3.prompt(s.sessionId, 'What is the code word? Reply with only the word.');
        const t = h3.agentText(r.updates);
        resumeOk = /PELICAN/.test(t);
        ctx.note(`after resume → ${JSON.stringify(t.trim())}`);
      } catch (e) {
        ctx.note(`resume failed: ${(e as Error).message.slice(0, 300)}`);
      }
      await h3.close();
      ctx.metric('loadOk', loadOk);
      ctx.metric('resumeOk', resumeOk);
      ctx.metric('loadReplay', loadReplay);
      ctx.metric('resumeReplay', resumeReplay);
      // §5.9a step 14: load replays history as user/agent chunks and remembers; resume remembers without replaying
      return loadOk && resumeOk && loadReplay && !resumeReplay;
    },
  },
  {
    id: '15-crash',
    title: 'kill -9 mid-turn',
    adapters: ['claude', 'codex'],
    async run(ctx) {
      const h = await ctx.spawn(undefined, { quiet: true });
      const { s } = await initAndNew(h, ctx);
      const p = h.promptNoWait(s.sessionId, 'Write a detailed essay of at least 3000 words on the history of version control systems. Do not stop early.');
      await sleep(3000);
      const tree = h.descendants(); // exact pids, snapshotted before the kill
      const groupBefore = tree.map((d) => `${d.pid}:${d.cmd}`);
      const t0 = Date.now();
      h.child.kill('SIGKILL');
      let outcome: string;
      try {
        const r = await withTimeout(p, 15_000, 'prompt after SIGKILL');
        outcome = `resolved stop=${r.stopReason}`;
      } catch (e) {
        outcome = `rejected: ${(e as Error).message.slice(0, 160)}`;
      }
      const rejectMs = Date.now() - t0;
      let closedMs: number | 'timeout';
      try {
        await withTimeout(h.conn.closed, 10_000, 'conn.closed');
        closedMs = Date.now() - t0;
      } catch {
        closedMs = 'timeout';
      }
      await sleep(1500);
      const survivors = Harness.alive(tree.map((d) => d.pid));
      ctx.metric('crash', { outcome, rejectMs, closedMs, groupBefore, survivors });
      ctx.note(`prompt ${outcome} after ${rejectMs}ms; conn.closed=${closedMs}; survivors after SIGKILL of adapter pid only: ${survivors.length ? survivors.map((s) => `${s.pid} ${s.cmd}`).join(' | ') : 'none'}`);
      await h.close();
      const afterClose = Harness.alive(tree.map((d) => d.pid));
      ctx.metric('survivorsAfterClose', afterClose);
      ctx.note(`after close() (group kill): ${afterClose.length ? afterClose.map((s) => `${s.pid} ${s.cmd}`).join(' | ') : 'none'}`);
      // Part B: adapter exits before initialize completes — the client must not hang.
      const h2 = await ctx.spawn('early-exit', { quiet: true });
      const t1 = Date.now();
      const init = h2.initialize();
      h2.child.kill('SIGKILL');
      let early: string;
      try {
        await withTimeout(init, 15_000, 'initialize after early exit');
        early = 'resolved';
      } catch (e) {
        early = `rejected: ${(e as Error).message.slice(0, 120)}`;
      }
      const earlyMs = Date.now() - t1;
      ctx.metric('earlyExit', { early, earlyMs });
      ctx.note(`initialize on a dead adapter → ${early} after ${earlyMs}ms`);
      await h2.close();
      return outcome.startsWith('rejected') && closedMs !== 'timeout' && early.startsWith('rejected') && afterClose.length === 0;
    },
  },
  {
    id: '16-embedded-context',
    title: 'Embedded resource block + standing-context cost',
    adapters: ['claude', 'codex'],
    async run(ctx) {
      const h = await ctx.spawn();
      const { s } = await initAndNew(h, ctx);
      const asgPath = path.join(process.env.HOME!, '.syntaur/projects/syntaur-meta/tickets/acp-adapter-spike/ticket.md');
      const text = fs.readFileSync(asgPath, 'utf8');
      const acSection = text.split(/^## Acceptance Criteria\s*$/m)[1]?.split(/^## /m)[0] ?? '';
      const acs = (acSection.match(/^- \[[ x]\] /gm) ?? []).length;
      const blocks: acp.ContentBlock[] = [
        { type: 'resource', resource: { uri: 'file://' + asgPath, mimeType: 'text/markdown', text } },
        { type: 'text', text: 'Using only the attached ticket document (do not read any files or run any tools): what is the ticket slug, and how many acceptance criteria does it list? Reply in one line: "<slug>, <n>".' },
      ];
      const r = await h.prompt(s.sessionId, blocks);
      const reply = h.agentText(r.updates).trim();
      const calls = toolCalls(h, r.updates).length;
      const usage = h.updatesOfKind('usage_update', r.updates).map((u) => (u.update as any).used);
      ctx.metric('resourceChars', text.length);
      ctx.metric('toolCallsDuringPrompt', calls);
      ctx.metric('usageUsedAfterFirstPrompt', usage);
      ctx.metric('acCountInFile', acs);
      const countOk = new RegExp(`\\b${acs}\\b`).test(reply);
      ctx.note(`reply=${JSON.stringify(reply.slice(0, 120))} toolCalls=${calls} usage.used=${JSON.stringify(usage)} (resource ${text.length} chars, ${acs} acceptance criteria in file; count in reply=${countOk})`);
      await h.close();
      return calls === 0 && /acp-adapter-spike/.test(reply) && countOk && usage.some((u) => typeof u === 'number' && u > 0);
    },
  },
  {
    id: '17-subagent',
    title: 'Sub-agent (Task tool) rendering',
    adapters: ['claude'],
    async run(ctx) {
      const h = await ctx.spawn();
      const { s } = await initAndNew(h, ctx);
      const r = await h.prompt(s.sessionId, 'Use a subagent (the Task tool with subagent_type Explore) to summarize the purpose of the src/ directory in three bullets. Relay the subagent\'s summary verbatim.');
      const calls = toolCalls(h, r.updates);
      const ups = toolUpdates(h, r.updates);
      const task = calls.filter((c) => /task|agent/i.test(c.update.title) || c.update.kind === 'think');
      const ids = new Set(task.map((c) => c.update.toolCallId));
      const taskUps = ups.filter((u) => ids.has(u.update.toolCallId));
      const nested = taskUps.flatMap((u) => u.update.content ?? []).length + task.flatMap((c) => c.update.content ?? []).length;
      const meta = [...task, ...taskUps].filter((u) => (u.update as any)._meta).map((u) => Object.keys((u.update as any)._meta));
      ctx.metric('toolCalls', calls.map((c) => ({ title: c.update.title, kind: c.update.kind, status: c.update.status })));
      ctx.metric('taskUpdates', taskUps.length);
      ctx.metric('taskNestedContent', nested);
      ctx.metric('taskMetaKeys', meta);
      ctx.note(`tool_calls=${calls.length} (${calls.map((c) => `${c.update.kind}:${c.update.title}`).join(', ')}); task-like=${task.length}; task updates=${taskUps.length}; nested content items=${nested}; _meta keys=${JSON.stringify(meta)}`);
      ctx.note(`text=${JSON.stringify(h.agentText(r.updates).trim().slice(0, 200))}`);
      await h.close();
      return null;
    },
  },
  {
    id: '20-client-death',
    title: 'Client closes stdin mid-turn (dashboard/server dies)',
    adapters: ['claude', 'codex'],
    async run(ctx) {
      const h = await ctx.spawn(undefined, { quiet: true });
      const { s } = await initAndNew(h, ctx);
      const p = h.promptNoWait(s.sessionId, 'Write a detailed essay of at least 3000 words on the history of version control systems. Do not stop early.');
      p.catch(() => {});
      await sleep(3000);
      const tree = h.descendants(); // exact pids, snapshotted before stdin closes
      const before = tree.map((d) => `${d.pid}:${d.cmd}`);
      const t0 = Date.now();
      h.child.stdin!.end(); // what the adapter sees when its client process dies
      const exit = await Promise.race([h.exit.then((e) => `exited ${JSON.stringify(e)}`), sleep(10_000).then(() => 'still running after 10s')]);
      const exitMs = Date.now() - t0;
      await sleep(1500);
      const after = Harness.alive(tree.map((d) => d.pid));
      ctx.metric('clientDeath', { before, exit, exitMs, survivors: after.map((d) => `${d.pid}:${d.cmd}`) });
      ctx.note(`stdin closed mid-turn → adapter ${exit} (${exitMs}ms); descendants before=${before.length}, alive after=${after.length}${after.length ? ' (' + after.map((d) => d.cmd).join(', ') + ')' : ''}`);
      await h.close();
      return exit.startsWith('exited') && after.length === 0;
    },
  },
  {
    id: '19-concurrency',
    title: 'Two adapters on the same worktree',
    adapters: ['claude', 'codex'],
    async run(ctx) {
      const a = await ctx.spawn('planner', { quiet: true });
      const b = await ctx.spawn('implementer', { quiet: true });
      const [{ s: sa }, { s: sb }] = await Promise.all([initAndNew(a, ctx), initAndNew(b, ctx)]);
      await a.setMode(sa.sessionId, MODES[ctx.adapter].plan);
      await b.setMode(sb.sessionId, MODES[ctx.adapter].edits);
      const samples: Array<{ t: number; a: string; b: string }> = [];
      const sample = () => {
        const ps = (h: Harness) => {
          const pids = h.orphans().map((o) => o.pid);
          if (!pids.length) return '-';
          try {
            const out = execFileSync('ps', ['-o', 'rss=,%cpu=', '-p', pids.join(',')], { encoding: 'utf8' }).trim().split('\n');
            const rss = out.reduce((n, l) => n + Number(l.trim().split(/\s+/)[0]), 0);
            const cpu = out.reduce((n, l) => n + Number(l.trim().split(/\s+/)[1]), 0);
            return `${Math.round(rss / 1024)}MB/${cpu.toFixed(0)}%`;
          } catch {
            return '?';
          }
        };
        samples.push({ t: Date.now(), a: ps(a), b: ps(b) });
      };
      sample();
      const timer = setInterval(sample, 2000);
      const marker = '<!-- acp-spike: concurrent edit -->';
      const [ra, rb] = await Promise.all([
        a.prompt(sa.sessionId, 'Read package.json and write a three-step plan for adding t --version flag to this CLI. Do not edit any files.'),
        b.prompt(sb.sessionId, `Insert the line ${marker} as the very first line of README.md. Make only that change, then reply DONE.`),
      ]);
      clearInterval(timer);
      sample();
      const crossA = a.updates.filter((u) => u.sessionId !== sa.sessionId).length;
      const crossB = b.updates.filter((u) => u.sessionId !== sb.sessionId).length;
      const onDisk = fs.readFileSync(path.join(ctx.target, 'README.md'), 'utf8').split('\n')[0] === marker;
      const aEditPaths = [...toolCalls(a), ...toolUpdates(a)]
        .flatMap((u) => (u.update.content ?? []).filter((c: any) => c.type === 'diff').map((c: any) => String(c.path)))
        .concat(toolCalls(a).filter((c) => c.update.kind === 'edit').flatMap((c) => (c.update.locations ?? []).map((l) => l.path)));
      const aEdited = aEditPaths.some((p) => p.startsWith(ctx.target)); // plan mode may write its own plan file elsewhere
      ctx.metric('plannerEditPaths', aEditPaths);
      ctx.metric('samples', samples.map((s) => ({ t: s.t - samples[0].t, planner: s.a, implementer: s.b })));
      ctx.metric('stops', { planner: ra.response.stopReason, implementer: rb.response.stopReason });
      ctx.metric('crossTalk', { planner: crossA, implementer: crossB });
      ctx.note(`planner stop=${ra.response.stopReason} (${ra.ms}ms, edits in target=${aEdited}, edit paths=${JSON.stringify(aEditPaths)}); implementer stop=${rb.response.stopReason} (${rb.ms}ms, README edited=${onDisk}); cross-session updates=${crossA}/${crossB}`);
      ctx.note(`rss/cpu samples: ${samples.map((s) => `[${Math.round((s.t - samples[0].t) / 1000)}s ${s.a} | ${s.b}]`).join(' ')}`);
      const samplesOk = samples.length >= 2 && samples.every((s) => /MB\//.test(s.a) && /MB\//.test(s.b));
      if (!samplesOk) ctx.note('rss/cpu sampling incomplete (a "-" or "?" sample) — inconclusive');
      git(ctx.target, 'checkout', '--', 'README.md');
      await Promise.all([a.close(), b.close()]);
      return ra.response.stopReason === 'end_turn' && rb.response.stopReason === 'end_turn' && crossA === 0 && crossB === 0 && onDisk && !aEdited && samplesOk;
    },
  },
];

export { allowAll };
