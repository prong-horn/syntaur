import { describe, it, expect } from 'vitest';
import {
  resolveLaunchPrompt,
  bareGrabSeed,
  runPlaybookClause,
} from '../launch/launch-prompt.js';

const BASE = {
  id: 'a1b2c3',
  assignmentDir: '/Users/x/.syntaur/projects/proj/assignments/asg',
  projectSlug: 'proj' as string | null,
  assignmentSlug: 'asg',
};

const POINTER =
  `This session is Syntaur assignment a1b2c3, with records at ${BASE.assignmentDir}. ` +
  `Claim and bind it with the /grab-assignment skill if available; ` +
  `otherwise read assignment.md, plan*.md, and progress.md in that directory for full context.`;

describe('resolveLaunchPrompt — @assignment', () => {
  it('project assignment: id + records dir + grab-if-available + read fallback', () => {
    const { prompt, warnings } = resolveLaunchPrompt({ ...BASE, template: '@assignment' });
    expect(prompt).toBe(POINTER);
    expect(prompt).toContain('a1b2c3');
    expect(prompt).toContain(BASE.assignmentDir);
    expect(prompt).toContain('/grab-assignment skill if available');
    expect(prompt).toContain('read assignment.md, plan*.md, and progress.md');
    expect(warnings).toEqual([]);
  });

  it('standalone assignment (projectSlug null) uses the same wording', () => {
    const { prompt, warnings } = resolveLaunchPrompt({
      ...BASE,
      projectSlug: null,
      template: '@assignment',
    });
    expect(prompt).toBe(POINTER);
    expect(warnings).toEqual([]);
  });

  it('@assignment embedded mid-sentence preserves surrounding text', () => {
    const { prompt } = resolveLaunchPrompt({ ...BASE, template: 'Context: @assignment Then go.' });
    expect(prompt).toBe(`Context: ${POINTER} Then go.`);
  });
});

describe('resolveLaunchPrompt — @<playbook-slug>', () => {
  it('resolves a known slug with no warning', () => {
    const { prompt, warnings } = resolveLaunchPrompt({
      ...BASE,
      template: 'Run @e2e-dev-cycle now.',
      knownPlaybookSlugs: new Set(['e2e-dev-cycle']),
    });
    expect(prompt).toBe(`Run ${runPlaybookClause('e2e-dev-cycle')} now.`);
    expect(prompt).toContain('/run-playbook');
    expect(warnings).toEqual([]);
  });

  it('resolves multiple tokens in one template', () => {
    const { prompt, warnings } = resolveLaunchPrompt({
      ...BASE,
      template: '@assignment Then run @keep-records-updated and @e2e-dev-cycle.',
      knownPlaybookSlugs: new Set(['keep-records-updated', 'e2e-dev-cycle']),
    });
    expect(prompt).toContain(POINTER);
    expect(prompt).toContain(runPlaybookClause('keep-records-updated'));
    expect(prompt).toContain(runPlaybookClause('e2e-dev-cycle'));
    expect(warnings).toEqual([]);
  });

  it('resolves any well-formed slug when no known set is provided', () => {
    const { prompt, warnings } = resolveLaunchPrompt({ ...BASE, template: 'Use @whatever-slug.' });
    expect(prompt).toBe(`Use ${runPlaybookClause('whatever-slug')}.`);
    expect(warnings).toEqual([]);
  });

  it('warns + leaves literal for a well-formed-but-unknown slug when a set is provided', () => {
    const { prompt, warnings } = resolveLaunchPrompt({
      ...BASE,
      template: 'Use @missing-thing.',
      knownPlaybookSlugs: new Set(['e2e-dev-cycle']),
    });
    expect(prompt).toBe('Use @missing-thing.');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('missing-thing');
    expect(warnings[0]).toContain('not installed');
  });
});

describe('resolveLaunchPrompt — malformed tokens warn + literal, launch not aborted', () => {
  it.each(['@FOO', '@foo_bar', '@foo--bar'])('%s warns and stays literal', (tok) => {
    const { prompt, warnings } = resolveLaunchPrompt({ ...BASE, template: `x ${tok} y` });
    expect(prompt).toBe(`x ${tok} y`);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('not a valid playbook token');
  });
});

describe('resolveLaunchPrompt — non-tokens are left untouched with no warning', () => {
  it('a bare @ is ordinary prose', () => {
    const { prompt, warnings } = resolveLaunchPrompt({ ...BASE, template: 'meet @ 5pm sharp' });
    expect(prompt).toBe('meet @ 5pm sharp');
    expect(warnings).toEqual([]);
  });

  it('an email address (@ not at a word boundary) is untouched', () => {
    const { prompt, warnings } = resolveLaunchPrompt({ ...BASE, template: 'mail user@example.com ok' });
    expect(prompt).toBe('mail user@example.com ok');
    expect(warnings).toEqual([]);
  });
});

describe('resolveLaunchPrompt — fallback chain (back-compat)', () => {
  it('no template + no playbook → bare /grab-assignment (project)', () => {
    const { prompt, warnings } = resolveLaunchPrompt({ ...BASE });
    expect(prompt).toBe('/grab-assignment proj asg');
    expect(warnings).toEqual([]);
  });

  it('no template + no playbook → standalone --id', () => {
    const { prompt } = resolveLaunchPrompt({ ...BASE, projectSlug: null });
    expect(prompt).toBe('/grab-assignment --id a1b2c3');
  });

  it('no template + no playbook → slug fallback (no project, no id)', () => {
    const { prompt } = resolveLaunchPrompt({ ...BASE, projectSlug: null, id: undefined });
    expect(prompt).toBe('/grab-assignment asg');
  });

  it('bareGrabSeed matches the three branches exactly', () => {
    expect(bareGrabSeed({ projectSlug: 'proj', assignmentSlug: 'asg' })).toBe('/grab-assignment proj asg');
    expect(bareGrabSeed({ projectSlug: null, assignmentSlug: 'asg', id: 'u1' })).toBe('/grab-assignment --id u1');
    expect(bareGrabSeed({ projectSlug: null, assignmentSlug: 'asg' })).toBe('/grab-assignment asg');
  });

  it('playbook set (no template) synthesizes pointer + direct run-playbook clause', () => {
    const { prompt, warnings } = resolveLaunchPrompt({ ...BASE, playbook: 'e2e-dev-cycle' });
    expect(prompt).toBe(`${POINTER} Run ${runPlaybookClause('e2e-dev-cycle')} end-to-end.`);
    expect(warnings).toEqual([]);
  });

  it('synth does not validate the playbook against the known set', () => {
    const { prompt, warnings } = resolveLaunchPrompt({
      ...BASE,
      playbook: 'not-installed',
      knownPlaybookSlugs: new Set(['e2e-dev-cycle']),
    });
    expect(prompt).toContain(runPlaybookClause('not-installed'));
    expect(warnings).toEqual([]);
  });

  it('reserved-assignment collision: playbook named "assignment" does not double-resolve', () => {
    const { prompt } = resolveLaunchPrompt({ ...BASE, playbook: 'assignment' });
    expect(prompt).toContain(runPlaybookClause('assignment'));
    // The @assignment pointer appears exactly once (the playbook name was not
    // routed through @-token syntax).
    expect(prompt.match(/This session is Syntaur assignment/g)).toHaveLength(1);
  });

  it('launchPrompt wins when both launchPrompt and playbook are set', () => {
    const { prompt } = resolveLaunchPrompt({
      ...BASE,
      template: '@assignment only',
      playbook: 'e2e-dev-cycle',
    });
    expect(prompt).toBe(`${POINTER} only`);
    expect(prompt).not.toContain('e2e-dev-cycle');
  });
});

describe('resolveLaunchPrompt — removable grab (criterion 4)', () => {
  it('a template without @assignment injects no grab/pointer/id', () => {
    const { prompt, warnings } = resolveLaunchPrompt({ ...BASE, template: 'Just review the diff carefully.' });
    expect(prompt).toBe('Just review the diff carefully.');
    expect(prompt).not.toContain('grab-assignment');
    expect(prompt).not.toContain('Syntaur assignment');
    expect(warnings).toEqual([]);
  });

  it('a template with only a playbook token gets no assignment injection', () => {
    const { prompt } = resolveLaunchPrompt({
      ...BASE,
      template: 'Run @e2e-dev-cycle.',
      knownPlaybookSlugs: new Set(['e2e-dev-cycle']),
    });
    expect(prompt).toBe(`Run ${runPlaybookClause('e2e-dev-cycle')}.`);
    expect(prompt).not.toContain('grab-assignment');
    expect(prompt).not.toContain('Syntaur assignment');
  });
});
