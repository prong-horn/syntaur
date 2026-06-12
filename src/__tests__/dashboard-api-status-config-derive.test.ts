import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, readFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createStatusConfigRouter } from '../dashboard/api-status-config.js';
import { clearStatusConfigCache } from '../dashboard/api.js';
import {
  writeStatusConfig,
  parseStatusConfig,
  type StatusDefinition,
  type StatusTransition,
  type DeriveConfig,
  type RawFactDeclaration,
} from '../utils/config.js';
import { DEFAULT_DERIVE_CONFIG } from '../utils/derive-config.js';

const originalHome = process.env.HOME;
const originalSyntaurHome = process.env.SYNTAUR_HOME;

let tmpHome: string;
let projectsDir: string;
let standaloneDir: string;
let server: Server;
let baseUrl: string;

// A status set that satisfies DEFAULT_DERIVE_CONFIG's references.
const statuses: StatusDefinition[] = [
  { id: 'draft', label: 'Draft' },
  { id: 'ready_for_planning', label: 'Ready for planning' },
  { id: 'ready_to_implement', label: 'Ready to implement' },
  { id: 'in_progress', label: 'In progress' },
  { id: 'review', label: 'Review' },
  { id: 'parked', label: 'Parked' },
  { id: 'blocked', label: 'Blocked' },
  { id: 'completed', label: 'Completed', terminal: true },
];
const order = statuses.map((s) => s.id);

interface SeedOpts {
  statuses?: StatusDefinition[];
  order?: string[];
  transitions?: StatusTransition[];
  derive?: DeriveConfig | null;
  facts?: RawFactDeclaration[] | null;
}

/**
 * Seed ~/.syntaur/config.md via the real serializer so tests never hand-roll
 * YAML — the derive/transitions/facts blocks match exactly what the CLI writes.
 */
async function seedConfigWith(opts: SeedOpts = {}): Promise<void> {
  await writeStatusConfig({
    statuses: opts.statuses ?? statuses,
    order: opts.order ?? (opts.statuses ?? statuses).map((s) => s.id),
    transitions: opts.transitions ?? [],
    derive: opts.derive ?? null,
    facts: opts.facts ?? null,
  });
  clearStatusConfigCache();
}

async function post(body: unknown): Promise<Response> {
  return fetch(baseUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function readConfigMd(): Promise<string> {
  return readFile(join(tmpHome, '.syntaur', 'config.md'), 'utf-8');
}

async function seedAssignment(dir: string, slug: string, status: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  const md = `---
id: 22222222-2222-2222-2222-${slug.padEnd(12, '0').slice(0, 12)}
slug: ${slug}
title: ${slug}
status: ${status}
priority: medium
created: "2026-01-01T00:00:00Z"
updated: "2026-01-01T00:00:00Z"
assignee: null
externalIds: []
dependsOn: []
links: []
blockedReason: null
workspace:
  repository: null
  worktreePath: null
  branch: null
  parentBranch: null
tags: []
---

# ${slug}
`;
  const p = join(dir, 'assignment.md');
  await writeFile(p, md);
  return p;
}

async function statusOf(path: string): Promise<string | null> {
  try {
    const content = await readFile(path, 'utf-8');
    return content.match(/^status:\s*(\S+)/m)?.[1] ?? null;
  } catch {
    return null;
  }
}

async function fileGone(path: string): Promise<boolean> {
  try {
    await access(path);
    return false;
  } catch {
    return true;
  }
}

beforeEach(async () => {
  tmpHome = await mkdtemp(join(tmpdir(), 'syntaur-derive-api-'));
  await mkdir(join(tmpHome, '.syntaur'), { recursive: true });
  projectsDir = join(tmpHome, 'projects');
  standaloneDir = join(tmpHome, '.syntaur', 'assignments');
  await mkdir(projectsDir, { recursive: true });
  await mkdir(standaloneDir, { recursive: true });
  process.env.HOME = tmpHome;
  process.env.SYNTAUR_HOME = join(tmpHome, '.syntaur');

  const app = express();
  app.use(express.json());
  app.use('/api/config/statuses', createStatusConfigRouter(projectsDir, standaloneDir));
  await new Promise<void>((ready) => {
    server = app.listen(0, () => ready());
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/config/statuses`;
});

afterEach(async () => {
  await new Promise<void>((done) => server.close(() => done()));
  process.env.HOME = originalHome;
  if (originalSyntaurHome === undefined) delete process.env.SYNTAUR_HOME;
  else process.env.SYNTAUR_HOME = originalSyntaurHome;
  await rm(tmpHome, { recursive: true, force: true });
  clearStatusConfigCache();
});

describe('GET derive + deriveCustom', () => {
  it('returns the defaults (deriveCustom=false) when config declares no derive', async () => {
    await seedConfigWith();
    const body = await (await fetch(baseUrl)).json();
    expect(body.deriveCustom).toBe(false);
    expect(body.derive).toEqual(DEFAULT_DERIVE_CONFIG);
    expect(Array.isArray(body.knownCommands)).toBe(true);
    expect(body.knownCommands).toContain('start');
  });

  it('returns the custom derive (deriveCustom=true) when config declares it', async () => {
    const custom: DeriveConfig = {
      ...DEFAULT_DERIVE_CONFIG,
      phaseLadder: [{ phase: 'draft', when: '*', next: 'Custom next' }, { phase: 'review', when: 'reviewRequested:true' }],
    };
    await seedConfigWith({ derive: custom });
    const body = await (await fetch(baseUrl)).json();
    expect(body.deriveCustom).toBe(true);
    expect(body.derive.phaseLadder[0].next).toBe('Custom next');
  });
});

describe('POST derive', () => {
  it('persists a valid derive config', async () => {
    await seedConfigWith();
    const derive: DeriveConfig = {
      ...DEFAULT_DERIVE_CONFIG,
      phaseLadder: [{ phase: 'draft', when: '*', next: 'Start here' }, { phase: 'in_progress', when: 'implementationStarted:true' }],
    };
    const res = await post({ statuses, order, transitions: [], derive });
    expect(res.status).toBe(200);
    const parsed = parseStatusConfig(await readConfigMd());
    expect(parsed!.derive!.phaseLadder.find((r) => r.phase === 'in_progress')!.when).toBe('implementationStarted:true');
  });

  it('400s a derive rung referencing an undefined status', async () => {
    await seedConfigWith();
    const derive: DeriveConfig = {
      ...DEFAULT_DERIVE_CONFIG,
      phaseLadder: [{ phase: 'draft', when: '*' }, { phase: 'ghost', when: 'planApproved:true' }],
    };
    const res = await post({ statuses, order, transitions: [], derive });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid-derive');
    expect(body.problems.join(' ')).toContain('ghost');
  });

  it('400s a derive with no else-arm', async () => {
    await seedConfigWith();
    const derive: DeriveConfig = {
      ...DEFAULT_DERIVE_CONFIG,
      disposition: [{ when: 'parked:true', is: 'parked' }],
    };
    const res = await post({ statuses, order, transitions: [], derive });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid-derive');
  });

  it('400s a derive with an unparseable condition', async () => {
    await seedConfigWith();
    const derive: DeriveConfig = {
      ...DEFAULT_DERIVE_CONFIG,
      phaseLadder: [{ phase: 'draft', when: '*' }, { phase: 'review', when: 'bogusField:true' }],
    };
    const res = await post({ statuses, order, transitions: [], derive });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid-derive');
  });

  it('derive: null resets to defaults', async () => {
    await seedConfigWith({ derive: { ...DEFAULT_DERIVE_CONFIG, phaseLadder: [{ phase: 'draft', when: '*', next: 'x' }] } });
    const res = await post({ statuses, order, transitions: [], derive: null });
    expect(res.status).toBe(200);
    expect(parseStatusConfig(await readConfigMd())!.derive).toBeNull();
  });
});

describe('POST transitions', () => {
  it('persists transitions', async () => {
    await seedConfigWith();
    const transitions: StatusTransition[] = [
      { from: 'in_progress', command: 'block', to: 'blocked', requiresReason: true },
    ];
    const res = await post({ statuses, order, transitions });
    expect(res.status).toBe(200);
    const parsed = parseStatusConfig(await readConfigMd());
    expect(parsed!.transitions).toEqual(transitions);
  });

  it('400s transitions referencing an unknown status', async () => {
    await seedConfigWith();
    const res = await post({ statuses, order, transitions: [{ from: 'ghost', command: 'x', to: 'in_progress' }] });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid-transitions');
  });
});

describe('no-wipe regression', () => {
  it('hand-written transitions + derive survive a statuses-only-shaped save', async () => {
    const transitions: StatusTransition[] = [{ from: 'in_progress', command: 'block', to: 'blocked' }];
    const derive: DeriveConfig = { ...DEFAULT_DERIVE_CONFIG, phaseLadder: [{ phase: 'draft', when: '*', next: 'keep me' }] };
    await seedConfigWith({ transitions, derive });

    // Body omits derive and transitions entirely (old-client / preserve shape).
    const res = await post({ statuses, order });
    expect(res.status).toBe(200);

    const parsed = parseStatusConfig(await readConfigMd());
    expect(parsed!.transitions).toEqual([
      { from: 'in_progress', command: 'block', to: 'blocked', requiresReason: false },
    ]);
    expect(parsed!.derive!.phaseLadder[0].next).toBe('keep me');
  });
});

describe('round-trip: unified save preserves all four sections', () => {
  it('statuses + transitions + derive + facts survive writeStatusConfig → parseStatusConfig', async () => {
    await seedConfigWith();
    const transitions: StatusTransition[] = [{ from: 'in_progress', command: 'review', to: 'review', label: 'Send to review' }];
    const derive: DeriveConfig = { ...DEFAULT_DERIVE_CONFIG };
    const facts: RawFactDeclaration[] = [{ name: 'shipped', type: 'bool', binds: null }];
    const res = await post({ statuses, order, transitions, derive, facts });
    expect(res.status).toBe(200);

    const parsed = parseStatusConfig(await readConfigMd())!;
    expect(parsed.statuses.map((s) => s.id)).toEqual(order);
    // parseStatusConfig canonicalizes transitions (requiresReason defaults to false).
    expect(parsed.transitions).toEqual([
      { from: 'in_progress', command: 'review', to: 'review', label: 'Send to review', requiresReason: false },
    ]);
    expect(parsed.derive).toEqual(derive);
    expect(parsed.facts).toEqual(facts);

    // And the POST response itself carries every section for client rehydration.
    const body = await (await fetch(baseUrl)).json();
    expect(body.rawFacts).toEqual(facts);
    expect(body.deriveCustom).toBe(true);
  });
});

describe('fact-removal 409 evaluates the INCOMING derive', () => {
  const deriveRefShipped: DeriveConfig = {
    ...DEFAULT_DERIVE_CONFIG,
    phaseLadder: [{ phase: 'draft', when: '*' }, { phase: 'review', when: 'shipped:true' }],
  };

  it('409s when a removed fact is still referenced by the PRESERVED derive', async () => {
    await seedConfigWith({ facts: [{ name: 'shipped', type: 'bool', binds: null }], derive: deriveRefShipped });
    // Remove the fact; omit derive so the current (shipped-referencing) derive is
    // preserved. The fact-reference scan evaluates that incoming-effective derive
    // and 409s. (If derive WERE sent referencing the removed fact, derive
    // validation against the incoming facts would 400 invalid-derive first.)
    const res = await post({ statuses, order, transitions: [], facts: [] });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('unresolved-fact-references');
  });

  it('succeeds when the fact AND its referencing rule are removed together', async () => {
    await seedConfigWith({ facts: [{ name: 'shipped', type: 'bool', binds: null }], derive: deriveRefShipped });
    const cleanDerive: DeriveConfig = { ...DEFAULT_DERIVE_CONFIG, phaseLadder: [{ phase: 'draft', when: '*' }] };
    const res = await post({ statuses, order, transitions: [], derive: cleanDerive, facts: [] });
    expect(res.status).toBe(200);
  });
});

describe('validation before mutation', () => {
  it('an invalid-derive payload with pending resolutions does NOT touch assignment files', async () => {
    // status "review" will be dropped, with an assignment in it + a resolution.
    await seedConfigWith();
    const assignPath = await seedAssignment(join(projectsDir, 'p1', 'assignments', 'a1'), 'a1', 'review');

    const droppedStatuses = statuses.filter((s) => s.id !== 'review');
    const res = await post({
      statuses: droppedStatuses,
      order: droppedStatuses.map((s) => s.id),
      transitions: [],
      // invalid derive (rung references the dropped 'review') → must 400 BEFORE any remap
      derive: { ...DEFAULT_DERIVE_CONFIG, phaseLadder: [{ phase: 'draft', when: '*' }, { phase: 'review', when: 'reviewRequested:true' }] },
      resolutions: [{ id: 'review', mode: 'remap', target: 'in_progress' }],
    });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid-derive');
    // The assignment file is untouched: still exists, still status review.
    expect(await fileGone(assignPath)).toBe(false);
    expect(await statusOf(assignPath)).toBe('review');
  });

  it('an invalid-facts payload with pending resolutions does NOT touch assignment files', async () => {
    await seedConfigWith();
    const assignPath = await seedAssignment(join(projectsDir, 'p1', 'assignments', 'a2'), 'a2', 'review');

    const droppedStatuses = statuses.filter((s) => s.id !== 'review');
    const res = await post({
      statuses: droppedStatuses,
      order: droppedStatuses.map((s) => s.id),
      transitions: [],
      facts: [{ name: 'Bad Name', type: 'bool', binds: null }], // invalid (uppercase + space)
      resolutions: [{ id: 'review', mode: 'remap', target: 'in_progress' }],
    });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid-facts');
    expect(await statusOf(assignPath)).toBe('review');
  });
});
