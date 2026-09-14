import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseTemplateManifest } from '../ticket-templates/manifest.js';
import { validateTemplate, validateTemplateId } from '../ticket-templates/validate.js';
import { BUILTIN_TEMPLATE_IDS, builtinTemplatesDir } from '../ticket-templates/builtins.js';

function loadBuiltin(id: string) {
  const path = resolve(builtinTemplatesDir(), id, 'template.md');
  const content = readFileSync(path, 'utf-8');
  return parseTemplateManifest(path, id, content);
}

describe('built-in manifests', () => {
  for (const id of BUILTIN_TEMPLATE_IDS) {
    it(`${id} parses and validates clean`, () => {
      const manifest = loadBuiltin(id);
      expect(manifest.id).toBe(id);
      const issues = [
        ...validateTemplateId(manifest, id),
        ...validateTemplate(manifest, ['template.md']),
      ];
      expect(issues).toEqual([]);
    });
  }
});

function manifestYaml(body: string): string {
  return `---\n${body}\n---\nignored body\n`;
}

const baseStages = `stages:
  - id: backlog
    instructions: backlog
  - id: done
    instructions: done`;

function baseManifest(parts: { stages?: string; files?: string; gates?: string } = {}): string {
  const stages = parts.stages ?? baseStages;
  const files = parts.files ?? 'files: []';
  const gates = parts.gates ?? '';
  return `id: test
version: 1
description: A test template
whenToUse: Testing
${stages}
${files}
${gates}`;
}

describe('validation rules', () => {
  it('rule 1: id must match directory', () => {
    const m = parseTemplateManifest('f', 'test', manifestYaml(baseManifest()));
    const issues = validateTemplateId(m, 'wrong');
    expect(issues.some((i) => i.rule === 1)).toBe(true);
  });

  it('rule 2: version must be 1', () => {
    const m = parseTemplateManifest('f', 'test', manifestYaml(baseManifest().replace('version: 1', 'version: 2')));
    expect(validateTemplate(m, ['template.md']).some((i) => i.rule === 2)).toBe(true);
  });

  it('rule 3: unknown stage id', () => {
    expect(() =>
      parseTemplateManifest(
        'f',
        'test',
        manifestYaml(baseManifest().replace('id: backlog', 'id: unknown_stage')),
      ),
    ).toThrow();
  });

  it('rule 4: stages out of order', () => {
    const yaml = baseManifest({
      stages: `stages:
  - id: done
    instructions: done
  - id: backlog
    instructions: backlog`,
    });
    const m = parseTemplateManifest('f', 'test', manifestYaml(yaml));
    expect(validateTemplate(m, ['template.md']).some((i) => i.rule === 4)).toBe(true);
  });

  it('rule 5: ready requires plan role', () => {
    const yaml = baseManifest({
      stages: `stages:
  - id: backlog
    instructions: backlog
  - id: ready
    instructions: ready
  - id: done
    instructions: done`,
    });
    const m = parseTemplateManifest('f', 'test', manifestYaml(yaml));
    expect(validateTemplate(m, ['template.md']).some((i) => i.rule === 5)).toBe(true);
  });

  it('rule 6: plan-approved requires plan role', () => {
    const m = parseTemplateManifest(
      'f',
      'test',
      manifestYaml(baseManifest({ gates: 'gates:\n  approve: [plan-approved]' })),
    );
    expect(validateTemplate(m, ['template.md']).some((i) => i.rule === 6)).toBe(true);
  });

  it('rule 7: review-clean requires review stage', () => {
    const yaml = baseManifest({
      files: `files:
  - path: journal.md
    role: log
    writer: cli
    description: log`,
      gates: 'gates:\n  done: [review-clean]',
    });
    const m = parseTemplateManifest('f', 'test', manifestYaml(yaml));
    expect(validateTemplate(m, ['template.md']).some((i) => i.rule === 7)).toBe(true);
  });

  it('rule 8: deliverable-present requires deliverable role', () => {
    const m = parseTemplateManifest(
      'f',
      'test',
      manifestYaml(baseManifest({ gates: 'gates:\n  done: [deliverable-present]' })),
    );
    expect(validateTemplate(m, ['template.md']).some((i) => i.rule === 8)).toBe(true);
  });

  it('rule 9: log gates require log role', () => {
    const m = parseTemplateManifest(
      'f',
      'test',
      manifestYaml(baseManifest({ gates: 'gates:\n  done: [handoff-logged]' })),
    );
    expect(validateTemplate(m, ['template.md']).some((i) => i.rule === 9)).toBe(true);
  });

  it('rule 10: at most one plan role', () => {
    const yaml = baseManifest({
      files: `files:
  - path: plan.md
    role: plan
    writer: agent
    description: plan one
  - path: plan2.md
    role: plan
    writer: agent
    description: plan two`,
    });
    const m = parseTemplateManifest('f', 'test', manifestYaml(yaml));
    expect(validateTemplate(m, ['template.md']).some((i) => i.rule === 10)).toBe(true);
  });

  it('rule 11: description required', () => {
    const yaml = baseManifest({
      files: `files:
  - path: notes.md
    role: notes
    writer: agent
    description: " "`,
    });
    const m = parseTemplateManifest('f', 'test', manifestYaml(yaml));
    expect(validateTemplate(m, ['template.md']).some((i) => i.rule === 11)).toBe(true);
  });

  it('rule 12: log role requires cli writer', () => {
    const yaml = baseManifest({
      files: `files:
  - path: journal.md
    role: log
    writer: agent
    description: log file`,
    });
    const m = parseTemplateManifest('f', 'test', manifestYaml(yaml));
    expect(validateTemplate(m, ['template.md']).some((i) => i.rule === 12)).toBe(true);
  });

  it('rule 14: invalid createOn', () => {
    const yaml = baseManifest({
      files: `files:
  - path: notes.md
    role: notes
    writer: agent
    createOn: planning
    description: notes`,
    });
    const m = parseTemplateManifest('f', 'test', manifestYaml(yaml));
    expect(validateTemplate(m, ['template.md']).some((i) => i.rule === 14)).toBe(true);
  });

  it('rule 15: kernel path in files[]', () => {
    const yaml = baseManifest({
      files: `files:
  - path: ticket.md
    writer: agent
    description: bad`,
    });
    const m = parseTemplateManifest('f', 'test', manifestYaml(yaml));
    expect(validateTemplate(m, ['template.md']).some((i) => i.rule === 15)).toBe(true);
  });

  it('rule 16: dropped in stages', () => {
    expect(() =>
      parseTemplateManifest(
        'f',
        'test',
        manifestYaml(`id: test
version: 1
description: x
whenToUse: x
stages:
  - id: dropped
    instructions: no
  - id: done
    instructions: done
files: []`),
      ),
    ).toThrow();
  });

  it('extra: invalid writer', () => {
    const yaml = baseManifest({
      files: `files:
  - path: x.md
    writer: bot
    description: x`,
    });
    expect(() => parseTemplateManifest('f', 'test', manifestYaml(yaml))).toThrow();
  });

  it('extra: entryTypes on non-log file', () => {
    const yaml = baseManifest({
      files: `files:
  - path: notes.md
    role: notes
    writer: agent
    description: notes
    entryTypes: [progress]`,
    });
    const m = parseTemplateManifest('f', 'test', manifestYaml(yaml));
    expect(validateTemplate(m, ['template.md']).some((i) => i.rule === 'entryTypes')).toBe(true);
  });

  it('extra: gates-stage missing target', () => {
    const m = parseTemplateManifest(
      'f',
      'test',
      manifestYaml(baseManifest({ gates: 'gates:\n  start: [deps-done]' })),
    );
    expect(validateTemplate(m, ['template.md']).some((i) => i.rule === 'gates-stage')).toBe(true);
  });
});
