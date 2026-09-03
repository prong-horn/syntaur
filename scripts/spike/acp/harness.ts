// ACP spike harness (assignment acp-adapter-spike). Throwaway by design:
// spawns an ACP adapter, wraps the SDK stream so every JSON-RPC frame in both
// directions is logged, collects session/update notifications, and exposes the
// handful of session/* calls the scenarios need. See ../../../claude-info/plans/
// assignment-chat-design.md §5.9a for the scenarios this serves.

import { spawn, spawnSync, execFileSync, type ChildProcess } from 'node:child_process';
import { PassThrough, Readable, Writable } from 'node:stream';
import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import * as acp from '@agentclientprotocol/sdk';

export type Adapter = 'claude' | 'codex' | 'cursor';

export const ADAPTERS: Record<Adapter, { bin: string; args: string[] }> = {
  claude: { bin: 'claude-agent-acp', args: [] },
  codex: { bin: 'codex-acp', args: [] },
  cursor: { bin: 'cursor-agent', args: ['acp'] },
};

export interface Frame {
  seq: number;
  ts: string;
  t: number; // ms since the adapter was spawned
  dir: 'in' | 'out';
  msg: unknown;
}

export interface CollectedUpdate {
  ts: string;
  sessionId: string;
  update: acp.SessionUpdate;
}

export interface PermissionEvent {
  ts: string;
  request: acp.RequestPermissionRequest;
  response?: acp.RequestPermissionResponse;
  respondedAt?: string;
}

export interface ExtRequestEvent {
  ts: string;
  method: string;
  params: unknown;
  response?: unknown;
  respondedAt?: string;
}

export interface ExtNotificationEvent {
  ts: string;
  method: string;
  params: unknown;
}

export type PermissionPolicy = (
  req: acp.RequestPermissionRequest,
  info: { index: number; harness: Harness },
) => Promise<acp.RequestPermissionResponse> | acp.RequestPermissionResponse;

export interface SpawnOptions {
  adapter: Adapter;
  cwd: string;
  runDir: string;
  scenario: string;
  /** Extra env; the adapter inherits process.env minus `scrubEnv` keys. */
  env?: Record<string, string>;
  scrubEnv?: string[];
  policy?: PermissionPolicy;
  /** Console rendering of updates (default on). */
  quiet?: boolean;
  /** Identifies this adapter instance in log lines when several run at once. */
  label?: string;
}

const now = () => new Date().toISOString();

export function selected(optionId: string): acp.RequestPermissionResponse {
  return { outcome: { outcome: 'selected', optionId } };
}
export const cancelledOutcome: acp.RequestPermissionResponse = { outcome: { outcome: 'cancelled' } };

/** Pick the option whose `kind` matches, falling back to the first option. */
export function pickOption(req: acp.RequestPermissionRequest, kind: string): string {
  const opt = req.options.find((o) => o.kind === kind) ?? req.options[0];
  return opt.optionId;
}

export const allowAll: PermissionPolicy = (req) => selected(pickOption(req, 'allow_once'));
export const rejectAll: PermissionPolicy = (req) => selected(pickOption(req, 'reject_once'));
/** Allow the first request, reject every later one. */
export const allowFirstRejectRest: PermissionPolicy = (req, { index }) =>
  selected(pickOption(req, index === 0 ? 'allow_once' : 'reject_once'));
/** Never answer; the scenario resolves it by cancelling the turn. */
export const holdForever: PermissionPolicy = (_req, { harness }) =>
  new Promise((resolve) => {
    harness.heldPermissions.push(resolve);
  });

/** Pass-through parser for cursor extension methods (SDK requires a parser for custom names). */
const passthrough = <T>(v: unknown) => v as T;

export class Harness {
  readonly frames: Frame[] = [];
  readonly updates: CollectedUpdate[] = [];
  readonly permissions: PermissionEvent[] = [];
  readonly extRequests: ExtRequestEvent[] = [];
  readonly extNotifications: ExtNotificationEvent[] = [];
  readonly badStdoutLines: string[] = [];
  readonly heldPermissions: Array<(r: acp.RequestPermissionResponse) => void> = [];
  /** Resolve a pending cursor/ask_question (set by the probe when it wants to answer). */
  pendingAskQuestion?: (answer: unknown) => void;
  /** Resolve a pending cursor/create_plan (set by the probe when it wants to accept). */
  pendingCreatePlan?: (answer: unknown) => void;
  readonly stderrPath: string;
  readonly framesPath: string;
  readonly startedAt = Date.now();
  /** ms from spawn to the initialize response. */
  startupMs: number | null = null;
  /** ms from each session/prompt send to its first agent_message_chunk. */
  readonly firstTokenMs: number[] = [];
  stderrBytes = 0;
  policy: PermissionPolicy;
  child!: ChildProcess;
  conn!: acp.ClientConnection;
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  private exitResolve!: (v: { code: number | null; signal: NodeJS.Signals | null }) => void;
  private frameStream: fs.WriteStream;
  private opts: SpawnOptions;

  constructor(opts: SpawnOptions) {
    this.opts = opts;
    this.policy = opts.policy ?? allowAll;
    fs.mkdirSync(opts.runDir, { recursive: true });
    const base = path.join(opts.runDir, opts.scenario + (opts.label ? `.${opts.label}` : ''));
    this.stderrPath = base + '.stderr.log';
    this.framesPath = base + '.ndjson';
    this.frameStream = fs.createWriteStream(this.framesPath, { flags: 'w' }); // one process = one fresh transcript
    this.exit = new Promise((r) => (this.exitResolve = r));
  }

  get adapter(): Adapter {
    return this.opts.adapter;
  }
  get label(): string {
    return this.opts.label ?? this.opts.adapter;
  }
  get pid(): number {
    return this.child.pid!;
  }

  /** Spawn the adapter in its own process group and connect the SDK client. */
  static async spawn(opts: SpawnOptions): Promise<Harness> {
    const h = new Harness(opts);
    await h.start();
    return h;
  }

  private async start(): Promise<void> {
    const { bin, args } = ADAPTERS[this.opts.adapter];
    const env: Record<string, string | undefined> = { ...process.env, ...(this.opts.env ?? {}) };
    for (const k of this.opts.scrubEnv ?? []) delete env[k];
    this.child = spawn(bin, args, {
      cwd: this.opts.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true, // own process group so kill(-pid) reaches grandchildren
    });
    this.child.on('exit', (code, signal) => this.exitResolve({ code, signal }));
    this.child.on('error', (err) => this.log(`spawn error: ${err.message}`));
    this.child.stderr!.on('data', (d: Buffer) => (this.stderrBytes += d.length));
    this.child.stderr!.pipe(fs.createWriteStream(this.stderrPath, { flags: 'a' }));

    // Tee stdout: one branch feeds the SDK, the other validates NDJSON framing.
    const forSdk = new PassThrough();
    const forCheck = new PassThrough();
    this.child.stdout!.pipe(forSdk);
    this.child.stdout!.pipe(forCheck);
    readline.createInterface({ input: forCheck, crlfDelay: Infinity }).on('line', (line) => {
      if (!line.trim()) return;
      try {
        JSON.parse(line);
      } catch {
        this.badStdoutLines.push(line);
      }
    });

    const base = acp.ndJsonStream(
      Writable.toWeb(this.child.stdin!) as WritableStream<Uint8Array>,
      Readable.toWeb(forSdk) as ReadableStream<Uint8Array>,
    );
    const writer = base.writable.getWriter();
    const logged: acp.Stream = {
      writable: new WritableStream({
        write: async (msg) => {
          this.record('out', msg);
          await writer.write(msg);
        },
        close: () => writer.close().catch(() => {}),
        abort: (reason) => writer.abort(reason).catch(() => {}),
      }),
      readable: base.readable.pipeThrough(
        new TransformStream({
          transform: (msg, controller) => {
            this.record('in', msg);
            controller.enqueue(msg);
          },
        }),
      ),
    };

    this.conn = acp
      .client({ name: 'syntaur-acp-spike' })
      .onRequest(acp.methods.client.session.requestPermission, async (ctx) => {
        const ev: PermissionEvent = { ts: now(), request: ctx.params };
        this.permissions.push(ev);
        const idx = this.permissions.length - 1;
        this.log(
          `permission #${idx}: ${ctx.params.toolCall.title ?? ctx.params.toolCall.toolCallId} ` +
            `[${ctx.params.options.map((o) => `${o.kind}=${o.optionId}`).join(', ')}]`,
        );
        const response = await this.policy(ctx.params, { index: idx, harness: this });
        ev.response = response;
        ev.respondedAt = now();
        return response;
      })
      .onRequest('cursor/create_plan', passthrough, async (ctx) => {
        const ev: ExtRequestEvent = { ts: now(), method: 'cursor/create_plan', params: ctx.params };
        this.extRequests.push(ev);
        this.log(`ext request cursor/create_plan keys=${Object.keys(ctx.params as object).join(',')}`);
        const response = await new Promise<unknown>((resolve) => {
          this.pendingCreatePlan = resolve;
        });
        ev.response = response;
        ev.respondedAt = now();
        this.pendingCreatePlan = undefined;
        return response;
      })
      .onRequest('cursor/ask_question', passthrough, async (ctx) => {
        const ev: ExtRequestEvent = { ts: now(), method: 'cursor/ask_question', params: ctx.params };
        this.extRequests.push(ev);
        this.log(`ext request cursor/ask_question keys=${Object.keys(ctx.params as object).join(',')}`);
        const response = await new Promise<unknown>((resolve) => {
          this.pendingAskQuestion = resolve;
        });
        ev.response = response;
        ev.respondedAt = now();
        this.pendingAskQuestion = undefined;
        return response;
      })
      .onNotification(acp.methods.client.session.update, (ctx) => {
        const u = ctx.params;
        this.updates.push({ ts: now(), sessionId: u.sessionId, update: u.update });
        if (!this.opts.quiet) this.render(u.update);
      })
      .onNotification('cursor/update_todos', passthrough, (ctx) => {
        this.extNotifications.push({ ts: now(), method: 'cursor/update_todos', params: ctx.params });
        this.log(`ext notification cursor/update_todos`);
      })
      .onNotification('cursor/task', passthrough, (ctx) => {
        this.extNotifications.push({ ts: now(), method: 'cursor/task', params: ctx.params });
        this.log(`ext notification cursor/task`);
      })
      .onNotification('cursor/generate_image', passthrough, (ctx) => {
        this.extNotifications.push({ ts: now(), method: 'cursor/generate_image', params: ctx.params });
        this.log(`ext notification cursor/generate_image`);
      })
      .connect(logged);
  }

  private record(dir: 'in' | 'out', msg: unknown): void {
    const f: Frame = { seq: this.frames.length, ts: now(), t: Date.now() - this.startedAt, dir, msg };
    this.frames.push(f);
    this.frameStream.write(redactEmails(JSON.stringify(f)) + '\n');
  }

  log(line: string): void {
    if (!this.opts.quiet) console.log(`  [${this.label}] ${line}`);
  }

  private render(u: acp.SessionUpdate): void {
    const k = u.sessionUpdate;
    const text = (c: acp.ContentBlock) => (c.type === 'text' ? c.text : `<${c.type}>`);
    switch (k) {
      case 'agent_message_chunk':
        process.stdout.write(text(u.content));
        return;
      case 'agent_thought_chunk':
        process.stdout.write(`\x1b[2m${text(u.content)}\x1b[0m`);
        return;
      case 'user_message_chunk':
        this.log(`user echo: ${text(u.content).slice(0, 80)}`);
        return;
      case 'tool_call':
        this.log(`tool_call ${u.toolCallId} kind=${u.kind ?? '?'} status=${u.status ?? '?'} "${u.title}"`);
        return;
      case 'tool_call_update':
        this.log(`tool_call_update ${u.toolCallId} status=${u.status ?? '-'} content=${u.content?.length ?? 0}`);
        return;
      case 'plan':
        this.log(`plan: ${u.entries.map((e) => `[${e.status}] ${e.content}`).join(' | ')}`);
        return;
      default:
        this.log(k + (k === 'usage_update' ? ` ${JSON.stringify(u)}` : ''));
    }
  }

  // ---- ACP calls -------------------------------------------------------

  async initialize(extra: Partial<acp.InitializeRequest> = {}): Promise<acp.InitializeResponse> {
    const res = await this.conn.agent.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {},
      clientInfo: { name: 'syntaur-acp-spike', version: '0.0.0' },
      ...extra,
    } as acp.InitializeRequest);
    this.startupMs ??= Date.now() - this.startedAt;
    return res;
  }

  newSession(extra: Partial<acp.NewSessionRequest> = {}): Promise<acp.NewSessionResponse> {
    return this.conn.agent.request(acp.methods.agent.session.new, {
      cwd: this.opts.cwd,
      mcpServers: [],
      ...extra,
    } as acp.NewSessionRequest);
  }

  loadSession(sessionId: string): Promise<acp.LoadSessionResponse> {
    return this.conn.agent.request(acp.methods.agent.session.load, {
      sessionId,
      cwd: this.opts.cwd,
      mcpServers: [],
    } as acp.LoadSessionRequest);
  }

  resumeSession(sessionId: string): Promise<acp.ResumeSessionResponse> {
    return this.conn.agent.request(acp.methods.agent.session.resume, {
      sessionId,
      cwd: this.opts.cwd,
      mcpServers: [],
    } as acp.ResumeSessionRequest);
  }

  setMode(sessionId: string, modeId: string): Promise<acp.SetSessionModeResponse> {
    return this.conn.agent.request(acp.methods.agent.session.setMode, { sessionId, modeId });
  }

  setConfigOption(sessionId: string, configId: string, value: string | boolean): Promise<acp.SetSessionConfigOptionResponse> {
    const params = typeof value === 'boolean' ? { sessionId, configId, type: 'boolean', value } : { sessionId, configId, value };
    return this.conn.agent.request(acp.methods.agent.session.setConfigOption, params as acp.SetSessionConfigOptionRequest);
  }

  cancel(sessionId: string): Promise<void> {
    return this.conn.agent.notify(acp.methods.agent.session.cancel, { sessionId });
  }

  /** Send a prompt and wait for the turn to end. Returns the response plus the updates seen during it. */
  async prompt(
    sessionId: string,
    blocks: string | acp.ContentBlock[],
    opts: { timeoutMs?: number; extra?: Record<string, unknown> } = {},
  ): Promise<{ response: acp.PromptResponse; updates: CollectedUpdate[]; ms: number }> {
    const from = this.updates.length;
    const t0 = Date.now();
    const response = await withTimeout(this.promptNoWait(sessionId, blocks, opts.extra), opts.timeoutMs ?? 240_000, 'session/prompt');
    return { response, updates: this.updates.slice(from), ms: Date.now() - t0 };
  }

  promptNoWait(sessionId: string, blocks: string | acp.ContentBlock[], extra: Record<string, unknown> = {}): Promise<acp.PromptResponse> {
    const prompt = typeof blocks === 'string' ? [{ type: 'text', text: blocks } as acp.ContentBlock] : blocks;
    const from = this.updates.length;
    const t0 = Date.now();
    const p = this.conn.agent.request(acp.methods.agent.session.prompt, { sessionId, prompt, ...extra } as acp.PromptRequest);
    // first-token latency: first agent_message_chunk for this session after the send
    const poll = setInterval(() => {
      const hit = this.updates.slice(from).find((u) => u.sessionId === sessionId && u.update.sessionUpdate === 'agent_message_chunk');
      if (hit) {
        this.firstTokenMs.push(Date.parse(hit.ts) - t0);
        clearInterval(poll);
      }
    }, 20);
    p.finally(() => clearInterval(poll)).catch(() => {});
    return p;
  }

  /** Any non-standard method (e.g. codex-acp's private `authentication/status`). */
  ext(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    return this.conn.agent.request(method, params);
  }

  /** claude-agent-acp's steering extension (`_session/steering`). */
  steer(sessionId: string, text: string, meta?: Record<string, unknown>): Promise<unknown> {
    return this.conn.agent.request('_session/steering', {
      sessionId,
      prompt: [{ type: 'text', text }],
      ...(meta ? { _meta: meta } : {}),
    });
  }

  // ---- process control -------------------------------------------------

  /** Kill the whole process group. Resolves once the direct child has exited (or after `graceMs`). */
  async kill(signal: NodeJS.Signals = 'SIGTERM', graceMs = 5000): Promise<{ code: number | null; signal: NodeJS.Signals | null } | 'timeout'> {
    try {
      process.kill(-this.pid, signal);
    } catch (e) {
      try {
        this.child.kill(signal);
      } catch {}
    }
    const r = await Promise.race([this.exit, sleep(graceMs).then(() => 'timeout' as const)]);
    return r;
  }

  /** PIDs still alive in the adapter's process group (macOS pgrep -g). */
  orphans(): Array<{ pid: number; cmd: string }> {
    try {
      const out = execFileSync('pgrep', ['-g', String(this.pid), '-l'], { encoding: 'utf8' });
      return out
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((l) => {
          const [pid, ...cmd] = l.trim().split(/\s+/);
          return { pid: Number(pid), cmd: cmd.join(' ') };
        });
    } catch {
      return []; // pgrep exits 1 when nothing matches
    }
  }

  /** Which of these exact PIDs are still alive (snapshot descendants() before a kill, check them after). */
  static alive(pids: number[]): Array<{ pid: number; cmd: string }> {
    if (!pids.length) return [];
    try {
      return execFileSync('ps', ['-o', 'pid=,comm=', '-p', pids.join(',')], { encoding: 'utf8' })
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((l) => {
          const [pid, ...cmd] = l.trim().split(/\s+/);
          return { pid: Number(pid), cmd: cmd.join(' ') };
        });
    } catch {
      return []; // ps exits 1 when none of the pids exist
    }
  }

  /**
   * Descendants of the adapter found by walking PPIDs (catches children that
   * called setsid and left the process group). Includes the adapter itself if alive.
   */
  descendants(): Array<{ pid: number; ppid: number; pgid: number; cmd: string }> {
    let rows: Array<{ pid: number; ppid: number; pgid: number; cmd: string }>;
    try {
      rows = execFileSync('ps', ['-axo', 'pid=,ppid=,pgid=,comm='], { encoding: 'utf8' })
        .trim()
        .split('\n')
        .map((l) => {
          const [pid, ppid, pgid, ...cmd] = l.trim().split(/\s+/);
          return { pid: Number(pid), ppid: Number(ppid), pgid: Number(pgid), cmd: cmd.join(' ') };
        });
    } catch {
      return [];
    }
    const out: typeof rows = [];
    const want = new Set([this.pid]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const r of rows) {
        if ((want.has(r.ppid) || r.pid === this.pid || r.pgid === this.pid) && !want.has(r.pid)) {
          want.add(r.pid);
          grew = true;
        }
      }
    }
    for (const r of rows) if (want.has(r.pid)) out.push(r);
    return out;
  }

  /** Resident set size (KB) summed over the process group. */
  rssKb(): number {
    const members = this.orphans();
    if (members.length === 0) return 0;
    try {
      const out = execFileSync('ps', ['-o', 'rss=', '-p', members.map((m) => m.pid).join(',')], { encoding: 'utf8' });
      return out
        .trim()
        .split('\n')
        .reduce((a, l) => a + (Number(l.trim()) || 0), 0);
    } catch {
      return 0;
    }
  }

  async close(): Promise<void> {
    try {
      this.conn.close();
    } catch {}
    await this.kill('SIGTERM', 4000);
    if (this.orphans().length) await this.kill('SIGKILL', 2000);
    for (const d of this.descendants()) {
      try {
        process.kill(d.pid, 'SIGKILL');
      } catch {}
    }
    this.frameStream.end();
  }

  /** Per-adapter numbers every scenario records. */
  stats() {
    return {
      pid: this.pid,
      startupMs: this.startupMs,
      firstTokenMs: this.firstTokenMs,
      frames: this.frames.length,
      framesIn: this.frames.filter((f) => f.dir === 'in').length,
      updates: this.updates.length,
      stderrBytes: this.stderrBytes,
      badStdoutLines: this.badStdoutLines.length,
    };
  }

  // ---- helpers over collected data ------------------------------------

  updatesOfKind<K extends acp.SessionUpdate['sessionUpdate']>(kind: K, list = this.updates) {
    return list.filter((u) => u.update.sessionUpdate === kind) as Array<CollectedUpdate & { update: Extract<acp.SessionUpdate, { sessionUpdate: K }> }>;
  }

  /** Concatenated agent message text from a slice of updates. */
  agentText(list = this.updates): string {
    return this.updatesOfKind('agent_message_chunk', list)
      .map((u) => (u.update.content.type === 'text' ? u.update.content.text : ''))
      .join('');
  }

  /** Wait until a predicate over updates holds, or time out. */
  async waitFor(pred: (updates: CollectedUpdate[]) => boolean, timeoutMs: number, what: string): Promise<void> {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      if (pred(this.updates)) return;
      await sleep(100);
    }
    throw new Error(`timeout waiting for ${what}`);
  }
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: NodeJS.Timeout;
  return Promise.race([
    p.finally(() => clearTimeout(t)),
    new Promise<T>((_, rej) => {
      t = setTimeout(() => rej(new Error(`timeout after ${ms}ms: ${what}`)), ms);
    }),
  ]);
}

// ---- results -----------------------------------------------------------

export interface ScenarioResult {
  id: string;
  title: string;
  adapter: Adapter | 'both';
  pass: boolean | null; // null = observation only, no pass criterion
  notes: string[];
  metrics?: Record<string, unknown>;
  error?: string;
  frames?: string; // path to the transcript
  sourceCommit?: string; // commit of this repo the target clone was reset to for this row (a --only rerun can differ from the run's first rows)
  ms: number;
}

/** Fixtures are committed: strip anything that looks like an email address. */
export function redactEmails(s: string): string {
  return s.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g, '[redacted-email]');
}

/** `claude auth status` prints the account email; keep only the fields the preflight needs. */
function sanitizeClaudeAuth(raw: string): string {
  try {
    const j = JSON.parse(raw);
    return JSON.stringify({ loggedIn: j.loggedIn, authMethod: j.authMethod, apiProvider: j.apiProvider });
  } catch {
    return redactEmails(raw.replace(/\s+/g, ' ').slice(0, 200));
  }
}

export function appendResult(runDir: string, r: ScenarioResult): void {
  const p = path.join(runDir, 'results.json');
  const list: ScenarioResult[] = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : [];
  const i = list.findIndex((x) => x.id === r.id && x.adapter === r.adapter);
  if (i >= 0) list[i] = r; // a rerun (--only) replaces the earlier row
  else list.push(r);
  fs.writeFileSync(p, JSON.stringify(list, null, 2));
}

/** `cursor-agent status` prints the account email; keep only login state. */
function sanitizeCursorAuth(raw: string): string {
  return redactEmails(raw.replace(/\s+/g, ' ').slice(0, 200));
}

/** §5.9a step 1: versions + auth probes. Throws when a binary is missing or nobody is logged in. */
export function preflight(adapters: Adapter[] = ['claude', 'codex']): Record<string, string> {
  const v = (bin: string, args: string[]) => {
    try {
      // codex prints `login status` on stderr, so capture both
      const r = spawnSync(bin, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      if (r.error) throw r.error;
      if (r.status !== 0) throw new Error(`exit ${r.status}: ${(r.stderr || r.stdout).trim()}`);
      return (r.stdout.trim() || r.stderr.trim()).trim();
    } catch (e) {
      return `unavailable (${(e as Error).message.split('\n')[0]})`;
    }
  };
  const out: Record<string, string> = {
    node: process.version,
    'claude-agent-acp': v('claude-agent-acp', ['--version']),
    'codex-acp': v('codex-acp', ['--version']),
    claude: v('claude', ['--version']),
    codex: v('codex', ['--version']),
    'cursor-agent': v('cursor-agent', ['--version']),
    '@agentclientprotocol/sdk': JSON.parse(fs.readFileSync(new URL('./node_modules/@agentclientprotocol/sdk/package.json', import.meta.url), 'utf8')).version,
    'claude auth status': sanitizeClaudeAuth(v('claude', ['auth', 'status'])),
    'codex login status': v('codex', ['login', 'status']),
    'cursor-agent status': sanitizeCursorAuth(v('cursor-agent', ['status'])),
  };
  const problems: string[] = [];
  const need = new Set(adapters);
  if (need.has('claude') || need.has('codex')) {
    for (const k of ['claude-agent-acp', 'codex-acp', 'claude', 'codex'] as const) if (out[k].startsWith('unavailable')) problems.push(`${k}: ${out[k]}`);
    if (need.has('claude') && !/"loggedIn":\s*true/.test(out['claude auth status'])) problems.push(`claude not logged in: ${out['claude auth status']}`);
    if (need.has('codex') && !/Logged in/.test(out['codex login status'])) problems.push(`codex not logged in: ${out['codex login status']}`);
  }
  if (need.has('cursor')) {
    if (out['cursor-agent'].startsWith('unavailable')) problems.push(`cursor-agent: ${out['cursor-agent']}`);
    if (!/Logged in/.test(out['cursor-agent status'])) problems.push(`cursor not logged in: ${out['cursor-agent status']}`);
  }
  // The scripts are .ts run without a build step, so the actual requirement is native type stripping, not a version number.
  if (Number(process.versions.node.split('.')[0]) < 22) problems.push(`node ${process.version} (need ≥ 22 for native .ts type stripping)`);
  else if (!(process.features as { typescript?: unknown }).typescript) problems.push(`node ${process.version} has process.features.typescript unset (native type stripping is off)`);
  if (!/^1\.4\./.test(out['@agentclientprotocol/sdk'])) problems.push(`@agentclientprotocol/sdk ${out['@agentclientprotocol/sdk']} (expected 1.4.x)`);
  if (need.has('claude') && !/^0\.70\./.test(out['claude-agent-acp'])) problems.push(`claude-agent-acp version ${out['claude-agent-acp']} (expected 0.70.x)`);
  if (need.has('codex') && !/ 1\.7\./.test(out['codex-acp'])) problems.push(`codex-acp version ${out['codex-acp']} (expected 1.7.x)`);
  if (problems.length) throw new Error('preflight failed:\n  ' + problems.join('\n  '));
  return out;
}
