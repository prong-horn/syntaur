import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  initEventsDb,
  closeEventsDb,
  resetEventsDb,
  latestStageEntryForTicket,
  insertLiveEventOrThrow,
} from '../db/events-db.js';
import {
  closeSessionDb,
  initSessionDb,
  resetSessionDb,
  getSessionDb,
} from '../dashboard/session-db.js';
import { getOpenEngagement, openEngagement } from '../db/engagement-db.js';
import { setCumulativeTokenSource, type TokenSnapshot } from '../db/engagement-tokens.js';
import { seedMissingBuiltins } from '../ticket-templates/builtins.js';
import { loadTemplate } from '../ticket-templates/registry.js';
import {
  recordStageEntryLocked,
  completeStageEntry,
  isUuidEntryId,
  buildManualFallbackEntryId,
  type StageDispatchCallback,
} from '../lifecycle/stage-entry.js';

let home: string;
let projectsDir: string;

const TOKEN_SNAP: TokenSnapshot = {
  models: {},
  collectorRunAt: null,
  capturedAt: '2026-01-01T00:00:00Z',
};

function seedSession(
  sessionId: string,
  opts: { status?: string; hostedBy?: string | null } = {},
): void {
  getSessionDb()
    .prepare(
      `INSERT INTO sessions (session_id, agent, started, status, path, hosted_by)
       VALUES (?, 'claude', ?, ?, ?, ?)`,
    )
    .run(
      sessionId,
      '2026-01-01T00:00:00Z',
      opts.status ?? 'active',
      '/tmp/wt',
      opts.hostedBy ?? null,
    );
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'sv11-entry-'));
  projectsDir = resolve(home, 'projects');
  process.env.SYNTAUR_HOME = home;
  await writeFile(
    resolve(home, 'config.md'),
    `---\nversion: "2.0"\ndefaultProjectDir: ${projectsDir}\n---\n`,
  );
  await seedMissingBuiltins(home);
  resetEventsDb();
  initEventsDb(resolve(home, 'syntaur.db'));
  resetSessionDb();
  initSessionDb(resolve(home, 'syntaur.db'));
  setCumulativeTokenSource(async () => TOKEN_SNAP);
});

afterEach(async () => {
  setCumulativeTokenSource(null);
  closeSessionDb();
  resetSessionDb();
  closeEventsDb();
  resetEventsDb();
  delete process.env.SYNTAUR_HOME;
  await rm(home, { recursive: true, force: true });
});

describe('stage entry recording', () => {
  it('records created entry with stageEntryId and dispatch fields', async () => {
    const manifest = await loadTemplate(home, 'feature');
    const entry = recordStageEntryLocked({
      ticketId: 'FE-1',
      projectSlug: 'p',
      actor: 'human',
      at: '2026-01-01T00:00:00Z',
      eventType: 'created',
      stage: 'backlog',
      manifest,
    });
    expect(isUuidEntryId(entry.entryId)).toBe(true);
    const latest = latestStageEntryForTicket('FE-1');
    expect(latest?.eventId).toBe(entry.entryId);
    expect(latest?.dispatchTarget).toBeNull();
  });

  it('completeStageEntry calls injectable dispatch without starting agents when skipped', async () => {
    const manifest = await loadTemplate(home, 'feature');
    const dispatch = vi.fn();
    const entry = recordStageEntryLocked({
      ticketId: 'FE-2',
      projectSlug: 'p',
      actor: 'human',
      at: '2026-01-01T00:00:00Z',
      eventType: 'moved',
      stage: 'planning',
      manifest,
      from: 'backlog',
      verb: 'plan',
    });
    const outcome = await completeStageEntry({
      ticketId: 'FE-2',
      ticketDir: '/tmp/t',
      projectSlug: 'p',
      ticketSlug: 't',
      entry,
      actor: 'human',
      dispatch,
    });
    expect(outcome.dispatch?.state).toBe('skipped');
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('manual fallback token is not a UUID', () => {
    const token = buildManualFallbackEntryId('in_progress', 'feature', null);
    expect(isUuidEntryId(token)).toBe(false);
    expect(token.startsWith('unrecorded~')).toBe(true);
  });

  it('calls notifyStageEntry before dispatch for manual-only stages', async () => {
    const manifest = await loadTemplate(home, 'feature');
    const notifyStageEntry = vi.fn().mockResolvedValue(undefined);
    const dispatchImpl = vi.fn();
    const dispatch = Object.assign(dispatchImpl, { notifyStageEntry }) as StageDispatchCallback;
    const entry = recordStageEntryLocked({
      ticketId: 'FE-3',
      projectSlug: 'p',
      actor: 'human',
      at: '2026-01-01T00:00:00Z',
      eventType: 'moved',
      stage: 'review',
      manifest,
      from: 'in_progress',
      verb: 'review',
    });
    await completeStageEntry({
      ticketId: 'FE-3',
      ticketDir: '/tmp/t',
      projectSlug: 'p',
      ticketSlug: 't',
      entry,
      actor: 'human',
      dispatch,
    });
    expect(notifyStageEntry).toHaveBeenCalledOnce();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('calls notifyStageEntry for terminal drop without auto dispatch', async () => {
    const manifest = await loadTemplate(home, 'feature');
    const notifyStageEntry = vi.fn().mockResolvedValue(undefined);
    const dispatchImpl = vi.fn();
    const dispatch = Object.assign(dispatchImpl, { notifyStageEntry }) as StageDispatchCallback;
    const entry = recordStageEntryLocked({
      ticketId: 'FE-4',
      projectSlug: 'p',
      actor: 'human',
      at: '2026-01-01T00:00:00Z',
      eventType: 'moved',
      stage: 'dropped',
      manifest,
      from: 'in_progress',
      verb: 'drop',
      reason: 'done',
    });
    const outcome = await completeStageEntry({
      ticketId: 'FE-4',
      ticketDir: '/tmp/t',
      projectSlug: 'p',
      ticketSlug: 't',
      entry,
      actor: 'human',
      dispatch,
    });
    expect(notifyStageEntry).toHaveBeenCalledOnce();
    expect(outcome.dispatch?.state).toBe('skipped');
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('notification failure warns but keeps lifecycle success', async () => {
    const manifest = await loadTemplate(home, 'feature');
    const notifyStageEntry = vi.fn().mockRejectedValue(new Error('broker offline'));
    const dispatchImpl = vi.fn().mockResolvedValue({ state: 'queued', requestId: 'auto~x' });
    const dispatch = Object.assign(dispatchImpl, { notifyStageEntry }) as StageDispatchCallback;
    const entry = recordStageEntryLocked({
      ticketId: 'FE-5',
      projectSlug: 'p',
      actor: 'human',
      at: '2026-01-01T00:00:00Z',
      eventType: 'moved',
      stage: 'in_progress',
      manifest,
      from: 'ready',
      verb: 'start',
    });
    const outcome = await completeStageEntry({
      ticketId: 'FE-5',
      ticketDir: '/tmp/t',
      projectSlug: 'p',
      ticketSlug: 't',
      entry,
      actor: 'human',
      dispatch,
    });
    expect(outcome.stageChanged).toBe(true);
    expect(outcome.warnings?.some((w) => w.includes('stage entry notification failed'))).toBe(true);
    expect(dispatchImpl).toHaveBeenCalledOnce();
  });

  it('records dispatchSuppressed on auto stage when suppressDispatch is set', async () => {
    const manifest = await loadTemplate(home, 'feature');
    const entry = recordStageEntryLocked({
      ticketId: 'FE-6',
      projectSlug: 'p',
      actor: 'human',
      at: '2026-01-01T00:00:00Z',
      eventType: 'moved',
      stage: 'in_progress',
      manifest,
      from: 'ready',
      verb: 'start',
      suppressDispatch: true,
    });
    expect(entry.dispatchSuppressed).toBe(true);
    const latest = latestStageEntryForTicket('FE-6');
    expect(latest?.dispatchSuppressed).toBe(true);
    const dispatch = vi.fn();
    const notifyStageEntry = vi.fn().mockResolvedValue(undefined);
    const dispatchCb = Object.assign(dispatch, { notifyStageEntry }) as StageDispatchCallback;
    const outcome = await completeStageEntry({
      ticketId: 'FE-6',
      ticketDir: '/tmp/t',
      projectSlug: 'p',
      ticketSlug: 't',
      entry,
      actor: 'human',
      dispatch: dispatchCb,
    });
    expect(outcome.dispatch?.state).toBe('suppressed');
    expect(dispatch).not.toHaveBeenCalled();
    expect(notifyStageEntry).toHaveBeenCalledOnce();
  });

  it('suppressDispatch on a stage without target stays skipped', async () => {
    const manifest = await loadTemplate(home, 'feature');
    const entry = recordStageEntryLocked({
      ticketId: 'FE-7',
      projectSlug: 'p',
      actor: 'human',
      at: '2026-01-01T00:00:00Z',
      eventType: 'moved',
      stage: 'ready',
      manifest,
      from: 'planning',
      verb: 'approve',
      suppressDispatch: true,
    });
    expect(entry.dispatchSuppressed).toBe(false);
    const dispatch = vi.fn();
    const outcome = await completeStageEntry({
      ticketId: 'FE-7',
      ticketDir: '/tmp/t',
      projectSlug: 'p',
      ticketSlug: 't',
      entry,
      actor: 'human',
      dispatch,
    });
    expect(outcome.dispatch?.state).toBe('skipped');
    expect(dispatch).not.toHaveBeenCalled();
  });
});

describe('completeStageEntry caller engagement', () => {
  async function planningEntry() {
    const manifest = await loadTemplate(home, 'feature');
    return recordStageEntryLocked({
      ticketId: 'FE-10',
      projectSlug: 'p',
      actor: 'human',
      at: '2026-01-01T00:00:00Z',
      eventType: 'moved',
      stage: 'planning',
      manifest,
      from: 'backlog',
      verb: 'plan',
    });
  }

  it('updates an existing open engagement for a strong active non-ACP caller', async () => {
    seedSession('sess-strong');
    openEngagement({
      sessionId: 'sess-strong',
      ticketId: 'FE-10',
      stage: 'backlog',
      startedAt: '2026-01-01T00:00:00Z',
    });
    const entry = await planningEntry();
    await completeStageEntry({
      ticketId: 'FE-10',
      ticketDir: '/tmp/t',
      projectSlug: 'p',
      ticketSlug: 't',
      entry,
      actor: 'human',
      callerSession: { id: 'sess-strong', provenance: 'STRONG' },
    });
    expect(getOpenEngagement('sess-strong')?.stage).toBe('planning');
  });

  it('does not create an engagement when the caller has none open', async () => {
    seedSession('sess-no-open');
    const entry = await planningEntry();
    await completeStageEntry({
      ticketId: 'FE-10',
      ticketDir: '/tmp/t',
      projectSlug: 'p',
      ticketSlug: 't',
      entry,
      actor: 'human',
      callerSession: { id: 'sess-no-open', provenance: 'STRONG' },
    });
    expect(getOpenEngagement('sess-no-open')).toBeNull();
  });

  it('ignores weak callers', async () => {
    seedSession('sess-weak');
    openEngagement({
      sessionId: 'sess-weak',
      ticketId: 'FE-10',
      stage: 'backlog',
      startedAt: '2026-01-01T00:00:00Z',
    });
    const entry = await planningEntry();
    await completeStageEntry({
      ticketId: 'FE-10',
      ticketDir: '/tmp/t',
      projectSlug: 'p',
      ticketSlug: 't',
      entry,
      actor: 'human',
      callerSession: { id: 'sess-weak', provenance: 'WEAK' },
    });
    expect(getOpenEngagement('sess-weak')?.stage).toBe('backlog');
  });

  it('ignores stopped sessions', async () => {
    seedSession('sess-stopped', { status: 'stopped' });
    openEngagement({
      sessionId: 'sess-stopped',
      ticketId: 'FE-10',
      stage: 'backlog',
      startedAt: '2026-01-01T00:00:00Z',
    });
    const entry = await planningEntry();
    await completeStageEntry({
      ticketId: 'FE-10',
      ticketDir: '/tmp/t',
      projectSlug: 'p',
      ticketSlug: 't',
      entry,
      actor: 'human',
      callerSession: { id: 'sess-stopped', provenance: 'STRONG' },
    });
    expect(getOpenEngagement('sess-stopped')?.stage).toBe('backlog');
  });

  it('ignores ACP-hosted sessions', async () => {
    seedSession('sess-acp', { hostedBy: 'acp' });
    openEngagement({
      sessionId: 'sess-acp',
      ticketId: 'FE-10',
      stage: 'backlog',
      startedAt: '2026-01-01T00:00:00Z',
    });
    const entry = await planningEntry();
    await completeStageEntry({
      ticketId: 'FE-10',
      ticketDir: '/tmp/t',
      projectSlug: 'p',
      ticketSlug: 't',
      entry,
      actor: 'human',
      callerSession: { id: 'sess-acp', provenance: 'STRONG' },
    });
    expect(getOpenEngagement('sess-acp')?.stage).toBe('backlog');
  });
});

describe('latestStageEntryForTicket', () => {
  it('uses rowid tie-breaker for same-second transitions', () => {
    insertLiveEventOrThrow({
      eventId: '11111111-1111-4111-8111-111111111111',
      ticketId: 'FE-99',
      type: 'moved',
      actor: 'human',
      at: '2026-01-01T00:00:00Z',
      details: { to: 'planning', stageEntryId: '11111111-1111-4111-8111-111111111111' },
    });
    insertLiveEventOrThrow({
      eventId: '22222222-2222-4222-8222-222222222222',
      ticketId: 'FE-99',
      type: 'moved',
      actor: 'human',
      at: '2026-01-01T00:00:00Z',
      details: { to: 'ready', stageEntryId: '22222222-2222-4222-8222-222222222222' },
    });
    const latest = latestStageEntryForTicket('FE-99');
    expect(latest?.eventId).toBe('22222222-2222-4222-8222-222222222222');
    expect(latest?.stage).toBe('ready');
  });

  it('does not infer created stage from current ticket status', () => {
    insertLiveEventOrThrow({
      eventId: '33333333-3333-4333-8333-333333333333',
      ticketId: 'FE-100',
      type: 'created',
      actor: 'human',
      at: '2026-01-01T00:00:00Z',
      details: {},
    });
    expect(latestStageEntryForTicket('FE-100')).toBeNull();
  });
});
