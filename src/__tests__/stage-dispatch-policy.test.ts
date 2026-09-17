import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadTemplate } from '../ticket-templates/registry.js';
import {
  resolveStageDispatch,
  validateStageTargetDeclarations,
} from '../ticket-templates/stage-dispatch.js';
import { buildReviewerPrompt, validateRequestId, StageDispatchError } from '../chat/stage-dispatch-broker.js';
import { seedMissingBuiltins } from '../ticket-templates/builtins.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('resolveStageDispatch', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'sv11-policy-'));
    await seedMissingBuiltins(home);
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('feature in_progress defaults to agent cursor with auto', async () => {
    const manifest = await loadTemplate(home, 'feature');
    const target = resolveStageDispatch(manifest, 'in_progress');
    expect(target).toMatchObject({ role: 'agent', agentId: 'cursor', auto: true });
  });

  it('review uses reviewer with auto false', async () => {
    const manifest = await loadTemplate(home, 'feature');
    const target = resolveStageDispatch(manifest, 'review');
    expect(target).toMatchObject({ role: 'reviewer', agentId: 'cursor', auto: false });
  });

  it('terminal done returns null even with template agent', async () => {
    const manifest = await loadTemplate(home, 'feature');
    expect(resolveStageDispatch(manifest, 'done')).toBeNull();
  });

  it('override requests dispatch with role agent when no default', async () => {
    const manifest = await loadTemplate(home, 'feature');
    const target = resolveStageDispatch(manifest, 'backlog', 'cursor');
    expect(target).toMatchObject({ agentId: 'cursor', role: 'agent', auto: true });
  });

  it('override on auto=false stage still auto-dispatches once', async () => {
    const manifest = await loadTemplate(home, 'feature');
    const target = resolveStageDispatch(manifest, 'review', 'cursor');
    expect(target?.auto).toBe(true);
  });

  it('validates builtin templates have single target per stage', async () => {
    const manifest = await loadTemplate(home, 'feature');
    expect(validateStageTargetDeclarations(manifest)).toEqual([]);
  });

  it('validateRequestId rejects invalid source at runtime', () => {
    expect(() =>
      validateRequestId('bogus' as 'automatic', 'auto~x', 'x'),
    ).toThrow(StageDispatchError);
    expect(() => validateRequestId('manual', 'not-a-uuid', 'entry-1')).toThrow(StageDispatchError);
  });

  it('buildReviewerPrompt references review log command without log role path', async () => {
    const manifest = await loadTemplate(home, 'feature');
    const prompt = buildReviewerPrompt('FE-1', manifest, 'cursor', 'Review carefully.', 'SHOW');
    expect(prompt).toContain('syntaur log FE-1 -t review');
    expect(prompt).toContain('SHOW');
    expect(prompt).not.toMatch(/journal\.md/);
  });
});
