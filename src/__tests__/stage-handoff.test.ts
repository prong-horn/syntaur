import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { seedMissingBuiltins } from '../ticket-templates/builtins.js';
import { loadTemplate } from '../ticket-templates/registry.js';
import { buildStageHandoffDescriptor, formatStageHandoffLine } from '../ticket-templates/stage-handoff.js';
import { buildManualFallbackEntryId } from '../lifecycle/stage-entry.js';
import { loadAgentDefinitions } from '../chat/agents.js';
import type { ChatEvent } from '../chat/types.js';
import { initEventsDb, resetEventsDb, type StageEntryEvent } from '../db/events-db.js';
import { insertLiveEventOrThrow } from '../db/events-db.js';

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'stage-handoff-'));
  process.env.SYNTAUR_HOME = home;
  await writeFile(
    join(home, 'config.md'),
    `---\nversion: "2.0"\ndefaultProjectDir: ${resolve(home, 'projects')}\n---\n`,
  );
  await seedMissingBuiltins(home);
  resetEventsDb();
  initEventsDb(join(home, 'events.db'));
});

afterEach(async () => {
  delete process.env.SYNTAUR_HOME;
  await rm(home, { recursive: true, force: true });
});

async function setInProgressAuto(auto: boolean): Promise<void> {
  const path = join(home, 'templates', 'feature', 'template.md');
  const text = await readFile(path, 'utf-8');
  const replaced = text.replace(
    /(- id: in_progress[\s\S]*?agent: cursor\n    )auto: true/,
    `$1auto: ${auto}`,
  );
  expect(replaced).not.toBe(text);
  await writeFile(path, replaced, 'utf-8');
}

const ENTRY_ID = '33333333-3333-4333-8333-333333333333';

function inProgressEntry(fields: Partial<StageEntryEvent>): StageEntryEvent {
  return {
    eventId: ENTRY_ID,
    at: '2026-01-01T00:00:00.000Z',
    stage: 'in_progress',
    dispatchTarget: 'cursor',
    dispatchRole: 'agent',
    dispatchAuto: true,
    dispatchOverride: false,
    verb: 'start',
    type: 'moved',
    ...fields,
  };
}

describe('buildStageHandoffDescriptor', () => {
  it('marks terminal stages as not dispatchable', async () => {
    const manifest = await loadTemplate(home, 'feature');
    const { definitions } = await loadAgentDefinitions(home);
    const descriptor = buildStageHandoffDescriptor({
      ticketId: 'FE-1',
      status: 'done',
      templateId: 'feature',
      manifest,
      chatEvents: [],
      definitions,
    });
    expect(descriptor.canDispatch).toBe(false);
    expect(descriptor.reason).toContain('Terminal');
  });

  it('surfaces latest receipt for the current entry', async () => {
    const manifest = await loadTemplate(home, 'feature');
    const { definitions } = await loadAgentDefinitions(home);
    const entryId = '11111111-1111-4111-8111-111111111111';
    insertLiveEventOrThrow({
      ticketId: 'FE-1',
      projectSlug: 'demo',
      actor: 'human',
      at: '2026-01-01T00:00:00.000Z',
      type: 'moved',
      details: {
        to: 'in_progress',
        stageEntryId: entryId,
        dispatchTarget: 'cursor',
        dispatchRole: 'agent',
        dispatchAuto: true,
        verb: 'start',
      },
      sourceKey: 'move~1',
      eventId: entryId,
    });
    const events: ChatEvent[] = [
      {
        seq: 1,
        ticketId: 'FE-1',
        kind: 'stage.dispatch',
        sessionKey: 'ticket~FE-1',
        agentId: 'system',
        turnId: null,
        ts: '2026-01-01T00:00:01.000Z',
        payload: {
          requestId: `auto~${entryId}`,
          entryId,
          agentId: 'cursor',
          stage: 'in_progress',
          role: 'agent',
          source: 'automatic',
          policyDigest: 'abc',
          state: 'queued',
        },
      },
    ];
    const descriptor = buildStageHandoffDescriptor({
      ticketId: 'FE-1',
      status: 'in_progress',
      templateId: 'feature',
      manifest,
      chatEvents: events,
      definitions,
    });
    expect(descriptor.entryId).toBe(entryId);
    expect(descriptor.latestReceipt?.state).toBe('queued');
    expect(descriptor.canDispatch).toBe(false);
    expect(formatStageHandoffLine(descriptor)).toContain('queued handoff');
  });

  it('exposes startDefaultAgentId from in_progress template policy', async () => {
    const manifest = await loadTemplate(home, 'feature');
    const { definitions } = await loadAgentDefinitions(home);
    const descriptor = buildStageHandoffDescriptor({
      ticketId: 'FE-1',
      status: 'ready',
      templateId: 'feature',
      manifest,
      chatEvents: [],
      definitions,
    });
    expect(descriptor.startDefaultAgentId).toBe('cursor');
  });

  it('uses manual fallback entry token matching broker digest', async () => {
    const manifest = await loadTemplate(home, 'feature');
    const { definitions } = await loadAgentDefinitions(home);
    const entryId = buildManualFallbackEntryId('in_progress', manifest.id, null);
    const descriptor = buildStageHandoffDescriptor({
      ticketId: 'FE-1',
      status: 'in_progress',
      templateId: 'feature',
      manifest,
      chatEvents: [],
      definitions,
      stageEntry: null,
    });
    expect(descriptor.manualFallback).toBe(true);
    expect(descriptor.entryId).toBe(entryId);
    expect(descriptor.entryId.startsWith('unrecorded~')).toBe(true);
  });

  it('ignores receipts tied to a previous stage entry', async () => {
    const manifest = await loadTemplate(home, 'feature');
    const { definitions } = await loadAgentDefinitions(home);
    const oldEntryId = '22222222-2222-4222-8222-222222222222';
    const newEntryId = '11111111-1111-4111-8111-111111111111';
    insertLiveEventOrThrow({
      ticketId: 'FE-1',
      projectSlug: 'demo',
      actor: 'human',
      at: '2026-01-01T00:00:00.000Z',
      type: 'moved',
      details: {
        to: 'in_progress',
        stageEntryId: newEntryId,
        dispatchTarget: 'cursor',
        dispatchRole: 'agent',
        dispatchAuto: true,
        verb: 'start',
      },
      sourceKey: 'move~2',
      eventId: newEntryId,
    });
    const events: ChatEvent[] = [
      {
        seq: 1,
        ticketId: 'FE-1',
        kind: 'stage.dispatch',
        sessionKey: 'ticket~FE-1',
        agentId: 'system',
        turnId: null,
        ts: '2026-01-01T00:00:00.000Z',
        payload: {
          requestId: `auto~${oldEntryId}`,
          entryId: oldEntryId,
          agentId: 'cursor',
          stage: 'in_progress',
          role: 'agent',
          source: 'automatic',
          policyDigest: 'abc',
          state: 'completed',
        },
      },
    ];
    const descriptor = buildStageHandoffDescriptor({
      ticketId: 'FE-1',
      status: 'in_progress',
      templateId: 'feature',
      manifest,
      chatEvents: events,
      definitions,
    });
    expect(descriptor.entryId).toBe(newEntryId);
    expect(descriptor.latestReceipt).toBeUndefined();
    expect(descriptor.canDispatch).toBe(true);
  });

  it('uses the entry override on an auto:false stage: auto with the recorded target', async () => {
    await setInProgressAuto(false);
    const manifest = await loadTemplate(home, 'feature');
    const { definitions } = await loadAgentDefinitions(home);
    const descriptor = buildStageHandoffDescriptor({
      ticketId: 'FE-1',
      status: 'in_progress',
      templateId: 'feature',
      manifest,
      chatEvents: [],
      definitions,
      stageEntry: inProgressEntry({ dispatchTarget: 'codex', dispatchAuto: true, dispatchOverride: true }),
    });
    expect(descriptor).toMatchObject({
      entryId: ENTRY_ID,
      auto: true,
      templateAuto: false,
      recordedTargetId: 'codex',
      defaultAgentId: 'cursor',
      startDefaultAuto: false,
      canDispatch: true,
      manualFallback: false,
    });
    expect(descriptor.latestReceipt).toBeUndefined();
    expect(formatStageHandoffLine(descriptor)).toBe(
      'Agent: automatic handoff to @codex on stage entry',
    );
  });

  it('keeps a non-override entry on an auto:false stage manual to the template default', async () => {
    await setInProgressAuto(false);
    const manifest = await loadTemplate(home, 'feature');
    const { definitions } = await loadAgentDefinitions(home);
    const descriptor = buildStageHandoffDescriptor({
      ticketId: 'FE-1',
      status: 'in_progress',
      templateId: 'feature',
      manifest,
      chatEvents: [],
      definitions,
      stageEntry: inProgressEntry({ dispatchAuto: false }),
    });
    expect(descriptor).toMatchObject({ auto: false, templateAuto: false, defaultAgentId: 'cursor' });
    expect(formatStageHandoffLine(descriptor)).toBe('Agent: hand off to @cursor when ready');
  });

  it('labels an override on an auto stage with the recorded target, not the template default', async () => {
    const manifest = await loadTemplate(home, 'feature');
    const { definitions } = await loadAgentDefinitions(home);
    const descriptor = buildStageHandoffDescriptor({
      ticketId: 'FE-1',
      status: 'in_progress',
      templateId: 'feature',
      manifest,
      chatEvents: [],
      definitions,
      stageEntry: inProgressEntry({ dispatchTarget: 'codex', dispatchOverride: true }),
    });
    expect(descriptor).toMatchObject({
      auto: true,
      templateAuto: true,
      recordedTargetId: 'codex',
      defaultAgentId: 'cursor',
    });
    expect(formatStageHandoffLine(descriptor)).toContain('@codex');
  });

  it('keeps unrecorded fallback entries manual even on an auto template stage', async () => {
    const manifest = await loadTemplate(home, 'feature');
    const { definitions } = await loadAgentDefinitions(home);
    const descriptor = buildStageHandoffDescriptor({
      ticketId: 'FE-1',
      status: 'in_progress',
      templateId: 'feature',
      manifest,
      chatEvents: [],
      definitions,
      stageEntry: null,
    });
    expect(descriptor).toMatchObject({
      manualFallback: true,
      auto: false,
      templateAuto: true,
      recordedTargetId: null,
      defaultAgentId: 'cursor',
    });
    expect(formatStageHandoffLine(descriptor)).toBe('Agent: hand off to @cursor when ready');
  });
});
