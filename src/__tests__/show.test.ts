import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { seedMissingBuiltins } from '../ticket-templates/builtins.js';
import {
  buildShow,
  renderLogOnly,
  renderShowText,
  type ShowModel,
} from '../ticket-templates/show.js';
import { parseLogEntries } from '../ticket-templates/log-reader.js';
import { fileState } from '../ticket-templates/roles.js';
import { loadTemplate } from '../ticket-templates/registry.js';
import { parseTicketFrontmatter } from '../lifecycle/frontmatter.js';

let home: string;

const NOW = new Date('2026-09-11T00:40:00Z');

/** Apply the four driver-allowed substitutions to a §7.2/§7.3 spec example. */
function expectSpecShowText(
  text: string,
  model: ShowModel,
  spec: string,
  specObjective: string,
  specLogState: string,
  specStageSuffix: string,
  specCommands: string,
): void {
  const kernelDesc = model.files.find((f) => f.path === 'ticket.md')!.description;
  const logRole = model.files.find((f) => f.role === 'log');
  const logStateLine = logRole ? `journal.md  log · ${logRole.state}` : '';
  const stage = model.ticket.stage;
  const commandsLine = `Commands: ${model.commands.join('; ')}`;

  const expected = spec
    .replace(specObjective, `    ${kernelDesc}`)
    .replace(specLogState, logStateLine)
    .replace(specStageSuffix, ` · ${model.ticket.template} · ${stage}`)
    .replace(specCommands, commandsLine);

  expect(text).toBe(expected);
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  home = await mkdtemp(join(tmpdir(), 'show-test-'));
  process.env.SYNTAUR_HOME = home;
  await writeFile(
    join(home, 'config.md'),
    `---\nversion: "2.0"\ndefaultProjectDir: ${resolve(home, 'projects')}\n---\n`,
  );
  await seedMissingBuiltins(home);
});

afterEach(async () => {
  vi.useRealTimers();
  delete process.env.SYNTAUR_HOME;
  await rm(home, { recursive: true, force: true });
});

async function writeProjectTicket(
  project: string,
  folder: string,
  files: Record<string, string>,
): Promise<string> {
  const projectDir = resolve(home, 'projects', project);
  const ticketDir = resolve(projectDir, 'tickets', folder);
  await mkdir(ticketDir, { recursive: true });
  await mkdir(projectDir, { recursive: true });
  await writeFile(
    resolve(projectDir, 'project.md'),
    `---\nslug: ${project}\ntitle: ${project}\nprefix: SYN\nnextTicket: 200\n---\n`,
    'utf-8',
  );
  for (const [name, content] of Object.entries(files)) {
    await writeFile(resolve(ticketDir, name), content, 'utf-8');
  }
  return ticketDir;
}

describe('parseLogEntries', () => {
  it('parses v2 headings and legacy progress headings', () => {
    const content = `---
purpose: log
---

## 2026-09-10T22:40:00Z · progress · cursor

Implemented filter.

## 2026-09-09T12:00:00Z

Legacy entry.
`;
    const entries = parseLogEntries(content);
    expect(entries).toHaveLength(2);
    expect(entries[0].type).toBe('progress');
    expect(entries[0].author).toBe('cursor');
    expect(entries[1].type).toBe('progress');
    expect(entries[1].author).toBeNull();
  });
});

describe('§7.2 SYN-142 feature in_progress', () => {
  it('renders the worked example (age and Commands are template-specific)', async () => {
    const planBody = '# Plan\n\nApproved implementation plan with real tasks.\n';
    const planDigest = createHash('sha256').update(planBody, 'utf-8').digest('hex');
    const depDir = await writeProjectTicket('syntaur', 'SYN-138-dep', {
      'ticket.md': `---
id: SYN-138
slug: dep
title: Dep
project: syntaur
template: feature
status: completed
priority: medium
created: "2026-01-01T00:00:00Z"
updated: "2026-01-01T00:00:00Z"
depends_on: []
links: []
plan:
  file: null
  approvedDigest: null
  approvedAt: null
  approvedBy: null
---

## Objective

Done upstream.
`,
    });
    void depDir;

    const ticketDir = await writeProjectTicket('syntaur', 'SYN-142-needs-me', {
      'ticket.md': `---
id: SYN-142
slug: needs-me
title: "Needs me: age out the backlog with a max-age filter and snooze"
project: syntaur
template: feature
status: in_progress
priority: medium
created: "2026-01-01T00:00:00Z"
updated: "2026-01-01T00:00:00Z"
depends_on:
  - SYN-138
links: []
workspace:
  repository: /Users/brennen/syntaur
  branch: feat/needs-me-backlog-aging
  worktreePath: /Users/brennen/syntaur/.worktrees/feat/needs-me-backlog-aging
  parentBranch: main
plan:
  file: plan.md
  approvedDigest: ${planDigest}
  approvedAt: "2026-09-01T00:00:00Z"
  approvedBy: human
tags: []
archived: false
archivedAt: null
archivedReason: null
phase: null
disposition: null
parked: false
reviewRequested: false
reworkRequested: false
implementationStarted: false
override: null
facts: {}
attestations: []
solicitations: []
firedVerdicts: []
frozenChecks: null
hold: false
gateOverrides: []
statusHistory: []
assignee: null
externalIds: []
workflow: null
blockedReason: null
---

## Objective

Keep the Needs me queue from being dominated by reviews and plan approvals on parked projects.

## Acceptance Criteria

- [x] one
- [x] two
- [x] three
- [x] four
- [x] five
`,
      'plan.md': planBody,
      'journal.md': `---
purpose: log
---

## 2026-09-10T22:40:00Z · progress · cursor

Implemented max-age filter in computeInbox

## 2026-09-10T20:05:00Z · decision · human

Default window is 14 days

## 2026-09-10T12:15:00Z · progress · cursor

Started implementation

## 2026-09-09T12:00:00Z · progress · cursor

More

## 2026-09-08T12:00:00Z · progress · cursor

More2

## 2026-09-07T12:00:00Z · progress · cursor

More3

## 2026-09-06T12:00:00Z · progress · cursor

More4

## 2026-09-05T12:00:00Z · progress · cursor

More5
`,
    });

    const model = await buildShow(home, ticketDir);
    const text = renderShowText(model);
    const specSyn142 = `SYN-142 · Needs me: age out the backlog with a max-age filter and snooze · feature · in_progress
Objective: Keep the Needs me queue from being dominated by reviews and plan approvals on parked projects.
Acceptance: 5 of 5 checked
Workspace: /Users/brennen/syntaur · feat/needs-me-backlog-aging · /Users/brennen/syntaur/.worktrees/feat/needs-me-backlog-aging
Depends: SYN-138 done
Files:
  ticket.md  kernel · editable
    Age filter and snooze for Needs me queue
  plan.md  plan · approved
    Implementation plan with tasks and verify steps; requires human approval before start.
  journal.md  log · 8 entries · last progress 2h
    Append-only log for progress, decisions, handoffs, questions, answers, and reviews.
Handoff: none
Log: last 3 entries
  ## 2026-09-10T22:40:00Z · progress · cursor — Implemented max-age filter in computeInbox
  ## 2026-09-10T20:05:00Z · decision · human — Default window is 14 days
  ## 2026-09-10T12:15:00Z · progress · cursor — Started implementation
Stage: in_progress. Implement the approved plan task by task. Log progress after meaningful steps. Tick acceptance criteria in ticket.md as each is met. Commit in small logical units with clear messages. Never commit secrets. Run linter before commit if configured.
Next: syntaur review SYN-142
Commands: syntaur log SYN-142 -t progress "..."; syntaur block SYN-142 "reason"; ask via question log or @mention in chat`;
    expectSpecShowText(
      text,
      model,
      specSyn142,
      '    Age filter and snooze for Needs me queue',
      'journal.md  log · 8 entries · last progress 2h',
      ' · feature · in_progress',
      'Commands: syntaur log SYN-142 -t progress "..."; syntaur block SYN-142 "reason"; ask via question log or @mention in chat',
    );
  });
});

describe('§7.3 SCR-7 quick backlog', () => {
  it('renders the quick ticket example', async () => {
    const ticketDir = await writeProjectTicket('scratch', 'SCR-7-readme', {
      'ticket.md': `---
id: SCR-7
slug: readme
title: Update README install section
project: scratch
template: quick
status: draft
priority: low
created: "2026-01-01T00:00:00Z"
updated: "2026-01-01T00:00:00Z"
depends_on: []
links: []
plan:
  file: null
  approvedDigest: null
  approvedAt: null
  approvedBy: null
tags: []
archived: false
archivedAt: null
archivedReason: null
phase: null
disposition: null
parked: false
reviewRequested: false
reworkRequested: false
implementationStarted: false
override: null
facts: {}
attestations: []
solicitations: []
firedVerdicts: []
frozenChecks: null
hold: false
gateOverrides: []
statusHistory: []
assignee: null
externalIds: []
workflow: null
blockedReason: null
---

## Objective

Add skills.sh install path to README.

## Acceptance Criteria

- [ ] ship it
`,
    });

    const model = await buildShow(home, ticketDir);
    const text = renderShowText(model);
    const specScr7 = `SCR-7 · Update README install section · quick · backlog
Objective: Add skills.sh install path to README.
Acceptance: 0 of 1 checked
Workspace: none (template does not require one)
Depends: none
Files:
  ticket.md  kernel · editable
    README install update
Handoff: none
Log: last 0 entries
Stage: backlog. Do the work described in the objective, then syntaur done.
Next: syntaur done SCR-7
Commands: syntaur log SCR-7 -t note "..."; syntaur block SCR-7 "reason"; ask via question log or @mention in chat`;
    expectSpecShowText(
      text,
      model,
      specScr7,
      '    README install update',
      'journal.md  log · 8 entries · last progress 2h',
      ' · quick · backlog',
      'Commands: syntaur log SCR-7 -t note "..."; syntaur block SCR-7 "reason"; ask via question log or @mention in chat',
    );
  });
});

describe('off-template stage', () => {
  it('quick at ready_for_planning shows planning off-template and next declared stage', async () => {
    const ticketDir = await writeProjectTicket('scratch', 'SCR-9-planning', {
      'ticket.md': `---
id: SCR-9
slug: planning
title: Off-template stage
project: scratch
template: quick
status: ready_for_planning
priority: low
created: "2026-01-01T00:00:00Z"
updated: "2026-01-01T00:00:00Z"
depends_on: []
links: []
plan:
  file: null
  approvedDigest: null
  approvedAt: null
  approvedBy: null
tags: []
archived: false
archivedAt: null
archivedReason: null
phase: null
disposition: null
parked: false
reviewRequested: false
reworkRequested: false
implementationStarted: false
override: null
facts: {}
attestations: []
solicitations: []
firedVerdicts: []
frozenChecks: null
hold: false
gateOverrides: []
statusHistory: []
assignee: null
externalIds: []
workflow: null
blockedReason: null
---

## Objective

Quick ticket in planning status.

## Acceptance Criteria

- [ ] ship it
`,
    });

    const model = await buildShow(home, ticketDir);
    const text = renderShowText(model);
    expect(text).toContain('Stage: planning (not declared by template quick)');
    expect(text).toContain('Next: syntaur done SCR-9');
    expect(model.ticket.stage).toBe('planning');
  });
});

describe('legacy ticket', () => {
  it('lists six files and parses legacy progress headings', async () => {
    const ticketDir = await writeProjectTicket('p', 'LEG-1-legacy', {
      'ticket.md': `---
id: LEG-1
slug: legacy
title: Legacy ticket
project: p
template: legacy
status: draft
priority: medium
created: "2026-01-01T00:00:00Z"
updated: "2026-01-01T00:00:00Z"
depends_on: []
links: []
plan:
  file: null
  approvedDigest: null
  approvedAt: null
  approvedBy: null
tags: []
archived: false
archivedAt: null
archivedReason: null
phase: null
disposition: null
parked: false
reviewRequested: false
reworkRequested: false
implementationStarted: false
override: null
facts: {}
attestations: []
solicitations: []
firedVerdicts: []
frozenChecks: null
hold: false
gateOverrides: []
statusHistory: []
assignee: null
externalIds: []
workflow: null
blockedReason: null
---

## Objective

Legacy objective.
`,
      'progress.md': `---
ticket: legacy
entryCount: 1
generated: "2026-01-01T00:00:00Z"
updated: "2026-01-01T00:00:00Z"
---

# Progress

## 2026-09-01T10:00:00Z

Did work.
`,
      'plan.md': '# Plan\n\nStub only\n',
      'scratchpad.md': '# scratch\n',
      'decision-record.md': '# decisions\n',
      'handoff.md': '# handoff\n',
      'comments.md': '# comments\n',
    });

    const model = await buildShow(home, ticketDir);
    expect(model.files.length).toBe(7);
    expect(renderShowText(model)).toContain('Handoff: none');
    expect(renderShowText(model)).toContain('progress.md  log ·');
    expect(renderShowText(model)).toContain(
      'Commands: syntaur progress log --ticket LEG-1 "..."; syntaur show LEG-1; syntaur comment LEG-1 "..." --type question; ask via @mention in chat',
    );
  });
});

describe('header and log states', () => {
  it('prints blocked and parked together when both apply', async () => {
    const ticketDir = await writeProjectTicket('p', 'T-1-both', {
      'ticket.md': `---
id: T-1
slug: both
title: Both flags
project: p
template: quick
status: draft
priority: low
created: "2026-01-01T00:00:00Z"
updated: "2026-01-01T00:00:00Z"
depends_on: []
links: []
plan:
  file: null
  approvedDigest: null
  approvedAt: null
  approvedBy: null
tags: []
archived: false
archivedAt: null
archivedReason: null
phase: null
disposition: null
parked: true
reviewRequested: false
reworkRequested: false
implementationStarted: false
override: null
facts: {}
attestations: []
solicitations: []
firedVerdicts: []
frozenChecks: null
hold: false
gateOverrides: []
statusHistory: []
assignee: null
externalIds: []
workflow: null
blockedReason: waiting on upstream
---

## Objective

x
`,
    });
    const text = renderShowText(await buildShow(home, ticketDir));
    expect(text).toContain('blocked: waiting on upstream · parked');
  });

  it('renders zero log entries without a last segment', async () => {
    const manifest = await loadTemplate(home, 'feature');
    const logFile = manifest.files.find((f) => f.role === 'log')!;
    const ticketDir = join(home, 'empty-log');
    await mkdir(ticketDir, { recursive: true });
    expect(await fileState(logFile, ticketDir, parseTicketFrontmatter('---\nid: X\n---\n'), manifest)).toBe(
      '0 entries',
    );
    await writeFile(
      resolve(ticketDir, logFile.path),
      '---\npurpose: log\n---\n',
      'utf-8',
    );
    expect(
      await fileState(
        logFile,
        ticketDir,
        parseTicketFrontmatter('---\nid: X\n---\n'),
        manifest,
      ),
    ).toBe('0 entries');
  });
});

describe('file states', () => {
  it('reports plan approved, stale, and deliverable empty', async () => {
    const manifest = await loadTemplate(home, 'feature');
    const fm = parseTicketFrontmatter(`---
id: T-1
slug: t
title: T
project: p
template: feature
status: draft
priority: medium
created: "2026-01-01T00:00:00Z"
updated: "2026-01-01T00:00:00Z"
depends_on: []
links: []
plan:
  file: plan.md
  approvedDigest: abc
  approvedAt: null
  approvedBy: null
tags: []
archived: false
archivedAt: null
archivedReason: null
phase: null
disposition: null
parked: false
reviewRequested: false
reworkRequested: false
implementationStarted: false
override: null
facts: {}
attestations: []
solicitations: []
firedVerdicts: []
frozenChecks: null
hold: false
gateOverrides: []
statusHistory: []
assignee: null
externalIds: []
workflow: null
blockedReason: null
---

## Objective

x
`);
    const ticketDir = join(home, 'state-ticket');
    await mkdir(ticketDir, { recursive: true });
    await writeFile(resolve(ticketDir, 'plan.md'), '# Plan\n\nChanged after approval.\n', 'utf-8');
    const planFile = manifest.files.find((f) => f.role === 'plan')!;
    expect(await fileState(planFile, ticketDir, fm, manifest)).toBe('stale');
  });
});

describe('show --json and --log', () => {
  it('emits ticket.status and stage', async () => {
    const ticketDir = await writeProjectTicket('scratch', 'SCR-7-readme', {
      'ticket.md': `---
id: SCR-7
slug: readme
title: Update README install section
project: scratch
template: quick
status: draft
priority: low
created: "2026-01-01T00:00:00Z"
updated: "2026-01-01T00:00:00Z"
depends_on: []
links: []
plan:
  file: null
  approvedDigest: null
  approvedAt: null
  approvedBy: null
tags: []
archived: false
archivedAt: null
archivedReason: null
phase: null
disposition: null
parked: false
reviewRequested: false
reworkRequested: false
implementationStarted: false
override: null
facts: {}
attestations: []
solicitations: []
firedVerdicts: []
frozenChecks: null
hold: false
gateOverrides: []
statusHistory: []
assignee: null
externalIds: []
workflow: null
blockedReason: null
---

## Objective

Add skills.sh install path to README.
`,
    });
    const model = await buildShow(home, ticketDir);
    expect(model.ticket.status).toBe('draft');
    expect(model.ticket.stage).toBe('backlog');
    expect(model.commands.length).toBeGreaterThan(0);
  });

  it('filters log output by type', async () => {
    const ticketDir = await writeProjectTicket('syntaur', 'SYN-142-needs-me', {
      'ticket.md': `---
id: SYN-142
slug: needs-me
title: Needs me
project: syntaur
template: feature
status: in_progress
priority: medium
created: "2026-01-01T00:00:00Z"
updated: "2026-01-01T00:00:00Z"
depends_on: []
links: []
plan:
  file: null
  approvedDigest: null
  approvedAt: null
  approvedBy: null
tags: []
archived: false
archivedAt: null
archivedReason: null
phase: null
disposition: null
parked: false
reviewRequested: false
reworkRequested: false
implementationStarted: false
override: null
facts: {}
attestations: []
solicitations: []
firedVerdicts: []
frozenChecks: null
hold: false
gateOverrides: []
statusHistory: []
assignee: null
externalIds: []
workflow: null
blockedReason: null
---

## Objective

x
`,
      'journal.md': `## 2026-09-10T22:40:00Z · progress · cursor

p

## 2026-09-10T20:05:00Z · decision · human

d
`,
    });
    const out = await renderLogOnly(home, ticketDir, 'review');
    expect(out).toBe('no log entries');
    const decisions = await renderLogOnly(home, ticketDir, 'decision');
    expect(decisions).toContain('decision · human');
  });
});
